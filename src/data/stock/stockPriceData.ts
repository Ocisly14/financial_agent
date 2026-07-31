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

export const STOCK_PRICE_DATA_SOURCE = "Alpaca (IEX feed)";

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
  staleness?: string;
};

export type StockPriceQuery = {
  symbol: string;
  historyDays: number;
  includeIntraday: boolean;
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

function pct(current: number, base: number): number | null {
  if (!isFinite(base) || base === 0) return null;
  return parseFloat((((current - base) / base) * 100).toFixed(2));
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

  let dailyBars: DailyBar[] = [];
  try {
    const repository =
      deps.repository === undefined ? await getSharedBarRepository() : deps.repository;
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
  } catch {
    dailyBars = [];
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
      intradayBars = await loadIntradayBars(query.symbol, etDateString(current));
    } catch {
      intradayBars = [];
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
      ...(staleness ? { staleness } : {}),
    },
  };
}
