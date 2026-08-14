const ALPACA_BASE = "https://data.alpaca.markets/v2";
const DEFAULT_FEED: BarFeed = "iex";
/** Consolidated tape: every exchange, and history well before IEX's own 2020 start. Beta needs both,
 *  so it opts in explicitly rather than changing what the chart and indicator tools already fetch. */
export type BarFeed = "iex" | "sip";

/**
 * Days of the consolidated tape this subscription may not query. Asking for anything more recent is
 * a 403, not an empty page, so the window is clamped rather than retried. Everything SIP is wanted
 * for — long histories for beta — is unaffected by ending a few days early.
 */
const SIP_EMBARGO_DAYS = 4;

function clampToFeedWindow(to: string, feed: BarFeed): string {
  if (feed !== "sip") return to;
  const latest = new Date();
  latest.setUTCDate(latest.getUTCDate() - SIP_EMBARGO_DAYS);
  const iso = latest.toISOString().slice(0, 10);
  return to > iso ? iso : to;
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export type DailyBar = {
  t: string;   // Trading day "2026-07-27" (daily bar) or full ISO timestamp (minute bar)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
};

export type Timeframe = "1Min" | "5Min" | "1Day";

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
  fetchBars: (symbol: string, timeframe: Timeframe, from: string, to: string, feed?: BarFeed) => Promise<DailyBar[]>;
};

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

function num(val: unknown): number | null {
  return typeof val === "number" && isFinite(val) ? val : null;
}

/**
 * Which tape to read. `ALPACA_FEED=sip` opts a paid subscription into the consolidated tape;
 * anything unrecognised falls back to IEX rather than failing a request at runtime.
 */
export function resolveFeed(
  explicit?: BarFeed,
  env: Record<string, string | undefined> = process.env,
): BarFeed {
  if (explicit) return explicit;
  return env["ALPACA_FEED"] === "sip" ? "sip" : DEFAULT_FEED;
}

/** Injection seam so retry backoff is testable without real waiting. */
export type FetchOptions = { sleep?: (ms: number) => Promise<void> };

/**
 * Transient upstream failures are retried; everything else is surfaced immediately.
 *
 * 429 matters most: the free plan allows 200 requests a minute, and without a retry a burst
 * turns into a thrown error that callers log and skip — a strategy silently not being evaluated
 * looks exactly like a strategy whose condition was not met.
 */
const RETRYABLE_STATUS = (status: number): boolean => status === 429 || status >= 500;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function alpacaFetch(path: string, options: FetchOptions = {}): Promise<Record<string, unknown>> {
  const sleep = options.sleep ?? defaultSleep;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${ALPACA_BASE}${path}`, {
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": requiredEnv("ALPACA_API_KEY_ID"),
        "APCA-API-SECRET-KEY": requiredEnv("ALPACA_API_SECRET_KEY"),
      },
    });
    if (res.ok) {
      const json: unknown = await res.json();
      const rec = asRecord(json);
      if (!rec) throw new Error("Alpaca returned a non-object response");
      return rec;
    }
    const body = await res.text();
    lastError = `Alpaca ${res.status}: ${body.slice(0, 200)}`;
    if (!RETRYABLE_STATUS(res.status) || attempt === MAX_ATTEMPTS) throw new Error(lastError);
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  throw new Error(lastError);
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

async function fetchBarsPaged(path: string, dateOnly: boolean, options: FetchOptions = {}): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  let pageToken: string | undefined;
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const body = await alpacaFetch(`${path}${suffix}`, options);
    for (const raw of Array.isArray(body["bars"]) ? body["bars"] : []) {
      const bar = toBar(raw, dateOnly);
      if (bar) bars.push(bar);
    }
    pageToken = typeof body["next_page_token"] === "string" ? body["next_page_token"] : undefined;
  } while (pageToken);
  return bars;
}

/** Bars for any supported timeframe. Always uses adjusted prices. */
export async function fetchBars(
  symbol: string,
  timeframe: Timeframe,
  from: string,
  to: string,
  feed: BarFeed = resolveFeed(),
  options: FetchOptions = {},
): Promise<DailyBar[]> {
  const end = clampToFeedWindow(to, feed);
  if (from > end) return [];
  const qs = `timeframe=${timeframe}&start=${encodeURIComponent(from)}&end=${encodeURIComponent(end)}&adjustment=all&limit=10000&feed=${feed}`;
  return fetchBarsPaged(`/stocks/${encodeURIComponent(symbol)}/bars?${qs}`, timeframe === "1Day", options);
}

/** Daily bars. from/to are "YYYY-MM-DD", inclusive range. Kept for get_stock_price to call. */
export async function fetchDailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]> {
  return fetchBars(symbol, "1Day", from, to);
}

/** Minute bars for a given trading day. day is "YYYY-MM-DD". */
export async function fetchIntradayBars(symbol: string, day: string): Promise<DailyBar[]> {
  return fetchBars(symbol, "1Min", day, day);
}

export async function fetchSnapshot(symbol: string): Promise<Snapshot> {
  const body = await alpacaFetch(`/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${resolveFeed()}`);
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
 * Caches load's result per key for ttlMs milliseconds. nowMs is supplied by the caller, to keep this testable.
 * Nothing is cached when loader throws.
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

/**
 * Live quote cache: 5 second TTL.
 *
 * Equal to the `StockChart` component's 5 second polling interval (see inline-stock-chart spec §5).
 * A cache slower than the polling would make half the polls return the same stale data; faster
 * would purely waste upstream quota.
 */
export const getSnapshotCached = createTtlCache(fetchSnapshot, 5_000);
