import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSeekProvider } from "../deepseekProvider.ts";
import { MalformedResponseError } from "../provider.ts";
import type { JsonObject } from "../../../framework/types.ts";

/** Builds an SSE Response body from the chunk objects a DeepSeek stream would emit. */
function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

type Captured = { url: string; init: RequestInit; body: JsonObject };

/**
 * Runs `body` with `names` cleared from the environment, restoring them afterwards.
 *
 * The suite runs under `--env-file=.env`, so any variable the provider reads is whatever the
 * developer happens to have configured. A test asserting a built-in default has to own that
 * variable for its duration, or it is really asserting the contents of someone's .env — and it
 * fails on their machine and passes on a bare CI runner for reasons that have nothing to do
 * with the code.
 */
async function withoutEnv(names: readonly string[], body: () => Promise<void>): Promise<void> {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const withoutModelOverrides = (body: () => Promise<void>): Promise<void> =>
  withoutEnv(["DEEPSEEK_MODEL_SMALL", "DEEPSEEK_MODEL_MEDIUM", "DEEPSEEK_MODEL_LARGE"], body);

/** Swaps in a fetch that records the request and replies with `response`. */
async function withStubbedFetch(
  response: Response | (() => Response),
  run: (captured: Captured[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const captured: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) as JsonObject });
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  try {
    await run(captured);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("posts an OpenAI-shaped chat completion request to the DeepSeek endpoint", async () => {
  await withoutModelOverrides(async () => {
    await withStubbedFetch(
      () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      async (captured) => {
        const provider = new DeepSeekProvider("sk-test");
        await provider.generate(
          [
            { role: "system", content: "You are a financial analyst." },
            { role: "user", content: "What is FCF?" },
          ],
          { modelClass: "MEDIUM" },
        );

        const request = captured[0]!;
        assert.equal(request.url, "https://api.deepseek.com/chat/completions");
        assert.equal((request.init.headers as Record<string, string>)["Authorization"], "Bearer sk-test");
        assert.equal(request.body["model"], "deepseek-v4-flash");
        assert.equal(request.body["stream"], true);
        assert.deepEqual(request.body["stream_options"], { include_usage: true });
        assert.deepEqual(request.body["messages"], [
          { role: "system", content: "You are a financial analyst." },
          { role: "user", content: "What is FCF?" },
        ]);
      },
    );
  });
});

test("maps every model class to deepseek-v4-flash", async () => {
  await withoutModelOverrides(async () => {
    await withStubbedFetch(
      () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      async (captured) => {
        const provider = new DeepSeekProvider("sk-test");
        for (const modelClass of ["SMALL", "MEDIUM", "LARGE"] as const) {
          await provider.generate([{ role: "user", content: "hi" }], { modelClass });
        }
        assert.deepEqual(
          captured.map((request) => request.body["model"]),
          ["deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-flash"],
        );
      },
    );
  });
});

test("omits the thinking field so DeepSeek's own default applies", async () => {
  await withStubbedFetch(
    () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
    async (captured) => {
      const provider = new DeepSeekProvider("sk-test");
      await provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
      assert.ok(!("thinking" in captured[0]!.body));
    },
  );
});

test("turns thinking off when DEEPSEEK_THINKING says disabled", async () => {
  const original = process.env["DEEPSEEK_THINKING"];
  process.env["DEEPSEEK_THINKING"] = "disabled";
  try {
    await withStubbedFetch(
      () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      async (captured) => {
        const provider = new DeepSeekProvider("sk-test");
        await provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
        assert.deepEqual(captured[0]!.body["thinking"], { type: "disabled" });
      },
    );
  } finally {
    if (original === undefined) delete process.env["DEEPSEEK_THINKING"];
    else process.env["DEEPSEEK_THINKING"] = original;
  }
});

test("passes reasoning_effort through when set, and omits it otherwise", async () => {
  await withoutEnv(["DEEPSEEK_REASONING_EFFORT"], async () => {
    await withStubbedFetch(
      () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      async (captured) => {
        await new DeepSeekProvider("sk-test").generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
        assert.ok(!("reasoning_effort" in captured[0]!.body));

        process.env["DEEPSEEK_REASONING_EFFORT"] = "medium";
        await new DeepSeekProvider("sk-test").generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
        assert.equal(captured[1]!.body["reasoning_effort"], "medium");
      },
    );
  });
});

test("budgets max_tokens for thinking plus the reply, overridable by env", async () => {
  await withoutEnv(["DEEPSEEK_MAX_TOKENS"], async () => {
    await withStubbedFetch(
      () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
      async (captured) => {
        await new DeepSeekProvider("sk-test").generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
        assert.equal(captured[0]!.body["max_tokens"], 64_000);

        process.env["DEEPSEEK_MAX_TOKENS"] = "1234";
        await new DeepSeekProvider("sk-test").generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
        assert.equal(captured[1]!.body["max_tokens"], 1234);
      },
    );
  });
});

test("keeps reasoning_content out of the reply text and the token stream", async () => {
  await withStubbedFetch(
    () => sseResponse([
      { choices: [{ delta: { role: "assistant", content: null, reasoning_content: "" } }] },
      { choices: [{ delta: { content: null, reasoning_content: "We need to define FCF." } }] },
      { choices: [{ delta: { content: "Free cash flow." }, finish_reason: "stop" }] },
    ]),
    async () => {
      const provider = new DeepSeekProvider("sk-test");
      const tokens: string[] = [];
      const result = await provider.generate([{ role: "user", content: "hi" }], {
        modelClass: "MEDIUM",
        onToken: (delta) => tokens.push(delta),
      });

      assert.equal(result.text, "Free cash flow.");
      assert.deepEqual(tokens, ["Free cash flow."]);
    },
  );
});

test("preserves assistant tool calls and their results as native OpenAI messages", async () => {
  await withStubbedFetch(
    () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
    async (captured) => {
      const provider = new DeepSeekProvider("sk-test");
      await provider.generate(
        [
          { role: "user", content: "run it" },
          { role: "assistant", content: "calling tool", toolCalls: [{ id: "call_1", name: "get_price", input: { ticker: "MSFT" } }] },
          { role: "tool", content: "tool output", toolCallId: "call_1", toolName: "get_price" },
        ],
        { modelClass: "MEDIUM" },
      );

      assert.deepEqual(captured[0]!.body["messages"], [
        { role: "user", content: "run it" },
        { role: "assistant", content: "calling tool", tool_calls: [{
          id: "call_1", type: "function", function: { name: "get_price", arguments: "{\"ticker\":\"MSFT\"}" },
        }] },
        { role: "tool", tool_call_id: "call_1", content: "tool output" },
      ]);
    },
  );
});

test("declares tools in OpenAI function format with tool_choice auto", async () => {
  await withStubbedFetch(
    () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
    async (captured) => {
      const provider = new DeepSeekProvider("sk-test");
      await provider.generate([{ role: "user", content: "hi" }], {
        modelClass: "MEDIUM",
        tools: [{
          name: "get_price",
          description: "Fetch a price",
          inputSchema: { type: "object", properties: { ticker: { type: "string" } } },
        }],
      });

      const request = captured[0]!;
      assert.deepEqual(request.body["tools"], [{
        type: "function",
        function: {
          name: "get_price",
          description: "Fetch a price",
          parameters: { type: "object", properties: { ticker: { type: "string" } } },
        },
      }]);
      assert.equal(request.body["tool_choice"], "auto");
    },
  );
});

test("omits the tools field entirely when the caller declares none", async () => {
  await withStubbedFetch(
    () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
    async (captured) => {
      const provider = new DeepSeekProvider("sk-test");
      await provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
      assert.ok(!("tools" in captured[0]!.body));
      assert.ok(!("tool_choice" in captured[0]!.body));
    },
  );
});

/**
 * DeepSeek caches server-side and splits its prompt tokens into hit and miss. Reading only
 * `prompt_tokens` left the cost table's cache columns at 0 for every run on this provider — which
 * reads as "nothing was cached" when it actually means "nobody asked". `cache_read_write_ratio`, the
 * health signal CLAUDE.md leans on, was therefore null on every DeepSeek run: the guard was off.
 */
test("splits DeepSeek's prompt tokens into the uncached remainder and the cache read", async () => {
  await withStubbedFetch(
    () => sseResponse([
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 40_000, completion_tokens: 120,
        prompt_cache_hit_tokens: 36_000, prompt_cache_miss_tokens: 4_000 } },
    ]),
    async () => {
      const result = await new DeepSeekProvider("sk-test")
        .generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
      assert.equal(result.metrics.tokens_in, 4_000, "tokens_in is the uncached remainder, not the whole prompt");
      assert.equal(result.metrics.cache_read, 36_000);
      assert.equal(result.metrics.cache_write, undefined,
        "DeepSeek has no write tier to report; absent says so, 0 would claim nothing was cached");
    },
  );
});

