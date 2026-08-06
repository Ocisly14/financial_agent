import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { InMemoryFilingTableStore } from "../../../infra/xbrl/filingTableStore.ts";
import type { SourceReviewArtifact } from "../../../infra/xbrl/sourceReviewStore.ts";
import { runHistoricalMappingLoop } from "../historicalMappingLoop.ts";

const finalProposal = { rationale: "mapped", payload: { selectedHistoricalPeriodIds: ["FY2025"], decisions: [],
  categoryLineItems: [], statementMappingPlans: [], categoryGroups: [] }, sourceRefs: ["fact-1"] };

function source(): SourceReviewArtifact {
  const row = { sourceLineItemId: "source.income.revenue", statement: "income_statement", label: "Revenue",
    unit: { kind: "currency", code: "USD" }, order: 1, conceptQName: "us-gaap:Revenue", depth: 0,
    dimensionSignature: "", dimensions: [], presentationAccessions: ["a"], sourceTableId: "table-1" };
  return { ingestionRunId: "run", filings: [], facts: [{ factId: "fact-1", status: "staged", lineItemId: row.sourceLineItemId,
    periodId: "FY2025", value: 100, unit: row.unit, provenance: { sourceType: "filing_xbrl", sourceRefs: ["#f"], asOfDate: "2025-01-01" } }],
    statementViews: {
      income_statement: { candidate: { periods: [], rows: [row] }, filingPresentations: [] },
      balance_sheet: { candidate: { periods: [], rows: [] }, filingPresentations: [] },
      cash_flow_statement: { candidate: { periods: [], rows: [] }, filingPresentations: [] },
    }, curatedTables: [], curations: [], dimensionalDisclosures: [],
    coverage: { requestedPeriodIds: ["FY2025"], statements: [], issues: [] } } as unknown as SourceReviewArtifact;
}

const projection = { subagent: "historical_mapping" as const, modelId: "m1", baseRevision: 1,
  lifecycleStage: "draft" as const, workbook: { periods: [], sections: {}, diagnostics: [] }, filingInsights: null };

test("historical mapping injects all row/column titles once and retains the complete tool transcript", async () => {
  const prompts: string[] = [];
  const replies = [
    { action: "call_tool", calls: [{ tool: "get_statement_rows", input: { sourceLineItemIds: ["source.income.revenue"] } }] },
    { action: "call_tool", calls: [{ tool: "get_statement_rows", input: { sourceLineItemIds: ["source.income.revenue"] } }] },
    finalProposal,
  ];
  const provider: LlmProvider = { name: "scripted", generate: async (messages) => {
    prompts.push(messages.map((message) => message.content).join("\n"));
    return { text: JSON.stringify(replies.shift()), metrics: { tokens_in: 1, tokens_out: 1, ms: 0,
      model_class: "MEDIUM" as const, provider: "scripted" } };
  } };
  const result = await runHistoricalMappingLoop({ modelRouter: new ModelRouter(provider), projection, sourceReview: source(),
    tableStore: new InMemoryFilingTableStore(), task: "map", systemPrompt: "system", maxSteps: 3 });
  assert.deepEqual(result, finalProposal);
  assert.match(prompts[0]!, /"tool":"<allowed-tool-name>","input":\{\}/);
  assert.doesNotMatch(prompts[0]!, /args \(\*/);
  assert.match(prompts[0]!, /BASE CONTEXT — ROW\/COLUMN TITLES/);
  assert.match(prompts[0]!, /source\.income\.revenue/);
  assert.equal((prompts[2]!.match(/\[TOOL RESULTS\]/g) ?? []).length, 2);
});

test("historical mapping rejects nonstandard toolName/args rather than adding a second protocol", async () => {
  const provider: LlmProvider = { name: "scripted", generate: async () => ({
    text: JSON.stringify({ action: "call_tool", calls: [{ toolName: "list_statement_rows", args: {} }] }),
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM" as const, provider: "scripted" },
  }) };
  await assert.rejects(() => runHistoricalMappingLoop({ modelRouter: new ModelRouter(provider), projection, sourceReview: source(),
    tableStore: new InMemoryFilingTableStore(), task: "map", systemPrompt: "system", maxSteps: 1 }),
  /expected calls\[\]\.tool and calls\[\]\.input/);
});
