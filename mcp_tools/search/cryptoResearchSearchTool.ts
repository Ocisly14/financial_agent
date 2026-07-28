import type { JsonObject, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { tavilySearch } from "../shared/tavilyClient.ts";
import { CRYPTO_RESEARCH_PROMPT_TEMPLATE } from "./prompts.ts";

const KNOWN_SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA"] as const;

function detectSymbol(text: string): string {
  const upper = text.toUpperCase();
  for (const sym of KNOWN_SYMBOLS) {
    if (upper.includes(sym)) return sym;
  }
  return "";
}

export function createCryptoResearchSearchTool(): RegisteredTool {
  return {
    name: "crypto_research_search",
    description:
      "Search for cryptocurrency research, analysis, reports, studies, and market context from higher-quality sources.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language research task or question.",
        },
        query: {
          type: "string",
          description: "Explicit search query. Falls back to task when omitted.",
        },
        symbol: {
          type: "string",
          description:
            "Cryptocurrency ticker symbol (e.g. BTC, ETH). Auto-detected from task/query when omitted.",
        },
        limit: {
          type: "number",
          description: "Number of results to return (default 3, max 10). Increase only when the task needs broader coverage.",
        },
      },
    },
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const task = String(input.task ?? "");
      const baseQuery = String(input.query ?? "") || task;
      const limit = Math.min((input.limit as number) ?? 3, 10);

      const symbol =
        String(input.symbol ?? "") ||
        detectSymbol(String(input.symbol ?? "") + " " + baseQuery + " " + task);

      const focusedQuery = symbol
        ? `${symbol} crypto research: ${baseQuery}`
        : baseQuery;

      try {
        const results = await tavilySearch({
          query: focusedQuery,
          topic: "general",
          limit,
          searchDepth: "advanced",
        });

        const resultList = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.content.slice(0, 300)}${r.publishedDate ? `\n   Published: ${r.publishedDate}` : ""}`,
          )
          .join("\n");

        const prompt =
          results.length > 0
            ? `${CRYPTO_RESEARCH_PROMPT_TEMPLATE}\n\nSearch results:\n${resultList}`
            : `${CRYPTO_RESEARCH_PROMPT_TEMPLATE}\n\nSearch results: none returned.`;

        const data: JsonObject = {
          query: focusedQuery,
          symbol,
          result_count: results.length,
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content.slice(0, 300),
            publishedDate: r.publishedDate ?? null,
          })) as unknown as JsonValue,
        };

        return {
          summary: `Crypto research search returned ${results.length} results for query: ${focusedQuery}`,
          generation_context: { prompt, data },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Crypto research search failed: ${message}`,
          generation_context: {
            prompt: CRYPTO_RESEARCH_PROMPT_TEMPLATE,
            data: { query: focusedQuery, symbol, result_count: 0, results: [], error: message },
          },
        };
      }
    },
  };
}
