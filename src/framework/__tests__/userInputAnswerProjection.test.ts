import test from "node:test";
import assert from "node:assert/strict";
import { formatLatestInput, SessionState } from "../sessionState.ts";
import { orchestratorPrompt } from "../../agent/prompts/orchestratorPrompt.ts";
import { researchPrompt } from "../../agent/research/researchPrompt.ts";

/**
 * An answer to an `ask_user` card is not something the user said — it is a
 * structured reply to a question the agent asked. It reaches the model as its
 * own labelled block, and it never renders as a chat bubble.
 *
 * The event itself stays a `user_message`: it is what opens the turn, and
 * `foldUserInputRequest` finds it to decide whether a card was answered or
 * skipped. Only its projections change.
 */
function stateWithAnsweredTurn(): SessionState {
  const state = new SessionState("room_1", new Date().toISOString());
  state.beginTurn("value RKLB");
  state.recordReply("done", true);
  state.beginTurn("Entry?: Buy at market now", {
    request_id: "input_1",
    answers: [{ question_id: "entry", selected_option_ids: ["market"] }],
  });
  return state;
}

test("a prior answer turn projects as its own block, not as a User line", () => {
  const history = stateWithAnsweredTurn().projectForPrompt(3).conversationSoFar;

  assert.match(history, /\[ANSWERED YOUR QUESTIONS\]\nEntry\?: Buy at market now/);
  assert.doesNotMatch(history, /User: Entry\?/);
  // The real user turn before it is untouched.
  assert.match(history, /User: value RKLB/);
});

test("the answer turn still anchors the card's answered state", () => {
  const state = stateWithAnsweredTurn();
  const events = state.allEvents().filter((event) => event.kind === "user_message");

  assert.equal(events.length, 2);
  assert.equal(events[1]!.payload.response_to, "input_1");
});

test("the turn's opening block is labelled by what opened it", () => {
  assert.equal(
    formatLatestInput("value RKLB", false),
    "[THE USER'S LATEST MESSAGE — RESPOND TO THIS]\nvalue RKLB",
  );
  assert.equal(
    formatLatestInput("Entry?: Buy at market now", true),
    "[THE USER ANSWERED YOUR QUESTIONS — CONTINUE FROM HERE]\nEntry?: Buy at market now",
  );
});

test("both prompts take the whole block, so neither hardcodes the message heading", () => {
  for (const template of [orchestratorPrompt.prompt, researchPrompt.prompt]) {
    assert.match(template, /\{\{latestInput\}\}/);
    assert.doesNotMatch(template, /LATEST MESSAGE — RESPOND TO THIS/);
    assert.doesNotMatch(template, /\{\{userMessage\}\}/);
  }
});
