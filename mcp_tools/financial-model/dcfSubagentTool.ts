import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject, JsonValue } from "../../src/framework/types.ts";
import type { ModelRouter } from "../../src/infra/llm/provider.ts";
import { FinancialModelService } from "../../src/financial-model/service.ts";
import type { FinancialModelToolDeps } from "./financialModelTools.ts";
import { parseHistoryReviewInput, parseOperations } from "./schemas.ts";
import { validate } from "./schemas.ts";
import type { JsonSchema } from "../../src/framework/types.ts";
import { resolve } from "node:path";
import { SqliteFilingTableStore, type FilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import { createPreparedStatementProvider, type PreparedStatementProvider } from "../../src/infra/xbrl/preparedStatementProvider.ts";
import { createSmallModelInsightGenerator, type ChunkInsightGenerator } from "../../src/infra/filing-insights/extractor.ts";
import { runMappingReviewLoop } from "../../src/agent/financial-modeling/mappingReviewLoop.ts";
import { runSpineMappingAgent } from "../../src/agent/financial-modeling/spineMappingAgent.ts";
import { runStatementUnificationAgent } from "../../src/agent/financial-modeling/statementUnificationAgent.ts";
import type { PremapSummary } from "../../src/financial-model/autoPremap.ts";
import { runRevenueDecomposition } from "../../src/agent/financial-modeling/revenueDecomposition.ts";
import {
  assertFreshDcfProposal,
  DcfSubagentRegistry,
  projectForDcfSubagent,
  runStatementExtraction,
  type DcfSubagentProposal,
  type ModelingProposalSubagent,
} from "../../src/agent/financial-modeling/subagents.ts";

export const DCF_PRIVATE_SUBAGENT_TOOL = "run_dcf_subagent";

const SUBAGENT_INPUT_SCHEMA: JsonSchema = { type: "object", oneOf: [
  { type: "object", additionalProperties: false, required: ["subagent", "symbol"], properties: {
    subagent: { type: "string", enum: ["statement_extraction"] }, symbol: { type: "string" }, historyYears: { type: "number" },
    forecastYears: { type: "number" }, reportingCurrency: { type: "string" },
  } },
  { type: "object", additionalProperties: false, required: ["subagent", "modelId", "task"], properties: {
    subagent: { type: "string", enum: ["mapping_review", "forecast_modeling", "valuation_review"] },
    modelId: { type: "string" }, task: { type: "string" },
  } },
  { type: "object", additionalProperties: false, required: ["subagent", "modelId", "task"], properties: {
    subagent: { type: "string", enum: ["revenue_decomposition"] },
    modelId: { type: "string" }, task: { type: "string" },
  } },
  { type: "object", additionalProperties: false, required: ["subagent", "modelId", "task"], properties: {
    subagent: { type: "string", enum: ["statement_unification", "spine_mapping"] },
    modelId: { type: "string" }, task: { type: "string" },
  } },
] };

export function createDcfSubagentTool(deps: {
  modelRouter: ModelRouter;
  financial: FinancialModelToolDeps;
  provider?: PreparedStatementProvider;
  subagentRegistry?: DcfSubagentRegistry;
  tableStore?: FilingTableStore;
  generateInsights?: ChunkInsightGenerator;
}): RegisteredTool {
  const provider = deps.provider ?? createPreparedStatementProvider();
  const subagents = deps.subagentRegistry ?? new DcfSubagentRegistry();
  // Opened lazily so constructing the tool never touches the filesystem.
  let tableStore = deps.tableStore;
  const filingTableStore = () => tableStore ??= SqliteFilingTableStore.open(
    resolve(process.env["FINANCIAL_MODEL_DB_PATH"] ?? "data/financial-models.sqlite"));
  return {
    name: DCF_PRIVATE_SUBAGENT_TOOL,
    description: "Private delegation from the DCF Agent to one bounded DCF subagent. Subagents return ingestion results or revision-bound proposals and cannot mutate model revisions.",
    category: "non_trading",
    inputSchema: SUBAGENT_INPUT_SCHEMA,
    async execute(input, context) {
      try { validate(input, SUBAGENT_INPUT_SCHEMA, "$", true); }
      catch (error) { return { summary: error instanceof Error ? error.message : String(error),
        error: { code: "invalid_tool_input", message: error instanceof Error ? error.message : String(error) } }; }
      const subagent = requiredString(input, "subagent");
      // A pipeline name, deliberately not a registry kind: it drives the two
      // registered decomposition kinds internally.
      if (subagent === "revenue_decomposition") {
        const modelId = requiredString(input, "modelId");
        const meta = deps.financial.modelStore.getMeta(modelId);
        if (!meta || meta.ownerAgentId !== context.agentId) return { summary: "Financial model not found.", error: { code: "financial_model_not_found", message: "Financial model not found." } };
        const sourceReview = deps.financial.sourceReviewStore.get(modelId);
        if (!sourceReview) return { summary: "Source review unavailable.", error: { code: "source_review_unavailable", message: "revenue_decomposition requires a prepared source review" } };
        const result = await runRevenueDecomposition({ modelRouter: deps.modelRouter, sourceReview,
          tableStore: filingTableStore(), store: deps.financial.decompositionStore,
          mapPrompt: subagents.get("filing_decomposition").prompt, reducePrompt: subagents.get("decomposition_reduce").prompt,
          task: requiredString(input, "task") });
        const ranked = result.decision?.ranked ?? [];
        const summaries = ranked.flatMap((id) => {
          const candidate = result.candidates.find((entry) => entry.candidateSchemeId === id);
          return candidate ? [{ candidateSchemeId: candidate.candidateSchemeId, label: candidate.label, axisHint: candidate.axisHint,
            targetSourceLineItemId: candidate.targetSourceLineItemId, coverage: candidate.coverage,
            residualRatioByPeriod: candidate.residualRatioByPeriod, flags: candidate.flags,
            children: candidate.children.map((child) => ({ childId: child.childId, label: child.label })) }] : [];
        });
        return { summary: ranked.length === 0 ? "No revenue decomposition available; revenue stays whole-line."
          : `revenue_decomposition ranked ${ranked.length} scheme(s); driver ${result.decision?.driverSchemeId ?? "none"}. Accept with apply_revenue_decomposition.`,
        generation_context: { data: { decomposition: { candidates: summaries,
          driverSchemeId: result.decision?.driverSchemeId ?? null, diagnostics: result.diagnostics } as unknown as JsonObject } } };
      }
      if (subagent === "statement_unification" || subagent === "spine_mapping") {
        const modelId = requiredString(input, "modelId");
        const meta = deps.financial.modelStore.getMeta(modelId);
        if (!meta || meta.ownerAgentId !== context.agentId) return { summary: "Financial model not found.", error: { code: "financial_model_not_found", message: "Financial model not found." } };
        const sourceReview = deps.financial.sourceReviewStore.get(modelId);
        if (!sourceReview) return { summary: "Source review unavailable.", error: { code: "source_review_unavailable", message: `${subagent} requires a prepared source review` } };
        if (subagent === "statement_unification") {
          if (!sourceReview.presentationExtracts?.length) return { summary: "Presentation extracts unavailable.",
            error: { code: "presentation_extract_unavailable", message: "statement_unification needs presentationExtracts; re-run statement_extraction" } };
          const requestedPeriods = sourceReview.statementViews.income_statement.candidate.periods;
          const run = await runStatementUnificationAgent({ modelRouter: deps.modelRouter,
            systemPrompt: subagents.get("statement_unification").prompt,
            filings: sourceReview.presentationExtracts, requestedPeriods });
          deps.financial.sourceReviewStore.save(modelId, { ...sourceReview, unifiedStatements: run.artifact });
          return { summary: run.artifact.unresolvedFindings.length === 0
            ? `statement_unification produced ${run.artifact.rows.length} unified rows over ${run.artifact.periods.length} period(s).`
            : `statement_unification shipped ${run.artifact.rows.length} rows WITH ${run.artifact.unresolvedFindings.length} unresolved finding(s).`,
          generation_context: { data: { unifiedStatements: { periods: run.artifact.periods, rows: run.artifact.rows,
            restatements: run.artifact.restatements, rollupBreaks: run.artifact.rollupBreaks,
            unresolvedFindings: run.artifact.unresolvedFindings } as unknown as JsonObject } } };
        }
        if (!sourceReview.unifiedStatements) return { summary: "Unified statements unavailable.",
          error: { code: "unified_statements_unavailable", message: "spine_mapping needs unifiedStatements; run statement_unification first" } };
        const run = await runSpineMappingAgent({ modelRouter: deps.modelRouter,
          systemPrompt: subagents.get("spine_mapping").prompt, unified: sourceReview.unifiedStatements });
        return { summary: run.unresolvedFindings.length === 0
          ? `spine_mapping staged ${run.facts.length} fact(s) across ${run.decision.mappings.length} spine mapping(s). Commit via the model's fact review operations.`
          : `spine_mapping shipped ${run.facts.length} fact(s) WITH ${run.unresolvedFindings.length} unresolved finding(s).`,
        generation_context: { data: { spineMapping: { decision: run.decision, facts: run.facts,
          coverageGaps: run.coverageGaps, unresolvedFindings: run.unresolvedFindings } as unknown as JsonObject } } };
      }
      if (!subagents.has(subagent as never)) return { summary: `Unknown DCF subagent: ${subagent}`, error: { code: "invalid_dcf_subagent", message: `Unknown DCF subagent: ${subagent}` } };
      const definition = subagents.get(subagent as never);
      if (subagent === "statement_extraction") {
        const result = await runStatementExtraction({ provider, ingestionStore: deps.financial.ingestionStore,
          insightStore: deps.financial.insightStore, generateInsights: deps.generateInsights ?? createSmallModelInsightGenerator(deps.modelRouter),
          tableStore: filingTableStore() },
        context.agentId, { symbol: requiredString(input, "symbol"), historyYears: integer(input["historyYears"], 5, 3, 10),
          forecastYears: integer(input["forecastYears"], 5, 3, 10), filingForms: ["10-K", "10-K/A"],
          ...(typeof input["reportingCurrency"] === "string" ? { reportingCurrency: input["reportingCurrency"] } : {}) });
        return { summary: result.status === "ready" ? `Prepared filing ingestion ${result.ingestionRunId}.` : result.error?.message ?? "Filing preprocessing failed.",
          generation_context: { data: result as unknown as JsonObject }, ...(result.status === "failed" ? { error: { code: result.error!.code, message: result.error!.message } } : {}) };
      }
      if (!(subagent === "mapping_review" || subagent === "forecast_modeling" || subagent === "valuation_review")) throw new Error("invalid proposal subagent authority");
      const modelId = requiredString(input, "modelId");
      const meta = deps.financial.modelStore.getMeta(modelId);
      if (!meta || meta.ownerAgentId !== context.agentId) return { summary: "Financial model not found.", error: { code: "financial_model_not_found", message: "Financial model not found." } };
      const service = new FinancialModelService(deps.financial.modelStore, context.sessionId);
      const model = service.getModel(modelId);
      if (!("currentWorkbook" in model)) throw new Error("default model context expected");
      const insightSetId = model.currentWorkbook.filingInsightSetId;
      const projection = projectForDcfSubagent(subagent, model,
        insightSetId ? deps.financial.insightStore.getContext(insightSetId) ?? null : null);
      const mappingReviewSourceReview = subagent === "mapping_review"
        ? requiredSourceReview(deps.financial.sourceReviewStore.get(modelId)) : undefined;
      const payload = subagent === "mapping_review"
        ? await runMappingReviewLoop({ modelRouter: deps.modelRouter, projection,
          sourceReview: mappingReviewSourceReview!, tableStore: filingTableStore(),
          task: requiredString(input, "task"), systemPrompt: definition.prompt })
        : parsePayload((await deps.modelRouter.generate([
          { role: "system", content: definition.prompt },
          { role: "user", content: `${requiredString(input, "task")}\n\nREAD-ONLY CONTEXT:\n${JSON.stringify(projection)}` },
        ], { modelClass: definition.modelClass, temperature: 0.1, metadata: { mode: "dcf_subagent", subagent } })).text);
      const proposedPayload = validateProposalPayload(subagent, payload["payload"], modelId, projection.baseRevision,
        mappingReviewSourceReview?.premap, payload["rationale"]);
      const proposal: DcfSubagentProposal = { subagent, modelId, baseRevision: projection.baseRevision,
        lifecycleStage: projection.lifecycleStage, rationale: typeof payload["rationale"] === "string" ? payload["rationale"] : "",
        payload: proposedPayload, sourceRefs: Array.isArray(payload["sourceRefs"])
          ? payload["sourceRefs"].filter((entry): entry is string => typeof entry === "string") : [] };
      const latest = service.getModel(modelId);
      if (!("currentWorkbook" in latest)) throw new Error("default model context expected");
      assertFreshDcfProposal(proposal, latest);
      return { summary: `${subagent} returned a read-only proposal for ${modelId}@${proposal.baseRevision}.`,
        generation_context: { data: { proposal: proposal as unknown as JsonObject } } };
    },
  };
}

function validateProposalPayload(subagent: ModelingProposalSubagent, payload: JsonValue | undefined, modelId: string, revision: number,
  premap?: PremapSummary, rationale?: JsonValue): JsonValue {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${subagent} proposal payload must be an object`);
  if ("modelId" in payload || "expectedRevision" in payload) throw new Error("subagent proposal must not supply model ownership/revision fields");
  if (subagent === "mapping_review") {
    const input = { ...(payload as JsonObject), modelId, expectedRevision: revision };
    parseHistoryReviewInput(input);
    assertRemapsOfEngineMappedTargetsHaveRationale(payload as JsonObject, premap, rationale);
    return payload;
  }
  const operations = (payload as JsonObject)["operations"];
  parseOperations({ modelId, expectedRevision: revision, operations: operations ?? payload });
  return { operations: operations ?? payload };
}

/** Spec §5/§7: remapping an already engine-mapped target must carry a stated reason. */
function assertRemapsOfEngineMappedTargetsHaveRationale(payload: JsonObject, premap: PremapSummary | undefined, rationale: JsonValue | undefined): void {
  if (!premap) return;
  const mappedTargets = new Set(premap.mapped.map((entry) => entry.targetLineItemId));
  const plans = payload["statementMappingPlans"];
  if (!Array.isArray(plans)) return;
  const hasRationale = typeof rationale === "string" && rationale.trim().length > 0;
  for (const plan of plans) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) continue;
    const targetLineItemId = (plan as JsonObject)["targetLineItemId"];
    if (typeof targetLineItemId === "string" && mappedTargets.has(targetLineItemId) && !hasRationale) {
      throw new Error(`remap of engine-mapped target requires rationale: ${targetLineItemId}`);
    }
  }
}

function parsePayload(text: string): JsonObject {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("DCF subagent did not return JSON");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DCF subagent proposal must be an object");
  return parsed as JsonObject;
}
function requiredSourceReview(value: ReturnType<FinancialModelToolDeps["sourceReviewStore"]["get"]>): NonNullable<typeof value> {
  if (!value) throw new Error("mapping_review source review is unavailable");
  return value;
}
function requiredString(input: JsonObject, key: string): string { const value = input[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`); return value.trim(); }
function integer(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`expected integer ${min}..${max}`); return value;
}
