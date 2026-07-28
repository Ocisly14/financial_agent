import type { JsonObject, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { fetchLaunchpadTokens } from "./hubbleClient.ts";
import { cacheRawData } from "../shared/rawDataCache.ts";
import { TOKEN_METADATA_PROMPT } from "./prompts.ts";

export function createTokenMetadataOverviewTool(): RegisteredTool {
  return {
    name: "token_metadata_overview",
    description:
      "Fetch and analyze launchpad token metadata including price, market cap, bonding curve progress, and phase distribution from the Hubble Launchpad API.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "User request or task describing what token metadata analysis is needed.",
        },
        symbol: {
          type: "string",
          description: "Optional token symbol or name substring to filter results.",
        },
        phase: {
          type: "string",
          enum: ["new", "bonding", "graduated"],
          description: "Optional phase filter: new, bonding, or graduated.",
        },
        limit: {
          type: "number",
          description: "Maximum number of tokens to return (default 10, max 100).",
        },
      },
    },
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const phase = parsePhase(input.phase);
      const limit = Math.min(typeof input.limit === "number" ? Math.floor(input.limit) : 10, 100);
      const symbol = typeof input.symbol === "string" && input.symbol.trim().length > 0 ? input.symbol.trim() : undefined;

      const tokens = await fetchLaunchpadTokens({
        ...(symbol !== undefined ? { symbol } : {}),
        ...(phase !== undefined ? { phase } : {}),
        limit,
      });

      const newCount = tokens.filter((t) => t.phase === "new").length;
      const bondingCount = tokens.filter((t) => t.phase === "bonding").length;
      const gradCount = tokens.filter((t) => t.phase === "graduated").length;

      const topToken = tokens[0];
      const topSymbol = topToken?.symbol ?? "N/A";
      const topMcap =
        topToken?.mktCapUsd !== undefined
          ? topToken.mktCapUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })
          : "N/A";

      // Persist the full token list to the local cache; data hands the model a
      // capped, curated subset so a 100-token pull can't bloat the context.
      await cacheRawData("token_metadata", `${(input.phase as string | undefined) ?? "all"}_${symbol ?? "all"}`, tokens);

      // Display follows the agent's `limit` (the fetch already returned `limit`
      // tokens); the full list is in the cache.
      const curatedTokens = tokens.map((t) => ({
        symbol: t.symbol,
        name: t.name,
        phase: t.phase,
        priceUsd: t.priceUsd ?? null,
        mktCapUsd: t.mktCapUsd ?? null,
        bondingCurveProgress: t.bondingCurveProgress ?? null,
        createdAt: t.createdAt ?? null,
      }));

      const data: JsonObject = {
        tokenCount: tokens.length,
        phase: (input.phase as string | undefined) ?? "all",
        tokens: curatedTokens,
      };

      return {
        summary: `Launchpad overview: ${tokens.length} tokens. Phases: new=${newCount}, bonding=${bondingCount}, graduated=${gradCount}. Top MCap: ${topSymbol} ($${topMcap}).`,
        generation_context: {
          prompt: TOKEN_METADATA_PROMPT + "\n\nDATA:\n" + JSON.stringify(data, null, 2),
          data,
        },
      };
    },
  };
}

function parsePhase(value: unknown): "new" | "bonding" | "graduated" | undefined {
  if (value === "new" || value === "bonding" || value === "graduated") return value;
  return undefined;
}
