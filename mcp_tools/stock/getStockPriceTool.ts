import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import {
  loadStockPriceData,
  STOCK_PRICE_DATA_SOURCE,
  type BarRepository,
  type Snapshot,
  type StockPriceData,
} from "../../src/data/stock/index.ts";
import { buildStockPricePrompt } from "./prompts.ts";

const DEFAULT_HISTORY_DAYS = 60;

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
    dailyBars: data.dailyBars.map((bar) => ({ ...bar })),
    dataSource: data.dataSource,
    ...(data.intradayBars ? { intradayBars: data.intradayBars.map((bar) => ({ ...bar })) } : {}),
    ...(data.staleness ? { staleness: data.staleness } : {}),
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
      "Fetch live US stock quotes and recent daily bars for one ticker. You must pass the ticker in the symbol argument. Live quotes come from Alpaca; daily history is served from a local store that updates incrementally.",
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
        task: {
          type: "string",
          description: "Natural-language request, passed through for report context.",
        },
        historyDays: {
          type: "number",
          description: `How many trading days of daily bars to return. Defaults to ${DEFAULT_HISTORY_DAYS}.`,
        },
        includeIntraday: {
          type: "boolean",
          description: "Whether to include today's 1-minute bars. Defaults to false.",
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

      const historyDays =
        typeof input["historyDays"] === "number" && input["historyDays"] > 0
          ? Math.floor(input["historyDays"])
          : DEFAULT_HISTORY_DAYS;

      const result = await loadStockPriceData(
        { symbol, historyDays, includeIntraday: input["includeIntraday"] === true },
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
        ? ` | 数据截至 ${data.dailyBars[data.dailyBars.length - 1]?.t}`
        : ` | ${data.marketSession}`;

      return {
        summary: `${symbol} ${priceStr} | ${changeStr} | Vol ${fmtVolume(data.volume)}${suffix}`,
        generation_context: {
          prompt: buildStockPricePrompt(symbol, data.marketSession, data.staleness),
          data: toJsonData(data),
        },
      };
    },
  };
}
