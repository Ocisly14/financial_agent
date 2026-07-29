// test/sessionState.projection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../src/framework/sessionState.ts";

test("projectForPrompt without a compaction cache renders prior turns as before", () => {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");
  state.beginTurn("turn 1 question");
  state.recordReply("turn 1 answer", true);
  state.beginTurn("turn 2 question");

  const proj = state.projectForPrompt(2);

  assert.equal(proj.conversationSoFar, "User: turn 1 question\nYou: turn 1 answer");
  assert.ok(!proj.conversationSoFar.includes("[EARLIER CONVERSATION SUMMARY]"));
});

test("projectForPrompt with a compaction cache prepends summary + preserved data", () => {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");
  // Simulate post-compaction state: turns 1-2 trimmed, turn 3 remains.
  state.beginTurn("turn 3 question"); // turn 1 in this fresh state's counter terms
  state.recordReply("turn 3 answer", true);
  state.setCompactionCache({
    summarizedThroughTurn: 2,
    summaryText: "User has been asking about BTC and ETH on-chain flows.",
    preservedData: [
      { turn: 1, agent: "market_data", data: { inflow: 1200 } },
      { turn: 2, agent: "technical", data: { rsi: 58 } },
    ],
  });

  const proj = state.projectForPrompt(2);

  assert.match(proj.conversationSoFar, /^\[EARLIER CONVERSATION SUMMARY\]/);
  assert.match(proj.conversationSoFar, /User has been asking about BTC and ETH on-chain flows\./);
  assert.match(proj.conversationSoFar, /\[DATA FROM EARLIER TASKS\]/);
  assert.match(proj.conversationSoFar, /- turn 1 \(market_data\): \{"inflow":1200\}/);
  assert.match(proj.conversationSoFar, /- turn 2 \(technical\): \{"rsi":58\}/);
  assert.match(proj.conversationSoFar, /\[RECENT CONVERSATION\]\nUser: turn 3 question\nYou: turn 3 answer/);
});
