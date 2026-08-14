import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../anthropicProvider.ts";
import { llmCostReport, ModelRouter, resetLlmCostReport } from "../provider.ts";
import type { GenerateResult } from "../provider.ts";

/** Builds an SSE Response body from the events an Anthropic stream would emit. */
function sseResponse(events: { type: string; [key: string]: unknown }[]): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Swaps in a fetch that replies with `response`, restoring the real one afterwards. */
async function withStubbedFetch(response: () => Response, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response()) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** A minimal stream carrying one text block plus whatever usage the test wants to report. */
function textStream(usage: Record<string, number>): { type: string; [key: string]: unknown }[] {
  return [
    { type: "message_start", message: { usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
  ];
}

test("reports the cache read and write token counts alongside the uncached input", async () => {
  await withStubbedFetch(
    () => sseResponse(textStream({
      input_tokens: 42,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 36000,
    })),
    async () => {
      const provider = new AnthropicProvider("sk-test");
      const result = await provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });

      assert.equal(result.metrics.tokens_in, 42);
      assert.equal(result.metrics.tokens_out, 7);
      assert.equal(result.metrics.cache_write, 1200);
      assert.equal(result.metrics.cache_read, 36000);
    },
  );
});

test("reports zero cache tokens when the response carries no cache fields at all", async () => {
  await withStubbedFetch(
    () => sseResponse(textStream({ input_tokens: 42 })),
    async () => {
      const provider = new AnthropicProvider("sk-test");
      const result = await provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });

      // Absent fields mean "nothing cached", not "unknown" — a caller reading 0 is reading the truth.
      assert.equal(result.metrics.cache_write, 0);
      assert.equal(result.metrics.cache_read, 0);
    },
  );
});

/**
 * The cost table exists because `tokens_in` alone is misleading under prompt caching: a cache WRITE
 * is billed above full price, so moving tokens out of `tokens_in` and into `cache_write` can cost
 * more while looking like a large saving. The weighted total is what an optimization is judged on.
 */
test("the cost report weights cache reads and writes rather than counting raw prompt tokens", async () => {
  resetLlmCostReport();
  const router = new ModelRouter({
    name: "stub",
    async generate(): Promise<GenerateResult> {
      return { text: "ok", metrics: { tokens_in: 1000, cache_read: 40_000, cache_write: 8_000,
        tokens_out: 500, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  });

  await router.generate([{ role: "user", content: "hi" }],
    { modelClass: "MEDIUM", metadata: { mode: "subagent", agent: "statement_unification" } });

  const row = llmCostReport()["subagent:statement_unification"]!;
  assert.equal(row.calls, 1);
  // 1000 + 40000*0.1 + 8000*1.25 = 15,000 — well above the 1,000 that tokens_in alone reports.
  assert.equal(row.equivalent_input_tokens, 15_000);
  assert.equal(row.cache_read_write_ratio, 5);
});

test("a run that only ever writes its cache is reported as a ratio below one", async () => {
  resetLlmCostReport();
  const router = new ModelRouter({
    name: "stub",
    async generate(): Promise<GenerateResult> {
      // The shape of the defect this table is meant to surface: tiny tokens_in, huge cache_write,
      // nothing read back.
      return { text: "ok", metrics: { tokens_in: 109, cache_read: 8_611, cache_write: 38_964,
        tokens_out: 100, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  });

  await router.generate([{ role: "user", content: "hi" }],
    { modelClass: "MEDIUM", metadata: { mode: "subagent", agent: "statement_unification" } });

  const row = llmCostReport()["subagent:statement_unification"]!;
  assert.ok(row.cache_read_write_ratio! < 1, "writes exceed reads — the entries are never read back");
  assert.ok(row.equivalent_input_tokens > 48_000,
    `equivalent cost ${row.equivalent_input_tokens} must expose what tokens_in=109 hides`);
});
