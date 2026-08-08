import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { fact, filing, node, period, statement } from "../../../infra/xbrl/__tests__/spineFixture.ts";
import { DcfSubagentRegistry } from "../subagents.ts";
import type { LoopTool } from "../../../../mcp_tools/financial-model/mappingSubagentTools.ts";
import type { FilingTable } from "../../../infra/xbrl/tableTypes.ts";
import type { FilingTableFactOccurrence, XbrlDimension } from "../../../infra/xbrl/types.ts";
import { runStatementUnificationAgent } from "../statementUnificationAgent.ts";

function scripted(responses: string[]): { router: ModelRouter; prompts: () => string[] } {
  let call = 0;
  const seen: string[] = [];
  const provider: LlmProvider = { name: "scripted", generate: async (messages) => {
    seen.push(messages.map((m) => m.content).join("\n---\n"));
    return { text: responses[Math.min(call++, responses.length - 1)]!,
      metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } };
  } };
  return { router: new ModelRouter(provider), prompts: () => seen };
}

const periods = [period("FY2025", 2025)];
const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
  node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e6)]),
])])];
// The subagent's first turn is always the load call, so every script starts with one.
const task = "Unify TSLA's extracted filings into multi-year statements.";
const loadCall = JSON.stringify({ tool: "load_concept_inventory", input: { symbol: "TSLA" } });
function loader(): { tools: Map<string, LoopTool> } {
  const tool: LoopTool = { name: "load_concept_inventory", category: "non_trading", description: "stub",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
    execute: () => ({ symbol: "TSLA" } as never) };
  return { tools: new Map([[tool.name, tool]]) };
}

// -- Dimension exploration fixtures (minimal fixture, following dimensionInventory.test.ts's convention). --
const exploreDone = JSON.stringify({ done: true });
const SEG_AXIS = "us-gaap:StatementBusinessSegmentsAxis";
function stubTool(name: string): LoopTool {
  return { name, category: "non_trading", description: "stub",
    inputSchema: { type: "object", properties: {} }, execute: () => ({} as never) };
}
function loaderWithExploration(): { tools: Map<string, LoopTool> } {
  const { tools } = loader();
  return { tools: new Map([...tools, ["list_dimension_axes", stubTool("list_dimension_axes")]]) };
}
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

const systemPrompt = new DcfSubagentRegistry().get("statement_unification").prompt;
const good = JSON.stringify({ rows: [{ rowId: "revenues", statement: "income_statement", label: "Revenues",
  components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }],
  rationale: "single top-line concept" }] });

test("a clean decision produces artifact facts and empty unresolved findings in one run", async () => {
  const { router } = scripted([loadCall, good]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, filings, requestedPeriods: periods });
  assert.deepEqual(run.artifact.unresolvedFindings, []);
  assert.equal(run.artifact.facts.length, 1);
  assert.equal(run.artifact.facts[0]!.lineItemId, "unified.income_statement.revenues");
  assert.equal(run.artifact.facts[0]!.value, 100e6);
});

test("a re-run is asked for a patch over the previous decision, not a fresh one", async () => {
  // Run 1 leaves the only inventory cell unconsumed; run 2 corrects it by adding one row.
  const empty = JSON.stringify({ rows: [] });
  const patch = JSON.stringify({ upsertRows: [{ rowId: "revenues", statement: "income_statement",
    label: "Revenues", components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }], rationale: "added" }] });
  const { router, prompts } = scripted([loadCall, empty, patch]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, filings, requestedPeriods: periods });
  assert.deepEqual(run.artifact.unresolvedFindings, []);
  assert.equal(run.decision.rows.length, 1);
  assert.equal(run.artifact.facts[0]!.value, 100e6);
  // The re-run sees what it previously decided, the findings against it, and is told to correct.
  assert.ok(prompts()[2]!.includes("[YOUR PREVIOUS DECISION]"), prompts()[2]);
  assert.ok(prompts()[2]!.includes("[FINDINGS AGAINST IT]"), prompts()[2]);
  assert.ok(prompts()[2]!.includes("CORRECTING an existing decision"), prompts()[2]);
});

test("rows the patch does not mention survive the re-run untouched", async () => {
  const three = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e6)]),
    node(1, null, "us-gaap:CostOfRevenue", "Cost of revenue", [fact("FY2025", 60e6)]),
    node(2, null, "us-gaap:OperatingExpenses", "Opex", [fact("FY2025", 10e6)]),
  ])])];
  const row = (rowId: string, concept: string, label: string) =>
    ({ rowId, statement: "income_statement", label, components: [{ conceptQName: concept, weight: 1 }], rationale: "r" });
  // Run 1 leaves OperatingExpenses unconsumed -> dangling.
  const partial = JSON.stringify({ rows: [row("revenues", "us-gaap:Revenues", "Revenues"),
    row("cost_of_revenue", "us-gaap:CostOfRevenue", "Cost of revenue")] });
  // The patch adds only the missing row and says nothing about the other two.
  const patch = JSON.stringify({ upsertRows: [row("opex", "us-gaap:OperatingExpenses", "Opex")] });
  const { router } = scripted([loadCall, partial, patch]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, filings: three, requestedPeriods: periods });
  assert.deepEqual(run.decision.rows.map((r) => r.rowId), ["revenues", "cost_of_revenue", "opex"]);
  assert.deepEqual(run.decision.rows.map((r) => r.label), ["Revenues", "Cost of revenue", "Opex"]);
  assert.deepEqual(run.artifact.unresolvedFindings, []);
});

