import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import {
  loadStockPriceData,
  STOCK_PRICE_DATA_SOURCE,
  condenseBars,
  MAX_RANGE_DAYS,
  type BarRepository,
  type Snapshot,
  type StockPriceData,
} from "../../src/data/stock/index.ts";
import { buildStockPricePrompt } from "./prompts.ts";

/** A trading year. Before `condenseBars`, a longer default meant a proportionally
 *  larger prompt, so 60 was the compromise. Now the trend is capped at a fixed
 *  point budget: a year costs about 1KB more than a quarter and shows the model
 *  annual highs, lows and drawdowns that three months cannot. */
const DEFAULT_HISTORY_DAYS = 250;

/** Minute bars kept raw: the last quarter hour. The only question needing
 *  per-minute precision is "is it moving right now", and minute bars are the
 *  lowest-density data in the system. */
const INTRADAY_KEEP_TAIL = 15;
/** Enough points for the session's shape: ~6 minutes per bucket in regular
 *  hours, ~16 across an extended-hours session. */
const INTRADAY_MAX_TREND_POINTS = 60;

/** Raw bars kept at the tail of an explicit window. Larger than `daily`'s seven:
 *  a range the user named is usually itself the subject, not a backdrop for
 *  "how has it been lately". */
const WINDOW_KEEP_TAIL = 30;

/** Shape a `window.from`/`window.to` string must match before it reaches the
 *  repository. Without this, something like "Jan 5" string-compares as
 *  garbage against stored ISO dates and silently surfaces as "no stored bars"
 *  rather than as the malformed-input error it actually is. */
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function fmtVolume(volume: number | null): string {
  if (volume === null) return "N/A";
  if (volume >= 1e9) return `${(volume / 1e9).toFixed(2)}B`;
  if (volume >= 1e6) return `${(volume / 1e6).toFixed(1)}M`;
  if (volume >= 1e3) return `${(volume / 1e3).toFixed(1)}K`;
  return String(volume);
}

function toJsonData(data: StockPriceData): JsonObject {
  return {
    symbol: data.symbol,
    price: data.price,
    bidPrice: data.bidPrice,
    askPrice: data.askPrice,
    dayOpen: data.dayOpen,
    dayHigh: data.dayHigh,
    dayLow: data.dayLow,
    prevClose: data.prevClose,
    changePercent: data.changePercent,
    volume: data.volume,
    marketSession: data.marketSession,
    quoteTimestamp: data.quoteTimestamp,
    // Renamed from `dailyBars`: the shape changed, and reusing the old name
    // would leave the model indexing `dailyBars[0].o` into a digest.
    daily: condenseBars(data.dailyBars) as unknown as JsonObject,
    dataSource: data.dataSource,
    ...(data.intradayBars
      ? {
          intraday: condenseBars(data.intradayBars, {
            keepTail: INTRADAY_KEEP_TAIL,
            maxTrendPoints: INTRADAY_MAX_TREND_POINTS,
          }) as unknown as JsonObject,
        }
      : {}),
    ...(data.staleness ? { staleness: data.staleness } : {}),
    // Same three-part shape as `daily`, so the prompt's explanation of
    // recentBars / trend / stats covers both fields.
    ...(data.windowBars
      ? { window: condenseBars(data.windowBars, { keepTail: WINDOW_KEEP_TAIL }) as unknown as JsonObject }
      : {}),
    ...(data.windowNote ? { windowNote: data.windowNote } : {}),
    ...(data.dailyNote ? { dailyNote: data.dailyNote } : {}),
  };
}

