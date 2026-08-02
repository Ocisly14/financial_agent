import test from "node:test";
import assert from "node:assert/strict";
import { condenseBars } from "../barDigest.ts";
import type { DailyBar } from "../alpacaClient.ts";

/** A bar whose close is `c`; the other fields are derived so they stay distinguishable. */
function bar(t: string, c: number): DailyBar {
  return { t, o: c - 1, h: c + 1, l: c - 2, c, v: 1_000, vw: c };
}

/** `count` consecutive weekday-ish dates from 2020-01-01, closes given by `close(i)`. */
function series(count: number, close: (i: number) => number): DailyBar[] {
  const bars: DailyBar[] = [];
  const day = new Date(Date.UTC(2020, 0, 1));
  for (let i = 0; i < count; i++) {
    bars.push(bar(day.toISOString().slice(0, 10), close(i)));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return bars;
}

test("empty input yields no trend and no stats", () => {
  assert.deepEqual(condenseBars([]), { recentBars: [] });
});

test("input at or below keepTail is returned whole, with stats but no trend", () => {
  const bars = series(7, (i) => 100 + i);
  const digest = condenseBars(bars);
  assert.deepEqual(digest.recentBars, bars);
  assert.equal(digest.trend, undefined);
  assert.equal(digest.stats?.count, 7);
});

test("one bar past keepTail produces a single trend point at bucketDays 1", () => {
  const digest = condenseBars(series(8, (i) => 100 + i));
  assert.equal(digest.recentBars.length, 7);
  assert.equal(digest.trend?.bucketDays, 1);
  assert.deepEqual(digest.trend?.t, ["2020-01-01"]);
  assert.deepEqual(digest.trend?.c, [100]);
});

test("a thousand bars keep seven raw and cap the trend at the point budget", () => {
  const digest = condenseBars(series(1000, (i) => 100 + i));
  assert.equal(digest.recentBars.length, 7);
  assert.equal(digest.trend?.bucketDays, Math.ceil(993 / 120));
  assert.equal(digest.trend?.t.length, digest.trend?.c.length);
  assert.ok((digest.trend?.t.length ?? 0) <= 120);
});

test("each trend point is the last bar of its bucket", () => {
  // 13 bars: 6 in the head (keepTail 7), maxTrendPoints 3 → bucketDays 2 → buckets [0,1] [2,3] [4,5]
  const digest = condenseBars(series(13, (i) => 100 + i), { maxTrendPoints: 3 });
  assert.equal(digest.trend?.bucketDays, 2);
  assert.deepEqual(digest.trend?.c, [101, 103, 105]);
  assert.deepEqual(digest.trend?.t, ["2020-01-02", "2020-01-04", "2020-01-06"]);
});

test("a short final bucket still emits its point", () => {
  // 12 bars: 5 in the head, bucketDays 2 → buckets [0,1] [2,3] [4]
  const digest = condenseBars(series(12, (i) => 100 + i), { maxTrendPoints: 3 });
  assert.deepEqual(digest.trend?.c, [101, 103, 104]);
});

test("stats cover the whole input, not just the downsampled head", () => {
  const digest = condenseBars(series(100, (i) => 100 + i));
  assert.equal(digest.stats?.from, "2020-01-01");
  assert.equal(digest.stats?.count, 100);
  assert.equal(digest.stats?.first, 100);
  assert.equal(digest.stats?.last, 199);
});

test("derived figures match hand-computed values", () => {
  const bars = [bar("2021-01-01", 10), bar("2021-01-02", 20), bar("2021-01-03", 30)];
  const stats = condenseBars(bars, { keepTail: 3 }).stats!;
  assert.deepEqual(stats.min, { value: 10, t: "2021-01-01" });
  assert.deepEqual(stats.max, { value: 30, t: "2021-01-03" });
  assert.equal(stats.mean, 20);
  // population stdev of [10,20,30] = sqrt(200/3) = 8.16
  assert.equal(stats.stdev, 8.16);
  assert.equal(stats.returnPct, 200);
});

test("min and max report the first occurrence of a repeated extreme", () => {
  const bars = [bar("2021-01-01", 5), bar("2021-01-02", 9), bar("2021-01-03", 5), bar("2021-01-04", 9)];
  const stats = condenseBars(bars, { keepTail: 4 }).stats!;
  assert.equal(stats.min.t, "2021-01-01");
  assert.equal(stats.max.t, "2021-01-02");
});

test("a monotonic rise has no drawdown", () => {
  const stats = condenseBars(series(50, (i) => 100 + i), { keepTail: 50 }).stats!;
  assert.equal(stats.maxDrawdownPct, 0);
});

test("max drawdown is measured from the running peak", () => {
  // peak 200 → trough 150 is 25%; the later 180 → 171 dip is only 5%
  const bars = [
    bar("2021-01-01", 100), bar("2021-01-02", 200), bar("2021-01-03", 150),
    bar("2021-01-04", 180), bar("2021-01-05", 171),
  ];
  const stats = condenseBars(bars, { keepTail: 5 }).stats!;
  assert.equal(stats.maxDrawdownPct, 25);
});

test("a zero opening price yields zero return rather than Infinity", () => {
  const bars = [bar("2021-01-01", 0), bar("2021-01-02", 50)];
  const stats = condenseBars(bars, { keepTail: 2 }).stats!;
  assert.equal(stats.returnPct, 0);
  assert.ok(Number.isFinite(stats.returnPct));
});

test("moving averages are null until enough bars exist", () => {
  const short = condenseBars(series(19, (i) => 100 + i), { keepTail: 19 }).stats!;
  assert.equal(short.sma20, null);
  assert.equal(short.sma50, null);

  const mid = condenseBars(series(20, () => 100), { keepTail: 20 }).stats!;
  assert.equal(mid.sma20, 100);
  assert.equal(mid.sma50, null);

  const long = condenseBars(series(50, () => 100), { keepTail: 50 }).stats!;
  assert.equal(long.sma50, 100);
});

test("moving averages use only the trailing window", () => {
  // The first 10 closes are 1 and the last 20 are 200: an sma20 that reached
  // back past the window would land well under 200.
  const bars = series(30, (i) => (i < 10 ? 1 : 200));
  const stats = condenseBars(bars, { keepTail: 30 }).stats!;
  assert.equal(stats.sma20, 200);
  assert.equal(stats.sma50, null);
});

test("condensing is idempotent for a given input", () => {
  const bars = series(300, (i) => 100 + Math.sin(i));
  assert.deepEqual(condenseBars(bars), condenseBars(bars));
});

test("the input array is not mutated", () => {
  const bars = series(30, (i) => 100 + i);
  const before = JSON.stringify(bars);
  condenseBars(bars);
  assert.equal(JSON.stringify(bars), before);
});
