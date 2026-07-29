import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSymbolChartWorkspace,
  parseWorkspaceVisualization,
  rangeForTechnicalTimeframe,
} from "../chartWorkspace.ts";

test("parses a stock price visualization source", () => {
  assert.deepEqual(
    parseWorkspaceVisualization({ type: "stock_price", symbol: "msft", range: "1Y" }),
    { type: "stock_price", symbol: "MSFT", range: "1Y" },
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
  assert.equal(rangeForTechnicalTimeframe("1Day"), "1Y");
  assert.equal(rangeForTechnicalTimeframe("15Min"), "1D");
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
    { user: "system", text: '<StockChart symbol="MSFT" />', visualizations: [{ type: "stock_price", symbol: "MSFT", range: "1D" }] },
    { user: "system", text: '<StockChart symbol="MSFT" />', visualizations: [sma] },
    { user: "system", text: '<StockChart symbol="AAPL" range="5D" />' },
    { user: "system", text: "Updated MSFT SMA", visualizations: [{ ...sma, series: [{ key: "sma", label: "SMA(20)", points: [{ timestamp: "2026-07-30", value: 503 }] }] }] },
  ]);

  assert.deepEqual(workspace.charts.map((chart) => chart.symbol), ["MSFT", "AAPL"]);
  assert.equal(workspace.charts[0]?.studies.length, 1);
  assert.equal(workspace.charts[0]?.range, "1Y");
  assert.equal(workspace.charts[0]?.studies[0]?.series[0]?.points[0]?.value, 503);
  assert.equal(workspace.focusSymbol, "MSFT");
});
