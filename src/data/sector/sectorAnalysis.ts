import type { DailyBar } from "../stock/index.ts";

export const SECTOR_UNIVERSE = [
  { symbol: "XLC", sector: "Communication Services" },
  { symbol: "XLY", sector: "Consumer Discretionary" },
  { symbol: "XLP", sector: "Consumer Staples" },
  { symbol: "XLE", sector: "Energy" },
  { symbol: "XLF", sector: "Financials" },
  { symbol: "XLV", sector: "Health Care" },
  { symbol: "XLI", sector: "Industrials" },
  { symbol: "XLB", sector: "Materials" },
  { symbol: "XLRE", sector: "Real Estate" },
  { symbol: "XLK", sector: "Technology" },
  { symbol: "XLU", sector: "Utilities" },
] as const;

export type SectorSymbol = (typeof SECTOR_UNIVERSE)[number]["symbol"];
export type AbsoluteTrend = "bullish" | "mixed" | "bearish";
export type RelativePhase = "leading" | "weakening" | "improving" | "lagging";

export type HorizonValues = {
  d20: number | null;
  d60: number | null;
  d120: number | null;
  d252: number | null;
};

export type SectorAnalysisRow = {
  rank: number | null;
  symbol: string;
  sector: string;
  strength_score: number | null;
  relative_phase: RelativePhase;
  absolute_trend: AbsoluteTrend;
  as_of: string;
  close: number;
  returns_pct: HorizonValues;
  relative_returns_pct: HorizonValues;
  trend: {
    sma50: number;
    sma200: number;
    distance_from_sma50_pct: number;
    distance_from_sma200_pct: number;
    relative_slope_annualized_pct: number;
    relative_r_squared: number;
    relative_acceleration_pct_points: number;
  };
  risk: {
    volatility_60d_annualized_pct: number;
    max_drawdown_120d_pct: number;
  };
  coverage: { from: string; to: string; bars: number };
};

export type SectorAnalysisInput = {
  benchmarkBars: DailyBar[];
  sectors: Array<{ symbol: string; sector: string; bars: DailyBar[] }>;
};

type RawRow = SectorAnalysisRow & {
  factors: {
    relativeMomentum: number;
    absoluteMomentum: number;
    trendQuality: number;
    acceleration: number;
    volatility: number;
    maxDrawdown: number;
  };
};

const HORIZON_WEIGHTS = [0.25, 0.35, 0.25, 0.15] as const;
const TRADING_DAYS_PER_YEAR = 252;

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function returnPct(values: number[], periods: number): number | null {
  if (values.length <= periods) return null;
  const current = values.at(-1)!;
  const prior = values[values.length - 1 - periods]!;
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior <= 0) return null;
  const value = (current / prior - 1) * 100;
  return Number.isFinite(value) ? value : null;
}

function horizons(values: number[]): HorizonValues {
  return {
    d20: returnPct(values, 20),
    d60: returnPct(values, 60),
    d120: returnPct(values, 120),
    d252: returnPct(values, 252),
  };
}

function weightedHorizon(values: HorizonValues): number {
  const fields: Array<keyof HorizonValues> = ["d20", "d60", "d120", "d252"];
  let sum = 0;
  let weight = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const value = values[fields[index]!];
    if (value === null) continue;
    sum += value * HORIZON_WEIGHTS[index]!;
    weight += HORIZON_WEIGHTS[index]!;
  }
  return weight > 0 ? sum / weight : 0;
}

function averageTail(values: number[], count: number): number {
  const tail = values.slice(-count);
  if (tail.length === 0) return 0;
  return tail.reduce((sum, value) => sum + value, 0) / tail.length;
}

function linearTrend(values: number[], count: number): { annualizedSlopePct: number; rSquared: number } {
  const ys = values.slice(-count).filter((value) => Number.isFinite(value) && value > 0).map(Math.log);
  const n = ys.length;
  if (n < 2) return { annualizedSlopePct: 0, rSquared: 0 };

  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  for (let index = 0; index < n; index += 1) {
    covariance += (index - meanX) * (ys[index]! - meanY);
    varianceX += (index - meanX) ** 2;
  }
  if (varianceX === 0) return { annualizedSlopePct: 0, rSquared: 0 };
  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;
  let residual = 0;
  let total = 0;
  for (let index = 0; index < n; index += 1) {
    const fitted = intercept + slope * index;
    residual += (ys[index]! - fitted) ** 2;
    total += (ys[index]! - meanY) ** 2;
  }
  const rSquared = total <= Number.EPSILON ? 0 : Math.max(0, Math.min(1, 1 - residual / total));
  const annualizedSlopePct = Math.expm1(slope * TRADING_DAYS_PER_YEAR) * 100;
  return {
    annualizedSlopePct: Number.isFinite(annualizedSlopePct) ? annualizedSlopePct : 0,
    rSquared: Number.isFinite(rSquared) ? rSquared : 0,
  };
}

