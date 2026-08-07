import path from "node:path";
import type { JsonObject, JsonSchema, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import { buildPremap } from "../../src/financial-model/autoPremap.ts";
import { FinancialModelError } from "../../src/financial-model/errors.ts";
import type { FinancialModelSnapshot, ModelOperation, ModelQuery } from "../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../src/financial-model/snapshotCodec.ts";
import { SqliteModelStore, type ModelFilter, type ModelStore } from "../../src/financial-model/store.ts";
import { SqliteFilingInsightStore, type FilingInsightStore } from "../../src/infra/filing-insights/store.ts";
import type { FilingInsightContextView } from "../../src/infra/filing-insights/types.ts";
import { SqliteSourceReviewStore, type FilingIngestionStore, type SourceReviewStore } from "../../src/infra/xbrl/sourceReviewStore.ts";
import { SqliteDecompositionStore, type DecompositionStore } from "../../src/infra/xbrl/decompositionStore.ts";
import { materializeDecomposition } from "../../src/infra/xbrl/materializeDecomposition.ts";
import type { RegisteredTool, ToolExecutionContext } from "../toolRegistry.ts";
import { operationsInputSchema, parseHistoryReviewInput, parseOperations, reviewInputSchema, validate } from "./schemas.ts";

export const FINANCIAL_MODELING_TOOLS = [
  "create_financial_model", "review_financial_model_history", "apply_financial_model_operations",
  "get_financial_model", "list_financial_models", "archive_financial_model", "apply_revenue_decomposition",
] as const;

export type FinancialModelToolDeps = {
  modelStore: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>;
  insightStore: FilingInsightStore;
  sourceReviewStore: SourceReviewStore;
  ingestionStore: FilingIngestionStore;
  decompositionStore: DecompositionStore;
};

let defaults: FinancialModelToolDeps | undefined;
export function getDefaultFinancialModelToolDeps(): FinancialModelToolDeps {
  if (defaults) return defaults;
  const databasePath = path.resolve(process.env["FINANCIAL_MODEL_DB_PATH"] ?? "data/financial-models.sqlite");
  defaults = {
    modelStore: SqliteModelStore.open(databasePath, financialModelSnapshotCodec),
    insightStore: SqliteFilingInsightStore.open(databasePath),
    sourceReviewStore: SqliteSourceReviewStore.open(databasePath),
    ingestionStore: SqliteSourceReviewStore.open(databasePath),
    decompositionStore: SqliteDecompositionStore.open(databasePath),
  };
  return defaults;
}

export function createFinancialModelTools(injected?: FinancialModelToolDeps): RegisteredTool[] {
  const deps = injected ?? getDefaultFinancialModelToolDeps();
  const schema = (properties: Record<string, JsonObject>, required: string[] = []): RegisteredTool["inputSchema"] =>
    ({ type: "object", properties: properties as Record<string, JsonSchema>, additionalProperties: false, ...(required.length ? { required } : {}) });
  const tool = (name: string, description: string, properties: Record<string, JsonObject>, required: string[],
    execute: RegisteredTool["execute"]): RegisteredTool => {
      const inputSchema = schema(properties, required);
      return { name, description, category: "non_trading", inputSchema, execute: async (input, context) => {
        try { validate(input, inputSchema, "$", true); }
        catch (error) { return failure("invalid_tool_input", error instanceof Error ? error.message : String(error)); }
        return execute(input, context);
      } };
    };
  return [
    tool("create_financial_model", "Create a revisioned DCF model from complete filing-level XBRL statements.", {
      symbol: { type: "string" },
      ingestionRunId: { type: "string", description: "Immutable run returned by the private statement_extraction subagent." },
    }, ["symbol", "ingestionRunId"], async (input, context) => createModel(deps, input, context)),
    tool("review_financial_model_history", "Atomically commit reviewed facts, periods, categories, and statement mappings.", {
      ...(reviewInputSchema.properties as unknown as Record<string, JsonObject>),
    }, reviewInputSchema.required ?? [],
    async (input, context) => mutate(deps, input, context,
      (service, id, revision) => service.reviewFacts(id, revision, parseHistoryReviewInput(input)))),
    tool("apply_financial_model_operations", "Apply an ordered batch of DCF assumptions, formulas, categories, configuration, and stage changes.", {
      ...(operationsInputSchema.properties as unknown as Record<string, JsonObject>),
    }, operationsInputSchema.required ?? [], async (input, context) => mutate(deps, input, context,
      (service, id, revision) => service.applyOperations(id, revision, parseOperations(input)))),
    tool("get_financial_model", "Read current model context, a section/cell slice, lineage, a prior revision, or filing-insight evidence.", {
      modelId: { type: "string" }, revision: { type: "number" }, section: { type: "string" }, selector: { type: "object" },
      includeLineage: { type: "boolean" }, reopenSources: { type: "boolean" }, insightId: { type: "string" },
    }, ["modelId"], async (input, context) => getModel(deps, input, context)),
    tool("list_financial_models", "List financial models owned by the current Agent.", {
      symbol: { type: "string" }, lifecycleStage: { type: "string" }, includeArchived: { type: "boolean" },
    }, [], async (input, context) => listModels(deps, input, context)),
    tool("apply_revenue_decomposition", "Accept revenue decomposition schemes proposed by the private revenue_decomposition pipeline and materialize their child rows into the source review.", {
      modelId: { type: "string" }, acceptedSchemeIds: { type: "array", items: { type: "string" } },
      driverSchemeId: { type: "string" }, rationale: { type: "string" },
    }, ["modelId", "acceptedSchemeIds", "rationale"], async (input, context) => applyRevenueDecomposition(deps, input, context)),
    tool("archive_financial_model", "Archive an owned financial model without deleting revision history.", {
      modelId: { type: "string" }, expectedRevision: { type: "number" },
    }, ["modelId", "expectedRevision"], async (input, context) => mutate(deps, input, context,
      (service, id, revision) => service.archive(id, revision))),
  ];
}

async function createModel(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const symbol = requireString(input, "symbol").toUpperCase();
  const ingestionRunId = typeof input["ingestionRunId"] === "string" ? input["ingestionRunId"] : "";
  if (!ingestionRunId) return failure("statement_extraction_required", "Run the private statement_extraction subagent before creating the model.", { retryable: true });
  const ingestion = deps.ingestionStore.getIngestion(ingestionRunId);
  if (!ingestion || ingestion.ownerAgentId !== context.agentId || ingestion.symbol !== symbol || ingestion.consumedAt) {
    return failure("filing_ingestion_not_found", "Owned filing ingestion run not found.");
  }
  const source = ingestion.source;
  if (!source) return failure("filing_source_resolution_failed", ingestion.error?.message ?? "Filing source metadata is unavailable.",
    { retryable: true, ingestion_run_id: ingestionRunId });
  const modelId = ingestion.modelId;
  const service = new FinancialModelService(deps.modelStore, context.sessionId);
  try {
    const created = service.createModel({ modelId, ownerAgentId: context.agentId, originSessionId: context.sessionId, symbol,
      metadata: { cik: String(source.company.cik), companyName: source.company.title, fiscalYearEnd: source.fiscalYearEnd },
      reportingCurrency: source.reportingCurrency, periods: source.periods, preparedStatementRows: [] });
    const consumed = deps.ingestionStore.consumeIngestion(ingestionRunId, context.agentId, symbol);
    if (!consumed) return failure("filing_ingestion_already_consumed", "Filing ingestion was consumed concurrently.", { model_id: modelId, revision: 0 });
    if (ingestion.status !== "ready" || !ingestion.prepared) return failure(ingestion.error?.code ?? "incomplete_financial_statements",
      ingestion.error?.message ?? "Filing preprocessing did not produce complete statements.", { model_id: modelId, revision: created.revision,
        retryable: true, ingestion_run_id: ingestionRunId, diagnostics: ingestion.diagnostics });
    const prepared = ingestion.prepared;
    const filingInsights = ingestion.filingInsightSetId ? deps.insightStore.getContext(ingestion.filingInsightSetId) : undefined;
    const imported = service.stagePreparedStatements(modelId, 0, prepared.rows, prepared.facts, ingestion.filingInsightSetId);
    // Layer 1 + Layer 2(a) of the auto-premapping spec (§6): deterministic mapping runs before the
    // first workbook is returned, so historical values and YoY growth are already computed here.
    const historicalPeriodIds = source.periods.filter((period) => period.cls === "actual").map((period) => period.id);
    const premap = buildPremap({ statementViews: prepared.statementViews, facts: prepared.facts, historicalPeriodIds });
    const premapped = premap.plans.length === 0 ? imported : service.applyAutoPremap(modelId, imported.revision, {
      plans: premap.plans, streams: premap.streams, historicalPeriodIds,
      reviewedBy: context.agentId, rationale: "Deterministic auto pre-mapping at import (auto-premap-v1)" });
    deps.sourceReviewStore.save(modelId, { ingestionRunId, statementViews: prepared.statementViews, facts: prepared.facts,
      curatedTables: ingestion.curatedTables ?? [], curations: ingestion.curations ?? [],
      ...(ingestion.verification ? { verification: ingestion.verification } : {}),
      ...(ingestion.presentationExtracts ? { presentationExtracts: ingestion.presentationExtracts } : {}),
      dimensionalDisclosures: prepared.dimensionalDisclosures,
      coverage: prepared.coverage, filings: prepared.filings, premap: premap.summary });
    const currentWorkbook = enrichWorkbook(premapped.currentWorkbook, deps.sourceReviewStore.get(modelId));
    return success(`Created ${symbol} financial model ${modelId} at revision ${premapped.revision}.`, { model_id: modelId, revision: premapped.revision,
      lifecycle_stage: premapped.status, revision_summary: premapped.revisionSummary, filing_insights: filingInsights ?? null,
      statement_coverage: prepared.coverage, premap: premap.summary as unknown as JsonValue,
      current_workbook: currentWorkbook, warnings: premapped.warnings });
  } catch (error) {
    if (error instanceof FinancialModelError) return toolError(error);
    return failure("financial_model_creation_failed", error instanceof Error ? error.message : String(error), { model_id: modelId, retryable: true });
  }
}

async function mutate(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext,
  action: (service: FinancialModelService, id: string, revision: number) => ReturnType<FinancialModelService["archive"]>): Promise<ToolExecutionResult> {
  try {
    const id = requireString(input, "modelId"); requireOwner(deps, id, context.agentId);
    const result = action(new FinancialModelService(deps.modelStore, context.sessionId), id, requireInteger(input, "expectedRevision"));
    const insights = insightContext(deps, result.currentWorkbook.filingInsightSetId ?? null);
    return success(`Updated financial model ${id} to revision ${result.revision}.`, { model_id: id, revision: result.revision,
      lifecycle_stage: result.status, revision_summary: result.revisionSummary, filing_insights: insights,
      current_workbook: enrichWorkbook(result.currentWorkbook, deps.sourceReviewStore.get(id)), warnings: result.warnings });
  } catch (error) { return toolError(error); }
}

async function getModel(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  try {
    const id = requireString(input, "modelId"); requireOwner(deps, id, context.agentId);
    const service = new FinancialModelService(deps.modelStore, context.sessionId);
    const revision = typeof input["revision"] === "number" ? input["revision"] : undefined;
    const stored = deps.modelStore.getRevision(id, revision);
    if (!stored) throw new FinancialModelError("financial_model_not_found", `model or revision not found: ${id}`);
    if (typeof input["insightId"] === "string") {
      const setId = stored.snapshot.filingInsightSetId; const detail = setId ? deps.insightStore.getDetail(setId, input["insightId"]) : undefined;
      if (!detail) return failure("filing_insight_not_found", "filing insight not found");
      return success(`Loaded filing insight ${input["insightId"]}.`, { model_id: id, revision: stored.revision, filing_insight: detail });
    }
    const view = service.getModel(id, { ...(revision === undefined ? {} : { revision }),
      ...(typeof input["section"] === "string" ? { section: input["section"] as never } : {}),
      ...(input["selector"] && typeof input["selector"] === "object" ? { selector: input["selector"] as ModelQuery["selector"] } : {}),
      includeLineage: input["includeLineage"] === true, reopenSources: input["reopenSources"] === true });
    if ("currentWorkbook" in view) {
      return success(`Loaded financial model ${id} revision ${view.currentWorkbook.revision}.`, { model_id: id, revision: view.currentWorkbook.revision,
        revision_history: view.revisionHistory, filing_insights: insightContext(deps, view.currentWorkbook.filingInsightSetId),
        current_workbook: enrichWorkbook(view.currentWorkbook, deps.sourceReviewStore.get(id)) });
    }
    return success(`Loaded financial model ${id} revision ${view.revision}.`, { model_id: id, revision: view.revision,
      filing_insights: insightContext(deps, stored.snapshot.filingInsightSetId ?? null), workbook_slice: view });
  } catch (error) { return toolError(error); }
}

async function applyRevenueDecomposition(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  try {
    const modelId = requireString(input, "modelId"); requireOwner(deps, modelId, context.agentId);
    const rationale = requireString(input, "rationale");
    const acceptedSchemeIds = requireArray(input, "acceptedSchemeIds").map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) throw new Error("acceptedSchemeIds must contain scheme ids");
      return entry;
    });
    const driverSchemeId = input["driverSchemeId"] === undefined ? undefined : requireString(input, "driverSchemeId");
    if (driverSchemeId !== undefined && !acceptedSchemeIds.includes(driverSchemeId)) {
      return failure("invalid_driver_scheme", "driverSchemeId must be one of acceptedSchemeIds", { model_id: modelId });
    }
    const artifact = deps.sourceReviewStore.get(modelId);
    if (!artifact) return failure("source_review_unavailable", "apply_revenue_decomposition requires a prepared source review", { model_id: modelId });
    const candidates = deps.decompositionStore.listCandidates(artifact.ingestionRunId);
    const decision = { acceptedSchemeIds, driverSchemeId: driverSchemeId ?? null, decidedBy: context.agentId, rationale };
    const next = materializeDecomposition({ artifact, candidates, decision });
    deps.sourceReviewStore.save(modelId, next);
    deps.decompositionStore.saveFinalDecision(artifact.ingestionRunId, decision);
    // Layer 2(b) of the auto-premapping spec (§4b, §6): re-run the engine over the post-materialization
    // artifact and hand the whole engine-owned plan set to the service, which replaces its own previous
    // output and leaves agent-authored plans untouched. An unchanged decision produces an empty diff.
    const stored = deps.modelStore.getRevision(modelId);
    if (!stored) return failure("financial_model_not_found", `model not found: ${modelId}`, { model_id: modelId });
    const historicalPeriodIds = stored.snapshot.periods.filter((period) => period.cls === "actual").map((period) => period.id);
    const premap = buildPremap({ statementViews: next.statementViews, facts: next.facts,
      ...(next.decomposition ? { decomposition: next.decomposition } : {}), historicalPeriodIds });
    const result = new FinancialModelService(deps.modelStore, context.sessionId).applyAutoPremap(modelId, stored.revision, {
      plans: premap.plans, streams: premap.streams,
      sourceRows: Object.values(next.statementViews).flatMap((view) => view.candidate.rows),
      facts: next.facts, historicalPeriodIds, reviewedBy: context.agentId,
      rationale: `Deterministic auto pre-mapping after revenue decomposition (auto-premap-v1): ${rationale}` });
    deps.sourceReviewStore.save(modelId, { ...next, premap: premap.summary });
    return success(`Applied ${acceptedSchemeIds.length} revenue decomposition scheme(s) to ${modelId}.`,
      { model_id: modelId, revision: result.revision, decomposition: next.decomposition as unknown as JsonValue,
        premap: premap.summary as unknown as JsonValue, demoted: premap.summary.demoted as unknown as JsonValue,
        current_workbook: enrichWorkbook(result.currentWorkbook, deps.sourceReviewStore.get(modelId)),
        warnings: result.warnings as unknown as JsonValue });
  } catch (error) { return toolError(error); }
}

