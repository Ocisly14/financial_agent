import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearchTools } from "../financialSearchTool.ts";
import type { RegisteredTool, ToolExecutionContext } from "../../toolRegistry.ts";
import type { SearchOptions, SearchResult } from "../tavilyClient.ts";

const CONTEXT: ToolExecutionContext = { sessionId: "test", tenantId: "agent-1" };

function tools(search: (options: SearchOptions) => Promise<SearchResult[]>): { search: RegisteredTool; read: RegisteredTool } {
  const [financialSearch, readSearchResult] = createSearchTools(search);
  return { search: financialSearch!, read: readSearchResult! };
}

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "Rocket Lab Q2 2026 results",
    url: "https://example.com/rklb-q2",
    content: "Revenue rose 62%.",
    publishedDate: "2026-08-10",
    score: 0.9,
    ...overrides,
  };
}

test("requires an explicit query and does not call Tavily without one", async () => {
  let calls = 0;
  const { search } = tools(async () => {
    calls += 1;
    return [];
  });

  const result = await search.execute({ task: "find bank earnings" }, CONTEXT);

  assert.equal(calls, 0);
  assert.deepEqual(result.error, { code: "invalid_query", message: "query is required" });
});

test("passes the subagent query and parameters directly to Tavily", async () => {
  let received: SearchOptions | undefined;
  const { search } = tools(async (options) => {
    received = options;
    return [
      {
        title: "Federal Reserve press release",
        url: "https://www.federalreserve.gov/example",
        content: "The Federal Reserve announced its latest rate decision.",
        publishedDate: "2026-07-29",
        score: 0.97,
        images: ["https://www.federalreserve.gov/chart.png"],
      },
    ];
  });

  const result = await search.execute(
    {
      query: "  Federal Reserve July 2026 interest rate decision  ",
      topic: "news",
      limit: 8,
      search_depth: "advanced",
      task: "auto-supplied task must not shape the query",
    },
    CONTEXT,
  );

  assert.deepEqual(received, {
    query: "Federal Reserve July 2026 interest rate decision",
    topic: "news",
    limit: 8,
    searchDepth: "advanced",
  });
  assert.deepEqual(result.generation_context?.data.results, [
    {
      source_id: "s1",
      title: "Federal Reserve press release",
      url: "https://www.federalreserve.gov/example",
      content: "The Federal Reserve announced its latest rate decision.",
      score: 0.97,
      publishedDate: "2026-07-29",
      images: ["https://www.federalreserve.gov/chart.png"],
    },
  ]);
  assert.equal(result.generation_context?.prompt, undefined);
});

test("uses generic defaults and clamps the result limit", async () => {
  let received: SearchOptions | undefined;
  const { search } = tools(async (options) => {
    received = options;
    return [];
  });

  await search.execute({ query: "global bond market outlook", limit: 100 }, CONTEXT);

  assert.deepEqual(received, {
    query: "global bond market outlook",
    topic: "general",
    limit: 10,
    searchDepth: "basic",
  });
});

test("truncates long page text and flags what was cut", async () => {
  const long = "x".repeat(5000);
  const { search } = tools(async () => [hit({ content: long }), hit({ url: "https://example.com/short", content: "short" })]);

  const result = await search.execute({ query: "rklb q2 2026" }, CONTEXT);
  const results = result.generation_context?.data.results as Record<string, unknown>[];

  assert.equal((results[0]!.content as string).length, 1200);
  assert.equal(results[0]!.content_truncated, true);
  assert.equal(results[0]!.full_content_chars, 5000);
  assert.equal(results[1]!.content, "short");
  assert.equal(results[1]!.content_truncated, undefined);
  assert.equal(results[1]!.full_content_chars, undefined);
  assert.match(result.summary, /read_search_result/);
});

test("read_search_result returns the untruncated text the search withheld", async () => {
  const long = "y".repeat(4000);
  const { search, read } = tools(async () => [hit({ content: long })]);

  await search.execute({ query: "rklb q2 2026" }, CONTEXT);
  const result = await read.execute({ source_ids: ["s1"] }, CONTEXT);

  assert.deepEqual(result.generation_context?.data.sources, [
    {
      source_id: "s1",
      title: "Rocket Lab Q2 2026 results",
      url: "https://example.com/rklb-q2",
      content: long,
      publishedDate: "2026-08-10",
    },
  ]);
});

test("source ids keep counting across searches in the same run", async () => {
  const { search, read } = tools(async (options) => [hit({ content: `body for ${options.query}` })]);

  await search.execute({ query: "first" }, CONTEXT);
  await search.execute({ query: "second" }, CONTEXT);
  const result = await read.execute({ source_ids: ["s2"] }, CONTEXT);

  const sources = result.generation_context?.data.sources as Record<string, unknown>[];
  assert.equal(sources[0]!.content, "body for second");
});

test("one run cannot read another run's stored sources", async () => {
  const { search, read } = tools(async () => [hit()]);

  await search.execute({ query: "first" }, { ...CONTEXT, taskId: "task-a" });
  const result = await read.execute({ source_ids: ["s1"] }, { ...CONTEXT, taskId: "task-b" });

  assert.equal(result.error?.code, "no_search_results");
});

test("read_search_result caps one call and reports the rest for a follow-up", async () => {
  const { search, read } = tools(async () => [hit(), hit(), hit(), hit()]);

  await search.execute({ query: "rklb" }, CONTEXT);
  const result = await read.execute({ source_ids: ["s1", "s2", "s3", "s4"] }, CONTEXT);

  const data = result.generation_context?.data as Record<string, unknown>;
  assert.equal((data.sources as unknown[]).length, 3);
  assert.deepEqual(data.not_read, ["s4"]);
});

test("read_search_result reports every unknown id, not just the first", async () => {
  const { search, read } = tools(async () => [hit()]);

  await search.execute({ query: "rklb" }, CONTEXT);
  const result = await read.execute({ source_ids: ["s1", "s7", "s9"] }, CONTEXT);

  assert.deepEqual(result.generation_context?.data.unknown_source_ids, ["s7", "s9"]);
  assert.match(result.summary, /s7, s9/);
});

test("read_search_result rejects a call whose ids are all unknown", async () => {
  const { search, read } = tools(async () => [hit()]);

  await search.execute({ query: "rklb" }, CONTEXT);
  const result = await read.execute({ source_ids: ["s7"] }, CONTEXT);

  assert.equal(result.error?.code, "unknown_source_id");
  assert.equal(result.generation_context, undefined);
});

test("read_search_result requires a non-empty array of strings", async () => {
  const { read } = tools(async () => []);

  assert.equal((await read.execute({ source_ids: [] }, CONTEXT)).error?.code, "invalid_source_ids");
  assert.equal((await read.execute({ source_ids: "s1" }, CONTEXT)).error?.code, "invalid_source_ids");
  const malformed = await read.execute({ source_ids: ["s1", "", 3] }, CONTEXT);
  assert.equal(malformed.error?.code, "invalid_source_ids");
  assert.match(malformed.error!.message, /""/);
  assert.match(malformed.error!.message, /3/);
});