test("a usage frame without the cache fields reports the prompt whole, and claims no caching either way", async () => {
  await withStubbedFetch(
    () => sseResponse([
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 40_000, completion_tokens: 120 } },
    ]),
    async () => {
      const result = await new DeepSeekProvider("sk-test")
        .generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
      assert.equal(result.metrics.tokens_in, 40_000);
      assert.equal(result.metrics.cache_read, undefined);
    },
  );
});

test("accumulates streamed text deltas and reports them to onToken", async () => {
  await withStubbedFetch(
    () => sseResponse([
      { choices: [{ delta: { content: "Free " } }] },
      { choices: [{ delta: { content: "cash " } }] },
      { choices: [{ delta: { content: "flow." }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
    ]),
    async () => {
      const provider = new DeepSeekProvider("sk-test");
      const tokens: string[] = [];
      const result = await provider.generate([{ role: "user", content: "hi" }], {
        modelClass: "MEDIUM",
        onToken: (delta) => tokens.push(delta),
      });

      assert.equal(result.text, "Free cash flow.");
      assert.deepEqual(tokens, ["Free ", "cash ", "flow."]);
      assert.equal(result.metrics.tokens_in, 42);
      assert.equal(result.metrics.tokens_out, 7);
      assert.equal(result.metrics.provider, "deepseek");
      assert.equal(result.metrics.model_class, "MEDIUM");
      assert.equal(result.toolCalls, undefined);
    },
  );
});

test("joins tool-call arguments split across stream chunks into one parsed call", async () => {
  await withStubbedFetch(
    () => sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_price", arguments: "{\"tick" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "er\":\"AAPL\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
    async () => {
      const provider = new DeepSeekProvider("sk-test");
      const result = await provider.generate([{ role: "user", content: "price?" }], { modelClass: "MEDIUM" });

      assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "get_price", input: { ticker: "AAPL" } }]);
      assert.equal(result.text, "");
    },
  );
});

test("keeps parallel tool calls separate by stream index", async () => {
  await withStubbedFetch(
    () => sseResponse([
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "a", function: { name: "get_price", arguments: "{\"ticker\":" } },
        { index: 1, id: "b", function: { name: "get_news", arguments: "{\"ticker\":" } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: "\"MSFT\"}" } },
        { index: 0, function: { arguments: "\"AAPL\"}" } },
      ] } }] },
    ]),
    async () => {
      const provider = new DeepSeekProvider("sk-test");
      const result = await provider.generate([{ role: "user", content: "both" }], { modelClass: "MEDIUM" });

      assert.deepEqual(result.toolCalls, [
        { id: "a", name: "get_price", input: { ticker: "AAPL" } },
        { id: "b", name: "get_news", input: { ticker: "MSFT" } },
      ]);
    },
  );
});

