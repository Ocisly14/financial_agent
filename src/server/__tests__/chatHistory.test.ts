import assert from "node:assert/strict";
import test from "node:test";
import { SessionState } from "../../framework/sessionState.ts";
import { projectChatHistory } from "../chatHistory.ts";

test("chat history projects user and assistant messages with durable UI metadata", () => {
  const state = new SessionState("room-1", "2026-07-29T00:00:00.000Z");
  state.beginTurn("Chart AAPL");
  const dispatch = state.recordDispatch("market_data", "Load AAPL chart");
  state.recordTaskResult("market_data", dispatch.event_id, {
    task_id: dispatch.event_id,
    agent: "market_data",
    status: "ok",
    summary: "Chart loaded",
    artifacts: [{ type: "url", ref: "https://example.test/report", label: "report" }],
    visualizations: [{ type: "stock_chart", symbol: "AAPL" }],
  });
  state.recordReply("Open {{artifact:1}}", true);

  const messages = projectChatHistory(state.allEvents());

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0] && { user: messages[0].user, text: messages[0].text }, {
    user: "user",
    text: "Chart AAPL",
  });
  assert.equal(messages[1]?.text, "Open report");
  assert.deepEqual(messages[1]?.content?.metadata?.visualizations, [{ type: "stock_chart", symbol: "AAPL" }]);
  assert.equal(messages[1]?.content?.metadata?.artifacts[0]?.ref, "https://example.test/report");
  assert.deepEqual(messages[1]?.progressTasks, [{
    taskId: dispatch.event_id,
    description: "Load AAPL chart",
    status: "completed",
    agent: "market_data",
    summary: "Chart loaded",
  }]);
});

test("chat history includes non-final step replies in event order", () => {
  const state = new SessionState("room-2", "2026-07-29T00:00:00.000Z");
  state.beginTurn("Research AAPL");
  state.recordReply("I will research that.", false);
  state.recordReply("Done.", true);

  assert.deepEqual(projectChatHistory(state.allEvents()).map(({ user, text }) => ({ user, text })), [
    { user: "user", text: "Research AAPL" },
    { user: "system", text: "I will research that." },
    { user: "system", text: "Done." },
  ]);
});
