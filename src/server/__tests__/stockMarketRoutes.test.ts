import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStockQuoteResponse,
  createRateLimiter,
  normalizeSymbol,
  parseRangeParam,
  type StockQuoteDeps,
} from "../stockMarketRoutes.ts";
import type { DailyBar, Snapshot, Timeframe } from "../../../mcp_tools/stock/alpacaClient.ts";

const NOW = new Date("2026-07-28T18:56:07Z");

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

const SNAPSHOT: Snapshot = {
  symbol: "AAPL", price: 339.34, bidPrice: 339.3, askPrice: 339.38,
  dayOpen: 340.02, dayHigh: 342.87, dayLow: 335.63, prevClose: 336.93,
  volume: 1450015, quoteTimestamp: "2026-07-28T18:56:07Z",
};

function makeDeps(over?: Partial<StockQuoteDeps> & { candles?: DailyBar[] }): StockQuoteDeps & {
  repositoryCalls: Array<{ symbol: string; timeframe: Timeframe; count: number }>;
  snapshotCalls: number;
} {
  const repositoryCalls: Array<{ symbol: string; timeframe: Timeframe; count: number }> = [];
  let snapshotCalls = 0;
  const candles = over?.candles ?? [bar("2026-07-28T13:30:00Z", 338)];
  const deps: StockQuoteDeps = {
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

test("range=1D 返回 1Min candles", async () => {
  const deps = makeDeps({ candles: [bar("2026-07-28T13:30:00Z", 338)] });
  const { status, body } = await buildStockQuoteResponse("AAPL", "1D", deps);
  const payload = body as { range: string; timeframe: string; candles: DailyBar[] };
  assert.equal(status, 200);
  assert.equal(payload.range, "1D");
  assert.equal(payload.timeframe, "1Min");
  assert.equal(payload.candles.length, 1);
  assert.deepEqual(deps.repositoryCalls[0], { symbol: "AAPL", timeframe: "1Min", count: 390 });
});

test("1M / 3M / 1Y 共用日线并按各自上限取数", async () => {
  const all = Array.from({ length: 300 }, (_, i) => bar(`2026-${String(i).padStart(3, "0")}`, i));
  for (const [range, count] of [["1M", 21], ["3M", 63], ["1Y", 252]] as const) {
    const deps = makeDeps({ candles: all });
    const { body } = await buildStockQuoteResponse("AAPL", range, deps);
    const payload = body as { timeframe: string; candles: DailyBar[] };
    assert.equal(payload.timeframe, "1Day");
    assert.ok(payload.candles.length <= count);
    assert.equal(deps.repositoryCalls[0]!.count, count);
  }
});

test("range=none 只返回报价，不访问 repository", async () => {
  const deps = makeDeps();
  const { status, body } = await buildStockQuoteResponse("AAPL", "none", deps);
  assert.equal(status, 200);
  assert.equal("candles" in (body as object), false);
  assert.equal("timeframe" in (body as object), false);
  assert.equal(deps.repositoryCalls.length, 0);
});

test("非法、空和缺失 range 都回退 1D", async () => {
  for (const range of ["7D", "abc", "", null]) {
    const { status, body } = await buildStockQuoteResponse("AAPL", range, makeDeps());
    assert.equal(status, 200);
    assert.equal((body as { range: string }).range, "1D");
    assert.equal((body as { timeframe: string }).timeframe, "1Min");
  }
});

test("当日无分钟线时标注 previous_session", async () => {
  const deps = makeDeps({ candles: [
    bar("2026-07-27T13:30:00Z", 336),
    bar("2026-07-27T13:31:00Z", 337),
  ] });
  const { body } = await buildStockQuoteResponse("AAPL", "1D", deps);
  assert.deepEqual((body as { staleness: unknown }).staleness, {
    reason: "previous_session", asOf: "2026-07-27",
  });
});

test("拒绝非法 symbol 且不访问数据源", async () => {
  const deps = makeDeps();
  const { status, body } = await buildStockQuoteResponse("../etc", "1D", deps);
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "invalid_symbol" });
  assert.equal(deps.repositoryCalls.length, 0);
  assert.equal(deps.snapshotCalls, 0);
});

test("snapshot 失败但 candles 可用时降级为 200", async () => {
  const deps = makeDeps({
    loadSnapshot: async () => { throw new Error("Alpaca 500"); },
    candles: [bar("2026-07-27", 336.93)],
  });
  const { status, body } = await buildStockQuoteResponse("AAPL", "1M", deps);
  assert.equal(status, 200);
  assert.equal((body as { quote: unknown }).quote, null);
  assert.equal((body as { staleness: { reason: string } }).staleness.reason, "quote_unavailable");
});

test("snapshot 与 candles 都失败时返回 502，404 保持映射", async () => {
  for (const [message, expected] of [["Alpaca 500", 502], ["Alpaca 404: no", 404]] as const) {
    const deps = makeDeps({
      loadSnapshot: async () => { throw new Error(message); },
      candles: [],
    });
    assert.equal((await buildStockQuoteResponse("AAPL", "1D", deps)).status, expected);
  }
});

test("限流器和 symbol/range 纯函数保持边界行为", async () => {
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
  assert.equal((await buildStockQuoteResponse("AAPL", "1D", deps)).status, 429);
  assert.equal(deps.snapshotCalls, 0);
});
