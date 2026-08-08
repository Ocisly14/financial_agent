import type { JsonObject, JsonValue } from "../../framework/types.ts";
import type { LifecycleStage } from "../../financial-model/types.ts";
import type { ModelClass } from "../../infra/llm/provider.ts";
import type { ModelContextView } from "../../financial-model/views.ts";
import type { FilingInsightContextView } from "../../infra/filing-insights/types.ts";
import { readOnlyProposalPrompt, spineMappingPrompt,
  statementUnificationPrompt } from "../prompts/dcfSubagentPrompts.ts";

/**
 * The DCF Agent's subagents — every one of them an LLM call. Filing extraction is deliberately NOT
 * here: it is a deterministic Arelle pipeline the DCF Agent calls as a plain tool.
 *
 * statement_unification aligns the issuer's own concepts across years; spine_mapping places those
 * unified rows on the canonical spine. Both read what extraction stored and write their result back to
 * the store, returning the DCF Agent a description of what they did rather than the data itself.
 * forecast_modeling and valuation_review then work the resulting workbook as read-only proposals.
 */
export type DcfSubagentKind = "statement_unification" | "spine_mapping" | "forecast_modeling" | "valuation_review";
export type ModelingProposalSubagent = Exclude<DcfSubagentKind, "statement_unification" | "spine_mapping">;

export type DcfSubagentProposal<T extends JsonValue = JsonValue> = {
  subagent: ModelingProposalSubagent;
  modelId: string;
  baseRevision: number;
  lifecycleStage: LifecycleStage;
  rationale: string;
  payload: T;
  sourceRefs: string[];
};


export type DcfSubagentProjection = {
  subagent: ModelingProposalSubagent;
  modelId: string;
  baseRevision: number;
  lifecycleStage: LifecycleStage;
  workbook: JsonObject;
  filingInsights: FilingInsightContextView | null;
};

/** Stage-specific read projection; never includes owner credentials or tool handles. */
export function projectForDcfSubagent(
  subagent: ModelingProposalSubagent,
  context: ModelContextView,
  filingInsights: FilingInsightContextView | null,
): DcfSubagentProjection {
  const workbook = context.currentWorkbook;
  const sections = subagent === "forecast_modeling"
    ? { history: workbook.sections.history, metrics: workbook.sections.metrics, revenue: workbook.sections.revenue, operations: workbook.sections.operations }
    : { operations: workbook.sections.operations, dcf: workbook.sections.dcf };
  return { subagent, modelId: context.model.modelId, baseRevision: workbook.revision,
    lifecycleStage: workbook.lifecycleStage, workbook: { periods: workbook.periods, sections, diagnostics: workbook.diagnostics,
      reconciliationResults: workbook.reconciliationResults,
      valuationConfig: workbook.valuationConfig,
      ...(subagent === "valuation_review" ? { valuation: workbook.valuation } : {}) }, filingInsights };
}

export function assertFreshDcfProposal<T extends JsonValue>(proposal: DcfSubagentProposal<T>, context: ModelContextView): void {
  if (proposal.modelId !== context.model.modelId || proposal.baseRevision !== context.currentWorkbook.revision
    || proposal.lifecycleStage !== context.currentWorkbook.lifecycleStage) {
    throw new Error(`stale_dcf_proposal: expected ${context.model.modelId}@${context.currentWorkbook.revision}/${context.currentWorkbook.lifecycleStage}`);
  }
}

/** Private registry is intentionally a different type from framework SubagentRegistry. */
export type DcfSubagentDefinition = {
  name: DcfSubagentKind;
  modelClass: ModelClass;
  authority: "read_only_proposal";
  prompt: string;
};

export class DcfSubagentRegistry {
  private readonly subagents = new Map<DcfSubagentKind, DcfSubagentDefinition>();
  constructor() {
    this.register({ name: "statement_unification", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: statementUnificationPrompt });
    this.register({ name: "spine_mapping", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: spineMappingPrompt });
    for (const name of ["forecast_modeling", "valuation_review"] as const) {
      this.register({ name, modelClass: "MEDIUM", authority: "read_only_proposal", prompt: readOnlyProposalPrompt(name) });
    }
  }
  register(definition: DcfSubagentDefinition): void {
    if (this.subagents.has(definition.name)) throw new Error(`duplicate DCF subagent: ${definition.name}`);
    this.subagents.set(definition.name, definition);
  }
  get(subagent: DcfSubagentKind): DcfSubagentDefinition {
    const definition = this.subagents.get(subagent); if (!definition) throw new Error(`unknown DCF subagent: ${subagent}`); return definition;
  }
  has(subagent: DcfSubagentKind): boolean { return this.subagents.has(subagent); }
  list(): DcfSubagentKind[] { return [...this.subagents.keys()]; }
}
