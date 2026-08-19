import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { ArelleAdapterError } from "../../../src/infra/xbrl/arelleAdapter.ts";
import { InMemoryFilingTableStore } from "../../../src/infra/xbrl/filingTableStore.ts";
import { InMemorySourceReviewStore } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import type { PreparedStatementProvider } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import type { FilingIdentity } from "../../../src/infra/xbrl/types.ts";
import { filingTable, PERIODS, REPORT_DATES } from "../../../src/infra/xbrl/__tests__/curationFixtures.ts";
import type { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { createStatementExtractionTool, STATEMENT_EXTRACTION_TOOL } from "../statementExtractionTool.ts";
import type { FinancialModelToolDeps } from "../financialModelTools.ts";

const TABLES = REPORT_DATES.flatMap((reportDate, index) => ["is", "bs", "cf"]
  .map((prefix) => filingTable({ sourceTableId: `${prefix}${index}`, reportDate,
    statement: prefix === "is" ? "income_statement" : prefix === "bs" ? "balance_sheet" : "cash_flow_statement" })));

const FILING: FilingIdentity = { accession: "fixture", form: "10-K", filedAt: REPORT_DATES[1]!,
  reportDate: REPORT_DATES[1]!, primaryDocumentUrl: "https://example.test/fixture.htm" };

function provider(tables = TABLES): PreparedStatementProvider {
  return {
    resolve: async () => ({ company: { cik: 1, ticker: "AAPL", title: "Apple" }, reportingCurrency: "USD",
      fiscalYearEnd: "09-27", periods: PERIODS, filings: [FILING] }),
    extract: async () => [{ filing: FILING, tables, calculationRelations: [], negatedConcepts: [], diagnostics: [], statements: [] }],
    filingDocuments: async () => { throw new Error("offline"); },
  };
}

/** The router must never be reached: extraction is deterministic apart from the insight pass. */
const forbiddenRouter = { generate: async () => { throw new Error("statement extraction must not call a model"); } } as unknown as ModelRouter;

function fixture(tables = TABLES, override?: PreparedStatementProvider) {
  const store = new InMemorySourceReviewStore();
  const insightStore = new InMemoryFilingInsightStore();
  const financial: FinancialModelToolDeps = {
    modelStore: new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec),
    insightStore, sourceReviewStore: store, ingestionStore: store,
  };
  const tool = createStatementExtractionTool({ modelRouter: forbiddenRouter, financial, provider: override ?? provider(tables),
    tableStore: new InMemoryFilingTableStore(), generateInsights: async () => [] });
  return { tool, store, insightStore };
}

/** The same fixture with no explicit generator, so the env flag decides. */
function unflaggedFixture() {
  const store = new InMemorySourceReviewStore();
  const insightStore = new InMemoryFilingInsightStore();
  const financial: FinancialModelToolDeps = {
    modelStore: new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec),
    insightStore, sourceReviewStore: store, ingestionStore: store,
  };
  const tool = createStatementExtractionTool({ modelRouter: forbiddenRouter, financial, provider: provider(),
    tableStore: new InMemoryFilingTableStore() });
  return { tool, insightStore };
}

const context = { tenantId: "agent-1", sessionId: "session-1" } as never;

test("the extraction tool is a plain tool: a symbol in, an ingestion run and coverage statistics out", async () => {
  const { tool, store } = fixture();
  assert.equal(tool.name, STATEMENT_EXTRACTION_TOOL);
  const result = await tool.execute({ symbol: "aapl", historyYears: 3, forecastYears: 3 }, context);

  assert.equal(result.error, undefined);
  const data = result.generation_context!.data as { extraction: { ingestionRunId: string; accessions: string[]; curationOutcome: string } };
  assert.equal(data.extraction.curationOutcome, "success");
  assert.deepEqual(data.extraction.accessions, ["fixture"]);
  // The run is in the store, ready for create_financial_model.
  assert.equal(store.getIngestion(data.extraction.ingestionRunId)?.symbol, "AAPL");
  // Statistics, not statements: the rows stay in the store rather than in the parent's context.
  assert.ok(result.summary.includes("income_statement 2/2"), result.summary);
  assert.ok(!JSON.stringify(data).includes("sourceLineItemId"), "extraction must not return statement rows");
});

test("a symbol whose filings yield no facts fails the run instead of returning an empty ingestion", async () => {
  const { tool } = fixture([]);
  const result = await tool.execute({ symbol: "aapl" }, context);
  assert.equal(result.error?.code, "incomplete_financial_statements");
});

test("filing insights are off unless FILING_INSIGHTS_ENABLED opts in", async () => {
  const previous = process.env["FILING_INSIGHTS_ENABLED"];
  delete process.env["FILING_INSIGHTS_ENABLED"];
  try {
    const { tool, insightStore } = unflaggedFixture();
    const result = await tool.execute({ symbol: "aapl" }, context);

    assert.equal(result.error, undefined);
    const { extraction } = result.generation_context!.data as { extraction: { filingInsightSetId: string } };
    // The set is still created and still linked, so create_financial_model is unaffected.
    assert.deepEqual(insightStore.getContext(extraction.filingInsightSetId)?.coverage.failureCodes, ["filing_insights_disabled"]);
  } finally {
    if (previous === undefined) delete process.env["FILING_INSIGHTS_ENABLED"];
    else process.env["FILING_INSIGHTS_ENABLED"] = previous;
  }
});

// The summary is all the agent reads. Left bare, "Invalid adapter JSON" looks transient and the
// agent re-calls the tool until its step budget is gone.
test("a non-retryable adapter failure tells the agent in the summary to stop calling the tool", async () => {
  const { tool } = fixture(TABLES, { ...provider(),
    extract: async () => { throw new ArelleAdapterError("xbrl_protocol_error", "Invalid adapter JSON: SyntaxError"); } });
  const result = await tool.execute({ symbol: "aapl" }, context);

  assert.equal(result.error?.code, "xbrl_protocol_error");
  assert.ok(result.summary.includes("Invalid adapter JSON"), result.summary);
  assert.match(result.summary, /do not retry/i);
  assert.equal((result.generation_context!.data as { extraction: { retryable: boolean } }).extraction.retryable, false);
});

test("a retryable adapter failure leaves the retry decision to the agent", async () => {
  const { tool } = fixture(TABLES, { ...provider(),
    extract: async () => { throw new ArelleAdapterError("xbrl_timeout", "Arelle adapter exceeded 120000ms"); } });
  const result = await tool.execute({ symbol: "aapl" }, context);

  assert.equal(result.error?.code, "xbrl_timeout");
  assert.doesNotMatch(result.summary, /do not retry/i);
  assert.equal((result.generation_context!.data as { extraction: { retryable: boolean } }).extraction.retryable, true);
});

test("history years outside 3..10 are rejected before Arelle is invoked", async () => {
  const { tool } = fixture();
  const result = await tool.execute({ symbol: "aapl", historyYears: 42 }, context);
  assert.equal(result.error?.code, "invalid_tool_input");
});
