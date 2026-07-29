// test/contextCompaction.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../src/framework/sessionState.ts";
import { InMemoryEventStore } from "../src/framework/eventStore.ts";
import { ModelRouter, type LlmProvider } from "../src/infra/llm/provider.ts";
import { compact, maybeCompact } from "../src/framework/contextCompaction.ts";

function fakeProvider(summaryText: string): LlmProvider {
  return {
    name: "fake",
    async generate(messages) {
      return {
        text: summaryText,
        metrics: { tokens_in: 10, tokens_out: 10, ms: 1, model_class: "SMALL", provider: "fake" },
      };
    },
  };
}

function buildSession(): SessionState {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");

  // Turn 1
  state.beginTurn("What's BTC's on-chain inflow looking like?");
  const dispatch = state.recordDispatch("market_data", "fetch BTC exchange inflow/outflow");
  state.recordTaskResult("market_data", dispatch.event_id, {
    task_id: dispatch.event_id,
    agent: "market_data",
    status: "ok",
    summary: "Inflow is up 12% over 24h",
    generation_context: { prompt: "compute inflow/outflow for BTC", data: { inflow: 1200, outflow: 900 } },
    artifacts: [{ type: "file", ref: "./reports/flow.txt", label: "Flow data" }],
  });
  state.recordReply("BTC inflows are up 12% over the last 24h.", true);

  // Turn 2
  state.beginTurn("What about ETH?");
  state.recordReply("ETH inflows are roughly flat.", true);

  return state;
}

test("compact() summarizes turns 1..targetThrough and preserves task data without prompt/artifacts", async () => {
  const state = buildSession();
  const router = new ModelRouter(fakeProvider("User is researching BTC and ETH on-chain flows."));

  await compact(state, router, 1, 1);

  const cache = state.compactionCache();
  assert.ok(cache);
  assert.equal(cache!.summarizedThroughTurn, 1);
  assert.equal(cache!.summaryText, "User is researching BTC and ETH on-chain flows.");
  assert.deepEqual(cache!.preservedData, [
    { turn: 1, agent: "market_data", data: { inflow: 1200, outflow: 900 } },
  ]);

  // Turn 1 events have been trimmed from the in-memory log.
  const remainingTurns = new Set(state.allEvents().map((e) => e.turn));
  assert.deepEqual([...remainingTurns], [2]);
});

test("compact() persists the compaction cache to the EventStore", async () => {
  const store = new InMemoryEventStore();
  const state = new SessionState("sess_persist", "2026-06-10T00:00:00.000Z", store);
  state.beginTurn("What's BTC's on-chain inflow looking like?");
  state.recordReply("BTC inflows are up 12% over the last 24h.", true);
  state.beginTurn("What about ETH?");
  state.recordReply("ETH inflows are roughly flat.", true);

  const router = new ModelRouter(fakeProvider("Summary through turn 1."));
  await compact(state, router, 1, 1);

  const persisted = await store.loadCompaction("sess_persist");
  assert.ok(persisted);
  assert.equal(persisted!.summarizedThroughTurn, 1);
  assert.equal(persisted!.summaryText, "Summary through turn 1.");
});

test("compact() trims sidechain events within the compacted turn range", async () => {
  const state = buildSession();
  state.record("market_data", "tool_result", { task_id: "fetch_inflow", output: "ok" }, { isSidechain: true, turn: 1 });

  const router = new ModelRouter(fakeProvider("User is researching BTC and ETH on-chain flows."));
  await compact(state, router, 1, 1);

  // The sidechain event for turn 1 is trimmed along with the rest of turn 1.
  assert.deepEqual(new Set(state.allEvents().map((e) => e.turn)), new Set([2]));
  assert.ok(!state.allEvents().some((e) => e.is_sidechain));
});

test("compact() merges with an existing summary on a second call", async () => {
  const state = buildSession();
  state.beginTurn("And SOL?"); // turn 3
  state.recordReply("SOL inflows are up slightly.", true);

  const router1 = new ModelRouter(fakeProvider("Summary through turn 1."));
  await compact(state, router1, 1, 1);

  const router2 = new ModelRouter(fakeProvider("Summary through turn 2, building on turn 1."));
  await compact(state, router2, 2, 2);

  const cache = state.compactionCache();
  assert.equal(cache!.summarizedThroughTurn, 2);
  assert.equal(cache!.summaryText, "Summary through turn 2, building on turn 1.");
  assert.deepEqual(new Set(state.allEvents().map((e) => e.turn)), new Set([3]));
});

function buildFiveTurnSession(): SessionState {
  const state = new SessionState("sess_2", "2026-06-10T00:00:00.000Z");
  for (let i = 1; i <= 5; i++) {
    state.beginTurn(`question ${i}`);
    state.recordReply(`answer ${i}`, true);
  }
  return state;
}

test("maybeCompact does nothing below the threshold", async () => {
  const state = buildFiveTurnSession();
  state.recordPromptTokens(Math.floor(0.5 * 200_000)); // 50% < 60%
  const router = new ModelRouter(fakeProvider("should not be called"));

  await maybeCompact(state, router, 6);

  assert.equal(state.compactionCache(), undefined);
  assert.equal(state.allEvents().length, 10); // 5 turns * 2 events, nothing trimmed
});

test("maybeCompact compacts turns older than the last N when over threshold", async () => {
  const state = buildFiveTurnSession();
  state.recordPromptTokens(Math.floor(0.7 * 200_000)); // 70% >= 60%
  const router = new ModelRouter(fakeProvider("Summary of turns 1-2."));

  // currentTurn=6, KEEP_RECENT_TURNS=3 → targetThrough = 6 - 1 - 3 = 2
  await maybeCompact(state, router, 6);

  const cache = state.compactionCache();
  assert.ok(cache);
  assert.equal(cache!.summarizedThroughTurn, 2);
  assert.deepEqual(new Set(state.allEvents().map((e) => e.turn)), new Set([3, 4, 5]));
});

test("maybeCompact is a no-op when no prompt tokens have been recorded yet", async () => {
  const state = buildFiveTurnSession();
  const router = new ModelRouter(fakeProvider("should not be called"));

  await maybeCompact(state, router, 6);

  assert.equal(state.compactionCache(), undefined);
});
