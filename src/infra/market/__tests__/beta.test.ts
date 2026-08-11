import assert from "node:assert/strict";
import test from "node:test";
import { alignOnDate, computeBeta, logReturns, toWeekly, type PriceBar } from "../beta.ts";

/** `days` trading days starting on a Monday, so week boundaries are predictable. */
function series(start: string, closes: readonly number[]): PriceBar[] {
  const date = new Date(`${start}T00:00:00Z`);
  return closes.map((c) => {
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    const t = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 1);
    return { t, c };
  });
}

test("log returns are continuously compounded and additive across a period", () => {
  const returns = logReturns([100, 110, 121]);
  assert.equal(returns.length, 2);
  // ln(1.1) twice, and their sum is the two-period return ln(1.21).
  assert.ok(Math.abs(returns[0]! - Math.log(1.1)) < 1e-12);
  assert.ok(Math.abs(returns[0]! + returns[1]! - Math.log(1.21)) < 1e-12);
});

test("a non-positive close is skipped rather than poisoning the series with NaN", () => {
  const returns = logReturns([100, 0, 110, 121]);
  assert.ok(returns.every(Number.isFinite), JSON.stringify(returns));
});

test("weekly resampling keeps the last close of each Monday-to-Sunday week", () => {
  const bars = series("2026-01-05", [10, 11, 12, 13, 14, 20, 21]); // Mon-Fri, then Mon-Tue
  const weekly = toWeekly(bars);
  assert.deepEqual(weekly.map((b) => b.c), [14, 21]);
  assert.deepEqual(weekly.map((b) => b.t), ["2026-01-09", "2026-01-13"]);
});

test("alignment keeps only the dates both series carry", () => {
  const asset = [{ t: "2026-01-05", c: 1 }, { t: "2026-01-06", c: 2 }, { t: "2026-01-07", c: 3 }];
  const market = [{ t: "2026-01-05", c: 10 }, { t: "2026-01-07", c: 30 }];
  const aligned = alignOnDate(asset, market);
  assert.deepEqual(aligned.dates, ["2026-01-05", "2026-01-07"]);
  assert.deepEqual(aligned.asset, [1, 3]);
  assert.deepEqual(aligned.market, [10, 30]);
});

test("an asset that moves exactly twice the market has beta 2 on both frequencies", () => {
  // Market compounds 0.1% a day; the asset compounds twice that, so in LOG space it is exactly 2x.
  const marketCloses = Array.from({ length: 600 }, (_v, i) => 100 * Math.exp(0.001 * i));
  const assetCloses = Array.from({ length: 600 }, (_v, i) => 50 * Math.exp(0.002 * i));
  // A constant ratio has zero variance, so add a shared wiggle the asset amplifies twofold.
  const wiggle = (i: number) => Math.sin(i * 0.7) * 0.01;
  const market = series("2016-01-04", marketCloses.map((c, i) => c * Math.exp(wiggle(i))));
  const asset = series("2016-01-04", assetCloses.map((c, i) => c * Math.exp(2 * wiggle(i))));

  const result = computeBeta({ asset, market });
  assert.ok(Math.abs(result.daily - 2) < 1e-9, `daily ${result.daily}`);
  assert.ok(Math.abs(result.weekly - 2) < 1e-9, `weekly ${result.weekly}`);
  assert.equal(result.average, (result.daily + result.weekly) / 2);
  assert.equal(result.dailyObservations, 599);
  assert.ok(result.weeklyObservations > 100 && result.weeklyObservations < 150, `${result.weeklyObservations}`);
  assert.equal(result.from, asset[0]!.t);
  assert.equal(result.to, asset.at(-1)!.t);
});

test("too little shared history is refused rather than returned as a number", () => {
  const asset = series("2026-01-05", Array.from({ length: 50 }, (_v, i) => 100 + i));
  const market = series("2026-01-05", Array.from({ length: 50 }, (_v, i) => 100 + i * 2));
  assert.throws(() => computeBeta({ asset, market }), /more than 200 shared trading days/);
});

test("a market with no variance is refused rather than dividing by zero", () => {
  const flat = series("2016-01-04", Array.from({ length: 400 }, () => 100));
  const asset = series("2016-01-04", Array.from({ length: 400 }, (_v, i) => 100 + i));
  assert.throws(() => computeBeta({ asset, market: flat }), /zero variance/);
});
