import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, type ReplayFixture } from "../replay.ts";

const base = (candles: number[]): { ts: number; high: number; low: number; close: number }[] =>
  candles.map((c, i) => ({ ts: i * 60_000, high: c, low: c, close: c }));

/** Enough flat samples for the entry filter to have a baseline to judge against. */
const WARMUP = [100, 100, 100, 100, 100];

test("a sustained drawdown breaks through the entry filter and fires", () => {
  const fx: ReplayFixture = {
    id: "t1", symbol: "AAPL", expectedFire: true, label: "clean drawdown",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 30 },
    candles: base([...WARMUP, 94, 93, 92]),
  };
  assert.equal(replay(fx).fired, true);
});

test("a single wick is rejected at the entry filter and never reaches the trigger", () => {
  const fx: ReplayFixture = {
    id: "t2", symbol: "AAPL", expectedFire: false, label: "single wick",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 30 },
    candles: base([...WARMUP, 94, 100, 100]),
  };
  assert.equal(replay(fx).fired, false);
});

test("chop that never leaves the band fires nothing", () => {
  const fx: ReplayFixture = {
    id: "t3", symbol: "AAPL", expectedFire: false, label: "chop",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 30 },
    candles: base([...WARMUP, 97, 98, 97, 98]),
  };
  assert.equal(replay(fx).fired, false);
});

test("the filtered-out samples are reported so a fixture's losses are visible", () => {
  const fx: ReplayFixture = {
    id: "t4", symbol: "AAPL", expectedFire: false, label: "single wick",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 30 },
    candles: base([...WARMUP, 94, 100]),
  };
  assert.equal(replay(fx).filtered, 1);
});
