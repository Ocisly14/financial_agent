import { env } from "../config.ts";

const ALPACA_BASE = "https://data.alpaca.markets/v2";
const FEED = "iex";

export type DailyBar = {
  t: string;   // 交易日 "2026-07-27"（日线）或完整 ISO 时刻（分钟线）
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
};

export type Snapshot = {
  symbol: string;
  price: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  prevClose: number | null;
  volume: number | null;
  quoteTimestamp: string;
};

export type BarFetcher = {
  fetchDailyBars: (symbol: string, from: string, to: string) => Promise<DailyBar[]>;
};

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

function num(val: unknown): number | null {
  return typeof val === "number" && isFinite(val) ? val : null;
}

async function alpacaFetch(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${ALPACA_BASE}${path}`, {
    headers: {
      Accept: "application/json",
      "APCA-API-KEY-ID": env("ALPACA_API_KEY_ID"),
      "APCA-API-SECRET-KEY": env("ALPACA_API_SECRET_KEY"),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${res.status}: ${body.slice(0, 200)}`);
  }
  const json: unknown = await res.json();
  const rec = asRecord(json);
  if (!rec) throw new Error("Alpaca returned a non-object response");
  return rec;
}

function toBar(raw: unknown, dateOnly: boolean): DailyBar | undefined {
  const r = asRecord(raw);
  if (!r) return undefined;
  const t = typeof r["t"] === "string" ? r["t"] : undefined;
  const c = num(r["c"]);
  if (!t || c === null) return undefined;
  return {
    t: dateOnly ? t.slice(0, 10) : t,
    o: num(r["o"]) ?? c,
    h: num(r["h"]) ?? c,
    l: num(r["l"]) ?? c,
    c,
    v: num(r["v"]) ?? 0,
    vw: num(r["vw"]) ?? c,
  };
}

async function fetchBarsPaged(path: string, dateOnly: boolean): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  let pageToken: string | undefined;
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const body = await alpacaFetch(`${path}${suffix}`);
    for (const raw of Array.isArray(body["bars"]) ? body["bars"] : []) {
      const bar = toBar(raw, dateOnly);
      if (bar) bars.push(bar);
    }
    pageToken = typeof body["next_page_token"] === "string" ? body["next_page_token"] : undefined;
  } while (pageToken);
  return bars;
}

/** 日 K。from/to 为 "YYYY-MM-DD"，闭区间。一律取复权后价。 */
export async function fetchDailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]> {
  const qs = `timeframe=1Day&start=${from}&end=${to}&adjustment=all&limit=10000&feed=${FEED}`;
  return fetchBarsPaged(`/stocks/${encodeURIComponent(symbol)}/bars?${qs}`, true);
}

/** 指定交易日的分钟线。day 为 "YYYY-MM-DD"。 */
export async function fetchIntradayBars(symbol: string, day: string): Promise<DailyBar[]> {
  const qs = `timeframe=1Min&start=${day}&end=${day}&limit=1000&feed=${FEED}`;
  return fetchBarsPaged(`/stocks/${encodeURIComponent(symbol)}/bars?${qs}`, false);
}

export async function fetchSnapshot(symbol: string): Promise<Snapshot> {
  const body = await alpacaFetch(`/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${FEED}`);
  const trade = asRecord(body["latestTrade"]);
  const quote = asRecord(body["latestQuote"]);
  const daily = asRecord(body["dailyBar"]);
  const prev = asRecord(body["prevDailyBar"]);
  if (!trade && !quote && !daily) {
    throw new Error(`No snapshot data for ${symbol}`);
  }
  return {
    symbol,
    price: num(trade?.["p"]) ?? num(daily?.["c"]),
    bidPrice: num(quote?.["bp"]),
    askPrice: num(quote?.["ap"]),
    dayOpen: num(daily?.["o"]),
    dayHigh: num(daily?.["h"]),
    dayLow: num(daily?.["l"]),
    prevClose: num(prev?.["c"]),
    volume: num(daily?.["v"]),
    quoteTimestamp:
      (typeof trade?.["t"] === "string" ? trade["t"] : undefined) ??
      (typeof quote?.["t"] === "string" ? quote["t"] : undefined) ??
      new Date().toISOString(),
  };
}

/**
 * 按 key 缓存 load 的结果 ttlMs 毫秒。nowMs 由调用方传入，便于测试。
 * loader 抛错时不写缓存。
 */
export function createTtlCache<T>(
  load: (key: string) => Promise<T>,
  ttlMs: number,
): (key: string, nowMs: number) => Promise<T> {
  const cache = new Map<string, { value: T; expiresAt: number }>();
  return async (key: string, nowMs: number): Promise<T> => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > nowMs) return hit.value;
    const value = await load(key);
    cache.set(key, { value, expiresAt: nowMs + ttlMs });
    return value;
  };
}

/** 实时报价缓存：10 秒 TTL。 */
export const getSnapshotCached = createTtlCache(fetchSnapshot, 10_000);
