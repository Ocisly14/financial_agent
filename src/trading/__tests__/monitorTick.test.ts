import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_INTERVAL_MS, REST_FALLBACK_INTERVAL_MS, runOnce, resetMonitorState } from "../strategyMonitor.ts";
import type { StoredStrategy } from "../persistence/strategyStore.ts";
import type { RealtimeFeed } from "../../data/stock/realtime/index.ts";
import type { OhlcSample } from "../../data/stock/realtime/buckets.ts";

const NOW = new Date("2026-08-14T14:00:00Z");

/** A RealtimeFeed the test drives by hand. */
function fakeFeed(overrides: Partial<RealtimeFeed> = {}) {
  const reconciled: string[][] = [];
  const recorded: { symbol: string; price: number }[] = [];
  const feed: RealtimeFeed = {
    start() {},
    stop() {},
    latestPrice: async () => 0,
    latestSnapshot: async () => { throw new Error("unused"); },
    currentPrice: () => undefined,
    window: () => [] as OhlcSample[],
    isArmed: () => true,
    reconcileStrategySymbols: (symbols) => { reconciled.push([...symbols]); },
    recordPrice: (symbol, price) => { recorded.push({ symbol, price }); },
    subscribePrice: () => () => {},
    sweep() {},
    status: () => ({ state: "connected", pinned: 0, leased: 0, capacity: 30, overflow: [] }),
    ...overrides,
  };
  return { feed, reconciled, recorded };
}

function strategy(overrides: Partial<StoredStrategy> = {}): StoredStrategy {
  return {
    id: "strat-1",
    owner: "test",
    symbol: "AAPL",
    status: "active",
    created_at: NOW.toISOString(),
    dsl: {
      name: "test",
      symbol: "AAPL",
      mode: "paper",
      phases: [
        {
          id: "p1",
          name: "buy the dip",
          status: "active",
          depends_on: [],
          activate_on: "phase_completed",
          price_trigger: { type: "absolute_threshold", direction: "down", price: 100 },
          action: { side: "BUY", size: { type: "fixed_base_qty", value: 1 }, order_type: "market", max_slippage_bps: 50 },
          recurrence: { mode: "one_shot", reanchor: false, trigger_count: 0 },
        },
      ],
    },
    ...overrides,
  } as StoredStrategy;
}

function deps(feed: RealtimeFeed, overrides: Record<string, unknown> = {}) {
  return {
    feed,
    listActive: async () => [strategy()],
    save: async () => {},
    execute: async () => ({ execution_id: "exec-1", placed: true, fill_price: 99, quantity: 1 }),
    fetchPrice: async () => 99,
    ...overrides,
  };
}

test("the active tick matches the realtime bucket width", () => {
  assert.equal(ACTIVE_INTERVAL_MS, 500);
});

test("a tick pins the symbols of every active strategy", async () => {
  resetMonitorState();
  const { feed, reconciled } = fakeFeed({ currentPrice: () => 99 });
  await runOnce(NOW, deps(feed));

  assert.deepEqual(reconciled, [["AAPL"]]);
});

test("a buffered price is used without any REST call", async () => {
  resetMonitorState();
  let restCalls = 0;
  const { feed } = fakeFeed({ currentPrice: () => 99 });
  await runOnce(NOW, deps(feed, { fetchPrice: async () => { restCalls++; return 99; } }));

  assert.equal(restCalls, 0);
});

test("an empty buffer falls back to REST and writes the price back into the buffer", async () => {
  resetMonitorState();
  const { feed, recorded } = fakeFeed();
  await runOnce(NOW, deps(feed, { fetchPrice: async () => 98.5 }));

  assert.deepEqual(recorded, [{ symbol: "AAPL", price: 98.5 }]);
});

test("the REST fallback is rate limited even though the tick is not", async () => {
  resetMonitorState();
  let restCalls = 0;
  const { feed } = fakeFeed();
  const options = deps(feed, { fetchPrice: async () => { restCalls++; return 98.5; } });

  // Fourteen ticks at 500ms cover seven seconds — one fallback window.
  for (let tick = 0; tick < 14; tick++) {
    await runOnce(new Date(NOW.getTime() + tick * ACTIVE_INTERVAL_MS), options);
  }

  assert.equal(restCalls, 1, `expected one call per ${REST_FALLBACK_INTERVAL_MS}ms`);
});

test("a met condition fires on the first sample that shows it", async () => {
  resetMonitorState();
  let fired = 0;
  const { feed } = fakeFeed({ currentPrice: () => 99 }); // below the 100 threshold
  await runOnce(NOW, deps(feed, {
    execute: async () => { fired++; return { execution_id: "e", placed: true, fill_price: 99, quantity: 1 }; },
  }));

  assert.equal(fired, 1);
});

test("a condition that is not met does not fire", async () => {
  resetMonitorState();
  let fired = 0;
  const { feed } = fakeFeed({ currentPrice: () => 101 }); // above the 100 threshold
  await runOnce(NOW, deps(feed, {
    execute: async () => { fired++; return { execution_id: "e", placed: true, fill_price: 101, quantity: 1 }; },
  }));

  assert.equal(fired, 0);
});

test("a rolling-change phase waits for its window to arm", async () => {
  resetMonitorState();
  let fired = 0;
  const rolling = strategy();
  rolling.dsl.phases[0]!.price_trigger = {
    type: "rolling_change", direction: "down", pct: 1, window_minutes: 10,
  };
  const { feed } = fakeFeed({
    currentPrice: () => 90,
    isArmed: () => false,
    window: () => [{ ts: NOW.getTime() - 600_000, high: 100, low: 100, close: 100 }],
  });
  await runOnce(NOW, deps(feed, {
    listActive: async () => [rolling],
    execute: async () => { fired++; return { execution_id: "e", placed: true, fill_price: 90, quantity: 1 }; },
  }));

  assert.equal(fired, 0, "an unarmed window must not be evaluated");
});

test("a live-mode strategy is paused rather than executed", async () => {
  resetMonitorState();
  const live = strategy();
  (live.dsl as { mode: string }).mode = "live";
  const saved: StoredStrategy[] = [];
  const { feed } = fakeFeed({ currentPrice: () => 99 });
  await runOnce(NOW, deps(feed, {
    listActive: async () => [live],
    save: async (s: StoredStrategy) => { saved.push(s); },
  }));

  assert.equal(saved.at(-1)?.status, "paused");
});
