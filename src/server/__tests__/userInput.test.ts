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
