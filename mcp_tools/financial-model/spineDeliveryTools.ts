import { validate } from "./schemas.ts";
import { SYMBOL_INPUT, resolveModel, runKey, runStateStore, spineTargets, subagentTool } from "./mappingShared.ts";
import { refreshWaccSheetFromSpine, type FinancialModelToolDeps } from "./financialModelTools.ts";
import type { RegisteredTool, ToolExecutionContext } from "../toolRegistry.ts";
import type { JsonSchema, JsonValue } from "../../src/framework/types.ts";
import type { Fact, ReconciliationResult } from "../../src/financial-model/types.ts";
import { FinancialModelService } from "../../src/financial-model/service.ts";
import { CANONICAL_MAPPING_IDS, REQUIRED_MAPPING_IDS } from "../../src/financial-model/skeleton.ts";
import { applySpinePatch, buildSpineFromUnified, checkSpineCompleteness, resolveDetailLineItemIds,
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

/**
 * A check that could not run because the mapping is wrong, as opposed to merely thin.
 *
 * `missing_values` is deliberately excluded: an empty cell is already a coverage_gap finding, and a
 * period the filing only partly covers would otherwise fail delivery twice over. `no_prior_period`
 * is expected by construction.
 */
function isStructuralSkip(result: ReconciliationResult): result is ReconciliationResult
  & { skipReason: NonNullable<ReconciliationResult["skipReason"]> } {
  return result.skipReason?.kind === "unit_mismatch" || result.skipReason?.kind === "missing_line_item";
}

/**
 * One line an agent can act on, or nothing. Two things this deliberately does not do: pool the
 * trail's rowIds into one list — which term a row belongs to is the whole point of following it —
 * and stay quiet about a structural skip. `not_applicable` reads as "rule does not apply", but a
 * unit mismatch or an absent row wearing that status is a mapping defect that reaches the agent
 * through no other channel.
 */
export function describeReconciliationResult(result: ReconciliationResult): string | undefined {
  if (result.status === "failed") {
    const trail = result.unifiedTrail === undefined || result.unifiedTrail.length === 0
      ? "none"
      : result.unifiedTrail.map((step) => `${step.lineItemId}=${step.rowIds.length > 0
        ? step.rowIds.join("+")
        : `<${step.absent ?? "no_rows"}>`}`).join("; ");
    return `reconciliation_failed: ${result.ruleId}@${result.periodId}; actual=${result.actual}; `
      + `calculated=${result.calculated}; residual=${result.residual}; unified_rows=${trail}`;
  }
  if (isStructuralSkip(result)) {
    return `reconciliation_skipped: ${result.ruleId}@${result.periodId}; `
      + `reason=${result.skipReason.kind}; refs=${result.skipReason.refs.join(", ")}`;
  }
  return undefined;
}

export type SpineDelivery = { decision: SpineDecision; facts: Fact[];
  coverageGaps: Array<{ targetId: string; periodId: string }>;
  optionalCoverageGaps: Array<{ targetId: string; periodId: string }>;
  findings: string[];
  reconciliationFailures: ReconciliationResult[] };

type SpineRunState = {
  modelId: string;
  symbol: string;
  unified: UnifiedStatementsArtifact;
  spineIds: ReadonlySet<string>;
  requiredIds: ReadonlySet<string>;
  historicalPeriodIds: string[];
  labelByRowId: Map<string, string>;
  /** The workbook revision the next commit must build on; advanced by each commit this run makes. */
  baseRevision: number;
  lastEvaluation?: SpineDelivery;
};

/**
 * The spine_mapping agent's whole toolset — the same contract statement_unification gets: load the
 * working set, submit, read the findings off the tool result, correct with a patch. Structural
 * coverage AND a dry run of the workbook reconciliations gate every evaluation, and an accepted
 * mapping commits itself: facts land in the workbook and the WACC sheet refreshes inside the same
 * tool result the agent reads, so the revision it must quote onward is in its own transcript.
 */
export function createSpineAgentTools(deps: FinancialModelToolDeps): RegisteredTool[] {
  const runs = runStateStore<SpineRunState>();

  const requireRun = (context: ToolExecutionContext): SpineRunState => {
    const state = runs.get(runKey(context));
    if (!state) throw new Error("no working set loaded — call load_unified_statements with your ticker first");
    return state;
  };

  const evaluate = async (state: SpineRunState, context: ToolExecutionContext, decision: SpineDecision): Promise<JsonValue> => {
    const service = new FinancialModelService(deps.modelStore, context.sessionId);
    const labels = Object.fromEntries((state.unified.breakdownRows ?? []).map((row) => [row.rowId, row.label]));
    const completeness = checkSpineCompleteness({ unified: state.unified, decision,
      spineIds: state.spineIds, requiredIds: state.requiredIds });
    const built = buildSpineFromUnified({ decision, unified: state.unified,
      spineIds: state.spineIds, requiredIds: state.requiredIds });
    const previewed = completeness.length === 0 && built.findings.length === 0
      ? service.previewSpineFacts(state.modelId, { facts: built.facts,
        historicalPeriodIds: state.historicalPeriodIds, labels }).filter((result) => result.required)
      : [];
    const reconciliationFailures = previewed.filter((result) => result.status === "failed");
    // A required check the mapping made unrunnable is withheld work, not a pass: it blocks delivery
    // just as a failure does, or the agent finishes on checks that never executed.
    const reconciliationSkips = previewed.filter(isStructuralSkip);
    const reconciliationFindings = previewed
      .flatMap((result) => describeReconciliationResult(result) ?? []);
    const findings = [...completeness, ...built.findings, ...reconciliationFindings];
    state.lastEvaluation = { decision, facts: built.facts, coverageGaps: built.coverageGaps,
      optionalCoverageGaps: built.optionalCoverageGaps, findings, reconciliationFailures };

    // A clean mapping commits itself. This used to be a host callback invoked after the run ended;
    // committing at the moment of acceptance keeps the whole run on the ordinary dispatch path and
    // puts the resulting revision in the tool result the agent reads and reports onward.
    let committedRevision: number | undefined;
    if (findings.length === 0 && built.facts.length > 0) {
      const detailIds = resolveDetailLineItemIds(decision, state.unified);
      const detailLabels = Object.fromEntries(decision.detailRows.map((detail) => [
        detailIds[detail.rowId]!, state.labelByRowId.get(detail.rowId) ?? detail.rowId,
      ]));
      const commit = service.commitSpineFacts(state.modelId, state.baseRevision, {
        facts: [...built.facts], labels: detailLabels, historicalPeriodIds: state.historicalPeriodIds,
      });
      // Committed facts make WACC terms derivable; refresh as the mapping's final commit step.
      const waccOutcome = await refreshWaccSheetFromSpine(deps, service, state.modelId, commit.revision);
      committedRevision = waccOutcome.kind === "refreshed" ? waccOutcome.result.currentWorkbook.revision : commit.revision;
      state.baseRevision = committedRevision;
    }

    return { status: findings.length === 0 ? "accepted" : "incomplete",
      ...(committedRevision === undefined ? {} : { committedRevision,
        next: `facts are in the workbook at revision ${committedRevision}; finish with that revision in your summary` }),
      facts: built.facts.length, coverageGaps: built.coverageGaps.length,
      optionalCoverageGaps: built.optionalCoverageGaps,
      reconciliationFailures: reconciliationFailures.map((result) => ({ ruleId: result.ruleId,
        periodId: result.periodId, actual: result.actual, calculated: result.calculated,
        residual: result.residual, unifiedTrail: result.unifiedTrail ?? [] })),
      reconciliationSkips: reconciliationSkips.map((result) => ({ ruleId: result.ruleId,
        periodId: result.periodId, reason: result.skipReason.kind, refs: result.skipReason.refs })),
      findingCount: findings.length, findings: findings.slice(0, 40) } as unknown as JsonValue;
  };

  const load = subagentTool({
    name: "load_unified_statements", category: "non_trading",
    description: "Load the unified multi-year statements statement_unification stored for one ticker, "
      + "including any disclosed dimension breakdown rows that may be selected as revenue detail rows, "
      + "with the canonical spine target ids you map them onto — required ones separated from optional. "
      + "Always your first call: it opens the working set the delivery tools read.",
    inputSchema: SYMBOL_INPUT,
  }, (raw, context) => {
    const { modelId, symbol } = resolveModel(deps, context.tenantId, raw, SYMBOL_INPUT);
    const review = deps.sourceReviewStore.get(modelId);
    if (!review?.unifiedStatements) throw new Error(`${symbol} has no unified statements; run statement_unification first`);
    const unified = review.unifiedStatements;
    const service = new FinancialModelService(deps.modelStore, context.sessionId);
    const current = service.getModel(modelId);
    if (!("currentWorkbook" in current)) throw new Error("default model context expected");
    runs.set(runKey(context), { modelId, symbol, unified,
      spineIds: new Set(CANONICAL_MAPPING_IDS), requiredIds: REQUIRED_MAPPING_IDS,
      historicalPeriodIds: current.currentWorkbook.periods.filter((period) => period.cls === "actual").map((period) => period.id),
      labelByRowId: new Map([...unified.rows, ...(unified.breakdownRows ?? [])].map((row) => [row.rowId, row.label])),
      baseRevision: current.currentWorkbook.revision });
    return { symbol, periods: unified.periods, rows: unified.rows,
      breakdownRows: unified.breakdownRows ?? [],
      spineTargets: spineTargets() } as unknown as JsonValue;
  });

  const submit = subagentTool({
    name: "submit_spine_decision", category: "non_trading",
    description: "Submit your complete spine mapping. The host checks structural coverage AND dry-runs the resulting workbook reconciliations; a clean mapping commits its facts to the workbook and returns the new revision. If reconciliationFailures is non-empty, inspect its rule, period, residual, and unifiedTrail — each trail entry names one term of the identity and the rows it was summed from, or why it has none: <unmapped> is a row you still owe, <superseded> and <derived> mean the cell is driven by a formula rather than your mapping. If reconciliationSkips is non-empty the check could not run at all: unit_mismatch means you mapped rows of one unit onto a target of another, missing_line_item means the named row is absent. Patch the mapping before finishing.",
    inputSchema: SPINE_DECISION_SCHEMA,
  }, (raw, context) => {
    const state = requireRun(context);
    validate(raw, SPINE_DECISION_SCHEMA, "$", true);
    return evaluate(state, context, raw["decision"] as unknown as SpineDecision);
  });

  const patch = subagentTool({
    name: "patch_spine_decision", category: "non_trading",
    description: "Correct the mapping you already submitted, without restating it whole. Every list is patched by its own key — targetId, or rowId for the row-scoped ones — so upsert or delete only the entries at fault, and anything you do not name is left as it is. The host re-runs structural and accounting reconciliation checks after every patch; do not finish until both reconciliationFailures and reconciliationSkips are empty.",
    inputSchema: SPINE_PATCH_SCHEMA,
  }, (raw, context) => {
    const state = requireRun(context);
    if (!state.lastEvaluation) throw new Error("no mapping submitted yet — call submit_spine_decision first");
    validate(raw, SPINE_PATCH_SCHEMA, "$", true);
    return evaluate(state, context, applySpinePatch(state.lastEvaluation.decision, raw["patch"] as unknown as SpinePatch));
  });

  return [load, submit, patch];
}
