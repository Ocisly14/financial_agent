import test from "node:test";
import assert from "node:assert/strict";
import { chartFits, clampChartRatio, MIN_CHART_WIDTH, MIN_CONVERSATION_WIDTH } from "../splitLayout.ts";

const wide = { totalWidth: 1600, railWidth: 240 };

test("a comfortable ratio passes through untouched", () => {
  assert.equal(clampChartRatio(0.46, wide), 0.46);
});

test("a ratio starving the chart is raised to its minimum", () => {
  const clamped = clampChartRatio(0.05, wide);
  assert.ok(Math.abs(clamped - MIN_CHART_WIDTH / (1600 - 240)) < 1e-9);
});

test("a ratio starving the conversation is lowered to its maximum", () => {
  const clamped = clampChartRatio(0.95, wide);
  assert.ok(Math.abs(clamped - (1 - MIN_CONVERSATION_WIDTH / (1600 - 240))) < 1e-9);
});

test("both panes fit when the available width covers both minimums", () => {
  assert.equal(chartFits({ totalWidth: MIN_CHART_WIDTH + MIN_CONVERSATION_WIDTH + 240, railWidth: 240 }), true);
});

test("the chart pane does not fit one pixel below the combined minimums", () => {
  assert.equal(chartFits({ totalWidth: MIN_CHART_WIDTH + MIN_CONVERSATION_WIDTH + 239, railWidth: 240 }), false);
});

test("a ratio is clamped to zero when the chart cannot fit at all", () => {
  assert.equal(clampChartRatio(0.46, { totalWidth: 600, railWidth: 240 }), 0);
});

test("a non-finite ratio falls back to the default rather than poisoning the layout", () => {
  assert.equal(clampChartRatio(Number.NaN, wide), 0.46);
});

test("a zero-width container yields zero rather than dividing by zero", () => {
  assert.equal(clampChartRatio(0.46, { totalWidth: 0, railWidth: 240 }), 0);
});
