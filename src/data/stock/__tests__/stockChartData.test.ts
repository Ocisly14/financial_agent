import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStockChartDataResponse,
  createRateLimiter,
  normalizeSymbol,
  parseRangeParam,
  type StockChartDataDeps,
} from "../stockChartData.ts";
import type { DailyBar, Snapshot, Timeframe } from "../alpacaClient.ts";

const NOW = new Date("2026-07-28T18:56:07Z");

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

const SNAPSHOT: Snapshot = {
  symbol: "AAPL", price: 339.34, bidPrice: 339.3, askPrice: 339.38,
  dayOpen: 340.02, dayHigh: 342.87, dayLow: 335.63, prevClose: 336.93,
  volume: 1450015, quoteTimestamp: "2026-07-28T18:56:07Z",
};

function makeDeps(over?: Partial<StockChartDataDeps> & { candles?: DailyBar[] }): StockChartDataDeps & {
  repositoryCalls: Array<{ symbol: string; timeframe: Timeframe; count: number }>;
  snapshotCalls: number;
} {
  const repositoryCalls: Array<{ symbol: string; timeframe: Timeframe; count: number }> = [];
  let snapshotCalls = 0;
  const candles = over?.candles ?? [bar("2026-07-28T13:30:00Z", 338)];
  const deps: StockChartDataDeps = {
    repository: {
      getBars: async (symbol, timeframe, count) => {
        repositoryCalls.push({ symbol, timeframe, count });
        return candles.slice(Math.max(0, candles.length - count));
      },
    },
    loadSnapshot: async () => {
      snapshotCalls++;
      return SNAPSHOT;
    },
    now: () => NOW,
    allowUpstreamCall: () => true,
    ...over,
  };
  return Object.assign(deps, {
    repositoryCalls,
    get snapshotCalls() { return snapshotCalls; },
  });
}

test("range=1D returns 1Min candles", async () => {
  const deps = makeDeps({ candles: [bar("2026-07-28T13:30:00Z", 338)] });
  const { status, body } = await buildStockChartDataResponse("AAPL", "1D", deps);
  const payload = body as { range: string; timeframe: string; candles: DailyBar[] };
  assert.equal(status, 200);
  assert.equal(payload.range, "1D");
  assert.equal(payload.timeframe, "1Min");
  assert.equal(payload.candles.length, 1);
  assert.deepEqual(deps.repositoryCalls[0], { symbol: "AAPL", timeframe: "1Min", count: 390 });
});

test("1M / 3M / 1Y share daily bars and fetch up to their own limits", async () => {
  const all = Array.from({ length: 300 }, (_, i) => bar(`2026-${String(i).padStart(3, "0")}`, i));
  for (const [range, count] of [["1M", 21], ["3M", 63], ["1Y", 252]] as const) {
    const deps = makeDeps({ candles: all });
    const { body } = await buildStockChartDataResponse("AAPL", range, deps);
    const payload = body as { timeframe: string; candles: DailyBar[] };
    assert.equal(payload.timeframe, "1Day");
    assert.ok(payload.candles.length <= count);
    assert.equal(deps.repositoryCalls[0]!.count, count);
  }
});

test("range=none returns only the quote, without accessing the repository", async () => {
  const deps = makeDeps();
  const { status, body } = await buildStockChartDataResponse("AAPL", "none", deps);
  assert.equal(status, 200);
  assert.equal("candles" in (body as object), false);
  assert.equal("timeframe" in (body as object), false);
  assert.equal(deps.repositoryCalls.length, 0);
});

test("invalid, empty, and missing range all fall back to 1D", async () => {
  for (const range of ["7D", "abc", "", null]) {
    const { status, body } = await buildStockChartDataResponse("AAPL", range, makeDeps());
    assert.equal(status, 200);
    assert.equal((body as { range: string }).range, "1D");
    assert.equal((body as { timeframe: string }).timeframe, "1Min");
  }
});

test("labels previous_session when today has no minute bars", async () => {
  const deps = makeDeps({ candles: [
    bar("2026-07-27T13:30:00Z", 336),
    bar("2026-07-27T13:31:00Z", 337),
  ] });
  const { body } = await buildStockChartDataResponse("AAPL", "1D", deps);
  assert.deepEqual((body as { staleness: unknown }).staleness, {
    reason: "previous_session", asOf: "2026-07-27",
  });
});

test("rejects an invalid symbol without accessing the data source", async () => {
  const deps = makeDeps();
  const { status, body } = await buildStockChartDataResponse("../etc", "1D", deps);
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "invalid_symbol" });
  assert.equal(deps.repositoryCalls.length, 0);
  assert.equal(deps.snapshotCalls, 0);
});

test("degrades to 200 when snapshot fails but candles are available", async () => {
  const deps = makeDeps({
    loadSnapshot: async () => { throw new Error("Alpaca 500"); },
    candles: [bar("2026-07-27", 336.93)],
  });
  const { status, body } = await buildStockChartDataResponse("AAPL", "1M", deps);
  assert.equal(status, 200);
  assert.equal((body as { quote: unknown }).quote, null);
  assert.equal((body as { staleness: { reason: string } }).staleness.reason, "quote_unavailable");
});

test("returns 502 when both snapshot and candles fail, while 404 stays mapped", async () => {
  for (const [message, expected] of [["Alpaca 500", 502], ["Alpaca 404: no", 404]] as const) {
    const deps = makeDeps({
      loadSnapshot: async () => { throw new Error(message); },
      candles: [],
    });
    assert.equal((await buildStockChartDataResponse("AAPL", "1D", deps)).status, expected);
  }
});

test("rate limiter and symbol/range pure functions preserve boundary behavior", async () => {
  let clock = 1_000_000;
  const allow = createRateLimiter(2, 60_000, () => clock);
  assert.equal(allow(), true);
  assert.equal(allow(), true);
  assert.equal(allow(), false);
  clock += 60_001;
  assert.equal(allow(), true);
  assert.equal(normalizeSymbol("  aapl "), "AAPL");
  assert.equal(normalizeSymbol("../etc"), undefined);
  assert.equal(parseRangeParam("5D"), "5D");
  assert.equal(parseRangeParam("bad"), "1D");

  const deps = makeDeps({ allowUpstreamCall: () => false });
  assert.equal((await buildStockChartDataResponse("AAPL", "1D", deps)).status, 429);
  assert.equal(deps.snapshotCalls, 0);
});
