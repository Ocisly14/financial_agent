import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider, type LlmToolCall } from "../../../infra/llm/provider.ts";
import { buildConceptInventory } from "../../../infra/xbrl/conceptInventory.ts";
import { buildUnifiedStatements, type UnificationDecision } from "../../../infra/xbrl/unifiedStatements.ts";
import { fact, filing, node, period, statement } from "../../../infra/xbrl/__tests__/spineFixture.ts";
import { McpToolRegistry, type RegisteredTool } from "../../../../mcp_tools/toolRegistry.ts";
import { SessionState } from "../../../framework/sessionState.ts";
import { SubagentRuntime, type SubagentDefinition } from "../../../framework/subagent.ts";
import { runSpineMappingAgent } from "../spineMappingAgent.ts";
import type { ReconciliationResult } from "../../../financial-model/types.ts";

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
const task = "Map TSLA's unified statements onto the canonical spine.";

const goodDecision = {
  mappings: [{ targetId: "revenue.total", rowIds: ["revenues"], rationale: "top line" }],
  detailRows: [],
  excluded: [{ rowId: "d_and_a", reason: "FY2024 missing; not modeled" }],
  spineGaps: [{ targetId: "depreciation_amortization", reason: "no complete series" }],
};

function loadTool(counter: { calls: number }): RegisteredTool {
  return { name: "load_unified_statements", category: "non_trading", description: "stub",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
    execute: async () => { counter.calls += 1;
      return { summary: "ok", generation_context: { data: { rows: unified.rows, periods: unified.periods } } }; } };
}