/** Thin MCP adapter: validate tool input, call the stock data service, shape the tool response. */
export function createGetStockPriceTool(overrides?: {
  repository?: BarRepository;
  snapshot?: (symbol: string, nowMs: number) => Promise<Snapshot>;
}): RegisteredTool {
  return {
    name: "get_stock_price",
    description:
      "Fetch live US stock quotes and condensed daily history for one ticker. You must pass the ticker in the symbol argument. Live quotes come from Alpaca; daily history is served from a local store that updates incrementally. History comes back as the last 7 exact bars, a downsampled close series for trend, and exact derived statistics — do not recompute those yourself. The statistics carry two pairs of extremes: trueHigh/trueLow are the real period high and low including intraday, and are what you want for a \"52-week high\"; min/max are the highest and lowest close and must be named as closing high/low. To look at a specific past date or period, pass a `window`; do not widen `historyDays` to reach it.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: {
          type: "string",
          description:
            "US stock ticker to look up, e.g. AAPL, TSLA, NVDA. Required — resolve it from the conversation before calling.",
        },
        historyDays: {
          type: "number",
          description: `How many trading days of daily bars to return. Defaults to ${DEFAULT_HISTORY_DAYS}, capped at ${MAX_RANGE_DAYS}.`,
        },
        includeIntraday: {
          type: "boolean",
          description:
            "Whether to include the latest session's 1-minute bars. Defaults to false. Each bar carries its own timestamp; outside trading hours these are the previous session's.",
        },
        window: {
          type: "object",
          properties: {
            from: { type: "string", description: "Inclusive start, YYYY-MM-DD." },
            to: { type: "string", description: "Inclusive end, YYYY-MM-DD." },
          },
          required: ["from", "to"],
          description:
            "An absolute date range to look at, independent of historyDays. Use this whenever the question names a past date or period — it is far cheaper and more precise than widening historyDays and searching the result yourself. Returns the same condensed shape as `daily`, at full per-day resolution for ranges up to about 120 trading days.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const symbol =
        typeof input["symbol"] === "string" && input["symbol"].trim()
          ? input["symbol"].trim().toUpperCase()
          : undefined;

      if (!symbol) {
        return {
          summary: "No symbol was passed to get_stock_price. Call it again with the ticker in the symbol argument.",
          generation_context: {
            prompt:
              "No ticker was supplied. Determine which stock the user means from the conversation and call get_stock_price again with the symbol argument set.",
            data: { symbol: null, error: "symbol_required" },
          },
        };
      }

      const requestedHistoryDays =
        typeof input["historyDays"] === "number" && input["historyDays"] > 0
          ? Math.max(1, Math.floor(input["historyDays"]))
          : DEFAULT_HISTORY_DAYS;
      // Reaching further back is what `window` is for. Without this ceiling the
      // model's existing habit — widen the trailing history until it covers the
      // date it wants — silently survives every other change here.
      const historyDays = Math.min(requestedHistoryDays, MAX_RANGE_DAYS);
      const historyDaysNote =
        requestedHistoryDays > MAX_RANGE_DAYS
          ? `historyDays was capped at ${MAX_RANGE_DAYS} trading days. To look at an earlier period, pass a \`window\` instead of widening historyDays.`
          : undefined;

      const rawWindow = input["window"];
      let window: { from: string; to: string } | undefined;
      let malformedWindowNote: string | undefined;
      if (rawWindow !== undefined) {
        const isShapeValid =
          rawWindow !== null && typeof rawWindow === "object" && !Array.isArray(rawWindow)
            && typeof (rawWindow as Record<string, unknown>)["from"] === "string"
            && typeof (rawWindow as Record<string, unknown>)["to"] === "string";
        const from = isShapeValid ? (rawWindow as Record<string, string>)["from"]! : undefined;
        const to = isShapeValid ? (rawWindow as Record<string, string>)["to"]! : undefined;
        const isFormatValid =
          isShapeValid && DATE_FORMAT.test(from!) && DATE_FORMAT.test(to!);
        if (isFormatValid) {
          window = { from: from!, to: to! };
        } else {
          malformedWindowNote =
            "The window was ignored: `from` and `to` must both be YYYY-MM-DD dates.";
        }
      }

      const result = await loadStockPriceData(
        { symbol, historyDays, includeIntraday: input["includeIntraday"] === true, ...(window ? { window } : {}) },
        {
          ...(overrides?.repository ? { repository: overrides.repository } : {}),
          ...(overrides?.snapshot ? { snapshot: overrides.snapshot } : {}),
        },
      );

      if (!result.ok) {
        return {
          summary: `Market data unavailable for ${symbol}: ${result.error}`,
          generation_context: {
            prompt: `No market data available for ${symbol}.`,
            data: { symbol, error: result.error, dataSource: STOCK_PRICE_DATA_SOURCE },
          },
        };
      }

      const data = result.data;
      const changeStr =
        data.changePercent !== null
          ? `${data.changePercent >= 0 ? "+" : ""}${data.changePercent}%`
          : "N/A";
      const priceStr = data.price !== null ? `$${data.price}` : "N/A";
      const suffix = data.staleness
        ? ` | data as of ${data.dailyBars[data.dailyBars.length - 1]?.t}`
        : ` | ${data.marketSession}`;

      return {
        summary: `${symbol} ${priceStr} | ${changeStr} | Vol ${fmtVolume(data.volume)}${suffix}`,
        // `range` is a number of trading days (src/data/stock/stockChartData.ts);
        // 1 is the intraday session this tool's quote describes.
        visualizations: [{ type: "stock_price", symbol, range: 1 }],
        generation_context: {
          prompt: buildStockPricePrompt(symbol, data.marketSession, data.staleness),
          data: {
            ...toJsonData(data),
            ...(historyDaysNote ? { historyDaysNote } : {}),
            ...(malformedWindowNote ? { windowNote: malformedWindowNote } : {}),
          },
        },
      };
    },
  };
}
