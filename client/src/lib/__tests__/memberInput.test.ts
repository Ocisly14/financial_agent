import test from "node:test";
import assert from "node:assert/strict";
import { answerText, shouldContinueResearch } from "../memberInput.ts";
import type { UserInputRequestView } from "../../types/core.ts";

const request: UserInputRequestView = {
  request_id: "req_1",
  status: "pending",
  questions: [
    {
      id: "q1",
      question: "Which fiscal year?",
      options: [{ id: "fy25", label: "FY25" }, { id: "fy26", label: "FY26" }],
      min_selections: 1,
      max_selections: 2,
    },
    {
      id: "q2",
      question: "Include guidance?",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      min_selections: 1,
      max_selections: 1,
    },
  ],
};

test("answerText renders one line per question with the chosen labels", () => {
  const text = answerText(request, [
    { question_id: "q1", selected_option_ids: ["fy26"] },
    { question_id: "q2", selected_option_ids: ["yes"] },
  ]);
  assert.equal(text, "Which fiscal year?: FY26\nInclude guidance?: Yes");
});

test("answerText joins multiple selections in option order, not click order", () => {
  const text = answerText(request, [
    { question_id: "q1", selected_option_ids: ["fy26", "fy25"] },
    { question_id: "q2", selected_option_ids: ["no"] },
  ]);
  assert.equal(text, "Which fiscal year?: FY25, FY26\nInclude guidance?: No");
});

test("a question with no answer renders with an empty selection rather than being dropped", () => {
  const text = answerText(request, [{ question_id: "q1", selected_option_ids: ["fy25"] }]);
  assert.equal(text, "Which fiscal year?: FY25\nInclude guidance?: ");
});

test("shouldContinueResearch is false while any card is still pending", () => {
  assert.equal(shouldContinueResearch([
    { topicId: "a", topicName: "A", requestId: "r1", status: "answered" },
    { topicId: "b", topicName: "B", requestId: "r2", status: "pending" },
  ]), false);
});

test("shouldContinueResearch is true once every card is resolved", () => {
  assert.equal(shouldContinueResearch([
    { topicId: "a", topicName: "A", requestId: "r1", status: "answered" },
    { topicId: "b", topicName: "B", requestId: "r2", status: "skipped" },
  ]), true);
});

test("shouldContinueResearch is false with no cards at all", () => {
  // Nothing was asked, so there is nothing to continue from — this guards the
  // trigger against firing on an ordinary turn.
  assert.equal(shouldContinueResearch([]), false);
});
