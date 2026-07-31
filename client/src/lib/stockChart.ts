/**
 * Pure logic for `<StockChart />`.
 *
 * This file deliberately avoids importing React, using JSX, or going through the `@/` path
 * alias — the client repo has no test runner, so pure functions are kept here where the root
 * `node --test` can cover them directly (see client/src/lib/__tests__/stockChart.test.ts).
 */

/** Structurally identical to the backend's marketHours.ts MarketSession; deliberately redeclared here rather than imported across the client/server boundary. */
export type MarketSession = "pre-market" | "regular" | "after-hours" | "closed";

/** Same rule as the backend's stockMarketRoutes.ts SYMBOL_RE; each side implements its own. */
const SYMBOL_RE = /^[A-Z][A-Z.-]{0,5}$/;

export const STOCK_RANGES = ["1D", "5D", "1M", "3M", "1Y"] as const;
export type StockRange = (typeof STOCK_RANGES)[number];
export const DEFAULT_STOCK_RANGE: StockRange = "1D";

export type StockChartProps = { symbol: string; range: StockRange };
export type StockChartPropsError = { error: string };

const STOCK_CHART_TAG_RE = /<StockChart\b([^>]*)\/?\s*>/gi;

function readTagAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** Extract valid chart display directives emitted in an agent response. */
export function extractStockCharts(text: string): StockChartProps[] {
  const charts: StockChartProps[] = [];
  for (const match of text.matchAll(STOCK_CHART_TAG_RE)) {
    const attributes = match[1] ?? "";
    const parsed = parseStockChartProps({
      symbol: readTagAttribute(attributes, "symbol"),
      range: readTagAttribute(attributes, "range"),
    });
    if (!("error" in parsed)) charts.push(parsed);
  }
  return charts;
}

/**
 * symbol gets interpolated into the request URL, and it comes from model-generated text — this
 * is this component's one new risk surface. If it's invalid, no request is sent.
 */
export function parseStockChartProps(input: {
  symbol?: unknown;
  range?: unknown;
}): StockChartProps | StockChartPropsError {
  const raw = typeof input.symbol === "string" ? input.symbol : "";
  const symbol = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return { error: raw };

  return { symbol, range: parseRange(input.range) };
}

function parseRange(raw: unknown): StockRange {
  return typeof raw === "string" && (STOCK_RANGES as readonly string[]).includes(raw)
    ? (raw as StockRange)
    : DEFAULT_STOCK_RANGE;
}

export function shouldPollCandles(range: StockRange): boolean {
  return range === "1D" || range === "5D";
}

/**
 * Polling interval. The decision logic lives in exactly one place — the backend's
 * marketHours.ts — this function only maps from it.
 *
 * 5 seconds equals alpacaClient.ts's snapshot cache TTL — polling faster than the cache
 * wouldn't get fresher data.
 */
export function pollIntervalForSession(session: MarketSession): number | false {
  switch (session) {
    case "regular":
      return 5_000;
    case "pre-market":
    case "after-hours":
      return 30_000;
    case "closed":
      return false;
  }
}

/**
 * Cuts off a trailing unclosed `<...` fragment.
 *
 * During streaming render the body grows token by token, and intermediate states like
 * `<StockChart symb` get escaped by markdown-to-jsx into literal rendered text (verified
 * empirically: it doesn't swallow the following text, it just escapes `<` to `&lt;`). Users would
 * otherwise see a flash of the raw half-formed tag, which this hides.
 *
 * Known tradeoff: an `a < b` in the body that happens to land at the very end also gets cut.
 * Acceptable — the next token restores it, and this only affects the streaming preview state;
 * the finalized message never goes through this function.
 */
export function stripIncompleteTrailingTag(text: string): string {
  return text.replace(/<[^>]*$/, "");
}
