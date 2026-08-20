import test from "node:test";
import assert from "node:assert/strict";
import { OrchestratorRuntime } from "../orchestrator.ts";
import { SkillRegistry } from "../skill.ts";
import { SubagentRegistry } from "../subagent.ts";
import { Dispatcher } from "../dispatcher.ts";
import { SessionRegistry } from "../sessionState.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateOptions, GenerateResult, LlmMessage, LlmProvider } from "../../infra/llm/provider.ts";
import type { JsonObject, TaskRequest } from "../types.ts";

/**
 * `dispatch` and `tool_calls` have no dependency on one another, so a step may
 * carry both. `skill` is different: its whole purpose is to shape the task text
 * the model writes NEXT, so pairing it with another action is a protocol error
 * rather than a shortcut — and it must be reported, not silently dropped.
 */

type Harness = {
  run: (steps: Array<{ text?: string; calls?: Array<{ name: string; input: JsonObject }> }>, options?: { allowUserInput?: boolean; activeModel?: { modelId: string; symbol: string; createdAt: string; updatedAt: string; currentRevision: number; lifecycleStage: string } }) => Promise<void>;
  dispatched: TaskRequest[];
  toolCalls: { name: string; input: JsonObject }[];
  sessions: SessionRegistry;
};

function harness(): Harness {
  const dispatched: TaskRequest[] = [];
  const toolCalls: { name: string; input: JsonObject }[] = [];

  const subagents = new SubagentRegistry();
  subagents.register({
    name: "market_data",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: [],
    systemPrompt: { system: "", prompt: "" },
  });
  subagents.register({
    name: "financial_modeling",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: [],
    systemPrompt: { system: "", prompt: "" },
  });
  const subagentRuntime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest }) => { dispatched.push(ctx.request); },
  };

  // Both orchestrator-level tools, stubbed: the branch under test is the loop's,
  // not the tools' own behaviour (they have their own tests).
  const tools = new McpToolRegistry();
  for (const name of ["read_skill_reference", "run_skill_script", "ask_user"]) {
    tools.register({
      name,
      description: "d",
      category: "main",
      inputSchema: { type: "object" },
      execute: async (input: JsonObject) => {
        toolCalls.push({ name, input });
        if (name === "ask_user") {
          return {
            summary: "waiting",
            user_input_request: {
              request_id: "input_test",
              questions: [{
                id: "q",
                question: "Pick one",
                options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
                min_selections: 1,
                max_selections: 1,
              }],
            },
          };
        }
        return { summary: `${name} ok` };
      },
    });
  }

  const sessions = new SessionRegistry();
  const dispatcherFactory = (sessionId: string, tenantId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime as never, tools, sessions.getExisting(sessionId), tenantId);

  return {
    dispatched,
    toolCalls,
    sessions,
    run: async (steps: Array<{ text?: string; calls?: Array<{ name: string; input: JsonObject }> }>, options?: { allowUserInput?: boolean; activeModel?: { modelId: string; symbol: string; createdAt: string; updatedAt: string; currentRevision: number; lifecycleStage: string } }) => {
      let call = 0;
      const provider: LlmProvider = {
        name: "stub",
        async generate(_messages: LlmMessage[], _options: GenerateOptions): Promise<GenerateResult> {
          const step = steps[call] ?? { text: "done" };
          call += 1;
          return { text: step.text ?? "working",
            ...(step.calls ? { toolCalls: step.calls.map((c, i) => ({ id: `t${i}`, ...c })) } : {}),
            metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "LARGE", provider: "stub" } };
        },
      };
      const orchestrator = new OrchestratorRuntime(
        { system: "", prompt: "" },
        new ModelRouter(provider),
        dispatcherFactory,
        subagents,
        new SkillRegistry(),
        tools,
        sessions,
      );
      await orchestrator.run({ tenantId: "agent-1", sessionId: "s", userMessage: "go", ...options });
    },
  };
}

test("two tool calls in one step both run, instead of costing two loop iterations", async () => {
  const h = harness();

  await h.run([
    {
      text: "reading",
      calls: [
        { name: "read_skill_reference", input: { path: "a.md" } },
        { name: "read_skill_reference", input: { path: "b.md" } },
      ],
    },
    { text: "done" },
  ]);

  assert.deepEqual(h.toolCalls.map((c) => c.input["path"]), ["a.md", "b.md"]);
});



