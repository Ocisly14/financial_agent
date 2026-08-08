import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { buildConceptInventory } from "../../../infra/xbrl/conceptInventory.ts";
import { buildUnifiedStatements, type UnificationDecision } from "../../../infra/xbrl/unifiedStatements.ts";
import { fact, filing, node, period, statement } from "../../../infra/xbrl/__tests__/spineFixture.ts";
import type { LoopTool } from "../../../../mcp_tools/financial-model/mappingSubagentTools.ts";
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

// Fixture through the real ① → ②/③ pipeline: d_and_a is FY2025-only, so its FY2024 cell is null.
// depreciation_amortization is a REQUIRED spine id, so that gap is worth a finding.
const periods = [period("FY2024", 2024), period("FY2025", 2025)];
const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
  node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 96e9), fact("FY2025", 100e9)]),
  node(1, null, "us-gaap:DepreciationDepletionAndAmortization", "Depreciation and amortization", [fact("FY2025", 65e9)]),
])])];
const unificationDecision: UnificationDecision = { rows: [
  { rowId: "revenues", statement: "income_statement", label: "Revenues", rationale: "",
      components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }] },
  { rowId: "d_and_a", statement: "income_statement", label: "Depreciation and amortization", rationale: "",
      components: [{ conceptQName: "us-gaap:DepreciationDepletionAndAmortization", weight: 1 }] },
] };
const unified = buildUnifiedStatements({ decision: unificationDecision, filings, requestedPeriods: periods,
  inventory: buildConceptInventory({ filings, requestedPeriods: periods }) });

const spineIds = ["revenue.total", "depreciation_amortization"];

// The subagent's first turn is always the load call, so every script starts with one and the tool
// map records that it happened. The data itself still comes from the `unified` argument.
const task = "Map TSLA's unified statements onto the canonical spine.";
const loadCall = JSON.stringify({ tool: "load_unified_statements", input: { symbol: "TSLA" } });
function loader(): { tools: Map<string, LoopTool>; calls: () => number } {
  let calls = 0;
  const tool: LoopTool = { name: "load_unified_statements", category: "non_trading",
    description: "stub", inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
    execute: () => { calls += 1; return { rows: unified.rows, periods: unified.periods } as never; } };
  return { tools: new Map([[tool.name, tool]]), calls: () => calls };
}
// Literal on purpose: the registry prompt is owned by a parallel change.
const systemPrompt = "You are the DCF spine mapping agent. Place every unified row.";
const good = JSON.stringify({
  mappings: [{ targetId: "revenue.total", rowIds: ["revenues"], rationale: "top line" }],
  detailRows: [],
  excluded: [{ rowId: "d_and_a", reason: "FY2024 missing; not modeled" }],
  spineGaps: [{ targetId: "depreciation_amortization", reason: "no complete series" }],
});

test("a clean decision builds spine facts and returns with no unresolved findings in one run", async () => {
  const { router, prompts } = scripted([loadCall, good]);
  const run = await runSpineMappingAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, unified, spineIds });
  assert.deepEqual(run.unresolvedFindings, []);
  assert.deepEqual(run.coverageGaps, []);
  assert.equal(run.facts.length, 2);
  assert.equal(run.facts[0]!.lineItemId, "revenue.total");
  assert.ok(run.facts.some((f) => f.factId === "spine.revenue.total.FY2025" && f.value === 100e9));
  const prompt = prompts()[1]!;
  assert.ok(prompt.includes("[UNIFIED STATEMENTS]") && prompt.includes('"revenues"'));
  assert.ok(!prompt.includes("unified.income_statement"), "unified.facts must not be sent to the model");
});

test("a re-run is asked for a patch over the previous mapping, not a fresh one", async () => {
  // d_and_a placed nowhere -> dangling finding.
  const incomplete = JSON.stringify({ mappings: [{ targetId: "revenue.total", rowIds: ["revenues"], rationale: "r" }],
    detailRows: [], excluded: [], spineGaps: [{ targetId: "depreciation_amortization", reason: "r" }] });
  const patch = JSON.stringify({ upsertExcluded: [{ rowId: "d_and_a", reason: "FY2024 missing; not modeled" }] });
  const { router, prompts } = scripted([loadCall, incomplete, patch]);
  const run = await runSpineMappingAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, unified, spineIds });
  assert.deepEqual(run.unresolvedFindings, []);
  // The untouched mapping and gap survive the patch.
  assert.deepEqual(run.decision.mappings.map((m) => m.targetId), ["revenue.total"]);
  assert.deepEqual(run.decision.spineGaps.map((g) => g.targetId), ["depreciation_amortization"]);
  assert.ok(prompts()[2]!.includes("[YOUR PREVIOUS DECISION]"), prompts()[2]);
  assert.ok(prompts()[2]!.includes("[FINDINGS AGAINST IT]"), prompts()[2]);
  assert.ok(prompts()[2]!.includes("d_and_a"), prompts()[2]);
});

test("an optional spine id needs no declaration, a required one does", async () => {
  const withOptional = [...spineIds, "share_repurchases"];
  // Neither maps nor gap-declares share_repurchases — optional, so silence is accepted.
  const { router } = scripted([loadCall, good]);
  const run = await runSpineMappingAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, unified, spineIds: withOptional });
  assert.deepEqual(run.unresolvedFindings, []);

  // Dropping the REQUIRED id's declaration is a finding on every run.
  const missingRequired = JSON.stringify({
    mappings: [{ targetId: "revenue.total", rowIds: ["revenues"], rationale: "r" }],
    detailRows: [], excluded: [{ rowId: "d_and_a", reason: "r" }], spineGaps: [] });
  const { router: r2 } = scripted([loadCall, missingRequired, "{}", "{}"]);
  const dirty = await runSpineMappingAgent({ modelRouter: r2, systemPrompt, task, tools: loader().tools, unified, spineIds: withOptional, maxRuns: 3 });
  assert.ok(dirty.unresolvedFindings.some((f) => f.includes("required") && f.includes("depreciation_amortization")),
    dirty.unresolvedFindings.join("\n"));
  assert.ok(!dirty.unresolvedFindings.some((f) => f.includes("share_repurchases")),
    dirty.unresolvedFindings.join("\n"));
});

test("after maxRuns the last run ships with its unresolved findings instead of looping or passing silently", async () => {
  // Completeness passes, but cost_of_revenue FY2024 has no value and is not gap-declared -> coverage gap every run.
  const gapped = JSON.stringify({ mappings: [
    { targetId: "revenue.total", rowIds: ["revenues"], rationale: "r" },
    { targetId: "depreciation_amortization", rowIds: ["d_and_a"], rationale: "r" },
  ], detailRows: [], excluded: [], spineGaps: [] });
  // Runs 2 and 3 answer with an empty patch: nothing changes, so the gap persists to the end.
  const { router } = scripted([loadCall, gapped, "{}", "{}"]);
  const run = await runSpineMappingAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, unified, spineIds, maxRuns: 3 });
  assert.deepEqual(run.coverageGaps, [{ targetId: "depreciation_amortization", periodId: "FY2024" }]);
  assert.ok(run.unresolvedFindings.some((f) => f.includes("coverage_gap") && f.includes("FY2024")));
});

test("a schema-invalid decision gets one in-band correction round, then throws", async () => {
  const invalid = JSON.stringify({ mappings: "not an array", detailRows: [], excluded: [], spineGaps: [] });
  const { router } = scripted([loadCall, invalid, invalid]);
  await assert.rejects(
    runSpineMappingAgent({ modelRouter: router, systemPrompt, task, tools: loader().tools, unified, spineIds }),
    /mappings/);
});
