import { test } from "node:test";
import assert from "node:assert/strict";
import { toVertexMessages } from "../googleVertexProvider.ts";

test("keeps Vertex tool calls and results linked in the AI SDK transcript", () => {
  assert.deepEqual(toVertexMessages([
    { role: "user", content: "look up MSFT" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_price", input: { ticker: "MSFT" } }] },
    { role: "tool", content: '{"price":123}', toolCallId: "call_1", toolName: "get_price" },
  ]), [
    { role: "user", content: "look up MSFT" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "get_price", args: { ticker: "MSFT" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "get_price", result: { price: 123 } }] },
  ]);
});
