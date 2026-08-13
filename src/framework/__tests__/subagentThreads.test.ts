import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { AgentKind, TaskRequest } from "../types.ts";

/**
 * A subagent thread is a conversation that outlives one dispatch: the
 * orchestrator can hand the same agent more work and have it come back to what
 * it already did, instead of starting from nothing every time.
 *
 * These cover the addressing rules — who mints an id, what it means, and what
 * happens when the orchestrator names one that does not exist. The replay
 * behaviour itself lives in subagentUserInput.test.ts.
 */

function harness(): { dispatcher: Dispatcher; state: SessionState; seen: { request: TaskRequest; threadId: string }[] } {
  const seen: { request: TaskRequest; threadId: string }[] = [];
  const subagents = new SubagentRegistry();
  for (const name of ["market_data", "market_research"] as AgentKind[]) {
    subagents.register({ name, description: "d", modelClass: "MEDIUM", defaultTools: ["probe"],
      systemPrompt: { system: "", prompt: "" } });
  }
  const tools = new McpToolRegistry();
  tools.register({ name: "probe", description: "d", category: "non_trading",
    inputSchema: { type: "object" }, execute: async () => ({ summary: "ok" }) });

  const state = new SessionState("room_1", new Date().toISOString());
  state.beginTurn("go");
  const runtime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest; threadId: string; taskId: string }) => {
      seen.push({ request: ctx.request, threadId: ctx.threadId });
      ctx.request.agent && state.recordTaskResult(ctx.request.agent, ctx.taskId, {
        task_id: ctx.taskId, agent: ctx.request.agent, status: "ok", summary: "ok",
      });
    },
  };
  return { dispatcher: new Dispatcher("room_1", subagents, runtime as never, tools, state, "agent-1"), state, seen };
}

test("a dispatch with no thread opens one, named for the topic and the agent", async () => {
  const h = harness();

  await h.dispatcher.dispatch([{ agent: "market_data", task: "fetch AAPL" }]);

  assert.equal(h.seen[0]!.threadId, "room_1:market_data:1");
  assert.deepEqual(h.state.liveThreads().map((t) => t.thread_id), ["room_1:market_data:1"]);
});

test("naming an existing thread continues it rather than opening another", async () => {
  const h = harness();
  await h.dispatcher.dispatch([{ agent: "market_data", task: "fetch AAPL" }]);

  await h.dispatcher.dispatch([{ agent: "market_data", task: "now the volume", thread: "room_1:market_data:1" }]);

  assert.deepEqual(h.seen.map((s) => s.threadId), ["room_1:market_data:1", "room_1:market_data:1"]);
  const threads = h.state.liveThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.rounds, 2, "both dispatches count as rounds of the same conversation");
});

test("subagent progress retains a failed tool's code and structured correction details", () => {
  const state = new SessionState("room_1", new Date().toISOString());
  state.beginTurn("build DCF");
  const thread = state.openThread("financial_modeling");
  const task = state.recordDispatch("financial_modeling", "complete FCFF", thread).event_id;
  state.record("financial_modeling", "tool_result", {
    task_id: task, name: "apply_financial_model_operations", summary: "fcff incomplete",
    error: { code: "missing_formula_input", message: "fcff is incomplete at the requested stage" },
    generation_context: { data: { error: "missing_formula_input", refs: ["fcff@FY2027", "fcff@FY2028"] } },
  }, { threadId: thread, parent: task });

  const progress = state.subagentProgress({ thread });
  assert.match(progress, /error\(missing_formula_input\)/);
  assert.match(progress, /fcff@FY2027/);
  assert.match(progress, /fcff@FY2028/);
});

test("two tasks for one agent in the same step get separate threads", async () => {
  const h = harness();

  // Parallel dispatch: the numbering must not collide even though neither task
  // has finished when the other starts.
  await h.dispatcher.dispatch([
    { agent: "market_data", task: "fetch AAPL" },
    { agent: "market_data", task: "fetch MSFT" },
  ]);

  assert.deepEqual(h.seen.map((s) => s.threadId).sort(),
    ["room_1:market_data:1", "room_1:market_data:2"]);
});

test("each agent numbers its own threads", async () => {
  const h = harness();

  await h.dispatcher.dispatch([
    { agent: "market_data", task: "fetch AAPL" },
    { agent: "market_research", task: "read the news" },
  ]);

  assert.deepEqual(h.seen.map((s) => s.threadId).sort(),
    ["room_1:market_data:1", "room_1:market_research:1"]);
});

