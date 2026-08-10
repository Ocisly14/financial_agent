import { randomUUID } from "node:crypto";
import path from "node:path";
import type { JsonObject, JsonSchema, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import { FinancialModelError } from "../../src/financial-model/errors.ts";
import type { FinancialModelSnapshot, ModelOperation, ModelQuery } from "../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../src/financial-model/snapshotCodec.ts";
import { SqliteModelStore, type ModelFilter, type ModelStore } from "../../src/financial-model/store.ts";
import { SqliteFilingInsightStore, type FilingInsightStore } from "../../src/infra/filing-insights/store.ts";
import type { FilingInsightContextView } from "../../src/infra/filing-insights/types.ts";
import { SqliteSourceReviewStore, type FilingIngestionStore, type SourceReviewStore } from "../../src/infra/xbrl/sourceReviewStore.ts";
import { SqliteFilingTableStore, type FilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import type { RegisteredTool, ToolExecutionContext } from "../toolRegistry.ts";
import { operationsInputSchema, parseHistoryReviewInput, parseOperations, reviewInputSchema, validate } from "./schemas.ts";
import { deriveWaccParameters, type DerivationDeps, type WaccParameterName } from "../../src/financial-model/waccDerivation.ts";
import type { WaccSheet, WaccSheetComputedInput } from "../../src/financial-model/waccSheet.ts";
import { getSharedBarRepository, type BarRepository } from "../../src/data/stock/index.ts";
import { fetchTreasury30y } from "../../src/infra/market/treasuryYield.ts";

export const FINANCIAL_MODELING_TOOLS = [
  "create_financial_model", "review_financial_model_history", "apply_financial_model_operations",
  "get_financial_model", "list_financial_models", "archive_financial_model",
  "list_unified_statements", "get_unified_rows", "calculate_model_rows",
  "get_treasury_yield",
] as const;

export type FinancialModelToolDeps = {
  modelStore: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>;
  insightStore: FilingInsightStore;
  sourceReviewStore: SourceReviewStore;
  ingestionStore: FilingIngestionStore;
  /** Price source for the derived beta and equity value. Absent in tests that do not exercise them. */
  barRepository?: () => Promise<BarRepository | undefined>;
  /** Dimension exploration's data source; absent means statement_unification does not build breakdowns. */
  tableStore?: FilingTableStore;
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
    barRepository: getSharedBarRepository,
    tableStore: SqliteFilingTableStore.open(databasePath),
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
      (service, id, revision) => service.reviewFacts(id, revision, parseHistoryReviewInput(input)),
      { refreshWacc: true })),
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
  if (!ingestion || ingestion.ownerAgentId !== context.agentId || ingestion.symbol !== symbol) {
    return failure("filing_ingestion_not_found", "Owned filing ingestion run not found.");
  }
  const source = ingestion.source;
  if (!source) return failure("filing_source_resolution_failed", ingestion.error?.message ?? "Filing source metadata is unavailable.",
    { retryable: true, ingestion_run_id: ingestionRunId });
  // A run is reusable: the first create keeps the run's own modelId, every later one mints a fresh id,
  // so one extraction can seed several independent model versions of the same issuer.
  const modelId = deps.modelStore.getMeta(ingestion.modelId) ? `fm_${randomUUID()}` : ingestion.modelId;
  const service = new FinancialModelService(deps.modelStore, context.sessionId);
  try {
    const created = service.createModel({ modelId, ownerAgentId: context.agentId, originSessionId: context.sessionId, symbol,
      metadata: { cik: String(source.company.cik), companyName: source.company.title, fiscalYearEnd: source.fiscalYearEnd },
      reportingCurrency: source.reportingCurrency, periods: source.periods, preparedStatementRows: [] });
    if (ingestion.status !== "ready" || !ingestion.prepared) return failure(ingestion.error?.code ?? "incomplete_financial_statements",
      ingestion.error?.message ?? "Filing preprocessing did not produce complete statements.", { model_id: modelId, revision: created.revision,
        retryable: true, ingestion_run_id: ingestionRunId, diagnostics: ingestion.diagnostics });
    const prepared = ingestion.prepared;
    const filingInsights = ingestion.filingInsightSetId ? deps.insightStore.getContext(ingestion.filingInsightSetId) : undefined;
    // The workbook leaves creation with source rows staged but no canonical mapping: the spine is the
    // statement_unification -> spine_mapping subagents' output, not something guessed at import.
    const imported = service.stagePreparedStatements(modelId, 0, prepared.rows, prepared.facts, ingestion.filingInsightSetId);
    deps.sourceReviewStore.save(modelId, { ingestionRunId, statementViews: prepared.statementViews, facts: prepared.facts,
      curatedTables: ingestion.curatedTables ?? [], curations: ingestion.curations ?? [],
      ...(ingestion.verification ? { verification: ingestion.verification } : {}),
      ...(ingestion.presentationExtracts ? { presentationExtracts: ingestion.presentationExtracts } : {}),
      dimensionalDisclosures: prepared.dimensionalDisclosures,
      coverage: prepared.coverage, filings: prepared.filings });
    const currentWorkbook = enrichWorkbook(imported.currentWorkbook, deps.sourceReviewStore.get(modelId));
    return success(`Created ${symbol} financial model ${modelId} at revision ${imported.revision}. Run statement_unification, then spine_mapping, to populate the spine.`,
      { model_id: modelId, revision: imported.revision,
        lifecycle_stage: imported.status, revision_summary: imported.revisionSummary, filing_insights: filingInsights ?? null,
        statement_coverage: prepared.coverage, current_workbook: currentWorkbook, warnings: imported.warnings });
  } catch (error) {
    if (error instanceof FinancialModelError) return toolError(error);
    return failure("financial_model_creation_failed", error instanceof Error ? error.message : String(error), { model_id: modelId, retryable: true });
  }
}

