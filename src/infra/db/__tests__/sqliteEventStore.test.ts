import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRegistry } from "../../../framework/sessionState.ts";
import { SqliteEventStore } from "../sqliteEventStore.ts";

test("SQLite event store restores events and compaction after reopening the file", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "financial-agent-sessions-"));
  const databasePath = join(directory, "sessions.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const firstStore = SqliteEventStore.open(databasePath);
  const firstRegistry = new SessionRegistry(firstStore);
  const firstState = await firstRegistry.getOrCreate("room-1");
  firstState.beginTurn("hello");
  firstState.recordReply("hi", true);
  firstState.setCompactionCache({
    summarizedThroughTurn: 1,
    summaryText: "The user said hello.",
    preservedData: [{ turn: 1, agent: "market_data", data: { symbol: "AAPL" } }],
  });
  await firstState.persistCompactionCache();
  firstStore.close();

  const secondStore = SqliteEventStore.open(databasePath);
  t.after(() => secondStore.close());
  const restored = await new SessionRegistry(secondStore).getOrCreate("room-1");

  assert.equal(restored.currentTurn, 1);
  assert.deepEqual(restored.allEvents().map((event) => event.kind), ["user_message", "reply"]);
  assert.deepEqual(restored.compactionCache(), {
    summarizedThroughTurn: 1,
    summaryText: "The user said hello.",
    preservedData: [{ turn: 1, agent: "market_data", data: { symbol: "AAPL" } }],
  });
});

test("SQLite event store keeps different sessions isolated", async () => {
  const store = SqliteEventStore.open(":memory:");
  const registry = new SessionRegistry(store);
  (await registry.getOrCreate("room-a")).beginTurn("A");
  (await registry.getOrCreate("room-b")).beginTurn("B");

  assert.equal((await store.loadEvents("room-a"))[0]?.payload.content, "A");
  assert.equal((await store.loadEvents("room-b"))[0]?.payload.content, "B");
  store.close();
});

test("SQLite room catalog persists metadata, message previews, rename, and delete", async () => {
  const store = SqliteEventStore.open(":memory:");
  store.createRoom("default", "room-1", "First room", 100);
  const registry = new SessionRegistry(store);
  const state = await registry.getOrCreate("room-1");
  state.beginTurn("hello");
  state.recordReply("hi", true);

  assert.deepEqual(store.listRooms("default"), [{
    id: "room-1",
    name: "First room",
    createdAt: 100,
    lastMessage: { text: "hi", createdAt: Date.parse(state.allEvents()[1]!.timestamp) },
    messageCount: 2,
  }]);
  assert.equal(store.renameRoom("default", "room-1", "Renamed"), true);
  assert.equal(store.listRooms("default")[0]?.name, "Renamed");
  assert.equal(store.deleteRoom("default", "room-1"), true);
  assert.deepEqual(store.listRooms("default"), []);
  assert.deepEqual(await store.loadEvents("room-1"), []);
  store.close();
});
