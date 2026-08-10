import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import type { ModelRouter } from "../../src/infra/llm/provider.ts";
import { FinancialModelService } from "../../src/financial-model/service.ts";
import type { FinancialModelToolDeps } from "./financialModelTools.ts";
import { validate } from "./schemas.ts";
import type { JsonSchema } from "../../src/framework/types.ts";
import { createSpineMappingTools, createStatementUnificationTools, type LoadedWorkingSet } from "./mappingSubagentTools.ts";
import { resolveDetailLineItemIds } from "../../src/infra/xbrl/spineFromUnified.ts";
import { runSpineMappingAgent } from "../../src/agent/financial-modeling/spineMappingAgent.ts";
import { runStatementUnificationAgent } from "../../src/agent/financial-modeling/statementUnificationAgent.ts";
import { DcfSubagentRegistry } from "../../src/agent/financial-modeling/subagents.ts";

export const DCF_PRIVATE_SUBAGENT_TOOL = "run_dcf_subagent";

const SUBAGENT_INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["subagent", "modelId", "task"], properties: {
    subagent: { type: "string", enum: ["statement_unification", "spine_mapping"] },
    modelId: { type: "string" }, task: { type: "string" },
  } };

export function createDcfSubagentTool(deps: {
  modelRouter: ModelRouter;
  financial: FinancialModelToolDeps;
  subagentRegistry?: DcfSubagentRegistry;
}): RegisteredTool {
  const subagents = deps.subagentRegistry ?? new DcfSubagentRegistry();
  return {
    name: DCF_PRIVATE_SUBAGENT_TOOL,
    description: "Private delegation from the DCF Agent to one bounded DCF subagent. Each works from data extract_filing_statements already stored, writes its result back to the store, and returns a description of what it did — never a model revision it committed itself.",
    category: "non_trading",
    inputSchema: SUBAGENT_INPUT_SCHEMA,
    async execute(input, context) {
      try { validate(input, SUBAGENT_INPUT_SCHEMA, "$", true); }
      catch (error) { return { summary: error instanceof Error ? error.message : String(error),
        error: { code: "invalid_tool_input", message: error instanceof Error ? error.message : String(error) } }; }
      const subagent = requiredString(input, "subagent");
      const modelId = requiredString(input, "modelId");
      {
        const meta = deps.financial.modelStore.getMeta(modelId);
        if (!meta || meta.ownerAgentId !== context.agentId) return { summary: "Financial model not found.", error: { code: "financial_model_not_found", message: "Financial model not found." } };
        const sourceReview = deps.financial.sourceReviewStore.get(modelId);
        if (!sourceReview) return { summary: "Source review unavailable.", error: { code: "source_review_unavailable", message: `${subagent} requires a prepared source review` } };
        if (subagent === "statement_unification") {
          if (!sourceReview.presentationExtracts?.length) return { summary: "Presentation extracts unavailable.",
            error: { code: "presentation_extract_unavailable", message: "statement_unification needs presentationExtracts; re-run extract_filing_statements" } };
          const requestedPeriods = sourceReview.statementViews.income_statement.candidate.periods;
          const loader = createStatementUnificationTools({ modelStore: deps.financial.modelStore,
            sourceReviewStore: deps.financial.sourceReviewStore, ownerAgentId: context.agentId, modelId,
            ...(deps.financial.tableStore ? { tableStore: deps.financial.tableStore } : {}) });
          const run = await runStatementUnificationAgent({ modelRouter: deps.modelRouter,
            systemPrompt: subagents.get("statement_unification").prompt,
            task: requiredString(input, "task"), tools: loader.tools,
            filings: sourceReview.presentationExtracts, requestedPeriods,
            tables: deps.financial.tableStore?.getRunTables(sourceReview.ingestionRunId) ?? [] });
          const mismatch = wrongIssuer(loader.loaded(), modelId);
          if (mismatch) return { summary: mismatch, error: { code: "subagent_loaded_wrong_issuer", message: mismatch } };
          // The artifact goes to the store; the DCF Agent gets an account of it. Returning several
          // hundred unified rows would spend the parent's context on data spine_mapping reads from
          // the store anyway.
          deps.financial.sourceReviewStore.save(modelId, { ...sourceReview, unifiedStatements: run.artifact });
          const byStatement = run.artifact.rows.reduce<Record<string, number>>((counts, row) => {
            counts[row.statement] = (counts[row.statement] ?? 0) + 1; return counts;
          }, {});
          const material = run.artifact.rollupBreaks.filter((issue) => issue.material !== false).length;
          const breakdownRows = run.artifact.breakdownRows ?? [];
          return { summary: composeSubagentReport(`statement_unification unified ${run.artifact.rows.length} row(s) over `
            + `${run.artifact.periods.length} period(s) [${Object.entries(byStatement).map(([statement, count]) => `${statement} ${count}`).join(", ")}]`
            + `${run.artifact.restatements.length === 0 ? "" : `, ${run.artifact.restatements.length} restatement(s)`}`
            + `${material === 0 ? "" : `, ${material} material roll-up break(s)`}`
            + `${breakdownRows.length === 0 ? "" : `, ${breakdownRows.length} breakdown row(s) on ${new Set(breakdownRows.map((r) => r.axisQName)).size} axis/axes`}`
            + `${run.artifact.unresolvedFindings.length === 0 ? ". Stored; run spine_mapping next."
              : ` — SHIPPED WITH ${run.artifact.unresolvedFindings.length} unresolved finding(s).`}`, run.notes),
          generation_context: { data: { unifiedStatements: { periods: run.artifact.periods, rowsByStatement: byStatement,
            restatements: run.artifact.restatements.length, rollupBreaks: run.artifact.rollupBreaks.length,
            breakdownRows: breakdownRows.length,
            unresolvedFindings: run.artifact.unresolvedFindings } as unknown as JsonObject } } };
        }
        if (!sourceReview.unifiedStatements) return { summary: "Unified statements unavailable.",
          error: { code: "unified_statements_unavailable", message: "spine_mapping needs unifiedStatements; run statement_unification first" } };
        const loader = createSpineMappingTools({ modelStore: deps.financial.modelStore,
          sourceReviewStore: deps.financial.sourceReviewStore, ownerAgentId: context.agentId, modelId });
        const run = await runSpineMappingAgent({ modelRouter: deps.modelRouter,
          systemPrompt: subagents.get("spine_mapping").prompt, task: requiredString(input, "task"),
          tools: loader.tools, unified: sourceReview.unifiedStatements });
        const mismatch = wrongIssuer(loader.loaded(), modelId);
        if (mismatch) return { summary: mismatch, error: { code: "subagent_loaded_wrong_issuer", message: mismatch } };
        // Facts land as candidates, never committed: the subagent has no authority over a revision.
        // The owning agent accepts them with review_financial_model_history.
        const service = new FinancialModelService(deps.financial.modelStore, context.sessionId);
        const current = service.getModel(modelId);
        if (!("currentWorkbook" in current)) throw new Error("default model context expected");
        // Breakdown rows (segment/product/geography members) live in breakdownRows, not rows — a
        // detail row can point at either, so the label lookup has to search both.
        const unified = sourceReview.unifiedStatements!;
        const labelByRowId = new Map([...unified.rows, ...(unified.breakdownRows ?? [])].map((row) => [row.rowId, row.label]));
        // The same resolver the fact builder used, so a nested stream's label lands on the same id.
        const detailIds = resolveDetailLineItemIds(run.decision, unified);
        const labels = Object.fromEntries(run.decision.detailRows.map((detail) => [
          detailIds[detail.rowId]!,
          labelByRowId.get(detail.rowId) ?? detail.rowId,
        ]));
        const staged = run.facts.length === 0 ? current.currentWorkbook
          : service.stageSpineFacts(modelId, current.currentWorkbook.revision, { facts: run.facts, labels,
            historicalPeriodIds: current.currentWorkbook.periods.filter((period) => period.cls === "actual").map((period) => period.id),
          }).currentWorkbook;
        return { summary: composeSubagentReport(`spine_mapping staged ${run.facts.length} fact(s) at revision ${staged.revision} across `
          + `${run.decision.mappings.length} spine mapping(s) and ${run.decision.detailRows.length} detail row(s)`
          + `${run.decision.spineGaps.length === 0 ? "" : `, ${run.decision.spineGaps.length} declared spine gap(s)`}`
          + `${run.coverageGaps.length === 0 ? "" : `, ${run.coverageGaps.length} coverage gap(s)`}`
          + `${run.unresolvedFindings.length === 0 ? ". Accept them with review_financial_model_history."
            : ` — SHIPPED WITH ${run.unresolvedFindings.length} unresolved finding(s).`}`, run.notes),
        generation_context: { data: { spineMapping: { revision: staged.revision,
          mappedTargetIds: run.decision.mappings.map((mapping) => mapping.targetId),
          detailLineItemIds: Object.keys(labels),
          spineGaps: run.decision.spineGaps, coverageGaps: run.coverageGaps,
          unresolvedFindings: run.unresolvedFindings } as unknown as JsonObject } } };
      }
      return { summary: `Unknown DCF subagent: ${subagent}`, error: { code: "invalid_dcf_subagent", message: `Unknown DCF subagent: ${subagent}` } };
    },
  };
}

