import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, type ReplayFixture } from "../replay.ts";

const base = (candles: number[]): { ts: number; high: number; low: number; close: number }[] =>
  candles.map((c, i) => ({ ts: i * 60_000, high: c, low: c, close: c }));

test("clean drawdown fires after confirmation", () => {
  const fx: ReplayFixture = {
    id: "t1", symbol: "BTCUSDT", expectedFire: true, label: "clean drawdown",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 2 },
    candles: base([100, 100, 94, 93]), // drops >5% from high=100 and stays
  };
  assert.equal(replay(fx).fired, true);
});

test("single wick does not fire (confirm gate)", () => {
  const fx: ReplayFixture = {
    id: "t2", symbol: "BTCUSDT", expectedFire: false, label: "single wick",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 2 },
    candles: base([100, 100, 94, 100]), // one dip then recovers
  };
  assert.equal(replay(fx).fired, false);
});
