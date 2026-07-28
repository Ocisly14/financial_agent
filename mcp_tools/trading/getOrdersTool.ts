import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { resolveCredentials } from "./resolveCredentials.ts";
import { coinbaseFetch } from "./coinbaseAuth.ts";
import { binanceFetch } from "./binanceClient.ts";
import { cacheRawData } from "../shared/rawDataCache.ts";
import { curateRecords } from "../shared/curate.ts";

// Common order fields across Binance / Coinbase — curated for the model.
const ORDER_KEYS = [
  "orderId", "order_id", "symbol", "product_id", "side", "type", "order_type",
  "origQty", "quantity", "base_size", "price", "limit_price", "status",
  "time", "updateTime", "created_time",
];

export function createGetOrdersTool(): RegisteredTool {
  return {
    name: "get_orders",
    description:
      "Fetch order history or open orders from a centralized exchange (Coinbase or Binance) and return structured data for report generation.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request describing what the user wants to know about their orders.",
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
          description: "Trading symbol to filter orders, e.g. 'BTC'. Will be suffixed with 'USDT' for Binance.",
        },
        order_status: {
          type: "string",
          description: "Order status filter for Coinbase: e.g. 'OPEN', 'FILLED', 'CANCELLED'. Defaults to 'OPEN'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of orders to return. Defaults to 50.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const exchange = typeof input["exchange"] === "string" ? input["exchange"] : "binance";
      const symbol = typeof input["symbol"] === "string" && input["symbol"].trim() ? input["symbol"].trim().toUpperCase() : undefined;
      const limit = typeof input["limit"] === "number" ? input["limit"] : 50;
      const orderStatus = typeof input["order_status"] === "string" ? input["order_status"] : undefined;

      try {
        const creds = resolveCredentials(input);
        let orders: unknown;

        if (creds.exchange === "coinbase") {
          const params: Record<string, string> = {
            order_status: orderStatus ?? "OPEN",
            limit: String(limit),
          };
          orders = await coinbaseFetch(creds, "GET", "/api/v3/brokerage/orders/historical/batch", params);
        } else {
          if (symbol) {
            orders = await binanceFetch(creds, "GET", "/api/v3/allOrders", {
              symbol: symbol + "USDT",
              limit,
            });
          } else {
            orders = await binanceFetch(creds, "GET", "/api/v3/openOrders");
          }
        }

        const ordersArray = Array.isArray(orders)
          ? orders
          : (orders as { orders?: unknown[] })?.orders ?? [];

        const orderCount = ordersArray.length;

        // Persist the full raw order array to the local cache; hand the model
        // only a curated, capped subset of fields.
        await cacheRawData("orders", `${exchange}_${symbol ?? "all"}`, ordersArray);
        const curatedOrders = curateRecords(ordersArray, ORDER_KEYS, limit);

        return {
          summary: `Orders from ${exchange}: ${orderCount} orders found${symbol ? " for " + symbol : ""}.`,
          generation_context: {
            prompt: [
              "Use the following order data to answer the user's order history/status question.",
              "Format orders as a table with columns: side, symbol, type, quantity, price, status, time.",
              "Highlight any open or recently filled orders.",
              orderCount > curatedOrders.length
                ? `(${orderCount} total orders; showing the ${curatedOrders.length} most relevant.)`
                : "",
            ].filter(Boolean).join("\n"),
            data: {
              exchange,
              symbol: symbol ?? null,
              orderCount,
              orders: curatedOrders,
            },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Orders fetch failed for ${exchange}: ${message}`,
          generation_context: {
            prompt: `No order data available from ${exchange}.`,
            data: { exchange, error: message },
          },
        };
      }
    },
  };
}
