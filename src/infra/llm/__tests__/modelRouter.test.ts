import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MalformedResponseError,
  ModelRouter,
  llmCostReport,
  resetLlmCostReport,
  type GenerateOptions,
  type GenerateResult,
  type LlmMessage,
  type LlmProvider,
} from "../provider.ts";

const reply = (text: string): GenerateResult => ({
  text,
  metrics: { tokens_in: 10, tokens_out: 5, ms: 1, model_class: "MEDIUM", provider: "stub" },
});

/** A provider that replays `outcomes`, one per call, recording how many times it was asked. */
function stubProvider(outcomes: Array<GenerateResult | Error>): LlmProvider & { calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  return {
    name: "stub",
    calls,
    async generate(messages: LlmMessage[], _options: GenerateOptions): Promise<GenerateResult> {
      calls.push(messages);
      const outcome = outcomes[calls.length - 1];
      if (outcome === undefined) throw new Error(`stub ran out of outcomes at call ${calls.length}`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const messages: LlmMessage[] = [{ role: "user", content: "build the model" }];
const options: GenerateOptions = { modelClass: "MEDIUM", metadata: { mode: "subagent", agent: "financial_modeling" } };

const malformed = (retryable: boolean) => new MalformedResponseError("unparseable arguments", { retryable });

test("resends a request whose reply came back corrupt", async () => {
  const provider = stubProvider([malformed(true), reply("second time clean")]);
  const result = await new ModelRouter(provider).generate(messages, options);

  assert.equal(result.text, "second time clean");
  assert.equal(provider.calls.length, 2);
  // The retry has to be the same request — a resend that re-renders the prompt would both
  // miss the cache and, on a subagent step, ask a different question than the one that failed.
  assert.deepEqual(provider.calls[1], provider.calls[0]);
});

test("gives up after a bounded number of corrupt replies", async () => {
  const provider = stubProvider([malformed(true), malformed(true), malformed(true), reply("never reached")]);

  await assert.rejects(
    () => new ModelRouter(provider).generate(messages, options),
    (error: Error) => error instanceof MalformedResponseError,
  );
  assert.equal(provider.calls.length, 3);
});

test("does not resend a reply that says resending will not help", async () => {
  const provider = stubProvider([malformed(false), reply("never reached")]);

  await assert.rejects(() => new ModelRouter(provider).generate(messages, options));
  assert.equal(provider.calls.length, 1);
});

test("passes ordinary provider failures straight through", async () => {
  // A 402 or a 429 is a property of the account or the request, not of the sample: resending
  // pays for the same failure again and delays the error the caller needs to see.
  const provider = stubProvider([new Error("DeepSeek API error 402: Insufficient Balance")]);

  await assert.rejects(
    () => new ModelRouter(provider).generate(messages, options),
    /Insufficient Balance/,
  );
  assert.equal(provider.calls.length, 1);
});

test("stops resending once the caller has aborted", async () => {
  const controller = new AbortController();
  const provider: LlmProvider = {
    name: "stub",
    async generate(): Promise<GenerateResult> {
      controller.abort();
      throw malformed(true);
    },
  };

  await assert.rejects(() => new ModelRouter(provider).generate(messages, { ...options, signal: controller.signal }));
});

test("bills only the attempt that produced a result", async () => {
  // A failed attempt reports no usage, so counting it would be inventing numbers; the cost
  // table stays a record of what the provider actually said it charged.
  resetLlmCostReport();
  const provider = stubProvider([malformed(true), reply("clean")]);
  await new ModelRouter(provider).generate(messages, options);

  const row = llmCostReport()["subagent:financial_modeling"];
  assert.equal(row?.calls, 1);
  assert.equal(row?.tokens_in, 10);
  resetLlmCostReport();
});
