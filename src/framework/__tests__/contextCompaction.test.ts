import assert from "node:assert/strict";
import test from "node:test";
import { compact, compactTaskResultData, maybeCompact, maybeCompactThread } from "../contextCompaction.ts";
import { InMemoryEventStore } from "../eventStore.ts";
import { SessionState } from "../sessionState.ts";

test("task-result indexes retain a durable pointer and shape, not raw structured payloads", () => {
  const indexed = compactTaskResultData({
    event_id: "ev_result",
    parent_event_id: "ev_dispatch",
    payload: {
      status: "ok",
      summary: "Loaded AAPL history.",
      generation_context: { data: {
        symbol: "AAPL",
        prices: [101, 102, 103],
        nested: { exact: 98_700_000_000 },
      } },
    },
  });

  assert.equal(indexed.source_event_id, "ev_result");
  assert.equal(indexed.task_id, "ev_dispatch");
  assert.deepEqual(indexed.data_keys, ["symbol", "prices", "nested"]);
  assert.equal((indexed.data_shape as { prices: string }).prices, "array(3)");
  assert.equal(JSON.stringify(indexed).includes("98_700_000_000"), false);
});

test("computed statistics are kept whole while the series they came from is left to a read", () => {
  const indexed = compactTaskResultData({
    event_id: "ev_result",
    parent_event_id: null,
    payload: {
      status: "ok",
      summary: "Loaded AAPL history.",
      generation_context: { data: {
        // The eleven top-level quote scalars a twelve-FIELD cap used to spend itself on.
        symbol: "AAPL", price: 225.1, bidPrice: 225, askPrice: 225.2, dayOpen: 224, dayHigh: 226,
        dayLow: 223.5, prevClose: 224.4, changePercent: 0.31, volume: 51_200_000,
        marketSession: "regular", quoteTimestamp: "2026-08-12T20:00:00Z",
        daily: {
          recentBars: Array.from({ length: 7 }, (_, i) => ({ t: `2026-08-0${i + 1}`, c: 220 + i })),
          trend: { t: Array.from({ length: 120 }, (_, i) => `2026-01-${i}`), c: Array.from({ length: 120 }, (_, i) => 100 + i) },
          stats: { count: 250, trueHigh: { value: 125.9, t: "2025-09-07" }, maxDrawdownPct: 7.4, sma50: 122.95 },
        },
      } },
    },
  });

  const values = indexed.values as Record<string, unknown>;
  assert.deepEqual(values["daily.stats"], { count: 250, trueHigh: { value: 125.9, t: "2025-09-07" }, maxDrawdownPct: 7.4, sma50: 122.95 },
    "the computed figures a later turn quotes survive verbatim");
  assert.equal(values.symbol, "AAPL");
  assert.equal(values["daily.trend"], undefined, "the downsampled series is shape only");
  assert.equal(JSON.stringify(indexed).includes("2026-01-119"), false);
  assert.equal((indexed.data_shape as { daily: string }).daily, "object(3)");
});

test("session compaction stores indexes while the durable task event keeps exact data", async () => {
  const store = new InMemoryEventStore();
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z", store);
  state.beginTurn("Check AAPL");
  const dispatch = state.recordDispatch("market_data", "Get price", state.openThread("market_data"));
  const result = state.recordTaskResult("market_data", dispatch.event_id, {
    task_id: dispatch.event_id,
    agent: "market_data",
    status: "ok",
    summary: "Loaded AAPL price.",
    generation_context: { data: { symbol: "AAPL", dailyBars: Array.from({ length: 100 }, (_, i) => i) } },
  });

  await compact(state, { generate: async () => ({ text: "AAPL was checked.", metrics: {} }) } as never, 1, 1);
  const entry = state.compactionCache()!.preservedData[0]!;
  assert.equal(entry.sourceEventId, result.event_id);
  assert.equal((entry.data.data_shape as { dailyBars: string }).dailyBars, "array(100)");
  assert.equal(JSON.stringify(entry.data).includes("98,99"), false);

  const durable = await store.loadEvents("room_1");
  const original = durable.find((event) => event.event_id === result.event_id)!;
  assert.equal(((original.payload.generation_context as { data: { dailyBars: number[] } }).data.dailyBars).length, 100);
});

