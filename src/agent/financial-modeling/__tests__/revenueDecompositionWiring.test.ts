import assert from "node:assert/strict";
import test from "node:test";
import { DcfSubagentRegistry } from "../subagents.ts";
import { createDcfSubagentTool } from "../../../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { runMappingReviewLoop } from "../mappingReviewLoop.ts";
import { createFinancialModelTools, type FinancialModelToolDeps } from "../../../../mcp_tools/financial-model/financialModelTools.ts";
import { InMemoryDecompositionStore } from "../../../infra/xbrl/decompositionStore.ts";
import { InMemoryFilingTableStore } from "../../../infra/xbrl/filingTableStore.ts";
import { InMemoryFilingInsightStore } from "../../../infra/filing-insights/store.ts";
import { InMemorySourceReviewStore } from "../../../infra/xbrl/sourceReviewStore.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { mintTableFactId } from "../../../infra/xbrl/decompositionTypes.ts";
import { shortHash } from "../../../infra/xbrl/decompositionAnalysis.ts";
import { filingTable } from "./curationFixtures.ts";
import { FinancialModelService } from "../../../financial-model/service.ts";
import { InMemoryModelStore } from "../../../financial-model/store.ts";
import { financialModelSnapshotCodec } from "../../../financial-model/snapshotCodec.ts";
import type { FinancialModelSnapshot } from "../../../financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../../financial-model/views.ts";
import type { SourceReviewArtifact } from "../../../infra/xbrl/sourceReviewStore.ts";
import type { FilingTable } from "../../../infra/xbrl/tableTypes.ts";

test("decomposition kinds are registered as private read-only subagents", () => {
  const registry = new DcfSubagentRegistry();
  assert.equal(registry.get("filing_decomposition").authority, "read_only_proposal");
  assert.equal(registry.get("decomposition_reduce").authority, "read_only_proposal");
  assert.match(registry.get("filing_decomposition").prompt, /Never write a source number/);
  assert.match(registry.get("decomposition_reduce").prompt, /merge_children/);
});

/** Face fact valued 205 so children 100+101 leave residual 4 ~ 2%. */
function artifact(table: FilingTable): SourceReviewArtifact {
  const period = { id: "FY2025", label: "FY2025", start: "2024-09-29", end: "2025-09-27", cls: "actual" as const };
  return {
    ingestionRunId: "run1",
    filings: [{ accession: table.accession, form: "10-K", filedAt: table.filedAt, reportDate: table.reportDate, primaryDocumentUrl: "https://example.test/doc" }],
    facts: [
      { factId: "xbrl-face", status: "staged", lineItemId: "source.income_statement.revenue", periodId: "FY2025", value: 205,
        unit: { kind: "currency", code: "USD" }, provenance: { sourceType: "filing_xbrl", sourceRefs: ["#rev"], asOfDate: "2025-10-01" } },
    ],
    statementViews: { income_statement: { candidate: { periods: [period], rows: [
      { sourceLineItemId: "source.income_statement.revenue", statement: "income_statement", label: "Net sales", unit: { kind: "currency", code: "USD" },
        order: 1, conceptQName: "us-gaap:Revenues", dimensionSignature: "", dimensions: [], depth: 0, presentationAccessions: [] },
    ] }, filingPresentations: [] },
      balance_sheet: { candidate: { periods: [period], rows: [] }, filingPresentations: [] },
      cash_flow_statement: { candidate: { periods: [period], rows: [] }, filingPresentations: [] } },
    coverage: { requestedPeriodIds: ["FY2025"], statements: [], issues: [] },
    dimensionalDisclosures: [], curatedTables: [], curations: [],
  } as unknown as SourceReviewArtifact;
}

const OWNER = { agentId: "owner-1", sessionId: "s1" };

/** apply_revenue_decomposition now premaps into a real workbook, so the fixture needs a real model. */
function ownedModelStore(modelId: string): FinancialModelToolDeps["modelStore"] {
  const store = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  new FinancialModelService(store, OWNER.sessionId).createModel({ modelId, ownerAgentId: OWNER.agentId,
    originSessionId: OWNER.sessionId, symbol: "TEST", metadata: {}, reportingCurrency: "USD",
    periods: [{ id: "FY2025", label: "FY2025", start: "2024-09-29", end: "2025-09-27", cls: "actual" }],
    preparedStatementRows: [] });
  return store;
}

