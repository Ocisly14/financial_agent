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
  run: (steps: string[]) => Promise<void>;
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
  for (const name of ["read_skill_reference", "run_skill_script"]) {
    tools.register({
      name,
      description: "d",
      category: "main",
      inputSchema: { type: "object" },
      execute: async (input: JsonObject) => {
        toolCalls.push({ name, input });
        return { summary: `${name} ok` };
      },
    });
  }

  const sessions = new SessionRegistry();
  const dispatcherFactory = (sessionId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime as never, tools, sessions.getExisting(sessionId));

  return {
    dispatched,
    toolCalls,
    sessions,
    run: async (steps: string[]) => {
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
      await orchestrator.run({ sessionId: "s", userMessage: "go" });
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
