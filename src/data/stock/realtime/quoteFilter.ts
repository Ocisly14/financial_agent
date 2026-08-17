/**
 * Entry filter for streamed quotes.
 *
 * This replaces the N-sample "wick confirmation" the triggers used to carry. That mechanism
 * came from a crypto design — 24/7, single thin venue, no circuit breakers — where a trigger
 * had to see a condition hold across several polls before acting. US equities have LULD bands
 * and clearly-erroneous-trade rules, so market-wide fake wicks are not the threat; unrepresentative
 * single-venue data is. Rejecting that at the entry is more direct than counting repetitions at
 * the trigger, and it costs no latency on clean data.
 *
 * The outlier rule carries the one genuinely dangerous failure mode in this file. "Reject anything
 * far from the recent median" silently discards a real crash or gap — exactly the move a stop-loss
 * exists for — leaving the strategy doing nothing while the price runs away. So the rule has an
 * escape hatch: a lone spike is dirty data, but a deviation that *persists* in one direction is
 * real, and once it does the baseline moves to the new level.
 */

export interface Quote {
  bid: number;
  ask: number;
  ts: number;
}

export type RejectReason = "invalid" | "crossed" | "wide_spread" | "outlier";

export type FilterResult = { ok: true; mid: number } | { ok: false; reason: RejectReason };

export interface QuoteFilter {
  accept(quote: Quote): FilterResult;
  stats(): Record<RejectReason, number>;
}

/** Below this many accepted quotes there is no baseline worth comparing against. */
export const MIN_SAMPLES_FOR_OUTLIER_CHECK = 5;

export const DEFAULT_MAX_SPREAD_PCT = 2;
export const DEFAULT_OUTLIER_PCT = 5;
/** Consecutive same-direction deviations that mean "this is the market, not a bad print". */
export const DEFAULT_BREAKOUT_SAMPLES = 3;
export const DEFAULT_MEDIAN_LOOKBACK = 20;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function createQuoteFilter(options: {
  maxSpreadPct?: number | undefined;
  outlierPct?: number | undefined;
  breakoutSamples?: number | undefined;
  medianLookback?: number | undefined;
} = {}): QuoteFilter {
  const maxSpreadPct = options.maxSpreadPct ?? DEFAULT_MAX_SPREAD_PCT;
  const outlierPct = options.outlierPct ?? DEFAULT_OUTLIER_PCT;
  const breakoutSamples = options.breakoutSamples ?? DEFAULT_BREAKOUT_SAMPLES;
  const medianLookback = options.medianLookback ?? DEFAULT_MEDIAN_LOOKBACK;

  const recent: number[] = [];
  let streakDirection: "up" | "down" | undefined;
  let streakCount = 0;
  const rejected: Record<RejectReason, number> = { invalid: 0, crossed: 0, wide_spread: 0, outlier: 0 };

  const reject = (reason: RejectReason): FilterResult => {
    rejected[reason] += 1;
    return { ok: false, reason };
  };

  const remember = (mid: number): void => {
    recent.push(mid);
    if (recent.length > medianLookback) recent.shift();
  };

  /** A confirmed move invalidates the old baseline outright — averaging across the gap would
   *  leave every quote at the new level looking like an outlier for the next lookback window. */
  const rebaseline = (mid: number): void => {
    recent.length = 0;
    for (let index = 0; index < MIN_SAMPLES_FOR_OUTLIER_CHECK; index++) recent.push(mid);
  };

  return {
    accept(quote) {
      const { bid, ask } = quote;
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
        return reject("invalid");
      }
      if (bid >= ask) return reject("crossed");

      const mid = (bid + ask) / 2;
      if (((ask - bid) / mid) * 100 > maxSpreadPct) return reject("wide_spread");

      if (recent.length >= MIN_SAMPLES_FOR_OUTLIER_CHECK) {
        const baseline = median(recent);
        const deviationPct = ((mid - baseline) / baseline) * 100;
        if (Math.abs(deviationPct) > outlierPct) {
          const direction = deviationPct > 0 ? "up" : "down";
          streakCount = direction === streakDirection ? streakCount + 1 : 1;
          streakDirection = direction;
          if (streakCount < breakoutSamples) return reject("outlier");
          rebaseline(mid);
          streakDirection = undefined;
          streakCount = 0;
          return { ok: true, mid };
        }
      }

      streakDirection = undefined;
      streakCount = 0;
      remember(mid);
      return { ok: true, mid };
    },

    stats() {
      return { ...rejected };
    },
  };
}
