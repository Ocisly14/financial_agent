import test from "node:test";
import assert from "node:assert/strict";
import { renderRoster, renderExternalDelta, staleDigests, type MemberFacts } from "../memberContext.ts";

const member = (over: Partial<MemberFacts> = {}): MemberFacts => ({
  topicId: "t1", name: "AAPL", leadSymbol: "AAPL", chartSymbols: ["AAPL", "SPY"],
  turnCount: 42, lastActivityMs: Date.parse("2026-07-28T00:00:00Z"),
  digest: "估值偏高但现金流稳健", seenThroughTurn: 42, ...over,
});

test("the roster names every member and carries its digest", () => {
  const text = renderRoster([member(), member({ topicId: "t2", name: "NVDA", leadSymbol: "NVDA", digest: "增长快、估值极高" })], 4000);
  assert.match(text, /t1/); assert.match(text, /AAPL/);
  assert.match(text, /t2/); assert.match(text, /增长快、估值极高/);
});

test("a member without a digest is still listed", () => {
  const text = renderRoster([member({ digest: null })], 4000);
  assert.match(text, /t1/, "a missing digest must not hide the member — the controller still needs to know it exists");
});

test("a macro member with no charts renders without a symbol", () => {
  const text = renderRoster([member({ name: "美联储降息路径", leadSymbol: null, chartSymbols: [] })], 4000);
  assert.match(text, /美联储降息路径/);
});

test("the roster truncates to its budget and says how many were dropped", () => {
  const many = Array.from({ length: 30 }, (_, i) => member({ topicId: `t${i}`, name: `T${i}` }));
  const text = renderRoster(many, 600);
  assert.match(text, /omitted/, "silently dropping members would leave the controller with a wrong world model");
});

test("no external change renders to an empty string", () => {
  assert.equal(renderExternalDelta([member({ turnCount: 42, seenThroughTurn: 42 })]), "");
});

test("an advanced member renders one line naming the gap", () => {
  const text = renderExternalDelta([member({ turnCount: 45, seenThroughTurn: 42 })]);
  assert.match(text, /AAPL/);
  assert.match(text, /3/, "the controller needs the size of what it missed");
});

test("only the advanced members appear in the delta", () => {
  const text = renderExternalDelta([
    member({ topicId: "t1", name: "AAPL", turnCount: 42, seenThroughTurn: 42 }),
    member({ topicId: "t2", name: "NVDA", turnCount: 50, seenThroughTurn: 44 }),
  ]);
  assert.doesNotMatch(text, /AAPL/);
  assert.match(text, /NVDA/);
});

test("a digest is stale exactly when the topic has moved past it", () => {
  assert.deepEqual(staleDigests([{ ...member(), digestThroughTurn: 42, turnCount: 42 }]), []);
  assert.deepEqual(staleDigests([{ ...member(), digestThroughTurn: 40, turnCount: 42 }]), ["t1"]);
});

test("a member that never had a digest counts as stale", () => {
  assert.deepEqual(staleDigests([{ ...member({ digest: null }), digestThroughTurn: 0, turnCount: 3 }]), ["t1"]);
});

test("a brand-new empty topic is not stale — there is nothing to summarise", () => {
  assert.deepEqual(staleDigests([{ ...member({ digest: null }), digestThroughTurn: 0, turnCount: 0 }]), []);
});
