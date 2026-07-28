import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";

function parseBaseAsset(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/-?(USDT|USDC|USD|BTC|ETH|BNB)$/, "")
    .trim();
}

export function createGetOrderbookTool(): RegisteredTool {
  return {
    name: "get_orderbook",
    description:
      "Fetch order book depth (top bids and asks) for a trading pair on Binance. Shows price levels and quantities. No authentication required.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task", "symbol"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request describing what the user wants to know about the order book.",
        },
        symbol: {
          type: "string",
          description: "Base asset symbol, e.g. 'BTC', 'ETH', or full pair 'BTC-USDT'.",
        },
        limit: {
          type: "number",
          description: "Number of price levels to return per side (1-20). Defaults to 5.",
        },
        venue: {
          type: "string",
          description: "Data source venue (currently 'binance' only).",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const rawSymbol = typeof input["symbol"] === "string" ? input["symbol"].trim() : "";
      if (!rawSymbol) {
        return {
          summary: "Order book fetch failed: symbol is required.",
          generation_context: {
            prompt: "No order book data available: symbol was not provided.",
            data: { error: "symbol required" },
          },
        };
      }

      const base = parseBaseAsset(rawSymbol);
      const rawLimit = typeof input["limit"] === "number" ? input["limit"] : 5;
      const limit = Math.max(1, Math.min(20, Math.round(rawLimit)));
      const binanceSymbol = base + "USDT";

      try {
        const res = await fetch(
          `https://api.binance.com/api/v3/depth?symbol=${binanceSymbol}&limit=${limit}`,
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Binance depth API error ${res.status}: ${text}`);
        }

        const data = (await res.json()) as {
          bids: [string, string][];
          asks: [string, string][];
          lastUpdateId: number;
        };

        const bids = data.bids.slice(0, limit);
        const asks = data.asks.slice(0, limit);
        const maxRows = Math.max(bids.length, asks.length);

        const headerLine = `### ${base}/USDT Order Book (top ${limit})`;
        const tableSep = "|" + "-".repeat(26) + "|" + "-".repeat(26) + "|";
        const tableHeader = "| BIDS (Price / Qty)        | ASKS (Price / Qty)        |";
        const rows: string[] = [];
        for (let i = 0; i < maxRows; i++) {
          const bid = bids[i];
          const ask = asks[i];
          const bidCell = bid ? `${bid[0]} / ${bid[1]}` : "";
          const askCell = ask ? `${ask[0]} / ${ask[1]}` : "";
          rows.push(`| ${bidCell.padEnd(25)}| ${askCell.padEnd(25)}|`);
        }

        const summary = [headerLine, tableHeader, tableSep, ...rows].join("\n");

        return {
          summary,
          generation_context: {
            prompt: [
              `Use the following order book data for ${base}/USDT to answer the user's question.`,
              "Present the top bid and ask levels. Note the best bid, best ask, and the spread.",
              "If there is a large imbalance between bid and ask depth, highlight it.",
            ].join("\n"),
            data: {
              symbol: base,
              binanceSymbol,
              limit,
              lastUpdateId: data.lastUpdateId,
              bids,
              asks,
            },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Order book fetch failed for ${base}: ${message}`,
          generation_context: {
            prompt: `No order book data available for ${base}. Error: ${message}`,
            data: { symbol: base, error: message },
          },
        };
      }
    },
  };
}
