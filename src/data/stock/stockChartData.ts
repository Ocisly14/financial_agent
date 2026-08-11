import type { BarRepository } from "./barRepository.ts";
import type { DailyBar, Snapshot, Timeframe } from "./alpacaClient.ts";
import { etDateString, marketSession, type MarketSession } from "./marketHours.ts";

export const STOCK_CHART_DATA_SOURCE = "Alpaca (IEX feed)";
export const STOCK_CHART_UPSTREAM_CALLS_PER_MINUTE = 120;

/**
 * A chart range is a NUMBER OF TRADING DAYS — not a label.
 *
 * The previous fixed enum ("1D" | "5D" | "1M" | "3M" | "1Y") could not express a
 * window nobody had thought to add: a request for six months arrived as "6M",
 * failed every membership test on the way in, and silently degraded to a
 * one-day intraday chart that looked perfectly normal. A day count has no
 * missing members, so that failure mode does not exist. Conventional windows
 * are just numbers: 21 ≈ 1 month, 63 ≈ 3 months, 126 ≈ 6 months, 252 ≈ 1 year.
 */
export type StockRange = number;
type RequestedRange = StockRange | "none";

/** The shortest window that means anything: one trading day. */
export const MIN_RANGE_DAYS = 1;

/**
 * Upper bound on a requested window, set by what the bar store can actually
 * serve rather than by taste. `barRepository.ts` backfills daily bars over
 * `DEFAULT_BACKFILL_YEARS` (5) years, so at ~252 trading days per year the
 * deepest daily history that ever exists locally is 5 * 252 = 1260 bars.
 * Asking for more cannot return more; it can only mislead. Raise this only
 * together with that backfill window.
 */
export const MAX_RANGE_DAYS = 1260;

/** Read-path fallback only — never used to coerce a value on the way into storage. */
export const DEFAULT_RANGE_DAYS = 1;

/**
 * The rule that replaced the old fixed `RANGE_CONFIG` table.
 *
 * It reproduces every entry of that table exactly: 1 -> 1Min/390 (was "1D"),
 * 5 -> 5Min/390 (was "5D"), 21 -> 1Day/21 (was "1M"), 63 -> 1Day/63 (was "3M"),
 * 252 -> 1Day/252 (was "1Y"). 390 is a full regular session in minutes, which
 * is why both intraday tiers ask for that many bars rather than a multiple of
 * the day count.
 */
export function barsForRangeDays(days: number): { timeframe: Timeframe; count: number } {
  if (days <= 1) return { timeframe: "1Min", count: 390 };
  if (days <= 5) return { timeframe: "5Min", count: 390 };
  return { timeframe: "1Day", count: days };
}

/**
 * Strict validator for every WRITE boundary (HTTP charts endpoint, agent
 * tools). Returns undefined for anything that is not a whole number of trading
 * days inside the servable window — callers reject rather than substitute, so
 * a bad range can never reach storage and re-create the silent-fallback bug.
 */
export function parseRangeDays(value: unknown): number | undefined {
  const days = typeof value === "number" ? value : durationToDays(value);
  return Number.isInteger(days) && days >= MIN_RANGE_DAYS && days <= MAX_RANGE_DAYS
    ? days
    : undefined;
}

/** Trading days per unit. Everything downstream of this function is days. */
const UNIT_DAYS: Record<string, number> = { D: 1, W: 5, M: 21, Y: 252 };

/**
 * Accepts a day count *or* a conventional duration (`1Y`, `6M`) and returns
 * days. This is the only place a unit exists; the whole pipeline below is days.
 *
 * Both forms are accepted deliberately. Messages already in the event log carry
 * `range: "1Y"`, and rejecting those would silently redraw every historical
 * chart as a single intraday session — the same silent-fallback failure this
 * change exists to remove. Mirrors `parseStockRange` in client/src/lib/stockChart.ts.
 */
function durationToDays(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const text = value.trim().toUpperCase();
  if (text === "") return Number.NaN;
  const duration = /^(\d+)([DWMY])$/.exec(text);
  if (duration) return Number(duration[1]) * UNIT_DAYS[duration[2]!]!;
  return Number(text);
}

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

/**
 * READ path only. `range=none` is the high-frequency quote poll and skips
 * candles entirely. Anything else must be a valid day count; an unparseable
 * query string still falls back here, but by the time a range reaches this
 * function from storage it has already been validated on write.
 */
export function parseRangeParam(raw: string | null): RequestedRange {
  if (raw === "none") return "none";
  return parseRangeDays(raw) ?? DEFAULT_RANGE_DAYS;
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
    const config = barsForRangeDays(range);
    timeframe = config.timeframe;
    try {
      candles = (await deps.repository?.getBars(symbol, timeframe, config.count)) ?? [];
      if (range <= 1 && candles.length > 0) {
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
    range !== "none" && range <= 1 && latest !== undefined && latest.t.slice(0, 10) !== etDateString(current);

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
