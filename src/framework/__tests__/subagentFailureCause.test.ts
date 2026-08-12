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
    sessionId: "s", agentId: "agent-1", taskId: dispatch.event_id,
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
