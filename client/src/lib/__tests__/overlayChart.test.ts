import test from "node:test";
import assert from "node:assert/strict";
import {
  brushToWindow,
  formatBaseDate,
  formatOverlayValue,
  overlayTabLabel,
  overlayValueTicks,
  seriesColor,
} from "../overlayChart.ts";

test("every tick lands inside the domain it was asked for", () => {
  for (const [min, max] of [[-16, 27], [0, 1], [-3.5, 3.5], [95, 118], [-200, 40]] as const) {
    const ticks = overlayValueTicks(min, max);
    assert.ok(ticks.length > 0, `expected ticks for ${min}..${max}`);
    for (const tick of ticks) {
      assert.ok(tick >= min && tick <= max, `${tick} escaped ${min}..${max}`);
    }
  }
});

test("a domain gets enough gridlines to read a value off", () => {
  // The failing case this rule was written for: a six-month AAPL/NVDA overlay
  // spans roughly -17%..+35%, which under a strict round-up produced a step of
  // 20 and so exactly two lines — one of them the baseline the chart already
  // draws. Counting by target rather than by step width gives it five.
  assert.deepEqual(overlayValueTicks(-17, 35), [-10, 0, 10, 20, 30]);
  for (const [min, max] of [[-17, 35], [-16, 27], [-30, 30], [-5, 12], [88, 130]] as const) {
    const ticks = overlayValueTicks(min, max);
    assert.ok(ticks.length >= 3 && ticks.length <= 7, `${min}..${max} produced ${ticks.length} ticks`);
  }
});

test("ticks step evenly, on round numbers", () => {
  const ticks = overlayValueTicks(-16, 27);
  const step = ticks[1]! - ticks[0]!;
  for (let index = 1; index < ticks.length; index++) {
    assert.ok(Math.abs(ticks[index]! - ticks[index - 1]! - step) < 1e-9, "uneven step");
  }
  assert.ok(Number.isInteger(step * 2), `${step} is not a round step`);
});

test("an empty or inverted domain has no ticks rather than throwing", () => {
  assert.deepEqual(overlayValueTicks(5, 5), []);
  assert.deepEqual(overlayValueTicks(10, 2), []);
});

test("a normalized reading is printed in its own mode's convention", () => {
  assert.equal(formatOverlayValue(18.34, "pct"), "+18.3%");
  assert.equal(formatOverlayValue(-7.37, "pct"), "-7.4%");
  assert.equal(formatOverlayValue(0, "pct"), "+0.0%", "the sign is explicit even at the base");
  assert.equal(formatOverlayValue(118.34, "index100"), "118.3");
});

test("a brush snaps outward to real axis points, and a stray click is not a zoom", () => {
  const axis = ["2026-01-02", "2026-01-03", "2026-01-06", "2026-01-07", "2026-01-08"];
  assert.deepEqual(brushToWindow(axis, 0.3, 0.6), { from: "2026-01-03", to: "2026-01-07" });
  // Dragged right-to-left: the same window.
  assert.deepEqual(brushToWindow(axis, 0.6, 0.3), { from: "2026-01-03", to: "2026-01-07" });
  assert.equal(brushToWindow(axis, 0.5, 0.5), null);
  assert.equal(brushToWindow(["2026-01-02"], 0, 1), null);
});

test("the tab label names what is being compared, and colours never repeat within the cap", () => {
  assert.equal(overlayTabLabel(["AAPL", "NVDA"]), "AAPL+NVDA");
  assert.equal(new Set([0, 1, 2, 3, 4, 5].map(seriesColor)).size, 6);
  assert.equal(formatBaseDate("2026-01-30T14:30:00Z"), "2026-01-30");
});
