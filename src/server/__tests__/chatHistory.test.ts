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

test("chat history carries retrieved sources so citations can be rendered inline", () => {
  const state = new SessionState("room-3", "2026-07-30T00:00:00.000Z");
  state.beginTurn("NVDA 有什么传闻");
  const dispatch = state.recordDispatch("market_research", "Search NVDA rumours");
  // A subagent's own tool call lands as a sidechain tool_result.
  state.record("market_research", "tool_result", {
    task_id: dispatch.event_id,
    name: "financial_search",
    summary: "returned 2 results",
    generation_context: {
      data: {
        results: [
          {
            title: "Nvidia Reportedly Moves to Backstop $250 Billion",
            url: "https://finance.yahoo.com/a",
            content: "Nvidia is reportedly in talks to backstop financing…",
            publishedDate: "2026-07-27",
            score: 0.9,
          },
          { title: "Duplicate", url: "https://finance.yahoo.com/a", content: "dupe" },
          { title: "No url", content: "dropped" },
        ],
      },
    },
  }, { parent: dispatch.event_id, isSidechain: true });
  state.recordTaskResult("market_research", dispatch.event_id, {
    task_id: dispatch.event_id,
    agent: "market_research",
    status: "ok",
    summary: "done",
  });
  state.recordReply("传闻见 [[cite:2500 亿担保|1]]。", true);

  const sources = projectChatHistory(state.allEvents()).at(-1)?.content?.metadata?.sources;
  assert.equal(sources?.length, 1, "deduped by url, entries without a url dropped");
  assert.deepEqual(sources?.[0], {
    url: "https://finance.yahoo.com/a",
    title: "Nvidia Reportedly Moves to Backstop $250 Billion",
    snippet: "Nvidia is reportedly in talks to backstop financing…",
    publishedDate: "2026-07-27",
  });
});
