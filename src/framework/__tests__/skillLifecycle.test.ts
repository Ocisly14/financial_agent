import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { TaskRequest } from "../types.ts";

function makeDispatcher(state: SessionState, seen: TaskRequest[]): Dispatcher {
  const subagents = new SubagentRegistry();
  subagents.register({
    name: "market_data",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: [],
    systemPrompt: { system: "", prompt: "" },
  });
  const runtime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest }) => { seen.push(ctx.request); },
  };
  return new Dispatcher("s", subagents, runtime as never, new McpToolRegistry(), state, "agent-1");
}

test("a skill activated in one turn does not follow the next turn's dispatch", async () => {
  const state = new SessionState("s", new Date().toISOString());
  const seen: TaskRequest[] = [];

  // 第一个 turn：skill 激活
  state.beginTurn("analyse NVDA");
  const first = makeDispatcher(state, seen);
  first.setSkillSections({ market_data: "RSI period 14" });
  await first.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  // 第二个 turn：orchestrator.run 会新建一个 Dispatcher，没有任何 skill 状态
  state.beginTurn("what about the volume");
  const second = makeDispatcher(state, seen);
  await second.dispatch([{ agent: "market_data", task: "what about the volume" }]);

  assert.match(seen[0]!.task, /RSI period 14/);
  assert.doesNotMatch(seen[1]!.task, /RSI period 14/);
});

test("the dispatch event records the user's task, not the task plus the skill text", async () => {
  const state = new SessionState("s", new Date().toISOString());
  const seen: TaskRequest[] = [];
  const turn = state.beginTurn("analyse NVDA");

  const dispatcher = makeDispatcher(state, seen);
  dispatcher.setSkillSections({ market_data: "RSI period 14" });
  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  const projection = state.projectForPrompt(turn);
  assert.match(projection.currentTurnProgress, /analyse NVDA/);
  assert.doesNotMatch(projection.currentTurnProgress, /RSI period 14/);
});