function scripted(calls: LlmToolCall[][]): SubagentRuntime {
  let step = 0;
  const provider: LlmProvider = { name: "scripted", generate: async () => ({
    text: "note", toolCalls: calls[Math.min(step++, calls.length - 1)]!,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  return new SubagentRuntime(new ModelRouter(provider), new McpToolRegistry());
}

const call = (name: string, input: object): LlmToolCall[] => [{ id: "t", name, input } as LlmToolCall];

const definition: SubagentDefinition = {
  name: "spine_mapping", description: "d", modelClass: "MEDIUM",
  defaultTools: [], maxToolSteps: 8,
  systemPrompt: { system: "{{skills}}", prompt: "{{task}}\n{{progress}}" },
};

async function run(runtime: SubagentRuntime, counter = { calls: 0 }) {
  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  return runSpineMappingAgent({ subagentRuntime: runtime, definition, state, sessionId: "s", tenantId: "a",
    task, readTools: [loadTool(counter)], unified, spineIds });
}

test("a post-mapping reconciliation failure is returned to the mapping agent and cannot be finished or committed", async () => {
  const runtime = scripted([
    call("submit_spine_decision", { decision: goodDecision }),
    call("finish", { summary: "incorrectly finished" }),
  ]);
  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  const failed: ReconciliationResult = {
    kind: "accounting_identity", identity: "operating_income", parentLineItemId: "operating_income",
    ruleId: "accounting_identity:operating_income", periodId: "FY2025", status: "failed", required: true,
    actual: 100, calculated: 110, residual: -10, difference: 10, tolerance: 0.1,
    refs: ["operating_income@FY2025"], unifiedTrail: [{ lineItemId: "other_operating_expenses", rowIds: ["other_opex"] }],
  };
  let commits = 0;
  await assert.rejects(() => runSpineMappingAgent({ subagentRuntime: runtime, definition, state, sessionId: "s", tenantId: "a",
    task, readTools: [loadTool({ calls: 0 })], unified, spineIds,
    previewReconciliations: () => [failed], commit: () => { commits += 1; return { revision: 2 }; } }),
  /finished with 1 unresolved finding\(s\); no facts were committed/);
  assert.equal(commits, 0);
});

test("a submitted mapping builds spine facts and returns with no unresolved findings", async () => {
  const counter = { calls: 0 };
  const runtime = scripted([
    call("load_unified_statements", { symbol: "TSLA" }),
    call("submit_spine_decision", { decision: goodDecision }),
    call("finish", { summary: "done" }),
  ]);

  const result = await run(runtime, counter);

  assert.equal(counter.calls, 1, "the agent loads its own working set");
  assert.deepEqual(result.unresolvedFindings, []);
  assert.equal(result.facts.length, 2, "revenue.total over both periods");
  assert.ok(result.decision.spineGaps.some((gap) => gap.targetId === "depreciation_amortization"));
});

test("a clean mapping invokes its commit callback exactly once after verification", async () => {
  const runtime = scripted([
    call("submit_spine_decision", { decision: goodDecision }),
    call("finish", { summary: "done" }),
  ]);
  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  let commits = 0;
  const result = await runSpineMappingAgent({ subagentRuntime: runtime, definition, state, sessionId: "s", tenantId: "a",
    task, readTools: [loadTool({ calls: 0 })], unified, spineIds,
    commit: (candidate) => { commits += 1; assert.equal(candidate.facts.length, 2); return { revision: 7 }; } });

  assert.equal(commits, 1);
  assert.equal(result.committedRevision, 7);
});

test("findings come back on the submission, and a patch corrects what was submitted", async () => {
  // Declaring no gap for a required id it also did not map is the finding; the patch adds the gap.
  const incomplete = { ...goodDecision, spineGaps: [] };
  const runtime = scripted([
    call("submit_spine_decision", { decision: incomplete }),
    call("patch_spine_decision", { patch: { upsertSpineGaps: goodDecision.spineGaps } }),
    call("finish", { summary: "done" }),
  ]);

  const result = await run(runtime);

  assert.deepEqual(result.unresolvedFindings, []);
  assert.equal(result.decision.spineGaps.length, 1);
});

test("patches stack on each other — a second correction needs no resubmission", async () => {
  // Two things wrong at once, fixed one round at a time: the gap is missing, and the row it should
  // have excluded was mapped onto the wrong id. Each patch is re-checked in full against the
  // accumulated decision, so the second must not lose what the first fixed.
  const wrong = { ...goodDecision, spineGaps: [],
    mappings: [...goodDecision.mappings, { targetId: "depreciation_amortization", rowIds: ["d_and_a"], rationale: "wrong" }],
    excluded: [] };
  const runtime = scripted([
    call("submit_spine_decision", { decision: wrong }),
    call("patch_spine_decision", { patch: { deleteMappingTargetIds: ["depreciation_amortization"],
      upsertExcluded: goodDecision.excluded } }),
    call("patch_spine_decision", { patch: { upsertSpineGaps: goodDecision.spineGaps } }),
    call("finish", { summary: "done" }),
  ]);

  const result = await run(runtime);

  assert.deepEqual(result.unresolvedFindings, []);
  assert.equal(result.decision.mappings.length, 1, "the first patch's deletion survived the second patch");
  assert.equal(result.decision.excluded.length, 1);
  assert.equal(result.decision.spineGaps.length, 1);
  assert.equal(result.facts.length, 2, "facts are rebuilt from the fully patched decision");
});

test("the summary the agent writes at finish is what comes back to the DCF orchestrator", async () => {
  const written = "Gapped D&A rather than forcing the FY2025-only line onto it.";
  const runtime = scripted([
    call("submit_spine_decision", { decision: goodDecision }),
    call("finish", { summary: written }),
  ]);

  const result = await run(runtime);

  // Written AFTER the submission, so it can speak to the host's verdict — that is the whole point
  // of routing the report through finish rather than through a field on the decision.
  assert.equal(result.summary, written);
});

test("a run that never finishes reports that, rather than a summary it never wrote", async () => {
  const runtime = scripted([
    call("submit_spine_decision", { decision: goodDecision }),
    call("load_unified_statements", { symbol: "TSLA" }),
  ]);

  const result = await run(runtime);

  assert.equal(result.facts.length, 2, "the delivery is still salvaged");
  assert.match(result.summary, /without writing a finish summary/);
});

test("an agent that finishes without submitting fails loudly", async () => {
  const runtime = scripted([call("finish", { summary: "nothing to do" })]);

  await assert.rejects(() => run(runtime), /finished without submitting a mapping/);
});
