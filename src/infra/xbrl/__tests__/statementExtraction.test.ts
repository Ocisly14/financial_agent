import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFilingInsightStore } from "../../filing-insights/store.ts";
import { InMemoryFilingTableStore } from "../filingTableStore.ts";
import { InMemorySourceReviewStore } from "../sourceReviewStore.ts";
import { ArelleAdapterError } from "../arelleAdapter.ts";
import type { PreparedStatementProvider } from "../preparedStatementProvider.ts";
import { runStatementExtraction } from "../statementExtraction.ts";
import { filingTable, PERIODS, REPORT_DATES } from "./curationFixtures.ts";

const TABLES = REPORT_DATES.flatMap((reportDate, index) => ["is", "bs", "cf"]
  .map((prefix) => filingTable({ sourceTableId: `${prefix}${index}`, reportDate,
    statement: prefix === "is" ? "income_statement" : prefix === "bs" ? "balance_sheet" : "cash_flow_statement" })));

function provider(filingTables = TABLES): PreparedStatementProvider {
  return {
    resolve: async () => ({ company: { cik: 1, ticker: "AAPL", title: "Apple" }, reportingCurrency: "USD",
      fiscalYearEnd: "09-27", periods: PERIODS, filings: [] }),
    extract: async () => [{
      filing: { accession: "fixture", form: "10-K", filedAt: REPORT_DATES[1]!, reportDate: REPORT_DATES[1]!,
        primaryDocumentUrl: "https://example.test/fixture.htm" },
      tables: filingTables, calculationRelations: [], negatedConcepts: [], diagnostics: ["arelle_ok"], statements: [],
    }],
    // Insight extraction is out of scope here; failing it exercises the
    // unavailable-insight fallback and keeps the test offline.
    filingDocuments: async () => { throw new Error("offline"); },
  };
}

const request = { symbol: "aapl", historyYears: 2, forecastYears: 2, filingForms: ["10-K"] as Array<"10-K">, };

test("extraction persists every table and deterministically selects complete face statements without an LLM", async () => {
  const tableStore = new InMemoryFilingTableStore();
  const ingestionStore = new InMemorySourceReviewStore();
  const result = await runStatementExtraction({ provider: provider(), ingestionStore, insightStore: new InMemoryFilingInsightStore(),
    generateInsights: async () => [], tableStore }, "agent", request);

  assert.equal(result.status, "ready");
  assert.equal(result.curation?.outcome, "success");
  assert.equal(result.curation?.verification.green, true);
  assert.equal(result.curation?.steps, 0);
  assert.equal(result.curation?.curatedTables, 6);
  assert.equal(tableStore.listTables(result.ingestionRunId, { tier: "all" }).entries.length, 6);
  const ingestion = ingestionStore.getIngestion(result.ingestionRunId)!;
  assert.deepEqual(ingestion.diagnostics, ["arelle_ok"]);
  assert.deepEqual(ingestion.curatedTables?.map((table) => table.sourceTableId).sort(), ["bs0", "bs1", "cf0", "cf1", "is0", "is1"]);
  assert.equal(ingestion.curations?.length, 6);
  assert.equal(ingestion.presentationExtracts?.length, 1);
  const extract = ingestion.presentationExtracts![0]!;
  assert.equal(extract.filing.accession, "fixture");
  assert.deepEqual(Object.keys(extract).sort(), ["calculationRelations", "filing", "negatedConcepts", "statements"]);
});

test("an incomplete deterministic selection is still a ready ingestion carrying its diagnostics", async () => {
  const ingestionStore = new InMemorySourceReviewStore();
  const withoutBalanceSheets = TABLES.filter((table) => !table.sourceTableId.startsWith("bs"));
  const result = await runStatementExtraction({ provider: provider(withoutBalanceSheets), ingestionStore, insightStore: new InMemoryFilingInsightStore(),
    generateInsights: async () => [], tableStore: new InMemoryFilingTableStore(),
  }, "agent", request);

  assert.equal(result.status, "ready");
  assert.equal(result.curation?.outcome, "partial");
  assert.ok(result.diagnostics.some((entry) => entry.includes("missing_face_statement:balance_sheet")));
  assert.deepEqual(ingestionStore.getIngestion(result.ingestionRunId)?.diagnostics, result.diagnostics);
});