test("a delegation and a direct tool call share one step and one list", async () => {
  const h = harness();

  await h.run([
    {
      text: "working",
      calls: [
        { name: "delegate_to_agent", input: { agent: "market_data", task: "quote NVDA" } },
        { name: "read_skill_reference", input: { path: "a.md" } },
      ],
    },
    { text: "done" },
  ]);

  assert.deepEqual(h.dispatched.map((d) => d.task), ["quote NVDA"]);
  assert.deepEqual(h.toolCalls.map((c) => c.input["path"]), ["a.md"]);
});



test("the visible model becomes the advisory default for a DCF dispatch", async () => {
  const h = harness();

  await h.run([
    { text: "updating", calls: [{ name: "delegate_to_agent", input: { agent: "financial_modeling", task: "update the DCF" } }] },
    { text: "done" },
  ], { activeModel: { modelId: "model-visible", symbol: "AAPL", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z", currentRevision: 7, lifecycleStage: "valued" } });

  assert.equal(h.dispatched[0]?.model_id, "model-visible");
});

test("an explicit DCF model choice remains available to the agent", async () => {
  const h = harness();

  await h.run([
    { text: "updating", calls: [{ name: "delegate_to_agent", input: { agent: "financial_modeling", task: "build a comparison model", model_id: "model-other" } }] },
    { text: "done" },
  ], { activeModel: { modelId: "model-visible", symbol: "AAPL", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z", currentRevision: 7, lifecycleStage: "valued" } });

  assert.equal(h.dispatched[0]?.model_id, "model-other");
});

test("pairing skill with another action is refused outright, not silently resolved by priority", async () => {
  const h = harness();

  await h.run([
    { text: "working", calls: [
      { name: "invoke_skill", input: { skill: "whatever" } },
      { name: "delegate_to_agent", input: { agent: "market_data", task: "quote NVDA" } },
    ] },
    { text: "done" },
  ]);

  assert.equal(h.dispatched.length, 0, "the dispatch must not win by branch order");
  assert.equal(h.toolCalls.length, 0);
});

test("the protocol error is visible to the model, so it can correct itself next step", async () => {
  const h = harness();

  await h.run([
    { text: "working", calls: [
      { name: "invoke_skill", input: { skill: "whatever" } },
      { name: "delegate_to_agent", input: { agent: "market_data", task: "quote NVDA" } },
    ] },
    { text: "done" },
  ]);

  const state = h.sessions.getExisting("s");
  const progress = state.projectForPrompt(1).currentTurnProgress;
  assert.match(progress, /invoke_skill/);
  assert.match(progress, /only call/);
});

test("ask_user records a request and ends the turn without another model step", async () => {
  const h = harness();

  await h.run([
    { text: "Choose what fits.", calls: [{ name: "ask_user", input: { questions: [] } }] },
    { text: "this must not be reached" },
  ]);

  const state = h.sessions.getExisting("s");
  assert.equal(state.userInputRequest("input_test")?.status, "pending");
  // The card names its asker; this one is the Topic agent's own question.
  assert.equal(state.userInputRequest("input_test")?.asked_by, "orchestrator");
  const final = [...state.allEvents()].reverse().find((event) => event.kind === "reply" && event.payload.final === true);
  assert.equal(final?.payload.content, "Choose what fits.");
  assert.equal(h.toolCalls.filter((call) => call.name === "ask_user").length, 1);
});

test("ask_user is rejected when mixed with another action", async () => {
  const h = harness();

  await h.run([
    {
      text: "mixed",
      calls: [
        { name: "ask_user", input: {} },
        { name: "read_skill_reference", input: { path: "a.md" } },
      ],
    },
    { text: "done" },
  ]);

  assert.equal(h.toolCalls.length, 0);
  assert.match(h.sessions.getExisting("s").projectForPrompt(1).currentTurnProgress, /ask_user must be the only action/);
});

test("ask_user is unavailable when a Research controller drives a Topic in the background", async () => {
  const h = harness();

  await h.run([
    { text: "choose", calls: [{ name: "ask_user", input: {} }] },
    { text: "missing input returned to caller" },
  ], { allowUserInput: false });

  assert.equal(h.toolCalls.length, 0);
  assert.equal(h.sessions.getExisting("s").userInputRequest("input_test"), undefined);
});



test("a delegate call that stays invalid is a loud protocol error, never a silent turn end", async () => {
  const h = harness();

  await h.run([
    {
      text: "working",
      calls: [{ name: "delegate_to_agent", input: { agent: "market_data" } }], // no task
    },
    { text: "done" },
  ]);

  assert.equal(h.dispatched.length, 0);
  const state = h.sessions.getExisting("s");
  const progress = state.projectForPrompt(1).currentTurnProgress;
  assert.match(progress, /delegate_to_agent call\(s\) were invalid/);
});
