import test from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../sqliteEventStore.ts";

function seeded() {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t-aapl", "AAPL");
  store.createTopic("a1", "t-nvda", "NVDA");
  store.createTopic("a1", "t-macro", "美联储降息路径");
  return store;
}

test("a research lists with its member count", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "半导体估值");
  store.replaceResearchMembers("r1", ["t-aapl", "t-nvda"]);

  const list = store.listResearches("a1");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, "半导体估值");
  assert.equal(list[0]?.memberCount, 2);
  store.close();
});

test("members keep the order they were given", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "R");
  store.replaceResearchMembers("r1", ["t-nvda", "t-aapl", "t-macro"]);

  assert.deepEqual(
    store.listResearchMembers("r1").map((m) => m.topicId),
    ["t-nvda", "t-aapl", "t-macro"],
  );
  store.close();
});

test("replacing members drops the ones left out", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "R");
  store.replaceResearchMembers("r1", ["t-aapl", "t-nvda"]);
  store.replaceResearchMembers("r1", ["t-aapl"]);

  assert.deepEqual(store.listResearchMembers("r1").map((m) => m.topicId), ["t-aapl"]);
  store.close();
});

test("a surviving member keeps its digest across a membership rewrite", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "R");
  store.replaceResearchMembers("r1", ["t-aapl", "t-nvda"]);
  store.setMemberDigest("r1", "t-aapl", "AAPL 估值偏高但现金流稳", 12);

  store.replaceResearchMembers("r1", ["t-aapl", "t-macro"]);

  const aapl = store.listResearchMembers("r1").find((m) => m.topicId === "t-aapl");
  assert.equal(aapl?.digest, "AAPL 估值偏高但现金流稳", "a rewrite must not throw away work already paid for");
  assert.equal(aapl?.digestThroughTurn, 12);
  store.close();
});

test("a topic can belong to several researches at once", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "半导体估值");
  store.createResearch("a1", "r2", "财报季");
  store.replaceResearchMembers("r1", ["t-aapl"]);
  store.replaceResearchMembers("r2", ["t-aapl"]);

  assert.equal(store.listResearchMembers("r1").length, 1);
  assert.equal(store.listResearchMembers("r2").length, 1);
  store.close();
});

test("digests are per membership, not per topic", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.createResearch("a1", "r2", "B");
  store.replaceResearchMembers("r1", ["t-aapl"]);
  store.replaceResearchMembers("r2", ["t-aapl"]);
  store.setMemberDigest("r1", "t-aapl", "从估值角度看", 5);

  const inR2 = store.listResearchMembers("r2")[0];
  assert.equal(inR2?.digest, null, "each research reads the same topic through its own lens");
  store.close();
});

test("deleting a topic removes it from every research", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.createResearch("a1", "r2", "B");
  store.replaceResearchMembers("r1", ["t-aapl", "t-nvda"]);
  store.replaceResearchMembers("r2", ["t-aapl"]);

  store.deleteTopic("a1", "t-aapl");

  assert.deepEqual(store.listResearchMembers("r1").map((m) => m.topicId), ["t-nvda"]);
  assert.deepEqual(store.listResearchMembers("r2"), []);
  store.close();
});

test("a research whose members all vanish still exists", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.replaceResearchMembers("r1", ["t-aapl"]);
  store.deleteTopic("a1", "t-aapl");

  // The research's own conversation and thesis still exist — it must not vanish along with the topic.
  assert.equal(store.listResearches("a1").length, 1);
  assert.equal(store.listResearches("a1")[0]?.memberCount, 0);
  store.close();
});

test("deleting a research clears its membership rows but not the topics", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.replaceResearchMembers("r1", ["t-aapl"]);

  assert.equal(store.deleteResearch("a1", "r1"), true);
  assert.deepEqual(store.listResearchMembers("r1"), []);
  assert.equal(store.listTopics("a1").length, 3, "topics outlive the research that grouped them");
  store.close();
});

test("seenThroughTurn round-trips and defaults to zero", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.replaceResearchMembers("r1", ["t-aapl"]);
  assert.equal(store.listResearchMembers("r1")[0]?.seenThroughTurn, 0);

  store.setMemberSeenTurn("r1", "t-aapl", 9);
  assert.equal(store.listResearchMembers("r1")[0]?.seenThroughTurn, 9);
  store.close();
});
