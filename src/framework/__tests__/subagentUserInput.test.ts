import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState, SessionRegistry } from "../sessionState.ts";
import { SubagentRegistry, SubagentRuntime } from "../subagent.ts";
import { OrchestratorRuntime } from "../orchestrator.ts";
import { SkillRegistry } from "../skill.ts";
import { createSubagentRegistry } from "../../agent/subagents/registerSubagents.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateOptions, GenerateResult, LlmMessage, LlmProvider, LlmToolCall } from "../../infra/llm/provider.ts";
import type { TaskRequest, ToolDefinition, UserInputRequest } from "../types.ts";

/**
 * `ask_user` reaches exactly one subagent — financial_modeling — and only when a
 * human is watching the stream. These tests pin both halves of that, plus the
 * turn-ending plumbing: an ask from inside a subagent has to surface as the
 * turn's `user_input_required` event, or the questions are recorded in the
 * sidechain and never rendered.
 */

const askUserOutput = (): { summary: string; user_input_request: UserInputRequest } => ({
  summary: "Waiting for the user to answer 1 question.",
  user_input_request: {
    request_id: "input_test",
    questions: [{
      id: "basis",
      question: "Which revenue basis?",
      options: [{ id: "gaap", label: "GAAP" }, { id: "adj", label: "Adjusted" }],
      min_selections: 1,
      max_selections: 1,
    }],
  },
});

function toolRegistry(): McpToolRegistry {
  const tools = new McpToolRegistry();
  tools.register({
    name: "ask_user",
    description: "d",
    category: "main",
    inputSchema: { type: "object" },
    execute: async () => askUserOutput(),
  });
  for (const name of ["get_financial_model", "financial_search"]) {
    tools.register({
      name,
      description: "d",
      category: "non_trading",
      inputSchema: { type: "object" },
      execute: async () => ({ summary: `${name} ok` }),
    });
  }
  return tools;
}

// ── the grant ────────────────────────────────────────────────────────────

test("only financial_modeling carries ask_user in its default pool", () => {
  const registry = createSubagentRegistry();
  const withAskUser = registry.list().filter((d) => d.defaultTools.includes("ask_user")).map((d) => d.name);

  assert.deepEqual(withAskUser, ["financial_modeling"]);
});

// ── the suppression ──────────────────────────────────────────────────────

function dispatcherHarness(): {
  dispatcher: Dispatcher;
  seen: { request: TaskRequest; allowedTools: ToolDefinition[] }[];
} {
  const seen: { request: TaskRequest; allowedTools: ToolDefinition[] }[] = [];
  const subagents = new SubagentRegistry();
  subagents.register({
    name: "financial_modeling",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: ["get_financial_model", "ask_user"],
    systemPrompt: { system: "", prompt: "" },
  });
  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  const runtime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest; allowedTools: ToolDefinition[] }) => {
      seen.push({ request: ctx.request, allowedTools: ctx.allowedTools });
    },
  };
  return { dispatcher: new Dispatcher("s", subagents, runtime as never, toolRegistry(), state, "agent-1"), seen };
}

test("ask_user stays in the pool while a human is watching", async () => {
  const { dispatcher, seen } = dispatcherHarness();

  await dispatcher.dispatch([{ agent: "financial_modeling", task: "value AAPL" }]);

  assert.ok(seen[0]!.allowedTools.some((t) => t.name === "ask_user"));
});

test("ask_user is dropped from the pool in an agent-to-agent run", async () => {
  const { dispatcher, seen } = dispatcherHarness();
  dispatcher.setUserInputAllowed(false);

  await dispatcher.dispatch([{ agent: "financial_modeling", task: "value AAPL" }]);

  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name), ["get_financial_model"]);
});