test("naming a thread that does not exist fails the task instead of starting over quietly", async () => {
  const h = harness();

  await h.dispatcher.dispatch([{ agent: "market_data", task: "continue", thread: "room_1:market_data:7" }]);

  assert.deepEqual(h.seen, [], "the subagent never runs");
  const result = h.state.turnResults(1)[0]!;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "thread_not_found");
  // The orchestrator reads this back next step and can correct itself.
  assert.match(result.summary, /omit "thread" to start a new one/);
});

test("handing one agent's thread to another agent fails the task", async () => {
  const h = harness();
  await h.dispatcher.dispatch([{ agent: "market_data", task: "fetch AAPL" }]);

  await h.dispatcher.dispatch([{ agent: "market_research", task: "continue", thread: "room_1:market_data:1" }]);

  const result = h.state.turnResults(1)[1]!;
  assert.equal(result.error?.code, "thread_agent_mismatch");
  assert.match(result.summary, /belongs to market_data, not market_research/);
});

test("the orchestrator's own history echoes the thread each dispatch went into", async () => {
  const h = harness();
  await h.dispatcher.dispatch([{ agent: "market_data", task: "fetch AAPL" }]);

  // This is how the orchestrator learns the id of a thread it just opened —
  // there is no separate return channel from dispatch.
  const progress = h.state.projectForPrompt(1).currentTurnProgress;
  assert.match(progress, /\[dispatch → market_data thread=room_1:market_data:1\] fetch AAPL/);
});

test("a subagent's own events stay off the main thread", async () => {
  const h = harness();
  await h.dispatcher.dispatch([{ agent: "market_data", task: "fetch AAPL" }]);
  h.state.record("market_data", "subagent_note", { task_id: "t", step: 1, note: "thinking" },
    { threadId: "room_1:market_data:1" });

  // The dispatch and its result are the orchestrator's business; the note is not.
  const mainKinds = h.state.allEvents().filter((e) => e.thread_id === h.state.mainThread).map((e) => e.kind);
  assert.deepEqual(mainKinds, ["user_message", "dispatch", "task_result"]);
  assert.doesNotMatch(h.state.projectForPrompt(1).currentTurnProgress, /thinking/);
});

// ── scope: what a prompt sees vs. what a result reports ──────────────────

test("prompt scope spans the thread; result scope is one round", () => {
  const state = new SessionState("room_1", new Date().toISOString());
  state.beginTurn("go");
  const thread = state.openThread("market_data");
  const round1 = state.recordDispatch("market_data", "round one", thread).event_id;
  state.record("market_data", "tool_result", { task_id: round1, name: "probe", summary: "first" }, { threadId: thread });
  const round2 = state.recordDispatch("market_data", "round two", thread).event_id;
  state.record("market_data", "tool_result", { task_id: round2, name: "probe", summary: "second" }, { threadId: thread });

  // The agent's prompt: everything it has done here.
  assert.match(state.subagentProgress({ thread }), /first[\s\S]*second/);
  // The round's own result: only this round's work, or every later result would
  // re-attach every earlier round's artifacts.
  assert.deepEqual(state.subagentToolOutputs({ task: round2 }).map((o) => o.summary), ["second"]);
});

test("a thread summary is a barrier: folded rounds stop being replayed", () => {
  const state = new SessionState("room_1", new Date().toISOString());
  state.beginTurn("go");
  const thread = state.openThread("market_data");
  const task = state.recordDispatch("market_data", "work", thread).event_id;
  state.record("market_data", "tool_result", { task_id: task, name: "probe", summary: "ancient history" }, { threadId: thread });
  state.record("market_data", "subagent_note", { task_id: task, step: 0, thread_summary: true,
    note: "[earlier in this thread, summarized] it looked at AAPL" }, { threadId: thread });
  state.record("market_data", "tool_result", { task_id: task, name: "probe", summary: "recent" }, { threadId: thread });

  const progress = state.subagentProgress({ thread });
  assert.doesNotMatch(progress, /ancient history/, "folded rounds must not also be replayed verbatim");
  assert.match(progress, /it looked at AAPL/);
  assert.match(progress, /recent/);
});
