import type { JsonObject, JsonValue, ToolExecutionResult } from "../../src/framework/types.ts";
import { runKey, runStateStore, type RegisteredTool, type ToolExecutionContext } from "../toolRegistry.ts";
import { tavilySearch, type SearchOptions, type SearchResult } from "./tavilyClient.ts";

type SearchFn = (options: SearchOptions) => Promise<SearchResult[]>;

/**
 * How much of a result's page text rides along in the search payload.
 *
 * Every byte here is permanent: a tool's `generation_context.data` is what
 * `renderSubagentProgress` injects into [PROGRESS SO FAR], so a result read once
 * is re-sent on every remaining step of the run. Tavily's `advanced` depth
 * returns whole-page extracts — measured at ~1.8k tokens each, ten per call —
 * and a research round that runs five such calls spends more on re-reading its
 * own transcript than on anything else it does. The snippet is sized to settle
 * relevance ("is this the earnings story I want?"); the full text is kept out of
 * band and fetched by `read_search_result` only for the few results that earn it.
 */
const SNIPPET_CHARS = 1200;

/** Full documents are the expensive thing this split exists to ration, so a single call
 * cannot undo the saving by asking for a whole search page back at once. */
const MAX_READS_PER_CALL = 3;

type StoredSource = SearchResult & { sourceId: string };
type SearchRunState = { sources: StoredSource[]; next: number };

function requiredQuery(input: JsonObject): string {
  return typeof input.query === "string" ? input.query.trim() : "";
}

function boundedLimit(value: JsonValue | undefined): number {
  const limit = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 5;
  return Math.max(1, Math.min(limit, 10));
}

/** The search tools, sharing one per-run store: `financial_search` writes the full text it
 * withheld, `read_search_result` reads it back. They are created together because that store
 * is the contract between them. */
export function createSearchTools(search: SearchFn = tavilySearch): RegisteredTool[] {
  const runs = runStateStore<SearchRunState>();

  const financialSearch: RegisteredTool = {
    name: "financial_search",
    description:
      "Search the web with Tavily for financial information across equities, funds, fixed income, commodities, FX, digital assets, macroeconomics, companies, regulation, and financial news. The caller must provide the complete query. Each result carries a snippet of the page, not the whole page: a result whose text was cut is marked `content_truncated` and carries a `source_id` that `read_search_result` exchanges for the full document.",
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
          description: "Maximum number of results to return. Defaults to 5 and is clamped to 1-10. Every result stays in this run's context for the rest of the run, so ask for the number you will actually read.",
        },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "Tavily search depth. Defaults to basic. advanced retrieves fuller page text, which reaches you as the same snippet — it buys a better-sourced snippet and a fuller document behind read_search_result, not more text up front.",
        },
      },
    },
    execute: async (input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> => {
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
        const state = runs.get(runKey(context)) ?? { sources: [], next: 1 };
        let truncatedCount = 0;

        const rendered = results.map((result) => {
          const sourceId = `s${state.next}`;
          state.next += 1;
          state.sources.push({ ...result, sourceId });

          const content = result.content ?? "";
          const truncated = content.length > SNIPPET_CHARS;
          if (truncated) truncatedCount += 1;
          const item: JsonObject = {
            source_id: sourceId,
            title: result.title,
            url: result.url,
            content: truncated ? content.slice(0, SNIPPET_CHARS) : content,
            score: result.score,
          };
          if (result.publishedDate) item.publishedDate = result.publishedDate;
          if (truncated) {
            item.content_truncated = true;
            item.full_content_chars = content.length;
          }
          if (result.images) item.images = result.images as unknown as JsonValue;
          return item;
        });
        runs.set(runKey(context), state);

        const data: JsonObject = {
          query,
          topic,
          search_depth: searchDepth,
          result_count: results.length,
          results: rendered as unknown as JsonValue,
        };

        const note = truncatedCount > 0 ? ` ${truncatedCount} truncated; read in full with read_search_result.` : "";
        return {
          summary: `Financial search for '${query}' returned ${results.length} results.${note}`,
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

  const readSearchResult: RegisteredTool = {
    name: "read_search_result",
    description:
      "Read the full page text of results an earlier financial_search in this run returned truncated. Takes the `source_id` values from those results. A full document is many times the size of its snippet and stays in context for the rest of the run, so read only the results whose detail the answer actually turns on.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["source_ids"],
      properties: {
        source_ids: {
          type: "array",
          items: { type: "string" },
          description: `source_id values from a financial_search result in this run. At most ${MAX_READS_PER_CALL} are read per call; any beyond that come back under not_read for a follow-up call.`,
        },
      },
    },
    execute: async (input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> => {
      const raw = input.source_ids;
      if (!Array.isArray(raw) || raw.length === 0) {
        return {
          summary: "read_search_result failed: source_ids is required.",
          error: { code: "invalid_source_ids", message: "source_ids must be a non-empty array of source_id strings" },
        };
      }
      // Every fault, not the first: a rejected call costs the agent a step, so a caller that
      // passed one bad entry among good ones learns about all of them in one round trip.
      const malformed = raw.filter((id) => typeof id !== "string" || id.trim() === "");
      if (malformed.length > 0) {
        return {
          summary: "read_search_result failed: source_ids must all be non-empty strings.",
          error: {
            code: "invalid_source_ids",
            message: `not source_id strings: ${malformed.map((id) => JSON.stringify(id)).join(", ")}`,
          },
        };
      }
      const ids = (raw as string[]).map((id) => id.trim());

      const state = runs.get(runKey(context));
      if (!state) {
        return {
          summary: "read_search_result failed: no financial_search results in this run.",
          error: { code: "no_search_results", message: "call financial_search before reading a result in full" },
        };
      }

      const requested = ids.slice(0, MAX_READS_PER_CALL);
      const notRead = ids.slice(MAX_READS_PER_CALL);
      const found: JsonObject[] = [];
      const unknown: string[] = [];
      for (const id of requested) {
        const source = state.sources.find((candidate) => candidate.sourceId === id);
        if (!source) {
          unknown.push(id);
          continue;
        }
        const item: JsonObject = {
          source_id: source.sourceId,
          title: source.title,
          url: source.url,
          content: source.content ?? "",
        };
        if (source.publishedDate) item.publishedDate = source.publishedDate;
        found.push(item);
      }

      if (found.length === 0) {
        return {
          summary: `read_search_result failed: unknown source_id ${unknown.join(", ")}.`,
          error: {
            code: "unknown_source_id",
            message: `no search result in this run has source_id: ${unknown.join(", ")}`,
          },
        };
      }

      const data: JsonObject = { sources: found as unknown as JsonValue };
      if (unknown.length > 0) data.unknown_source_ids = unknown;
      if (notRead.length > 0) data.not_read = notRead;

      const chars = found.reduce((total, item) => total + String(item.content).length, 0);
      const skipped = notRead.length > 0 ? ` Not read this call: ${notRead.join(", ")}.` : "";
      const missing = unknown.length > 0 ? ` Unknown: ${unknown.join(", ")}.` : "";
      return {
        summary: `Read ${found.length} search result(s) in full (${chars} chars).${missing}${skipped}`,
        generation_context: { data },
      };
    },
  };

  return [financialSearch, readSearchResult];
}
