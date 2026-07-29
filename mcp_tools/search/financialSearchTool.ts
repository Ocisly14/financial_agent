import type { JsonObject, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { tavilySearch, type SearchOptions, type SearchResult } from "./tavilyClient.ts";

type SearchFn = (options: SearchOptions) => Promise<SearchResult[]>;

function requiredQuery(input: JsonObject): string {
  return typeof input.query === "string" ? input.query.trim() : "";
}

function boundedLimit(value: JsonValue | undefined): number {
  const limit = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 5;
  return Math.max(1, Math.min(limit, 10));
}

export function createFinancialSearchTool(search: SearchFn = tavilySearch): RegisteredTool {
  return {
    name: "financial_search",
    description:
      "Search the web with Tavily for financial information across equities, funds, fixed income, commodities, FX, digital assets, macroeconomics, companies, regulation, and financial news. The caller must provide the complete query.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Complete Tavily search query written by the subagent. It is sent unchanged apart from trimming surrounding whitespace.",
        },
        topic: {
          type: "string",
          enum: ["general", "news"],
          description: "Use news for recent events; otherwise use general. Defaults to general.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 5 and is clamped to 1-10.",
        },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "Tavily search depth. Defaults to basic.",
        },
      },
    },
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const query = requiredQuery(input);
      if (!query) {
        return {
          summary: "Financial search failed: query is required.",
          error: { code: "invalid_query", message: "query is required" },
        };
      }

      const topic = input.topic === "news" ? "news" : "general";
      const limit = boundedLimit(input.limit);
      const searchDepth = input.search_depth === "advanced" ? "advanced" : "basic";

      try {
        const results = await search({ query, topic, limit, searchDepth });
        const data: JsonObject = {
          query,
          topic,
          search_depth: searchDepth,
          result_count: results.length,
          results: results as unknown as JsonValue,
        };

        return {
          summary: `Financial search for '${query}' returned ${results.length} results.`,
          generation_context: { data },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          summary: `Financial search for '${query}' failed: ${message}`,
          error: { code: "search_failed", message },
        };
      }
    },
  };
}
