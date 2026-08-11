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

/**
 * A range is a NUMBER OF TRADING DAYS, not a label — same contract as the
 * backend's `src/data/stock/stockChartData.ts`.
 *
 * The enum this replaced ("1D" | "5D" | "1M" | "3M" | "1Y") had no way to say
 * "six months": a `6M` from the agent failed every membership test and fell
 * back to `1D`, so the user got a one-day intraday chart that looked entirely
 * normal. A day count cannot be missing a member.
 */
export type StockRange = number;

export const MIN_STOCK_RANGE_DAYS = 1;
/** Mirrors MAX_RANGE_DAYS in src/data/stock/stockChartData.ts (5 years of daily backfill). */
export const MAX_STOCK_RANGE_DAYS = 1260;
export const DEFAULT_STOCK_RANGE: StockRange = 1;

/**
 * The curated buttons. A deliberately short, conventional set — the chart area
 * is not a command line, and the agent can already ask for any window it wants.
 * A range outside this set still renders (see `stockRangeLabel`), it just is
 * not one of the presets.
 */
export const STOCK_RANGE_PRESETS: readonly StockRange[] = [1, 5, 21, 63, 126, 252];

/**
 * A day count as a finance reader says it: 1 -> "1D", 63 -> "3M", 252 -> "1Y",
 * 504 -> "2Y". Returns an i18n key plus its value rather than a string, so the
 * unit is translated and this stays a pure function the root `node --test` can
 * cover (the client has no React test runner).
 *
 * The thresholds are the conventional ones: under a month it reads in days,
 * under a year in months, past that in years. `value` deliberately is not
 * called `count` — i18next treats a `count` interpolation as a plural selector
 * and would demand `_one` / `_other` variants for a purely numeric label.
 */
export function stockRangeLabel(days: number): { key: string; value: number } {
  if (days < 21) return { key: "charts.range.days", value: days };
  if (days < 252) return { key: "charts.range.months", value: Math.round(days / 21) };
  return { key: "charts.range.years", value: Math.round((days / 252) * 10) / 10 };
}

/** True when a range needs its own chip because no preset button represents it. */
export function isPresetStockRange(days: number): boolean {
  return STOCK_RANGE_PRESETS.includes(days);
}

/**
 * Strict parse: a whole number of trading days inside the servable window, or
 * undefined. Callers on a read path may substitute `DEFAULT_STOCK_RANGE`;
 * nothing on a write path may.
 */
export function parseStockRange(raw: unknown): StockRange | undefined {
  const days = typeof raw === "number" ? raw : durationToDays(raw);
  return Number.isInteger(days) && days >= MIN_STOCK_RANGE_DAYS && days <= MAX_STOCK_RANGE_DAYS
    ? days
    : undefined;
}

/** Trading days per unit. Everything downstream of this function is days. */
const UNIT_DAYS: Record<string, number> = { D: 1, W: 5, M: 21, Y: 252 };

/**
 * Accepts a day count *or* a conventional duration (`1Y`, `6M`, `5D`) and
 * returns days. The internal representation is always a day count; this is the
 * only place a unit exists.
 *
 * Both forms are accepted on purpose. Every message already written stores
 * `<StockChart range="1Y" />`, and rejecting those would silently turn years of
 * history into one-day charts — the exact failure this whole change is fixing.
 * A model writing markdown prose also reaches for `1Y` before `252`, and there
 * is no reason to make it translate.
 */
function durationToDays(raw: unknown): number {
  if (typeof raw !== "string") return Number.NaN;
  const text = raw.trim().toUpperCase();
  if (text === "") return Number.NaN;
  const duration = /^(\d+)([DWMY])$/.exec(text);
  if (duration) return Number(duration[1]) * UNIT_DAYS[duration[2]!]!;
  return Number(text);
}

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
  return parseStockRange(raw) ?? DEFAULT_STOCK_RANGE;
}

/** Only the intraday tiers move within a session; see `barsForRangeDays`. */
export function shouldPollCandles(range: StockRange): boolean {
  return range <= 5;
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