test("after maxRuns a dirty run ships with its unresolved findings instead of looping or passing silently", async () => {
  // Roll-up break: GrossProfit reports 70 but Revenues - CostOfRevenue computes 60; the decision is
  // complete (every inventory cell consumed once) so only the stage-③ finding remains each run.
  const broken = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100)]),
    node(1, null, "us-gaap:CostOfRevenue", "Cost of revenue", [fact("FY2025", 40)]),
    node(2, null, "us-gaap:GrossProfit", "Gross profit", [fact("FY2025", 70, { decimals: 0 })]),
  ])], [{ roleUri: "http://x/role/income_statement", parentConcept: "us-gaap:GrossProfit",
    children: [{ concept: "us-gaap:Revenues", weight: 1, order: 1 }, { concept: "us-gaap:CostOfRevenue", weight: -1, order: 2 }] }])];
  const dirty = JSON.stringify({ rows: [
    { rowId: "revenues", statement: "income_statement", label: "Revenues",
      components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }], rationale: "r" },
    { rowId: "cost_of_revenue", statement: "income_statement", label: "Cost of revenue",
      components: [{ conceptQName: "us-gaap:CostOfRevenue", weight: 1 }], rationale: "r" },
    { rowId: "gross_profit", statement: "income_statement", label: "Gross profit",
      components: [{ conceptQName: "us-gaap:GrossProfit", weight: 1 }], rationale: "r" },
  ] });
  // Runs 2 and 3 answer with an empty patch: nothing to change, so the break persists to the end.
  const { router } = scripted([loadCall, dirty, "{}", "{}"]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, filings: broken, requestedPeriods: periods, maxRuns: 3 });
  assert.ok(run.artifact.unresolvedFindings.some((f) => f.includes("roll-up break")));
});

test("a schema-invalid decision gets one in-band correction round, then throws", async () => {
  const invalid = JSON.stringify({ rows: "not an array" });
  const { router } = scripted([loadCall, invalid, invalid]);
  await assert.rejects(
    runStatementUnificationAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, filings, requestedPeriods: periods }),
    /rows/);
});

test("materializes breakdown rows the decision declares", async () => {
  // Script order: load -> explore (done immediately) -> decision (row declares a breakdown).
  const segTable = segTableFixture();
  const decision = JSON.stringify({ rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales",
    components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }], rationale: "single top-line concept",
    breakdowns: [{ axisQName: SEG_AXIS, conceptQName: "us-gaap:Revenues", rationale: "product mix" }] }] });
  const { router } = scripted([loadCall, exploreDone, decision]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, task,
    tools: loaderWithExploration().tools, filings, requestedPeriods: periods, tables: [segTable] });
  const rows = run.artifact.breakdownRows ?? [];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.parentRowId, "net_sales");
});

test("without a tableStore the model is never told it explored dimensions, and the run stays clean", async () => {
  // Regression for an Important finding: the DIMENSION BREAKDOWNS paragraph used to be unconditional,
  // so a caller with no tableStore (every existing caller that omits `tables`) still told the model it
  // had explored the issuer's axes and could see a digest — neither of which is true here. A model
  // that believed that and declared a "breakdowns" entry on faith would get a "found no facts" finding
  // it could never correct (there is no tableStore for any later run to fix that with).
  const { router, prompts } = scripted([loadCall, good]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, filings, requestedPeriods: periods });
  assert.deepEqual(run.artifact.unresolvedFindings, []);
  assert.deepEqual(run.artifact.breakdownRows ?? [], []);
  const decisionPrompt = prompts()[1]!;
  assert.ok(!decisionPrompt.includes("DIMENSION BREAKDOWNS"), decisionPrompt);
  assert.ok(!decisionPrompt.includes("[DIMENSION BREAKDOWNS EXPLORED]"), decisionPrompt);
});

test("breakdown findings feed the correction loop", async () => {
  // The decision declares an (axis, concept) pair with no facts in the store; maxRuns=1 ships the
  // decision anyway, carrying the "no facts" finding.
  const segTable = segTableFixture();
  const decision = JSON.stringify({ rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales",
    components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }], rationale: "single top-line concept",
    breakdowns: [{ axisQName: SEG_AXIS, conceptQName: "us-gaap:NonexistentConcept", rationale: "product mix" }] }] });
  const { router } = scripted([loadCall, exploreDone, decision]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, task,
    tools: loaderWithExploration().tools, filings, requestedPeriods: periods, maxRuns: 1, tables: [segTable] });
  assert.ok(run.artifact.unresolvedFindings.some((f) => f.includes("no facts")));
});
