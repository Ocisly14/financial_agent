import { validate } from "./schemas.ts";
import { AXIS_INPUT, SYMBOL_INPUT, dimensionContext, resolveModel, runKey, runStateStore, subagentTool,
  type MappingSubagentDeps } from "./mappingShared.ts";
import type { RegisteredTool, ToolExecutionContext } from "../toolRegistry.ts";
import type { JsonObject, JsonSchema, JsonValue } from "../../src/framework/types.ts";
import type { Period } from "../../src/financial-model/types.ts";
import type { InventoryRow } from "../../src/infra/xbrl/conceptInventory.ts";
import { buildConceptInventory } from "../../src/infra/xbrl/conceptInventory.ts";
import type { PresentationExtract } from "../../src/infra/xbrl/types.ts";
import type { FilingTable } from "../../src/infra/xbrl/tableTypes.ts";
import { buildAxisBreakdown, buildAxisCatalog, materializeBreakdowns } from "../../src/infra/xbrl/dimensionInventory.ts";
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

const HELD_OUT_REF: JsonSchema = { type: "object", additionalProperties: false, required: ["conceptQName"],
  properties: { conceptQName: { type: "string" }, dimensionSignature: { type: "string" }, openingBalance: { type: "boolean" } } };

const ROW: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rowId", "statement", "label", "components", "rationale"],
  properties: { rowId: { type: "string" }, statement: { type: "string" }, label: { type: "string" },
    components: { type: "array", items: COMPONENT }, perYearOverrides: { type: "array", items: OVERRIDE },
    breakdowns: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["axisQName", "conceptQName", "rationale"],
      properties: { axisQName: { type: "string" }, conceptQName: { type: "string" }, rationale: { type: "string" },
        members: { type: "array", items: { type: "object", additionalProperties: false, required: ["memberQName"],
          properties: { memberQName: { type: "string" }, parentMemberQName: { type: "string" } } } } } } },
    // Required on every row, not only on merges — spelled out here because the prompt once said
    // "whenever a row merges >1 component", and a decision that followed that lost the whole batch.
    rationale: { type: "string",
      description: "Why this row is composed the way it is. Required on EVERY row: for a single-component row, \"one concept, reported directly\" is enough." } } };

export const UNIFICATION_DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["decision"], properties: { decision: { type: "object", additionalProperties: false, required: ["rows"],
    properties: { rows: { type: "array", items: ROW }, excluded: HELD_OUT({}, []),
      supplemental: HELD_OUT({ label: { type: "string" } }, ["label"]) } } } };

export const UNIFICATION_PATCH_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["patch"], properties: { patch: { type: "object", additionalProperties: false, required: [],
    properties: { upsertRows: { type: "array", items: ROW }, deleteRowIds: { type: "array", items: { type: "string" } },
      excluded: HELD_OUT({}, []), supplemental: HELD_OUT({ label: { type: "string" } }, ["label"]),
      upsertExcluded: HELD_OUT({}, []), deleteExcluded: { type: "array", items: HELD_OUT_REF },
      upsertSupplemental: HELD_OUT({ label: { type: "string" } }, ["label"]),
      deleteSupplemental: { type: "array", items: HELD_OUT_REF } } } } };

const EMPTY_OBJECT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, properties: {} };

export type UnificationDelivery = { decision: UnificationDecision; artifact: UnifiedStatementsArtifact; findings: string[] };

type UnificationRunState = {
  modelId: string;
  symbol: string;
  filings: readonly PresentationExtract[];
  requestedPeriods: readonly Period[];
  inventory: readonly InventoryRow[];
  tables: readonly FilingTable[];
  draft?: UnificationDecision;
  hasEvaluation: boolean;
  lastEvaluation?: UnificationDelivery;
};


/**
 * The statement_unification agent's whole toolset, registered process-wide like every other agent's.
 *
 * These used to be built per run by a host that closed over the working set, dispatched the agent by
 * hand, and persisted the artifact after the run — which meant the agent's declared pool was
 * decorative and the host's throw left the dispatch without a task_result. Now the first tool call
 * loads the working set out of the store into per-task state, and an accepted submission persists
 * itself: the store write happens at the moment the checks pass, inside the same tool result the
 * agent reads.
 *
 * Submitting is a dry run until it is clean: completeness against the run's own inventory, the
 * statement build, and the breakdown partition all run before anything can leave the agent, and a
 * later patch that dirties an accepted decision revokes the stored artifact's claim to be current
 * only by never overwriting it — the store holds the last ACCEPTED state, nothing else.
 */
