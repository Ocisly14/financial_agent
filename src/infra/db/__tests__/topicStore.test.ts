import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionRegistry } from "../../../framework/sessionState.ts";
import { SqliteEventStore } from "../sqliteEventStore.ts";

test("a new topic has no lead symbol", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "美联储降息路径");

  const topics = store.listTopics("agent-1");
  assert.equal(topics.length, 1);
  assert.equal(topics[0]?.name, "美联储降息路径");
  assert.equal(topics[0]?.leadSymbol, null);
  store.close();
});

test("updateTopic reports a miss for an unknown topic", () => {
  const store = SqliteEventStore.open(":memory:");
  assert.equal(store.updateTopic("agent-1", "nope", { name: "x" }), false);
  store.close();
});

test("chart preferences round-trip and replace wholesale", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "AAPL");

  store.replaceTopicCharts("topic-1", [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: 252, hidden: false, sortOrder: 0 },
    { id: "c2", kind: "symbol", symbol: "NVDA", range: null, hidden: true, sortOrder: 1 },
  ]);
  assert.deepEqual(store.listTopicCharts("topic-1"), [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: 252, hidden: false, sortOrder: 0 },
    { id: "c2", kind: "symbol", symbol: "NVDA", range: null, hidden: true, sortOrder: 1 },
  ]);

  store.replaceTopicCharts("topic-1", [
    { id: "c3", kind: "symbol", symbol: "MSFT", range: null, hidden: false, sortOrder: 0 },
  ]);
  assert.deepEqual(
    store.listTopicCharts("topic-1").map((row) => (row.kind === "symbol" ? row.symbol : row.overlay)),
    ["MSFT"],
  );
  store.close();
});

test("chart preferences are scoped per topic", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "A");
  store.createTopic("agent-1", "topic-2", "B");
  store.replaceTopicCharts("topic-1", [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 0 },
  ]);

  assert.deepEqual(store.listTopicCharts("topic-2"), []);
  store.close();
});

test("deleting a topic clears its chart preferences", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "AAPL");
  store.replaceTopicCharts("topic-1", [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 0 },
  ]);

  assert.equal(store.deleteTopic("agent-1", "topic-1"), true);
  assert.deepEqual(store.listTopicCharts("topic-1"), []);
  store.close();
});

test("listTopics: a topic with no charts has a null leadSymbol", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "Macro");

  const topic = store.listTopics("agent-1")[0];
  assert.equal(topic?.leadSymbol, null);
  store.close();
});

test("listTopics: with multiple charts, leadSymbol is the lowest sort_order", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "Multi");
  store.replaceTopicCharts("topic-1", [
    { id: "c1", kind: "symbol", symbol: "NVDA", range: null, hidden: false, sortOrder: 1 },
    { id: "c2", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 0 },
  ]);

  const topic = store.listTopics("agent-1")[0];
  assert.equal(topic?.leadSymbol, "AAPL");
  store.close();
});

test("listTopics: a hidden chart is never the leadSymbol", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "Multi");
  store.replaceTopicCharts("topic-1", [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: null, hidden: true, sortOrder: 0 },
    { id: "c2", kind: "symbol", symbol: "NVDA", range: null, hidden: false, sortOrder: 1 },
  ]);

  const topic = store.listTopics("agent-1")[0];
  assert.equal(topic?.leadSymbol, "NVDA");
  store.close();
});

test("both kinds live in one table and sort together", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  store.replaceTopicCharts("t1", [
    { id: "c1", kind: "overlay", overlay: { symbols: ["AAPL", "NVDA"], range: 252, normalize: "pct" }, range: null, hidden: false, sortOrder: 0 },
    { id: "c2", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 1 },
  ]);
  const rows = store.listTopicCharts("t1");
  assert.deepEqual(rows.map((r) => r.kind), ["overlay", "symbol"]);
  store.close();
});

test("the partial index still blocks a duplicate ticker", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  assert.throws(() => store.replaceTopicCharts("t1", [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 0 },
    { id: "c2", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 1 },
  ]));
  store.close();
});

