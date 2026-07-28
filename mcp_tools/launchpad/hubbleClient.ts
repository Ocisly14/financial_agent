import { env } from "../config.ts";

export type LaunchpadToken = {
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
  totalSupply?: number;
  volume1h?: number;
  buy1h?: number;
  sell1h?: number;
  tx1h?: number;
  totalHolders?: number;
  priceNative?: number;
  priceUsd?: number;
  mktCapUsd?: number;
  createdAt?: string;
  graduationAt?: string;
  bondingCurveProgress?: number;
  phase: "new" | "bonding" | "graduated";
};

const BASE_URL = "https://api.hubble.xyz/launchpad/api/v1";
const PHASES: Array<"new" | "bonding" | "graduated"> = ["new", "bonding", "graduated"];
const CACHE_TTL_MS = 60_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type CacheEntry = {
  expiresAt: number;
  value: LaunchpadToken[];
};

const tokenCache = new Map<string, CacheEntry>();

async function fetchPhase(phase: "new" | "bonding" | "graduated"): Promise<LaunchpadToken[]> {
  const apiKey = env("HUBBLE_API_KEY");
  const response = await fetch(`${BASE_URL}/tokens?phase=${phase}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Hubble API request failed for phase "${phase}" with HTTP ${response.status}.`);
  }

  const json = (await response.json()) as unknown;
  const items = Array.isArray(json) ? json : [];

  return items.map((item: unknown): LaunchpadToken => {
    const t = item as Record<string, unknown>;
    // Build required fields first, then spread optional ones to satisfy exactOptionalPropertyTypes
    const base = {
      tokenAddress: String(t.tokenAddress ?? t.token_address ?? ""),
      symbol: String(t.symbol ?? ""),
      name: String(t.name ?? ""),
      decimals: typeof t.decimals === "number" ? t.decimals : 0,
      phase,
    };
    const opt: Partial<LaunchpadToken> = {};
    const logo = typeof t.logo === "string" ? t.logo : undefined;
    if (logo !== undefined) opt.logo = logo;
    const totalSupply = typeof t.totalSupply === "number" ? t.totalSupply : typeof t.total_supply === "number" ? t.total_supply : undefined;
    if (totalSupply !== undefined) opt.totalSupply = totalSupply;
    const volume1h = typeof t.volume1h === "number" ? t.volume1h : typeof t.volume_1h === "number" ? t.volume_1h : undefined;
    if (volume1h !== undefined) opt.volume1h = volume1h;
    const buy1h = typeof t.buy1h === "number" ? t.buy1h : typeof t.buy_1h === "number" ? t.buy_1h : undefined;
    if (buy1h !== undefined) opt.buy1h = buy1h;
    const sell1h = typeof t.sell1h === "number" ? t.sell1h : typeof t.sell_1h === "number" ? t.sell_1h : undefined;
    if (sell1h !== undefined) opt.sell1h = sell1h;
    const tx1h = typeof t.tx1h === "number" ? t.tx1h : typeof t.tx_1h === "number" ? t.tx_1h : undefined;
    if (tx1h !== undefined) opt.tx1h = tx1h;
    const totalHolders = typeof t.totalHolders === "number" ? t.totalHolders : typeof t.total_holders === "number" ? t.total_holders : undefined;
    if (totalHolders !== undefined) opt.totalHolders = totalHolders;
    const priceNative = typeof t.priceNative === "number" ? t.priceNative : typeof t.price_native === "number" ? t.price_native : undefined;
    if (priceNative !== undefined) opt.priceNative = priceNative;
    const priceUsd = typeof t.priceUsd === "number" ? t.priceUsd : typeof t.price_usd === "number" ? t.price_usd : undefined;
    if (priceUsd !== undefined) opt.priceUsd = priceUsd;
    const mktCapUsd = typeof t.mktCapUsd === "number" ? t.mktCapUsd : typeof t.mkt_cap_usd === "number" ? t.mkt_cap_usd : undefined;
    if (mktCapUsd !== undefined) opt.mktCapUsd = mktCapUsd;
    const createdAt = typeof t.createdAt === "string" ? t.createdAt : typeof t.created_at === "string" ? t.created_at : undefined;
    if (createdAt !== undefined) opt.createdAt = createdAt;
    const graduationAt = typeof t.graduationAt === "string" ? t.graduationAt : typeof t.graduation_at === "string" ? t.graduation_at : undefined;
    if (graduationAt !== undefined) opt.graduationAt = graduationAt;
    const bondingCurveProgress = typeof t.bondingCurveProgress === "number" ? t.bondingCurveProgress : typeof t.bonding_curve_progress === "number" ? t.bonding_curve_progress : undefined;
    if (bondingCurveProgress !== undefined) opt.bondingCurveProgress = bondingCurveProgress;
    return { ...base, ...opt };
  });
}

export async function fetchLaunchpadTokens(filters?: {
  symbol?: string;
  phase?: "new" | "bonding" | "graduated";
  minMktCapUsd?: number;
  limit?: number;
}): Promise<LaunchpadToken[]> {
  const cacheKey = JSON.stringify(filters ?? {});
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const phasesToFetch = filters?.phase ? [filters.phase] : PHASES;

  const results = await Promise.allSettled(phasesToFetch.map((p) => fetchPhase(p)));

  const merged: LaunchpadToken[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      merged.push(...result.value);
    }
  }

  let filtered = merged;

  if (filters?.symbol) {
    const symbolLower = filters.symbol.toLowerCase();
    filtered = filtered.filter(
      (t) => t.symbol.toLowerCase().includes(symbolLower) || t.name.toLowerCase().includes(symbolLower),
    );
  }

  if (filters?.phase) {
    filtered = filtered.filter((t) => t.phase === filters.phase);
  }

  if (filters?.minMktCapUsd !== undefined) {
    const min = filters.minMktCapUsd;
    filtered = filtered.filter((t) => t.mktCapUsd !== undefined && t.mktCapUsd >= min);
  }

  filtered.sort((a, b) => {
    const aVal = a.mktCapUsd ?? 0;
    const bVal = b.mktCapUsd ?? 0;
    return bVal - aVal;
  });

  const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const sliced = filtered.slice(0, limit);

  tokenCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: sliced });

  return sliced;
}

export async function fetchTokenMetrics(tokenAddress: string): Promise<LaunchpadToken | undefined> {
  const tokens = await fetchLaunchpadTokens({ phase: "graduated", limit: MAX_LIMIT });
  return tokens.find((t) => t.tokenAddress.toLowerCase() === tokenAddress.toLowerCase());
}
