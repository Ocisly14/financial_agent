import test from "node:test";
import assert from "node:assert/strict";
import { buildAnswers, isQuestionSatisfied, questionSelectionCount } from "../userInputAnswers.ts";
import type { UserInputQuestion } from "../../types/core.ts";

const single: UserInputQuestion = {
  id: "horizon",
  question: "Horizon?",
  options: [{ id: "short", label: "Short" }, { id: "long", label: "Long" }],
  min_selections: 1,
  max_selections: 1,
};

const multi: UserInputQuestion = {
  id: "risks",
  question: "Risks?",
  options: [{ id: "drawdown", label: "Drawdown" }, { id: "tax", label: "Tax" }, { id: "fx", label: "FX" }],
  min_selections: 1,
  max_selections: 2,
};

test("free text counts as one selection once it holds more than whitespace", () => {
  assert.equal(questionSelectionCount([], ""), 0);
  assert.equal(questionSelectionCount([], "   "), 0);
  assert.equal(questionSelectionCount([], "something else"), 1);
  assert.equal(questionSelectionCount(["drawdown"], "regulatory"), 2);
});

test("free text alone satisfies a question, and crowding out its limit does not", () => {
  assert.equal(isQuestionSatisfied(single, [], "neither, actually"), true);
  assert.equal(isQuestionSatisfied(single, ["long"], "and also this"), false);
  assert.equal(isQuestionSatisfied(single, [], ""), false);
  assert.equal(isQuestionSatisfied(multi, ["drawdown", "fx"], "one more"), false);
  assert.equal(isQuestionSatisfied(multi, ["drawdown"], "regulatory"), true);
});

test("buildAnswers trims free text and omits it when blank", () => {
  const answers = buildAnswers([single, multi], { horizon: [], risks: ["fx"] }, {
    horizon: "  a decade  ",
    risks: "  ",
  });

  assert.deepEqual(answers, [
    { question_id: "horizon", selected_option_ids: [], free_text: "a decade" },
    { question_id: "risks", selected_option_ids: ["fx"] },
  ]);
});

test("buildAnswers covers every question even when nothing was touched", () => {
  assert.deepEqual(buildAnswers([single], {}, {}), [
    { question_id: "horizon", selected_option_ids: [] },
  ]);
});