export function createUnificationAgentTools(deps: MappingSubagentDeps): RegisteredTool[] {
  const runs = runStateStore<UnificationRunState>();

  const requireRun = (context: ToolExecutionContext): UnificationRunState => {
    const state = runs.get(runKey(context));
    if (!state) throw new Error("no working set loaded — call load_concept_inventory with your ticker first");
    return state;
  };

  const evaluate = (state: UnificationRunState): JsonValue => {
    const decision = state.draft!;
    const completeness = checkUnificationCompleteness({ inventory: state.inventory, decision,
      requestedPeriods: state.requestedPeriods });
    const artifact = buildUnifiedStatements({ decision, filings: state.filings,
      requestedPeriods: state.requestedPeriods, inventory: state.inventory });
    const breakdowns = materializeBreakdowns({ decision, tables: state.tables,
      requestedPeriods: state.requestedPeriods,
      parentValues: Object.fromEntries(artifact.rows.map((row) => [row.rowId, row.values])) });
    const findings = [...completeness, ...artifact.findings, ...breakdowns.findings];
    const candidate: UnificationDelivery = { decision, findings,
      artifact: { ...artifact, breakdownRows: breakdowns.breakdownRows, unresolvedFindings: findings } };
    state.hasEvaluation = true;
    state.lastEvaluation = candidate;
    // Only a clean, fully verified candidate crosses the agent boundary — by being written to the
    // store, where spine_mapping reads it. Persisting here, on acceptance, is what lets the whole
    // run go through the ordinary dispatch path with no host waiting outside to do it.
    if (findings.length === 0) {
      const review = deps.sourceReviewStore.get(state.modelId);
      if (!review) throw new Error(`source review for model ${state.modelId} disappeared mid-run`);
      deps.sourceReviewStore.save(state.modelId, { ...review, unifiedStatements: candidate.artifact });
    }
    return { status: findings.length === 0 ? "accepted" : "incomplete",
      ...(findings.length === 0 ? { stored: true, next: "dispatch spine_mapping" } : {}),
      rows: artifact.rows.length, breakdownRows: breakdowns.breakdownRows.length,
      restatements: artifact.restatements.length,
      rollupBreaks: artifact.rollupBreaks.filter((issue) => issue.material !== false).length,
      // Findings run to hundreds of lines on a bad decision; the tail is no more informative than
      // the head, and burying the step in them helps nobody.
      findingCount: findings.length, findings: findings.slice(0, 40) } as unknown as JsonValue;
  };

  const load = subagentTool({
    name: "load_concept_inventory", category: "non_trading",
    description: "Load the XBRL concept inventory and requested periods for one ticker's extracted filings. Always your first call: it opens the working set every other tool in this run reads.",
    inputSchema: SYMBOL_INPUT,
  }, (raw, context) => {
    const { modelId, symbol } = resolveModel(deps, context.tenantId, raw, SYMBOL_INPUT);
    const review = deps.sourceReviewStore.get(modelId);
    if (!review) throw new Error(`no source review stored for ${symbol}`);
    if (!review.presentationExtracts?.length) throw new Error(`${symbol} has no presentation extracts; re-run extract_filing_statements`);
    const requestedPeriods = review.statementViews.income_statement.candidate.periods;
    const inventory = buildConceptInventory({ filings: review.presentationExtracts, requestedPeriods });
    runs.set(runKey(context), { modelId, symbol, filings: review.presentationExtracts, requestedPeriods,
      inventory, tables: deps.tableStore?.getRunTables(review.ingestionRunId) ?? [], hasEvaluation: false });
    return { symbol, requestedPeriods: requestedPeriods.map((period) => period.id),
      inventory } as unknown as JsonValue;
  });

  // Progressive disclosure: the concept inventory alone doesn't surface segment/geography axes,
  // so a subagent that needs a dimensional breakdown asks for it explicitly, one axis at a time.
  const axes = subagentTool({
    name: "list_dimension_axes", category: "non_trading",
    description: "List every XBRL dimension axis present in one ticker's extracted filings, with member counts and top concepts.",
    inputSchema: SYMBOL_INPUT,
  }, (raw, context) => {
    const c = dimensionContext(deps, context.tenantId, raw, SYMBOL_INPUT);
    return { symbol: c.symbol, axes: buildAxisCatalog({ tables: c.tables, requestedPeriods: c.requestedPeriods }) } as unknown as JsonValue;
  });

  const breakdown = subagentTool({
    name: "get_axis_breakdown", category: "non_trading",
    description: "Member-level values for one axis and concept, resolved latest-filing-wins.",
    inputSchema: AXIS_INPUT,
  }, (raw, context) => {
    const c = dimensionContext(deps, context.tenantId, raw, AXIS_INPUT);
    const cursor = raw["cursor"];
    if (cursor !== undefined && (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)) {
      throw new Error("cursor must be a non-negative integer from a previous response's nextCursor");
    }
    const result = buildAxisBreakdown({ tables: c.tables, requestedPeriods: c.requestedPeriods,
      axisQName: String(raw["axisQName"]), conceptQName: String(raw["conceptQName"]),
      ...(typeof raw["memberFilter"] === "string" ? { memberFilter: raw["memberFilter"] } : {}),
      ...(cursor !== undefined ? { cursor } : {}) });
    // A zero result from a fuzzy member search is information.  A zero result from the exact
    // axis/concept pair is instead a bad lookup, and should point the agent back to the catalog.
    if (result.members.length === 0 && raw["memberFilter"] === undefined) {
      throw new Error(`no dimensional members for ${result.axisQName}/${result.conceptQName}; `
        + "call list_dimension_axes and use one of its axis/concept pairs");
    }
    return { symbol: c.symbol, ...result } as unknown as JsonValue;
  });

  const submit = subagentTool({
    name: "submit_unification_decision", category: "non_trading",
    description: "Submit your complete unification decision. Returns the host's findings against it; an empty findings list means it is accepted and the unified statements are stored for spine_mapping.",
    inputSchema: UNIFICATION_DECISION_SCHEMA,
  }, (raw, context) => {
    const state = requireRun(context);
    validate(raw, UNIFICATION_DECISION_SCHEMA, "$", true);
    state.draft = raw["decision"] as unknown as UnificationDecision;
    return evaluate(state);
  });

  const startDraft = subagentTool({
    name: "start_unification_draft", category: "non_trading",
    description: "Discard the decision on file and start over from an empty draft. You do not need this to begin: the first patch_unification_decision opens a draft on its own. Use it only to abandon a decision you no longer want to patch.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  }, (raw, context) => {
    const state = requireRun(context);
    validate(raw, EMPTY_OBJECT_SCHEMA, "$", true);
    state.draft = { rows: [] };
    delete state.lastEvaluation;
    state.hasEvaluation = false;
    return { status: "draft_started", rows: 0 } as unknown as JsonValue;
  });

  const patch = subagentTool({
    name: "patch_unification_decision", category: "non_trading",
    description: "Update a decision without restating it whole. Rows are patched by rowId; excluded and supplemental can be patched by concept/dimension/opening-balance identity with upsertExcluded/deleteExcluded and upsertSupplemental/deleteSupplemental. The legacy excluded and supplemental fields replace their lists wholesale. Returns findings after validation, or just draft progress before first validation.",
    inputSchema: UNIFICATION_PATCH_SCHEMA,
  }, (raw, context) => {
    const state = requireRun(context);
    // The first batch opens the draft itself. An explicit start_unification_draft would cost a whole
    // round to send `{}`, and `draft` is only ever unset before the first write, so there is no
    // earlier state for a lazy start to lose.
    state.draft ??= { rows: [] };
    validate(raw, UNIFICATION_PATCH_SCHEMA, "$", true);
    state.draft = applyUnificationPatch(state.draft, raw["patch"] as unknown as UnificationPatch);
    // Preserve the existing submit → patch → findings workflow. Before the first validation, a
    // batch only updates the draft so the model is not flooded with premature completeness findings.
    return state.hasEvaluation ? evaluate(state) : { status: "draft_updated", rows: state.draft.rows.length } as unknown as JsonValue;
  });

  const validateDraft = subagentTool({
    name: "validate_unification_decision", category: "non_trading",
    description: "Validate the completed draft. Returns findings; patch only the named rows, then validate again until accepted.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  }, (raw, context) => {
    const state = requireRun(context);
    if (!state.draft) throw new Error("no draft on file — add your first batch with patch_unification_decision first");
    validate(raw, EMPTY_OBJECT_SCHEMA, "$", true);
    return evaluate(state);
  });

  return [load, axes, breakdown, submit, startDraft, patch, validateDraft];
}
