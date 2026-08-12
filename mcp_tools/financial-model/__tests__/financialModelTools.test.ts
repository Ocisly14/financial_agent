import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore, type FilingIngestionArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import type { FilingTable, TableCuration } from "../../../src/infra/xbrl/tableTypes.ts";
import type { PreparedFilingStatements, PresentationExtract } from "../../../src/infra/xbrl/types.ts";
import { FinancialModelService } from "../../../src/financial-model/service.ts";
import type { Fact, Period } from "../../../src/financial-model/types.ts";
import type { BarRepository, DailyBar } from "../../../src/data/stock/index.ts";
import { recalculateWaccSheet, setWaccInput } from "../../../src/financial-model/waccSheet.ts";
import { createFinancialModelTools, refreshWaccSheetFromSpine, type FinancialModelToolDeps } from "../financialModelTools.ts";
import { formatAllowedTools } from "../../../src/framework/subagent.ts";

function fixture(): { deps: FinancialModelToolDeps; ingestion: InMemorySourceReviewStore; prepared: PreparedFilingStatements } {
  const ingestion = new InMemorySourceReviewStore();
  const periods = [
    { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" as const },
    { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" as const },
    { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" as const },
    { id: "FY2027", label: "FY2027", start: "2027-01-01", end: "2027-12-31", cls: "forecast" as const },
  ];
  const rows = (["income_statement", "balance_sheet", "cash_flow_statement"] as const).map((statement, index) => ({
    sourceLineItemId: `source.${statement}.row`, statement, label: `${statement} row`, unit: { kind: "currency" as const, code: "USD" }, order: index,
  }));
  const facts = rows.map((row, index) => ({ factId: `f${index}`, status: "staged" as const, lineItemId: row.sourceLineItemId,
    periodId: "FY2024", value: 100 + index, unit: row.unit, provenance: { sourceType: "filing_xbrl", sourceRefs: ["fixture"], asOfDate: "2026-02-01" } }));
  const statementViews = Object.fromEntries(rows.map((row) => [row.statement, { candidate: { periods, rows: [] }, filingPresentations: [] }])) as unknown as PreparedFilingStatements["statementViews"];
  const prepared: PreparedFilingStatements = { filings: [], periods, rows, facts, statementViews, dimensionalDisclosures: [], diagnostics: [],
    coverage: { requestedPeriodIds: ["FY2024"], statements: rows.map((row) => ({ statement: row.statement, availablePeriodIds: ["FY2024"], missingPeriodIds: [] })), issues: [] } };
  return { ingestion, prepared, deps: { modelStore: new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec),
    insightStore: new InMemoryFilingInsightStore(), sourceReviewStore: ingestion, ingestionStore: ingestion } };
}

const CURATED_STATEMENTS = ["income_statement", "balance_sheet", "cash_flow_statement"] as const;
const curatedTables: FilingTable[] = CURATED_STATEMENTS.map((statement, index) => ({
  sourceTableId: `filing:html-table:${index + 1}`, accession: "filing", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31",
  heading: statement, htmlOrder: index + 1, sourceAnchor: `https://sec.test/filing#table=${index + 1}`,
  prescreen: { tier: "strong", presentationOverlap: 0.9, dimensionlessRatio: 1, periodSpan: 1, factCount: 1 },
  suggestedStatements: [statement], columns: [], rows: [],
}));
const curations: TableCuration[] = CURATED_STATEMENTS.map((statement, index) => ({
  sourceTableId: `filing:html-table:${index + 1}`, statement, reportDate: "2025-12-31", kind: "face",
  rationale: "Consolidated statement heading and complete annual columns.",
}));

const presentationExtracts: PresentationExtract[] = [{
  filing: { accession: "filing", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31", primaryDocumentUrl: "https://sec.test/filing" },
  calculationRelations: [], negatedConcepts: [], statements: [],
}];

function run(ready = true) {
  const value = fixture();
  const artifact: FilingIngestionArtifact = { ingestionRunId: "ing-1", modelId: "model-1", ownerAgentId: "owner-1", symbol: "TEST",
    status: ready ? "ready" : "failed", source: { company: { cik: 1, ticker: "TEST", title: "Test Co" }, reportingCurrency: "USD",
      fiscalYearEnd: "12-31", periods: value.prepared.periods, filings: [] }, diagnostics: [],
    curatedTables: structuredClone(curatedTables), curations: structuredClone(curations),
    presentationExtracts: structuredClone(presentationExtracts),
    ...(ready ? { prepared: value.prepared } : { error: { code: "incomplete_financial_statements", message: "cash flow missing" } }) };
  value.ingestion.saveIngestion(artifact);
  return { ...value, tools: new Map(createFinancialModelTools(value.deps).map((tool) => [tool.name, tool])) };
}

test("create writes explicit revisions zero and one, and the same run can seed further model versions", async () => {
  const { deps, ingestion, tools } = run();
  const result = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  assert.equal(result.error, undefined);
  assert.equal(result.generation_context?.data["revision"], 1);
  assert.deepEqual(deps.modelStore.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);
  // A second create from the same extraction mints an independent model version of the same issuer.
  const second = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  assert.equal(second.error, undefined);
  const secondId = second.generation_context?.data["model_id"] as string;
  assert.notEqual(secondId, "model-1");
  assert.deepEqual(deps.modelStore.listRevisionHeaders(secondId).map((header) => header.revision), [0, 1]);
  // Each version carries its own source review artifact.
  assert.ok(ingestion.get(secondId));
  assert.ok(ingestion.get("model-1"));
});

test("failed three-statement ingestion leaves a durable revision zero", async () => {
  const { deps, tools } = run(false);
  const result = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  assert.equal(result.error?.code, "incomplete_financial_statements");
  assert.equal(deps.modelStore.getRevision("model-1")?.revision, 0);
});

test("all reads and mutations are owner scoped without disclosing another owner's model", async () => {
  const { tools } = run();
  await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  const read = await tools.get("get_financial_model")!.execute({ modelId: "model-1" }, { agentId: "owner-2", sessionId: "s2" });
  const archive = await tools.get("archive_financial_model")!.execute({ modelId: "model-1", expectedRevision: 1 }, { agentId: "owner-2", sessionId: "s2" });
  const list = await tools.get("list_financial_models")!.execute({}, { agentId: "owner-2", sessionId: "s2" });
  assert.equal(read.error?.code, "financial_model_not_found");
  assert.equal(archive.error?.code, "financial_model_not_found");
  assert.deepEqual(list.generation_context?.data["models"], []);
});

test("ingestion ownership/symbol checks still gate every create, and use never consumes the artifact", async () => {
  const { tools } = run();
  const wrongOwner = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-2", sessionId: "s" });
  const wrongSymbol = await tools.get("create_financial_model")!.execute({ symbol: "NOPE", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(wrongOwner.error?.code, "filing_ingestion_not_found");
  assert.equal(wrongSymbol.error?.code, "filing_ingestion_not_found");
  const valid = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(valid.error, undefined);
  const wrongOwnerAfterUse = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-2", sessionId: "s" });
  assert.equal(wrongOwnerAfterUse.error?.code, "filing_ingestion_not_found");
});

test("create carries the curation loop's tables and decisions into the source review artifact", async () => {
  const { ingestion, tools } = run();
  const created = await tools.get("create_financial_model")!.execute(
    { symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(created.error, undefined);
  const source = ingestion.get("model-1")!;
  assert.deepEqual(source.curations, curations);
  assert.deepEqual(source.curatedTables.map((table) => table.sourceTableId), curatedTables.map((table) => table.sourceTableId));
  assert.deepEqual(source.presentationExtracts, presentationExtracts);
  assert.ok(source.presentationExtracts!.every((extract) => !("tables" in extract)));
});

test("tool schemas expose nested operation contracts and reject unknown or malformed payloads", async () => {
  const { tools } = run();
  const operationItems = tools.get("apply_financial_model_operations")!.inputSchema.properties?.["operations"]?.items;
  assert.ok(operationItems?.oneOf?.some((variant) => variant.properties?.["kind"]?.enum?.includes("set_assumption")));
  const rendered = formatAllowedTools([tools.get("apply_financial_model_operations")!]);
  for (const field of ["set_assumption", "set_formula", "set_valuation_config", "assumptionId", "sensitivity"]) assert.match(rendered, new RegExp(field));

  const unknown = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1", surprise: true }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(unknown.error?.code, "invalid_tool_input");
  const invalidOperation = await tools.get("apply_financial_model_operations")!.execute({ modelId: "m", expectedRevision: 1,
    operations: [{ kind: "invented_operation" }] }, { agentId: "owner-1", sessionId: "s" });
  assert.equal(invalidOperation.error?.code, "invalid_tool_input");
});

test("apply_financial_model_operations writes set_wacc_input end to end, and rejects a payload missing rationale", async () => {
  const { tools } = run();
  const owner = { agentId: "owner-1", sessionId: "s" };
  await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, owner);

  const missingRationale = await tools.get("apply_financial_model_operations")!.execute({
    modelId: "model-1", expectedRevision: 1,
    operations: [{ kind: "set_wacc_input", rowId: "risk_free_rate", value: 0.04,
      sourceType: "market_data", sourceRefs: ["treasury:10y"] }],
  }, owner);
  assert.equal(missingRationale.error?.code, "invalid_tool_input");

  const result = await tools.get("apply_financial_model_operations")!.execute({
    modelId: "model-1", expectedRevision: 1,
    operations: [{ kind: "set_wacc_input", rowId: "risk_free_rate", value: 0.04,
      sourceType: "market_data", sourceRefs: ["treasury:10y"], rationale: "10y treasury yield" }],
  }, owner);
  assert.equal(result.error, undefined);
  assert.equal(result.generation_context?.data["revision"], 2);
  // A write answers with the overview, which carries the WACC sheet whole — twelve rows, and what
  // the discount rate still needs is read off them without a second call.
  const summary = result.generation_context?.data["model_overview"] as {
    wacc_sheet?: { rows: Array<{ rowId: string; value: number | null; provenance?: { rationale: string } }> } };
  const row = summary.wacc_sheet?.rows.find((entry) => entry.rowId === "risk_free_rate");
  assert.equal(row?.value, 0.04);
  assert.equal(row?.provenance?.rationale, "10y treasury yield");
});

test("a review decision may omit reviewedAt, and the committed ledger carries the host's stamp", async () => {
  const { deps, tools } = run();
  const owner = { agentId: "owner-1", sessionId: "s" };
  await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, owner);
  // replace_fact is the surviving path that writes review decisions, and it supersedes a COMMITTED
  // fact — so commit one off the spine first, exactly as spine_mapping would.
  const service = new FinancialModelService(deps.modelStore, "s");
  const spine: Fact = { factId: "spine-revenue", status: "staged", lineItemId: "revenue.total", periodId: "FY2024",
    value: 100, unit: { kind: "currency", code: "USD" },
    provenance: { sourceType: "unified_statements", sourceRefs: ["unified.revenue.total"], asOfDate: "2026-02-01" } };
  const committed = service.commitSpineFacts("model-1", 1, { facts: [spine], historicalPeriodIds: ["FY2024"] });
  const before = new Date().toISOString();

  // Neither decision carries a caller-supplied reviewedAt: the host stamps both.
  const result = await tools.get("apply_financial_model_operations")!.execute({
    modelId: "model-1", expectedRevision: committed.revision,
    operations: [{
      kind: "replace_fact",
      replacement: { ...spine, factId: "spine-revenue-corrected", value: 101, supersedesFactId: "spine-revenue" },
      commitDecision: { decisionId: "d1", factId: "spine-revenue-corrected", action: "commit",
        mappedLineItemId: "revenue.total",
        rationale: "Confirmed against the filing", reviewedBy: "financial_modeling" },
      supersedeDecision: { decisionId: "d2", factId: "spine-revenue", action: "supersede",
        replacementFactId: "spine-revenue-corrected",
        rationale: "Superseded by the corrected figure", reviewedBy: "financial_modeling" },
    }],
  }, owner);
  assert.equal(result.error, undefined);

  const stamped = deps.modelStore.getRevision("model-1")!.snapshot.factReviewDecisions.find((entry) => entry.decisionId === "d1");
  assert.ok(stamped, "the decision was committed");
  assert.ok(stamped!.reviewedAt >= before && stamped!.reviewedAt <= new Date().toISOString());
});

test("without a price data source the WACC refresh reports itself skipped instead of failing", async () => {
  const { deps } = run();
  assert.equal(deps.barRepository, undefined);
  const service = new FinancialModelService(deps.modelStore, "s");
  const tools = new Map(createFinancialModelTools(deps).map((tool) => [tool.name, tool]));
  await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s" });
  const outcome = await refreshWaccSheetFromSpine(deps, service, "model-1", 1);
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") assert.ok(outcome.reason.length > 0);
});

// --- WACC-sheet auto-refresh, wired end to end through review_financial_model_history --------------

// refreshWaccSheetFromSpine wires treasury30y straight to fetchTreasury30y's default (global) fetch, so
// these tests stub globalThis.fetch with a canned treasury.gov-shaped feed rather than hitting the
// network. Every requested month resolves to one point, dated the 1st of that month, at a fixed rate —
// on or before any asOfDate drawn from that same month (model creation uses today's date).
const WACC_TEST_RISK_FREE_RATE = 0.0486;
const originalFetch = globalThis.fetch;
function stubTreasuryFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const monthMatch = /field_tdr_date_value_month=(\d{6})/.exec(url);
    const month = monthMatch?.[1] ?? "202601";
    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns="http://www.w3.org/2005/Atom">
<entry><content type="application/xml"><m:properties>
<d:NEW_DATE m:type="Edm.DateTime">${month.slice(0, 4)}-${month.slice(4, 6)}-01T00:00:00</d:NEW_DATE>
<d:BC_30YEAR m:type="Edm.Double">${WACC_TEST_RISK_FREE_RATE * 100}</d:BC_30YEAR>
</m:properties></content></entry>
</feed>`;
    return new Response(xml, { status: 200 });
  }) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

const WACC_PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
  { id: "FY2027", label: "FY2027", start: "2027-01-01", end: "2027-12-31", cls: "forecast" },
];

function waccCommittedFact(lineItemId: string, periodId: string, value: number): Fact {
  return { factId: `spine.${lineItemId}.${periodId}`, status: "committed", lineItemId, periodId, value,
    unit: lineItemId === "diluted_shares" ? { kind: "shares" } : { kind: "currency", code: "USD" },
    provenance: { sourceType: "unified_statements", sourceRefs: [], asOfDate: "2026-08-07" } };
}

/** Six years of daily closes ending today, so beta and the last close both reach the present. */
function waccBars(seed: number, drift: number): DailyBar[] {
  const days = 1600;
  const out: DailyBar[] = [];
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Math.round(days * 7 / 5));
  for (let index = 0; index < days; index += 1) {
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    const c = seed * Math.exp(drift * index + Math.sin(index * 0.7) * 0.01);
    out.push({ t: date.toISOString().slice(0, 10), o: c, h: c, l: c, c, v: 1, vw: c });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

function waccBarRepository(): BarRepository {
  const series = new Map([["AAPL", waccBars(100, 0.0004)], ["SPY", waccBars(300, 0.0002)]]);
  return {
    getBars: async () => [],
    getBarsBetween: async (symbol, _timeframe, from, to) =>
      (series.get(symbol) ?? []).filter((bar) => bar.t >= from && bar.t <= to),
  };
}

function waccHarness() {
  const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  const review = new InMemorySourceReviewStore();
  const deps: FinancialModelToolDeps = { modelStore, insightStore: new InMemoryFilingInsightStore(),
    sourceReviewStore: review, ingestionStore: review,
    barRepository: async () => waccBarRepository() };
  const service = new FinancialModelService(modelStore, "session-1");
  service.createModel({ modelId: "fm-1", ownerAgentId: "agent-1", originSessionId: "session-1", symbol: "AAPL",
    metadata: {}, reportingCurrency: "USD", periods: WACC_PERIODS, preparedStatementRows: [] });
  return { modelStore, deps, service };
}

const WACC_FULL_FACTS: Fact[] = [
  waccCommittedFact("income_tax_expense", "FY2024", 16_000), waccCommittedFact("pretax_income", "FY2024", 100_000),
  waccCommittedFact("income_tax_expense", "FY2025", 16_000), waccCommittedFact("pretax_income", "FY2025", 100_000),
  waccCommittedFact("debt", "FY2024", 90_000), waccCommittedFact("debt", "FY2025", 100_000),
  waccCommittedFact("diluted_shares", "FY2025", 1_000),
  waccCommittedFact("interest_expense", "FY2025", 3_800),
  waccCommittedFact("cash_and_equivalents", "FY2025", 12_000),
];

const waccContext = { agentId: "agent-1", sessionId: "session-1" };

test("the WACC refresh derives the reachable rows, skips an agent-authored row, and lands one wacc_sheet_refreshed revision", async () => {
  stubTreasuryFetch();
  const { deps, modelStore, service } = waccHarness();
  const committed = service.commitSpineFacts("fm-1", 0, {
    facts: WACC_FULL_FACTS.map((fact) => ({ ...fact, status: "staged" as const })),
    historicalPeriodIds: ["FY2024", "FY2025"],
  });
  // The agent has already priced cost_of_debt off a current bond yield before the refresh; the
  // refresh must not clobber it even though it is one of the rows the engine could otherwise derive
  // from interest_expense/debt.
  const beforeRefresh = modelStore.getRevision("fm-1")!;
  const asOfDate = beforeRefresh.snapshot.waccSheet!.asOfDate;
  const withAgentOverride = structuredClone(beforeRefresh.snapshot);
  withAgentOverride.waccSheet = recalculateWaccSheet(setWaccInput(withAgentOverride.waccSheet!, {
    rowId: "cost_of_debt", value: 0.09, sourceType: "search", sourceRefs: ["bond:issue"],
    rationale: "current issue yield", asOfDate,
  }));
  modelStore.commit("fm-1", beforeRefresh.revision, {
    lifecycleStage: withAgentOverride.lifecycleStage, snapshot: withAgentOverride,
    changeSummary: { changes: [], changedSections: [], warningCount: 0, blockerCount: 0 },
    engineVersion: "test", creatingSessionId: "test",
  });
  const revisionBeforeRefresh = modelStore.getRevision("fm-1")!.revision;
  assert.equal(revisionBeforeRefresh, committed.revision + 1);

  const outcome = await refreshWaccSheetFromSpine(deps, service, "fm-1", revisionBeforeRefresh);
  assert.equal(outcome.kind, "refreshed");
  if (outcome.kind !== "refreshed") return;
  assert.equal(outcome.result.revision, revisionBeforeRefresh + 1);

  const sheet = outcome.result.currentWorkbook.waccSheet!;
  const rows = sheet.rows as Array<{ rowId: string; value: number | null; source: string;
    provenance?: { sourceType: string; rationale: string } }>;
  assert.equal(rows.find((row) => row.rowId === "beta")?.value !== null, true);
  assert.equal(rows.find((row) => row.rowId === "equity_value")?.value !== null, true);
  assert.equal(rows.find((row) => row.rowId === "total_debt")?.value, 100_000);
  assert.equal(rows.find((row) => row.rowId === "effective_tax_rate")?.value, 0.16);
  // The agent's override survived the refresh untouched.
  assert.equal(rows.find((row) => row.rowId === "cost_of_debt")?.value, 0.09);

  // The Treasury feed (stubbed above) landed risk_free_rate as a computed, market-sourced row.
  const rfRow = rows.find((row) => row.rowId === "risk_free_rate")!;
  assert.equal(rfRow.value, WACC_TEST_RISK_FREE_RATE);
  assert.equal(rfRow.source, "computed");
  assert.equal(rfRow.provenance?.sourceType, "market");
  assert.match(rfRow.provenance!.rationale, /treasury\.gov daily yield curve/);

  const headers = modelStore.listRevisionHeaders("fm-1");
  const lastHeader = headers.at(-1)!;
  const change = lastHeader.changeSummary.changes.find((entry) => entry.kind === "wacc_sheet_refreshed");
  assert.ok(change, "expected the final revision to carry the wacc_sheet_refreshed change");
  if (change?.kind === "wacc_sheet_refreshed") {
    assert.ok(change.rowIds.includes("beta"));
    assert.ok(change.rowIds.includes("risk_free_rate"), "risk_free_rate should be reported as refreshed");
    assert.ok(!change.rowIds.includes("cost_of_debt"), "cost_of_debt was agent-authored and must not be reported as refreshed");
  }
  restoreFetch();
});

test("an agent-preset risk_free_rate survives the Treasury-feed auto-refresh untouched", async () => {
  stubTreasuryFetch();
  const { deps, modelStore, service } = waccHarness();
  service.commitSpineFacts("fm-1", 0, {
    facts: WACC_FULL_FACTS.map((fact) => ({ ...fact, status: "staged" as const })),
    historicalPeriodIds: ["FY2024", "FY2025"],
  });
  // The agent has already stated a risk-free rate (say, from its own search) before the refresh;
  // the refresh must not clobber it even though the Treasury feed also resolves.
  const beforeRefresh = modelStore.getRevision("fm-1")!;
  const asOfDate = beforeRefresh.snapshot.waccSheet!.asOfDate;
  const withAgentOverride = structuredClone(beforeRefresh.snapshot);
  withAgentOverride.waccSheet = recalculateWaccSheet(setWaccInput(withAgentOverride.waccSheet!, {
    rowId: "risk_free_rate", value: 0.05, sourceType: "search", sourceRefs: ["agent-search:30y"],
    rationale: "agent-sourced 30y yield, predating the feed refresh", asOfDate,
  }));
  modelStore.commit("fm-1", beforeRefresh.revision, {
    lifecycleStage: withAgentOverride.lifecycleStage, snapshot: withAgentOverride,
    changeSummary: { changes: [], changedSections: [], warningCount: 0, blockerCount: 0 },
    engineVersion: "test", creatingSessionId: "test",
  });
  const revisionBeforeRefresh = modelStore.getRevision("fm-1")!.revision;

  const outcome = await refreshWaccSheetFromSpine(deps, service, "fm-1", revisionBeforeRefresh);
  assert.equal(outcome.kind, "refreshed");
  if (outcome.kind !== "refreshed") return;
  const rows = outcome.result.currentWorkbook.waccSheet!.rows as Array<{ rowId: string; value: number | null }>;
  assert.equal(rows.find((row) => row.rowId === "risk_free_rate")?.value, 0.05);
  restoreFetch();
});
test("create returns the coverage baseline without the workbook, which is unmapped filing rows at this revision", async () => {
  const { tools } = run();
  const result = await tools.get("create_financial_model")!.execute({ symbol: "TEST", ingestionRunId: "ing-1" }, { agentId: "owner-1", sessionId: "s1" });
  const data = result.generation_context!.data;

  // The regression this pins: current_workbook rode along here at ~430k characters, and the
  // projection then re-sent it in every later step's context — for rows only unification reads,
  // and it reads them from the store.
  assert.equal(data["current_workbook"], undefined);
  assert.equal(data["warnings"], undefined);
  // What the stage is actually judged on stays.
  assert.ok(data["statement_coverage"]);
  assert.equal(typeof data["staged_row_count"], "number");
  assert.equal(typeof (data["warning_summary"] as { total: number }).total, "number");
  assert.match(result.summary, /source row\(s\) staged/);
  assert.match(result.summary, /get_financial_model/);
});