function relativeAcceleration(values: number[], periods = 20): number {
  if (values.length <= periods * 2) return 0;
  const last = values.length - 1;
  const recentStart = values[last - periods]!;
  const previousStart = values[last - periods * 2]!;
  const boundary = values[last - periods]!;
  if (recentStart <= 0 || previousStart <= 0 || boundary <= 0) return 0;
  const recent = values[last]! / recentStart - 1;
  const previous = boundary / previousStart - 1;
  const acceleration = (recent - previous) * 100;
  return Number.isFinite(acceleration) ? acceleration : 0;
}

function annualizedVolatility(values: number[], periods: number): number {
  const prices = values.slice(-(periods + 1));
  const returns: number[] = [];
  for (let index = 1; index < prices.length; index += 1) {
    const prior = prices[index - 1]!;
    if (prior <= 0) continue;
    const value = prices[index]! / prior - 1;
    if (Number.isFinite(value)) returns.push(value);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(Math.max(0, variance)) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

function maxDrawdown(values: number[], periods: number): number {
  const prices = values.slice(-(periods + 1));
  let peak = prices[0] ?? 0;
  let worst = 0;
  for (const price of prices) {
    if (price > peak) peak = price;
    if (peak <= 0) continue;
    worst = Math.max(worst, (peak - price) / peak);
  }
  return worst * 100;
}

function phase(relative60: number | null, acceleration: number): RelativePhase {
  const relativePositive = (relative60 ?? 0) > 0;
  const accelerating = acceleration >= -1e-10;
  if (relativePositive && accelerating) return "leading";
  if (relativePositive) return "weakening";
  if (accelerating && acceleration > 1e-10) return "improving";
  return "lagging";
}

function absoluteTrend(close: number, sma50: number, sma200: number, return60: number | null): AbsoluteTrend {
  if (close > sma50 && sma50 > sma200 && (return60 ?? 0) > 0) return "bullish";
  if (close < sma50 && sma50 < sma200 && (return60 ?? 0) < 0) return "bearish";
  return "mixed";
}

/** Percentile ranks in [0, 100]. Equal values receive the average rank. */
function percentileRanks(values: number[]): number[] {
  if (values.length === 1) return [50];
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length).fill(50);
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && Math.abs(sorted[end + 1]!.value - sorted[start]!.value) <= 1e-12) end += 1;
    const averagePosition = (start + end) / 2;
    const percentile = averagePosition / (sorted.length - 1) * 100;
    for (let index = start; index <= end; index += 1) result[sorted[index]!.index] = percentile;
    start = end + 1;
  }
  return result;
}

function rawRow(
  benchmarkByDate: Map<string, number>,
  input: SectorAnalysisInput["sectors"][number],
): RawRow | undefined {
  const aligned = input.bars
    .filter((bar) => Number.isFinite(bar.c) && bar.c > 0 && benchmarkByDate.has(bar.t))
    .map((bar) => ({ bar, benchmark: benchmarkByDate.get(bar.t)! }))
    .filter(({ benchmark }) => Number.isFinite(benchmark) && benchmark > 0);
  if (aligned.length < 2) return undefined;

  const closes = aligned.map(({ bar }) => bar.c);
  const relative = aligned.map(({ bar, benchmark }) => bar.c / benchmark);
  const absoluteReturns = horizons(closes);
  const relativeReturns = horizons(relative);
  const close = closes.at(-1)!;
  const sma50 = averageTail(closes, 50);
  const sma200 = averageTail(closes, 200);
  const regression = linearTrend(relative, 60);
  const acceleration = relativeAcceleration(relative);
  const volatility = annualizedVolatility(closes, 60);
  const drawdown = maxDrawdown(closes, 120);

  return {
    rank: null,
    symbol: input.symbol,
    sector: input.sector,
    strength_score: null,
    relative_phase: phase(relativeReturns.d60, acceleration),
    absolute_trend: absoluteTrend(close, sma50, sma200, absoluteReturns.d60),
    as_of: aligned.at(-1)!.bar.t,
    close,
    returns_pct: absoluteReturns,
    relative_returns_pct: relativeReturns,
    trend: {
      sma50,
      sma200,
      distance_from_sma50_pct: sma50 > 0 ? (close / sma50 - 1) * 100 : 0,
      distance_from_sma200_pct: sma200 > 0 ? (close / sma200 - 1) * 100 : 0,
      relative_slope_annualized_pct: regression.annualizedSlopePct,
      relative_r_squared: regression.rSquared,
      relative_acceleration_pct_points: acceleration,
    },
    risk: {
      volatility_60d_annualized_pct: volatility,
      max_drawdown_120d_pct: drawdown,
    },
    coverage: {
      from: aligned[0]!.bar.t,
      to: aligned.at(-1)!.bar.t,
      bars: aligned.length,
    },
    factors: {
      relativeMomentum: weightedHorizon(relativeReturns),
      absoluteMomentum: weightedHorizon(absoluteReturns),
      trendQuality: regression.annualizedSlopePct * regression.rSquared,
      acceleration,
      volatility,
      maxDrawdown: drawdown,
    },
  };
}

