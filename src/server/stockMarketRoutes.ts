import type * as http from "node:http";
import {
  buildStockChartDataResponse,
  createRateLimiter,
  getSharedBarRepository,
  STOCK_CHART_UPSTREAM_CALLS_PER_MINUTE,
  type StockChartDataDeps,
} from "../data/stock/index.ts";
import { realtimeSnapshotLoader } from "../data/stock/realtime/snapshotLoader.ts";

export {
  barsForRangeDays,
  buildStockChartDataResponse,
  createRateLimiter,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  MIN_RANGE_DAYS,
  normalizeSymbol,
  parseRangeDays,
  parseRangeParam,
  type MarketSession,
  type StockChartDataDeps,
  type StockChartDataResult,
  type StockRange,
} from "../data/stock/index.ts";

const allowUpstreamCall = createRateLimiter(STOCK_CHART_UPSTREAM_CALLS_PER_MINUTE, 60_000);

async function defaultDeps(): Promise<StockChartDataDeps> {
  return {
    repository: await getSharedBarRepository(),
    loadSnapshot: realtimeSnapshotLoader(),
    now: () => new Date(),
    allowUpstreamCall,
  };
}

/** Thin HTTP adapter around the stock-owned chart data builder. */
export async function handleStockQuote(
  rawSymbol: string,
  sp: URLSearchParams,
  res: http.ServerResponse,
  deps?: StockChartDataDeps,
): Promise<void> {
  const { status, body } = await buildStockChartDataResponse(
    decodeURIComponent(rawSymbol),
    sp.get("range"),
    deps ?? (await defaultDeps()),
  );
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
