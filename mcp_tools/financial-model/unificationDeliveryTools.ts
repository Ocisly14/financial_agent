import { validate } from "./schemas.ts";
import { subagentTool } from "./mappingSubagentTools.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject, JsonSchema, JsonValue } from "../../src/framework/types.ts";
import type { Period } from "../../src/financial-model/types.ts";
import type { InventoryRow } from "../../src/infra/xbrl/conceptInventory.ts";
import type { PresentationExtract } from "../../src/infra/xbrl/types.ts";
import type { FilingTable } from "../../src/infra/xbrl/tableTypes.ts";
import { materializeBreakdowns } from "../../src/infra/xbrl/dimensionInventory.ts";
import { applyUnificationPatch, buildUnifiedStatements, checkUnificationCompleteness,
  type UnificationDecision, type UnificationPatch, type UnifiedStatementsArtifact } from "../../src/infra/xbrl/unifiedStatements.ts";

const COMPONENT: JsonSchema = { type: "object", additionalProperties: false, required: ["conceptQName", "weight"],
  properties: { conceptQName: { type: "string" },
    alsoTaggedAs: { type: "array", items: { type: "object", additionalProperties: false, required: ["conceptQName"],
      properties: { conceptQName: { type: "string" }, sign: { type: "number" } } } },
    dimensionSignature: { type: "string" }, openingBalance: { type: "boolean" }, weight: { type: "number" } } };

const OVERRIDE: JsonSchema = { type: "object", additionalProperties: false, required: ["periodId", "components", "reason"],
  properties: { periodId: { type: "string" }, components: { type: "array", items: COMPONENT }, reason: { type: "string" } } };

const HELD_OUT = (extra: Record<string, JsonSchema>, required: string[]): JsonSchema =>
  ({ type: "array", items: { type: "object", additionalProperties: false,
    required: ["conceptQName", "reason", ...required],
    properties: { conceptQName: { type: "string" }, dimensionSignature: { type: "string" },
      openingBalance: { type: "boolean" }, reason: { type: "string" }, ...extra } } });

const ROW: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rowId", "statement", "label", "components", "rationale"],
  properties: { rowId: { type: "string" }, statement: { type: "string" }, label: { type: "string" },
    components: { type: "array", items: COMPONENT }, perYearOverrides: { type: "array", items: OVERRIDE },
    breakdowns: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["axisQName", "conceptQName", "rationale"],
      properties: { axisQName: { type: "string" }, conceptQName: { type: "string" }, rationale: { type: "string" },
        members: { type: "array", items: { type: "object", additionalProperties: false, required: ["memberQName"],
          properties: { memberQName: { type: "string" }, parentMemberQName: { type: "string" } } } } } } },
    rationale: { type: "string" } } };

export const UNIFICATION_DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["decision"], properties: { decision: { type: "object", additionalProperties: false, required: ["rows"],
    properties: { rows: { type: "array", items: ROW }, excluded: HELD_OUT({}, []),
      supplemental: HELD_OUT({ label: { type: "string" } }, ["label"]) } } } };

export const UNIFICATION_PATCH_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["patch"], properties: { patch: { type: "object", additionalProperties: false, required: [],
    properties: { upsertRows: { type: "array", items: ROW }, deleteRowIds: { type: "array", items: { type: "string" } },
      excluded: HELD_OUT({}, []), supplemental: HELD_OUT({ label: { type: "string" } }, ["label"]) } } } };

export type UnificationDelivery = { decision: UnificationDecision; artifact: UnifiedStatementsArtifact; findings: string[] };

/**
 * The subagent's delivery surface. Submitting is where the host's three checks run — completeness
 * against its OWN inventory, the statement build, and the breakdown partition — and their findings
 * come back as the tool's result. That is the whole point: correction stops being a `for` loop the
 * host drives and becomes something the subagent can see and answer, one step at a time.
 *
 * Patching exists because a hundred-row decision costs minutes to regenerate and drifts between
 * attempts, while the fix for a handful of findings is a few rows long.
 */
export function createUnificationDeliveryTools(context: {
  filings: readonly PresentationExtract[];
  requestedPeriods: readonly Period[];
  inventory: readonly InventoryRow[];
  tables: readonly FilingTable[];
}): { tools: RegisteredTool[]; delivered: () => UnificationDelivery | undefined } {
  let delivered: UnificationDelivery | undefined;

  const evaluate = (decision: UnificationDecision): JsonValue => {
    const completeness = checkUnificationCompleteness({ inventory: context.inventory, decision,
      requestedPeriods: context.requestedPeriods });
    const artifact = buildUnifiedStatements({ decision, filings: context.filings,
      requestedPeriods: context.requestedPeriods, inventory: context.inventory });
    const breakdowns = materializeBreakdowns({ decision, tables: context.tables,
      requestedPeriods: context.requestedPeriods,
      parentValues: Object.fromEntries(artifact.rows.map((row) => [row.rowId, row.values])) });
    const findings = [...completeness, ...artifact.findings, ...breakdowns.findings];
    // Held even when dirty: a decision carrying findings beats discarding minutes of work, and the
    // host ships the last one if the step budget runs out mid-correction.
    delivered = { decision, findings,
      artifact: { ...artifact, breakdownRows: breakdowns.breakdownRows, unresolvedFindings: findings } };
    return { status: findings.length === 0 ? "accepted" : "incomplete",
      rows: artifact.rows.length, breakdownRows: breakdowns.breakdownRows.length,
      // Findings run to hundreds of lines on a bad decision; the tail is no more informative than
      // the head, and burying the step in them helps nobody.
      findingCount: findings.length, findings: findings.slice(0, 40) } as unknown as JsonValue;
  };

  const submit = subagentTool({
    name: "submit_unification_decision", category: "non_trading",
    description: "Submit your complete unification decision. Returns the host's findings against it; an empty findings list means it is accepted.",
    inputSchema: UNIFICATION_DECISION_SCHEMA,
  }, (raw: JsonObject) => {
    validate(raw, UNIFICATION_DECISION_SCHEMA, "$", true);
    return evaluate(raw["decision"] as unknown as UnificationDecision);
  });

  const patch = subagentTool({
    name: "patch_unification_decision", category: "non_trading",
    description: "Correct the decision you already submitted, without restating it whole. rows are patched by rowId — upsert or delete only the ones at fault, and any row you do not name is left as it is. excluded and supplemental are not keyed: each REPLACES its list wholesale, so send the complete list or omit the key. Returns the host's findings against the patched decision, so you can patch again without resubmitting.",
    inputSchema: UNIFICATION_PATCH_SCHEMA,
  }, (raw: JsonObject) => {
    if (!delivered) throw new Error("no decision submitted yet — call submit_unification_decision first");
    validate(raw, UNIFICATION_PATCH_SCHEMA, "$", true);
    return evaluate(applyUnificationPatch(delivered.decision, raw["patch"] as unknown as UnificationPatch));
  });

  return { tools: [submit, patch], delivered: () => delivered };
}