async function listModels(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const filter: ModelFilter = { ownerAgentId: context.agentId };
  if (typeof input["symbol"] === "string") filter.symbol = input["symbol"].toUpperCase();
  if (typeof input["lifecycleStage"] === "string" && ["draft", "history_committed", "revenue_forecast", "operations_fcff", "valued", "archived"].includes(input["lifecycleStage"])) {
    filter.lifecycleStage = input["lifecycleStage"] as NonNullable<ModelFilter["lifecycleStage"]>;
  }
  if (input["includeArchived"] === true) filter.includeArchived = true;
  const models = new FinancialModelService(deps.modelStore, context.sessionId).listModels(filter);
  return success(`Found ${models.length} owned financial model(s).`, { models });
}

function requireOwner(deps: FinancialModelToolDeps, id: string, agentId: string): void {
  const model = deps.modelStore.getMeta(id);
  if (!model || model.ownerAgentId !== agentId) throw new FinancialModelError("financial_model_not_found", `model not found: ${id}`);
}
function insightContext(deps: FinancialModelToolDeps, id: string | null): FilingInsightContextView | null { return id ? deps.insightStore.getContext(id) ?? null : null; }
function enrichWorkbook<T extends JsonValue>(workbook: T, source: ReturnType<SourceReviewStore["get"]>): JsonValue {
  if (!source || typeof workbook !== "object" || workbook === null || Array.isArray(workbook)) return workbook;
  if ((workbook as JsonObject)["mode"] !== "statement_mapping") return workbook;
  return { ...(workbook as JsonObject), source_statement_summary: {
    filings: source.filings,
    coverage: source.coverage,
    selected_tables: source.curations,
    normalized_row_count: Object.values(source.statementViews).reduce((sum, view) => sum + view.candidate.rows.length, 0),
    staged_fact_count: source.facts.length,
    source_conflict_count: source.verification?.columnConflicts.length ?? 0,
  } };
}
function success(summary: string, data: JsonObject): ToolExecutionResult { return { summary, generation_context: { data } }; }
function failure(code: string, message: string, data: JsonObject = {}): ToolExecutionResult { return { summary: message, error: { code, message }, generation_context: { data: { ...data, error: code } } }; }
function toolError(error: unknown): ToolExecutionResult {
  if (error instanceof FinancialModelError) return failure(error.code, error.message, error.details ?? {});
  return failure("financial_model_error", error instanceof Error ? error.message : String(error));
}
function requireString(input: JsonObject, key: string): string { const value = input[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`); return value.trim(); }
function requireInteger(input: JsonObject, key: string): number { const value = input[key]; if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`); return value; }
function requireArray(input: JsonObject, key: string): JsonValue[] { const value = input[key]; if (!Array.isArray(value)) throw new Error(`${key} must be an array`); return value; }
function boundedInteger(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`value must be an integer from ${min} to ${max}`); return value;
}
