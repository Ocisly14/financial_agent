import test from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../../framework/sessionState.ts";
import { projectEvent } from "../../infra/events/sseProjector.ts";

test("final SSE carries tool visualizations as a UI-only side channel", () => {
  const state = new SessionState("session-1", new Date().toISOString());
  state.beginTurn("Show MSFT SMA");
  const dispatch = state.recordDispatch("market_data", "Calculate MSFT SMA");
  const visualization = {
    type: "stock_technical",
    symbol: "MSFT",
    timeframe: "1Day",
    indicator: "SMA",
  };
  state.recordTaskResult("market_data", dispatch.event_id, {
    task_id: dispatch.event_id,
    agent: "market_data",
    status: "ok",
    summary: "done",
    visualizations: [visualization],
  });
  const reply = state.recordReply("MSFT SMA is rising.", true);

  const final = projectEvent(reply, state).find((frame) => frame.type === "final");
  assert.ok(final && final.type === "final");
  assert.deepEqual(final.visualizations, [visualization]);
});

test("final SSE carries a pending structured input request", () => {
  const state = new SessionState("session-input", new Date().toISOString());
  state.beginTurn("Help me choose");
  state.recordUserInputRequest({
    request_id: "input_1",
    questions: [{
      id: "risk",
      question: "Risk level?",
      options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
      min_selections: 1,
      max_selections: 1,
    }],
  });
  const reply = state.recordReply("Choose a risk level.", true);

  const final = projectEvent(reply, state).find((frame) => frame.type === "final");
  assert.ok(final && final.type === "final");
  assert.equal(final.input_request?.request_id, "input_1");
  assert.equal(final.input_request?.status, "pending");
});