function fixture() {
  const tableStore = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1", heading: "Net sales by product", rowLabels: ["iPhone", "Mac"] });
  for (const row of table.rows) for (const cell of row.cells) if (cell.fact) cell.fact.conceptQName = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
  tableStore.saveTables("run1", [table]);
  const sourceReviewStore = new InMemorySourceReviewStore();
  sourceReviewStore.save("m1", artifact(table));
  const financial: FinancialModelToolDeps = { modelStore: ownedModelStore("m1"), insightStore: new InMemoryFilingInsightStore(),
    sourceReviewStore, ingestionStore: sourceReviewStore, decompositionStore: new InMemoryDecompositionStore() };
  const candidateSchemeId = `cs-${shortHash("source.income_statement.revenue|presentation-only|by product")}`;
  const factId = (order: number) => mintTableFactId(table.accession, "seg-1", order, "FY2025", "c-FY2025");
  const responses = [
    JSON.stringify({ action: "call_tool", calls: [{ tool: "get_table_facts", input: { sourceTableId: "seg-1", rowOrders: [1, 2] } }] }),
    JSON.stringify({ rationale: "product split", sourceRefs: [], payload: { schemes: [{ schemeId: "s1", label: "by product",
      axisHint: "presentation-only", targetSourceLineItemId: "source.income_statement.revenue", children: [
        { label: "iPhone", factRefs: [{ factId: factId(1), periodId: "FY2025" }] },
        { label: "Mac", factRefs: [{ factId: factId(2), periodId: "FY2025" }] }] }] } }),
    JSON.stringify({ rationale: "only one scheme", sourceRefs: [], payload: { ranked: [candidateSchemeId], driverSchemeId: candidateSchemeId } }),
  ];
  let call = 0;
  const provider: LlmProvider = { name: "scripted", generate: async () => ({ text: responses[Math.min(call++, responses.length - 1)]!,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM" as const, provider: "scripted" } }) };
  const tool = createDcfSubagentTool({ modelRouter: new ModelRouter(provider), financial, tableStore });
  const tools = new Map(createFinancialModelTools(financial).map((entry) => [entry.name, entry]));
  return { financial, sourceReviewStore, tableStore, tool, tools, candidateSchemeId };
}

test("run_dcf_subagent runs the revenue_decomposition pipeline and apply_revenue_decomposition materializes it", async () => {
  const { sourceReviewStore, tool, tools, candidateSchemeId } = fixture();

  const run = await tool.execute({ subagent: "revenue_decomposition", modelId: "m1", task: "decompose" }, OWNER);
  assert.equal(run.error, undefined);
  assert.match(run.summary, new RegExp(`ranked 1 scheme\\(s\\); driver ${candidateSchemeId}`));
  const decomposition = run.generation_context!.data["decomposition"] as Record<string, unknown>;
  assert.equal(decomposition["driverSchemeId"], candidateSchemeId);
  const candidates = decomposition["candidates"] as Array<Record<string, unknown>>;
  assert.equal(candidates.length, 1);
  assert.equal("cells" in ((candidates[0]!["children"] as Array<object>)[0]!), false, "summaries carry no cell values");

  assert.ok(tools.has("apply_revenue_decomposition"));
  const applied = await tools.get("apply_revenue_decomposition")!.execute({ modelId: "m1",
    acceptedSchemeIds: [candidateSchemeId], driverSchemeId: candidateSchemeId, rationale: "product split is the driver" }, OWNER);
  assert.equal(applied.error, undefined);

  const saved = sourceReviewStore.get("m1")!;
  assert.equal(saved.decomposition!.schemes[0]!.driver, true);
  const labels = saved.statementViews.income_statement.candidate.rows.map((row) => row.label);
  for (const label of ["iPhone", "Mac"]) assert.ok(labels.includes(label), `child row ${label} is present`);
});

test("apply_revenue_decomposition rejects a driver outside the accepted set", async () => {
  const { tools, candidateSchemeId } = fixture();
  const applied = await tools.get("apply_revenue_decomposition")!.execute({ modelId: "m1",
    acceptedSchemeIds: [candidateSchemeId], driverSchemeId: "cs-other", rationale: "mismatch" }, OWNER);
  assert.equal(applied.error?.code, "invalid_driver_scheme");
});

test("mapping_review base context carries the accepted decomposition summary", async () => {
  const { sourceReviewStore, tableStore, tool, tools, candidateSchemeId } = fixture();
  await tool.execute({ subagent: "revenue_decomposition", modelId: "m1", task: "decompose" }, OWNER);
  await tools.get("apply_revenue_decomposition")!.execute({ modelId: "m1", acceptedSchemeIds: [candidateSchemeId],
    driverSchemeId: candidateSchemeId, rationale: "product split is the driver" }, OWNER);

  const prompts: string[] = [];
  const provider: LlmProvider = { name: "scripted", generate: async (messages) => {
    prompts.push(messages.map((message) => message.content).join("\n"));
    return { text: JSON.stringify({ rationale: "mapped", payload: { selectedHistoricalPeriodIds: ["FY2025"], decisions: [],
      categoryLineItems: [], statementMappingPlans: [], categoryGroups: [] }, sourceRefs: [] }),
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM" as const, provider: "scripted" } };
  } };
  await runMappingReviewLoop({ modelRouter: new ModelRouter(provider),
    projection: { subagent: "mapping_review", modelId: "m1", baseRevision: 1, lifecycleStage: "draft",
      workbook: { periods: [], sections: {}, diagnostics: [] }, filingInsights: null },
    sourceReview: sourceReviewStore.get("m1")!, tableStore, task: "map", systemPrompt: "system", maxSteps: 1 });
  assert.match(prompts[0]!, /"decomposition":/);
  assert.match(prompts[0]!, new RegExp(`"candidateSchemeId":"${candidateSchemeId}"`));
  assert.match(prompts[0]!, /"driver":true/);
});
