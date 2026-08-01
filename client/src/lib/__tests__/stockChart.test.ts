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
  assert.deepEqual(parseStockChartProps({ symbol: "AAPL", range: 252 }), {
    symbol: "AAPL",
    range: 252,
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

test("parseStockChartProps takes a day count, or a duration written the way a reader says it", () => {
  // A range is a number of trading days. Conventional durations are also
  // accepted at this boundary and converted, because every message already
  // written stores `range="1Y"` and a model writing prose reaches for that
  // before it reaches for 252.
  for (const [input, days] of [[1, 1], [126, 126], ["252", 252], ["1Y", 252], ["6M", 126], ["5D", 5]] as const) {
    assert.equal((parseStockChartProps({ symbol: "AAPL", range: input }) as { range: number }).range, days);
  }
  // An arbitrary window is legal now — that is the point of dropping the enum.
  assert.equal((parseStockChartProps({ symbol: "AAPL", range: 7 }) as { range: number }).range, 7);

  for (const range of ["abc", "", 0, -1, 2.5, undefined]) {
    assert.equal(
      (parseStockChartProps({ symbol: "AAPL", range }) as { range: number }).range,
      DEFAULT_STOCK_RANGE,
    );
  }
});

test("shouldPollCandles only polls the intraday windows", () => {
  assert.equal(shouldPollCandles(1), true);
  assert.equal(shouldPollCandles(5), true);
  assert.equal(shouldPollCandles(6), false, "past a week the bars are daily and stop moving intraday");
  assert.equal(shouldPollCandles(21), false);
  assert.equal(shouldPollCandles(252), false);
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
      { symbol: "AAPL", range: 252 },
      { symbol: "SPY", range: 5 },
    ],
  );
});

test("extractStockCharts ignores invalid symbols and defaults unparseable ranges", () => {
  assert.deepEqual(
    extractStockCharts('<StockChart symbol="../etc" /><StockChart symbol="MSFT" range="nonsense" />'),
    [{ symbol: "MSFT", range: DEFAULT_STOCK_RANGE }],
  );
  // "7D" is no longer invalid — an arbitrary window is the whole point.
  assert.deepEqual(
    extractStockCharts('<StockChart symbol="MSFT" range="7D" />'),
    [{ symbol: "MSFT", range: 7 }],
  );
});
