import test from "node:test";
import assert from "node:assert/strict";
import type { UserInputRequest } from "../../framework/types.ts";
import { validateUserInputAnswers } from "../server.ts";

const request: UserInputRequest = {
  request_id: "input_1",
  questions: [
    {
      id: "horizon",
      question: "Horizon?",
      options: [{ id: "short", label: "Short" }, { id: "long", label: "Long" }],
      min_selections: 1,
      max_selections: 1,
    },
    {
      id: "risks",
      question: "Risks?",
      options: [{ id: "drawdown", label: "Drawdown" }, { id: "tax", label: "Tax" }, { id: "fx", label: "FX" }],
      min_selections: 1,
      max_selections: 2,
    },
  ],
};

test("validates every structured answer and produces grounded user text", () => {
  const result = validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["long"] },
    { questionId: "risks", selectedOptionIds: ["drawdown", "fx"] },
  ]);

  assert.ok(!("error" in result));
  assert.equal(result.message, "Horizon?: Long\nRisks?: Drawdown, FX");
  assert.deepEqual(result.response.answers[1], {
    question_id: "risks",
    selected_option_ids: ["drawdown", "fx"],
  });
});

test("counts free text as one selection and quotes it back to the agent", () => {
  const result = validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: [], freeText: "  whatever survives a decade  " },
    { questionId: "risks", selectedOptionIds: ["drawdown"], freeText: "regulatory" },
  ]);

  assert.ok(!("error" in result));
  assert.equal(
    result.message,
    'Horizon?: Other — "whatever survives a decade"\nRisks?: Drawdown, Other — "regulatory"',
  );
  assert.deepEqual(result.response.answers[0], {
    question_id: "horizon",
    selected_option_ids: [],
    free_text: "whatever survives a decade",
  });
});

test("blank free text is absent rather than an empty selection", () => {
  const result = validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["long"], freeText: "   " },
    { questionId: "risks", selectedOptionIds: ["drawdown"] },
  ]);

  assert.ok(!("error" in result));
  assert.equal(result.message, "Horizon?: Long\nRisks?: Drawdown");
  assert.deepEqual(result.response.answers[0], { question_id: "horizon", selected_option_ids: ["long"] });
});

test("rejects free text that overruns the selection limit or the length cap", () => {
  assert.ok("error" in validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["long"], freeText: "and also this" },
    { questionId: "risks", selectedOptionIds: ["drawdown"] },
  ]));
  assert.ok("error" in validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["long"] },
    { questionId: "risks", selectedOptionIds: ["drawdown"], freeText: "x".repeat(501) },
  ]));
  assert.ok("error" in validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["long"], freeText: 7 },
    { questionId: "risks", selectedOptionIds: ["drawdown"] },
  ]));
});

test("rejects incomplete, unknown, duplicate, and over-limit selections", () => {
  assert.ok("error" in validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["long"] },
  ]));
  assert.ok("error" in validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["unknown"] },
    { questionId: "risks", selectedOptionIds: ["drawdown"] },
  ]));
  assert.ok("error" in validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["long", "long"] },
    { questionId: "risks", selectedOptionIds: ["drawdown"] },
  ]));
  assert.ok("error" in validateUserInputAnswers(request, [
    { questionId: "horizon", selectedOptionIds: ["long"] },
    { questionId: "risks", selectedOptionIds: ["drawdown", "tax", "fx"] },
  ]));
});
