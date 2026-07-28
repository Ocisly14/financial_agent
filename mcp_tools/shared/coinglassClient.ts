import { env } from "../config.ts";

const BASE = "https://open-api-v4.coinglass.com/api";

export type OhlcvBar = {
  time: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const toNum = (x: unknown): number => (typeof x === "number" ? x : parseFloat(String(x)));

function toStartTimeParam(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return value;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? String(ms) : value;
}

function toEndTimeParam(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCHours(23, 59, 59, 999);
  return String(date.getTime());
}

export async function fetchOhlcv(
  symbol: string,
  intervalDays = 100,
  exchange = "Binance",
): Promise<OhlcvBar[]> {
  const key = env("COINGLASS_API_KEY");
  const limit = Math.min(intervalDays, 1000);
  const url = `${BASE}/futures/price/history?exchange=${exchange}&symbol=${symbol}USDT&interval=1d&limit=${limit}`;
  const resp = await fetch(url, { headers: { "CG-API-KEY": key } });
  if (!resp.ok) throw new Error(`CoinGlass OHLCV ${resp.status}: ${await resp.text()}`);
  // CoinGlass v4 returns an array of bar objects (string values, time in ms):
  // { code:"0", data:[{ time, open, high, low, close, volume_usd }, ...] }
  const json = (await resp.json()) as {
    code: string;
    msg?: string;
    data?: Array<{
      time: number | string;
      open: number | string;
      high: number | string;
      low: number | string;
      close: number | string;
      volume_usd?: number | string;
      volume?: number | string;
    }>;
  };
  if (json.code !== "0") throw new Error(`CoinGlass OHLCV error ${json.code}: ${json.msg ?? "unknown"}`);
  if (!Array.isArray(json.data)) return [];
  return json.data.map((b) => ({
    time: toNum(b.time),
    open: toNum(b.open),
    high: toNum(b.high),
    low: toNum(b.low),
    close: toNum(b.close),
    volume: toNum(b.volume_usd ?? b.volume ?? 0),
  }));
}

export async function fetchWhalePositions(from?: string, to?: string): Promise<unknown[]> {
  const key = env("COINGLASS_API_KEY");
  const params = new URLSearchParams({ limit: "200" });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const resp = await fetch(`${BASE}/hyperliquid/whale-position?${params}`, {
    headers: { "CG-API-KEY": key },
  });
  if (!resp.ok) throw new Error(`CoinGlass whale-position ${resp.status}`);
  const json = (await resp.json()) as { data?: unknown[] };
  return json.data ?? [];
}

export async function fetchBidAskHistory(
  symbol: string,
  startTime?: string,
  endTime?: string,
  exchange = "Binance",
): Promise<unknown[]> {
  const key = env("COINGLASS_API_KEY");
  const params = new URLSearchParams({ exchange_list: exchange, symbol: `${symbol}USDT`, interval: "h1" });
  const start = toStartTimeParam(startTime);
  const end = toEndTimeParam(endTime);
  if (start) params.set("start_time", start);
  if (end) params.set("end_time", end);
  const resp = await fetch(`${BASE}/futures/orderbook/aggregated-ask-bids-history?${params}`, {
    headers: { "CG-API-KEY": key },
  });
  if (!resp.ok) throw new Error(`CoinGlass bid-ask ${resp.status}`);
  const json = (await resp.json()) as { data?: unknown[] };
  return json.data ?? [];
}

export async function fetchTakerVolume(
  symbol: string,
  startTime?: string,
  endTime?: string,
  exchange = "Binance",
): Promise<unknown[]> {
  const key = env("COINGLASS_API_KEY");
  const params = new URLSearchParams({
    exchange_list: exchange,
    symbol: `${symbol}USDT`,
    interval: "1d",
    limit: "1000",
    unit: "usd",
  });
  const start = toStartTimeParam(startTime);
  const end = toEndTimeParam(endTime);
  if (start) params.set("start_time", start);
  if (end) params.set("end_time", end);
  const resp = await fetch(`${BASE}/futures/aggregated-taker-buy-sell-volume/history?${params}`, {
    headers: { "CG-API-KEY": key },
  });
  if (!resp.ok) throw new Error(`CoinGlass taker-volume ${resp.status}`);
  const json = (await resp.json()) as { data?: unknown[] };
  return json.data ?? [];
}
