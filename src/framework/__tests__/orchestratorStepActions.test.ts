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
  run: (steps: string[], options?: { allowUserInput?: boolean }) => Promise<void>;
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
  const dispatcherFactory = (sessionId: string, agentId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime as never, tools, sessions.getExisting(sessionId), agentId);

  return {
    dispatched,
    toolCalls,
    sessions,
    run: async (steps: string[], options?: { allowUserInput?: boolean }) => {
      let call = 0;
      const provider: LlmProvider = {
        name: "stub",
        async generate(_messages: LlmMessage[], _options: GenerateOptions): Promise<GenerateResult> {
          const text = steps[call] ?? JSON.stringify({ reply: "done" });
          call += 1;
          return { text, metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "LARGE", provider: "stub" } };
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
      await orchestrator.run({ agentId: "agent-1", sessionId: "s", userMessage: "go", ...options });
    },
  };
}

test("two tool calls in one step both run, instead of costing two loop iterations", async () => {
  const h = harness();

  await h.run([
    JSON.stringify({
      reply: "reading",
      tool_calls: [
        { name: "read_skill_reference", input: { path: "a.md" } },
        { name: "read_skill_reference", input: { path: "b.md" } },
      ],
    }),
    JSON.stringify({ reply: "done" }),
  ]);

  assert.deepEqual(h.toolCalls.map((c) => c.input["path"]), ["a.md", "b.md"]);
});

test("a single tool_call object is still accepted", async () => {
  const h = harness();

  await h.run([
    JSON.stringify({ reply: "reading", tool_call: { name: "read_skill_reference", input: { path: "a.md" } } }),
    JSON.stringify({ reply: "done" }),
  ]);

  assert.deepEqual(h.toolCalls.map((c) => c.input["path"]), ["a.md"]);
});

test("dispatch and tool calls in the same step both run", async () => {
  const h = harness();

  await h.run([
    JSON.stringify({
      reply: "working",
      dispatch: [{ agent: "market_data", task: "quote NVDA" }],
      tool_calls: [{ name: "read_skill_reference", input: { path: "a.md" } }],
    }),
    JSON.stringify({ reply: "done" }),
  ]);

  assert.deepEqual(h.dispatched.map((d) => d.task), ["quote NVDA"]);
  assert.deepEqual(h.toolCalls.map((c) => c.input["path"]), ["a.md"]);
});

test("pairing skill with another action is refused outright, not silently resolved by priority", async () => {
  const h = harness();

  await h.run([
    JSON.stringify({
      reply: "working",
      skill: "whatever",
      dispatch: [{ agent: "market_data", task: "quote NVDA" }],
    }),
    JSON.stringify({ reply: "done" }),
  ]);

  assert.equal(h.dispatched.length, 0, "the dispatch must not win by branch order");
  assert.equal(h.toolCalls.length, 0);
});

test("the protocol error is visible to the model, so it can correct itself next step", async () => {
  const h = harness();

  await h.run([
    JSON.stringify({
      reply: "working",
      skill: "whatever",
      dispatch: [{ agent: "market_data", task: "quote NVDA" }],
    }),
    JSON.stringify({ reply: "done" }),
  ]);

  const state = h.sessions.getExisting("s");
  const progress = state.projectForPrompt(1).currentTurnProgress;
  assert.match(progress, /skill/i);
  assert.match(progress, /exclusive|同时|mutually/i);
});

test("ask_user records a request and ends the turn without another model step", async () => {
  const h = harness();

  await h.run([
    JSON.stringify({ reply: "Choose what fits.", tool_calls: [{ name: "ask_user", input: { questions: [] } }] }),
    JSON.stringify({ reply: "this must not be reached" }),
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
    JSON.stringify({
      reply: "mixed",
      tool_calls: [
        { name: "ask_user", input: {} },
        { name: "read_skill_reference", input: { path: "a.md" } },
      ],
    }),
    JSON.stringify({ reply: "done" }),
  ]);

  assert.equal(h.toolCalls.length, 0);
  assert.match(h.sessions.getExisting("s").projectForPrompt(1).currentTurnProgress, /ask_user must be the only action/);
});

test("ask_user is unavailable when a Research controller drives a Topic in the background", async () => {
  const h = harness();

  await h.run([
    JSON.stringify({ reply: "choose", tool_calls: [{ name: "ask_user", input: {} }] }),
    JSON.stringify({ reply: "missing input returned to caller" }),
  ], { allowUserInput: false });

  assert.equal(h.toolCalls.length, 0);
  assert.equal(h.sessions.getExisting("s").userInputRequest("input_test"), undefined);
});