async function mutate(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext,
  action: (service: FinancialModelService, id: string, revision: number) => ReturnType<FinancialModelService["archive"]>,
  options: { refreshWacc?: boolean } = {}): Promise<ToolExecutionResult> {
  try {
    const id = requireString(input, "modelId"); requireOwner(deps, id, context.agentId);
    const service = new FinancialModelService(deps.modelStore, context.sessionId);
    const reviewResult = action(service, id, requireInteger(input, "expectedRevision"));
    let result = reviewResult;
    // Committing facts is what makes WACC terms derivable, so the engine works them out here rather
    // than waiting to be asked, and lands them as their own revision. The agent reads where the wacc
    // row stands off the commit it already made, with no separate call. The refresh's own
    // revision_summary/warnings are reported alongside — not in place of — the review commit's: the
    // agent's fact-review feedback loop reads revision_summary off the commit it actually asked for.
    let waccRefreshSkipped: string | undefined;
    if (options.refreshWacc === true) {
      const outcome = await refreshWaccSheetFromSpine(deps, service, id, result.revision);
      if (outcome.kind === "refreshed") result = outcome.result;
      else waccRefreshSkipped = outcome.reason;
    }
    const refreshed = result !== reviewResult && result.revision !== reviewResult.revision;
    const insights = insightContext(deps, result.currentWorkbook.filingInsightSetId ?? null);
    return success(`Updated financial model ${id} to revision ${result.revision}.${waccSummary(result.currentWorkbook.waccSheet)}`,
      { model_id: id, revision: result.revision,
        lifecycle_stage: result.status, revision_summary: reviewResult.revisionSummary, filing_insights: insights,
        current_workbook: enrichWorkbook(result.currentWorkbook, deps.sourceReviewStore.get(id)),
        ...(refreshed ? { wacc_refresh_summary: result.revisionSummary } : {}),
        ...(waccRefreshSkipped !== undefined ? { wacc_refresh_skipped: waccRefreshSkipped } : {}),
        warnings: [...reviewResult.warnings, ...(refreshed ? result.warnings : [])] });
  } catch (error) { return toolError(error); }
}

/** Maps the seven `WaccParameterName` terms `deriveWaccParameters` already knows how to compute onto
 * the WACC sheet rows they fill. equityRiskPremium has no measurable source and no sheet row of its
 * own here — the agent supplies it directly — so it is simply absent from this table. */
const WACC_SHEET_ROW_BY_PARAMETER_NAME: Partial<Record<WaccParameterName, WaccSheetComputedInput["rowId"]>> = {
  beta: "beta", costOfDebt: "cost_of_debt", equityValue: "equity_value", totalDebt: "total_debt", taxRate: "effective_tax_rate",
  riskFreeRate: "risk_free_rate",
};

type WaccRefreshOutcome =
  | { kind: "refreshed"; result: ReturnType<FinancialModelService["archive"]> }
  | { kind: "skipped"; reason: string };

/**
 * Runs the WACC derivation against the model's just-committed spine and folds whatever it can reach
 * into the sheet as a `wacc_sheet_refreshed` revision. Never lets the review commit that triggered it
 * fail: an absent bar repository, a derivation error, or simply nothing derivable all fall back to a
 * skip reason reported alongside the commit that already happened.
 */
