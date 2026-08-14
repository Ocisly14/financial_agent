import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore, type SourceReviewArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { InMemoryFilingTableStore } from "../../../src/infra/xbrl/filingTableStore.ts";
import { ModelRouter, type LlmProvider } from "../../../src/infra/llm/provider.ts";
import { fact, filing, node, period, statement } from "../../../src/infra/xbrl/__tests__/spineFixture.ts";
import type { FilingTable } from "../../../src/infra/xbrl/tableTypes.ts";
import type { FilingTableFactOccurrence, XbrlDimension } from "../../../src/infra/xbrl/types.ts";
import { McpToolRegistry } from "../../toolRegistry.ts";
import { SessionRegistry } from "../../../src/framework/sessionState.ts";
import { SubagentRuntime } from "../../../src/framework/subagent.ts";
import { createSubagentRegistry } from "../../../src/agent/subagents/registerSubagents.ts";
import { createDcfSubagentTool } from "../dcfSubagentTool.ts";
import type { FinancialModelToolDeps } from "../financialModelTools.ts";
import { REQUIRED_MAPPING_IDS } from "../../../src/financial-model/skeleton.ts";

function scripted(responses: string[]): ModelRouter {
  let call = 0;
  const provider: LlmProvider = { name: "scripted", generate: async () => (
    { text: responses[Math.min(call++, responses.length - 1)]!,
      metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  return new ModelRouter(provider);
}

const PERIODS = [period("FY2025", 2025)];
const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
  node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e6)]),
])])];
const loadCall = JSON.stringify({ tool: "load_concept_inventory", input: { symbol: "TEST" } });
const exploreDone = JSON.stringify({ done: true });
const SEG_AXIS = "us-gaap:StatementBusinessSegmentsAxis";

function dim(member: string, memberLabel: string): XbrlDimension {
  return { axisQName: SEG_AXIS, axisLabel: "Segments", memberQName: member, memberLabel };
}
function dimFact(concept: string, periodId: string, value: number, dims: XbrlDimension[], htmlOrder = 1): FilingTableFactOccurrence {
  return { occurrenceId: `${concept}|${periodId}|${dims.map((d) => d.memberQName).join(",")}|${htmlOrder}`,
    conceptQName: concept, conceptLabel: concept, htmlOrder, contextId: "c", periodId, value,
    unit: { kind: "currency", code: "USD" }, decimals: -6, dimensions: dims, sourceAnchor: "#f" };
}
function segTableFixture(): FilingTable {
  const facts = [
    dimFact("us-gaap:Revenues", "FY2025", 60e6, [dim("x:ProductsMember", "Products")], 1),
    dimFact("us-gaap:Revenues", "FY2025", 40e6, [dim("x:ServicesMember", "Services")], 2),
  ];
  return { sourceTableId: "acc-2025-t1", accession: "acc-2025", form: "10-K", filedAt: "2026-01-30", reportDate: "2026-01-30",
    heading: "Segment information", htmlOrder: 5, sourceAnchor: "#t1",
    prescreen: { tier: "weak", presentationOverlap: 0, dimensionlessRatio: 0, periodSpan: 1, factCount: facts.length },
    suggestedStatements: [], columns: [],
    rows: [{ order: 1, labelText: "Revenue", indentLevel: 0,
      cells: facts.map((f, i) => ({ columnIndex: i + 1, text: String(f.value), fact: f })) }] };
}

const decisionWithBreakdown = JSON.stringify({ rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales",
  components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }], rationale: "single top-line concept",
  breakdowns: [{ axisQName: SEG_AXIS, conceptQName: "us-gaap:Revenues", rationale: "product mix" }] }] });
const decisionWithoutBreakdown = JSON.stringify({ rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales",
  components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }], rationale: "single top-line concept" }] });

function review(overrides: Partial<SourceReviewArtifact> = {}): SourceReviewArtifact {
  const view = { candidate: { periods: PERIODS, rows: [] }, filingPresentations: [] };
  return {
    ingestionRunId: "ing-1", coverage: { requestedPeriodIds: [], statements: [], issues: [] },
    dimensionalDisclosures: [], curatedTables: [], curations: [], filings: [], facts: [],
    presentationExtracts: filings as never,
    statementViews: { income_statement: view, balance_sheet: view, cash_flow_statement: view } as never,
    ...overrides,
  };
}

function setup(): { financial: FinancialModelToolDeps; modelId: string; sourceReviewStore: InMemorySourceReviewStore } {
  const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  const sourceReviewStore = new InMemorySourceReviewStore();
  const service = new FinancialModelService(modelStore, "session-1");
  const modelId = "fm-1";
  service.createModel({ modelId, ownerAgentId: "agent-1", originSessionId: "session-1", symbol: "TEST",
    metadata: {}, reportingCurrency: "USD", periods: PERIODS, preparedStatementRows: [] });
  return { modelId, sourceReviewStore,
    financial: { modelStore, sourceReviewStore, ingestionStore: sourceReviewStore,
      insightStore: new InMemoryFilingInsightStore() } };
}

/** The tool hands work to the shared SubagentRuntime now, so a test drives it with scripted tool
 *  calls rather than scripted text. */
