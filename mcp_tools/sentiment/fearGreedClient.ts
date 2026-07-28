import { env } from "../config.ts";

const CMC_FNG_URL = "https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical";

export type FearGreedPoint = {
  timestamp: number;
  value: number;
  label: "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed";
};

export type FearGreedAnalysis = {
  current: FearGreedPoint;
  history: FearGreedPoint[];
  trend: {
    direction: "rising" | "falling" | "stable";
    durationDays: number;
    volatility: number;
  };
  historicalContext: {
    avg: number;
    std: number;
    extremeFearCount: number;
    extremeGreedCount: number;
    percentileRank: number;
  };
};

// --- Helpers ---

function classifyValue(
  value: number,
): "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed" {
  if (value < 25)  return "Extreme Fear";
  if (value < 45)  return "Fear";
  if (value <= 55) return "Neutral";
  if (value <= 75) return "Greed";
  return "Extreme Greed";
}

function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const sumX  = xs.reduce((s, v) => s + v, 0);
  const sumY  = values.reduce((s, v) => s + v, 0);
  const sumXY = xs.reduce((s, v, i) => s + v * values[i]!, 0);
  const sumXX = xs.reduce((s, v) => s + v * v, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function populationStd(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentileRank(values: number[], target: number): number {
  if (values.length === 0) return 50;
  const below = values.filter((v) => v < target).length;
  return Math.round((below / values.length) * 100);
}

type CmcFngItem = {
  // `historical` returns `timestamp` (unix seconds, as a string); `latest`
  // returns `update_time` (ISO 8601). Accept either so one parser serves both.
  timestamp?: unknown;
  update_time?: unknown;
  value?: unknown;
  value_classification?: unknown;
};

type CmcFngResponse = {
  data?: unknown;
};

/** Normalize a raw timestamp (unix s/ms number, unix s/ms string, or ISO 8601
 * string) to unix SECONDS — the unit every downstream consumer assumes.
 * Returns null if it can't be interpreted. */
function toUnixSeconds(tsRaw: unknown): number | null {
  if (typeof tsRaw === "number" && Number.isFinite(tsRaw)) {
    return tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : tsRaw;
  }
  if (typeof tsRaw === "string") {
    // Numeric string → unix epoch (seconds or milliseconds). Check this BEFORE
    // Date.parse, which returns NaN for bare epoch strings like "1781049600".
    const asNum = Number(tsRaw);
    if (Number.isFinite(asNum) && asNum > 1e9) {
      return asNum > 1e12 ? Math.floor(asNum / 1000) : asNum;
    }
    // Otherwise treat as an ISO 8601 date string (the `latest` endpoint).
    const parsed = Date.parse(tsRaw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function parsePoint(item: CmcFngItem): FearGreedPoint | null {
  const valRaw = item.value;

  const timestamp = toUnixSeconds(item.update_time ?? item.timestamp);
  if (timestamp === null) return null;

  const value = typeof valRaw === "number" ? valRaw
    : typeof valRaw === "string" ? Number(valRaw)
    : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;

  // Use classifyValue to normalize to our union type (ignores raw API label for strict typing)
  const label = classifyValue(value);

  return { timestamp, value, label };
}

function filterByDateRange(
  points: FearGreedPoint[],
  from?: string,
  to?: string,
): FearGreedPoint[] {
  if (!from && !to) return points;
  const fromMs = from ? new Date(from).getTime() / 1000 : 0;
  const toMs   = to   ? new Date(to).getTime()   / 1000 + 86_400 : Infinity;
  return points.filter((p) => p.timestamp >= fromMs && p.timestamp <= toMs);
}

// --- Main export ---

export async function fetchFearGreedAnalysis(
  from?: string,
  to?: string,
): Promise<FearGreedAnalysis> {
  const apiKey = env("COINMARKETCAP_API_KEY");

  const url = new URL(CMC_FNG_URL);
  url.searchParams.set("start", "1");
  url.searchParams.set("limit", "500");

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-CMC_PRO_API_KEY": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(
      `CoinMarketCap Fear & Greed API returned HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as CmcFngResponse;
  const rawData = Array.isArray(payload.data) ? payload.data : [];

  const allPoints: FearGreedPoint[] = rawData
    .map((item) => parsePoint(item as CmcFngItem))
    .filter((p): p is FearGreedPoint => p !== null)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (allPoints.length === 0) {
    throw new Error("CoinMarketCap Fear & Greed API returned no valid data points");
  }

  const filteredPoints = filterByDateRange(allPoints, from, to);
  const workingPoints = filteredPoints.length > 0 ? filteredPoints : allPoints;

  const current = workingPoints[workingPoints.length - 1]!;

  // Trend: last 7 days
  const sevenDaysAgoTs = current.timestamp - 7 * 86_400;
  const last7 = workingPoints.filter((p) => p.timestamp >= sevenDaysAgoTs);
  const last7Values = last7.map((p) => p.value);
  const slope = linearSlope(last7Values);
  const trendDirection: "rising" | "falling" | "stable" =
    slope > 0.5 ? "rising" : slope < -0.5 ? "falling" : "stable";
  const trendVolatility = populationStd(last7Values);

  // Trend duration: count consecutive days in current direction from the end
  let durationDays = 1;
  for (let i = workingPoints.length - 2; i >= 0; i--) {
    const prev = workingPoints[i]!;
    const next = workingPoints[i + 1]!;
    const delta = next.value - prev.value;
    if (trendDirection === "rising"  && delta >= 0) { durationDays++; continue; }
    if (trendDirection === "falling" && delta <= 0) { durationDays++; continue; }
    if (trendDirection === "stable") { durationDays++; continue; }
    break;
  }

  // Historical context
  const allValues = workingPoints.map((p) => p.value);
  const avg = allValues.reduce((s, v) => s + v, 0) / allValues.length;
  const std = populationStd(allValues);
  const extremeFearCount  = allValues.filter((v) => v < 25).length;
  const extremeGreedCount = allValues.filter((v) => v > 75).length;
  const pctRank = percentileRank(allValues, current.value);

  return {
    current,
    history: workingPoints,
    trend: {
      direction: trendDirection,
      durationDays,
      volatility: trendVolatility,
    },
    historicalContext: {
      avg,
      std,
      extremeFearCount,
      extremeGreedCount,
      percentileRank: pctRank,
    },
  };
}
