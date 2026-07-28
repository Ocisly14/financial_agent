import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { resolveCredentials } from "./resolveCredentials.ts";
import { coinbaseFetch } from "./coinbaseAuth.ts";
import { binanceFetch } from "./binanceClient.ts";
import { cacheRawData } from "../shared/rawDataCache.ts";
import { curateRecords } from "../shared/curate.ts";

// Common fill fields across Binance / Coinbase — curated for the model.
const FILL_KEYS = [
  "id", "trade_id", "orderId", "order_id", "symbol", "product_id", "side",
  "price", "qty", "size", "quoteQty", "commission", "fee", "commissionAsset",
  "time", "trade_time", "created_time", "isBuyer", "isMaker",
];

export function createGetFillsTool(): RegisteredTool {
  return {
    name: "get_fills",
    description:
      "Fetch trade fills (executed trades) from a centralized exchange (Coinbase or Binance) and return structured data for report generation.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request describing what the user wants to know about their trade fills.",
        },
        exchange: {
          type: "string",
          description: "Exchange to query: 'coinbase' or 'binance'. Defaults to 'binance'.",
        },
        api_key: {
          type: "string",
          description: "API key for Binance.",
        },
        api_secret: {
          type: "string",
          description: "API secret for Binance, or EC private key PEM for Coinbase.",
        },
        api_key_name: {
          type: "string",
          description: "API key name (path) for Coinbase Advanced Trade.",
        },
        symbol: {
          type: "string",
          description: "Trading symbol to filter fills, e.g. 'BTC'. Required for Binance. Will be suffixed with 'USDT' for Binance.",
        },
        limit: {
          type: "number",
          description: "Maximum number of fills to return. Defaults to 50.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const exchange = typeof input["exchange"] === "string" ? input["exchange"] : "binance";
      const symbol = typeof input["symbol"] === "string" && input["symbol"].trim() ? input["symbol"].trim().toUpperCase() : undefined;
      const limit = typeof input["limit"] === "number" ? input["limit"] : 50;

      try {
        const creds = resolveCredentials(input);
        let fills: unknown;

        if (creds.exchange === "coinbase") {
          fills = await coinbaseFetch(creds, "GET", "/api/v3/brokerage/orders/historical/fills", {
            limit: String(limit),
          });
        } else {
          if (!symbol) {
            return {
              summary: `Fills fetch failed for ${exchange}: symbol is required for Binance fills. Please provide a symbol (e.g. BTC).`,
              generation_context: {
                prompt: `No fill data available from ${exchange}.`,
                data: { exchange, error: "symbol required for Binance fills" },
              },
            };
          }
          fills = await binanceFetch(creds, "GET", "/api/v3/myTrades", {
            symbol: symbol + "USDT",
            limit,
          });
        }

        const fillsArray = Array.isArray(fills)
          ? fills
          : (fills as { fills?: unknown[] })?.fills ?? [];

        const fillCount = fillsArray.length;

        // Persist the full raw fills array to the local cache; hand the model
        // only a curated, capped subset of fields.
        await cacheRawData("fills", `${exchange}_${symbol ?? "all"}`, fillsArray);
        const curatedFills = curateRecords(fillsArray, FILL_KEYS, limit);

        return {
          summary: `Fills from ${exchange}: ${fillCount} fills${symbol ? " for " + symbol : ""}.`,
          generation_context: {
            prompt: [
              "Use the following trade fill data to answer the user's question about executed trades.",
              "Summarize total bought/sold quantities, average fill prices, and total fees paid.",
              "Format fills as a table.",
              fillCount > curatedFills.length
                ? `(${fillCount} total fills; showing the ${curatedFills.length} most relevant.)`
                : "",
            ].filter(Boolean).join("\n"),
            data: {
              exchange,
              symbol: symbol ?? null,
              fillCount,
              fills: curatedFills,
            },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Fills fetch failed for ${exchange}: ${message}`,
          generation_context: {
            prompt: `No fill data available from ${exchange}.`,
            data: { exchange, error: message },
          },
        };
      }
    },
  };
}
