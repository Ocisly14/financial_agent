import { validate } from "./schemas.ts";
import { subagentTool } from "./mappingSubagentTools.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject, JsonSchema, JsonValue } from "../../src/framework/types.ts";
import type { Fact, ReconciliationResult } from "../../src/financial-model/types.ts";
import { applySpinePatch, buildSpineFromUnified, checkSpineCompleteness,
  type SpineDecision, type SpinePatch } from "../../src/infra/xbrl/spineFromUnified.ts";
import type { UnifiedStatementsArtifact } from "../../src/infra/xbrl/unifiedStatements.ts";

const MAPPING: JsonSchema = { type: "object", additionalProperties: false,
  required: ["targetId", "rowIds", "rationale"],
  properties: { targetId: { type: "string" }, rowIds: { type: "array", items: { type: "string" } },
    rationale: { type: "string" } } };
const DETAIL_ROW: JsonSchema = { type: "object", additionalProperties: false,
  required: ["parentTargetId", "rowId", "rationale"],
  properties: { parentTargetId: { type: "string" }, rowId: { type: "string" }, rationale: { type: "string" } } };
const EXCLUSION: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rowId", "reason"], properties: { rowId: { type: "string" }, reason: { type: "string" } } };
const SPINE_GAP: JsonSchema = { type: "object", additionalProperties: false,
  required: ["targetId", "reason"], properties: { targetId: { type: "string" }, reason: { type: "string" } } };
const idList: JsonSchema = { type: "array", items: { type: "string" } };

export const SPINE_DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["decision"], properties: { decision: { type: "object", additionalProperties: false,
    required: ["mappings", "detailRows", "excluded", "spineGaps"], properties: {
      mappings: { type: "array", items: MAPPING },
      detailRows: { type: "array", items: DETAIL_ROW },
      excluded: { type: "array", items: EXCLUSION },
      spineGaps: { type: "array", items: SPINE_GAP } } } } };

export const SPINE_PATCH_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["patch"], properties: { patch: { type: "object", additionalProperties: false, required: [], properties: {
    upsertMappings: { type: "array", items: MAPPING }, deleteMappingTargetIds: idList,
    upsertDetailRows: { type: "array", items: DETAIL_ROW }, deleteDetailRowIds: idList,
    upsertExcluded: { type: "array", items: EXCLUSION }, deleteExcludedRowIds: idList,
    upsertSpineGaps: { type: "array", items: SPINE_GAP }, deleteSpineGapTargetIds: idList } } } };

export type SpineDelivery = { decision: SpineDecision; facts: Fact[];
  coverageGaps: Array<{ targetId: string; periodId: string }>;
  optionalCoverageGaps: Array<{ targetId: string; periodId: string }>;
  findings: string[];
  reconciliationFailures: ReconciliationResult[] };

/** The spine_mapping agent's delivery surface — the same contract statement_unification gets:
 *  submit, read the host's findings off the tool result, correct with a patch. */
export function createSpineDeliveryTools(context: {
  unified: UnifiedStatementsArtifact;
  spineIds: ReadonlySet<string>;
  requiredIds: ReadonlySet<string>;
  /** Runs the proposed mapping against the current workbook without writing a revision. */
  previewReconciliations?: (facts: readonly Fact[]) => readonly ReconciliationResult[];
}): { tools: RegisteredTool[]; delivered: () => SpineDelivery | undefined;
  lastEvaluation: () => SpineDelivery | undefined } {
  let delivered: SpineDelivery | undefined;
  let lastEvaluation: SpineDelivery | undefined;

  const evaluate = (decision: SpineDecision): JsonValue => {
    const completeness = checkSpineCompleteness({ unified: context.unified, decision,
      spineIds: context.spineIds, requiredIds: context.requiredIds });
    const built = buildSpineFromUnified({ decision, unified: context.unified,
      spineIds: context.spineIds, requiredIds: context.requiredIds });
    const reconciliationFailures = completeness.length === 0 && built.findings.length === 0
      ? [...(context.previewReconciliations?.(built.facts) ?? [])].filter((result) => result.required && result.status === "failed")
      : [];
    const reconciliationFindings = reconciliationFailures.map((result) => {
      const rows = result.unifiedTrail?.flatMap((trail) => trail.rowIds).join(", ") ?? "none";
      return `reconciliation_failed: ${result.ruleId}@${result.periodId}; actual=${result.actual}; calculated=${result.calculated}; residual=${result.residual}; unified_rows=${rows}`;
    });
    const findings = [...completeness, ...built.findings, ...reconciliationFindings];
    const candidate: SpineDelivery = { decision, facts: built.facts, coverageGaps: built.coverageGaps,
      optionalCoverageGaps: built.optionalCoverageGaps, findings, reconciliationFailures };
    lastEvaluation = candidate;
    // A preview with findings is input to the mapping agent's correction loop, never a mapping that
    // downstream code may commit. This also revokes a previously accepted mapping after a bad patch.
    delivered = findings.length === 0 ? candidate : undefined;
    return { status: findings.length === 0 ? "accepted" : "incomplete",
      facts: built.facts.length, coverageGaps: built.coverageGaps.length,
      optionalCoverageGaps: built.optionalCoverageGaps,
      reconciliationFailures: reconciliationFailures.map((result) => ({ ruleId: result.ruleId,
        periodId: result.periodId, actual: result.actual, calculated: result.calculated,
        residual: result.residual, unifiedTrail: result.unifiedTrail ?? [] })),
      findingCount: findings.length, findings: findings.slice(0, 40) } as unknown as JsonValue;
  };

  const submit = subagentTool({
    name: "submit_spine_decision", category: "non_trading",
    description: "Submit your complete spine mapping. The host checks structural coverage AND dry-runs the resulting workbook reconciliations. If reconciliationFailures is non-empty, inspect its rule, period, residual, and unifiedTrail, then patch the mapping before finishing.",
    inputSchema: SPINE_DECISION_SCHEMA,
  }, (raw: JsonObject) => {
    validate(raw, SPINE_DECISION_SCHEMA, "$", true);
    return evaluate(raw["decision"] as unknown as SpineDecision);
  });

  const patch = subagentTool({
    name: "patch_spine_decision", category: "non_trading",
    description: "Correct the mapping you already submitted, without restating it whole. Every list is patched by its own key — targetId, or rowId for the row-scoped ones — so upsert or delete only the entries at fault, and anything you do not name is left as it is. The host re-runs structural and accounting reconciliation checks after every patch; do not finish until reconciliationFailures is empty.",
    inputSchema: SPINE_PATCH_SCHEMA,
  }, (raw: JsonObject) => {
    if (!lastEvaluation) throw new Error("no mapping submitted yet — call submit_spine_decision first");
    validate(raw, SPINE_PATCH_SCHEMA, "$", true);
    return evaluate(applySpinePatch(lastEvaluation.decision, raw["patch"] as unknown as SpinePatch));
  });

  return { tools: [submit, patch], delivered: () => delivered, lastEvaluation: () => lastEvaluation };
}
