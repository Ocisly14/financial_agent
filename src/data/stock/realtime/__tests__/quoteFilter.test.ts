import { test } from "node:test";
import assert from "node:assert/strict";
import { createQuoteFilter, MIN_SAMPLES_FOR_OUTLIER_CHECK } from "../quoteFilter.ts";

/** Feed enough clean quotes around `price` to establish a median baseline. */
function warmUp(filter: ReturnType<typeof createQuoteFilter>, price: number): void {
  for (let index = 0; index < MIN_SAMPLES_FOR_OUTLIER_CHECK; index++) {
    filter.accept({ bid: price - 0.01, ask: price + 0.01, ts: 1_000 + index });
  }
}

test("a clean quote is accepted and reduced to its mid", () => {
  const filter = createQuoteFilter();
  const result = filter.accept({ bid: 99.98, ask: 100.02, ts: 1_000 });
  assert.deepEqual(result, { ok: true, mid: 100 });
});

test("a crossed quote is rejected", () => {
  const filter = createQuoteFilter();
  const result = filter.accept({ bid: 100.05, ask: 100.0, ts: 1_000 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "crossed");
});

test("a locked quote is rejected", () => {
  const filter = createQuoteFilter();
  const result = filter.accept({ bid: 100, ask: 100, ts: 1_000 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "crossed");
});

test("a non-positive or missing side is rejected", () => {
  const filter = createQuoteFilter();
  assert.equal(filter.accept({ bid: 0, ask: 100, ts: 1_000 }).ok, false);
  assert.equal(filter.accept({ bid: 100, ask: Number.NaN, ts: 1_000 }).ok, false);
});

test("a spread wider than the limit is rejected", () => {
  const filter = createQuoteFilter({ maxSpreadPct: 2 });
  const result = filter.accept({ bid: 99, ask: 102, ts: 1_000 }); // ~2.99% of mid
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "wide_spread");
});

test("no outlier check runs before enough samples exist", () => {
  const filter = createQuoteFilter();
  // The very first quote has nothing to be an outlier against.
  assert.equal(filter.accept({ bid: 99.99, ask: 100.01, ts: 1_000 }).ok, true);
  assert.equal(filter.accept({ bid: 499.99, ask: 500.01, ts: 1_100 }).ok, true);
});

test("an isolated wild print is rejected as an outlier", () => {
  const filter = createQuoteFilter({ outlierPct: 5 });
  warmUp(filter, 100);

  const result = filter.accept({ bid: 119.99, ask: 120.01, ts: 2_000 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "outlier");

  // The baseline is untouched, so a normal quote still passes.
  assert.equal(filter.accept({ bid: 99.99, ask: 100.01, ts: 2_100 }).ok, true);
});

test("a sustained move in one direction breaks through the outlier guard", () => {
  const filter = createQuoteFilter({ outlierPct: 5, breakoutSamples: 3 });
  warmUp(filter, 100);

  // A genuine gap down: every sample is beyond the guard, all in the same direction.
  assert.equal(filter.accept({ bid: 89.99, ask: 90.01, ts: 2_000 }).ok, false);
  assert.equal(filter.accept({ bid: 89.94, ask: 89.96, ts: 2_500 }).ok, false);
  const third = filter.accept({ bid: 89.89, ask: 89.91, ts: 3_000 });
  assert.deepEqual(third, { ok: true, mid: 89.9 });
});

test("after a breakout the new level becomes the baseline", () => {
  const filter = createQuoteFilter({ outlierPct: 5, breakoutSamples: 3 });
  warmUp(filter, 100);
  filter.accept({ bid: 89.99, ask: 90.01, ts: 2_000 });
  filter.accept({ bid: 89.94, ask: 89.96, ts: 2_500 });
  filter.accept({ bid: 89.89, ask: 89.91, ts: 3_000 });

  // Quotes around the new level are ordinary now, not outliers.
  assert.equal(filter.accept({ bid: 89.99, ask: 90.01, ts: 3_500 }).ok, true);
  // And the old level is what looks wrong.
  assert.equal(filter.accept({ bid: 99.99, ask: 100.01, ts: 4_000 }).ok, false);
});

test("deviations that flip direction do not accumulate into a breakout", () => {
  const filter = createQuoteFilter({ outlierPct: 5, breakoutSamples: 3 });
  warmUp(filter, 100);

  assert.equal(filter.accept({ bid: 119.99, ask: 120.01, ts: 2_000 }).ok, false);
  assert.equal(filter.accept({ bid: 79.99, ask: 80.01, ts: 2_500 }).ok, false);
  // Third deviation is up again, but the streak was broken — still an outlier.
  assert.equal(filter.accept({ bid: 119.99, ask: 120.01, ts: 3_000 }).ok, false);
});

test("rejected quotes are counted by reason for diagnostics", () => {
  const filter = createQuoteFilter();
  filter.accept({ bid: 100.05, ask: 100.0, ts: 1_000 });
  filter.accept({ bid: 100.05, ask: 100.0, ts: 1_100 });
  assert.equal(filter.stats().crossed, 2);
});