test("the same symbol set may be kept under two normalisations", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  store.replaceTopicCharts("t1", [
    { id: "c1", kind: "overlay", overlay: { symbols: ["AAPL", "NVDA"], range: 252, normalize: "pct" }, range: null, hidden: false, sortOrder: 0 },
    { id: "c2", kind: "overlay", overlay: { symbols: ["AAPL", "NVDA"], range: 252, normalize: "index100" }, range: null, hidden: false, sortOrder: 1 },
  ]);
  assert.equal(store.listTopicCharts("t1").length, 2, "the partial index must not constrain overlay rows");
  store.close();
});

test("a malformed overlay JSON row is skipped rather than crashing the read", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  store.replaceTopicCharts("t1", [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 0 },
  ]);
  // Storage outlives the build that wrote it; a row this build cannot parse
  // must not take the whole tab bar down with it.
  store.rawExec("UPDATE topic_charts SET kind='overlay', symbol=NULL, overlay='{oops' WHERE id='c1'");
  assert.doesNotThrow(() => store.listTopicCharts("t1"));
  assert.deepEqual(store.listTopicCharts("t1"), []);
  store.close();
});

// ── digest, category and the lock ────────────────────────────────────────────

test("a digest write does not resurface the topic in the rail", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "美联储降息路径", 100);
  const before = store.rawGet("SELECT updated_at FROM chat_rooms WHERE id='t1'") as { updated_at: number };

  store.setTopicDigest("t1", "在跟踪降息路径", "macro", 3);

  const after = store.rawGet("SELECT updated_at FROM chat_rooms WHERE id='t1'") as { updated_at: number };
  assert.equal(after.updated_at, before.updated_at,
    "the rail orders by updated_at — a background summary that bumped it would manufacture the activity it describes");
  const topic = store.listTopics("a1")[0];
  assert.equal(topic?.summary, "在跟踪降息路径");
  assert.equal(topic?.category, "macro");
  assert.equal(topic?.categoryLocked, false);
  store.close();
});

test("a digest gives an untitled topic a title and symbols, without needing chart tabs", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "Chat 08-12 10:00", 100);

  store.setTopicDigest("t1", "估值仍取决于服务利润率。", "single_name", 1, {
    title: "AAPL valuation", symbols: ["AAPL", "MSFT"],
  });

  const topic = store.listTopics("a1")[0];
  assert.equal(topic?.name, "AAPL valuation");
  assert.equal(topic?.leadSymbol, null, "digest symbols do not create or mutate chart tabs");
  assert.deepEqual(topic?.subjectSymbols, ["AAPL", "MSFT"]);
  store.close();
});

test("a manual title is never overwritten by later digest titles", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "Chat 08-12 10:00");
  store.updateTopic("a1", "t1", { name: "My Apple notes" });

  store.setTopicDigest("t1", "摘要", "single_name", 1, {
    title: "AAPL valuation", symbols: ["AAPL"],
  });

  const topic = store.listTopics("a1")[0];
  assert.equal(topic?.name, "My Apple notes");
  assert.deepEqual(topic?.subjectSymbols, ["AAPL"], "the lock applies only to the title");
  store.close();
});

test("a hand-picked category is locked and survives the next digest", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "英伟达");
  store.setTopicDigest("t1", "第一版", "single_name", 1);

  assert.equal(store.updateTopic("a1", "t1", { category: "strategy" }), true);
  assert.equal(store.listTopics("a1")[0]?.categoryLocked, true);

  store.setTopicDigest("t1", "第二版", "single_name", 2);

  const topic = store.listTopics("a1")[0];
  assert.equal(topic?.category, "strategy", "the model must not argue with the user");
  assert.equal(topic?.summary, "第二版", "but the summary is still refreshed — locking a category is not freezing the blurb");
  store.close();
});

