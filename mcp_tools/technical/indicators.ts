import type { OhlcvBar } from "../shared/coinglassClient.ts";

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

export function atr(bars: OhlcvBar[], period = 14): number[] {
  if (bars.length < 2) return [];
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i]!;
    const prevClose = bars[i - 1]!.close;
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

export function obv(bars: OhlcvBar[]): number[] {
  if (bars.length === 0) return [];
  const result: number[] = [0];
  let current = 0;
  for (let i = 1; i < bars.length; i++) {
    const { close, volume } = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    if (close > prevClose) current += volume;
    else if (close < prevClose) current -= volume;
    // equal: unchanged
    result.push(current);
  }
  return result;
}

// ─── VWAP (Volume-Weighted Average Price) ─────────────────────────────────────

export function vwap(bars: OhlcvBar[]): number[] {
  if (bars.length === 0) return [];
  const result: number[] = [];
  let cumulativePV = 0;
  let cumulativeVol = 0;
  for (const bar of bars) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    cumulativePV += typical * bar.volume;
    cumulativeVol += bar.volume;
    result.push(cumulativeVol !== 0 ? cumulativePV / cumulativeVol : typical);
  }
  return result;
}

// ─── Support & Resistance ─────────────────────────────────────────────────────

export type SupportResistance = {
  support: number[];
  resistance: number[];
};

export function supportResistance(closes: number[], lookback = 20): SupportResistance {
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

  return {
    support: dedup(support).slice(-5),
    resistance: dedup(resistance).slice(-5),
  };
}

// ─── Trend Summary ────────────────────────────────────────────────────────────

export type TrendSummary = {
  sma20: number;
  sma50: number;
  sma200: number;
  ema12: number;
  ema26: number;
  rsi14: number;
  macdValue: number;
  macdSignal: number;
  macdHistogram: number;
  bb_upper: number;
  bb_middle: number;
  bb_lower: number;
  bb_pctB: number;
  atr14: number;
  obvChangePct: number; // 10-bar OBV % change (raw value; the agent judges direction)
  support: number[];
  resistance: number[];
  vwap: number;
};

function lastOf(arr: number[]): number {
  return arr[arr.length - 1] ?? 0;
}

export function computeTrend(bars: OhlcvBar[]): TrendSummary {
  const closes = bars.map((b) => b.close);

  const sma20Val = lastOf(sma(closes, 20));
  const sma50Val = lastOf(sma(closes, 50));
  const sma200Val = lastOf(sma(closes, 200));
  const ema12Val = lastOf(ema(closes, 12));
  const ema26Val = lastOf(ema(closes, 26));
  const rsi14Val = lastOf(rsi(closes, 14));

  const macdResult = macd(closes, 12, 26, 9);
  const macdValue = lastOf(macdResult.macd);
  const macdSignalVal = lastOf(macdResult.signal);
  const macdHistogram = lastOf(macdResult.histogram);

  const bbResult = bollinger(closes, 20, 2);
  const bb_upper = lastOf(bbResult.upper);
  const bb_middle = lastOf(bbResult.middle);
  const bb_lower = lastOf(bbResult.lower);
  const bb_pctB = lastOf(bbResult.pctB);

  const atr14Val = lastOf(atr(bars, 14));

  const obvSeries = obv(bars);
  const obvLen = obvSeries.length;
  let obvChangePct = 0;
  if (obvLen >= 10) {
    const recent = obvSeries[obvLen - 1]!;
    const older = obvSeries[obvLen - 10]!;
    obvChangePct = (recent - older) / (Math.abs(older) || 1);
  }

  const sr = supportResistance(closes, 20);
  const vwapVal = lastOf(vwap(bars));

  return {
    sma20: sma20Val,
    sma50: sma50Val,
    sma200: sma200Val,
    ema12: ema12Val,
    ema26: ema26Val,
    rsi14: rsi14Val,
    macdValue,
    macdSignal: macdSignalVal,
    macdHistogram,
    bb_upper,
    bb_middle,
    bb_lower,
    bb_pctB,
    atr14: atr14Val,
    obvChangePct,
    support: sr.support,
    resistance: sr.resistance,
    vwap: vwapVal,
  };
}
