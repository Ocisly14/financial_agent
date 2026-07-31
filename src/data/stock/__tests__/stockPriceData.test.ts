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
      repository: { getBars: async () => [bar("2026-07-27", 100)] },
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

test("data layer returns the latest close price and a staleness marker when snapshot is unavailable", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false },
    {
      repository: { getBars: async () => [bar("2026-07-27", 100)] },
      snapshot: async () => { throw new Error("network down"); },
      now: () => NOW,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.price, 100);
  assert.match(result.data.staleness ?? "", /2026-07-27/);
});
