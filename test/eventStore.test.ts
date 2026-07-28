// test/eventStore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventStore } from "../src/framework/eventStore.ts";
import type { SessionEvent } from "../src/framework/sessionState.ts";

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    event_id: "ev_1",
    parent_event_id: null,
    session_id: "sess_1",
    timestamp: "2026-06-10T00:00:00.000Z",
    source: "user",
    kind: "user_message",
    is_sidechain: false,
    turn: 1,
    payload: { content: "hi" },
    ...overrides,
  };
}

test("InMemoryEventStore appends and loads events per session", async () => {
  const store = new InMemoryEventStore();
  await store.appendEvent(makeEvent({ event_id: "ev_1" }));
  await store.appendEvent(makeEvent({ event_id: "ev_2", session_id: "sess_2" }));
  await store.appendEvent(makeEvent({ event_id: "ev_3" }));

  const sess1 = await store.loadEvents("sess_1");
  assert.equal(sess1.length, 2);
  assert.deepEqual(sess1.map((e) => e.event_id), ["ev_1", "ev_3"]);

  const sess2 = await store.loadEvents("sess_2");
  assert.equal(sess2.length, 1);
});

test("InMemoryEventStore round-trips compaction cache", async () => {
  const store = new InMemoryEventStore();
  assert.equal(await store.loadCompaction("sess_1"), undefined);

  await store.saveCompaction("sess_1", {
    summarizedThroughTurn: 2,
    summaryText: "user wants BTC analysis",
    preservedData: [{ turn: 2, agent: "onchain_data", data: { inflow: 100 } }],
  });

  const cache = await store.loadCompaction("sess_1");
  assert.deepEqual(cache, {
    summarizedThroughTurn: 2,
    summaryText: "user wants BTC analysis",
    preservedData: [{ turn: 2, agent: "onchain_data", data: { inflow: 100 } }],
  });
});
