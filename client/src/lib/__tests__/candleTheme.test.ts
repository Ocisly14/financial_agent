import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CANDLE_THEME } from "../../components/charts/candleTheme.ts";

test("CandleScope's default theme uses the Financial Chart Phosphor COL color scheme", () => {
  assert.deepEqual(
    {
      grid: DEFAULT_CANDLE_THEME.grid,
      gridStrong: DEFAULT_CANDLE_THEME.gridStrong,
      axis: DEFAULT_CANDLE_THEME.axis,
      ink: DEFAULT_CANDLE_THEME.ink,
      inkDim: DEFAULT_CANDLE_THEME.inkDim,
      amber: DEFAULT_CANDLE_THEME.amber,
      pos: DEFAULT_CANDLE_THEME.pos,
      neg: DEFAULT_CANDLE_THEME.neg,
    },
    {
      grid: "rgba(255,255,255,0.05)",
      gridStrong: "rgba(255,255,255,0.09)",
      axis: "#545a67",
      ink: "#edeff3",
      inkDim: "#8b909c",
      amber: "#ffb648",
      pos: "#4ade80",
      neg: "#fb5d7a",
    },
  );
});
