import assert from "node:assert/strict";
import test from "node:test";
import { DcfSubagentRegistry } from "../subagents.ts";
import { createSubagentRegistry } from "../../subagents/registerSubagents.ts";
import { SubagentRuntime } from "../../../framework/subagent.ts";
import { SessionState } from "../../../framework/sessionState.ts";
import { McpToolRegistry } from "../../../../mcp_tools/toolRegistry.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";

test("only financial_modeling is top-level; the two DCF subagents remain private", () => {
  const top = createSubagentRegistry().list().map((agent) => agent.name);
  assert.ok(top.includes("financial_modeling"));
  for (const child of new DcfSubagentRegistry().list()) assert.equal(top.includes(child as never), false);
  const financial = createSubagentRegistry().get("financial_modeling");
  assert.equal(financial.maxToolSteps, 30);
  assert.ok(financial.defaultTools.includes("run_dcf_subagent"));
  // Filing extraction is a tool, not a subagent: no prompt, no model call, nothing to register.
  assert.equal(new DcfSubagentRegistry().has("statement_extraction" as never), false);
  assert.ok(new DcfSubagentRegistry().list().every((subagent) => new DcfSubagentRegistry().get(subagent).authority !== "read_write_model" as never));
  assert.throws(() => createSubagentRegistry().get("spine_mapping" as never), /subagent not found/);
});

test("a resumed financial_modeling run refreshes the supplied model and pauses at the step budget without recreating", async () => {
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
  assert.equal(calls, 31, "one automatic resume refresh plus thirty budgeted steps");
  assert.match(result.summary, /Paused after 30 tool steps.*m1.*revision 4/);
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

test("native tool calls drive the loop: providers with toolCalls bypass text parsing, and the finish tool ends the run with its summary", async () => {
  let step = 0;
  const provider: LlmProvider = { name: "fc", generate: async (_messages, options) => {
    assert.ok(options.tools?.some((tool) => tool.name === "finish"), "finish tool is offered");
    assert.ok(options.tools?.some((tool) => tool.name === "probe"), "allowed tools are offered");
    step += 1;
    return { text: "", toolCalls: step === 1
      ? [{ name: "probe", input: { q: "x" } }]
      : [{ name: "finish", input: { summary: "done via finish tool" } }],
      metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "fc" } };
  } };
  const tools = new McpToolRegistry();
  let probed = 0;
  tools.register({ name: "probe", description: "probe", category: "non_trading", inputSchema: { type: "object" },
    execute: async () => { probed += 1; return { summary: "probed" }; } });
  const state = new SessionState("s", new Date().toISOString()); state.beginTurn("fc");
  const dispatch = state.recordDispatch("market_research", "look");
  const definition = { ...createSubagentRegistry().get("market_research"), defaultTools: ["probe"] };
  await new SubagentRuntime(new ModelRouter(provider), tools).run(definition, { sessionId: "s", agentId: "a", taskId: dispatch.event_id,
    request: { agent: "market_research", task: "look" }, allowedTools: [tools.list()[0]!], state, parentEventId: dispatch.event_id });
  const result = state.task(dispatch.event_id)?.result!;
  assert.equal(probed, 1);
  assert.equal(result.summary, "done via finish tool");
});

test("a finish tool call with an empty summary is retried, not accepted", async () => {
  let step = 0;
  const provider: LlmProvider = { name: "fc-empty", generate: async () => {
    step += 1;
    return { text: "", toolCalls: step === 1
      ? [{ name: "finish", input: { summary: "" } }]
      : [{ name: "finish", input: { summary: "second try" } }],
      metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "fc-empty" } };
  } };
  const tools = new McpToolRegistry();
  tools.register({ name: "probe", description: "probe", category: "non_trading", inputSchema: { type: "object" },
    execute: async () => ({ summary: "probed" }) });
  const state = new SessionState("s", new Date().toISOString()); state.beginTurn("fc2");
  const dispatch = state.recordDispatch("market_research", "look");
  const definition = { ...createSubagentRegistry().get("market_research"), defaultTools: ["probe"] };
  await new SubagentRuntime(new ModelRouter(provider), tools).run(definition, { sessionId: "s", agentId: "a", taskId: dispatch.event_id,
    request: { agent: "market_research", task: "look" }, allowedTools: [tools.list()[0]!], state, parentEventId: dispatch.event_id });
  assert.equal(state.task(dispatch.event_id)?.result?.summary, "second try");
  assert.equal(step, 2, "empty-summary finish consumed one retried step");
});