test("zero extracted tables is a failed ingestion", async () => {
  const result = await runStatementExtraction({ provider: provider([]), ingestionStore: new InMemorySourceReviewStore(),
    insightStore: new InMemoryFilingInsightStore(), generateInsights: async () => [],
    tableStore: new InMemoryFilingTableStore() }, "agent", request);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "incomplete_financial_statements");
});

// Insight extraction is the only part of an ingestion that spends model calls, and nothing
// downstream requires a populated set — so it has an off switch, and off means the filing
// documents are never even fetched.
test("omitting the insight generator skips the whole insight pass without failing the ingestion", async () => {
  let documentsFetched = 0;
  const counting: PreparedStatementProvider = { ...provider(),
    filingDocuments: async () => { documentsFetched += 1; throw new Error("offline"); } };
  const result = await runStatementExtraction({ provider: counting, ingestionStore: new InMemorySourceReviewStore(),
    insightStore: new InMemoryFilingInsightStore(), tableStore: new InMemoryFilingTableStore() }, "agent", request);

  assert.equal(result.status, "ready");
  assert.equal(documentsFetched, 0, "a disabled insight pass must not fetch filing documents");
  assert.equal(result.filingInsights?.coverage.status, "unavailable");
  assert.deepEqual(result.filingInsights?.coverage.failureCodes, ["filing_insights_disabled"]);
  assert.deepEqual(result.filingInsights?.insights, []);
  // The set still exists, so create_financial_model's filingInsightSetId plumbing is unchanged.
  assert.ok(result.filingInsights?.insightSetId);
});

function failing(error: unknown): PreparedStatementProvider {
  return { ...provider(), extract: async () => { throw error; } };
}

async function extractionFailure(error: unknown) {
  return await runStatementExtraction({ provider: failing(error), ingestionStore: new InMemorySourceReviewStore(),
    insightStore: new InMemoryFilingInsightStore(), generateInsights: async () => [],
    tableStore: new InMemoryFilingTableStore() }, "agent", request);
}

// The agent reads `retryable` as permission to call the tool again. A misconfigured or
// contract-breaking adapter answers identically every time, so re-calling it only burns steps.
test("adapter misconfiguration and protocol breaches are not retryable", async () => {
  for (const code of ["xbrl_runtime_unavailable", "xbrl_protocol_error"] as const) {
    const result = await extractionFailure(new ArelleAdapterError(code, "boom"));
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, code);
    assert.equal(result.error?.retryable, false, `${code} should not be retryable`);
  }
});

test("an adapter timeout or crash stays retryable", async () => {
  for (const code of ["xbrl_timeout", "xbrl_process_failed"] as const) {
    const result = await extractionFailure(new ArelleAdapterError(code, "boom"));
    assert.equal(result.error?.retryable, true, `${code} should be retryable`);
  }
});

test("tables whose requested-period facts were all dropped are persisted but still fail ingestion", async () => {
  const tableStore = new InMemoryFilingTableStore();
  const emptyFacts = TABLES.map((table) => ({ ...table,
    prescreen: { ...table.prescreen, factCount: 0, periodSpan: 0, tier: "weak" as const },
    rows: table.rows.map((row) => ({ ...row, cells: row.cells.map(({ fact: _fact, ...cell }) => cell) })),
  }));
  const result = await runStatementExtraction({ provider: provider(emptyFacts), ingestionStore: new InMemorySourceReviewStore(),
    insightStore: new InMemoryFilingInsightStore(), generateInsights: async () => [], tableStore,
  }, "agent", request);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "incomplete_financial_statements");
  assert.equal(tableStore.listTables(result.ingestionRunId, { tier: "all" }).entries.length, emptyFacts.length);
});
