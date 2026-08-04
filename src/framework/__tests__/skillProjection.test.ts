import test from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../sessionState.ts";

test("an invoked skill's content reaches the next round's prompt", () => {
  const state = new SessionState("s", new Date().toISOString());
  const turn = state.beginTurn("analyse NVDA");

  state.record("orchestrator", "skill_invoke", { skill: "demo" });
  state.record("orchestrator", "skill_result", {
    skill: "demo",
    summary: "Loaded skill demo.",
    content: "RULE: cite every number",
  });

  const projection = state.projectForPrompt(turn);
  assert.match(projection.currentTurnProgress, /RULE: cite every number/);
});
