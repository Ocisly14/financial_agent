import { env } from "../config.ts";
import { s3GetText, s3GetNewestKey } from "../shared/s3Client.ts";
import { daysAgo, toIsoDate } from "../shared/dateUtils.ts";

function getBucket(): string {
  return env("SENTISCORE_S3_BUCKET", "sentiscoredata-new");
}

type SymbolMode = "per-symbol" | "ALL";

type SourceConfig = {
  name: string;
  prefix: string;
  symbolMode: SymbolMode;
  weight: number;
  assetAgnostic: boolean;
  category: "Crypto News" | "KOL" | "Macro" | "Social Media";
  description: string;
};

const SOURCES: SourceConfig[] = [
  { name: "research",      prefix: "research",      symbolMode: "per-symbol", weight: 1.5, assetAgnostic: false, category: "KOL",          description: "Long-form analyst research reports (highest weight; institutional/professional voice)" },
  { name: "crypto_news",   prefix: "crypto_news",   symbolMode: "per-symbol", weight: 1.4, assetAgnostic: false, category: "Crypto News",  description: "Crypto-focused news outlets (high weight; editorial reporting)" },
  { name: "x_influencers", prefix: "X_influencers", symbolMode: "per-symbol", weight: 1.2, assetAgnostic: false, category: "KOL",          description: "Verified influencer accounts on X / Twitter (mid-high weight; trader-facing commentary)" },
  { name: "crypto_policy", prefix: "crypto_policy", symbolMode: "ALL",        weight: 1.1, assetAgnostic: true,  category: "Macro",        description: "Crypto regulation and policy news (mid weight; macro / asset-agnostic)" },
  { name: "macro_news",    prefix: "macro_news",    symbolMode: "ALL",        weight: 1.0, assetAgnostic: true,  category: "Macro",        description: "Broad macro and financial news (mid weight; macro / asset-agnostic)" },
  { name: "reddit",        prefix: "reddit",        symbolMode: "per-symbol", weight: 0.9, assetAgnostic: false, category: "Social Media", description: "Reddit crypto subreddit posts (mid-low weight; retail community)" },
  { name: "youtube",       prefix: "youtube",       symbolMode: "ALL",        weight: 0.8, assetAgnostic: true,  category: "KOL",          description: "Crypto YouTube creator transcripts (mid-low weight; macro / asset-agnostic)" },
  { name: "podcast",       prefix: "podcast",       symbolMode: "per-symbol", weight: 0.7, assetAgnostic: false, category: "KOL",          description: "Crypto podcast transcripts (low weight; long-form opinion)" },
  { name: "x",             prefix: "X",             symbolMode: "per-symbol", weight: 0.6, assetAgnostic: false, category: "Social Media", description: "General X / Twitter posts mentioning the asset (lowest weight; retail noise floor)" },
];

const SOURCE_MAP = new Map(SOURCES.map((s) => [s.name, s]));

export type SourceData = {
  source: string;
  rows: { time: string; value: number; total: number }[];
};

export type HorizonStat = {
  value: number;
  observationCount: number;
  trend: number;
  std: number;
};

export type DivergenceStat = {
  range: number;
  spread: number;
  topPositive: Array<{ source: string; value: number }>;
  topNegative: Array<{ source: string; value: number }>;
};

export type MacroVsAssetStat = {
  assetValue: number;
  macroValue: number;
  delta: number;
};

export type PerSourceHorizon = {
  h24: HorizonStat;
  h7d: HorizonStat;
  h30d: HorizonStat;
};

export type SentiScoreResult = {
  symbol: string;
  fromDate: string;
  toDate: string;
  horizons: {
    h24: HorizonStat;
    h7d: HorizonStat;
    h30d: HorizonStat;
  };
  perSource: Record<string, PerSourceHorizon>;
  features: {
    baselineDeviationSigma: number;
    divergence: {
      h24: DivergenceStat;
      h7d: DivergenceStat;
      h30d: DivergenceStat;
    };
    macroVsAsset: {
      h24: MacroVsAssetStat;
      h7d: MacroVsAssetStat;
      h30d: MacroVsAssetStat;
    };
    crossSourceSpread24h: number;
    macroVsAssetDelta24h: number;
    excludedSources: string[];
  };
  timeSeries: { time: string; value: number }[];
};

// --- CSV parsing ---

