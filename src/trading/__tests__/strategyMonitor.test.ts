import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_INTERVAL_MS, IDLE_INTERVAL_MS, nextTickDelay } from "../strategyMonitor.ts";

test("an idle pass backs the loop off; an active pass keeps it at the fast interval", () => {
  assert.equal(nextTickDelay(0), IDLE_INTERVAL_MS);
  assert.equal(nextTickDelay(1), ACTIVE_INTERVAL_MS);
  assert.equal(nextTickDelay(9), ACTIVE_INTERVAL_MS);
});

test("the idle interval is meaningfully slower than the active one", () => {
  assert.ok(IDLE_INTERVAL_MS >= ACTIVE_INTERVAL_MS * 5);
});
