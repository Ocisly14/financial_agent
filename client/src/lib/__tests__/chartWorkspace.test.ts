import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSymbolChartWorkspace,
  parseWorkspaceVisualization,
  rangeForTechnicalTimeframe,
} from "../chartWorkspace.ts";

test("parses a stock price visualization source", () => {
  assert.deepEqual(
    parseWorkspaceVisualization({ type: "stock_price", symbol: "msft", range: 252 }),
    { type: "stock_price", symbol: "MSFT", range: 252 },
  );
});

test("parses a technical study independently from the narrative", () => {
  const parsed = parseWorkspaceVisualization({
    type: "stock_technical",
    symbol: "MSFT",
    timeframe: "1Day",
    indicator: "SMA",
    placement: "overlay",
    parameters: { period: 20 },
    series: [{
      key: "sma",
      label: "SMA(20)",
      points: [
        { timestamp: "2026-07-28", value: 501.2 },
        { timestamp: "2026-07-29", value: 502.4 },
      ],
    }],
  });

  assert.equal(parsed?.type, "stock_technical");
  if (parsed?.type !== "stock_technical") return;
  assert.equal(parsed.symbol, "MSFT");
  assert.equal(parsed.study.id, "SMA:1Day:period=20");
  assert.equal(parsed.study.series[0]?.points.length, 2);
});

test("rejects malformed chart specs and maps technical timeframes to a useful price horizon", () => {
  assert.equal(parseWorkspaceVisualization({ type: "stock_technical", symbol: "../etc" }), undefined);
  assert.equal(rangeForTechnicalTimeframe("1Day"), 252);
  assert.equal(rangeForTechnicalTimeframe("15Min"), 1);
});

test("parses a stock overlay visualization, deduping and defaulting normalize to pct", () => {
  assert.deepEqual(
    parseWorkspaceVisualization({ type: "stock_overlay", symbols: ["aapl", "nvda", "aapl"], range: 252 }),
    { type: "stock_overlay", symbols: ["AAPL", "NVDA"], range: 252, normalize: "pct" },
  );
});

test("an overlay with more than 6 symbols is truncated, keeping the first 6", () => {
  const parsed = parseWorkspaceVisualization({
    type: "stock_overlay",
    symbols: ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"],
    range: 252,
  });
  assert.equal(parsed?.type, "stock_overlay");
  if (parsed?.type !== "stock_overlay") return;
  assert.deepEqual(parsed.symbols, ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]);
});

test("an overlay drops a single malformed ticker rather than the whole chart", () => {
  const parsed = parseWorkspaceVisualization({
    type: "stock_overlay",
    symbols: ["AAPL", "../etc", "NVDA"],
    range: 252,
  });
  assert.equal(parsed?.type, "stock_overlay");
  if (parsed?.type !== "stock_overlay") return;
  assert.deepEqual(parsed.symbols, ["AAPL", "NVDA"]);
});

test("an overlay with fewer than 2 valid symbols after validation is not a chart", () => {
  assert.equal(
    parseWorkspaceVisualization({ type: "stock_overlay", symbols: ["AAPL", "../etc"], range: 252 }),
    undefined,
  );
  assert.equal(
    parseWorkspaceVisualization({ type: "stock_overlay", symbols: ["AAPL"], range: 252 }),
    undefined,
  );
});

test("an overlay with an unrecognised normalize value falls back to pct rather than throwing", () => {
  const parsed = parseWorkspaceVisualization({
    type: "stock_overlay",
    symbols: ["AAPL", "NVDA"],
    range: 252,
    normalize: "z-score",
  });
  assert.equal(parsed?.type, "stock_overlay");
  if (parsed?.type !== "stock_overlay") return;
  assert.equal(parsed.normalize, "pct");
});

test("an overlay may explicitly request index100", () => {
  const parsed = parseWorkspaceVisualization({
    type: "stock_overlay",
    symbols: ["AAPL", "NVDA"],
    range: 252,
    normalize: "index100",
  });
  assert.equal(parsed?.type, "stock_overlay");
  if (parsed?.type !== "stock_overlay") return;
  assert.equal(parsed.normalize, "index100");
});

test("an overlay visualization is ignored by buildSymbolChartWorkspace's per-symbol derivation", () => {
  const workspace = buildSymbolChartWorkspace([
    {
      user: "system",
      visualizations: [{ type: "stock_overlay", symbols: ["AAPL", "NVDA"], range: 252, normalize: "pct" }],
    },
  ]);
  assert.deepEqual(workspace.charts, []);
  assert.equal(workspace.focusSymbol, undefined);
});

test("groups price and later technical studies into one tab per symbol", () => {
  const sma = {
    type: "stock_technical",
    symbol: "MSFT",
    timeframe: "1Day",
    indicator: "SMA",
    placement: "overlay",
    parameters: { period: 20 },
    series: [{ key: "sma", label: "SMA(20)", points: [{ timestamp: "2026-07-29", value: 502 }] }],
  };
  const workspace = buildSymbolChartWorkspace([
    { user: "system", text: '<StockChart symbol="MSFT" />', visualizations: [{ type: "stock_price", symbol: "MSFT", range: 1 }] },
    { user: "system", text: '<StockChart symbol="MSFT" />', visualizations: [sma] },
    { user: "system", text: '<StockChart symbol="AAPL" range="5D" />' },
    { user: "system", text: "Updated MSFT SMA", visualizations: [{ ...sma, series: [{ key: "sma", label: "SMA(20)", points: [{ timestamp: "2026-07-30", value: 503 }] }] }] },
  ]);

  assert.deepEqual(workspace.charts.map((chart) => chart.symbol), ["MSFT", "AAPL"]);
  assert.equal(workspace.charts[0]?.studies.length, 1);
  assert.equal(workspace.charts[0]?.range, 252);
  assert.equal(workspace.charts[0]?.studies[0]?.series[0]?.points[0]?.value, 503);
  assert.equal(workspace.focusSymbol, "MSFT");
});