type CsvRow = Record<string, string>;

function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = (cols[j] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseNum(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

type ParsedRow = { time: string; value: number; total: number };

function parseCsvRows(text: string): ParsedRow[] {
  const rawRows = parseCsv(text);
  const results: ParsedRow[] = [];

  for (const row of rawRows) {
    const time =
      row["time"] ?? row["date"] ?? row["datetime"] ?? row["timestamp"] ?? "";

    const scalarKey = ["score", "value", "sentiscore"].find((k) => k in row);
    if (scalarKey) {
      const rawVal = parseNum(row[scalarKey]);
      if (rawVal === null) continue;
      const value = Math.abs(rawVal) > 1 ? clamp(rawVal / 100, -1, 1) : clamp(rawVal, -1, 1);
      const total = parseNum(row["total"]) ?? 1;
      results.push({ time, value, total });
      continue;
    }

    // 7-category format
    const sn  = parseNum(row["strongly_negative"]);
    const mn  = parseNum(row["moderately_negative"]);
    const ln  = parseNum(row["mildly_negative"]);
    const neu = parseNum(row["neutral"]);
    const lp  = parseNum(row["mildly_positive"]);
    const mp  = parseNum(row["moderately_positive"]);
    const sp  = parseNum(row["strongly_positive"]);
    const tot = parseNum(row["total"]);

    if (
      sn === null && mn === null && ln === null &&
      neu === null && lp === null && mp === null && sp === null
    ) continue;

    const snV  = sn  ?? 0;
    const mnV  = mn  ?? 0;
    const lnV  = ln  ?? 0;
    const neuV = neu ?? 0;
    const lpV  = lp  ?? 0;
    const mpV  = mp  ?? 0;
    const spV  = sp  ?? 0;
    const total = tot ?? (snV + mnV + lnV + neuV + lpV + mpV + spV);

    if (total === 0) continue;

    const weighted =
      (-1 * snV + -0.667 * mnV + -0.333 * lnV + 0 * neuV + 0.333 * lpV + 0.667 * mpV + 1 * spV) / total;
    const value = clamp(weighted, -1, 1);
    results.push({ time, value, total });
  }

  return results;
}

// --- S3 fetching ---

async function fetchSourceRows(
  source: SourceConfig,
  symbol: string,
  from: string,
  to: string,
): Promise<ParsedRow[]> {
  const bucket = getBucket();
  const folder = source.symbolMode === "ALL" ? "ALL" : symbol.toUpperCase();

  const allRows: ParsedRow[] = [];
  const startMs = new Date(from).getTime();
  const endMs   = new Date(to).getTime();

  const dateCandidates: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    dateCandidates.push(toIsoDate(new Date(ms)));
  }

  await Promise.all(
    dateCandidates.map(async (date) => {
      const prefix = `${source.prefix}/${date}/hourly_score/${folder}/`;
      const key = await s3GetNewestKey(bucket, prefix);
      if (!key) return;
      try {
        const text = await s3GetText(bucket, key);
        const rows = parseCsvRows(text).map((r) => ({
          ...r,
          time: r.time || date,
        }));
        allRows.push(...rows);
      } catch {
        // silently skip missing files
      }
    }),
  );

  return allRows;
}

// --- Stats helpers ---

function weightedAvg(rows: ParsedRow[]): number {
  if (rows.length === 0) return 0;
  let sumVT = 0;
  let sumT  = 0;
  for (const r of rows) {
    const w = r.total > 0 ? r.total : 1;
    sumVT += r.value * w;
    sumT  += w;
  }
  return sumT === 0 ? 0 : sumVT / sumT;
}

function linearSlope(rows: ParsedRow[]): number {
  const n = rows.length;
  if (n < 2) return 0;
  const sorted = [...rows].sort((a, b) => a.time.localeCompare(b.time));
  const t0 = new Date(sorted[0]!.time).getTime();
  const xs = sorted.map((r) => (new Date(r.time).getTime() - t0) / 86_400_000);
  const ys = sorted.map((r) => r.value);
  const sumX  = xs.reduce((s, v) => s + v, 0);
  const sumY  = ys.reduce((s, v) => s + v, 0);
  const sumXY = xs.reduce((s, v, i) => s + v * ys[i]!, 0);
  const sumXX = xs.reduce((s, v) => s + v * v, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function populationStd(rows: ParsedRow[]): number {
  if (rows.length === 0) return 0;
  const vals = rows.map((r) => r.value);
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - avg) ** 2, 0) / vals.length;
  return Math.sqrt(variance);
}

function horizonStat(rows: ParsedRow[], toDate: string, days: number): HorizonStat {
  const cutoff = toIsoDate(daysAgo(days, new Date(toDate)));
  const filtered = rows.filter((r) => r.time >= cutoff && r.time <= toDate);
  return {
    value: weightedAvg(filtered),
    observationCount: filtered.length,
    trend: linearSlope(filtered),
    std: populationStd(filtered),
  };
}

// --- Source-weight-aware aggregate horizon computation ---

function sourceWeightedHorizonStat(
  perSourceStats: Record<string, HorizonStat>,
  horizon: "h24" | "h7d" | "h30d",
): HorizonStat {
  let weightSum = 0;
  let weightedValueSum = 0;
  let totalObs = 0;

  for (const [name, stats] of Object.entries(perSourceStats)) {
    const cfg = SOURCE_MAP.get(name);
    const w = cfg?.weight ?? 1.0;
    const stat = horizon === "h24" ? stats : stats;
    // perSourceStats values are already per-horizon, look them up directly
    if (stat.observationCount === 0) continue;
    weightedValueSum += stat.value * w;
    weightSum += w;
    totalObs += stat.observationCount;
  }

  return {
    value: weightSum > 0 ? weightedValueSum / weightSum : 0,
    observationCount: totalObs,
    trend: 0, // aggregate trend not meaningful here
    std: 0,
  };
}

function buildAggregateHorizon(
  perSource24: Record<string, HorizonStat>,
  perSource7d: Record<string, HorizonStat>,
  perSource30d: Record<string, HorizonStat>,
): { h24: HorizonStat; h7d: HorizonStat; h30d: HorizonStat } {
  return {
    h24: sourceWeightedHorizonStat(perSource24, "h24"),
    h7d: sourceWeightedHorizonStat(perSource7d, "h7d"),
    h30d: sourceWeightedHorizonStat(perSource30d, "h30d"),
  };
}

// --- Feature computation (aligned with 2.0 extractFeatures) ---

function computeDivergence(
  perSourceStats: Record<string, HorizonStat>,
): DivergenceStat {
  const valid = Object.entries(perSourceStats)
    .filter(([, s]) => s.observationCount > 0)
    .map(([name, s]) => ({ source: name, value: s.value }));

  if (valid.length === 0) return { range: 0, spread: 0, topPositive: [], topNegative: [] };

  const values = valid.map((v) => v.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const spread = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  const range = max - min;

  const sortedDesc = [...valid].sort((a, b) => b.value - a.value);
  const topPositive = sortedDesc.slice(0, 2).map((p) => ({ source: p.source, value: p.value }));
  const topNegative = sortedDesc.slice(-2).reverse().map((p) => ({ source: p.source, value: p.value }));

  return { range, spread, topPositive, topNegative };
}

function computeMacroVsAsset(
  perSourceStats: Record<string, HorizonStat>,
): MacroVsAssetStat {
  let assetWeightSum = 0;
  let assetWeightedValue = 0;
  let macroWeightSum = 0;
  let macroWeightedValue = 0;

  for (const [name, stat] of Object.entries(perSourceStats)) {
    if (stat.observationCount === 0) continue;
    const cfg = SOURCE_MAP.get(name);
    const w = cfg?.weight ?? 1.0;
    if (cfg?.assetAgnostic) {
      macroWeightedValue += stat.value * w;
      macroWeightSum += w;
    } else {
      assetWeightedValue += stat.value * w;
      assetWeightSum += w;
    }
  }

  const assetValue = assetWeightSum > 0 ? assetWeightedValue / assetWeightSum : 0;
  const macroValue = macroWeightSum > 0 ? macroWeightedValue / macroWeightSum : 0;
  return { assetValue, macroValue, delta: assetValue - macroValue };
}

// --- Time series aggregation (source-weight-aware) ---

function buildTimeSeries(
  allSourceData: SourceData[],
): { time: string; value: number }[] {
  const byTime = new Map<string, { weightedValueSum: number; weightSum: number }>();
  for (const sd of allSourceData) {
    const cfg = SOURCE_MAP.get(sd.source);
    const sourceWeight = cfg?.weight ?? 1.0;
    for (const r of sd.rows) {
      const articleWeight = r.total > 0 ? r.total : 1;
      const combined = sourceWeight * articleWeight;
      const entry = byTime.get(r.time) ?? { weightedValueSum: 0, weightSum: 0 };
      entry.weightedValueSum += r.value * combined;
      entry.weightSum += combined;
      byTime.set(r.time, entry);
    }
  }
  return [...byTime.entries()]
    .map(([time, { weightedValueSum, weightSum }]) => ({
      time,
      value: weightSum === 0 ? 0 : weightedValueSum / weightSum,
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

// --- Main export ---

export async function fetchSentiScore(
  symbol: string,
  from: string,
  to: string,
): Promise<SentiScoreResult> {
  const excludedSources: string[] = [];
  const sourceResults = await Promise.allSettled(
    SOURCES.map(async (src) => {
      const rows = await fetchSourceRows(src, symbol, from, to);
      return { source: src.name, rows } as SourceData;
    }),
  );

  const allSourceData: SourceData[] = [];
  for (let i = 0; i < sourceResults.length; i++) {
    const result = sourceResults[i]!;
    if (result.status === "fulfilled") {
      allSourceData.push(result.value);
    } else {
      excludedSources.push(SOURCES[i]!.name);
    }
  }

  // Per-source stats for all 3 horizons
  const perSource24: Record<string, HorizonStat> = {};
  const perSource7d: Record<string, HorizonStat> = {};
  const perSource30d: Record<string, HorizonStat> = {};
  const perSource: Record<string, PerSourceHorizon> = {};

  for (const sd of allSourceData) {
    const h24  = horizonStat(sd.rows, to, 1);
    const h7d  = horizonStat(sd.rows, to, 7);
    const h30d = horizonStat(sd.rows, to, 30);
    perSource24[sd.source]  = h24;
    perSource7d[sd.source]  = h7d;
    perSource30d[sd.source] = h30d;
    perSource[sd.source] = { h24, h7d, h30d };
  }

  // Source-weight-aware aggregate horizons (aligned with 2.0's fuseHourly approach)
  const horizons = buildAggregateHorizon(perSource24, perSource7d, perSource30d);

  // Add trend/std from raw aggregate rows (using timeSeries-based approximation)
  const timeSeries = buildTimeSeries(allSourceData);
  const tsRows: ParsedRow[] = timeSeries.map((p) => ({ time: p.time, value: p.value, total: 1 }));
  const agg24  = horizonStat(tsRows, to, 1);
  const agg7d  = horizonStat(tsRows, to, 7);
  const agg30d = horizonStat(tsRows, to, 30);
  // Keep source-weight-averaged value but use fused series for trend/std
  horizons.h24  = { ...horizons.h24,  trend: agg24.trend,  std: agg24.std  };
  horizons.h7d  = { ...horizons.h7d,  trend: agg7d.trend,  std: agg7d.std  };
  horizons.h30d = { ...horizons.h30d, trend: agg30d.trend, std: agg30d.std };

  // Features (aligned with 2.0's extractFeatures)
  const baselineDeviationSigma =
    horizons.h30d.std > 1e-6
      ? (horizons.h24.value - horizons.h30d.value) / horizons.h30d.std
      : 0;

  const divergence = {
    h24:  computeDivergence(perSource24),
    h7d:  computeDivergence(perSource7d),
    h30d: computeDivergence(perSource30d),
  };

  const macroVsAsset = {
    h24:  computeMacroVsAsset(perSource24),
    h7d:  computeMacroVsAsset(perSource7d),
    h30d: computeMacroVsAsset(perSource30d),
  };

  // Legacy flat features (kept for backward compatibility in prompts)
  const crossSourceSpread24h = divergence.h24.range;
  const macroVsAssetDelta24h = macroVsAsset.h24.assetValue - macroVsAsset.h24.macroValue;

  return {
    symbol: symbol.toUpperCase(),
    fromDate: from,
    toDate: to,
    horizons,
    perSource,
    features: {
      baselineDeviationSigma,
      divergence,
      macroVsAsset,
      crossSourceSpread24h,
      macroVsAssetDelta24h,
      excludedSources,
    },
    timeSeries,
  };
}

export { SOURCES };