test("explicitly requesting ask_user in an agent-to-agent run fails the task", async () => {
  const { dispatcher, seen } = dispatcherHarness();
  dispatcher.setUserInputAllowed(false);

  await dispatcher.dispatch([{ agent: "financial_modeling", task: "value AAPL", tools: ["ask_user"] }]);

  assert.equal(seen.length, 0);
});

// ── the subagent runtime ─────────────────────────────────────────────────

function subagentHarness(steps: LlmToolCall[][]): { runtime: SubagentRuntime; state: SessionState; tools: McpToolRegistry } {
  let call = 0;
  const provider: LlmProvider = {
    name: "stub",
    async generate(_messages: LlmMessage[], _options: GenerateOptions): Promise<GenerateResult> {
      const toolCalls = steps[call] ?? [{ name: "finish", input: { summary: "done" } }];
      call += 1;
      return { text: "", toolCalls, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };
  const tools = toolRegistry();
  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  return { runtime: new SubagentRuntime(new ModelRouter(provider), tools), state, tools };
}

const financialModeling = {
  name: "financial_modeling" as const,
  description: "d",
  modelClass: "MEDIUM" as const,
  defaultTools: ["get_financial_model", "ask_user"],
  systemPrompt: { system: "s", prompt: "{{task}} {{modelContext}} {{progress}}" },
};

async function runSubagent(runtime: SubagentRuntime, state: SessionState, tools: McpToolRegistry): Promise<string> {
  const thread = state.openThread("financial_modeling");
  const dispatch = state.recordDispatch("financial_modeling", "value AAPL", thread);
  await runtime.run(financialModeling, {
    sessionId: "s",
    tenantId: "agent-1",
    taskId: dispatch.event_id,
    request: { agent: "financial_modeling", task: "value AAPL" },
    allowedTools: ["get_financial_model", "ask_user"].map((name) => {
      const { execute: _execute, ...definition } = tools.get(name)!;
      return definition;
    }),
    state,
    threadId: thread,
  });
  return dispatch.event_id;
}

test("a subagent ask_user surfaces as the turn's user_input_required event", async () => {
  const { runtime, state, tools } = subagentHarness([[{ name: "ask_user", input: { questions: [] } }]]);

  await runSubagent(runtime, state, tools);

  const view = state.userInputRequestForTurn(1);
  assert.equal(view?.request_id, "input_test");
  assert.equal(view?.status, "pending");
});

test("the question is attributed to the subagent, not to the orchestrator channel it rode", async () => {
  const { runtime, state, tools } = subagentHarness([[{ name: "ask_user", input: { questions: [] } }]]);

  await runSubagent(runtime, state, tools);

  assert.equal(state.userInputRequestForTurn(1)?.asked_by, "financial_modeling");
});

test("the ask pauses the task instead of failing it, and the summary says so", async () => {
  const { runtime, state, tools } = subagentHarness([[{ name: "ask_user", input: { questions: [] } }]]);

  await runSubagent(runtime, state, tools);

  const result = state.turnResults(1)[0]!;
  assert.equal(result.status, "ok");
  // A pause, not a failure — and the summary hands the caller the thread it
  // needs to name to resume it.
  assert.match(result.summary, /^Paused on 1 question for the user; dispatch thread s:financial_modeling:1 again/);
});

test("the subagent stops calling tools once it has asked", async () => {
  const calls: string[] = [];
  const { runtime, state, tools } = subagentHarness([
    [{ name: "ask_user", input: { questions: [] } }],
    [{ name: "get_financial_model", input: {} }],
  ]);
  tools.get("get_financial_model")!.execute = async () => { calls.push("get_financial_model"); return { summary: "ok" }; };

  await runSubagent(runtime, state, tools);

  assert.deepEqual(calls, []);
});

test("ask_user alongside another call is refused, and nothing is asked", async () => {
  const { runtime, state, tools } = subagentHarness([
    [{ name: "ask_user", input: { questions: [] } }, { name: "get_financial_model", input: {} }],
    [{ name: "finish", input: { summary: "done" } }],
  ]);

  const taskId = await runSubagent(runtime, state, tools);

  assert.equal(state.userInputRequestForTurn(1), undefined);
  const errors = state.subagentToolErrors({ task: taskId });
  assert.ok(errors.some((e) => e.code === "user_input_must_be_solo"));
});

// ── resuming after the answer ────────────────────────────────────────────

/**
 * The question pauses the task; it does not end the work. The run that comes
 * back answers a new dispatch inside the SAME thread, so the agent returns to
 * its own notes instead of re-deriving everything from the model.
 */
function resumeHarness(steps: LlmToolCall[][]): { dispatcher: Dispatcher; state: SessionState; prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  const provider: LlmProvider = {
    name: "stub",
    async generate(messages: LlmMessage[]): Promise<GenerateResult> {
      prompts.push(messages.map((m) => m.content).join("\n"));
      const toolCalls = steps[call] ?? [{ name: "finish", input: { summary: "done" } }];
      call += 1;
      return { text: `note for step ${call}`, toolCalls, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };
  const subagents = new SubagentRegistry();
  subagents.register(financialModeling);
  const tools = toolRegistry();
  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("value AAPL");
  const runtime = new SubagentRuntime(new ModelRouter(provider), tools);
  return { dispatcher: new Dispatcher("s", subagents, runtime, tools, state, "agent-1"), state, prompts };
}

/** The id of the one thread the harness has opened so far. */
function onlyThread(state: SessionState): string {
  const threads = state.liveThreads();
  assert.equal(threads.length, 1, "expected exactly one thread open");
  return threads[0]!.thread_id;
}

/** The user answers the question the subagent asked. */
function answerQuestion(state: SessionState, text: string): void {
  state.beginTurn(text, {
    request_id: "input_test",
    answers: [{ question_id: "basis", selected_option_ids: ["gaap"] }],
  });
}

test("dispatching the same thread again after the answer continues the paused work", async () => {
  const h = resumeHarness([
    [{ name: "get_financial_model", input: {} }],
    [{ name: "ask_user", input: { questions: [] } }],
  ]);

  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "value AAPL" }]);
  assert.equal(h.state.userInputRequestForTurn(1)?.status, "pending");
  const thread = onlyThread(h.state);

  answerQuestion(h.state, "Which revenue basis?: GAAP");
  const before = h.prompts.length;
  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "GAAP basis; continue", thread }]);

  const resumedPrompt = h.prompts[before]!;
  assert.match(resumedPrompt, /note for step 1/, "the continuing run should see its own pre-question notes");
  assert.match(resumedPrompt, /\[resumed\]/, "the seam should be marked so the restarted step count reads correctly");
});

