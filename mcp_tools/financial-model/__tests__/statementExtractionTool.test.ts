import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemoryFilingTableStore } from "../../../src/infra/xbrl/filingTableStore.ts";
import { InMemorySourceReviewStore } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import type { PreparedStatementProvider } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import type { FilingIdentity } from "../../../src/infra/xbrl/types.ts";
import { filingTable, PERIODS, REPORT_DATES } from "../../../src/infra/xbrl/__tests__/curationFixtures.ts";
import type { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { InMemoryWaccParameterStore } from "../../../src/financial-model/waccStore.ts";
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

function fixture(tables = TABLES) {
  const store = new InMemorySourceReviewStore();
  const financial: FinancialModelToolDeps = {
    modelStore: new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec),
    insightStore: new InMemoryFilingInsightStore(), sourceReviewStore: store, ingestionStore: store,
    waccParameterStore: new InMemoryWaccParameterStore(),
  };
  const tool = createStatementExtractionTool({ modelRouter: forbiddenRouter, financial, provider: provider(tables),
    tableStore: new InMemoryFilingTableStore(), generateInsights: async () => [] });
  return { tool, store };
}

const context = { agentId: "agent-1", sessionId: "session-1" } as never;

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

test("history years outside 3..10 are rejected before Arelle is invoked", async () => {
  const { tool } = fixture();
  const result = await tool.execute({ symbol: "aapl", historyYears: 42 }, context);
  assert.equal(result.error?.code, "invalid_tool_input");
});
