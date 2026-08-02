import type { DailyBar } from "./alpacaClient.ts";

/**
 * Condensing a bar series for the model's prompt.
 *
 * A `get_stock_price` call used to inject its full bar array verbatim — a
 * thousand daily bars is ~84KB, about 21k tokens, and the model reads almost
 * none of it. What it actually uses is the last few bars, the shape of the rest,
 * and figures derived from the whole thing. This produces exactly those three.
 *
 * Every value here is computed, never estimated. Handing a numeric series to a
 * model to summarize is the single most reliable way to get plausible wrong
 * numbers, and `src/agent/prompts/orchestratorPrompt.ts` requires every figure
 * in an answer to come from this data.
 */

/** Raw bars kept at the tail. One trading week — these are the only bars a
 *  question quotes individually ("today", "yesterday", "this week"). Anything
 *  older is a question about shape, which `trend` answers. */
const DEFAULT_KEEP_TAIL = 7;

/** Ceiling on trend points. 120 is enough for the shape of any span to read,
 *  and two parallel arrays of that length cost ~2.4KB against the 84KB the
 *  raw series cost. */
const DEFAULT_MAX_TREND_POINTS = 120;

export type BarStats = {
  from: string;
  to: string;
  count: number;
  first: number;
  last: number;
  min: { value: number; t: string };
  max: { value: number; t: string };
  mean: number;
  stdev: number;
  returnPct: number;
  maxDrawdownPct: number;
  sma20: number | null;
  sma50: number | null;
};

export type BarDigest = {
  /** Tail bars, verbatim. Safe to quote per-bar. */
  recentBars: DailyBar[];
  /** Downsampled closes for everything before the tail. Omitted when there is
   *  nothing before it.
   *
   *  Parallel arrays rather than an array of objects: `[{t,c},…]` repeats two
   *  key names per point, `{t:[…],c:[…]}` writes them once. Dates are stored
   *  per point rather than derived from a start plus a step, because trading
   *  days are not calendar-uniform — a derived date would be wrong, and a wrong
   *  date gets quoted as fact. */
  trend?: { t: string[]; c: number[]; bucketDays: number };
  /** Exact figures over the whole input, including `recentBars`. Omitted only
   *  for empty input. */
  stats?: BarStats;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Population standard deviation: this is a complete known series, not a sample. */
function stdev(values: number[], mean: number): number {
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Largest peak-to-trough fall, as a percentage of the peak, where the peak
 *  precedes the trough. Zero for a series that never falls. */
function maxDrawdownPct(closes: number[]): number {
  let peak = closes[0]!;
  let worst = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const fall = ((peak - close) / peak) * 100;
      if (fall > worst) worst = fall;
    }
  }
  return worst;
}

/** Mean of the last `window` closes, or null when the series is shorter. */
function sma(closes: number[], window: number): number | null {
  if (closes.length < window) return null;
  const tail = closes.slice(closes.length - window);
  return round2(tail.reduce((sum, c) => sum + c, 0) / tail.length);
}

function computeStats(bars: readonly DailyBar[]): BarStats {
  const closes = bars.map((b) => b.c);
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;

  let min = { value: closes[0]!, t: bars[0]!.t };
  let max = { value: closes[0]!, t: bars[0]!.t };
  for (let i = 1; i < bars.length; i++) {
    // Strict comparison keeps the FIRST occurrence of a repeated extreme.
    if (closes[i]! < min.value) min = { value: closes[i]!, t: bars[i]!.t };
    if (closes[i]! > max.value) max = { value: closes[i]!, t: bars[i]!.t };
  }

  const mean = closes.reduce((sum, c) => sum + c, 0) / closes.length;

  return {
    from: bars[0]!.t,
    to: bars[bars.length - 1]!.t,
    count: bars.length,
    first: round2(first),
    last: round2(last),
    min: { value: round2(min.value), t: min.t },
    max: { value: round2(max.value), t: max.t },
    mean: round2(mean),
    stdev: round2(stdev(closes, mean)),
    // A zero opening price would make the ratio infinite; report no move
    // rather than emitting Infinity into the prompt.
    returnPct: first === 0 ? 0 : round2(((last - first) / first) * 100),
    maxDrawdownPct: round2(maxDrawdownPct(closes)),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
  };
}

export function condenseBars(
  bars: readonly DailyBar[],
  options?: { keepTail?: number; maxTrendPoints?: number },
): BarDigest {
  if (bars.length === 0) return { recentBars: [] };

  const keepTail = options?.keepTail ?? DEFAULT_KEEP_TAIL;
  const maxTrendPoints = options?.maxTrendPoints ?? DEFAULT_MAX_TREND_POINTS;
  const stats = computeStats(bars);

  if (bars.length <= keepTail) {
    return { recentBars: bars.map((bar) => ({ ...bar })), stats };
  }

  const head = bars.slice(0, bars.length - keepTail);
  const bucketDays = Math.max(1, Math.ceil(head.length / maxTrendPoints));
  const t: string[] = [];
  const c: number[] = [];
  // Each bucket contributes its LAST bar: the close a bucket ends on is the
  // one a reader compares against the next bucket. A short final bucket still
  // contributes, so the trend runs right up to where `recentBars` begins.
  for (let start = 0; start < head.length; start += bucketDays) {
    const bucketEnd = Math.min(start + bucketDays, head.length) - 1;
    t.push(head[bucketEnd]!.t);
    c.push(round2(head[bucketEnd]!.c));
  }

  return {
    recentBars: bars.slice(bars.length - keepTail).map((bar) => ({ ...bar })),
    trend: { t, c, bucketDays },
    stats,
  };
}
