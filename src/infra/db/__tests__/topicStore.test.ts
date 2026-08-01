import test from "node:test";
import assert from "node:assert/strict";
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
