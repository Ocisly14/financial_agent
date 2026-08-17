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

test("strips JSON Schema fields the Generative Language API rejects", async () => {
  const originalFetch = globalThis.fetch;
  let request: JsonObject | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body)) as JsonObject;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await new GoogleProvider("test-key").generate([{ role: "user", content: "go" }], {
      modelClass: "MEDIUM",
      tools: [{
        name: "store_rows",
        description: "store rows",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            rows: {
              type: "array",
              items: { type: "object", additionalProperties: false, properties: { id: { type: "string" } } },
            },
          },
          required: ["rows"],
        },
      }],
    });

    const declarations = (request?.["tools"] as Array<JsonObject>)[0]!["functionDeclarations"] as Array<JsonObject>;
    assert.deepEqual(declarations[0]!["parameters"], {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
      },
      required: ["rows"],
    });
    assert.ok(!JSON.stringify(request).includes("additionalProperties"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns Gemini thought signatures and hands them back on the next turn", async () => {
  const originalFetch = globalThis.fetch;
  const requests: JsonObject[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as JsonObject);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { functionCall: { id: "call_1", name: "get_price", args: { ticker: "TSLA" } }, thoughtSignature: "sig-abc" },
      ] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = new GoogleProvider("test-key");
    const first = await provider.generate([{ role: "user", content: "price TSLA" }], { modelClass: "MEDIUM" });
    assert.deepEqual(first.toolCalls, [{ id: "call_1", name: "get_price", input: { ticker: "TSLA" }, signature: "sig-abc" }]);

    await provider.generate([
      { role: "user", content: "price TSLA" },
      { role: "assistant", content: "", toolCalls: first.toolCalls! },
      { role: "tool", content: '{"price":1}', toolCallId: "call_1", toolName: "get_price" },
    ], { modelClass: "MEDIUM" });

    const contents = requests[1]!["contents"] as Array<{ role: string; parts: JsonObject[] }>;
    assert.deepEqual(contents[1]!.parts, [{
      functionCall: { id: "call_1", name: "get_price", args: { ticker: "TSLA" } },
      thoughtSignature: "sig-abc",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries a transient 503 and gives up on a 400", async () => {
  const originalFetch = globalThis.fetch;
  process.env["GOOGLE_MAX_RETRIES"] = "4";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls <= 2) return new Response('{"error":{"code":503}}', { status: 503 });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "recovered" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await new GoogleProvider("test-key").generate([{ role: "user", content: "go" }], { modelClass: "MEDIUM" });
    assert.equal(result.text, "recovered");
    assert.equal(calls, 3);

    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{"error":{"code":400,"message":"bad schema"}}', { status: 400 });
    }) as typeof fetch;
    await assert.rejects(
      new GoogleProvider("test-key").generate([{ role: "user", content: "go" }], { modelClass: "MEDIUM" }),
      /Google API error 400/,
    );
    assert.equal(calls, 1, "a 400 fails identically however often it is sent — do not retry it");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports the implicit cache hit and bills tokens_in as the uncached remainder", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "ok" }] } }],
    usageMetadata: { promptTokenCount: 41_000, cachedContentTokenCount: 38_000, candidatesTokenCount: 500 },
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    const result = await new GoogleProvider("test-key").generate([{ role: "user", content: "go" }], { modelClass: "MEDIUM" });
    // Gemini counts the cached prefix inside promptTokenCount; reporting it whole would hide the hit.
    assert.equal(result.metrics.tokens_in, 3_000);
    assert.equal(result.metrics.cache_read, 38_000);
    assert.equal(result.metrics.cache_write, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("renames oneOf to anyOf, the only union keyword Gemini reads", async () => {
  const originalFetch = globalThis.fetch;
  let request: JsonObject | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body)) as JsonObject;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await new GoogleProvider("test-key").generate([{ role: "user", content: "go" }], {
      modelClass: "MEDIUM",
      tools: [{
        name: "apply_operations",
        description: "apply",
        inputSchema: {
          type: "object",
          properties: {
            operations: {
              type: "array",
              items: {
                type: "object",
                oneOf: [
                  { type: "object", properties: { kind: { type: "string", enum: ["set_formula"] },
                    formula: { type: "object", properties: { source: { type: "string", description: "the expression" } } } } },
                  { type: "object", properties: { kind: { type: "string", enum: ["set_assumption"] } } },
                ],
              },
            },
          },
        },
      }],
    });

    const declared = ((request?.["tools"] as Array<JsonObject>)[0]!["functionDeclarations"] as Array<JsonObject>)[0]!;
    const items = ((declared["parameters"] as JsonObject)["properties"] as JsonObject)["operations"] as JsonObject;
    const shape = items["items"] as JsonObject;
    // Gemini drops `oneOf` silently, taking every variant's fields and descriptions with it — the
    // model then sees "an object" and invents field names. `anyOf` is read; the unions here are
    // discriminated by a `kind` enum, so exactly one variant matches either way.
    assert.equal(shape["oneOf"], undefined, "oneOf must not survive — Gemini ignores it");
    assert.equal((shape["anyOf"] as Array<JsonObject>).length, 2);
    const variant = (shape["anyOf"] as Array<JsonObject>)[0]!;
    const formula = ((variant["properties"] as JsonObject)["formula"] as JsonObject);
    assert.equal((((formula["properties"] as JsonObject)["source"]) as JsonObject)["description"], "the expression",
      "and the field descriptions inside a variant must survive with it");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
