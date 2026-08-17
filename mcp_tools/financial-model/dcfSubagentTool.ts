import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import type { SubagentRegistry, SubagentRuntime } from "../../src/framework/subagent.ts";
import type { SessionRegistry } from "../../src/framework/sessionState.ts";
import { FinancialModelService } from "../../src/financial-model/service.ts";
import { refreshWaccSheetFromSpine, type FinancialModelToolDeps } from "./financialModelTools.ts";
import { validate } from "./schemas.ts";
import type { JsonSchema } from "../../src/framework/types.ts";
import { createSpineMappingTools, createStatementUnificationTools, type LoadedWorkingSet } from "./mappingSubagentTools.ts";
import { resolveDetailLineItemIds } from "../../src/infra/xbrl/spineFromUnified.ts";
import { runSpineMappingAgent } from "../../src/agent/financial-modeling/spineMappingAgent.ts";
import { runStatementUnificationAgent } from "../../src/agent/financial-modeling/statementUnificationAgent.ts";

export const DCF_PRIVATE_SUBAGENT_TOOL = "run_dcf_subagent";

const SUBAGENT_INPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["subagent", "modelId", "task"], properties: {
    subagent: { type: "string", enum: ["statement_unification", "spine_mapping"] },
    modelId: { type: "string" },
    task: { type: "string", description: "What the work is for, in your own words: the ticker (required — "
      + "the subagent loads its working set by it), the periods, what this issuer or the user needs "
      + "respected, and on a re-run the shortfall to address. Not a list of concepts, rows, or spine "
      + "target ids — the subagent loads those itself and is checked against the engine's requirements, "
      + "and a task that enumerates them reads as the full scope of the job." },
  } };

