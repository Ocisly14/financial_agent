import type { DailyBar } from "../../src/data/stock/index.ts";

// ─── Simple Moving Average ────────────────────────────────────────────────────

export function sma(values: number[], period: number): number[] {
  if (period <= 0 || values.length === 0) return [];
  const result: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j]!;
    }
    result.push(sum / period);
  }
  return result;
}

// ─── Exponential Moving Average ──────────────────────────────────────────────

export function ema(values: number[], period: number): number[] {
  if (period <= 0 || values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period && i < values.length; i++) {
    sum += values[i]!;
  }
  if (values.length < period) return [];
  let prev = sum / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

export function rsi(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const result: number[] = [];

  // Initial averages from first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  const firstRs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + firstRs));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }

  return result;
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

export type MacdResult = {
  macd: number[];
  signal: number[];
  histogram: number[];
};

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  // emaFast has length closes.length - fast + 1
  // emaSlow has length closes.length - slow + 1
  // Align: slow series is shorter; fast series offset = slow - fast
  const offset = slow - fast; // emaFast[offset + i] aligns with emaSlow[i]
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[offset + i]! - emaSlow[i]!);
  }

  const signalLine = ema(macdLine, signalPeriod);
  const sigOffset = signalPeriod - 1; // macdLine index where signalLine[0] aligns
  const histogram: number[] = signalLine.map((s, i) => macdLine[sigOffset + i]! - s);

  return { macd: macdLine, signal: signalLine, histogram };
}

// ─── Bollinger Bands ─────────────────────────────────────────────────────────

export type BollingerResult = {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
  pctB: number[];
};

export function bollinger(closes: number[], period = 20, stdMult = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];
  const pctB: number[] = [];

  for (let i = 0; i < middle.length; i++) {
    const slice = closes.slice(i, i + period);
    const mean = middle[i]!;
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    const u = mean + stdMult * std;
    const l = mean - stdMult * std;
    upper.push(u);
    lower.push(l);
    const bw = mean !== 0 ? (u - l) / mean : 0;
    bandwidth.push(bw);
    const range = u - l;
    pctB.push(range !== 0 ? (closes[i + period - 1]! - l) / range : 0.5);
  }

  return { upper, middle, lower, bandwidth, pctB };
}

// ─── ATR (Average True Range) ─────────────────────────────────────────────────

export function atr(bars: DailyBar[], period = 14): number[] {
  if (bars.length < 2) return [];
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const { h: high, l: low } = bars[i]!;
    const prevClose = bars[i - 1]!.c;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }
  if (trueRanges.length < period) return [];

  // Seed with simple average of first `period` TR values
  let avgTr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: number[] = [avgTr];
  for (let i = period; i < trueRanges.length; i++) {
    avgTr = (avgTr * (period - 1) + trueRanges[i]!) / period;
    result.push(avgTr);
  }
  return result;
}

// ─── OBV (On-Balance Volume) ──────────────────────────────────────────────────

export function obv(bars: DailyBar[]): number[] {
  if (bars.length === 0) return [];
  const result: number[] = [0];
  let current = 0;
  for (let i = 1; i < bars.length; i++) {
    const { c: close, v: volume } = bars[i]!;
    const prevClose = bars[i - 1]!.c;
    if (close > prevClose) current += volume;
    else if (close < prevClose) current -= volume;
    // equal: unchanged
    result.push(current);
  }
  return result;
}

// ─── VWAP (Volume-Weighted Average Price) ─────────────────────────────────────

export function vwap(bars: DailyBar[]): number[] {
  if (bars.length === 0) return [];
  const result: number[] = [];
  let cumulativePV = 0;
  let cumulativeVol = 0;
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    cumulativePV += typical * bar.v;
    cumulativeVol += bar.v;
    result.push(cumulativeVol !== 0 ? cumulativePV / cumulativeVol : typical);
  }
  return result;
}

// ─── Support & Resistance ─────────────────────────────────────────────────────

export type SupportResistance = {
  support: number[];
  resistance: number[];
};

export function supportResistance(closes: number[], lookback = 20, maxLevels = 5): SupportResistance {
  const support: number[] = [];
  const resistance: number[] = [];

  for (let i = lookback; i < closes.length - lookback; i++) {
    const window = closes.slice(i - lookback, i + lookback + 1);
    const center = closes[i]!;
    const isMin = window.every((v) => v >= center);
    const isMax = window.every((v) => v <= center);
    if (isMin) support.push(center);
    if (isMax) resistance.push(center);
  }

  // Deduplicate close levels (within 0.5% of each other) and keep most recent
  const dedup = (levels: number[]): number[] => {
    const sorted = [...levels].sort((a, b) => a - b);
    const deduped: number[] = [];
    for (const level of sorted) {
      const last = deduped[deduped.length - 1];
      if (last === undefined || Math.abs(level - last) / last > 0.005) {
        deduped.push(level);
      }
    }
    return deduped;
  };

  const latest = closes.at(-1);
  const supports = dedup(support);
  const resistances = dedup(resistance);
  return {
    support: supports
      .filter((level) => latest === undefined || level <= latest)
      .sort((a, b) => b - a)
      .slice(0, maxLevels),
    resistance: resistances
      .filter((level) => latest === undefined || level >= latest)
      .sort((a, b) => a - b)
      .slice(0, maxLevels),
  };
}
