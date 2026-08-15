import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleProvider } from "../googleProvider.ts";
import type { JsonObject } from "../../../framework/types.ts";

test("keeps Gemini function calls and results associated by id", async () => {
  const originalFetch = globalThis.fetch;
  let request: JsonObject | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body)) as JsonObject;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { id: "call_2", name: "next_tool", args: {} } }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await new GoogleProvider("test-key").generate([
      { role: "user", content: "look up MSFT" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_price", input: { ticker: "MSFT" } }] },
      { role: "tool", content: '{"price":123}', toolCallId: "call_1", toolName: "get_price" },
    ], { modelClass: "MEDIUM" });

    assert.deepEqual(request?.["contents"], [
      { role: "user", parts: [{ text: "look up MSFT" }] },
      { role: "model", parts: [{ functionCall: { id: "call_1", name: "get_price", args: { ticker: "MSFT" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "call_1", name: "get_price", response: { price: 123 } } }] },
    ]);
    assert.deepEqual(result.toolCalls, [{ id: "call_2", name: "next_tool", input: {} }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