export function createDcfSubagentTool(deps: {
  subagentRuntime: SubagentRuntime;
  /** The one registry: these two agents are defined beside market_data and the rest. */
  subagents: SubagentRegistry;
  sessions: SessionRegistry;
  financial: FinancialModelToolDeps;
}): RegisteredTool {
  return {
    name: DCF_PRIVATE_SUBAGENT_TOOL,
    description: "Private delegation from the DCF Agent to one bounded DCF subagent. Each works from data extract_filing_statements already stored, writes its result back to the store, and returns an account of what it did.",
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
          const run = await runStatementUnificationAgent({
            subagentRuntime: deps.subagentRuntime, definition: deps.subagents.get("statement_unification"),
            state: deps.sessions.getExisting(context.sessionId),
            sessionId: context.sessionId, agentId: context.agentId,
            task: requiredString(input, "task"), readTools: loader.tools,
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
              : ` — SHIPPED WITH ${run.artifact.unresolvedFindings.length} unresolved finding(s).`}`, run.summary),
          generation_context: { data: { unifiedStatements: { periods: run.artifact.periods, rowsByStatement: byStatement,
            restatements: run.artifact.restatements.length, rollupBreaks: run.artifact.rollupBreaks.length,
            breakdownRows: breakdownRows.length,
            unresolvedFindings: run.artifact.unresolvedFindings } as unknown as JsonObject } } };
        }
        if (!sourceReview.unifiedStatements) return { summary: "Unified statements unavailable.",
          error: { code: "unified_statements_unavailable", message: "spine_mapping needs unifiedStatements; run statement_unification first" } };
        const service = new FinancialModelService(deps.financial.modelStore, context.sessionId);
        const current = service.getModel(modelId);
        if (!("currentWorkbook" in current)) throw new Error("default model context expected");
        const loader = createSpineMappingTools({ modelStore: deps.financial.modelStore,
          sourceReviewStore: deps.financial.sourceReviewStore, ownerAgentId: context.agentId, modelId });
        // The persistence implementation belongs at this boundary, but its invocation belongs to
        // spine_mapping: runSpineMappingAgent calls it only after the agent's last candidate is
        // structurally complete and reconciliation-clean.
        const unified = sourceReview.unifiedStatements;
        const labelByRowId = new Map([...unified.rows, ...(unified.breakdownRows ?? [])].map((row) => [row.rowId, row.label]));
        const historicalPeriodIds = current.currentWorkbook.periods.filter((period) => period.cls === "actual").map((period) => period.id);
        const run = await runSpineMappingAgent({
          subagentRuntime: deps.subagentRuntime, definition: deps.subagents.get("spine_mapping"),
          state: deps.sessions.getExisting(context.sessionId),
          sessionId: context.sessionId, agentId: context.agentId,
          task: requiredString(input, "task"), readTools: loader.tools,
          unified,
          previewReconciliations: (facts) => service.previewSpineFacts(modelId, {
            facts,
            historicalPeriodIds,
            labels: Object.fromEntries((unified.breakdownRows ?? []).map((row) => [row.rowId, row.label])),
          }),
          commit: async (candidate) => {
            const mismatch = wrongIssuer(loader.loaded(), modelId);
            if (mismatch) throw new Error(mismatch);
            const detailIds = resolveDetailLineItemIds(candidate.decision, unified);
            const labels = Object.fromEntries(candidate.decision.detailRows.map((detail) => [
              detailIds[detail.rowId]!, labelByRowId.get(detail.rowId) ?? detail.rowId,
            ]));
            if (candidate.facts.length === 0) return { revision: current.currentWorkbook.revision };
            const commit = service.commitSpineFacts(modelId, current.currentWorkbook.revision, {
              facts: [...candidate.facts], labels, historicalPeriodIds,
            });
            // Committed facts make WACC terms derivable; refresh as the mapping's final commit step.
            const waccOutcome = await refreshWaccSheetFromSpine(deps.financial, service, modelId, commit.revision);
            return { revision: waccOutcome.kind === "refreshed" ? waccOutcome.result.currentWorkbook.revision : commit.revision };
          },
        });
        const mismatch = wrongIssuer(loader.loaded(), modelId);
        if (mismatch) return { summary: mismatch, error: { code: "subagent_loaded_wrong_issuer", message: mismatch } };
        const revision = run.committedRevision ?? current.currentWorkbook.revision;
        const detailLineItemIds = Object.values(resolveDetailLineItemIds(run.decision, unified));
        return { summary: composeSubagentReport(`spine_mapping committed ${run.facts.length} fact(s) at revision ${revision} across `
          + `${run.decision.mappings.length} spine mapping(s) and ${run.decision.detailRows.length} detail row(s)`
          + `${run.decision.spineGaps.length === 0 ? "" : `, ${run.decision.spineGaps.length} declared spine gap(s)`}`
          + `${run.coverageGaps.length === 0 ? "" : `, ${run.coverageGaps.length} coverage gap(s)`}`
          + `${run.optionalCoverageGaps.length === 0 ? "" : `, ${run.optionalCoverageGaps.length} informational optional coverage gap(s)`}`
          + `${run.unresolvedFindings.length === 0 ? ""
            : ` — SHIPPED WITH ${run.unresolvedFindings.length} unresolved finding(s).`}`, run.summary),
        generation_context: { data: { spineMapping: { revision,
          mappedTargetIds: run.decision.mappings.map((mapping) => mapping.targetId),
          detailLineItemIds,
          spineGaps: run.decision.spineGaps, coverageGaps: run.coverageGaps,
          optionalCoverageGaps: run.optionalCoverageGaps,
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
 * are measured and cannot be wrong, then the summary the subagent wrote when it called finish —
 * written after it had seen the host's verdict on its submission, and the only place its reasoning
 * survives, since the orchestrator never sees the rows.
 *
 * Capped so a subagent that ignores its word limit cannot flood the orchestrator's context. The
 * counts are never truncated; only the summary is, at a sentence boundary where one is near.
 */
export const SUBAGENT_SUMMARY_BUDGET_CHARS = 700; // ~175 tokens of English prose

export function composeSubagentReport(counts: string, summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return counts;
  if (trimmed.length <= SUBAGENT_SUMMARY_BUDGET_CHARS) return `${counts}\n\n${trimmed}`;
  const clipped = trimmed.slice(0, SUBAGENT_SUMMARY_BUDGET_CHARS);
  const lastStop = clipped.lastIndexOf(". ");
  return `${counts}\n\n${lastStop > SUBAGENT_SUMMARY_BUDGET_CHARS / 2 ? clipped.slice(0, lastStop + 1) : `${clipped.trimEnd()}…`}`;
}

function requiredString(input: JsonObject, key: string): string { const value = input[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`); return value.trim(); }
