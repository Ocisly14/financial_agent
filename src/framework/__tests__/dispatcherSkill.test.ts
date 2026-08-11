import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { TaskRequest } from "../types.ts";

function harness(): { dispatcher: Dispatcher; seen: TaskRequest[]; state: SessionState; turn: number } {
  const seen: TaskRequest[] = [];
  const subagents = new SubagentRegistry();
  subagents.register({
    name: "market_data",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: [],
    systemPrompt: { system: "", prompt: "" },
  });
  subagents.register({
    name: "market_research",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: [],
    systemPrompt: { system: "", prompt: "" },
  });

  const state = new SessionState("s", new Date().toISOString());
  const turn = state.beginTurn("go");
  const runtime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest }) => {
      seen.push(ctx.request);
    },
  };
  const dispatcher = new Dispatcher(
    "s",
    subagents,
    runtime as never,
    new McpToolRegistry(),
    state,
    "agent-1",
  );
  return { dispatcher, seen, state, turn };
}

test("the section for the dispatched agent is appended to its task", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillSections({ market_data: "RSI period 14" });

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 1);
  assert.match(seen[0]!.task, /analyse NVDA/);
  assert.match(seen[0]!.task, /RSI period 14/);
});

test("an agent with no section receives its task unchanged", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillSections({ market_data: "RSI period 14" });

  await dispatcher.dispatch([{ agent: "market_research", task: "find news" }]);

  assert.equal(seen[0]!.task, "find news");
});

test("with no skill active every task is untouched", async () => {
  const { dispatcher, seen } = harness();
  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);
  assert.equal(seen[0]!.task, "analyse NVDA");
});

test("dispatching to an agent the active skill did not declare is refused before the run", async () => {
  const { dispatcher, seen, state, turn } = harness();
  dispatcher.setSkillAllowance({ agents: ["market_data"] });

  await dispatcher.dispatch([{ agent: "market_research", task: "find news" }]);

  assert.equal(seen.length, 0);
  const [result] = state.turnResults(turn);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "agent_not_allowed");
});

test("an allowance listing the agent lets the task through", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillAllowance({ agents: ["market_data"] });

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 1);
});
