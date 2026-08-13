import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  // The durable audit log retains the raw turn, while the restored working
  // context reapplies its saved compaction boundary to avoid double injection.
  assert.deepEqual((await secondStore.loadEvents("room-1")).map((event) => event.kind), ["user_message", "reply"]);
  assert.deepEqual(restored.allEvents().map((event) => event.kind), []);
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
  store.createTopic("default", "room-1", "First room", 100);
  const registry = new SessionRegistry(store);
  const state = await registry.getOrCreate("room-1");
  state.beginTurn("hello");
  state.recordReply("hi", true);

  assert.deepEqual(store.listTopics("default"), [{
    id: "room-1",
    name: "First room",
    leadSymbol: null,
    subjectSymbols: [],
    createdAt: 100,
    lastMessage: { text: "hi", createdAt: Date.parse(state.allEvents()[1]!.timestamp) },
    messageCount: 2,
    summary: null,
    category: null,
    categoryLocked: false,
  }]);
  assert.equal(store.updateTopic("default", "room-1", { name: "Renamed" }), true);
  assert.equal(store.listTopics("default")[0]?.name, "Renamed");
  assert.equal(store.deleteTopic("default", "room-1"), true);
  assert.deepEqual(store.listTopics("default"), []);
  assert.deepEqual(await store.loadEvents("room-1"), []);
  store.close();
});

/**
 * Databases written before threads existed carry `is_sidechain` and no
 * `thread_id`. The two old columns together say everything a thread id says —
 * "inside some subagent" plus "which task" — so the read path reconstructs one
 * instead of requiring a data migration.
 */
test("rows written before threads existed are read back into threads", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "financial-agent-legacy-"));
  const databasePath = join(directory, "sessions.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // Build a database the way the previous build would have: the table without
  // thread_id, then rows carrying only is_sidechain.
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE session_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
    parent_event_id TEXT, session_id TEXT NOT NULL, timestamp TEXT NOT NULL,
    source TEXT NOT NULL, kind TEXT NOT NULL, is_sidechain INTEGER NOT NULL,
    turn INTEGER NOT NULL, payload_json TEXT NOT NULL)`);
  const insert = legacy.prepare(`INSERT INTO session_events
    (event_id, parent_event_id, session_id, timestamp, source, kind, is_sidechain, turn, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("ev_1", null, "room-old", "2026-01-01T00:00:00.000Z", "user", "user_message", 0, 1, JSON.stringify({ content: "hi" }));
  insert.run("ev_2", "ev_1", "room-old", "2026-01-01T00:00:01.000Z", "orchestrator", "dispatch", 0, 1, JSON.stringify({ agent: "market_data", task: "look" }));
  insert.run("ev_3", "ev_2", "room-old", "2026-01-01T00:00:02.000Z", "market_data", "tool_result", 1, 1, JSON.stringify({ task_id: "ev_2", name: "probe", summary: "found" }));
  legacy.close();

  const store = SqliteEventStore.open(databasePath);
  t.after(() => store.close());
  const state = await new SessionRegistry(store).getOrCreate("room-old");

  const byKind = new Map(state.allEvents().map((e) => [e.kind, e.thread_id]));
  assert.equal(byKind.get("user_message"), "room-old", "main-chain rows land on the main thread");
  assert.equal(byKind.get("dispatch"), "room-old");
  // The old trace keeps grouping the way it always did, under the only key it
  // ever had — the dispatch event id.
  assert.equal(byKind.get("tool_result"), "ev_2");
  assert.deepEqual(state.subagentToolOutputs({ thread: "ev_2" }).map((o) => o.summary), ["found"]);
  // Nothing here is offered to the orchestrator as continuable: these runs were
  // one-shot and there is no `child_thread_id` to name.
  assert.deepEqual(state.liveThreads(), []);
});
