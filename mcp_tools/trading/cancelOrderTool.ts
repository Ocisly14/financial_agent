import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import { binanceFetch } from "./binanceClient.ts";
import { coinbaseFetch } from "./coinbaseAuth.ts";
import { resolveCredentials } from "./resolveCredentials.ts";

export function createCancelOrderTool(): RegisteredTool {
  return {
    name: "cancel_order",
    description:
      "Cancel one or more open orders on Binance or Coinbase. Provide order_ids array, or set all_open=true with symbol to cancel all open orders on a symbol.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language description of the cancellation request.",
        },
        exchange: {
          type: "string",
          description: "Exchange to cancel orders on: 'binance' or 'coinbase'. Defaults to 'binance'.",
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
          description: "Base asset symbol, e.g. 'BTC'. Required when all_open=true; also used to scope per-order cancels on Binance.",
        },
        order_ids: {
          type: "array",
          items: { type: "string" },
          description: "List of order IDs to cancel. Required if all_open is false.",
        },
        all_open: {
          type: "boolean",
          description: "If true, cancel all open orders on the given symbol (Binance only). Requires symbol.",
        },
      },
    },
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const symbol = str(input["symbol"]).toUpperCase();
      const allOpen = input["all_open"] === true;
      const orderIdsRaw = Array.isArray(input["order_ids"]) ? (input["order_ids"] as unknown[]) : [];
      const orderIds = orderIdsRaw.map((id) => String(id)).filter(Boolean);

      if (!allOpen && orderIds.length === 0) {
        return {
          summary: "Cancel failed: provide order_ids or set all_open=true with a symbol.",
          generation_context: {
            prompt: "Order cancellation could not proceed: no order IDs provided and all_open was not set.",
            data: { error: "missing order_ids or all_open" },
          },
        };
      }

      try {
        const creds = resolveCredentials(input);

        // ── Binance: cancel all open orders on symbol ──────────────────────
        if (creds.exchange === "binance" && allOpen) {
          if (!symbol) {
            return {
              summary: "Cancel failed: symbol is required when all_open=true.",
              generation_context: {
                prompt: "Order cancellation failed: symbol missing.",
                data: { error: "symbol required for all_open" },
              },
            };
          }
          const result = await binanceFetch(creds, "DELETE", "/api/v3/openOrders", {
            symbol: symbol + "USDT",
          });
          const cancelled = Array.isArray(result) ? result.length : 1;
          return {
            summary: `Cancelled all open orders on ${symbol} (${cancelled} order(s)) on Binance.`,
            generation_context: {
              prompt: [
                "All open orders for the symbol have been cancelled on Binance.",
                "Report the number of cancelled orders and the symbol to the user.",
              ].join("\n"),
              data: { exchange: "binance", symbol, cancelled, failed: 0, results: result as JsonValue },
            },
          };
        }

        // ── Binance: cancel specific order IDs ────────────────────────────
        if (creds.exchange === "binance") {
          if (!symbol) {
            return {
              summary: "Cancel failed: symbol is required for Binance order cancellation.",
              generation_context: {
                prompt: "Order cancellation failed: symbol missing.",
                data: { error: "symbol required for Binance" },
              },
            };
          }
          const settled = await Promise.allSettled(
            orderIds.map((orderId) =>
              binanceFetch(creds, "DELETE", "/api/v3/order", {
                symbol: symbol + "USDT",
                orderId,
              }),
            ),
          );
          const cancelled = settled.filter((r) => r.status === "fulfilled").length;
          const failed = settled.filter((r) => r.status === "rejected").length;
          const results: JsonValue = settled.map((r, i) => {
            if (r.status === "fulfilled") {
              return { orderId: orderIds[i] ?? "", status: "cancelled" };
            }
            const reason = (r as PromiseRejectedResult).reason;
            return {
              orderId: orderIds[i] ?? "",
              status: "failed",
              reason: reason instanceof Error ? reason.message : String(reason),
            };
          });
          const failedNote = failed > 0 ? ` Failed: ${failed}.` : "";
          return {
            summary: `Cancelled ${cancelled} order(s) on ${symbol}.${failedNote}`,
            generation_context: {
              prompt: [
                "Report the cancellation results to the user.",
                "List which orders were cancelled and which (if any) failed.",
              ].join("\n"),
              data: { exchange: "binance", symbol, cancelled, failed, results },
            },
          };
        }

        // ── Coinbase: cancel specific order IDs ───────────────────────────
        const settled = await Promise.allSettled(
          orderIds.map((orderId) =>
            coinbaseFetch(creds, "DELETE", `/api/v3/brokerage/orders/${orderId}`),
          ),
        );
        const cancelled = settled.filter((r) => r.status === "fulfilled").length;
        const failed = settled.filter((r) => r.status === "rejected").length;
        const results: JsonValue = settled.map((r, i) => {
          if (r.status === "fulfilled") {
            return { orderId: orderIds[i] ?? "", status: "cancelled" };
          }
          const reason = (r as PromiseRejectedResult).reason;
          return {
            orderId: orderIds[i] ?? "",
            status: "failed",
            reason: reason instanceof Error ? reason.message : String(reason),
          };
        });
        const failedNote = failed > 0 ? ` Failed: ${failed}.` : "";
        return {
          summary: `Cancelled ${cancelled} order(s) on ${symbol || "Coinbase"}.${failedNote}`,
          generation_context: {
            prompt: [
              "Report the cancellation results to the user.",
              "List which orders were cancelled and which (if any) failed.",
            ].join("\n"),
            data: { exchange: "coinbase", symbol: symbol || null, cancelled, failed, results },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const exchange = typeof input["exchange"] === "string" ? input["exchange"] : "binance";
        return {
          summary: `Order cancellation failed on ${exchange}: ${message}`,
          generation_context: {
            prompt: `Order cancellation failed. Error: ${message}`,
            data: { exchange, error: message },
          },
        };
      }
    },
  };
}
