import type { JsonObject, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchLaunchpadTokens, fetchTokenMetrics, type LaunchpadToken } from "./hubbleClient.ts";
import { TOKEN_HOURLY_METRICS_PROMPT } from "./prompts.ts";

export function createTokenHourlyMetricsTool(): RegisteredTool {
  return {
    name: "token_hourly_metrics",
    description:
      "Fetch and analyze hourly trading metrics for a launchpad token, including buy/sell ratio, transaction count, holder growth, and price momentum.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "User request or task describing what hourly metrics analysis is needed.",
        },
        symbol: {
          type: "string",
          description: "Token symbol or name to look up if tokenAddress is not provided.",
        },
        tokenAddress: {
          type: "string",
          description: "On-chain token address for direct lookup.",
        },
      },
    },
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const tokenAddress = typeof input.tokenAddress === "string" && input.tokenAddress.trim().length > 0 ? input.tokenAddress.trim() : undefined;
      const symbol = typeof input.symbol === "string" && input.symbol.trim().length > 0 ? input.symbol.trim() : undefined;

      let token: LaunchpadToken | undefined;

      if (tokenAddress) {
        token = await fetchTokenMetrics(tokenAddress);
      } else {
        const results = await fetchLaunchpadTokens({ ...(symbol !== undefined ? { symbol } : {}), limit: 1 });
        token = results[0];
      }

      if (!token) {
        const identifier = tokenAddress ?? symbol ?? "unknown";
        return {
          summary: `No token found for identifier "${identifier}". Cannot compute hourly metrics.`,
        };
      }

      const buy1h = token.buy1h ?? 0;
      const sell1h = token.sell1h ?? 0;
      const total = buy1h + sell1h;
      const buySellRatio = total > 0 ? buy1h / total : null;

      const tokenData: JsonObject = {
        tokenAddress: token.tokenAddress,
        symbol: token.symbol,
        name: token.name,
        phase: token.phase,
        priceUsd: token.priceUsd ?? null,
        priceNative: token.priceNative ?? null,
        volume1h: token.volume1h ?? null,
        buy1h: token.buy1h ?? null,
        sell1h: token.sell1h ?? null,
        tx1h: token.tx1h ?? null,
        totalHolders: token.totalHolders ?? null,
        bondingCurveProgress: token.bondingCurveProgress ?? null,
        mktCapUsd: token.mktCapUsd ?? null,
        createdAt: token.createdAt ?? null,
        graduationAt: token.graduationAt ?? null,
        buySellRatio: buySellRatio as JsonValue,
      };

      const priceDisplay = token.priceUsd !== undefined ? token.priceUsd.toFixed(6) : "N/A";
      const vol1hDisplay = token.volume1h !== undefined ? token.volume1h.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "N/A";
      const ratioDisplay = buySellRatio !== null ? buySellRatio.toFixed(2) : "N/A";
      const holdersDisplay = token.totalHolders !== undefined ? String(token.totalHolders) : "N/A";

      return {
        summary: `Hourly metrics for ${token.symbol}: price=$${priceDisplay}, vol1h=${vol1hDisplay}, buy/sell ratio=${ratioDisplay}, holders=${holdersDisplay}.`,
        generation_context: {
          prompt: TOKEN_HOURLY_METRICS_PROMPT + "\n\nDATA:\n" + JSON.stringify(tokenData, null, 2),
          data: tokenData,
        },
      };
    },
  };
}
