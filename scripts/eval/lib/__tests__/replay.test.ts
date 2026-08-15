import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, type ReplayFixture } from "../replay.ts";

const base = (candles: number[]): { ts: number; high: number; low: number; close: number }[] =>
  candles.map((c, i) => ({ ts: i * 60_000, high: c, low: c, close: c }));

/** Enough flat samples for the entry filter to have a baseline to judge against. */
const WARMUP = [100, 100, 100, 100, 100];

test("a sustained drawdown breaks through the entry filter and fires", () => {
  // The window is 5 minutes because the candles span 7: production will not evaluate a
  // rolling_change until the buffer covers the whole window, so a 30-minute window here
  // would test the arming gate rather than the drawdown.
  const fx: ReplayFixture = {
    id: "t1", symbol: "AAPL", expectedFire: true, label: "clean drawdown",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 5 },
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

// ── the two things production does that a naive replay does not ──────────────
// `strategyMonitor` arms a rolling_change only once the buffer spans its window
// (`feed.isArmed`) and then evaluates against `feed.window(...)` — the samples inside the
// window, not everything ever seen. On 24/7 data with dense candles the difference rarely
// showed; on US equities, where two consecutive prints can sit 17.5 hours apart across a
// close, it decides whether a strategy fires at all.

const MINUTE = 60_000;
const OVERNIGHT = 17.5 * 60 * MINUTE;

test("a drop measured across an overnight gap does not satisfy a 30-minute window", () => {
  // Yesterday's session sits at 100; today opens at 94. Nothing dropped 5% within any
  // 30-minute window — the move happened while the market was shut.
  const candles = [
    ...[0, 1, 2, 3, 4, 5].map((i) => ({ ts: i * MINUTE, high: 100, low: 100, close: 100 })),
    ...[0, 1, 2].map((i) => ({ ts: OVERNIGHT + i * MINUTE, high: 94, low: 94, close: 94 })),
  ];
  const fx: ReplayFixture = {
    id: "gap", symbol: "AAPL", expectedFire: false, label: "overnight gap",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 30 },
    candles,
  };
  assert.equal(replay(fx).fired, false);
});

test("a rolling_change stays unarmed until the buffer spans its window", () => {
  // A 5% drop inside the first two minutes of data. Production would not have a 30-minute
  // buffer yet, so it would not act on it.
  const fx: ReplayFixture = {
    id: "unarmed", symbol: "AAPL", expectedFire: false, label: "not yet armed",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 30 },
    candles: [
      { ts: 0, high: 100, low: 100, close: 100 },
      { ts: MINUTE, high: 100, low: 100, close: 100 },
      { ts: 2 * MINUTE, high: 94, low: 94, close: 94 },
    ],
  };
  assert.equal(replay(fx).fired, false);
});

test("a same-session drop inside the window still fires once armed", () => {
  const candles = [
    ...Array.from({ length: 31 }, (_, i) => ({ ts: i * MINUTE, high: 100, low: 100, close: 100 })),
    { ts: 31 * MINUTE, high: 94, low: 94, close: 94 },
    { ts: 32 * MINUTE, high: 93, low: 93, close: 93 },
    { ts: 33 * MINUTE, high: 92, low: 92, close: 92 },
  ];
  const fx: ReplayFixture = {
    id: "armed", symbol: "AAPL", expectedFire: true, label: "armed drawdown",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 30 },
    candles,
  };
  assert.equal(replay(fx).fired, true);
});

test("an absolute_threshold needs no window and fires on the gap that breaches it", () => {
  // The mirror of the first case: a level breached by a gap IS breached, whatever the clock says.
  const candles = [
    ...[0, 1, 2, 3, 4, 5].map((i) => ({ ts: i * MINUTE, high: 100, low: 100, close: 100 })),
    ...[0, 1, 2].map((i) => ({ ts: OVERNIGHT + i * MINUTE, high: 94, low: 94, close: 94 })),
  ];
  const fx: ReplayFixture = {
    id: "gap-level", symbol: "AAPL", expectedFire: true, label: "gap through a level",
    trigger: { type: "absolute_threshold", direction: "down", price: 96 },
    candles,
  };
  assert.equal(replay(fx).fired, true);
});
