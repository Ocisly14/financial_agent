import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { TaskRequest, ToolDefinition } from "../types.ts";

/**
 * Regression coverage for spec §9's "未声明的…工具被拒绝" (undeclared tools are
 * refused) line, which shipped with no test at all. Also pins the fix-1
 * decision that a skill's `tools:` list *narrows* the agent's pool via
 * intersection rather than throwing on the first pool member it doesn't
 * mention.
 */

function harness(): {
  dispatcher: Dispatcher;
  seen: { request: TaskRequest; allowedTools: ToolDefinition[] }[];
  state: SessionState;
  turn: number;
} {
  const seen: { request: TaskRequest; allowedTools: ToolDefinition[] }[] = [];
  const subagents = new SubagentRegistry();
  subagents.register({
    name: "market_data",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: ["stock_sma", "stock_rsi", "stock_macd"],
    systemPrompt: { system: "", prompt: "" },
  });

  const tools = new McpToolRegistry();
  for (const name of ["stock_sma", "stock_rsi", "stock_macd"]) {
    tools.register({
      name,
      description: "d",
      category: "non_trading",
      inputSchema: { type: "object" },
      execute: async () => ({ summary: "ok" }),
    });
  }

  const state = new SessionState("s", new Date().toISOString());
  const turn = state.beginTurn("go");
  const runtime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest; allowedTools: ToolDefinition[] }) => {
      seen.push({ request: ctx.request, allowedTools: ctx.allowedTools });
    },
  };
  const dispatcher = new Dispatcher("s", subagents, runtime as never, tools, state);
  return { dispatcher, seen, state, turn };
}

test("with no skill tools allowance, the agent's full default pool is used", async () => {
  const { dispatcher, seen } = harness();

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name), ["stock_sma", "stock_rsi", "stock_macd"]);
});

test("the skill's tools: list narrows the default pool to its intersection instead of failing the task", async () => {
  const { dispatcher, seen, state, turn } = harness();
  dispatcher.setSkillAllowance({ tools: ["stock_sma", "stock_rsi"] });

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  // The reviewer's repro: this must NOT throw and fail the whole task just
  // because stock_macd (in the pool, not in the skill list) is present.
  assert.equal(seen.length, 1, "the subagent must still run");
  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name), ["stock_sma", "stock_rsi"]);
  assert.equal(state.turnResults(turn).length, 0, "no failure result should be recorded");
});

test("an empty intersection refuses the task instead of running a toolless subagent", async () => {
  const { dispatcher, seen, state, turn } = harness();
  dispatcher.setSkillAllowance({ tools: ["some_other_tool"] });

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  // A subagent with no tools still answers — from prose alone. That result is
  // indistinguishable from a real one in the session log, which is the worst
  // possible failure mode for a tool whose entire job is grounding claims in data.
  assert.equal(seen.length, 0, "the subagent must not run with an empty tool set");
  const result = state.turnResults(turn)[0];
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "no_tools_available");
});

test("an explicitly requested tool outside the skill's declared list is refused with tool_not_allowed, before the run", async () => {
  const { dispatcher, seen, state, turn } = harness();
  dispatcher.setSkillAllowance({ tools: ["stock_sma", "stock_rsi"] });

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA", tools: ["stock_macd"] }]);

  assert.equal(seen.length, 0, "the subagent must never run");
  const [result] = state.turnResults(turn);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "tool_not_allowed");
});

test("an explicitly requested tool inside both the agent's pool and the skill's list is allowed", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillAllowance({ tools: ["stock_sma", "stock_rsi"] });

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA", tools: ["stock_sma"] }]);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name), ["stock_sma"]);
});

test("an explicitly requested tool outside the agent's own default pool is still refused generically (pre-existing behaviour)", async () => {
  const { dispatcher, seen, state, turn } = harness();

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA", tools: ["not_in_pool"] }]);

  assert.equal(seen.length, 0);
  const [result] = state.turnResults(turn);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "task_failed");
});
