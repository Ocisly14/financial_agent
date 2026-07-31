import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STOCK_RANGE,
  extractStockCharts,
  parseStockChartProps,
  pollIntervalForSession,
  shouldPollCandles,
  stripIncompleteTrailingTag,
} from "../stockChart.ts";

// 10. pollIntervalForSession — the four sessions
test("pollIntervalForSession maps each session to its interval", () => {
  assert.equal(pollIntervalForSession("regular"), 5_000);
  assert.equal(pollIntervalForSession("pre-market"), 30_000);
  assert.equal(pollIntervalForSession("after-hours"), 30_000);
  assert.equal(pollIntervalForSession("closed"), false);
});

// 11. parseStockChartProps
test("parseStockChartProps accepts well-formed tickers", () => {
  assert.deepEqual(parseStockChartProps({ symbol: "AAPL", range: "1Y" }), {
    symbol: "AAPL",
    range: "1Y",
  });
  assert.deepEqual(parseStockChartProps({ symbol: "BRK.B" }), { symbol: "BRK.B", range: DEFAULT_STOCK_RANGE });
});

test("parseStockChartProps normalizes case and whitespace", () => {
  assert.deepEqual(parseStockChartProps({ symbol: "  aapl " }), {
    symbol: "AAPL",
    range: DEFAULT_STOCK_RANGE,
  });
});

test("parseStockChartProps rejects anything that could be smuggled into a URL", () => {
  for (const symbol of ["../etc/passwd", "AA PL", "A/B", "TOOLONGSYM", "", "<script>", "AAPL?x=1"]) {
    const result = parseStockChartProps({ symbol });
    assert.ok("error" in result, `expected ${JSON.stringify(symbol)} to be rejected`);
  }
});

test("parseStockChartProps reports the original text so the UI can echo it", () => {
  const result = parseStockChartProps({ symbol: "not a ticker" });
  assert.deepEqual(result, { error: "not a ticker" });
});

test("parseStockChartProps accepts five ranges and defaults invalid values to 1D", () => {
  for (const range of ["1D", "5D", "1M", "3M", "1Y"] as const) {
    assert.equal((parseStockChartProps({ symbol: "AAPL", range }) as { range: string }).range, range);
  }
  for (const range of ["7D", "abc", "", 30, undefined]) {
    assert.equal(
      (parseStockChartProps({ symbol: "AAPL", range }) as { range: string }).range,
      DEFAULT_STOCK_RANGE,
    );
  }
});

test("shouldPollCandles only polls intraday ranges", () => {
  assert.equal(shouldPollCandles("1D"), true);
  assert.equal(shouldPollCandles("5D"), true);
  assert.equal(shouldPollCandles("1M"), false);
  assert.equal(shouldPollCandles("3M"), false);
  assert.equal(shouldPollCandles("1Y"), false);
});

// 12. stripIncompleteTrailingTag
test("stripIncompleteTrailingTag drops a half-streamed tag", () => {
  assert.equal(stripIncompleteTrailingTag("文字 <StockChart symb"), "文字 ");
  assert.equal(stripIncompleteTrailingTag("文字 <"), "文字 ");
});

test("stripIncompleteTrailingTag leaves complete tags and plain text alone", () => {
  const complete = 'AAPL 走强。\n\n<StockChart symbol="AAPL" range="1Y" />';
  assert.equal(stripIncompleteTrailingTag(complete), complete);
  assert.equal(stripIncompleteTrailingTag("没有尖括号的正文"), "没有尖括号的正文");
  assert.equal(stripIncompleteTrailingTag(""), "");
});

test("stripIncompleteTrailingTag keeps a closed angle bracket earlier in the text", () => {
  // A `<` that has a later `>` is unaffected; only one left unclosed all the way to the end gets cut.
  assert.equal(stripIncompleteTrailingTag("a < b > c"), "a < b > c");
});

test("extractStockCharts reads valid agent chart directives", () => {
  assert.deepEqual(
    extractStockCharts([
      "走势如下：",
      '<StockChart range="1Y" symbol="aapl" />',
      "以及指数：",
      "<StockChart symbol='SPY' range='5D'/>",
    ].join("\n")),
    [
      { symbol: "AAPL", range: "1Y" },
      { symbol: "SPY", range: "5D" },
    ],
  );
});

test("extractStockCharts ignores invalid symbols and defaults invalid ranges", () => {
  assert.deepEqual(
    extractStockCharts('<StockChart symbol="../etc" /><StockChart symbol="MSFT" range="7D" />'),
    [{ symbol: "MSFT", range: DEFAULT_STOCK_RANGE }],
  );
});
