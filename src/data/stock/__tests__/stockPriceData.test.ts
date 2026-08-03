import test from "node:test";
import assert from "node:assert/strict";
import { loadStockPriceData } from "../stockPriceData.ts";
import type { DailyBar, Snapshot } from "../alpacaClient.ts";

const NOW = new Date("2026-07-28T18:00:00Z");

function bar(t: string, c: number): DailyBar {
  return { t, o: c - 1, h: c + 1, l: c - 2, c, v: 1_000, vw: c };
}

const SNAPSHOT: Snapshot = {
  symbol: "AAPL",
  price: 102,
  bidPrice: 101.9,
  askPrice: 102.1,
  dayOpen: 100,
  dayHigh: 103,
  dayLow: 99,
  prevClose: 100,
  volume: 2_000,
  quoteTimestamp: "2026-07-28T18:00:00Z",
};

test("assembles local daily bars with Alpaca snapshot and computes change percent", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false },
    {
      repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.price, 102);
  assert.equal(result.data.changePercent, 2);
  assert.equal(result.data.dailyBars.length, 1);
  assert.equal(result.data.marketSession, "regular");
});

test("data layer falls back directly to Alpaca daily bars when the local store is explicitly unavailable", async () => {
  const calls: Array<{ from: string; to: string }> = [];
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 2, includeIntraday: true },
    {
      repository: null,
      dailyBars: async (_symbol, from, to) => {
        calls.push({ from, to });
        return [bar("2026-07-25", 99), bar("2026-07-27", 100), bar("2026-07-28", 101)];
      },
      intradayBars: async () => [bar("2026-07-28T13:30:00Z", 101)],
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.dailyBars.map((item) => item.t), ["2026-07-27", "2026-07-28"]);
  assert.equal(result.data.intradayBars?.length, 1);
  assert.equal(calls[0]?.to, "2026-07-28");
});

test("intraday bars come from the local store, sliced to the latest session, without touching Alpaca", async () => {
  const requested: Array<{ timeframe: string; count: number }> = [];
  let apiCalls = 0;
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 2, includeIntraday: true },
    {
      repository: {
        getBars: async (_symbol, timeframe, count) => {
          requested.push({ timeframe, count });
          if (timeframe === "1Day") return [bar("2026-07-27", 100), bar("2026-07-28", 101)];
          return [
            bar("2026-07-27T19:59:00Z", 100),
            bar("2026-07-28T13:30:00Z", 101),
            bar("2026-07-28T13:31:00Z", 102),
          ];
        },
        getBarsBetween: async () => [],
      },
      intradayBars: async () => { apiCalls += 1; return []; },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(apiCalls, 0);
  assert.equal(requested.some((call) => call.timeframe === "1Min"), true);
  assert.deepEqual(
    result.data.intradayBars?.map((item) => item.t),
    ["2026-07-28T13:30:00Z", "2026-07-28T13:31:00Z"],
  );
});

test("intraday bars fall back to a direct Alpaca fetch when the local store is unavailable", async () => {
  const days: string[] = [];
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 2, includeIntraday: true },
    {
      repository: null,
      dailyBars: async () => [bar("2026-07-28", 101)],
      intradayBars: async (_symbol, day) => {
        days.push(day);
        return [bar("2026-07-28T13:30:00Z", 101)];
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(days, ["2026-07-28"]);
  assert.equal(result.data.intradayBars?.length, 1);
});

test("data layer returns the latest close price and a staleness marker when snapshot is unavailable", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false },
    {
      repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
      snapshot: async () => { throw new Error("network down"); },
      now: () => NOW,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.price, 100);
  assert.match(result.data.staleness ?? "", /2026-07-27/);
});

test("a window is fetched by absolute date and returned unabridged", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "2026-01-01", to: "2026-02-01" } },
    {
      repository: {
        getBars: async () => [bar("2026-07-27", 100)],
        getBarsBetween: async (_s, _tf, from, to) => {
          assert.equal(from, "2026-01-01");
          assert.equal(to, "2026-02-01");
          return [bar("2026-01-05", 50), bar("2026-01-30", 60)];
        },
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.deepEqual(result.data.windowBars?.map((b) => b.t), ["2026-01-05", "2026-01-30"]);
  assert.equal(result.data.windowNote, undefined);
});

test("a window with no local coverage reports why rather than returning empty", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "1990-01-01", to: "1990-06-01" } },
    {
      repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.equal(result.data.windowBars, undefined);
  assert.match(result.data.windowNote ?? "", /1990-01-01/);
});

test("an inverted window is refused, not silently swapped", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "2026-06-01", to: "2026-01-01" } },
    {
      repository: {
        getBars: async () => [bar("2026-07-27", 100)],
        getBarsBetween: async () => { throw new Error("must not be called for an inverted range"); },
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.equal(result.data.windowBars, undefined);
  assert.match(result.data.windowNote ?? "", /before/i);
});

test("an over-long window is truncated back from its end", async () => {
  let askedFrom = "";
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "1990-01-01", to: "2026-01-01" } },
    {
      repository: {
        getBars: async () => [bar("2026-07-27", 100)],
        getBarsBetween: async (_s, _tf, from) => { askedFrom = from; return [bar("2021-01-04", 5)]; },
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.notEqual(askedFrom, "1990-01-01");
  assert.match(result.data.windowNote ?? "", /1260/);
});

test("a repository failure on the daily-bars path is reported, not swallowed into an empty history", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false },
    {
      repository: {
        getBars: async () => { throw new Error("disk I/O error"); },
        getBarsBetween: async () => [],
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.data.dailyBars, []);
  assert.match(result.data.dailyNote ?? "", /AAPL/);
  assert.match(result.data.dailyNote ?? "", /disk I\/O error|could not be loaded/i);
});

test("a window request with no repository reports the store as unavailable, not the market as empty", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "2026-01-01", to: "2026-01-10" } },
    {
      repository: null,
      dailyBars: async () => [bar("2026-07-28", 101)],
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.data.windowBars, undefined);
  assert.match(result.data.windowNote ?? "", /unavailable/i);
  assert.doesNotMatch(result.data.windowNote ?? "", /No stored bars fall in/);
});

test("a window reaching about four years back is served untruncated", async () => {
  // MAX_RANGE_DAYS (1260) is a trading-day budget, matching the store's ~5-year
  // backfill depth. capWindowStart converts it to calendar days at ~252
  // trading days/year, landing near 1825 calendar days (~5 years). A naive
  // calendar-day reading of 1260 would cap at ~3.45 years and wrongly truncate
  // this ~4-year window, which the store actually holds.
  let askedFrom = "";
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "2022-01-01", to: "2026-01-01" } },
    {
      repository: {
        getBars: async () => [bar("2026-07-27", 100)],
        getBarsBetween: async (_s, _tf, from) => { askedFrom = from; return [bar("2022-01-03", 5)]; },
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.equal(askedFrom, "2022-01-01", "a ~4-year window must not be truncated");
  assert.equal(result.data.windowNote, undefined);
});