test("names the model and finish reason when the stream yields no text and no tool call", async () => {
  await withoutModelOverrides(async () => {
    await withStubbedFetch(
      () => sseResponse([{ choices: [{ delta: {}, finish_reason: "length" }] }]),
      async () => {
        const provider = new DeepSeekProvider("sk-test");
        await assert.rejects(
          () => provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" }),
          (error: Error) => {
            assert.match(error.message, /deepseek-v4-flash/);
            assert.match(error.message, /length/);
            return true;
          },
        );
      },
    );
  });
});

test("surfaces the status code and body of a failed request", async () => {
  await withStubbedFetch(
    () => new Response("{\"error\":{\"message\":\"Insufficient Balance\"}}", { status: 402 }),
    async () => {
      const provider = new DeepSeekProvider("sk-test");
      await assert.rejects(
        () => provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" }),
        (error: Error) => {
          assert.match(error.message, /402/);
          assert.match(error.message, /Insufficient Balance/);
          return true;
        },
      );
    },
  );
});

test("honors a custom base URL", async () => {
  await withStubbedFetch(
    () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]),
    async (captured) => {
      const provider = new DeepSeekProvider("sk-test", "https://proxy.internal/v1");
      await provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" });
      assert.equal(captured[0]!.url, "https://proxy.internal/v1/chat/completions");
    },
  );
});

