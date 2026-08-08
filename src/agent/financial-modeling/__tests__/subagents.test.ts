import assert from "node:assert/strict";
import test from "node:test";
import { DcfSubagentRegistry, assertFreshDcfProposal, projectForDcfSubagent } from "../subagents.ts";
import { createSubagentRegistry } from "../../subagents/registerSubagents.ts";
import { SubagentRuntime } from "../../../framework/subagent.ts";
import { SessionState } from "../../../framework/sessionState.ts";
import { McpToolRegistry } from "../../../../mcp_tools/toolRegistry.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";

test("only financial_modeling is top-level; the four DCF subagents remain private", () => {
  const top = createSubagentRegistry().list().map((agent) => agent.name);
  assert.ok(top.includes("financial_modeling"));
  for (const child of new DcfSubagentRegistry().list()) assert.equal(top.includes(child as never), false);
  const financial = createSubagentRegistry().get("financial_modeling");
  assert.equal(financial.maxToolSteps, 12);
  assert.ok(financial.defaultTools.includes("run_dcf_subagent"));
  // Filing extraction is a tool, not a subagent: no prompt, no model call, nothing to register.
  assert.equal(new DcfSubagentRegistry().has("statement_extraction" as never), false);
  assert.ok(new DcfSubagentRegistry().list().every((subagent) => new DcfSubagentRegistry().get(subagent).authority !== "read_write_model" as never));
  assert.throws(() => createSubagentRegistry().get("spine_mapping" as never), /subagent not found/);
});

test("a resumed financial_modeling run refreshes the supplied model and pauses after 12 steps without recreating", async () => {
  let calls = 0;
  const provider: LlmProvider = { name: "loop", generate: async () => ({ text: JSON.stringify({ action: "call_tool", calls: [{ tool: "get_financial_model", input: { modelId: "m1" } }] }),
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "loop" } }) };
  const tools = new McpToolRegistry();
  tools.register({ name: "get_financial_model", description: "get", category: "non_trading", inputSchema: { type: "object" },
    execute: async () => { calls += 1; return { summary: "ok", generation_context: { data: { model_id: "m1", revision: 4,
      lifecycle_stage: "history_committed", revision_history: [{ revision: 0 }], current_workbook: { revision: 4 } } } }; } });
  const state = new SessionState("s", new Date().toISOString()); state.beginTurn("resume");
  const dispatch = state.recordDispatch("financial_modeling", "continue");
  const definition = { ...createSubagentRegistry().get("financial_modeling"), defaultTools: ["get_financial_model"] };
  await new SubagentRuntime(new ModelRouter(provider), tools).run(definition, { sessionId: "s", agentId: "a", taskId: dispatch.event_id,
    request: { agent: "financial_modeling", task: "continue", model_id: "m1" }, allowedTools: [tools.list()[0]!], state, parentEventId: dispatch.event_id });
  const result = state.task(dispatch.event_id)?.result!;
  assert.equal(calls, 13, "one automatic resume refresh plus twelve budgeted steps");
  assert.match(result.summary, /Paused after 12 tool steps.*m1.*revision 4/);
  assert.equal("tool_outputs" in (result.generation_context?.data ?? {}), false, "old workbooks are replaced, not accumulated");
  assert.deepEqual((result.generation_context?.data["active_model_context"] as Record<string, unknown>)["revision_history"], [{ revision: 0 }]);
});

test("financial_modeling runtime refuses parallel revision mutations before either tool executes", async () => {
  let llm = 0; let executions = 0; let correctionSeen = false;
  const provider: LlmProvider = { name: "serial", generate: async (messages) => {
    llm += 1;
    correctionSeen ||= messages.at(-1)?.content.includes("financial_mutation_serialization_required") ?? false;
    const text = llm === 1
      ? JSON.stringify({ action: "call_tool", calls: [{ tool: "apply_financial_model_operations", input: {} }, { tool: "archive_financial_model", input: {} }] })
      : JSON.stringify({ action: "finish", summary: "corrected" });
    return { text, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "serial" } };
  } };
  const tools = new McpToolRegistry();
  for (const name of ["apply_financial_model_operations", "archive_financial_model"]) tools.register({ name, description: name,
    category: "non_trading", inputSchema: { type: "object" }, execute: async () => { executions += 1; return { summary: "should not run" }; } });
  const state = new SessionState("s", new Date().toISOString()); state.beginTurn("mutate");
  const dispatch = state.recordDispatch("financial_modeling", "mutate");
  const definition = { ...createSubagentRegistry().get("financial_modeling"), defaultTools: tools.list().map((tool) => tool.name) };
  await new SubagentRuntime(new ModelRouter(provider), tools).run(definition, { sessionId: "s", agentId: "a", taskId: dispatch.event_id,
    request: { agent: "financial_modeling", task: "mutate" }, allowedTools: tools.list(), state, parentEventId: dispatch.event_id });
  assert.equal(executions, 0);
  assert.equal(correctionSeen, true);
  assert.equal(state.task(dispatch.event_id)?.result?.status, "ok");
});

test("subagent projections are stage specific and stale proposals are rejected", () => {
  const context = { model: { modelId: "m1", ownerAgentId: "a1", originSessionId: "s", symbol: "X", metadata: {}, currentRevision: 3,
    lifecycleStage: "history_committed" as const, updatedAt: "now", createdAt: "then" }, revisionHistory: [], currentWorkbook: {
      modelId: "m1", revision: 3, lifecycleStage: "history_committed" as const, engineVersion: "v", filingInsightSetId: null,
      periods: [], sections: { history: [], metrics: [], revenue: [], operations: [], dcf: [] }, categoryGroups: [], reconciliationResults: [],
      valuationConfig: {} as never, diagnostics: [], valuation: null, mode: "dcf" as const,
    } };
  const forecast = projectForDcfSubagent("forecast_modeling", context, null);
  assert.deepEqual(Object.keys((forecast.workbook["sections"] as object)), ["history", "metrics", "revenue", "operations"]);
  assert.equal("ownerAgentId" in forecast, false);
  assert.throws(() => assertFreshDcfProposal({ subagent: "forecast_modeling", modelId: "m1", baseRevision: 2,
    lifecycleStage: "history_committed", rationale: "", payload: {}, sourceRefs: [] }, context), /stale_dcf_proposal/);
});
