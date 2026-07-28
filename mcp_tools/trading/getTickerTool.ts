import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";

function parseBaseAsset(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/-?(USDT|USDC|USD|BTC|ETH|BNB)$/, "")
    .trim();
}

export function createGetTickerTool(): RegisteredTool {
  return {
    name: "get_ticker",
    description:
      "Get current bid/ask price, mid-price, spread and 24h statistics for a cryptocurrency on Binance or Coinbase. No authentication required.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task", "symbol"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request describing what the user wants to know about the ticker.",
        },
        symbol: {
          type: "string",
          description: "Base asset or trading pair, e.g. 'BTC', 'ETH', 'BTC-USDT'.",
        },
        venue: {
          type: "string",
          description: "Data source: currently 'binance' (default). Coinbase public ticker not yet implemented.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const rawSymbol = typeof input["symbol"] === "string" ? input["symbol"].trim() : "";
      if (!rawSymbol) {
        return {
          summary: "Ticker failed: symbol is required.",
          generation_context: {
            prompt: "No ticker data available: symbol was not provided.",
            data: { error: "symbol required" },
          },
        };
      }

      const base = parseBaseAsset(rawSymbol);
      const binanceSymbol = base + "USDT";

      try {
        const [bookRes, statsRes] = await Promise.all([
          fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${binanceSymbol}`),
          fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`),
        ]);

        if (!bookRes.ok) {
          const text = await bookRes.text();
          throw new Error(`Binance bookTicker error ${bookRes.status}: ${text}`);
        }
        if (!statsRes.ok) {
          const text = await statsRes.text();
          throw new Error(`Binance 24hr ticker error ${statsRes.status}: ${text}`);
        }

        const book = (await bookRes.json()) as {
          bidPrice: string;
          askPrice: string;
          bidQty: string;
          askQty: string;
        };
        const stats = (await statsRes.json()) as {
          lastPrice: string;
          priceChangePercent: string;
          highPrice: string;
          lowPrice: string;
          volume: string;
          quoteVolume: string;
        };

        const bid = parseFloat(book.bidPrice);
        const ask = parseFloat(book.askPrice);
        const mid = (bid + ask) / 2;
        const spreadBps = bid > 0 ? ((ask - bid) / bid) * 10000 : 0;
        const change24h = parseFloat(stats.priceChangePercent);
        const high24h = parseFloat(stats.highPrice);
        const low24h = parseFloat(stats.lowPrice);
        const volume = parseFloat(stats.volume);
        const quoteVolume = parseFloat(stats.quoteVolume);

        const fmt = (n: number, decimals = 2) => n.toFixed(decimals);

        const summary = [
          `### ${base}/USDT`,
          `| Bid | Ask | Mid | Spread (bps) | 24h% | 24h High | 24h Low |`,
          `|-----|-----|-----|-------------|------|----------|---------|`,
          `| ${fmt(bid)} | ${fmt(ask)} | ${fmt(mid)} | ${fmt(spreadBps, 2)} | ${fmt(change24h, 2)}% | ${fmt(high24h)} | ${fmt(low24h)} |`,
        ].join("\n");

        return {
          summary,
          generation_context: {
            prompt: [
              `Use the following ticker data for ${base}/USDT to answer the user's question.`,
              "Present bid, ask, mid-price, spread in basis points, and 24h statistics.",
              "If the spread is unusually wide or the 24h change is large, note it explicitly.",
            ].join("\n"),
            data: {
              symbol: base,
              binanceSymbol,
              bid,
              ask,
              mid,
              spreadBps,
              change24h,
              high24h,
              low24h,
              volume,
              quoteVolume,
            },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Ticker fetch failed for ${base}: ${message}`,
          generation_context: {
            prompt: `No ticker data available for ${base}. Error: ${message}`,
            data: { symbol: base, error: message },
          },
        };
      }
    },
  };
}
