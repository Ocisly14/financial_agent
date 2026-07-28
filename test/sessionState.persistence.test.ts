// test/sessionState.persistence.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionState, SessionRegistry } from "../src/framework/sessionState.ts";
import { InMemoryEventStore } from "../src/framework/eventStore.ts";

test("record() persists events to the EventStore", async () => {
  const store = new InMemoryEventStore();
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z", store);

  state.beginTurn("hello");
  state.recordReply("hi there", true);

  // appendEvent is fire-and-forget; give the microtask queue a tick.
  await new Promise((r) => setTimeout(r, 0));

  const persisted = await store.loadEvents("sess_1");
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0]?.kind, "user_message");
  assert.equal(persisted[1]?.kind, "reply");
});

test("compaction cache getter/setter and recordPromptTokens", () => {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");

  assert.equal(state.compactionCache(), undefined);
  assert.equal(state.lastPromptTokensIn(), undefined);

  state.recordPromptTokens(12345);
  assert.equal(state.lastPromptTokensIn(), 12345);

  state.setCompactionCache({
    summarizedThroughTurn: 1,
    summaryText: "summary",
    preservedData: [],
  });
  assert.deepEqual(state.compactionCache(), {
    summarizedThroughTurn: 1,
    summaryText: "summary",
    preservedData: [],
  });
});

test("compactEvents removes events at or below the given turn", () => {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");
  state.beginTurn("turn 1"); // turn 1
  state.recordReply("reply 1", true);
  state.beginTurn("turn 2"); // turn 2
  state.recordReply("reply 2", true);
  state.beginTurn("turn 3"); // turn 3
  state.recordReply("reply 3", true);

  state.compactEvents(2);

  const remainingTurns = state.allEvents().map((e) => e.turn);
  assert.deepEqual(remainingTurns, [3, 3]);
});

test("SessionRegistry restores a session from the EventStore on cold start", async () => {
  const store = new InMemoryEventStore();

  // First registry: create a session and write a couple of events.
  const registry1 = new SessionRegistry(store);
  const state1 = await registry1.getOrCreate("sess_restore");
  state1.beginTurn("hello");
  state1.recordReply("hi", true);
  await new Promise((r) => setTimeout(r, 0)); // let fire-and-forget writes land
  state1.setCompactionCache({ summarizedThroughTurn: 0, summaryText: "", preservedData: [] });

  // Second registry (simulating a process restart): same store, fresh map.
  const registry2 = new SessionRegistry(store);
  const state2 = await registry2.getOrCreate("sess_restore");

  assert.equal(state2.allEvents().length, 2);
  assert.equal(state2.currentTurn, 1);
});

test("SessionRegistry.getExisting throws for an unknown session", () => {
  const registry = new SessionRegistry();
  assert.throws(() => registry.getExisting("nope"), /session not found/);
});

test("SessionRegistry.getExisting returns a session created via getOrCreate", async () => {
  const registry = new SessionRegistry();
  const created = await registry.getOrCreate("sess_x");
  assert.equal(registry.getExisting("sess_x"), created);
});