function harness(calls: Array<{ name: string; input: object }>) {
  let step = 0;
  const provider: LlmProvider = { name: "scripted", generate: async () => ({
    text: "note", toolCalls: [{ id: `t${step}`, ...calls[Math.min(step++, calls.length - 1)]! }] as never,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  const sessions = new SessionRegistry();
  return { subagentRuntime: new SubagentRuntime(new ModelRouter(provider), new McpToolRegistry()),
    subagents: createSubagentRegistry(), sessions };
}

async function session(sessions: SessionRegistry, sessionId: string): Promise<void> {
  const state = await sessions.getOrCreate(sessionId);
  state.beginTurn("go");
}

test("statement_unification reports breakdown counts in summary and generation_context when a tableStore is wired", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review());
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [segTableFixture()]);
  const runner = harness([{ name: "load_concept_inventory", input: { symbol: "TEST" } },
    { name: "submit_unification_decision", input: { decision: JSON.parse(decisionWithBreakdown) } },
    { name: "finish", input: { summary: "done" } }]);
  await session(runner.sessions, "s1");
  const tool = createDcfSubagentTool({ ...runner, financial: { ...financial, tableStore } });
  const result = await tool.execute({ subagent: "statement_unification", modelId, task: "Unify TEST's filings." },
    { agentId: "agent-1", sessionId: "s1" });
  assert.equal(result.error, undefined);
  assert.match(result.summary, /2 breakdown row\(s\) on 1 axis\/axes/);
  const data = result.generation_context!.data as { unifiedStatements: { breakdownRows: number } };
  assert.equal(data.unifiedStatements.breakdownRows, 2);
});

test("statement_unification behaves as before when deps has no tableStore", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review());
  const runner = harness([{ name: "load_concept_inventory", input: { symbol: "TEST" } },
    { name: "submit_unification_decision", input: { decision: JSON.parse(decisionWithoutBreakdown) } },
    { name: "finish", input: { summary: "done" } }]);
  await session(runner.sessions, "s1");
  const tool = createDcfSubagentTool({ ...runner, financial });
  const result = await tool.execute({ subagent: "statement_unification", modelId, task: "Unify TEST's filings." },
    { agentId: "agent-1", sessionId: "s1" });
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.summary, /breakdown row/);
  const data = result.generation_context!.data as { unifiedStatements: { breakdownRows: number } };
  assert.equal(data.unifiedStatements.breakdownRows, 0);
});

// Regression for an Important finding: a breakdown row's label lives in unifiedStatements.breakdownRows,
// not .rows, so the label lookup in dcfSubagentTool.ts must search both — otherwise the label falls
// back to the rowId slug and the workbook shows e.g. "net_sales.statementbusinesssegments.products"
// instead of "Products".
const loadUnifiedCall = JSON.stringify({ tool: "load_unified_statements", input: { symbol: "TEST" } });
// Every REQUIRED spine id besides revenue.total must be mapped or gap-declared for the decision to be
// clean in one round; their content is irrelevant to this test.
const OTHER_REQUIRED_IDS = [...REQUIRED_MAPPING_IDS].filter((targetId) => targetId !== "revenue.total");
const spineDecisionWithBreakdownDetail = JSON.stringify({
  mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "top line" }],
  detailRows: [{ parentTargetId: "revenue.total", rowId: "net_sales.seg.products", rationale: "product mix" }],
  excluded: [],
  spineGaps: OTHER_REQUIRED_IDS.map((targetId) => ({ targetId, reason: "not modeled in this test" })),
});

test("spine_mapping labels a breakdown detail row from breakdownRows, not the rowId slug", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review({
    unifiedStatements: {
      periods: ["FY2025"],
      rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales", rationale: "",
        values: { FY2025: 100e6 } }],
      supplementalRows: [], excluded: [], restatements: [], rollupBreaks: [], findings: [], unresolvedFindings: [],
      facts: [{ factId: "unified.income_statement.net_sales.FY2025", status: "staged",
        lineItemId: "unified.income_statement.net_sales", periodId: "FY2025", value: 100e6,
        unit: { kind: "currency", code: "USD" },
        provenance: { sourceType: "filing", sourceRefs: [], asOfDate: "2026-01-30" } }],
      breakdownRows: [{ rowId: "net_sales.seg.products", parentRowId: "net_sales",
        axisQName: SEG_AXIS, memberQName: "x:ProductsMember", label: "Products",
        unit: { kind: "currency", code: "USD" }, values: { FY2025: 60e6 }, rationale: "product mix",
        asOfDate: "2026-01-30" }],
    } as never,
  }));
  const runner = harness([{ name: "load_unified_statements", input: { symbol: "TEST" } },
    { name: "submit_spine_decision", input: { decision: JSON.parse(spineDecisionWithBreakdownDetail) } },
    { name: "finish", input: { summary: "done" } }]);
  await session(runner.sessions, "s1");
  const tool = createDcfSubagentTool({ ...runner, financial });
  const result = await tool.execute({ subagent: "spine_mapping", modelId, task: "Map TEST's unified statements." },
    { agentId: "agent-1", sessionId: "s1" });
  assert.equal(result.error, undefined, result.summary);

  const service = new FinancialModelService(financial.modelStore, "s1");
  const view = service.getModel(modelId);
  assert.ok("currentWorkbook" in view);
  const stream = view.currentWorkbook.sections.revenue.find((row) => row.lineItemId === "revenue.products");
  assert.equal(stream?.label, "Products", JSON.stringify(view.currentWorkbook.sections.revenue.map((r) => r.lineItemId)));
});
