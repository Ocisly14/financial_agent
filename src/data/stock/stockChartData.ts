import type { BarRepository } from "./barRepository.ts";
import type { DailyBar, Snapshot, Timeframe } from "./alpacaClient.ts";
import { etDateString, marketSession, type MarketSession } from "./marketHours.ts";

export const STOCK_CHART_DATA_SOURCE = "Alpaca (IEX feed)";
export const STOCK_CHART_UPSTREAM_CALLS_PER_MINUTE = 120;

export type StockRange = "1D" | "5D" | "1M" | "3M" | "1Y";
type RequestedRange = StockRange | "none";

const RANGE_CONFIG: Record<StockRange, { timeframe: Timeframe; count: number }> = {
  "1D": { timeframe: "1Min", count: 390 },
  "5D": { timeframe: "5Min", count: 390 },
  "1M": { timeframe: "1Day", count: 21 },
  "3M": { timeframe: "1Day", count: 63 },
  "1Y": { timeframe: "1Day", count: 252 },
};

/** Keep this in sync with the client-side StockChart prop validator. */
const SYMBOL_RE = /^[A-Z][A-Z.-]{0,5}$/;

export type StockChartDataDeps = {
  /** Undefined when the local SQLite cache could not be opened. */
  repository: BarRepository | undefined;
  loadSnapshot: (symbol: string, nowMs: number) => Promise<Snapshot>;
  now: () => Date;
  /** False means the process-wide upstream budget is exhausted. */
  allowUpstreamCall: () => boolean;
};

export type StockChartDataResult = { status: number; body: unknown };

export function normalizeSymbol(raw: string): string | undefined {
  const candidate = raw.trim().toUpperCase();
  return SYMBOL_RE.test(candidate) ? candidate : undefined;
}

export function parseRangeParam(raw: string | null): RequestedRange {
  if (raw === "none") return "none";
  return raw === "1D" || raw === "5D" || raw === "1M" || raw === "3M" || raw === "1Y"
    ? raw
    : "1D";
}

/** Fixed-window limiter used to protect the Alpaca data budget. */
export function createRateLimiter(
  max: number,
  windowMs: number,
  now: () => number = Date.now,
): () => boolean {
  let windowStart = 0;
  let count = 0;
  return (): boolean => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    if (count >= max) return false;
    count++;
    return true;
  };
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Alpaca 404") || message.startsWith("No snapshot data");
}

function toQuote(snapshot: Snapshot, prevCloseFallback: number | null): Record<string, unknown> {
  const prevClose = snapshot.prevClose ?? prevCloseFallback;
  const changePercent =
    snapshot.price !== null && prevClose !== null && prevClose !== 0
      ? parseFloat((((snapshot.price - prevClose) / prevClose) * 100).toFixed(2))
      : null;
  return {
    price: snapshot.price,
    prevClose,
    changePercent,
    bidPrice: snapshot.bidPrice,
    askPrice: snapshot.askPrice,
    dayOpen: snapshot.dayOpen,
    dayHigh: snapshot.dayHigh,
    dayLow: snapshot.dayLow,
    volume: snapshot.volume,
    quoteTimestamp: snapshot.quoteTimestamp,
  };
}

/**
 * Builds the payload consumed by the inline client-side StockChart.
 * `range=none` intentionally omits candles for the high-frequency quote poll.
 */
export async function buildStockChartDataResponse(
  rawSymbol: string,
  rangeParam: string | null,
  deps: StockChartDataDeps,
): Promise<StockChartDataResult> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return { status: 400, body: { error: "invalid_symbol" } };

  if (!deps.allowUpstreamCall()) return { status: 429, body: { error: "rate_limited" } };

  const range = parseRangeParam(rangeParam);
  const current = deps.now();

  let candles: DailyBar[] | undefined;
  let timeframe: Timeframe | undefined;
  if (range !== "none") {
    const config = RANGE_CONFIG[range];
    timeframe = config.timeframe;
    try {
      candles = (await deps.repository?.getBars(symbol, timeframe, config.count)) ?? [];
      if (range === "1D" && candles.length > 0) {
        const latestSession = candles[candles.length - 1]!.t.slice(0, 10);
        candles = candles.filter((bar) => bar.t.slice(0, 10) === latestSession);
      }
    } catch {
      candles = [];
    }
  }

  let snapshot: Snapshot | undefined;
  let snapshotError: unknown;
  try {
    snapshot = await deps.loadSnapshot(symbol, current.getTime());
  } catch (error) {
    snapshotError = error;
  }

  if (!snapshot) {
    const latest = candles?.[candles.length - 1];
    if (!latest) {
      return isNotFound(snapshotError)
        ? { status: 404, body: { error: "symbol_not_found" } }
        : { status: 502, body: { error: "market_data_unavailable" } };
    }
  }

  const latest = candles?.[candles.length - 1];
  const prevCloseFallback = candles && candles.length >= 2 ? candles[candles.length - 2]!.c : null;
  const previousSession =
    range === "1D" && latest !== undefined && latest.t.slice(0, 10) !== etDateString(current);

  return {
    status: 200,
    body: {
      symbol,
      quote: snapshot ? toQuote(snapshot, prevCloseFallback) : null,
      session: marketSession(current),
      range,
      ...(timeframe ? { timeframe } : {}),
      ...(candles ? { candles } : {}),
      staleness: !snapshot
        ? { reason: "quote_unavailable", asOf: latest!.t }
        : previousSession
          ? { reason: "previous_session", asOf: latest!.t.slice(0, 10) }
          : null,
      dataSource: STOCK_CHART_DATA_SOURCE,
      fetchedAtMs: current.getTime(),
    },
  };
}

export type { MarketSession };
