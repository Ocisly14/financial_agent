import assert from "node:assert/strict";
import test from "node:test";
import { SessionState, type SessionEvent } from "../../framework/sessionState.ts";
import { projectChatHistory } from "../chatHistory.ts";

test("chat history projects user and assistant messages with durable UI metadata", () => {
  const state = new SessionState("room-1", "2026-07-29T00:00:00.000Z");
  state.beginTurn("Chart AAPL");
  const thread = state.openThread("market_data");
  const dispatch = state.recordDispatch("market_data", "Load AAPL chart", thread);
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
    threadId: thread,
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

test("chat history restores answered and skipped input cards", () => {
  const answered = new SessionState("room-input", "2026-08-04T00:00:00.000Z");
  answered.beginTurn("Help me choose");
  answered.recordUserInputRequest({
    request_id: "input_answered",
    questions: [{
      id: "risk",
      question: "Risk level?",
      options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
      min_selections: 1,
      max_selections: 1,
    }],
  });
  answered.recordReply("Choose one.", true);
  answered.beginTurn("Risk level?: Low", {
    request_id: "input_answered",
    answers: [{ question_id: "risk", selected_option_ids: ["low"] }],
  });
  answered.recordReply("Got it.", true);

  const answeredCard = projectChatHistory(answered.allEvents())[1]?.content?.metadata?.inputRequest;
  assert.equal(answeredCard?.status, "answered");
  assert.deepEqual(answeredCard?.answers, [{ question_id: "risk", selected_option_ids: ["low"] }]);

  const skipped = new SessionState("room-skipped", "2026-08-04T00:00:00.000Z");
  skipped.beginTurn("Help me choose");
  skipped.recordUserInputRequest({
    request_id: "input_skipped",
    questions: [{
      id: "risk",
      question: "Risk level?",
      options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
      min_selections: 1,
      max_selections: 1,
    }],
  });
  skipped.recordReply("Choose one.", true);
  skipped.beginTurn("Never mind");
  skipped.recordReply("Okay.", true);

  assert.equal(projectChatHistory(skipped.allEvents())[1]?.content?.metadata?.inputRequest?.status, "skipped");
});

test("a restored card still names who asked", () => {
  const state = new SessionState("room-asked-by", "2026-08-11T00:00:00.000Z");
  state.beginTurn("Value AAPL");
  state.recordUserInputRequest({
    request_id: "input_dcf",
    questions: [{
      id: "basis",
      question: "Which revenue basis?",
      options: [{ id: "gaap", label: "GAAP" }, { id: "adj", label: "Adjusted" }],
      min_selections: 1,
      max_selections: 1,
    }],
  }, "financial_modeling");
  state.recordReply("Please answer the questions below to continue.", true);

  assert.equal(projectChatHistory(state.allEvents())[1]?.content?.metadata?.inputRequest?.asked_by, "financial_modeling");
});

test("a card recorded before asked_by existed reads as the Topic agent's own question", () => {
  const state = new SessionState("room-legacy", "2026-08-11T00:00:00.000Z");
  state.beginTurn("Help me choose");
  state.recordUserInputRequest({
    request_id: "input_legacy",
    questions: [{
      id: "risk",
      question: "Risk level?",
      options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
      min_selections: 1,
      max_selections: 1,
    }],
  });
  state.recordReply("Choose one.", true);
  // Strip the field the way a session persisted before this change would have it.
  const events: SessionEvent[] = state.allEvents().map((event) => {
    if (event.kind !== "user_input_required") return event;
    const { asked_by: _askedBy, ...payload } = event.payload;
    return { ...event, payload };
  });

  assert.equal(projectChatHistory(events)[1]?.content?.metadata?.inputRequest?.asked_by, "orchestrator");
});

test("chat history carries retrieved sources so citations can be rendered inline", () => {
  const state = new SessionState("room-3", "2026-07-30T00:00:00.000Z");
  state.beginTurn("NVDA 有什么传闻");
  const thread = state.openThread("market_research");
  const dispatch = state.recordDispatch("market_research", "Search NVDA rumours", thread);
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
  }, { parent: dispatch.event_id, threadId: thread });
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

test("answering a card produces no chat bubble — the card itself is the record", () => {
  const state = new SessionState("room-input", "2026-08-14T00:00:00.000Z");
  state.beginTurn("Should I buy RKLB?");
  state.recordUserInputRequest({
    request_id: "input_1",
    questions: [{
      id: "entry",
      question: "Entry?",
      options: [{ id: "market", label: "Buy at market now" }, { id: "limit", label: "Limit order" }],
      min_selections: 1,
      max_selections: 1,
    }],
  }, "orchestrator");
  state.beginTurn("Entry?: Buy at market now", {
    request_id: "input_1",
    answers: [{ question_id: "entry", selected_option_ids: ["market"] }],
  });
  state.recordReply("Placing it.", true);

  const messages = projectChatHistory(state.allEvents());

  assert.deepEqual(messages.map((message) => message.text), ["Should I buy RKLB?", "Placing it."]);
});
