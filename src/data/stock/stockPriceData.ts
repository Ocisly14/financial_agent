import {
  fetchDailyBars,
  fetchIntradayBars,
  getSnapshotCached,
  type DailyBar,
  type Snapshot,
} from "./alpacaClient.ts";
import type { BarRepository } from "./barRepository.ts";
import { etDateString, marketSession, type MarketSession } from "./marketHours.ts";
import { getSharedBarRepository } from "./sharedRepository.ts";
import { MAX_RANGE_DAYS } from "./stockChartData.ts";

export const STOCK_PRICE_DATA_SOURCE = "Alpaca (IEX feed)";

/**
 * How many 1-minute bars to pull from the store before slicing off the latest session.
 * 960 is 04:00-20:00 ET, so a full extended-hours day survives the slice even when the tail
 * of the window still holds the previous session.
 */
const INTRADAY_LOOKBACK_BARS = 960;

export type StockPriceData = {
  symbol: string;
  price: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  prevClose: number | null;
  changePercent: number | null;
  volume: number | null;
  marketSession: MarketSession;
  quoteTimestamp: string | null;
  dailyBars: DailyBar[];
  dataSource: string;
  intradayBars?: DailyBar[];
  /** Bars for the requested `window`, unabridged. Absent when the range could
   *  not be served; `windowNote` then says why. */
  windowBars?: DailyBar[];
  /** Present only when the requested window could not be served as asked. */
  windowNote?: string;
  /** Present only when `dailyBars` came back empty because the local store
   *  could not be read, rather than because the ticker genuinely has no
   *  history in the requested range. */
  dailyNote?: string;
  staleness?: string;
};

export type StockPriceQuery = {
  symbol: string;
  historyDays: number;
  includeIntraday: boolean;
  /** An absolute, inclusive date range, independent of `historyDays`. The two
   *  have different anchors — trailing-from-today versus fixed — so they are not
   *  two spellings of one thing, and both may be present. */
  window?: { from: string; to: string };
};

export type StockPriceDataDeps = {
  /** `null` explicitly selects direct-Alpaca fallback; undefined uses the shared repository. */
  repository?: BarRepository | null;
  snapshot?: (symbol: string, nowMs: number) => Promise<Snapshot>;
  dailyBars?: (symbol: string, from: string, to: string) => Promise<DailyBar[]>;
  intradayBars?: (symbol: string, day: string) => Promise<DailyBar[]>;
  now?: () => Date;
};

export type StockPriceDataResult =
  | { ok: true; data: StockPriceData }
  | { ok: false; error: string };

/**
 * Keeps only the bars sharing the newest bar's calendar day.
 *
 * The window is "the most recent session", not "today": on a weekend or before the
 * open there is no today, and the last real session is the useful answer — the same
 * rule the intraday chart applies (see stockChartData.ts). Every bar carries its own
 * timestamp, so a caller reading a Friday session on a Sunday can tell.
 */
function latestSession(bars: DailyBar[]): DailyBar[] {
  const latest = bars[bars.length - 1];
  if (!latest) return [];
  const day = latest.t.slice(0, 10);
  return bars.filter((item) => item.t.slice(0, 10) === day);
}

function pct(current: number, base: number): number | null {
  if (!isFinite(base) || base === 0) return null;
  return parseFloat((((current - base) / base) * 100).toFixed(2));
}

/** MAX_RANGE_DAYS (1260) is a budget of *trading* days, matching the depth the
 *  local store actually backfills (about five years). capWindowStart works in
 *  calendar days on purpose — bounding a memory read doesn't need a market
 *  calendar — so the trading-day budget is converted using the conventional
 *  ~252 trading days per year. Using MAX_RANGE_DAYS directly as a calendar-day
 *  count would cap at ~3.45 years instead of ~5, truncating windows the store
 *  can actually serve. */
const MAX_WINDOW_CALENDAR_DAYS = Math.round((MAX_RANGE_DAYS * 365) / 252);

/** Pull a window's start forward so it spans at most MAX_WINDOW_CALENDAR_DAYS
 *  calendar days back from its end. Calendar days, not trading days: the cap
 *  exists to bound how much gets read into memory, and converting to trading
 *  days here would need a market calendar for no gain. */
function capWindowStart(from: string, to: string): string {
  const end = new Date(`${to}T00:00:00Z`);
  const earliest = new Date(end);
  earliest.setUTCDate(earliest.getUTCDate() - MAX_WINDOW_CALENDAR_DAYS);
  const earliestIso = earliest.toISOString().slice(0, 10);
  return from < earliestIso ? earliestIso : from;
}

/**
 * Stock quote use case. Handles the full assembly of the local history store, Alpaca fallback,
 * snapshot, and intraday data, so the upstream MCP/HTTP adapters don't need to know whether the
 * data came from the network or from SQLite.
 */