test("cold restore reapplies the compact cutoff instead of injecting summary and original events together", () => {
  const original = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  original.beginTurn("ORIGINAL_USER_TEXT_SHOULD_NOT_REPLAY");
  const dispatch = original.recordDispatch("market_data", "Get price", original.openThread("market_data"));
  original.recordTaskResult("market_data", dispatch.event_id, {
    task_id: dispatch.event_id,
    agent: "market_data",
    status: "ok",
    summary: "ORIGINAL_TASK_SUMMARY_SHOULD_NOT_REPLAY",
    generation_context: { data: { dailyBars: Array.from({ length: 100 }, (_, i) => i) } },
  });
  original.recordReply("ORIGINAL_REPLY_SHOULD_NOT_REPLAY", true);
  const cache = {
    summarizedThroughTurn: 1,
    summaryText: "The prior AAPL discussion was compacted.",
    preservedData: [{ turn: 1, agent: "market_data", sourceEventId: "ev_result", data: {
      kind: "task_result_index", source_event_id: "ev_result", data_keys: ["dailyBars"], data_shape: { dailyBars: "array(100)" },
    } }],
  };

  const restored = SessionState.restore("room_1", original.started_at, [...original.allEvents()], cache, undefined);
  const history = restored.projectForPrompt(2).conversationSoFar;

  assert.match(history, /prior AAPL discussion was compacted/);
  assert.doesNotMatch(history, /ORIGINAL_USER_TEXT_SHOULD_NOT_REPLAY/);
  assert.doesNotMatch(history, /ORIGINAL_TASK_SUMMARY_SHOULD_NOT_REPLAY/);
  assert.doesNotMatch(history, /ORIGINAL_REPLY_SHOULD_NOT_REPLAY/);
  assert.doesNotMatch(history, /dailyBars.*0.*99/);
});

test("threshold compaction preserves the current turn and the configured recent-turn tail verbatim", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  for (let turn = 1; turn <= 5; turn++) {
    state.beginTurn(`user turn ${turn}`);
    state.recordReply(`reply turn ${turn}`, true);
  }
  state.recordPromptTokens(200_000);

  await maybeCompact(state, { generate: async () => ({ text: "Older context.", metrics: {} }) } as never, state.currentTurn);

  const remainingTurns = [...new Set(state.allEvents().map((event) => event.turn))];
  assert.deepEqual(remainingTurns, [2, 3, 4, 5]);
  assert.equal(state.compactionCache()?.summarizedThroughTurn, 1);
});

test("a thread stays addressable and remembers its work after its opening turn is compacted", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  state.beginTurn("turn 1");
  const thread = state.openThread("market_data");
  const taskId = state.recordDispatch("market_data", "round 1", thread).event_id;
  state.record("market_data", "tool_result", { task_id: taskId, name: "probe", summary: "ROUND1_EVIDENCE" }, { threadId: thread });
  state.recordTaskResult("market_data", taskId, { task_id: taskId, agent: "market_data", status: "ok", summary: "ROUND1_RESULT" });
  state.recordReply("done", true);
  for (let turn = 2; turn <= 5; turn++) {
    state.beginTurn(`turn ${turn}`);
    state.recordReply(`reply ${turn}`, true);
  }

  await compact(state, { generate: async () => ({ text: "Turn 1 was compacted.", metrics: {} }) } as never, 1, 1);

  assert.deepEqual(state.liveThreads().map((t) => t.thread_id), [thread], "the orchestrator can still name the thread");
  assert.equal(state.liveThreads()[0]?.status, "ok", "and still sees how its last round ended");
  assert.match(state.subagentProgress({ thread }), /ROUND1_EVIDENCE/, "resuming it must not meet an amnesiac agent");
  // Retaining those events must not put the compacted turn back into the prompt.
  const history = state.projectForPrompt(6).conversationSoFar;
  assert.match(history, /Turn 1 was compacted/);
  assert.doesNotMatch(history, /ROUND1_RESULT/);
  assert.doesNotMatch(history, /round 1/);
});

/** One task result carrying `data`, recorded on its own dispatch. */
function recordTask(state: SessionState, agent: "market_data" | "financial_modeling", data: Record<string, unknown>): string {
  const dispatch = state.recordDispatch(agent, "work", state.openThread(agent));
  return state.recordTaskResult(agent, dispatch.event_id, {
    task_id: dispatch.event_id, agent, status: "ok", summary: "done",
    generation_context: { data: data as never },
  }).event_id;
}

