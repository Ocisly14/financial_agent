import type { RegisteredTool } from "../../../mcp_tools/toolRegistry.ts";
import type { JsonObject, JsonValue } from "../../framework/types.ts";
import type { ModelRouter } from "../../infra/llm/provider.ts";
import { FinancialModelService } from "../../financial-model/service.ts";
import type { FinancialModelToolDeps } from "../../../mcp_tools/financial-model/financialModelTools.ts";
import { parseHistoryReviewInput, parseOperations } from "../../../mcp_tools/financial-model/schemas.ts";
import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import type { JsonSchema } from "../../framework/types.ts";
import { resolve } from "node:path";
import { SqliteFilingTableStore, type FilingTableStore } from "../../infra/xbrl/filingTableStore.ts";
import { createPreparedStatementProvider, type PreparedStatementProvider } from "../../infra/xbrl/preparedStatementProvider.ts";
import { createSmallModelInsightGenerator, type ChunkInsightGenerator } from "../../infra/filing-insights/extractor.ts";
import { runHistoricalMappingLoop } from "./historicalMappingLoop.ts";
import {
  assertFreshDcfProposal,
  DcfSubagentRegistry,
  projectForDcfSubagent,
  runStatementExtraction,
  type DcfSubagentProposal,
  type ModelingProposalSubagent,
} from "./subagents.ts";

export const DCF_PRIVATE_SUBAGENT_TOOL = "run_dcf_subagent";

const SUBAGENT_INPUT_SCHEMA: JsonSchema = { type: "object", oneOf: [
  { type: "object", additionalProperties: false, required: ["subagent", "symbol"], properties: {
    subagent: { type: "string", enum: ["statement_extraction"] }, symbol: { type: "string" }, historyYears: { type: "number" },
    forecastYears: { type: "number" }, reportingCurrency: { type: "string" },
  } },
  { type: "object", additionalProperties: false, required: ["subagent", "modelId", "task"], properties: {
    subagent: { type: "string", enum: ["historical_mapping", "forecast_modeling", "valuation_review"] },
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
      if (!(subagent === "historical_mapping" || subagent === "forecast_modeling" || subagent === "valuation_review")) throw new Error("invalid proposal subagent authority");
      const modelId = requiredString(input, "modelId");
      const meta = deps.financial.modelStore.getMeta(modelId);
      if (!meta || meta.ownerAgentId !== context.agentId) return { summary: "Financial model not found.", error: { code: "financial_model_not_found", message: "Financial model not found." } };
      const service = new FinancialModelService(deps.financial.modelStore, context.sessionId);
      const model = service.getModel(modelId);
      if (!("currentWorkbook" in model)) throw new Error("default model context expected");
      const insightSetId = model.currentWorkbook.filingInsightSetId;
      const projection = projectForDcfSubagent(subagent, model,
        insightSetId ? deps.financial.insightStore.getContext(insightSetId) ?? null : null);
      const payload = subagent === "historical_mapping"
        ? await runHistoricalMappingLoop({ modelRouter: deps.modelRouter, projection,
          sourceReview: requiredSourceReview(deps.financial.sourceReviewStore.get(modelId)), tableStore: filingTableStore(),
          task: requiredString(input, "task"), systemPrompt: definition.prompt })
        : parsePayload((await deps.modelRouter.generate([
          { role: "system", content: definition.prompt },
          { role: "user", content: `${requiredString(input, "task")}\n\nREAD-ONLY CONTEXT:\n${JSON.stringify(projection)}` },
        ], { modelClass: definition.modelClass, temperature: 0.1, metadata: { mode: "dcf_subagent", subagent } })).text);
      const proposedPayload = validateProposalPayload(subagent, payload["payload"], modelId, projection.baseRevision);
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

function validateProposalPayload(subagent: ModelingProposalSubagent, payload: JsonValue | undefined, modelId: string, revision: number): JsonValue {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${subagent} proposal payload must be an object`);
  if ("modelId" in payload || "expectedRevision" in payload) throw new Error("subagent proposal must not supply model ownership/revision fields");
  if (subagent === "historical_mapping") {
    const input = { ...(payload as JsonObject), modelId, expectedRevision: revision };
    parseHistoryReviewInput(input); return payload;
  }
  const operations = (payload as JsonObject)["operations"];
  parseOperations({ modelId, expectedRevision: revision, operations: operations ?? payload });
  return { operations: operations ?? payload };
}

function parsePayload(text: string): JsonObject {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("DCF subagent did not return JSON");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DCF subagent proposal must be an object");
  return parsed as JsonObject;
}
function requiredSourceReview(value: ReturnType<FinancialModelToolDeps["sourceReviewStore"]["get"]>): NonNullable<typeof value> {
  if (!value) throw new Error("historical_mapping source review is unavailable");
  return value;
}
function requiredString(input: JsonObject, key: string): string { const value = input[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`); return value.trim(); }
function integer(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`expected integer ${min}..${max}`); return value;
}
