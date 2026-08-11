import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOverlay, type SeriesInput } from "../overlayNormalize.ts";

const series = (symbol: string, pairs: Array<[string, number]>): SeriesInput =>
  ({ symbol, bars: pairs.map(([t, c]) => ({ t, c })) });

test("pct expresses each line as percent change from its base", () => {
  const result = normalizeOverlay(
    [series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110]])],
    "pct",
  );
  assert.deepEqual(result.series[0]?.points.map((p) => p.v), [0, 10]);
});

test("index100 rebases to 100 and is a linear transform of pct", () => {
  const bars: Array<[string, number]> = [["2026-01-01", 100], ["2026-01-02", 110]];
  const pct = normalizeOverlay([series("AAPL", bars)], "pct").series[0]!;
  const idx = normalizeOverlay([series("AAPL", bars)], "index100").series[0]!;
  assert.deepEqual(idx.points.map((p) => p.v), [100, 110]);
  idx.points.forEach((point, i) => {
    assert.ok(Math.abs(point.v - (pct.points[i]!.v + 100)) < 1e-9);
  });
});

test("the axis is the intersection of the inputs, never a union", () => {
  const result = normalizeOverlay(
    [
      series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110], ["2026-01-03", 120]]),
      series("NVDA", [["2026-01-02", 50], ["2026-01-03", 55]]),
    ],
    "pct",
  );
  // 2026-01-01 is missing from NVDA, so it is not on the axis at all.
  assert.deepEqual(result.axis, ["2026-01-02", "2026-01-03"]);
  assert.equal(result.series.every((s) => s.points.length === 2), true);
});

test("no interpolation: a gap inside one series shrinks the axis", () => {
  const result = normalizeOverlay(
    [
      series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110], ["2026-01-03", 120]]),
      series("NVDA", [["2026-01-01", 50], ["2026-01-03", 55]]),
    ],
    "pct",
  );
  // NVDA did not trade on the 2nd. Inventing a point for it would be fabricating data.
  assert.deepEqual(result.axis, ["2026-01-01", "2026-01-03"]);
});

test("a symbol listed later than the others keeps its OWN base date", () => {
  const result = normalizeOverlay(
    [
      series("AAPL", [["2026-01-01", 100], ["2026-02-01", 150]]),
      series("IPO", [["2026-02-01", 20]]),
    ],
    "pct",
  );
  const ipo = result.series.find((s) => s.symbol === "IPO");
  assert.equal(ipo?.baseDate, "2026-02-01");
  assert.deepEqual(ipo?.points.map((p) => p.v), [0], "starting it at someone else's base would invent a gain it never had");
});

test("the base follows the visible window", () => {
  const bars: Array<[string, number]> = [
    ["2026-01-01", 100], ["2026-02-01", 150], ["2026-03-01", 180],
  ];
  const zoomed = normalizeOverlay([series("AAPL", bars)], "pct", "2026-02-01");
  assert.equal(zoomed.series[0]?.baseDate, "2026-02-01");
  assert.deepEqual(zoomed.series[0]?.points.map((p) => Math.round(p.v)), [0, 20]);
});

test("a visibleFrom past every bar falls back to the full range rather than emptying the chart", () => {
  const result = normalizeOverlay(
    [series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110]])],
    "pct",
    "2030-01-01",
  );
  assert.equal(result.axis.length, 2);
});

test("a symbol with no bars at all is dropped and named", () => {
  const result = normalizeOverlay(
    [series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110]]), series("DEAD", [])],
    "pct",
  );
  assert.deepEqual(result.series.map((s) => s.symbol), ["AAPL"]);
  assert.deepEqual(result.dropped, ["DEAD"]);
});

test("fewer than two overlapping points yields no series rather than a misleading flat line", () => {
  const result = normalizeOverlay(
    [
      series("AAPL", [["2026-01-01", 100]]),
      series("NVDA", [["2026-01-01", 50]]),
    ],
    "pct",
  );
  assert.deepEqual(result.series, []);
  assert.deepEqual(result.axis, []);
});

test("a zero base is dropped rather than dividing by zero", () => {
  const result = normalizeOverlay(
    [series("AAPL", [["2026-01-01", 0], ["2026-01-02", 10]]), series("NVDA", [["2026-01-01", 50], ["2026-01-02", 55]])],
    "pct",
  );
  assert.deepEqual(result.series.map((s) => s.symbol), ["NVDA"]);
  assert.deepEqual(result.dropped, ["AAPL"]);
});

test("input order is preserved in the output", () => {
  const result = normalizeOverlay(
    [
      series("NVDA", [["2026-01-01", 50], ["2026-01-02", 55]]),
      series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110]]),
    ],
    "pct",
  );
  assert.deepEqual(result.series.map((s) => s.symbol), ["NVDA", "AAPL"]);
});