test("repeated work on one entity collapses into a single indexed row with a call count", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  state.beginTurn("build the model");
  for (const revision of [1, 2, 3]) recordTask(state, "financial_modeling", { model_id: "fm_7", revision, rows: [1, 2, 3] });
  recordTask(state, "market_data", { symbol: "AAPL", bars: [1, 2] });
  const latest = recordTask(state, "market_data", { symbol: "AAPL", bars: [1, 2, 3, 4] });

  await compact(state, { generate: async () => ({ text: "summary", metrics: {} }) } as never, 1, 1);
  const preserved = state.compactionCache()!.preservedData;

  assert.equal(preserved.length, 2, "one row per distinct piece of work, not per call");
  const model = preserved.find((entry) => entry.agent === "financial_modeling")!;
  assert.equal(model.data.calls, 3);
  assert.equal((model.data.values as { revision: number }).revision, 3, "the newest production wins the row");
  const quote = preserved.find((entry) => entry.agent === "market_data")!;
  assert.equal(quote.data.calls, 2);
  assert.equal(quote.sourceEventId, latest, "and the pointer follows the newest");
  assert.equal((quote.data.data_shape as { bars: string }).bars, "array(4)");
});

test("different work never merges, and merging carries across compactions", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  const generate = async () => ({ text: "summary", metrics: {} });
  state.beginTurn("turn 1");
  recordTask(state, "market_data", { symbol: "AAPL", bars: [1] });
  recordTask(state, "market_data", { symbol: "MSFT", bars: [1] });
  recordTask(state, "market_data", { symbol: "AAPL", news: ["x"] });
  await compact(state, { generate } as never, 1, 1);
  assert.equal(state.compactionCache()!.preservedData.length, 3, "different entity or different keys is different work");

  state.beginTurn("turn 2");
  recordTask(state, "market_data", { symbol: "AAPL", bars: [1, 2] });
  await compact(state, { generate } as never, 2, 2);

  const preserved = state.compactionCache()!.preservedData;
  assert.equal(preserved.length, 3, "a later refresh merges into the row from the earlier compaction");
  const aaplBars = preserved.find((entry) => (entry.data.data_keys as string[]).includes("bars")
    && (entry.data.values as { symbol: string }).symbol === "AAPL")!;
  assert.equal(aaplBars.data.calls, 2);
  assert.equal(aaplBars.data.first_turn, 1);
  assert.equal(aaplBars.turn, 2);
});

/** Five turns of chat with the token gauge already over the threshold. */
function compactableSession(store?: InMemoryEventStore): SessionState {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z", store);
  for (let turn = 1; turn <= 5; turn++) {
    state.beginTurn(`USER_TURN_${turn}`);
    state.recordReply(`reply turn ${turn}`, true);
  }
  state.recordPromptTokens(200_000);
  return state;
}

test("a failed compaction is not allowed to fail the turn", async () => {
  const state = compactableSession();

  await maybeCompact(state, { generate: async () => { throw new Error("summarizer is down"); } } as never, state.currentTurn);

  assert.equal(state.compactionCache(), undefined);
  assert.match(state.projectForPrompt(5).conversationSoFar, /USER_TURN_1/, "nothing was dropped");
});

test("a failed persist leaves neither a half-applied cache nor duplicated history", async () => {
  const store = new InMemoryEventStore();
  store.saveCompaction = async () => { throw new Error("disk is full"); };
  const state = compactableSession(store);

  await maybeCompact(state, { generate: async () => ({ text: "Older context.", metrics: {} }) } as never, state.currentTurn);

  assert.equal(state.compactionCache(), undefined, "the cache must not outlive the write that failed");
  const history = state.projectForPrompt(5).conversationSoFar;
  assert.doesNotMatch(history, /Older context/);
  assert.match(history, /USER_TURN_1/, "the source turns are still the only copy of that history");
});

test("an empty summary is refused rather than allowed to erase history", async () => {
  const state = compactableSession();

  await maybeCompact(state, { generate: async () => ({ text: "   ", metrics: {} }) } as never, state.currentTurn);

  assert.equal(state.compactionCache(), undefined);
  assert.match(state.projectForPrompt(5).conversationSoFar, /USER_TURN_1/);
});

test("the summarizer is shown what was dispatched, not only what was said", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  state.beginTurn("Check AAPL");
  state.recordDispatch("market_data", "Fetch the daily bars", state.openThread("market_data"));
  state.recordReply("Here you go.", true);
  let seen = "";

  await compact(state, { generate: async (messages: { content: string }[]) => {
    seen = messages.at(-1)!.content;
    return { text: "AAPL was checked.", metrics: {} };
  } } as never, 1, 1);

  assert.match(seen, /market_data/);
  assert.match(seen, /Fetch the daily bars/);
});

