import type { JsonObject, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import type { RegisteredTool } from "../toolRegistry.ts";
import { tavilySearch } from "../shared/tavilyClient.ts";
import { WEB_SEARCH_PROMPT_TEMPLATE } from "./prompts.ts";

export function createWebSearchTool(): RegisteredTool {
  return {
    name: "web_search",
    description:
      "Search the web for general or news information and return normalised source context with cited URLs.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language task or question to research.",
        },
        query: {
          type: "string",
          description: "Explicit search query. Falls back to task when omitted.",
        },
        topic: {
          type: "string",
          enum: ["general", "news"],
          description: "Search topic. Use 'news' for time-sensitive current events.",
        },
        limit: {
          type: "number",
          description: "Number of results to return (default 3, max 10). Increase only when the task needs broader coverage.",
        },
      },
    },
    execute: async (input: JsonObject): Promise<ToolExecutionResult> => {
      const task = String(input.task ?? "");
      const query = String(input.query ?? "") || task;
      const topic = (input.topic === "news" ? "news" : "general") as "general" | "news";
      const limit = Math.max(Math.min((input.limit as number) ?? 3, 10), 3);

      try {
        const results = await tavilySearch({ query, topic, limit, searchDepth: "basic" });

        const resultList = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.content.slice(0, 300)}${r.publishedDate ? `\n   Published: ${r.publishedDate}` : ""}`,
          )
          .join("\n");

        const prompt =
          results.length > 0
            ? `${WEB_SEARCH_PROMPT_TEMPLATE}\n\nSearch results:\n${resultList}`
            : `${WEB_SEARCH_PROMPT_TEMPLATE}\n\nSearch results: none returned.`;

        const allImages = results.flatMap((r) => r.images ?? []);
        const data: JsonObject = {
          query,
          topic,
          result_count: results.length,
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content.slice(0, 300),
            publishedDate: r.publishedDate ?? null,
          })) as unknown as JsonValue,
          ...(allImages.length > 0 && { images: allImages as unknown as JsonValue }),
        };

        return {
          summary: `Web search for '${query}' returned ${results.length} results.`,
          generation_context: { prompt, data },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summary: `Web search for '${query}' failed: ${message}`,
          generation_context: {
            prompt: WEB_SEARCH_PROMPT_TEMPLATE,
            data: { query, topic, result_count: 0, results: [], error: message },
          },
        };
      }
    },
  };
}