test("the question is tagged with the thread it came from, so the answer can be routed back", async () => {
  const h = resumeHarness([[{ name: "ask_user", input: { questions: [] } }]]);

  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "value AAPL" }]);

  const asked = h.state.allEvents().find((e) => e.kind === "user_input_required")!;
  // On the MAIN thread — that is what puts the card in front of the user —
  // but carrying where it came from.
  assert.equal(asked.thread_id, h.state.mainThread);
  assert.equal(asked.payload.from_thread, onlyThread(h.state));
});

test("a later round of the same thread reads as new work, not as a re-answered question", async () => {
  const h = resumeHarness([[{ name: "ask_user", input: { questions: [] } }]]);

  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "value AAPL" }]);
  const thread = onlyThread(h.state);
  answerQuestion(h.state, "Which revenue basis?: GAAP");
  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "GAAP basis; continue", thread }]);

  // Round 3: the answered question is behind it now. The agent still gets the
  // thread's history, but must not be told a question was just answered — that
  // is how an agent ends up answering the same question twice.
  const before = h.prompts.length;
  h.state.beginTurn("now do the sensitivities");
  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "sensitivities", thread }]);

  const prompt = h.prompts[before]!;
  // Round 2's "[resumed]" note is still in the replayed history, and should be
  // — that is what the thread remembers. What matters is which seam is the most
  // recent one, because that is the one describing THIS round.
  assert.ok(prompt.lastIndexOf("[new round]") > prompt.lastIndexOf("[resumed]"),
    "the newest seam should say new work, not that a question was just answered");
  assert.match(prompt, /sensitivities/);
});