test("thread compaction folds only complete older rounds and leaves the current round verbatim", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  state.beginTurn("go");
  const thread = state.openThread("market_data");
  for (let round = 1; round <= 3; round++) {
    const taskId = state.recordDispatch("market_data", `old round ${round}`, thread).event_id;
    state.record("market_data", "tool_result", { task_id: taskId, name: "probe", summary: `OLD_${round}_${"x".repeat(15_000)}` }, { threadId: thread });
  }
  const currentTask = state.recordDispatch("market_data", "current round", thread).event_id;
  state.record("market_data", "subagent_note", { task_id: currentTask, step: 0, note: "CURRENT_ROUND_RAW" }, { threadId: thread });

  await maybeCompactThread(state, { generate: async () => ({ text: "Old rounds were summarized.", metrics: {} }) } as never,
    "market_data", thread, currentTask);

  const progress = state.subagentProgress({ thread });
  assert.match(progress, /Old rounds were summarized/);
  assert.match(progress, /CURRENT_ROUND_RAW/);
  assert.match(progress, /OLD_3_/, "the most recent completed round remains raw");
  assert.doesNotMatch(progress, /OLD_1_/);
  assert.doesNotMatch(progress, /OLD_2_/);
});

test("thread compaction never splits a large current round when it has no older round", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  state.beginTurn("go");
  const thread = state.openThread("market_data");
  const currentTask = state.recordDispatch("market_data", "current round", thread).event_id;
  state.record("market_data", "tool_result", { task_id: currentTask, name: "probe", summary: `CURRENT_ONLY_${"x".repeat(45_000)}` }, { threadId: thread });
  let compactCalls = 0;

  await maybeCompactThread(state, { generate: async () => { compactCalls++; return { text: "must not run", metrics: {} }; } } as never,
    "market_data", thread, currentTask);

  assert.equal(compactCalls, 0);
  assert.match(state.subagentProgress({ thread }), /CURRENT_ONLY_/);
});

test("a mid-round fold leaves the current round's own task-scoped outputs intact", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  state.beginTurn("go");
  const thread = state.openThread("market_data");
  for (let round = 1; round <= 3; round++) {
    const taskId = state.recordDispatch("market_data", `old round ${round}`, thread).event_id;
    state.record("market_data", "tool_result", { task_id: taskId, name: "probe", summary: `OLD_${round}_${"x".repeat(15_000)}` }, { threadId: thread });
  }
  const currentTask = state.recordDispatch("market_data", "current round", thread).event_id;
  state.record("market_data", "tool_result", {
    task_id: currentTask, name: "build", summary: "EARLY_CURRENT_EVIDENCE",
    artifacts: [{ type: "table", ref: "a1" }],
    generation_context: { data: { value: 42 } },
  }, { threadId: thread });

  await maybeCompactThread(state, { generate: async () => ({ text: "Old rounds summarized.", metrics: {} }) } as never,
    "market_data", thread, currentTask);
  state.record("market_data", "tool_result", { task_id: currentTask, name: "build", summary: "LATE_CURRENT_EVIDENCE" }, { threadId: thread });

  // The task_result of this round is assembled from exactly this list.
  const outputs = state.subagentToolOutputs({ task: currentTask });
  assert.deepEqual(outputs.map((o) => o.summary), ["EARLY_CURRENT_EVIDENCE", "LATE_CURRENT_EVIDENCE"]);
  assert.deepEqual(outputs.flatMap((o) => o.artifacts ?? []), [{ type: "table", ref: "a1" }]);
  // The fold note describes OTHER rounds, so it is not this round's own work.
  assert.doesNotMatch(state.subagentProgress({ task: currentTask }), /Old rounds summarized/);
});

test("thread summary retains evidence already produced by the current round", async () => {
  const state = new SessionState("room_1", "2026-08-12T00:00:00.000Z");
  state.beginTurn("go");
  const thread = state.openThread("market_data");
  for (let round = 1; round <= 3; round++) {
    const taskId = state.recordDispatch("market_data", `old round ${round}`, thread).event_id;
    state.record("market_data", "tool_result", { task_id: taskId, name: "probe", summary: `OLD_${round}_${"x".repeat(15_000)}` }, { threadId: thread });
  }
  const currentTask = state.recordDispatch("market_data", "current round", thread).event_id;
  state.record("market_data", "tool_result", { task_id: currentTask, name: "probe", summary: "CURRENT_EVIDENCE_MUST_SURVIVE" }, { threadId: thread });

  await maybeCompactThread(state, { generate: async () => ({ text: "Old rounds summarized.", metrics: {} }) } as never,
    "market_data", thread, currentTask);

  const progress = state.subagentProgress({ thread });
  assert.match(progress, /Old rounds summarized/);
  assert.match(progress, /CURRENT_EVIDENCE_MUST_SURVIVE/);
});
