import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry, SubagentRuntime } from "../subagent.ts";
import { createDelegateToAgentTool, DELEGATE_TO_AGENT } from "../delegation.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateResult, LlmMessage, LlmProvider, LlmToolCall } from "../../infra/llm/provider.ts";
import type { AgentKind, JsonObject } from "../types.ts";

/**
 * Delegation runs through Dispatcher rather than reaching for SubagentRuntime directly, so these
 * exercise the whole path: the callee's own pool is resolved and gated, a task_result exists on
 * every outcome, the thread can be continued, and the caller is handed an account rather than the
 * evidence behind it.
 */

const CALLER: AgentKind = "financial_modeling";
const CALLEE: AgentKind = "market_research";

/** A step is resolved when the provider is asked for it, so a later step can name a thread an
 *  earlier one only learned at runtime. */
type Step = LlmToolCall[] | (() => LlmToolCall[]);
type Script = Partial<Record<AgentKind, Step[]>>;

function harness(script: Script, options: { calleeTools?: string[]; slowCalleeMs?: number } = {}) {
  const subagents = new SubagentRegistry();
  subagents.register({
    name: CALLER,
    description: "the caller",
    modelClass: "MEDIUM",
    defaultTools: [DELEGATE_TO_AGENT],
    delegatesTo: [CALLEE],
    // The agent name is in the system text so the stub provider can tell the two runs apart.
    systemPrompt: { system: `AGENT:${CALLER}\n{{delegates}}`, prompt: "{{progress}}{{stepBudget}}" },
  });
  subagents.register({
    name: CALLEE,
    description: "the research delegate",
    modelClass: "MEDIUM",
    defaultTools: options.calleeTools ?? ["financial_search"],
    delegable: { returns: "summary", timeoutMs: 60_000 },
    systemPrompt: { system: `AGENT:${CALLEE}`, prompt: "{{progress}}{{stepBudget}}" },
  });

  const tools = new McpToolRegistry();
  tools.register({
    name: "financial_search",
    description: "d",
    category: "non_trading",
    inputSchema: { type: "object" },
    execute: async () => {
      if (options.slowCalleeMs) await new Promise((resolve) => setTimeout(resolve, options.slowCalleeMs));
      // Through the production path: progress reads generation_context.data, never `summary`.
      return { summary: "search ok", generation_context: { data: { hits: "TWENTY THOUSAND CHARACTERS OF SEARCH TEXT" } } };
    },
  });
  tools.register({
    name: "ask_user",
    description: "d",
    category: "main",
    inputSchema: { type: "object" },
    execute: async () => ({ summary: "asked" }),
  });

  const counts = new Map<AgentKind, number>();
  const provider: LlmProvider = {
    name: "stub",
    async generate(messages: LlmMessage[]): Promise<GenerateResult> {
      const system = messages.map((m) => String(m.content ?? "")).join("\n");
      const agent = system.includes(`AGENT:${CALLEE}`) ? CALLEE : CALLER;
      const step = counts.get(agent) ?? 0;
      counts.set(agent, step + 1);
      const scripted = script[agent]?.[step];
      const toolCalls = typeof scripted === "function" ? scripted()
        : scripted ?? [{ name: "finish", input: { summary: `${agent} done` } }];
      return { text: "", toolCalls, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };

  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  const runtime = new SubagentRuntime(new ModelRouter(provider), tools, undefined, subagents);

  const dispatchers = (sessionId: string, tenantId: string, _s?: SessionState, parentPath?: readonly AgentKind[]) =>
    new Dispatcher(sessionId, subagents, runtime, tools, state, tenantId, parentPath);

  tools.register(createDelegateToAgentTool({
    describe: (name) => subagents.get(name).description,
    policyFor: (name) => subagents.get(name).delegable,
    delegableNames: () => subagents.list().filter((n) => n.delegable).map((n) => n.name),
    dispatchers,
  }));

  const top = new Dispatcher("s", subagents, runtime, tools, state, "tenant-1");
  return { top, state, subagents };
}

/** The delegation payload the caller's own tool_result carried. */
function delegationPayload(state: SessionState): JsonObject | undefined {
  const event = state.allEvents().filter((e) => e.kind === "tool_result" && e.payload["name"] === DELEGATE_TO_AGENT).at(-1);
  const context = event?.payload["generation_context"] as { data?: JsonObject } | undefined;
  return context?.data?.["delegation"] as JsonObject | undefined;
}

test("a delegated round comes back as the delegate's account, and nothing else", async () => {
  const { top, state } = harness({
    [CALLER]: [[{ name: DELEGATE_TO_AGENT, input: { agent: CALLEE, task: "what moves AWS demand through 2030" } }]],
    [CALLEE]: [
      [{ name: "financial_search", input: { query: "aws demand" } }],
      [{ name: "finish", input: { summary: "Capacity, not demand, is the 2026 constraint." } }],
    ],
  });

  await top.dispatch([{ agent: CALLER, task: "value AMZN" }]);

  const delegation = delegationPayload(state);
  assert.ok(delegation, "the caller must receive the delegation payload");
  assert.equal(delegation["agent"], CALLEE);
  assert.equal(delegation["status"], "ok");
  assert.equal(delegation["summary"], "Capacity, not demand, is the 2026 constraint.");
  // The point of delegating: the callee's own generation_context is `{ task, tool_outputs: [...] }`,
  // every payload it collected. Handing that over would put the full text of each search into the
  // caller's progress region — the cost this whole path exists to avoid.
  assert.equal(delegation["data"], undefined);
  assert.ok(!JSON.stringify(delegation).includes("TWENTY THOUSAND CHARACTERS"));
});

test("the returned thread continues the same conversation instead of opening a second one", async () => {
  const script: Script = {
    [CALLER]: [[{ name: DELEGATE_TO_AGENT, input: { agent: CALLEE, task: "first round" } }]],
    [CALLEE]: [[{ name: "finish", input: { summary: "round one" } }]],
  };
  const { top, state } = harness(script);
  // Resolved when the provider asks for it, by which time round one has reported its thread.
  script[CALLER]!.push(() => [{
    name: DELEGATE_TO_AGENT,
    input: { agent: CALLEE, task: "press the capacity point further", thread: String(delegationPayload(state)!["thread"]) },
  }]);

  await top.dispatch([{ agent: CALLER, task: "value AMZN" }]);

  const rounds = state.allEvents()
    .filter((e) => e.kind === "tool_result" && e.payload["name"] === DELEGATE_TO_AGENT)
    .map((e) => (e.payload["generation_context"] as { data?: JsonObject }).data!["delegation"] as JsonObject);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[1]!["status"], "ok");
  assert.equal(rounds[0]!["thread"], rounds[1]!["thread"], "the second round must land on the first round's thread");
  assert.notEqual(rounds[0]!["task_id"], rounds[1]!["task_id"], "and be its own round on that thread");
  assert.equal(state.liveThreads().filter((t) => t.agent === CALLEE).length, 1);
});

test("a thread this session never opened fails the call rather than silently starting over", async () => {
  const { top, state } = harness({
    [CALLER]: [[{ name: DELEGATE_TO_AGENT, input: { agent: CALLEE, task: "again", thread: "s:market_research:9" } }]],
  });

  await top.dispatch([{ agent: CALLER, task: "value AMZN" }]);

  assert.equal(delegationPayload(state)?.["status"], "failed");
});

test("a delegated round always leaves a task_result behind", async () => {
  // The hand-rolled nested path does not: a throw inside it leaves the dispatch with no result,
  // so state.task() reports "running" forever and the thread stays live for anyone to continue into.
  const { top, state } = harness({
    [CALLER]: [[{ name: DELEGATE_TO_AGENT, input: { agent: CALLEE, task: "go" } }]],
    [CALLEE]: [[{ name: "not_a_tool", input: {} }], [{ name: "finish", input: { summary: "recovered" } }]],
  });

  await top.dispatch([{ agent: CALLER, task: "value AMZN" }]);

  const taskId = delegationPayload(state)?.["task_id"] as string;
  assert.equal(state.task(taskId)?.status, "ok");
});

test("a name outside the delegable set is refused before anything is dispatched", async () => {
  const { top, state } = harness({
    [CALLER]: [[{ name: DELEGATE_TO_AGENT, input: { agent: "market_data", task: "go" } }]],
  });

  await top.dispatch([{ agent: CALLER, task: "value AMZN" }]);

  // The runtime's roster gate fires first, so execute is never reached and no dispatch is recorded.
  const refusal = state.allEvents().find((e) => e.kind === "tool_result"
    && (e.payload["error"] as { code?: string } | undefined)?.code === "agent_not_allowed");
  assert.ok(refusal, "an off-roster delegate must be refused");
  assert.equal(state.allEvents().filter((e) => e.kind === "dispatch" && e.payload["agent"] === "market_data").length, 0);
});

test("ask_user is stripped from a delegated run", async () => {
  // A nested question has nowhere to go: it ends the callee's turn, is resumed by the ORCHESTRATOR
  // re-dispatching that thread, and the caller is blocked inside execute meanwhile.
  const { top, state } = harness(
    { [CALLER]: [[{ name: DELEGATE_TO_AGENT, input: { agent: CALLEE, task: "go" } }]],
      [CALLEE]: [[{ name: "ask_user", input: {} }], [{ name: "finish", input: { summary: "no question asked" } }]] },
    { calleeTools: ["financial_search", "ask_user"] },
  );

  await top.dispatch([{ agent: CALLER, task: "value AMZN" }]);

  const invalid = state.allEvents().find((e) => e.kind === "tool_result"
    && (e.payload["error"] as { code?: string } | undefined)?.code === "invalid_tool");
  assert.ok(invalid, "ask_user must not be in the delegated pool");
});

test("a delegate that runs past its policy timeout fails the call rather than hanging it", async () => {
  const { top, state } = harness(
    { [CALLER]: [[{ name: DELEGATE_TO_AGENT, input: { agent: CALLEE, task: "go" } }]],
      [CALLEE]: [[{ name: "financial_search", input: {} }], [{ name: "finish", input: { summary: "late" } }]] },
    { slowCalleeMs: 40 },
  );
  // The policy's own ceiling, not taskTimeoutMs's per-agent default.
  const subagents = (top as unknown as { subagents: SubagentRegistry }).subagents;
  subagents.get(CALLEE).delegable!.timeoutMs = 1;

  await top.dispatch([{ agent: CALLER, task: "value AMZN" }]);

  const delegation = delegationPayload(state);
  assert.equal(delegation?.["status"], "timeout");
  assert.equal(state.task(delegation?.["task_id"] as string)?.status, "timeout");
});
