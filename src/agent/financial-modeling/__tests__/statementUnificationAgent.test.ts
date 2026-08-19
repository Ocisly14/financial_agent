import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider, type LlmToolCall } from "../../../infra/llm/provider.ts";
import { fact, filing, node, period, statement } from "../../../infra/xbrl/__tests__/spineFixture.ts";
import { McpToolRegistry, type RegisteredTool } from "../../../../mcp_tools/toolRegistry.ts";
import { SessionState } from "../../../framework/sessionState.ts";
import { SubagentRuntime, type SubagentDefinition } from "../../../framework/subagent.ts";
import { runStatementUnificationAgent } from "../statementUnificationAgent.ts";

/**
 * The agent decides its own sequence now. What the host still owes, and what these pin:
 * the checks run on submission, their findings come back as a tool result, a patch is applied to
 * what was already submitted, and nothing is invented when the agent never delivers.
 */

const periods = [period("FY2025", 2025)];
const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
  node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e6)]),
])])];
const task = "Unify TSLA's extracted filings into multi-year statements.";

const revenueRow = { rowId: "revenues", statement: "income_statement", label: "Revenues",
  components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }], rationale: "single top-line concept" };

function loadTool(): RegisteredTool {
  return { name: "load_concept_inventory", category: "non_trading", description: "stub",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
    execute: async () => ({ summary: "ok", generation_context: { data: { symbol: "TSLA" } } }) };
}

/** Drives the runtime with a fixed sequence of tool calls, one per step. */
function scripted(calls: LlmToolCall[][]): { runtime: SubagentRuntime; seen: () => string[] } {
  let step = 0;
  const seen: string[] = [];
  const provider: LlmProvider = { name: "scripted", generate: async (messages) => {
    seen.push(messages.map((m) => m.content).join("\n---\n"));
    const toolCalls = calls[Math.min(step++, calls.length - 1)]!;
    return { text: "note", toolCalls,
      metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } };
  } };
  return { runtime: new SubagentRuntime(new ModelRouter(provider), new McpToolRegistry()), seen: () => seen };
}

const call = (name: string, input: object, id = "t"): LlmToolCall[] => [{ id, name, input } as LlmToolCall];

const definition: SubagentDefinition = {
  name: "statement_unification", description: "d", modelClass: "MEDIUM",
  defaultTools: [], maxToolSteps: 8,
  systemPrompt: { system: "{{skills}}", prompt: "{{task}}\n{{progress}}" },
};

async function run(runtime: SubagentRuntime) {
  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  return runStatementUnificationAgent({ subagentRuntime: runtime, definition, state,
    sessionId: "s", tenantId: "a", task, readTools: [loadTool()], filings, requestedPeriods: periods });
}

test("a submitted decision is checked, stored, and returned as the artifact", async () => {
  const { runtime } = scripted([
    call("load_concept_inventory", { symbol: "TSLA" }),
    call("submit_unification_decision", { decision: { rows: [revenueRow] } }),
    call("finish", { summary: "done" }),
  ]);

  const result = await run(runtime);

  assert.deepEqual(result.artifact.unresolvedFindings, []);
  assert.equal(result.artifact.facts.length, 1);
  assert.equal(result.artifact.facts[0]!.lineItemId, "unified.income_statement.revenues");
  assert.equal(result.artifact.facts[0]!.value, 100e6);
});

test("findings come back on the submission itself, and a patch corrects what was submitted", async () => {
  // The empty decision leaves the only inventory cell unconsumed — a finding the agent then patches.
  const { runtime, seen } = scripted([
    call("submit_unification_decision", { decision: { rows: [] } }),
    call("patch_unification_decision", { patch: { upsertRows: [revenueRow] } }),
    call("finish", { summary: "done" }),
  ]);

  const result = await run(runtime);

  assert.deepEqual(result.artifact.unresolvedFindings, []);
  assert.equal(result.decision.rows.length, 1);
  assert.equal(result.artifact.facts[0]!.value, 100e6);
  // The findings reached the agent as the submission's own result — no separate correction prompt.
  assert.match(seen()[1]!, /incomplete/);
});

test("a dirty unification preview never crosses the agent boundary", async () => {
  const { runtime } = scripted([
    call("submit_unification_decision", { decision: { rows: [] } }),
    call("finish", { summary: "shipping despite the finding" }),
  ]);

  await assert.rejects(() => run(runtime), /finished with 1 unresolved finding\(s\); no unified statements were committed/);
});

test("a later dirty patch revokes an earlier accepted preview", async () => {
  const { runtime } = scripted([
    call("submit_unification_decision", { decision: { rows: [revenueRow] } }),
    call("patch_unification_decision", { patch: { deleteRowIds: ["revenues"] } }),
    call("finish", { summary: "done" }),
  ]);

  await assert.rejects(() => run(runtime), /finished with 1 unresolved finding\(s\); no unified statements were committed/);
});

test("a large decision can be drafted in batches, then validated and corrected incrementally", async () => {
  const { runtime, seen } = scripted([
    call("start_unification_draft", {}),
    call("patch_unification_decision", { patch: { upsertRows: [revenueRow] } }),
    call("validate_unification_decision", {}),
    call("finish", { summary: "done" }),
  ]);

  const result = await run(runtime);

  assert.deepEqual(result.artifact.unresolvedFindings, []);
  assert.equal(result.decision.rows.length, 1);
  assert.match(seen()[2]!, /draft_updated/, "the batch is recorded without triggering full findings");
});

test("the first batch opens the draft on its own, with no start_unification_draft round", async () => {
  const { runtime, seen } = scripted([
    call("patch_unification_decision", { patch: { upsertRows: [revenueRow] } }),
    call("validate_unification_decision", {}),
    call("finish", { summary: "done" }),
  ]);

  const result = await run(runtime);

  assert.deepEqual(result.artifact.unresolvedFindings, []);
  assert.equal(result.decision.rows.length, 1);
  assert.match(seen()[1]!, /draft_updated/, "patching an unopened draft starts it rather than failing");
});

test("the summary the agent writes at finish is what comes back to the DCF orchestrator", async () => {
  const written = "Merged the two revenue tags; FY2024 is the restated figure.";
  const { runtime } = scripted([
    call("submit_unification_decision", { decision: { rows: [revenueRow] } }),
    call("finish", { summary: written }),
  ]);

  const result = await run(runtime);

  // Written AFTER the submission, so it can speak to the host's verdict — that is the whole point
  // of routing the report through finish rather than through a field on the decision.
  assert.equal(result.summary, written);
});

test("a run that never finishes reports that, rather than a summary it never wrote", async () => {
  // Budget spent looping on a read after a valid submission: the artifact ships, the account does not.
  const { runtime } = scripted([
    call("submit_unification_decision", { decision: { rows: [revenueRow] } }),
    call("load_concept_inventory", { symbol: "TSLA" }),
  ]);

  const result = await run(runtime);

  assert.equal(result.artifact.facts.length, 1, "the delivery is still salvaged");
  assert.match(result.summary, /without writing a finish summary/);
});

test("an agent that finishes without submitting fails loudly rather than shipping an empty artifact", async () => {
  const { runtime } = scripted([call("finish", { summary: "nothing to do" })]);

  // An empty artifact would read downstream as "this issuer has no statements".
  await assert.rejects(() => run(runtime), /finished without submitting a decision/);
});

test("the step budget running out without a submission is also a failure, not a silent empty run", async () => {
  const { runtime } = scripted([call("load_concept_inventory", { symbol: "TSLA" })]);

  await assert.rejects(() => run(runtime), /finished without submitting a decision/);
});
