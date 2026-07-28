import { env } from "../config.ts";

const CMC_BASE = "https://pro-api.coinmarketcap.com";

export type PriceData = {
  symbol: string;
  price: number;
  marketCap: number | null;
  volume24h: number | null;
  percentChange1h: number | null;
  percentChange24h: number | null;
  percentChange7d: number | null;
  percentChange30d: number | null;
  fullyDilutedMarketCap: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  lastUpdated: string;
  fearIndex?: number;
  fearIndexLabel?: string;
  fearIndexUpdatedAt?: string;
};

function round4(val: unknown): number | null {
  const n = typeof val === "number" ? val : typeof val === "string" ? parseFloat(val) : NaN;
  if (!isFinite(n)) return null;
  return parseFloat(n.toFixed(4));
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

async function cmcFetch(path: string): Promise<unknown> {
  const apiKey = env("COINMARKETCAP_API_KEY");
  const url = `${CMC_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-CMC_PRO_API_KEY": apiKey,
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const status = asRecord(body?.["status"]);
      if (typeof status?.["error_message"] === "string") {
        msg = `HTTP ${res.status}: ${status["error_message"]}`;
      } else if (typeof body?.["message"] === "string") {
        msg = `HTTP ${res.status}: ${body["message"]}`;
      }
    } catch {
      // ignore json parse error
    }
    throw new Error(`CoinMarketCap request failed — ${msg}`);
  }
  return res.json();
}

export async function fetchPrice(symbol: string, convert = "USD"): Promise<PriceData> {
  const sym = symbol.toUpperCase();
  const params = new URLSearchParams({ symbol: sym, convert: convert.toUpperCase() });
  const json = await cmcFetch(`/v1/cryptocurrency/quotes/latest?${params.toString()}`);

  const root = asRecord(json);
  const data = asRecord(root?.["data"]);
  const symbolData = asRecord(data?.[sym]);
  const quote = asRecord(asRecord(symbolData?.["quote"])?.[convert.toUpperCase()]);

  if (!symbolData || !quote) {
    throw new Error(`No quote returned for ${sym}/${convert}`);
  }

  const lastUpdated =
    typeof quote["last_updated"] === "string"
      ? quote["last_updated"]
      : typeof symbolData["last_updated"] === "string"
        ? (symbolData["last_updated"] as string)
        : new Date().toISOString();

  return {
    symbol: sym,
    price: round4(quote["price"]) ?? 0,
    marketCap: round4(quote["market_cap"]),
    volume24h: round4(quote["volume_24h"]),
    percentChange1h: round4(quote["percent_change_1h"]),
    percentChange24h: round4(quote["percent_change_24h"]),
    percentChange7d: round4(quote["percent_change_7d"]),
    percentChange30d: round4(quote["percent_change_30d"]),
    fullyDilutedMarketCap: round4(quote["fully_diluted_market_cap"]),
    circulatingSupply: round4(symbolData["circulating_supply"]),
    totalSupply: round4(symbolData["total_supply"]),
    maxSupply: round4(symbolData["max_supply"]),
    lastUpdated,
  };
}

export async function fetchFearIndex(): Promise<{ value: number; label: string; updatedAt: string } | null> {
  try {
    const json = await cmcFetch("/v3/fear-and-greed/latest");
    const root = asRecord(json);
    const data = asRecord(root?.["data"]);
    if (!data) return null;

    const value = typeof data["value"] === "number" ? data["value"] : parseFloat(String(data["value"] ?? ""));
    const label =
      typeof data["value_classification"] === "string"
        ? data["value_classification"]
        : "";
    const updatedAt =
      typeof data["update_time"] === "string"
        ? data["update_time"]
        : new Date().toISOString();

    if (!isFinite(value)) return null;
    return { value, label, updatedAt };
  } catch {
    return null;
  }
}