test("a dispatch that names no thread starts blank", async () => {
  const h = resumeHarness([[{ name: "ask_user", input: { questions: [] } }]]);

  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "value AAPL" }]);
  answerQuestion(h.state, "Which revenue basis?: GAAP");
  const before = h.prompts.length;
  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "now value MSFT instead" }]);

  const prompt = h.prompts[before]!;
  assert.doesNotMatch(prompt, /\[resumed\]/);
  assert.doesNotMatch(prompt, /note for step 1/);
  assert.equal(h.state.liveThreads().length, 2, "unrelated work gets its own thread");
});

test("each run still reports its own task_result, so the pause and the finish are distinct", async () => {
  const h = resumeHarness([
    [{ name: "ask_user", input: { questions: [] } }],
  ]);

  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "value AAPL" }]);
  const thread = onlyThread(h.state);
  answerQuestion(h.state, "Which revenue basis?: GAAP");
  await h.dispatcher.dispatch([{ agent: "financial_modeling", task: "GAAP basis; continue", thread }]);

  assert.match(h.state.turnResults(1)[0]!.summary, /^Paused on 1 question/);
  // Written against the resuming dispatch, not swallowed by the paused task's
  // own (idempotent) result.
  assert.equal(h.state.turnResults(2)[0]!.summary, "done");
});

// ── the orchestrator turn ────────────────────────────────────────────────

test("a subagent's pending question ends the orchestrator turn", async () => {
  const subagents = new SubagentRegistry();
  subagents.register(financialModeling);
  const tools = toolRegistry();
  tools.register({ name: "read_skill_reference", description: "d", category: "main", inputSchema: { type: "object" }, execute: async () => ({ summary: "ok" }) });
  const sessions = new SessionRegistry();

  const subagentRuntime = {
    run: async (_definition: unknown, ctx: { state: SessionState; taskId: string }) => {
      ctx.state.recordUserInputRequest(askUserOutput().user_input_request);
      ctx.state.recordTaskResult("financial_modeling", ctx.taskId, {
        task_id: ctx.taskId,
        agent: "financial_modeling",
        status: "ok",
        summary: "Waiting for the user to answer 1 question; resume model m1.",
      });
    },
  };
  const dispatcherFactory = (sessionId: string, tenantId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime as never, tools, sessions.getExisting(sessionId), tenantId);

  const steps = [
    JSON.stringify({ reply: "building", tool_calls: [{ name: "delegate_to_agent", input: { agent: "financial_modeling", task: "value AAPL" } }] }),
    JSON.stringify({ reply: "should never be reached", tool_calls: [{ name: "delegate_to_agent", input: { agent: "financial_modeling", task: "again" } }] }),
  ];
  let call = 0;
  const provider: LlmProvider = {
    name: "stub",
    async generate(): Promise<GenerateResult> {
      const text = steps[call] ?? JSON.stringify({ reply: "done" });
      call += 1;
      return { text, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "LARGE", provider: "stub" } };
    },
  };
  const orchestrator = new OrchestratorRuntime(
    { system: "", prompt: "" }, new ModelRouter(provider), dispatcherFactory, subagents, new SkillRegistry(), tools, sessions,
  );

  await orchestrator.run({ tenantId: "agent-1", sessionId: "s", userMessage: "value AAPL" });

  assert.equal(call, 1, "the orchestrator kept looping after its subagent asked the user");
  const state = sessions.getExisting("s");
  assert.equal(state.userInputRequestForTurn(1)?.status, "pending");
});
