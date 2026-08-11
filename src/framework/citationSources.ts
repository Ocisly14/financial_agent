import type { SessionEvent } from "./sessionState.ts";

/**
 * A retrieved web source, carried to the client so an inline citation can show
 * the page's title, snippet, and date without re-fetching anything.
 *
 * Search hits live on the subagents' sidechain tool_result events — the
 * orchestrator's answer only refers to them by number, so both projections (the
 * live SSE `final` frame and the replayed chat history) collect them here.
 */
export type CitationSource = {
  url: string;
  title: string;
  snippet?: string;
  publishedDate?: string;
};

const MAX_SNIPPET_CHARS = 500;

export function collectTurnSources(events: readonly SessionEvent[], turn: number): CitationSource[] {
  const byUrl = new Map<string, CitationSource>();
  for (const event of events) {
    if (event.turn !== turn || event.kind !== "tool_result" || event.payload.error) continue;
    const context = event.payload.generation_context as { data?: { results?: unknown } } | undefined;
    const results = context?.data?.results;
    if (!Array.isArray(results)) continue;
    for (const candidate of results) {
      const result = candidate as Record<string, unknown>;
      if (typeof result.url !== "string" || typeof result.title !== "string") continue;
      if (byUrl.has(result.url)) continue;
      const source: CitationSource = { url: result.url, title: result.title };
      if (typeof result.content === "string" && result.content.length > 0) {
        source.snippet = result.content.slice(0, MAX_SNIPPET_CHARS);
      }
      if (typeof result.publishedDate === "string") source.publishedDate = result.publishedDate;
      byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}
