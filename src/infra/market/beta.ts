/**
 * Levered beta from price history: cov(asset, market) / var(market).
 *
 * Two conventions matter and both are deliberate here. Returns are continuously compounded — the
 * natural log of the price relative — so that they add across time and a weekly return is exactly the
 * sum of its days. And the weekly series is resampled from the same daily bars rather than fetched
 * separately, so both betas come from one set of split- and dividend-adjusted prices.
 */

export type PriceBar = { t: string; c: number };

export type BetaResult = {
  /** Beta on daily returns. */
  daily: number;
  /** Beta on weekly returns, resampled from the same bars. */
  weekly: number;
  /** The figure to use: the two carry different noise, and neither is authoritative alone. */
  average: number;
  dailyObservations: number;
  weeklyObservations: number;
  /** Trading dates actually shared by both series, so a short listing history is visible. */
  from: string;
  to: string;
};

/** Below this a beta is noise dressed as a number. ~1 year of trading days. */
const MIN_DAILY_OBSERVATIONS = 200;

/** Continuously compounded returns: ln(P_t / P_t-1). */
export function logReturns(closes: readonly number[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const previous = closes[index - 1]!;
    const current = closes[index]!;
    // A non-positive close has no logarithm. Skipping the pair keeps the series finite rather than
    // seeding it with NaN, which would silently poison the covariance.
    if (previous <= 0 || current <= 0) continue;
    returns.push(Math.log(current / previous));
  }
  return returns;
}

/** ISO-week bucket (Mon–Sun) as a sortable key. */
function weekKey(isoDate: string): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  const day = date.getUTCDay();
  // Shift Sunday (0) to the end of the preceding week rather than the start of the next one.
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

/** The last close of each ISO week. A short week (holiday, listing date) still yields its close. */
export function toWeekly(bars: readonly PriceBar[]): PriceBar[] {
  const lastOfWeek = new Map<string, PriceBar>();
  for (const bar of [...bars].sort((a, b) => a.t.localeCompare(b.t))) lastOfWeek.set(weekKey(bar.t), bar);
  return [...lastOfWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, bar]) => bar);
}

/** Closes for the dates both series carry, in date order. One-sided dates cannot form a pair. */
export function alignOnDate(asset: readonly PriceBar[], market: readonly PriceBar[]):
{ dates: string[]; asset: number[]; market: number[] } {
  const marketByDate = new Map(market.map((bar) => [bar.t.slice(0, 10), bar.c]));
  const dates: string[] = [];
  const assetCloses: number[] = [];
  const marketCloses: number[] = [];
  for (const bar of [...asset].sort((a, b) => a.t.localeCompare(b.t))) {
    const date = bar.t.slice(0, 10);
    const marketClose = marketByDate.get(date);
    if (marketClose === undefined) continue;
    dates.push(date);
    assetCloses.push(bar.c);
    marketCloses.push(marketClose);
  }
  return { dates, asset: assetCloses, market: marketCloses };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Population covariance. Beta divides one by the other, so the divisor cancels — it only has to match. */
export function covariance(xs: readonly number[], ys: readonly number[]): number {
  const xMean = mean(xs);
  const yMean = mean(ys);
  return xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index]! - yMean), 0) / xs.length;
}

export function variance(xs: readonly number[]): number {
  const xMean = mean(xs);
  return xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0) / xs.length;
}

function betaOf(assetReturns: readonly number[], marketReturns: readonly number[]): number {
  const marketVariance = variance(marketReturns);
  if (marketVariance === 0) throw new Error("market returns have zero variance; beta is undefined");
  return covariance(assetReturns, marketReturns) / marketVariance;
}

export function computeBeta(input: { asset: readonly PriceBar[]; market: readonly PriceBar[] }): BetaResult {
  const daily = alignOnDate(input.asset, input.market);
  if (daily.dates.length <= MIN_DAILY_OBSERVATIONS) {
    throw new Error(`beta needs more than ${MIN_DAILY_OBSERVATIONS} shared trading days, got ${daily.dates.length}`);
  }
  // Resample AFTER aligning, so both series are bucketed over an identical set of dates and a week
  // the asset did not trade cannot pair with a week the market did.
  const alignedBars = (closes: readonly number[]): PriceBar[] =>
    daily.dates.map((date, index) => ({ t: date, c: closes[index]! }));
  const weeklyAsset = toWeekly(alignedBars(daily.asset)).map((bar) => bar.c);
  const weeklyMarket = toWeekly(alignedBars(daily.market)).map((bar) => bar.c);

  const dailyAssetReturns = logReturns(daily.asset);
  const dailyMarketReturns = logReturns(daily.market);
  const weeklyAssetReturns = logReturns(weeklyAsset);
  const weeklyMarketReturns = logReturns(weeklyMarket);

  const dailyBeta = betaOf(dailyAssetReturns, dailyMarketReturns);
  const weeklyBeta = betaOf(weeklyAssetReturns, weeklyMarketReturns);
  return {
    daily: dailyBeta,
    weekly: weeklyBeta,
    average: (dailyBeta + weeklyBeta) / 2,
    dailyObservations: dailyAssetReturns.length,
    weeklyObservations: weeklyAssetReturns.length,
    from: daily.dates[0]!,
    to: daily.dates.at(-1)!,
  };
}