/**
 * The subagent picks its own ticker out of the orchestrator's instruction, so a garbled instruction
 * can point it at the wrong company. Every downstream check would still pass — the statements are
 * internally consistent, just not this model's issuer — so the mismatch has to be caught here.
 */
function wrongIssuer(loaded: LoadedWorkingSet | undefined, modelId: string): string | undefined {
  if (!loaded) return "The subagent never loaded a working set.";
  if (loaded.modelId !== modelId) {
    return `The subagent loaded ${loaded.symbol}, which is not the issuer of model ${modelId}. Restate the instruction with the right ticker.`;
  }
  return undefined;
}

/**
 * What the DCF orchestrator reads. Two parts, deliberately in this order: the host's counts, which
 * are measured and cannot be wrong, then the subagent's own account of the judgment calls behind
 * them, which is the only place that reasoning survives — the orchestrator never sees the rows.
 *
 * Capped so a subagent that ignores its word limit cannot flood the orchestrator's context. The
 * counts are never truncated; only the notes are, at a sentence boundary where one is near.
 */
export const SUBAGENT_NOTES_BUDGET_CHARS = 700; // ~175 tokens of English prose

export function composeSubagentReport(counts: string, notes: string): string {
  const trimmed = notes.trim();
  if (trimmed.length === 0) return counts;
  if (trimmed.length <= SUBAGENT_NOTES_BUDGET_CHARS) return `${counts}\n\n${trimmed}`;
  const clipped = trimmed.slice(0, SUBAGENT_NOTES_BUDGET_CHARS);
  const lastStop = clipped.lastIndexOf(". ");
  return `${counts}\n\n${lastStop > SUBAGENT_NOTES_BUDGET_CHARS / 2 ? clipped.slice(0, lastStop + 1) : `${clipped.trimEnd()}…`}`;
}

function requiredString(input: JsonObject, key: string): string { const value = input[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`); return value.trim(); }
