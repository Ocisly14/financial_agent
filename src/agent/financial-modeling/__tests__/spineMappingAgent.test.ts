import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { buildConceptInventory } from "../../../infra/xbrl/conceptInventory.ts";
import { buildUnifiedStatements, type UnificationDecision } from "../../../infra/xbrl/unifiedStatements.ts";
import { fact, filing, node, period, statement } from "../../../infra/xbrl/__tests__/spineFixture.ts";
import { runSpineMappingAgent } from "../spineMappingAgent.ts";

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

// Fixture through the real ① → ②/③ pipeline: cost_of_revenues is FY2025-only, so its FY2024 cell is null.
const periods = [period("FY2024", 2024), period("FY2025", 2025)];
const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
  node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 96e9), fact("FY2025", 100e9)]),
  node(1, null, "us-gaap:CostOfRevenue", "Cost of revenues", [fact("FY2025", 65e9)]),
])])];
const unificationDecision: UnificationDecision = { rows: [
  { rowId: "revenues", statement: "income_statement", label: "Revenues", rationale: "",
      components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }] },
  { rowId: "cost_of_revenues", statement: "income_statement", label: "Cost of revenues", rationale: "",
      components: [{ conceptQName: "us-gaap:CostOfRevenue", weight: 1 }] },
] };
const unified = buildUnifiedStatements({ decision: unificationDecision, filings, requestedPeriods: periods,
  inventory: buildConceptInventory({ filings, requestedPeriods: periods }) });

const spineIds = ["revenue.total", "cost_of_revenue"];
// Literal on purpose: the registry prompt is owned by a parallel change.
const systemPrompt = "You are the DCF spine mapping agent. Place every unified row.";
const good = JSON.stringify({
  mappings: [{ targetId: "revenue.total", rowIds: ["revenues"], rationale: "top line" }],
  detailRows: [],
  excluded: [{ rowId: "cost_of_revenues", reason: "FY2024 missing; not modeled" }],
  spineGaps: [{ targetId: "cost_of_revenue", reason: "no complete series" }],
});

test("a clean decision builds spine facts and returns with no unresolved findings in one run", async () => {
  const { router, prompts } = scripted([good]);
  const run = await runSpineMappingAgent({ modelRouter: router, systemPrompt, unified, spineIds });
  assert.deepEqual(run.unresolvedFindings, []);
  assert.deepEqual(run.coverageGaps, []);
  assert.equal(run.facts.length, 2);
  assert.equal(run.facts[0]!.lineItemId, "revenue.total");
  assert.ok(run.facts.some((f) => f.factId === "spine.revenue.total.FY2025" && f.value === 100e9));
  const prompt = prompts()[0]!;
  assert.ok(prompt.includes("[UNIFIED STATEMENTS]") && prompt.includes('"revenues"'));
  assert.ok(!prompt.includes("unified.income_statement"), "unified.facts must not be sent to the model");
});

test("completeness findings are fed back verbatim and the corrected second run succeeds", async () => {
  // cost_of_revenues placed nowhere -> dangling finding.
  const incomplete = JSON.stringify({ mappings: [{ targetId: "revenue.total", rowIds: ["revenues"], rationale: "r" }],
    detailRows: [], excluded: [], spineGaps: [{ targetId: "cost_of_revenue", reason: "r" }] });
  const { router, prompts } = scripted([incomplete, good]);
  const run = await runSpineMappingAgent({ modelRouter: router, systemPrompt, unified, spineIds });
  assert.deepEqual(run.unresolvedFindings, []);
  assert.ok(prompts()[1]!.includes("[FINDINGS FROM PREVIOUS RUN]"));
  assert.ok(prompts()[1]!.includes("cost_of_revenues"));
});

test("after maxRuns the last run ships with its unresolved findings instead of looping or passing silently", async () => {
  // Completeness passes, but cost_of_revenue FY2024 has no value and is not gap-declared -> coverage gap every run.
  const gapped = JSON.stringify({ mappings: [
    { targetId: "revenue.total", rowIds: ["revenues"], rationale: "r" },
    { targetId: "cost_of_revenue", rowIds: ["cost_of_revenues"], rationale: "r" },
  ], detailRows: [], excluded: [], spineGaps: [] });
  const { router } = scripted([gapped, gapped, gapped]);
  const run = await runSpineMappingAgent({ modelRouter: router, systemPrompt, unified, spineIds, maxRuns: 3 });
  assert.deepEqual(run.coverageGaps, [{ targetId: "cost_of_revenue", periodId: "FY2024" }]);
  assert.ok(run.unresolvedFindings.some((f) => f.includes("coverage_gap") && f.includes("FY2024")));
});

test("a schema-invalid decision gets one in-band correction round, then throws", async () => {
  const invalid = JSON.stringify({ mappings: "not an array", detailRows: [], excluded: [], spineGaps: [] });
  const { router } = scripted([invalid, invalid]);
  await assert.rejects(
    runSpineMappingAgent({ modelRouter: router, systemPrompt, unified, spineIds }),
    /mappings/);
});
