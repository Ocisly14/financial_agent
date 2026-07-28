import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { fetchPrice, fetchFearIndex } from "./cmcClient.ts";
import { buildCryptoPricePrompt } from "./prompts.ts";

const SYMBOL_PATTERN = /\b(BTC|ETH|SOL|XRP|DOGE|BNB|ADA|MATIC|LINK|AVAX|LTC|DOT)\b/i;

function detectSymbol(task: string): string {
  const m = task.match(SYMBOL_PATTERN);
  return m ? m[1]!.toUpperCase() : "BTC";
}

function fmtMcap(val: number | null): string {
  if (val === null) return "N/A";
  if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}T`;
  if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  return `$${val.toFixed(2)}`;
}

export function createGetCryptoPriceTool(): RegisteredTool {
  return {
    name: "get_crypto_price",
    description:
      "Fetch live cryptocurrency price and market data from CoinMarketCap and return structured market context for report generation.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language request. Symbol is detected automatically if not provided.",
        },
        symbol: {
          type: "string",
          description: "Crypto ticker, e.g. BTC, ETH. Detected from task if omitted.",
        },
        convert: {
          type: "string",
          description: "Quote currency, e.g. USD, EUR. Defaults to USD.",
        },
        includeFearIndex: {
          type: "boolean",
          description: "Whether to include the CoinMarketCap Fear & Greed Index.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const task = typeof input["task"] === "string" ? input["task"] : "";
      const symbol =
        typeof input["symbol"] === "string" && input["symbol"].trim()
          ? input["symbol"].trim().toUpperCase()
          : detectSymbol(task);
      const convert =
        typeof input["convert"] === "string" && input["convert"].trim()
          ? input["convert"].trim().toUpperCase()
          : "USD";
      const includeFearIndex = input["includeFearIndex"] === true;

      try {
        const priceData = await fetchPrice(symbol, convert);

        let fearValue: number | null = null;
        let fearLabel: string | null = null;

        if (includeFearIndex) {
          const fi = await fetchFearIndex();
          if (fi) {
            fearValue = fi.value;
            fearLabel = fi.label;
            priceData.fearIndex = fi.value;
            priceData.fearIndexLabel = fi.label;
            priceData.fearIndexUpdatedAt = fi.updatedAt;
          }
        }

        const promptLines = [buildCryptoPricePrompt(symbol, fearValue, fearLabel)];

        const data: JsonObject = {
          symbol: priceData.symbol,
          currency: convert,
          price: priceData.price,
          marketCap: priceData.marketCap,
          volume24h: priceData.volume24h,
          percentChange1h: priceData.percentChange1h,
          percentChange24h: priceData.percentChange24h,
          percentChange7d: priceData.percentChange7d,
          percentChange30d: priceData.percentChange30d,
          fullyDilutedMarketCap: priceData.fullyDilutedMarketCap,
          circulatingSupply: priceData.circulatingSupply,
          totalSupply: priceData.totalSupply,
          maxSupply: priceData.maxSupply,
          lastUpdated: priceData.lastUpdated,
          ...(priceData.fearIndex !== undefined ? { fearIndex: priceData.fearIndex } : {}),
          ...(priceData.fearIndexLabel !== undefined ? { fearIndexLabel: priceData.fearIndexLabel } : {}),
          ...(priceData.fearIndexUpdatedAt !== undefined ? { fearIndexUpdatedAt: priceData.fearIndexUpdatedAt } : {}),
        };

        const pct24h = priceData.percentChange24h;
        const pctStr = pct24h !== null ? `${pct24h >= 0 ? "+" : ""}${pct24h.toFixed(2)}%` : "N/A";
        const mcapStr = fmtMcap(priceData.marketCap);

        return {
          summary: `${symbol} price: $${priceData.price} ${convert} | 24h: ${pctStr} | MCap: ${mcapStr}`,
          generation_context: {
            prompt: promptLines[0]!,
            data,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Price fetch failed for ${symbol}: ${message}`,
          generation_context: {
            prompt: `No market data available for ${symbol}.`,
            data: { symbol, currency: convert, error: message },
          },
        };
      }
    },
  };
}
