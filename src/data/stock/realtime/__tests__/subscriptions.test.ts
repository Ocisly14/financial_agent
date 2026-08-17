import { test } from "node:test";
import assert from "node:assert/strict";
import { createSubscriptionSet } from "../subscriptions.ts";

test("reconciling pins subscribes the newly active symbols", () => {
  const set = createSubscriptionSet({ capacity: 5 });
  const delta = set.reconcilePins(["AAPL", "MSFT"], 1_000);

  assert.deepEqual(delta.subscribe.sort(), ["AAPL", "MSFT"]);
  assert.deepEqual(delta.unsubscribe, []);
  assert.equal(set.isSubscribed("AAPL"), true);
});

test("reconciling the same pins again is a no-op", () => {
  const set = createSubscriptionSet({ capacity: 5 });
  set.reconcilePins(["AAPL", "MSFT"], 1_000);
  const delta = set.reconcilePins(["MSFT", "AAPL"], 2_000);

  assert.deepEqual(delta, { subscribe: [], unsubscribe: [] });
});

test("a symbol dropped from the active set is unsubscribed", () => {
  const set = createSubscriptionSet({ capacity: 5 });
  set.reconcilePins(["AAPL", "MSFT"], 1_000);
  const delta = set.reconcilePins(["AAPL"], 2_000);

  assert.deepEqual(delta.unsubscribe, ["MSFT"]);
  assert.equal(set.isSubscribed("MSFT"), false);
});

test("leasing an unsubscribed symbol subscribes it", () => {
  const set = createSubscriptionSet({ capacity: 5 });
  const result = set.lease("TSLA", 1_000);

  assert.equal(result.subscribed, true);
  assert.deepEqual(result.delta.subscribe, ["TSLA"]);
  assert.equal(set.isSubscribed("TSLA"), true);
});

test("leasing a pinned symbol adds no subscription traffic", () => {
  const set = createSubscriptionSet({ capacity: 5 });
  set.reconcilePins(["AAPL"], 1_000);
  const result = set.lease("AAPL", 2_000);

  assert.equal(result.subscribed, true);
  assert.deepEqual(result.delta, { subscribe: [], unsubscribe: [] });
});

test("a full set evicts the least recently used lease", () => {
  const set = createSubscriptionSet({ capacity: 2 });
  set.lease("AAPL", 1_000);
  set.lease("MSFT", 2_000);
  set.lease("AAPL", 3_000); // AAPL is now the more recent of the two

  const result = set.lease("TSLA", 4_000);
  assert.equal(result.subscribed, true);
  assert.deepEqual(result.delta.unsubscribe, ["MSFT"]);
  assert.deepEqual(result.delta.subscribe, ["TSLA"]);
  assert.equal(set.isSubscribed("MSFT"), false);
});

test("a lease is refused rather than evicting a pinned strategy symbol", () => {
  const set = createSubscriptionSet({ capacity: 2 });
  set.reconcilePins(["AAPL", "MSFT"], 1_000);

  const result = set.lease("TSLA", 2_000);
  assert.equal(result.subscribed, false);
  assert.deepEqual(result.delta, { subscribe: [], unsubscribe: [] });
  assert.equal(set.isSubscribed("AAPL"), true);
  assert.equal(set.isSubscribed("MSFT"), true);
});

test("leases expire after their idle window, pins never do", () => {
  const set = createSubscriptionSet({ capacity: 5, leaseTtlMs: 60_000 });
  set.reconcilePins(["AAPL"], 1_000);
  set.lease("TSLA", 1_000);

  assert.deepEqual(set.expire(30_000), { subscribe: [], unsubscribe: [] });
  assert.deepEqual(set.expire(61_001).unsubscribe, ["TSLA"]);
  assert.equal(set.isSubscribed("AAPL"), true);
});

test("touching a lease postpones its expiry", () => {
  const set = createSubscriptionSet({ capacity: 5, leaseTtlMs: 60_000 });
  set.lease("TSLA", 1_000);
  set.lease("TSLA", 50_000);

  assert.deepEqual(set.expire(61_001), { subscribe: [], unsubscribe: [] });
  assert.deepEqual(set.expire(111_000).unsubscribe, ["TSLA"]);
});

test("pinning a symbol that is already leased does not resubscribe it", () => {
  const set = createSubscriptionSet({ capacity: 5 });
  set.lease("TSLA", 1_000);
  const delta = set.reconcilePins(["TSLA"], 2_000);

  assert.deepEqual(delta, { subscribe: [], unsubscribe: [] });
  assert.equal(set.status().pinned, 1);
  assert.equal(set.status().leased, 0);
});

test("unpinning a symbol that is still being read keeps it as a lease", () => {
  const set = createSubscriptionSet({ capacity: 5, leaseTtlMs: 60_000 });
  set.reconcilePins(["AAPL"], 1_000);
  set.lease("AAPL", 2_000); // the chart is watching it too

  const delta = set.reconcilePins([], 3_000);
  assert.deepEqual(delta, { subscribe: [], unsubscribe: [] });
  assert.equal(set.isSubscribed("AAPL"), true);
  assert.equal(set.status().leased, 1);
});

test("pins beyond capacity are reported as overflow instead of silently dropped", () => {
  const set = createSubscriptionSet({ capacity: 2 });
  const delta = set.reconcilePins(["AAPL", "MSFT", "TSLA"], 1_000);

  assert.equal(delta.subscribe.length, 2);
  assert.deepEqual(set.status().overflow, ["TSLA"]);
  assert.equal(set.isSubscribed("TSLA"), false);
});

test("overflowed pins get subscribed once room frees up", () => {
  const set = createSubscriptionSet({ capacity: 2 });
  set.reconcilePins(["AAPL", "MSFT", "TSLA"], 1_000);
  const delta = set.reconcilePins(["AAPL", "TSLA"], 2_000);

  assert.deepEqual(delta.unsubscribe, ["MSFT"]);
  assert.deepEqual(delta.subscribe, ["TSLA"]);
  assert.deepEqual(set.status().overflow, []);
});
