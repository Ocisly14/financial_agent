import { randomUUID } from "node:crypto";
import path from "node:path";
import type { JsonObject, JsonSchema, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import { FinancialModelError } from "../../src/financial-model/errors.ts";
import type { FinancialModelSnapshot, ModelOperation, ModelQuery } from "../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../src/financial-model/service.ts";
import { MODEL_READ_SECTIONS, type CurrentWorkbookView, type HistoricalDcfCompletenessView, type ModelContextView } from "../../src/financial-model/views.ts";
import { financialModelSnapshotCodec } from "../../src/financial-model/snapshotCodec.ts";
import { SqliteModelStore, type ModelFilter, type ModelStore } from "../../src/financial-model/store.ts";
import { SqliteFilingInsightStore, type FilingInsightStore } from "../../src/infra/filing-insights/store.ts";
import type { FilingInsightContextView } from "../../src/infra/filing-insights/types.ts";
import { SqliteSourceReviewStore, type FilingIngestionStore, type SourceReviewStore } from "../../src/infra/xbrl/sourceReviewStore.ts";
import { SqliteFilingTableStore, type FilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import type { RegisteredTool, ToolExecutionContext } from "../toolRegistry.ts";
import { operationsInputSchema, parseOperations, validate } from "./schemas.ts";
import { explainFailedIdentity } from "../../src/financial-model/reconciliation.ts";
import { splitCellKey, type CellKey } from "../../src/financial-model/dsl/graph.ts";
import { suggestionClause, type NameSpace } from "../../src/framework/suggest.ts";
import { deriveWaccParameters, type DerivationDeps, type WaccParameterName } from "../../src/financial-model/waccDerivation.ts";
import type { WaccSheet, WaccSheetComputedInput } from "../../src/financial-model/waccSheet.ts";
import { getSharedBarRepository, type BarRepository } from "../../src/data/stock/index.ts";
import { fetchTreasury30y } from "../../src/infra/market/treasuryYield.ts";

export const FINANCIAL_MODELING_TOOLS = [
  "create_financial_model", "apply_financial_model_operations",
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
    tool("apply_financial_model_operations", "Apply an ordered batch of DCF assumptions, formulas, categories, configuration, and stage changes.", {
      ...(operationsInputSchema.properties as unknown as Record<string, JsonObject>),
    }, operationsInputSchema.required ?? [], async (input, context) => mutate(deps, input, context,
      (service, id, revision) => service.applyOperations(id, revision, parseOperations(input)))),
    tool("get_financial_model",
      "Read the model. With modelId alone: an overview — lifecycle, per-section fill counts, what the "
      + "required history still lacks, diagnostics grouped by code. Narrow with `section` for one "
      + "section's rows, or `selector` for named rows and cells. Also reads a prior revision, lineage, "
      + "or one filing insight.", {
        modelId: { type: "string" }, revision: { type: "number" },
        section: { type: "string", enum: [...MODEL_READ_SECTIONS],
          description: "One section's rows, with values. `source_*` are the as-filed statements. "
            + "Sections group rows structurally, NOT by time — `history` is the section of historical "
            + "input rows, not a filter for any row's historical periods. For one row's history, name "
            + "the row and use selector.periodClass \"actual\" (or explicit periodIds) with no section. "
            + "Do not combine it with named rows from another section; the error names their section." },
        selector: { type: "object", additionalProperties: false, description:
          "Narrow to named rows or cells. Combined filters intersect; omit to select the whole section. "
            + "When a section excludes a named row, the response identifies that row's actual section.",
          properties: {
            lineItemIds: { type: "array", items: { type: "string" }, description: "Exact line item ids, e.g. [\"revenue.total\", \"fcff\"]." },
            periodIds: { type: "array", items: { type: "string" }, description: "Exact period ids, e.g. [\"FY2024\", \"FY2025\"]." },
            cellRefs: { type: "array", description: "Individual cells, when whole rows are more than you need.",
              items: { type: "object", additionalProperties: false, required: ["lineItemId", "periodId"],
                properties: { lineItemId: { type: "string" }, periodId: { type: "string" } } } },
            parentId: { type: "string", description: "Restrict to the children of one line item." },
            section: { type: "string", enum: [...MODEL_READ_SECTIONS] },
            role: { type: "string", description: "Restrict to line items carrying one engine role, e.g. \"fcff\"." },
            periodClass: { type: "string", enum: ["actual", "ttm", "forecast"] },
          } },
        includeLineage: { type: "boolean", description: "Attach how each cell was derived. Costly — ask for it on a narrowed read." },
        reopenSources: { type: "boolean" }, insightId: { type: "string" },
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
  if (!ingestion || ingestion.ownerTenantId !== context.tenantId || ingestion.symbol !== symbol) {
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
    const created = service.createModel({ modelId, ownerTenantId: context.tenantId, originSessionId: context.sessionId, symbol,
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
    // The workbook is deliberately NOT returned here. At this revision it is the raw filing rows,
    // unmapped — hundreds of lines the agent can form no judgment about, and whose only consumer is
    // statement_unification, which reads them from the store rather than from this response. Returning
    // it cost ~430k characters that then rode along in every later step's context, for nothing.
    // Coverage is what this stage is actually judged on; `get_financial_model` with a section serves
    // anyone who does want to look.
    return success(`Created ${symbol} financial model ${modelId} at revision ${imported.revision} with `
      + `${prepared.rows.length} source row(s) staged. Run statement_unification, then spine_mapping, to populate the spine. `
      + `The workbook is not included at this revision — read it with get_financial_model (pass a section) if you need it.`,
      { model_id: modelId, revision: imported.revision,
        lifecycle_stage: imported.status, revision_summary: imported.revisionSummary, filing_insights: filingInsights ?? null,
        statement_coverage: prepared.coverage, staged_row_count: prepared.rows.length,
        warning_summary: summarizeDiagnostics(imported.warnings) });
  } catch (error) {
    if (error instanceof FinancialModelError) return toolError(error);
    return failure("financial_model_creation_failed", error instanceof Error ? error.message : String(error), { model_id: modelId, retryable: true });
  }
}

async function mutate(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext,
  action: (service: FinancialModelService, id: string, revision: number) => ReturnType<FinancialModelService["archive"]>,
  options: { refreshWacc?: boolean } = {}): Promise<ToolExecutionResult> {
  try {
    const id = requireString(input, "modelId"); requireOwner(deps, id, context.tenantId);
    const service = new FinancialModelService(deps.modelStore, context.sessionId);
    const expectedRevision = requireInteger(input, "expectedRevision");
    const reviewResult = action(service, id, expectedRevision);
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
    // The same overview a read answers with, not the workbook. The agent just wrote this model; what
    // it does not know is where the write left it, and `revision_summary` below names the sections
    // that moved — it narrows to one of those with get_financial_model when it wants the values.
    // Echoing the whole workbook was both dearer and less use: on an AAPL run it cost ~71k tokens a
    // write and still did not say why the model was stuck, because the shortfall was not in it.
    const view = new FinancialModelService(deps.modelStore, context.sessionId).getModel(id);
    if (!("currentWorkbook" in view)) throw new Error("untargeted read expected");
    const summary = overview(view, service.historicalCompleteness(id),
      insightContext(deps, view.currentWorkbook.filingInsightSetId), deps.sourceReviewStore.get(id));
    // Keep the agent's explicitly-read slices as revision-stamped working memory.  A mutation
    // returns this compact delta rather than echoing a workbook; the agent decides whether its next
    // task needs a fresh read of a changed section's values.
    const changedRows = modelChangeRows(view.currentWorkbook, reviewResult.revisionSummary.changes);
    // `warnings` used to ride along here as well, but a commit's warnings ARE the snapshot's
    // diagnostics — the same array the overview groups by code — so the response carried the same
    // 503 `missing_input` entries twice, once counted and once spelled out. The count lives on
    // revision_summary.warningCount; the grouping is in model_overview.diagnostics_by_code.
    return success(`Updated financial model ${id} to revision ${result.revision}`
      + `${waccSummary(result.currentWorkbook.waccSheet)}${shortfallPhrase(summary)}.`,
      { ...summary,
        revision_summary: reviewResult.revisionSummary,
        model_change_context: { revision: result.revision,
          changed_sections: reviewResult.revisionSummary.changedSections,
          changed_rows: changedRows },
        ...(refreshed ? { wacc_refresh_summary: result.revisionSummary } : {}),
        ...(waccRefreshSkipped !== undefined ? { wacc_refresh_skipped: waccRefreshSkipped } : {}) });
  } catch (error) { return toolError(error); }
}

function modelChangeRows(workbook: CurrentWorkbookView, changes: RevisionChangeSummary["changes"]): JsonValue[] {
  const changedIds = new Set<string>();
  for (const change of changes) {
    if ("lineItemId" in change) changedIds.add(change.lineItemId);
    if ("parentLineItemId" in change) changedIds.add(change.parentLineItemId);
  }
  return Object.values(workbook.sections).flat().filter((row) => "lineItemId" in row && changedIds.has(row.lineItemId))
    .map((row) => ({ line_item_id: row.lineItemId, section: row.section, sources: row.sources,
      formulas: row.formulas.map((formula) => ({ applies_to: formula.appliesTo, period_ids: formula.periodIds, source: formula.source })),
      assumption_ids: row.assumptions.map((assumption) => assumption.assumptionId) })) as unknown as JsonValue[];
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
export async function refreshWaccSheetFromSpine(deps: FinancialModelToolDeps, service: FinancialModelService,
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
      lineItems: stored.snapshot.lineItems, periods: stored.snapshot.periods, cells: stored.snapshot.cells,
      deps: derivationDeps });
    const inputs: WaccSheetComputedInput[] = [];
    for (const parameter of derived) {
      const rowId = WACC_SHEET_ROW_BY_PARAMETER_NAME[parameter.name];
      if (rowId === undefined) continue;
      inputs.push({ rowId, value: parameter.value, provenance: { sourceType: parameter.sourceType,
        sourceRefs: parameter.sourceRefs, asOfDate: parameter.asOfDate, rationale: parameter.rationale } });
    }
    if (cashAndEquivalents) {
      inputs.push({ rowId: "cash_and_equivalents_value", value: cashAndEquivalents.value,
        provenance: { sourceType: cashAndEquivalents.sourceType, sourceRefs: cashAndEquivalents.sourceRefs,
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
    const id = requireString(input, "modelId"); requireOwner(deps, id, context.tenantId);
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
      // The overview carries the WACC sheet whole — twelve rows, and what the discount rate still
      // needs is a decision the agent makes from where it already is.
      const summary = overview(view, service.historicalCompleteness(id),
        insightContext(deps, view.currentWorkbook.filingInsightSetId), deps.sourceReviewStore.get(id));
      return success(`Loaded financial model ${id} revision ${view.currentWorkbook.revision} `
        + `(${view.currentWorkbook.lifecycleStage})${shortfallPhrase(summary)}.`, summary);
    }
    return success(`Loaded financial model ${id} revision ${view.revision}.`, { model_id: id, revision: view.revision,
      filing_insights: insightContext(deps, stored.snapshot.filingInsightSetId ?? null), workbook_slice: view });
  } catch (error) {
    const modelId = typeof input["modelId"] === "string" ? input["modelId"] : undefined;
    return toolError(error, modelId === undefined ? undefined : () => nameSpacesFor(deps, modelId));
  }
}

async function listModels(deps: FinancialModelToolDeps, input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const filter: ModelFilter = { ownerTenantId: context.tenantId };
  if (typeof input["symbol"] === "string") filter.symbol = input["symbol"].toUpperCase();
  if (typeof input["lifecycleStage"] === "string" && ["draft", "history_committed", "revenue_forecast", "operations_fcff", "valued", "archived"].includes(input["lifecycleStage"])) {
    filter.lifecycleStage = input["lifecycleStage"] as NonNullable<ModelFilter["lifecycleStage"]>;
  }
  if (input["includeArchived"] === true) filter.includeArchived = true;
  const models = new FinancialModelService(deps.modelStore, context.sessionId).listModels(filter);
  return success(`Found ${models.length} owned financial model(s).`, { models });
}

function requireOwner(deps: FinancialModelToolDeps, id: string, tenantId: string): void {
  const model = deps.modelStore.getMeta(id);
  if (!model || model.ownerTenantId !== tenantId) throw new FinancialModelError("financial_model_not_found", `model not found: ${id}`);
}
function insightContext(deps: FinancialModelToolDeps, id: string | null): FilingInsightContextView | null { return id ? deps.insightStore.getContext(id) ?? null : null; }
/**
 * The orienting read: what the model is, what is filled, and what is still owed — at a size the
 * agent can afford to take more than once.
 *
 * The full context view runs to ~68k tokens, three quarters of which is bulk that answers no
 * question on its own: 773 diagnostics that all say `missing_input` and name a cell, and 50
 * reconciliation results of which the interesting ones are the failures. An agent that reads that
 * to find out where it stands pays for the whole workbook and carries it for the rest of the run —
 * and one that reads it five times in a row, as happened on an AAPL run, carries it five times.
 *
 * So this is the default, and `section` or `selector` narrows from here. It follows the shape
 * list_unified_statements already set for the unified rows: orient first, then pull what you named.
 */
function overview(view: ModelContextView, completeness: HistoricalDcfCompletenessView,
  insights: FilingInsightContextView | null, source: ReturnType<SourceReviewStore["get"]>): JsonObject {
  const workbook = view.currentWorkbook;
  const sourceSummary = workbook.mode === "statement_mapping" ? sourceStatementSummary(source) : undefined;
  const filled = (row: { cells: Record<string, { value: number | null }> }): number =>
    Object.values(row.cells).filter((cell) => cell.value !== null && cell.value !== undefined).length;

  const sections = Object.fromEntries(Object.entries(workbook.sections).map(([name, rows]) => {
    const cells = rows.reduce((sum, row) => sum + Object.keys(row.cells).length, 0);
    const withValues = rows.reduce((sum, row) => sum + filled(row), 0);
    return [name, { rows: rows.length, cells_filled: withValues, cells_empty: cells - withValues }];
  }));

  // Named, not counted: this is the list that decides whether the model can leave `draft`, and an
  // agent that cannot see it goes looking for the answer at the wrong end of the workbook.
  //
  // Completeness is measured over the selected historical periods, so before any are selected it
  // has nothing to measure and reports no gaps. That reads as "complete" and is the opposite of
  // true — the gate refuses an empty selection outright — so the empty case is stated, not counted.
  const selected = completeness.selectedHistoricalPeriodIds;
  const missing = completeness.categories.flatMap((category) => category.periods
    .filter((period) => period.status === "missing").map((period) => `${category.lineItemId}@${period.periodId}`));
  const requiredHistory = selected.length === 0
    ? { complete: false, missing: [] as string[],
        blocked_by: "no historical periods are selected yet — commit spine facts before the history can be judged" }
    : { complete: missing.length === 0, missing };

  const byCode = new Map<string, string[]>();
  for (const diagnostic of workbook.diagnostics) {
    const refs = byCode.get(diagnostic.code) ?? [];
    refs.push(...diagnostic.refs);
    byCode.set(diagnostic.code, refs);
  }
  const diagnostics = [...byCode].map(([code, refs]) => ({ code, count: refs.length, refs: refs.slice(0, 12),
    ...(refs.length > 12 ? { more: refs.length - 12 } : {}) }));

  const reconciliations = workbook.reconciliationResults;
  // A failed identity without its components' values sends the agent reading the workbook to find
  // them, which is exactly the search that stalls a run. Ship them with the failure, and name the
  // component whose polarity would account for the residual — see explainFailedIdentity.
  const rowsByLineItemId = new Map(Object.values(workbook.sections).flat()
    .flatMap((row) => "lineItemId" in row ? [[row.lineItemId as string, row] as const] : []));
  const failed = reconciliations.filter((result) => result.status === "failed").map((result) => {
    if (result.residual === null) return result;
    const components = result.refs.flatMap((ref) => {
      const { lineItemId, periodId } = splitCellKey(ref as CellKey);
      // The parent's own children are where a polarity error hides; the parent cell only carries
      // their total, which is the number that already failed.
      return [...rowsByLineItemId.entries()]
        .filter(([id, row]) => id !== lineItemId && (row as { parentId?: string }).parentId === lineItemId)
        .flatMap(([id, row]) => {
          const value = (row as { cells: Record<string, { value: number | null }> }).cells[periodId]?.value;
          return typeof value === "number" ? [{ lineItemId: id, value }] : [];
        });
    });
    if (components.length === 0) return result;
    return { ...result, ...explainFailedIdentity({ residual: result.residual, tolerance: result.tolerance }, components) };
  });

  // model_id / revision / lifecycle_stage / revision_history / filing_insights stay at the top
  // level: projectFinancialModelData reads those by name to build the agent's active model context.
  // Everything this function adds rides in one key, so that projection needs to learn one name
  // rather than grow a list it can silently fall behind.
  return {
    model_id: workbook.modelId, revision: workbook.revision, lifecycle_stage: workbook.lifecycleStage,
    revision_history: view.revisionHistory.slice(-5), filing_insights: insights,
    model_overview: {
      symbol: view.model.symbol,
      periods: workbook.periods.map((period) => ({ id: period.id, cls: period.cls })),
      sections,
      // Nothing else decides `draft`, and naming the cells costs less than the search for them.
      required_history: requiredHistory,
      diagnostics_by_code: diagnostics,
      lifecycle_blockers: workbook.diagnostics
        .filter((diagnostic) => diagnostic.stage !== undefined)
        .map((diagnostic) => ({ stage: diagnostic.stage, code: diagnostic.code,
          message: diagnostic.message, refs: diagnostic.refs })),
      reconciliations: { total: reconciliations.length,
        by_status: [...reconciliations.reduce((counts, result) => counts.set(result.status, (counts.get(result.status) ?? 0) + 1),
          new Map<string, number>())].map(([status, count]) => ({ status, count })),
        failed },
      wacc_sheet: workbook.waccSheet, valuation: workbook.valuation, valuation_config: workbook.valuationConfig,
      ...(sourceSummary ? { source_statement_summary: sourceSummary } : {}),
      read_more: "Narrow with `section` for one section's rows, or `selector` "
        + "(lineItemIds / periodIds / cellRefs / role / periodClass) for specific rows and cells.",
    },
  } as unknown as JsonObject;
}

/** Where the model still falls short of leaving `draft`, as a clause for the summary line. */
function shortfallPhrase(summary: JsonObject): string {
  const overview = summary["model_overview"] as {
    required_history: { complete: boolean; missing: string[]; blocked_by?: string };
    lifecycle_blockers: Array<{ message?: string }>;
  };
  const required = overview.required_history;
  if (required.complete) {
    const blocker = overview.lifecycle_blockers[0];
    return blocker?.message ? `; ${blocker.message}` : "";
  }
  if (required.blocked_by !== undefined) return `; ${required.blocked_by}`;
  return `; required history still missing ${required.missing.length} cell(s)`;
}

/**
 * What the extraction produced, for a model whose spine is not committed yet. None of it can be
 * read back off a section — the filings and their coverage are facts about the import, not rows —
 * so it travels with the overview for as long as the workbook is still in mapping mode.
 */
function sourceStatementSummary(source: ReturnType<SourceReviewStore["get"]>): JsonObject | undefined {
  if (!source) return undefined;
  return {
    filings: source.filings,
    coverage: source.coverage,
    selected_tables: source.curations,
    normalized_row_count: Object.values(source.statementViews).reduce((sum, view) => sum + view.candidate.rows.length, 0),
    staged_fact_count: source.facts.length,
    source_conflict_count: source.verification?.columnConflicts.length ?? 0,
  } as unknown as JsonObject;
}
/**
 * Diagnostics carry a `refs` list per entry, so a freshly staged import runs to tens of thousands of
 * characters of cell keys. What the agent can act on at that point is the shape — which kinds, how
 * many, an example of each — not the enumeration. It reads the individual refs from the workbook when
 * a specific number turns out to be wrong.
 */
function summarizeDiagnostics(warnings: { code: string; refs: string[] }[]): JsonObject {
  const byCode = new Map<string, { count: number; example?: string }>();
  for (const warning of warnings) {
    const entry = byCode.get(warning.code) ?? { count: 0 };
    entry.count += 1;
    if (entry.example === undefined && warning.refs[0] !== undefined) entry.example = warning.refs[0];
    byCode.set(warning.code, entry);
  }
  return { total: warnings.length,
    by_code: Object.fromEntries([...byCode].map(([code, entry]) => [code, entry as unknown as JsonValue])) };
}

function success(summary: string, data: JsonObject): ToolExecutionResult { return { summary, generation_context: { data } }; }
export function failure(code: string, message: string, data: JsonObject = {}): ToolExecutionResult { return { summary: message, error: { code, message }, generation_context: { data: { ...data, error: code } } }; }
/**
 * Every namespace a rejected name might really belong to, with the one call that reads each.
 *
 * Gathered here rather than declared per validation point: the engine that rejects an id knows only
 * its own line items, while the guess is as likely to be a unified rowId — an AMZN run asked for
 * `marketable_securities`, which is not a line item but is a source row and a unified row. Only the
 * tool boundary can see all three, so this is where the search belongs.
 */
function nameSpacesFor(deps: FinancialModelToolDeps, modelId: string): NameSpace[] {
  const spaces: NameSpace[] = [];
  const snapshot = deps.modelStore.getRevision(modelId)?.snapshot;
  if (snapshot) {
    spaces.push({ kind: "line item", how: "get_financial_model { selector: { lineItemIds } }",
      names: snapshot.lineItems.map((item) => item.id) });
    spaces.push({ kind: "period", how: "get_financial_model { selector: { periodIds } }",
      names: snapshot.periods.map((period) => period.id) });
  }
  const unified = deps.sourceReviewStore.get(modelId)?.unifiedStatements;
  if (unified) {
    spaces.push({ kind: "unified row", how: "get_unified_rows { rowIds }",
      names: unified.rows.map((row) => row.rowId) });
  }
  spaces.push({ kind: "section", how: "get_financial_model { section }", names: [...MODEL_READ_SECTIONS] });
  return spaces;
}

/**
 * `spaces` is looked at only when the error names the input it rejected (`details.unknownName`), so
 * the search costs nothing on the errors that already say what to do.
 */
export function toolError(error: unknown, spaces?: () => NameSpace[]): ToolExecutionResult {
  if (error instanceof FinancialModelError) {
    const unknownName = error.details?.["unknownName"];
    const clause = typeof unknownName === "string" && spaces
      ? suggestionClause(unknownName, spaces())
      : "";
    return failure(error.code, error.message + clause, error.details ?? {});
  }
  return failure("financial_model_error", error instanceof Error ? error.message : String(error));
}
function requireString(input: JsonObject, key: string): string { const value = input[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`); return value.trim(); }
function requireInteger(input: JsonObject, key: string): number { const value = input[key]; if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`); return value; }
function requireArray(input: JsonObject, key: string): JsonValue[] { const value = input[key]; if (!Array.isArray(value)) throw new Error(`${key} must be an array`); return value; }
function boundedInteger(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`value must be an integer from ${min} to ${max}`); return value;
}
