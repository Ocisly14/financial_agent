import test from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../../framework/sessionState.ts";
import { projectEvent } from "../../infra/events/sseProjector.ts";

test("final SSE carries tool visualizations as a UI-only side channel", () => {
  const state = new SessionState("session-1", new Date().toISOString());
  state.beginTurn("Show MSFT SMA");
  const thread = state.openThread("market_data");
  const dispatch = state.recordDispatch("market_data", "Calculate MSFT SMA", thread);
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

test("a financial model tool result projects one model_revision frame", () => {
  const state = new SessionState("session-model", new Date().toISOString());
  state.beginTurn("Build the AAPL model");
  const event = state.record("financial_modeling", "tool_result", {
    tool_use_id: "tu-1",
    task_id: "task-1",
    name: "apply_financial_model_operations",
    summary: "assumptions set",
    generation_context: {
      data: {
        model_id: "model-1",
        revision: 12,
        lifecycle_stage: "operations_fcff",
        revision_summary: {
          revision: 12,
          changedSections: ["operations", "dcf"],
          warningCount: 0,
          changes: [
            { kind: "assumption_set", lineItemId: "tax_rate", periodIds: ["FY2026", "FY2027"] },
            { kind: "formula_set", lineItemId: "nopat", appliesTo: "forecast", periodIds: ["FY2026"] },
          ],
        },
      },
    },
  }, { threadId: "session-1:financial_modeling:1" });

  const frames = projectEvent(event, state).filter((frame) => frame.type === "model_revision");
  assert.equal(frames.length, 1);
  const frame = frames[0]!;
  assert.equal(frame.type, "model_revision");
  assert.equal(frame.model_id, "model-1");
  assert.equal(frame.revision, 12);
  assert.equal(frame.lifecycle_stage, "operations_fcff");
  assert.deepEqual(frame.changed_sections, ["operations", "dcf"]);
  assert.deepEqual(frame.changed_line_item_ids.sort(), ["nopat", "tax_rate"]);
  assert.deepEqual(frame.changed_period_ids.sort(), ["FY2026", "FY2027"]);
  assert.deepEqual(frame.change_kinds.sort(), ["assumption_set", "formula_set"]);
});

test("a wacc-only revision still carries its change kinds", () => {
  const state = new SessionState("session-wacc", new Date().toISOString());
  state.beginTurn("Refresh WACC");
  const event = state.record("financial_modeling", "tool_result", {
    tool_use_id: "tu-2",
    task_id: "task-2",
    name: "apply_financial_model_operations",
    summary: "wacc refreshed",
    generation_context: {
      data: {
        model_id: "model-1",
        revision: 13,
        lifecycle_stage: "operations_fcff",
        // changedSections is deliberately empty: ModelReadSection has no WACC
        // member, so the sheet mapping has to come from change kinds.
        revision_summary: {
          revision: 13,
          changedSections: [],
          warningCount: 0,
          changes: [{ kind: "wacc_sheet_refreshed", rowIds: ["beta", "wacc"] }],
        },
      },
    },
  }, { threadId: "session-1:financial_modeling:1" });

  const frame = projectEvent(event, state).find((f) => f.type === "model_revision");
  assert.ok(frame && frame.type === "model_revision");
  assert.deepEqual(frame.changed_sections, []);
  assert.deepEqual(frame.change_kinds, ["wacc_sheet_refreshed"]);
  assert.deepEqual(frame.changed_line_item_ids, []);
});

test("a tool result without model fields projects no model_revision frame", () => {
  const state = new SessionState("session-plain", new Date().toISOString());
  state.beginTurn("Search filings");
  const event = state.record("financial_modeling", "tool_result", {
    tool_use_id: "tu-3",
    task_id: "task-3",
    name: "financial_search",
    summary: "3 results",
    generation_context: { data: { results: [] } },
  }, { threadId: "session-1:financial_modeling:1" });

  assert.deepEqual(projectEvent(event, state).filter((frame) => frame.type === "model_revision"), []);
});

test("a model revision defaults to focus, and a tool can opt out with silent", () => {
  const frameFor = (display?: string) => {
    const state = new SessionState(`session-display-${display ?? "default"}`, new Date().toISOString());
    state.beginTurn("Build the model");
    const event = state.record("financial_modeling", "tool_result", {
      tool_use_id: "tu-d", task_id: "task-d", name: "create_financial_model", summary: "created",
      generation_context: {
        data: {
          model_id: "model-1", revision: 1, lifecycle_stage: "draft",
          ...(display === undefined ? {} : { display }),
          revision_summary: { revision: 1, changedSections: [], warningCount: 0, changes: [{ kind: "model_created" }] },
        },
      },
    }, { threadId: `session-display-${display ?? "default"}:financial_modeling:1` });
    const frame = projectEvent(event, state).find((f) => f.type === "model_revision");
    assert.ok(frame && frame.type === "model_revision");
    return frame;
  };

  // Omitted means show it: a tool that built what the user asked for should not
  // have to opt in to being seen.
  assert.equal(frameFor().display, "focus");
  assert.equal(frameFor("focus").display, "focus");
  assert.equal(frameFor("silent").display, "silent");
  // An unrecognised value must not silently suppress the artifact.
  assert.equal(frameFor("nonsense").display, "focus");
});
