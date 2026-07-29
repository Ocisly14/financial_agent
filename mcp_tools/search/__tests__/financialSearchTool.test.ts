import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinancialSearchTool } from "../financialSearchTool.ts";
import type { SearchOptions, SearchResult } from "../tavilyClient.ts";

test("requires an explicit query and does not call Tavily without one", async () => {
  let calls = 0;
  const tool = createFinancialSearchTool(async () => {
    calls += 1;
    return [];
  });

  const result = await tool.execute({ task: "find bank earnings" }, { sessionId: "test" });

  assert.equal(calls, 0);
  assert.deepEqual(result.error, { code: "invalid_query", message: "query is required" });
});

test("passes the subagent query and parameters directly to Tavily", async () => {
  let received: SearchOptions | undefined;
  const expected: SearchResult[] = [
    {
      title: "Federal Reserve press release",
      url: "https://www.federalreserve.gov/example",
      content: "The Federal Reserve announced its latest rate decision.",
      publishedDate: "2026-07-29",
      score: 0.97,
      images: ["https://www.federalreserve.gov/chart.png"],
    },
  ];
  const tool = createFinancialSearchTool(async (options) => {
    received = options;
    return expected;
  });

  const result = await tool.execute(
    {
      query: "  Federal Reserve July 2026 interest rate decision  ",
      topic: "news",
      limit: 8,
      search_depth: "advanced",
      task: "auto-supplied task must not shape the query",
    },
    { sessionId: "test" },
  );

  assert.deepEqual(received, {
    query: "Federal Reserve July 2026 interest rate decision",
    topic: "news",
    limit: 8,
    searchDepth: "advanced",
  });
  assert.deepEqual(result.generation_context?.data.results, expected);
  assert.equal(result.generation_context?.prompt, undefined);
});

test("uses generic defaults and clamps the result limit", async () => {
  let received: SearchOptions | undefined;
  const tool = createFinancialSearchTool(async (options) => {
    received = options;
    return [];
  });

  await tool.execute({ query: "global bond market outlook", limit: 100 }, { sessionId: "test" });

  assert.deepEqual(received, {
    query: "global bond market outlook",
    topic: "general",
    limit: 10,
    searchDepth: "basic",
  });
});