async function refreshWaccSheetFromSpine(deps: FinancialModelToolDeps, service: FinancialModelService,
  modelId: string, expectedRevision: number): Promise<WaccRefreshOutcome> {
  if (!deps.barRepository) return { kind: "skipped", reason: "no price data source is configured" };
  try {
    const meta = deps.modelStore.getMeta(modelId);
    const stored = deps.modelStore.getRevision(modelId, expectedRevision);
    if (!meta || !stored) return { kind: "skipped", reason: "model not found" };
    const waccSheet = stored.snapshot.waccSheet;
    if (waccSheet === null) return { kind: "skipped", reason: "model has no WACC sheet" };
    const repository = await deps.barRepository();
    const derivationDeps: DerivationDeps = {
      dailyCloses: async (symbol, from, to) => repository === undefined ? []
        : (await repository.getBarsBetween(symbol, "1Day", from, to)).map((bar) => ({ t: bar.t, c: bar.c })),
      treasury30y: (asOf) => fetchTreasury30y(asOf),
    };
    // The as-of date is the sheet's own — fixed at the model's creation — never today's date, so a
    // refresh years later still derives against the same anchor the skeleton was built with.
    const { derived, cashAndEquivalents, unreachable } = await deriveWaccParameters({
      symbol: meta.symbol, asOfDate: waccSheet.asOfDate, facts: stored.snapshot.facts,
      lineItems: stored.snapshot.lineItems, periods: stored.snapshot.periods, deps: derivationDeps });
    const inputs: WaccSheetComputedInput[] = [];
    for (const parameter of derived) {
      const rowId = WACC_SHEET_ROW_BY_PARAMETER_NAME[parameter.name];
      if (rowId === undefined) continue;
      inputs.push({ rowId, value: parameter.value, provenance: { sourceType: parameter.sourceType,
        sourceRefs: parameter.sourceRefs, asOfDate: parameter.asOfDate, rationale: parameter.rationale } });
    }
    if (cashAndEquivalents) {
      inputs.push({ rowId: "cash_and_equivalents_value", value: cashAndEquivalents.value,
        provenance: { sourceType: "filing", sourceRefs: cashAndEquivalents.sourceRefs,
          asOfDate: waccSheet.asOfDate, rationale: cashAndEquivalents.rationale } });
    }
    if (inputs.length === 0) {
      const reason = unreachable.map((entry) => `${entry.name}: ${entry.reason}`).join("; ") || "no derivable WACC terms";
      return { kind: "skipped", reason };
    }
    return { kind: "refreshed", result: service.refreshWaccSheet(modelId, expectedRevision, inputs) };
  } catch (error) {
    return { kind: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
}

function waccSummary(waccSheet: WaccSheet | null): string {
  const row = waccSheet?.rows.find((entry) => entry.rowId === "wacc");
  if (!row) return "";
  return row.value !== null
    ? ` wacc ${row.value}.`
    : ` wacc null; missing: ${row.missingInputs.join(", ")}.`;
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
      // The full read carries the WACC sheet as part of current_workbook.waccSheet — the agent sees
      // where the model stands, and what the discount rate still needs, without a separate call.
      return success(`Loaded financial model ${id} revision ${view.currentWorkbook.revision}.`,
        { model_id: id, revision: view.currentWorkbook.revision,
          revision_history: view.revisionHistory, filing_insights: insightContext(deps, view.currentWorkbook.filingInsightSetId),
          current_workbook: enrichWorkbook(view.currentWorkbook, deps.sourceReviewStore.get(id)) });
    }
    return success(`Loaded financial model ${id} revision ${view.revision}.`, { model_id: id, revision: view.revision,
      filing_insights: insightContext(deps, stored.snapshot.filingInsightSetId ?? null), workbook_slice: view });
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
export function failure(code: string, message: string, data: JsonObject = {}): ToolExecutionResult { return { summary: message, error: { code, message }, generation_context: { data: { ...data, error: code } } }; }
export function toolError(error: unknown): ToolExecutionResult {
  if (error instanceof FinancialModelError) return failure(error.code, error.message, error.details ?? {});
  return failure("financial_model_error", error instanceof Error ? error.message : String(error));
}
function requireString(input: JsonObject, key: string): string { const value = input[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`); return value.trim(); }
function requireInteger(input: JsonObject, key: string): number { const value = input[key]; if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`); return value; }
function requireArray(input: JsonObject, key: string): JsonValue[] { const value = input[key]; if (!Array.isArray(value)) throw new Error(`${key} must be an array`); return value; }
function boundedInteger(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`value must be an integer from ${min} to ${max}`); return value;
}
