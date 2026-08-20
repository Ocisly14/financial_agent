import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher, taskTimeoutMs } from "../dispatcher.ts";
import { createSubagentRegistry } from "../../agent/subagents/registerSubagents.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { TaskRequest, ToolDefinition } from "../types.ts";

/**
 * What an agent may reach is decided entirely by its own pool, declared in the
 * topology; there is no second gate underneath and no side-channel that widens it.
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
    defaultTools: ["stock_sma", "stock_rsi", "stock_macd", "ask_user"],
    systemPrompt: { system: "", prompt: "" },
  });

  const tools = new McpToolRegistry();
  // stock_atr is registered but outside the pool: it exists only to be granted.
  for (const name of ["stock_sma", "stock_rsi", "stock_macd", "stock_atr"]) {
    tools.register({
      name,
      description: "d",
      category: "non_trading",
      inputSchema: { type: "object" },
      execute: async () => ({ summary: "ok" }),
    });
  }
  tools.register({
    name: "ask_user",
    description: "d",
    category: "main",
    inputSchema: { type: "object" },
    execute: async () => ({ summary: "ok" }),
  });

  const state = new SessionState("s", new Date().toISOString());
  const turn = state.beginTurn("go");
  const runtime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest; allowedTools: ToolDefinition[] }) => {
      seen.push({ request: ctx.request, allowedTools: ctx.allowedTools });
    },
  };
  const dispatcher = new Dispatcher("s", subagents, runtime as never, tools, state, "agent-1");
  return { dispatcher, seen, state, turn };
}

test("the agent's pool is the whole allowance — no skill widens it", async () => {
  // Skills used to add tools to a dispatched agent's pool per turn. That grant was a capability
  // side-channel around the topology, which is now the ONE place an agent's reach is declared.
  const { dispatcher, seen } = harness();

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name), ["stock_sma", "stock_rsi", "stock_macd", "ask_user"]);
});

test("an explicitly requested tool must come from the pool", async () => {
  const { dispatcher, seen } = harness();

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA", tools: ["stock_rsi"] }]);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name), ["stock_rsi"]);
});

test("an explicitly requested tool outside the pool is refused", async () => {
  const { dispatcher, seen, state, turn } = harness();

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA", tools: ["stock_atr"] }]);

  assert.equal(seen.length, 0);
  const [result] = state.turnResults(turn);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "task_failed");
});

test("ask_user is stripped from the pool when no human is watching", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setUserInputAllowed(false);

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.allowedTools.some((t) => t.name === "ask_user"));
});

test("the task ceiling comes from the agent's own topology node", () => {
  const min = (n: number) => n * 60_000;
  const registry = createSubagentRegistry();
  const timeout = (agent: Parameters<typeof registry.get>[0]) =>
    taskTimeoutMs({ agent, task: "t" }, registry.get(agent));

  // A quote is seconds; leaving this high would only delay noticing a hang.
  assert.equal(timeout("market_data"), min(5));
  // A DCF round is 60 tool steps and nests whole agent rounds inside delegate_to_agent.
  // At five minutes it timed out mid-round while the agent ran on unheard.
  assert.equal(timeout("financial_modeling"), min(30));
  assert.equal(timeout("trading_operations"), min(16));
  // An explicit request always wins, whatever the agent declares.
  assert.equal(taskTimeoutMs({ agent: "financial_modeling", task: "t", timeout_ms: 42 }, registry.get("financial_modeling")), 42);
});

test("a task that outlives its ceiling is recorded as a timeout", async () => {
  const { state, turn } = harness();
  const never = new Promise(() => {}); // only the timeout can end this
  const subagents = new SubagentRegistry();
  subagents.register({ name: "market_data", description: "d", modelClass: "MEDIUM",
    defaultTools: [], systemPrompt: { system: "", prompt: "" } });
  const timed = new Dispatcher("s", subagents, { run: () => never } as never, new McpToolRegistry(), state, "a1");

  await timed.dispatch([{ agent: "market_data", task: "quote NVDA", timeout_ms: 20 }]);

  const result = state.turnResults(turn).at(-1);
  assert.equal(result?.status, "timeout");
  assert.equal(result?.error?.code, "timeout");
});
