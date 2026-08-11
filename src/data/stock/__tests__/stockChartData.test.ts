import test from "node:test";
import assert from "node:assert/strict";
import {
  barsForRangeDays,
  buildStockChartDataResponse,
  createRateLimiter,
  MAX_RANGE_DAYS,
  normalizeSymbol,
  parseRangeDays,
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
      getBarsBetween: async () => [],
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

test("range=1 (one trading day) returns 1Min candles", async () => {
  const deps = makeDeps({ candles: [bar("2026-07-28T13:30:00Z", 338)] });
  const { status, body } = await buildStockChartDataResponse("AAPL", "1", deps);
  const payload = body as { range: number; timeframe: string; candles: DailyBar[] };
  assert.equal(status, 200);
  assert.equal(payload.range, 1);
  assert.equal(payload.timeframe, "1Min");
  assert.equal(payload.candles.length, 1);
  assert.deepEqual(deps.repositoryCalls[0], { symbol: "AAPL", timeframe: "1Min", count: 390 });
});

test("the timeframe rule reproduces the table it replaced", () => {
  // Every entry of the deleted RANGE_CONFIG, by its old label.
  assert.deepEqual(barsForRangeDays(1), { timeframe: "1Min", count: 390 }, "was 1D");
  assert.deepEqual(barsForRangeDays(5), { timeframe: "5Min", count: 390 }, "was 5D");
  assert.deepEqual(barsForRangeDays(21), { timeframe: "1Day", count: 21 }, "was 1M");
  assert.deepEqual(barsForRangeDays(63), { timeframe: "1Day", count: 63 }, "was 3M");
  assert.deepEqual(barsForRangeDays(252), { timeframe: "1Day", count: 252 }, "was 1Y");
});

test("the timeframe rule switches tiers at 1, 5 and 6 trading days", () => {
  assert.equal(barsForRangeDays(1).timeframe, "1Min");
  assert.equal(barsForRangeDays(2).timeframe, "5Min", "just past the intraday-minute tier");
  assert.equal(barsForRangeDays(5).timeframe, "5Min", "last day of the 5Min tier");
  assert.deepEqual(barsForRangeDays(6), { timeframe: "1Day", count: 6 }, "first daily-bar range");
  // 6M — the window whose absence from the old enum caused the bug.
  assert.deepEqual(barsForRangeDays(126), { timeframe: "1Day", count: 126 });
});

test("daily ranges share daily bars and fetch exactly their own day count", async () => {
  const all = Array.from({ length: 300 }, (_, i) => bar(`2026-${String(i).padStart(3, "0")}`, i));
  for (const days of [21, 63, 126, 252]) {
    const deps = makeDeps({ candles: all });
    const { body } = await buildStockChartDataResponse("AAPL", String(days), deps);
    const payload = body as { timeframe: string; candles: DailyBar[] };
    assert.equal(payload.timeframe, "1Day");
    assert.ok(payload.candles.length <= days);
    assert.equal(deps.repositoryCalls[0]!.count, days);
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

test("an unusable range on the READ path still falls back to one day", async () => {
  // A last resort only: every write boundary now rejects, so nothing invalid
  // should reach here from storage. A hand-typed query string still can.
  for (const range of ["abc", "", "0", "-5", "2.5", String(MAX_RANGE_DAYS + 1), null]) {
    const { status, body } = await buildStockChartDataResponse("AAPL", range, makeDeps());
    assert.equal(status, 200);
    assert.equal((body as { range: number }).range, 1);
    assert.equal((body as { timeframe: string }).timeframe, "1Min");
  }
});

test("parseRangeDays rejects everything that is not a whole servable day count", () => {
  assert.equal(parseRangeDays(126), 126);
  assert.equal(parseRangeDays("126"), 126);
  assert.equal(parseRangeDays(1), 1);
  assert.equal(parseRangeDays(MAX_RANGE_DAYS), MAX_RANGE_DAYS);
  for (const bad of [0, -1, 2.5, MAX_RANGE_DAYS + 1, "", null, undefined, {}, NaN, Infinity, "6Q", "M6"]) {
    assert.equal(parseRangeDays(bad), undefined, `${String(bad)} must be rejected`);
  }
});

test("a conventional duration is accepted and converted to days", () => {
  // Messages already in the event log carry `range: "1Y"`. Rejecting those
  // would silently redraw every historical chart as one intraday session —
  // the very failure this change removes. The unit exists only here; the
  // whole pipeline below is a day count.
  assert.equal(parseRangeDays("1Y"), 252);
  assert.equal(parseRangeDays("6M"), 126);
  assert.equal(parseRangeDays("5D"), 5);
  assert.equal(parseRangeDays("2w"), 10, "lowercase and weeks both parse");
});

test("labels previous_session when today has no minute bars", async () => {
  const deps = makeDeps({ candles: [
    bar("2026-07-27T13:30:00Z", 336),
    bar("2026-07-27T13:31:00Z", 337),
  ] });
  const { body } = await buildStockChartDataResponse("AAPL", "1", deps);
  assert.deepEqual((body as { staleness: unknown }).staleness, {
    reason: "previous_session", asOf: "2026-07-27",
  });
});

test("rejects an invalid symbol without accessing the data source", async () => {
  const deps = makeDeps();
  const { status, body } = await buildStockChartDataResponse("../etc", "1", deps);
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
  const { status, body } = await buildStockChartDataResponse("AAPL", "21", deps);
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
    assert.equal((await buildStockChartDataResponse("AAPL", "1", deps)).status, expected);
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
  assert.equal(parseRangeParam("5"), 5);
  assert.equal(parseRangeParam("none"), "none");
  assert.equal(parseRangeParam("bad"), 1);

  const deps = makeDeps({ allowUpstreamCall: () => false });
  assert.equal((await buildStockChartDataResponse("AAPL", "1", deps)).status, 429);
  assert.equal(deps.snapshotCalls, 0);
});
