import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter, type GenerateOptions, type LlmMessage, type LlmProvider } from "../../infra/llm/provider.ts";
import { generateDigest, parseDigestReply } from "../topicDigest.ts";

// The digest's TEXT quality needs real credentials and is checked by hand. What
// is checked here is the part that must never depend on a model: when a call is
// spent, and how a reply that isn't the JSON we asked for is salvaged.
//
// WHEN a digest runs is not this module's concern — see
// src/server/__tests__/topicDigestScheduler.test.ts.

function replyingWith(text: string): { router: ModelRouter; calls: () => number; lastOptions: () => GenerateOptions | undefined; lastPrompt: () => string } {
  let calls = 0;
  let lastOptions: GenerateOptions | undefined;
  let prompt = "";
  const provider: LlmProvider = {
    name: "fake",
    async generate(messages: LlmMessage[], options: GenerateOptions) {
      calls++;
      lastOptions = options;
      prompt = String(messages[messages.length - 1]?.content ?? "");
      return { text, metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: options.modelClass, provider: "fake" } };
    },
  };
  return { router: new ModelRouter(provider), calls: () => calls, lastOptions: () => lastOptions, lastPrompt: () => prompt };
}

const oneTurn = [{ turn: 1, user: "英伟达估值还合理吗", reply: "远期 PE 32x…" }];

test("a digest is generated with the SMALL model class", async () => {
  const { router, lastOptions } = replyingWith('{"summary": "  某缩要  ", "category": "single_name"}');
  const digest = await generateDigest(oneTurn, router);

  assert.equal(lastOptions()?.modelClass, "SMALL");
  assert.equal(digest.summary, "某缩要", "trimmed");
  assert.equal(digest.category, "single_name");
});

test("an empty history spends no model call", async () => {
  const { router, calls } = replyingWith("{}");
  assert.deepEqual(await generateDigest([], router), { title: null, symbols: [], summary: "", category: null });
  assert.equal(calls(), 0, "summarising a conversation that hasn't happened invents one");
});

test("title and explicitly mentioned symbols are returned structurally", () => {
  const parsed = parseDigestReply('{"title":"Apple valuation","symbols":["aapl","MSFT","AAPL","not a ticker"],"summary":"AAPL is under review.","category":"single_name"}');
  assert.equal(parsed.title, "Apple valuation");
  assert.deepEqual(parsed.symbols, ["AAPL", "MSFT"]);
});

test("an incremental update receives the old digest and only its new turns", async () => {
  const { router, lastPrompt } = replyingWith('{"summary":"更新后","category":"single_name"}');
  await generateDigest([{ turn: 4, user: "新问题", reply: "新答案" }], router, "此前结论");

  assert.match(lastPrompt(), /Existing digest[\s\S]*此前结论/);
  assert.match(lastPrompt(), /\[turn 4\][\s\S]*新问题[\s\S]*新答案/);
  assert.doesNotMatch(lastPrompt(), /Conversation history/);
});

test("a category outside the taxonomy is dropped, not stored", () => {
  const parsed = parseDigestReply('{"summary": "宏观利率讨论", "category": "crypto"}');
  assert.equal(parsed.summary, "宏观利率讨论");
  assert.equal(parsed.category, null, "asset class is not a category — an invented slug must not reach the DB");
});

test("an explicitly null category parses as unclassified", () => {
  assert.equal(parseDigestReply('{"summary": "闲聊", "category": null}').category, null);
});

test("JSON wrapped in prose or a fence is still read", () => {
  const fenced = parseDigestReply('```json\n{"summary": "半导体周期", "category": "sector"}\n```');
  assert.deepEqual(fenced, { title: null, symbols: [], summary: "半导体周期", category: "sector" });

  const chatty = parseDigestReply('Sure! Here you go:\n{"summary": "配对交易", "category": "comparative"}\nHope that helps.');
  assert.deepEqual(chatty, { title: null, symbols: [], summary: "配对交易", category: "comparative" });
});

test("an unparsable reply keeps the summary and loses only the category", () => {
  // The summary is the expensive half of the call. A model that forgot the JSON
  // wrapper has still done the work, and a missing category self-heals next turn.
  const parsed = parseDigestReply("这个 Topic 在跟踪美联储降息路径，尚无结论。");
  assert.equal(parsed.summary, "这个 Topic 在跟踪美联储降息路径，尚无结论。");
  assert.equal(parsed.category, null);
});

test("valid JSON with an empty summary falls back to the raw reply", () => {
  const parsed = parseDigestReply('{"summary": "", "category": "macro"}');
  assert.equal(parsed.summary, '{"summary": "", "category": "macro"}', "never return a blank summary as if it were one");
});