test("returning a topic to automatic releases the lock without blanking the label", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "英伟达");
  store.updateTopic("a1", "t1", { category: "strategy" });

  store.updateTopic("a1", "t1", { category: null });

  const released = store.listTopics("a1")[0];
  assert.equal(released?.categoryLocked, false);
  assert.equal(released?.category, "strategy",
    "the topic is not stale, so nothing would reclassify it — blanking here would just make the label vanish");

  // The next digest is now free to overwrite it.
  store.setTopicDigest("t1", "某缩要", "single_name", 1);
  assert.equal(store.listTopics("a1")[0]?.category, "single_name");
  store.close();
});

test("a digest with no category never blanks one already stored", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "英伟达");
  store.setTopicDigest("t1", "第一版", "single_name", 1);

  // The model replied with prose instead of JSON, so the category was lost.
  store.setTopicDigest("t1", "第二版", null, 2);

  const topic = store.listTopics("a1")[0];
  assert.equal(topic?.category, "single_name", "an unparsable reply must not undo a good classification");
  assert.equal(topic?.summary, "第二版");
  store.close();
});

test("staleness tracks the topic's own log", async () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  assert.equal(store.isTopicDigestStale("t1"), false, "a topic with no turns has nothing to summarise");
  assert.deepEqual(store.listStaleTopics("a1"), []);

  const registry = new SessionRegistry(store);
  const state = await registry.getOrCreate("t1");
  state.beginTurn("问");
  state.recordReply("答", true);

  assert.equal(store.isTopicDigestStale("t1"), true);
  assert.deepEqual(store.listStaleTopics("a1"), ["t1"]);

  store.setTopicDigest("t1", "缩要", "macro", 1);
  assert.equal(store.isTopicDigestStale("t1"), false);
  assert.deepEqual(store.listStaleTopics("a1"), []);
  store.close();
});

test("digest cadence is first turn, then each complete three-turn increment", async () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  const state = await new SessionRegistry(store).getOrCreate("t1");
  const append = (turn: number) => {
    state.beginTurn(`问 ${turn}`);
    state.recordReply(`答 ${turn}`, true);
  };

  append(1);
  assert.equal(store.isTopicDigestDue("t1"), true);
  assert.deepEqual(store.listDigestDueTopics("a1"), ["t1"]);
  store.setTopicDigest("t1", "首版", "macro", 1);

  append(2);
  append(3);
  assert.equal(store.isTopicDigestDue("t1"), false, "two new turns are an incomplete increment");
  append(4);
  assert.equal(store.isTopicDigestDue("t1"), true);
  assert.deepEqual(store.getTopicDigest("t1"), { summary: "首版", throughTurn: 1 });
  store.close();
});

test("an unknown topic is never reported stale", () => {
  const store = SqliteEventStore.open(":memory:");
  assert.equal(store.isTopicDigestStale("ghost"), false);
  store.close();
});

test("a database written before the digest columns existed is migrated on open", () => {
  // CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so a new
  // column in SCHEMA reaches new databases only. This is the path that covers
  // everyone who already has a sessions.sqlite on disk.
  const dir = mkdtempSync(join(tmpdir(), "topic-migrate-"));
  const path = join(dir, "sessions.sqlite");

  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE chat_rooms (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER)`);
  legacy.exec("INSERT INTO chat_rooms VALUES ('t1', 'a1', '旧话题', 100, 100, NULL)");
  legacy.close();

  const store = SqliteEventStore.open(path);
  const topic = store.listTopics("a1")[0];
  assert.equal(topic?.name, "旧话题", "the existing row survives");
  assert.equal(topic?.summary, null);
  assert.equal(topic?.category, null);
  assert.equal(topic?.categoryLocked, false);

  store.setTopicDigest("t1", "缩要", "macro", 1);
  assert.equal(store.listTopics("a1")[0]?.category, "macro", "the added columns are writable");
  store.close();

  // Opening again must not try to add them a second time.
  const reopened = SqliteEventStore.open(path);
  assert.equal(reopened.listTopics("a1")[0]?.summary, "缩要");
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});