function rounded(row: RawRow): SectorAnalysisRow {
  const roundHorizons = (values: HorizonValues): HorizonValues => ({
    d20: values.d20 === null ? null : round(values.d20, 2),
    d60: values.d60 === null ? null : round(values.d60, 2),
    d120: values.d120 === null ? null : round(values.d120, 2),
    d252: values.d252 === null ? null : round(values.d252, 2),
  });
  return {
    rank: row.rank,
    symbol: row.symbol,
    sector: row.sector,
    strength_score: row.strength_score === null ? null : round(row.strength_score, 1),
    relative_phase: row.relative_phase,
    absolute_trend: row.absolute_trend,
    as_of: row.as_of,
    close: round(row.close, 4),
    returns_pct: roundHorizons(row.returns_pct),
    relative_returns_pct: roundHorizons(row.relative_returns_pct),
    trend: {
      sma50: round(row.trend.sma50, 4),
      sma200: round(row.trend.sma200, 4),
      distance_from_sma50_pct: round(row.trend.distance_from_sma50_pct, 2),
      distance_from_sma200_pct: round(row.trend.distance_from_sma200_pct, 2),
      relative_slope_annualized_pct: round(row.trend.relative_slope_annualized_pct, 2),
      relative_r_squared: round(row.trend.relative_r_squared, 4),
      relative_acceleration_pct_points: round(row.trend.relative_acceleration_pct_points, 2),
    },
    risk: {
      volatility_60d_annualized_pct: round(row.risk.volatility_60d_annualized_pct, 2),
      max_drawdown_120d_pct: round(row.risk.max_drawdown_120d_pct, 2),
    },
    coverage: { ...row.coverage },
  };
}

/** Analyze already-loaded adjusted daily bars. This function performs no I/O. */
export function analyzeSectorUniverse(input: SectorAnalysisInput): { sectors: SectorAnalysisRow[] } {
  const benchmarkByDate = new Map(
    input.benchmarkBars
      .filter((bar) => Number.isFinite(bar.c) && bar.c > 0)
      .map((bar) => [bar.t, bar.c] as const),
  );
  const rows = input.sectors
    .map((sector) => rawRow(benchmarkByDate, sector))
    .filter((row): row is RawRow => row !== undefined);

  if (rows.length <= 1) return { sectors: rows.map(rounded) };

  const relativeRanks = percentileRanks(rows.map((row) => row.factors.relativeMomentum));
  const absoluteRanks = percentileRanks(rows.map((row) => row.factors.absoluteMomentum));
  const trendRanks = percentileRanks(rows.map((row) => row.factors.trendQuality));
  const accelerationRanks = percentileRanks(rows.map((row) => row.factors.acceleration));
  const volatilityRanks = percentileRanks(rows.map((row) => row.factors.volatility));
  const drawdownRanks = percentileRanks(rows.map((row) => row.factors.maxDrawdown));

  rows.forEach((row, index) => {
    const riskQuality = ((100 - volatilityRanks[index]!) + (100 - drawdownRanks[index]!)) / 2;
    row.strength_score =
      0.4 * relativeRanks[index]!
      + 0.25 * absoluteRanks[index]!
      + 0.2 * trendRanks[index]!
      + 0.1 * accelerationRanks[index]!
      + 0.05 * riskQuality;
  });

  rows.sort((a, b) =>
    (b.strength_score ?? 0) - (a.strength_score ?? 0) || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return { sectors: rows.map(rounded) };
}
