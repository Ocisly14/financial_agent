import type { OhlcSample } from "../../mcp_tools/trading/strategy/priceTrigger.ts";

/**
 * Public Binance market-data fetchers (no auth). Used by the strategy monitor
 * for price polling, window backfill, and exchange filter lookups.
 */

// Public market-data host. Defaults to Binance's official data mirror
// (data-api.binance.vision), which serves the same unauthenticated klines /
// ticker / depth / exchangeInfo endpoints but — unlike api.binance.com — is not
// geo-restricted. Override with BINANCE_DATA_BASE if your region prefers
// api.binance.com or another mirror. (Signed trading endpoints are unaffected;
// they live in binanceClient.ts.)
const BINANCE_BASE = process.env["BINANCE_DATA_BASE"] || "https://data-api.binance.vision";

/** Fetch recent OHLC klines and map them to OhlcSample[] (oldest → newest). */
export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<OhlcSample[]> {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines error ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as unknown[];
  return rows.map((row) => {
    const k = row as [number, string, string, string, string, ...unknown[]];
    return {
      ts: Number(k[0]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    };
  });
}

/** One OHLCV bar for the candlestick scope (open included, unlike OhlcSample). */
export interface Candle {
  t: number; // bar open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Map a Binance interval label to its millisecond span (covers the UI set). */
const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/**
 * Fetch the last `limit` full OHLCV candles for `symbol` at `interval`
 * (oldest → newest). Public Binance klines — no auth. Unlike `fetchKlines`
 * this keeps the open and volume the candlestick chart needs. Ported from the
 * financial-agent-0428 backtest data source (realDataSource.ts), pared to the live
 * chart's needs and folded onto the existing Binance fetcher in this file.
 */
export async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const safeInterval = INTERVAL_MS[interval] ? interval : "1m";
  const safeLimit = Math.min(Math.max(limit, 1), 1000);
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(
    symbol,
  )}&interval=${safeInterval}&limit=${safeLimit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines error ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as unknown[];
  return rows.map((row) => {
    const k = row as [number, string, string, string, string, string, ...unknown[]];
    return {
      t: Number(k[0]),
      o: Number.parseFloat(k[1]),
      h: Number.parseFloat(k[2]),
      l: Number.parseFloat(k[3]),
      c: Number.parseFloat(k[4]),
      v: Number.parseFloat(k[5]),
    };
  });
}

/** Fetch the current mid price (from best bid/ask). Returns 0 if unavailable. */
export async function fetchMidPrice(symbol: string): Promise<number> {
  const url = `${BINANCE_BASE}/api/v3/ticker/bookTicker?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance bookTicker error ${res.status}: ${await res.text()}`);
  const book = (await res.json()) as { bidPrice?: string; askPrice?: string };
  const bid = Number.parseFloat(book.bidPrice ?? "0");
  const ask = Number.parseFloat(book.askPrice ?? "0");
  return bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
}

export interface SymbolFilters {
  stepSize: string; // LOT_SIZE step
  minQty: number;
  tickSize: string; // PRICE_FILTER tick
  minNotional: number;
}

interface BinanceFilter {
  filterType: string;
  stepSize?: string;
  minQty?: string;
  tickSize?: string;
  minNotional?: string;
  notional?: string;
}

/** Fetch the LOT_SIZE / PRICE_FILTER / (MIN_)NOTIONAL filters for a symbol. */
export async function fetchSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const url = `${BINANCE_BASE}/api/v3/exchangeInfo?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance exchangeInfo error ${res.status}: ${await res.text()}`);
  const info = (await res.json()) as { symbols?: { filters?: BinanceFilter[] }[] };
  const filters = info.symbols?.[0]?.filters ?? [];
  const lot = filters.find((f) => f.filterType === "LOT_SIZE");
  const price = filters.find((f) => f.filterType === "PRICE_FILTER");
  const notional = filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  return {
    stepSize: lot?.stepSize ?? "0.00000001",
    minQty: Number.parseFloat(lot?.minQty ?? "0"),
    tickSize: price?.tickSize ?? "0.00000001",
    minNotional: Number.parseFloat(notional?.minNotional ?? notional?.notional ?? "0"),
  };
}
