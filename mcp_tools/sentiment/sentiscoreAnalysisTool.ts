import type { JsonObject, JsonSchema, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { dateRange } from "../shared/dateUtils.ts";
import { cacheRawData } from "../shared/rawDataCache.ts";
import { fetchSentiScore } from "./sentiscoreClient.ts";
import { buildSentiscorePrompt } from "./prompts.ts";

function detectSymbol(task: string): string {
  const mappings: Array<[RegExp, string]> = [
    [/\b(bitcoin|btc)\b/i, "BTC"],
    [/\b(ethereum|eth)\b/i, "ETH"],
    [/\b(solana|sol)\b/i, "SOL"],
    [/\b(dogecoin|doge)\b/i, "DOGE"],
    [/\b(ripple|xrp)\b/i, "XRP"],
    [/\b(cardano|ada)\b/i, "ADA"],
    [/\b(binancecoin|bnb)\b/i, "BNB"],
    [/\b(polygon|matic)\b/i, "MATIC"],
    [/\b(chainlink|link)\b/i, "LINK"],
    [/\b(avalanche|avax)\b/i, "AVAX"],
    [/\b(litecoin|ltc)\b/i, "LTC"],
    [/\b(polkadot|dot)\b/i, "DOT"],
  ];
  for (const [pattern, symbol] of mappings) {
    if (pattern.test(task)) return symbol;
  }
  // Try uppercase token match (e.g. "BTC sentiment")
  const tokenMatch = task.match(/\b([A-Z]{2,6})\b/);
  if (tokenMatch) return tokenMatch[1]!;
  return "BTC";
}

function readString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function sentiscoreInputSchema(): JsonSchema {
  return {
    type: "object",
    required: ["task"],
    properties: {
      task: {
        type: "string",
        description: "Natural-language request for sentiscore sentiment analysis.",
      },
      symbol: {
        type: "string",
        description: "Cryptocurrency ticker symbol, e.g. BTC or ETH. Detected from task if not provided.",
      },
      from: {
        type: "string",
        description: "Optional start date in YYYY-MM-DD format.",
      },
      to: {
        type: "string",
        description: "Optional end date in YYYY-MM-DD format.",
      },
      locale: {
        type: "string",
        description: "Optional locale for output formatting, e.g. en-US.",
      },
    },
  };
}

export function createSentiscoreAnalysisTool(): RegisteredTool {
  return {
    name: "sentiscore_analysis",
    description:
      "Fetch and analyze multi-source sentiment scores from S3 for a given crypto asset, returning a structured analysis framework.",
    category: "non_trading",
    inputSchema: sentiscoreInputSchema(),
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const task   = readString(input.task);
      const symbol = (readString(input.symbol) || detectSymbol(task)).toUpperCase() || "BTC";
      const { from, to } = dateRange(
        readString(input.from) || undefined,
        readString(input.to) || undefined,
        30,
      );

      try {
        const result = await fetchSentiScore(symbol, from, to);
        const h24  = result.horizons.h24;
        const h7d  = result.horizons.h7d;
        const h30d = result.horizons.h30d;
        const feat = result.features;

        const prompt = buildSentiscorePrompt(symbol, from, to, result);

        const summary =
          `Sentiscore analysis for ${symbol}: 24h=${h24.value.toFixed(3)}, ` +
          `7d=${h7d.value.toFixed(3)}, 30d=${h30d.value.toFixed(3)}. ` +
          `Sources: ${Object.keys(result.perSource).length}. ` +
          `Excluded: ${feat.excludedSources.length}.`;

        // Persist the full result (incl. the raw timeSeries) to the local cache;
        // generation_context.data carries only the curated aggregates the prompt
        // references — never the point-by-point series.
        await cacheRawData("sentiscore", `${symbol}_${from}_${to}`, result);

        const data: JsonObject = {
          symbol: result.symbol,
          fromDate: result.fromDate,
          toDate: result.toDate,
          horizons: result.horizons as unknown as JsonObject,
          perSource: result.perSource as unknown as JsonObject,
          features: result.features as unknown as JsonObject,
        };

        return {
          summary,
          generation_context: {
            prompt,
            data,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          summary: `Sentiscore analysis failed for ${symbol} (${from} to ${to}): ${message}`,
          generation_context: {
            prompt: `Sentiscore data could not be retrieved for ${symbol} (${from} to ${to}). Error: ${message}. Do not fabricate sentiment values.`,
            data: {
              symbol,
              fromDate: from,
              toDate: to,
              error: message,
              status: "failed",
            },
          },
        };
      }
    },
  };
}
