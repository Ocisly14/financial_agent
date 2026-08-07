import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { fact, filing, node, period, statement } from "../../../infra/xbrl/__tests__/spineFixture.ts";
import { DcfSubagentRegistry } from "../subagents.ts";
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
const systemPrompt = new DcfSubagentRegistry().get("statement_unification").prompt;
const good = JSON.stringify({ rows: [{ rowId: "revenues", statement: "income_statement", label: "Revenues",
  components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }],
  rationale: "single top-line concept" }] });

test("a clean decision produces artifact facts and empty unresolved findings in one run", async () => {
  const { router } = scripted([good]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, filings, requestedPeriods: periods });
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
  const { router, prompts } = scripted([empty, patch]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, filings, requestedPeriods: periods });
  assert.deepEqual(run.artifact.unresolvedFindings, []);
  assert.equal(run.decision.rows.length, 1);
  assert.equal(run.artifact.facts[0]!.value, 100e6);
  // The re-run sees what it previously decided, the findings against it, and is told to correct.
  assert.ok(prompts()[1]!.includes("[YOUR PREVIOUS DECISION]"), prompts()[1]);
  assert.ok(prompts()[1]!.includes("[FINDINGS AGAINST IT]"), prompts()[1]);
  assert.ok(prompts()[1]!.includes("CORRECTING an existing decision"), prompts()[1]);
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
  const { router } = scripted([partial, patch]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, filings: three, requestedPeriods: periods });
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
  const { router } = scripted([dirty, "{}", "{}"]);
  const run = await runStatementUnificationAgent({ modelRouter: router, systemPrompt, filings: broken, requestedPeriods: periods, maxRuns: 3 });
  assert.ok(run.artifact.unresolvedFindings.some((f) => f.includes("roll-up break")));
});

test("a schema-invalid decision gets one in-band correction round, then throws", async () => {
  const invalid = JSON.stringify({ rows: "not an array" });
  const { router } = scripted([invalid, invalid]);
  await assert.rejects(
    runStatementUnificationAgent({ modelRouter: router, systemPrompt, filings, requestedPeriods: periods }),
    /rows/);
});
