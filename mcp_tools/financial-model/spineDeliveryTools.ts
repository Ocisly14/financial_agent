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
    const previewed = completeness.length === 0 && built.findings.length === 0
      ? [...(context.previewReconciliations?.(built.facts) ?? [])].filter((result) => result.required)
      : [];
    const reconciliationFailures = previewed.filter((result) => result.status === "failed");
    // A required check the mapping made unrunnable is withheld work, not a pass: it blocks delivery
    // just as a failure does, or the agent finishes on checks that never executed.
    const reconciliationSkips = previewed.filter(isStructuralSkip);
    const reconciliationFindings = previewed
      .flatMap((result) => describeReconciliationResult(result) ?? []);
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
      reconciliationSkips: reconciliationSkips.map((result) => ({ ruleId: result.ruleId,
        periodId: result.periodId, reason: result.skipReason.kind, refs: result.skipReason.refs })),
      findingCount: findings.length, findings: findings.slice(0, 40) } as unknown as JsonValue;
  };

  const submit = subagentTool({
    name: "submit_spine_decision", category: "non_trading",
    description: "Submit your complete spine mapping. The host checks structural coverage AND dry-runs the resulting workbook reconciliations. If reconciliationFailures is non-empty, inspect its rule, period, residual, and unifiedTrail — each trail entry names one term of the identity and the rows it was summed from, or why it has none: <unmapped> is a row you still owe, <superseded> and <derived> mean the cell is driven by a formula rather than your mapping. If reconciliationSkips is non-empty the check could not run at all: unit_mismatch means you mapped rows of one unit onto a target of another, missing_line_item means the named row is absent. Patch the mapping before finishing.",
    inputSchema: SPINE_DECISION_SCHEMA,
  }, (raw: JsonObject) => {
    validate(raw, SPINE_DECISION_SCHEMA, "$", true);
    return evaluate(raw["decision"] as unknown as SpineDecision);
  });

  const patch = subagentTool({
    name: "patch_spine_decision", category: "non_trading",
    description: "Correct the mapping you already submitted, without restating it whole. Every list is patched by its own key — targetId, or rowId for the row-scoped ones — so upsert or delete only the entries at fault, and anything you do not name is left as it is. The host re-runs structural and accounting reconciliation checks after every patch; do not finish until both reconciliationFailures and reconciliationSkips are empty.",
    inputSchema: SPINE_PATCH_SCHEMA,
  }, (raw: JsonObject) => {
    if (!lastEvaluation) throw new Error("no mapping submitted yet — call submit_spine_decision first");
    validate(raw, SPINE_PATCH_SCHEMA, "$", true);
    return evaluate(applySpinePatch(lastEvaluation.decision, raw["patch"] as unknown as SpinePatch));
  });

  return { tools: [submit, patch], delivered: () => delivered, lastEvaluation: () => lastEvaluation };
}