export async function loadStockPriceData(
  query: StockPriceQuery,
  deps: StockPriceDataDeps = {},
): Promise<StockPriceDataResult> {
  const current = deps.now?.() ?? new Date();
  const loadSnapshot = deps.snapshot ?? getSnapshotCached;
  const loadDailyBars = deps.dailyBars ?? fetchDailyBars;
  const loadIntradayBars = deps.intradayBars ?? fetchIntradayBars;

  const repository =
    deps.repository === undefined ? await getSharedBarRepository() : deps.repository;

  let dailyBars: DailyBar[] = [];
  let dailyNote: string | undefined;
  try {
    if (repository) {
      dailyBars = await repository.getBars(query.symbol, "1Day", query.historyDays);
    } else {
      // Falls back to pure-API mode when SQLite is unavailable; over-fetches calendar days to cover the needed trading days.
      const from = new Date(current);
      from.setUTCDate(from.getUTCDate() - Math.ceil(query.historyDays * 1.5) - 5);
      const fetched = await loadDailyBars(
        query.symbol,
        from.toISOString().slice(0, 10),
        etDateString(current),
      );
      dailyBars = fetched.slice(Math.max(0, fetched.length - query.historyDays));
    }
  } catch (error) {
    // An empty `dailyBars` here is otherwise indistinguishable from a ticker
    // that genuinely has no history — this note is what tells them apart.
    dailyBars = [];
    dailyNote = `Daily history for ${query.symbol} could not be loaded: ${
      error instanceof Error ? error.message : String(error)
    }.`;
  }

  let snapshot: Snapshot | undefined;
  let snapshotError: string | undefined;
  try {
    snapshot = await loadSnapshot(query.symbol, current.getTime());
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error);
  }

  const latestBar = dailyBars[dailyBars.length - 1];
  if (!snapshot && !latestBar) {
    return { ok: false, error: snapshotError ?? "no data" };
  }

  const staleness =
    !snapshot && latestBar
      ? `Live quote unavailable; the most recent data is the daily close for ${latestBar.t}.`
      : undefined;
  const price = snapshot?.price ?? latestBar?.c ?? null;
  const prevClose =
    snapshot?.prevClose ?? (dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2]!.c : null);

  let intradayBars: DailyBar[] | undefined;
  if (query.includeIntraday) {
    try {
      // The store already holds minute bars for anything that has been charted or
      // run through an indicator, and refreshes them on a 60-second window, so going
      // through it costs nothing extra and spends no upstream quota on a repeat call.
      // Only when SQLite is out of reach does this fall back to a direct fetch.
      intradayBars = repository
        ? latestSession(await repository.getBars(query.symbol, "1Min", INTRADAY_LOOKBACK_BARS))
        : await loadIntradayBars(query.symbol, etDateString(current));
    } catch {
      intradayBars = [];
    }
  }

  let windowBars: DailyBar[] | undefined;
  let windowNote: string | undefined;
  if (query.window) {
    const { from, to } = query.window;
    if (from > to) {
      // Not swapped: an inverted range is a mistake upstream, and silently
      // fixing it hides that the model asked for something it did not mean.
      windowNote = `The window was ignored: its end (${to}) is before its start (${from}).`;
    } else {
      const capped = capWindowStart(from, to);
      if (capped !== from) {
        windowNote = `The requested start ${from} was truncated to ${capped} to stay within the ${MAX_RANGE_DAYS}-trading-day budget (~${MAX_WINDOW_CALENDAR_DAYS} calendar days) before ${to}.`;
      }
      if (!repository) {
        // Distinct from "no bars in range": this is a claim about the system,
        // not about the market, and the two must not read the same.
        windowNote = `The local bar store is unavailable, so the window ${capped}..${to} could not be checked for ${query.symbol}.`;
      } else {
        try {
          // `repository` is already resolved at the top of loadStockPriceData —
          // do NOT re-resolve it here.
          const bars = await repository.getBarsBetween(query.symbol, "1Day", capped, to);
          if (bars.length > 0) windowBars = bars;
          else {
            windowNote = `No stored bars fall in ${capped}..${to} for ${query.symbol}.`;
          }
        } catch {
          windowNote = `The window ${capped}..${to} could not be read.`;
        }
      }
    }
  }

  return {
    ok: true,
    data: {
      symbol: query.symbol,
      price,
      bidPrice: snapshot?.bidPrice ?? null,
      askPrice: snapshot?.askPrice ?? null,
      dayOpen: snapshot?.dayOpen ?? latestBar?.o ?? null,
      dayHigh: snapshot?.dayHigh ?? latestBar?.h ?? null,
      dayLow: snapshot?.dayLow ?? latestBar?.l ?? null,
      prevClose,
      changePercent: price !== null && prevClose !== null ? pct(price, prevClose) : null,
      volume: snapshot?.volume ?? latestBar?.v ?? null,
      marketSession: marketSession(current),
      quoteTimestamp: snapshot?.quoteTimestamp ?? latestBar?.t ?? null,
      dailyBars,
      dataSource: STOCK_PRICE_DATA_SOURCE,
      ...(intradayBars ? { intradayBars } : {}),
      ...(windowBars ? { windowBars } : {}),
      ...(windowNote ? { windowNote } : {}),
      ...(dailyNote ? { dailyNote } : {}),
      ...(staleness ? { staleness } : {}),
    },
  };
}
