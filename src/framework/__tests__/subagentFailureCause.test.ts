import test from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../sessionState.ts";
import { SubagentRuntime } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateOptions, GenerateResult, LlmMessage, LlmProvider, LlmToolCall } from "../../infra/llm/provider.ts";

/**
 * When a run ends badly, the result has to name what ended it. A tool error never does — it is fed
 * back to the agent, which corrects and keeps going — so reporting the first one as the cause
 * describes a moment the run already recovered from. An AAPL DCF run died on a provider refusing
 * the request for want of credit and reported "unknown section: income_statement", a guess the
 * agent had fixed fifteen steps earlier: the wrong diagnosis, and a caller cannot tell a spent
 * budget from a spent account.
 */

const agent = {
  name: "financial_modeling" as const,
  description: "d",
  modelClass: "MEDIUM" as const,
  defaultTools: ["flaky_tool"],
  systemPrompt: { system: "s", prompt: "{{task}} {{modelContext}} {{progress}}" },
};

function harness(steps: LlmToolCall[][], failAfter: number, failure: Error) {
  let call = 0;
  const provider: LlmProvider = {
    name: "stub",
    async generate(_messages: LlmMessage[], _options: GenerateOptions): Promise<GenerateResult> {
      if (call >= failAfter) throw failure;
      const toolCalls = steps[call] ?? [{ name: "finish", input: { summary: "done" } }];
      call += 1;
      return { text: "", toolCalls, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };

  let toolCalls = 0;
  const tools = new McpToolRegistry();
  tools.register({
    name: "flaky_tool", description: "d", category: "non_trading", inputSchema: { type: "object" },
    // Wrong the first time, right afterwards — the shape of a guess the agent corrects.
    execute: async () => {
      toolCalls += 1;
      if (toolCalls === 1) throw new Error("unknown section: income_statement");
      return { summary: "flaky_tool ok" };
    },
  });

  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  return { runtime: new SubagentRuntime(new ModelRouter(provider), tools), state, tools };
}

async function run(runtime: SubagentRuntime, state: SessionState, tools: McpToolRegistry): Promise<void> {
  const thread = state.openThread("financial_modeling");
  const dispatch = state.recordDispatch("financial_modeling", "value AAPL", thread);
  const { execute: _execute, ...definition } = tools.get("flaky_tool")!;
  await runtime.run(agent, {
    sessionId: "s", tenantId: "agent-1", taskId: dispatch.event_id,
    request: { agent: "financial_modeling", task: "value AAPL" },
    allowedTools: [definition], state, threadId: thread,
  });
}

test("a provider failure is reported as the cause, not a tool error the agent already recovered from", async () => {
  const steps: LlmToolCall[][] = [
    [{ name: "flaky_tool", input: {} }],
    [{ name: "flaky_tool", input: {} }],
  ];
  const { runtime, state, tools } = harness(steps, 2,
    new Error('Anthropic API error 400: {"type":"error","error":{"message":"Your credit balance is too low"}}'));

  await run(runtime, state, tools);

  const result = state.turnResults(1)[0]!;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "llm_call_failed");
  assert.match(result.error!.message, /credit balance is too low/);
  assert.match(result.summary, /credit balance is too low/);
  assert.doesNotMatch(result.summary, /unknown section/,
    "the recovered tool error is not what ended the run");
});

test("the step the provider failed at is named, so a partial run can be placed", async () => {
  // Refused on the very first call: nothing ran, and the message has to say so rather than
  // implying the agent got somewhere.
  const { runtime, state, tools } = harness([], 0, new Error("connection reset"));

  await run(runtime, state, tools);

  assert.match(state.turnResults(1)[0]!.error!.message, /failed at step 1: connection reset/);
  assert.equal(state.turnResults(1)[0]!.metrics?.["llm_calls"], 0);
});

test("a clean finish after a recovered tool error is still a success", async () => {
  const steps: LlmToolCall[][] = [
    [{ name: "flaky_tool", input: {} }],
    [{ name: "finish", input: { summary: "valued AAPL at $210/share" } }],
  ];
  const { runtime, state, tools } = harness(steps, 99, new Error("unused"));

  await run(runtime, state, tools);

  const result = state.turnResults(1)[0]!;
  assert.equal(result.status, "ok");
  assert.equal(result.summary, "valued AAPL at $210/share");
  assert.equal(result.error, undefined);
});

/**
 * Spending the step budget is a PAUSE, and the round loop is built to dispatch the thread again —
 * but only if the result says so. An AAPL run corrected a rejected `sourceType` at step 27, committed
 * revision 11 with its WACC at steps 29-30, ran out of budget before it could call finish, and was
 * reported as "failed" carrying the step-27 message it had already fixed. The e2e harness stops on a
 * failure by design, so five of six rounds never ran and the DCF never reached `valued` — over an
 * error the agent had moved past.
 */
test("a spent budget after a recovered tool error is a pause, not a failure", async () => {
  const steps: LlmToolCall[][] = [
    [{ name: "flaky_tool", input: {} }],   // errors, and is corrected below
    [{ name: "flaky_tool", input: {} }],
    [{ name: "flaky_tool", input: {} }],   // budget ends here, with no finish call
  ];
  const { runtime, state, tools } = harness(steps, 99, new Error("unused"));
  const thread = state.openThread("financial_modeling");
  const dispatch = state.recordDispatch("financial_modeling", "value AAPL", thread);
  const { execute: _execute, ...definition } = tools.get("flaky_tool")!;
  await runtime.run({ ...agent, maxToolSteps: 3 }, {
    sessionId: "s", tenantId: "agent-1", taskId: dispatch.event_id,
    request: { agent: "financial_modeling", task: "value AAPL" },
    allowedTools: [definition], state, threadId: thread });

  const result = state.turnResults(1)[0]!;
  assert.equal(result.status, "ok", "the work stands; the thread just needs dispatching again");
  assert.equal(result.error, undefined);
  assert.match(result.summary, /Paused after 3 tool steps/);
  assert.doesNotMatch(result.summary, /unknown section/,
    "the corrected error is not what stopped the run — the budget is");
});

test("a tool error the agent never got past is still what failed the run", async () => {
  const steps: LlmToolCall[][] = [[{ name: "always_fails", input: {} }], [{ name: "always_fails", input: {} }]];
  const { runtime, state, tools } = harness(steps, 99, new Error("unused"));
  tools.register({ name: "always_fails", description: "d", category: "non_trading", inputSchema: { type: "object" },
    execute: async () => { throw new Error("unknown section: income_statement"); } });
  const thread = state.openThread("financial_modeling");
  const dispatch = state.recordDispatch("financial_modeling", "value AAPL", thread);
  const { execute: _execute, ...definition } = tools.get("always_fails")!;
  await runtime.run({ ...agent, defaultTools: ["always_fails"], maxToolSteps: 2 }, {
    sessionId: "s", tenantId: "agent-1", taskId: dispatch.event_id,
    request: { agent: "financial_modeling", task: "value AAPL" },
    allowedTools: [definition], state, threadId: thread });

  const result = state.turnResults(1)[0]!;
  assert.equal(result.status, "failed");
  assert.match(result.summary, /unknown section/);
});

/**
 * A tool declares failure with its `error` field. Guessing from the summary text — which is what
 * `normalizeToolError` used to do — reclassified successful reads whose summary honestly reported
 * the model's standing state: "Loaded financial model … (draft); required DCF reconciliation checks
 * failed." matched /failed/ and became a tool error.
 *
 * The count was the least of it. `subagentToolOutputs` drops errored results, so the whole overview
 * — 580KB of it across one AMZN run — never reached the agent's progress region. The agent saw only
 * "get_financial_model failed", read again, and looped: ten consecutive identical reads, each one
 * answered correctly and then discarded before it could be read.
 */
test("a successful tool result is not reclassified as an error because its summary says 'failed'", async () => {
  const provider: LlmProvider = {
    name: "stub",
    async generate(): Promise<GenerateResult> {
      return { text: "", toolCalls: [{ name: "read_model", input: {} }],
        metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };
  const tools = new McpToolRegistry();
  tools.register({ name: "read_model", description: "d", category: "non_trading", inputSchema: { type: "object" },
    // Exactly the shape that broke: a success whose summary reports a standing model condition.
    execute: async () => ({ summary: "Loaded financial model fm_1 revision 7 (draft); required DCF reconciliation checks failed.",
      generation_context: { data: { model_id: "fm_1", revision: 7, model_overview: { blocker: "unresolved_reconciliation" } } } }) });

  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  const thread = state.openThread("financial_modeling");
  const dispatch = state.recordDispatch("financial_modeling", "value AMZN", thread);
  const { execute: _execute, ...definition } = tools.get("read_model")!;

  await new SubagentRuntime(new ModelRouter(provider), tools).run(
    { ...agent, defaultTools: ["read_model"] } as never,
    { sessionId: "s", tenantId: "a", taskId: dispatch.event_id,
      request: { agent: "financial_modeling", task: "value AMZN" },
      allowedTools: [definition], state, threadId: thread });

  assert.deepEqual(state.subagentToolErrors({ thread }), [], "the tool reported no error, so neither should the log");
  const outputs = state.subagentToolOutputs({ thread });
  assert.ok(outputs.length > 0, "and the result survives into the agent's own context");
  assert.equal(outputs[0]!.generation_context?.data?.["revision"], 7, "with the data it was read for");
});

test("a tool that declares an error is still recorded as one", async () => {
  const provider: LlmProvider = {
    name: "stub",
    async generate(): Promise<GenerateResult> {
      return { text: "", toolCalls: [{ name: "read_model", input: {} }],
        metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };
  const tools = new McpToolRegistry();
  tools.register({ name: "read_model", description: "d", category: "non_trading", inputSchema: { type: "object" },
    execute: async () => ({ summary: "model not found", error: { code: "financial_model_not_found", message: "model not found" } }) });

  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  const thread = state.openThread("financial_modeling");
  const dispatch = state.recordDispatch("financial_modeling", "value AMZN", thread);
  const { execute: _execute, ...definition } = tools.get("read_model")!;

  await new SubagentRuntime(new ModelRouter(provider), tools).run(
    { ...agent, defaultTools: ["read_model"] } as never,
    { sessionId: "s", tenantId: "a", taskId: dispatch.event_id,
      request: { agent: "financial_modeling", task: "value AMZN" },
      allowedTools: [definition], state, threadId: thread });

  assert.equal(state.subagentToolErrors({ thread })[0]?.code, "financial_model_not_found");
});