/** An SSE body whose tool-call arguments arrive as the given fragments, in order. */
function toolCallResponse(name: string, fragments: string[], finishReason = "tool_calls"): Response {
  return sseResponse([
    ...fragments.map((argument, index) => ({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            ...(index === 0 ? { function: { name, arguments: argument } } : { function: { arguments: argument } }),
          }],
        },
      }],
    })),
    { choices: [{ finish_reason: finishReason }] },
  ]);
}

test("a corrupt tool-call argument names the tool and invites a resend", async () => {
  await withStubbedFetch(
    () => toolCallResponse("apply_operations", ['{"modelId":"fm_1", rows:2}']),
    async () => {
      const provider = new DeepSeekProvider("sk-test");
      await assert.rejects(
        () => provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" }),
        (error: Error) => {
          assert.ok(error instanceof MalformedResponseError);
          // Resending is the whole point: this sample is corrupt, the request is fine.
          assert.equal(error.retryable, true);
          assert.match(error.message, /apply_operations/);
          assert.match(error.message, /finish_reason=tool_calls/);
          // The offending bytes, not just the offset into a string nobody can see.
          assert.match(error.message, /rows:2/);
          return true;
        },
      );
    },
  );
});

test("arguments cut off at the output cap are not worth resending", async () => {
  await withStubbedFetch(
    () => toolCallResponse("apply_operations", ['{"modelId":"fm_1","rows":['], "length"),
    async () => {
      const provider = new DeepSeekProvider("sk-test");
      await assert.rejects(
        () => provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" }),
        (error: Error) => {
          assert.ok(error instanceof MalformedResponseError);
          // A retry reproduces the truncation and pays for a second cap-length generation.
          assert.equal(error.retryable, false);
          assert.match(error.message, /finish_reason=length/);
          return true;
        },
      );
    },
  );
});

test("a frame the stream could not parse is counted, not silently dropped", async () => {
  await withStubbedFetch(
    () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}\n\n'
      + "data: {not json}\n\n"
      + 'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n'
      + "data: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ),
    async () => {
      const provider = new DeepSeekProvider("sk-test");
      await assert.rejects(
        () => provider.generate([{ role: "user", content: "hi" }], { modelClass: "MEDIUM" }),
        (error: Error) => {
          // The dropped frame is the likeliest cause of the damage; the message has to say so,
          // or the reader blames the model for bytes the transport lost.
          assert.match(error.message, /dropped_frames=1/);
          return true;
        },
      );
    },
  );
});
