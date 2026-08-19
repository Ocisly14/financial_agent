import test from "node:test";
import assert from "node:assert/strict";
import { createAskUserTool } from "../askUserTool.ts";

test("ask_user normalizes a multi-question request and supplies defaults", async () => {
  const result = await createAskUserTool().execute({
    questions: [
      {
        id: "horizon",
        header: "Time horizon",
        question: "How long will you hold?",
        options: [
          { id: "short", label: "Under one year", recommended: true },
          { id: "long", label: "One year or more", description: "Accepts a longer cycle." },
        ],
      },
      {
        id: "risks",
        question: "Which risks matter?",
        options: [
          { id: "drawdown", label: "Drawdown" },
          { id: "liquidity", label: "Liquidity" },
          { id: "tax", label: "Tax" },
        ],
        min_selections: 1,
        max_selections: 2,
      },
    ],
  }, { sessionId: "s", tenantId: "agent-1" });

  assert.equal(result.error, undefined);
  assert.match(result.user_input_request?.request_id ?? "", /^input_/);
  assert.deepEqual(
    result.user_input_request?.questions.map((question) => [question.id, question.min_selections, question.max_selections]),
    [["horizon", 1, 2], ["risks", 1, 2]],
  );
  assert.equal(result.user_input_request?.questions[0]?.options[0]?.recommended, true);
});

test("ask_user rejects duplicate ids and invalid selection limits", async () => {
  const duplicate = await createAskUserTool().execute({
    questions: [{
      id: "q",
      question: "Pick",
      options: [{ id: "same", label: "A" }, { id: "same", label: "B" }],
    }],
  }, { sessionId: "s", tenantId: "agent-1" });
  assert.equal(duplicate.error?.code, "invalid_user_input_request");

  const limits = await createAskUserTool().execute({
    questions: [{
      id: "q",
      question: "Pick",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      min_selections: 2,
      max_selections: 1,
    }],
  }, { sessionId: "s", tenantId: "agent-1" });
  assert.equal(limits.error?.code, "invalid_user_input_request");
});
