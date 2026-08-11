import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher, taskTimeoutMs } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { TaskRequest, ToolDefinition } from "../types.ts";

/**
 * A skill's `tools:` GRANTS — it adds to the agent's own pool and never takes
 * away. Domain isolation is not this list's job: toolAccess's category gate runs
 * on every name in the union, and it is what actually keeps agents apart.
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

test("with no skill active, the agent's full default pool is used", async () => {
  const { dispatcher, seen } = harness();

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name), ["stock_sma", "stock_rsi", "stock_macd"]);
});

test("the skill's tools: adds to the pool and never removes from it", async () => {
  const { dispatcher, seen, state, turn } = harness();
  dispatcher.setSkillTools(["stock_sma", "stock_atr"]);

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 1, "the subagent must still run");
  // stock_rsi and stock_macd are in the pool and unmentioned by the skill: they stay.
  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name),
    ["stock_sma", "stock_rsi", "stock_macd", "stock_atr"]);
  assert.equal(state.turnResults(turn).length, 0, "no failure result should be recorded");
});

test("a skill naming only tools outside the pool still leaves the pool intact", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillTools(["stock_atr"]);

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  // Under the old intersection this emptied the set and failed the task.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name),
    ["stock_sma", "stock_rsi", "stock_macd", "stock_atr"]);
});

test("an explicitly requested tool may come from the skill's grant", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillTools(["stock_atr"]);

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA", tools: ["stock_atr"] }]);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.allowedTools.map((t) => t.name), ["stock_atr"]);
});

test("an explicitly requested tool outside both the pool and the grant is refused", async () => {
  const { dispatcher, seen, state, turn } = harness();
  dispatcher.setSkillTools(["stock_atr"]);

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA", tools: ["not_in_pool"] }]);

  assert.equal(seen.length, 0);
  const [result] = state.turnResults(turn);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "task_failed");
});

test("a granted tool the category gate refuses still fails the dispatch", async () => {
  const { dispatcher, seen, state, turn } = harness();
  const tools = new McpToolRegistry();
  // Rebuilt here so the grant names a trading tool a market_data agent may not have.
  for (const name of ["stock_sma", "stock_rsi", "stock_macd"]) {
    tools.register({ name, description: "d", category: "non_trading", inputSchema: { type: "object" }, execute: async () => ({ summary: "ok" }) });
  }
  tools.register({ name: "create_strategy", description: "d", category: "trading", inputSchema: { type: "object" }, execute: async () => ({ summary: "ok" }) });
  const subagents = new SubagentRegistry();
  subagents.register({ name: "market_data", description: "d", modelClass: "MEDIUM",
    defaultTools: ["stock_sma"], systemPrompt: { system: "", prompt: "" } });
  const gated = new Dispatcher("s", subagents, { run: async () => { seen.push({} as never); } } as never,
    tools, state, "agent-1");
  gated.setSkillTools(["create_strategy"]);

  await gated.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 0, "the category gate is the real isolation and must still bite");
  const result = state.turnResults(turn).at(-1);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error?.code, "task_failed");
});

test("ask_user is stripped from the union, not just from the pool, when no human is watching", async () => {
  const { dispatcher, seen } = harness();
  // The strip used to run on the pool alone, so a skill granting ask_user could
  // smuggle it past userInputAllowed and end the turn on an empty seat.
  dispatcher.setSkillTools(["ask_user"]);
  dispatcher.setUserInputAllowed(false);

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.allowedTools.some((t) => t.name === "ask_user"));
});

test("the task ceiling is per-agent, because the right ceiling is a property of the work", () => {
  const min = (n: number) => n * 60_000;

  // A quote is seconds; leaving this high would only delay noticing a hang.
  assert.equal(taskTimeoutMs({ agent: "market_data", task: "quote NVDA" }), min(5));
  // A DCF round is 30 tool steps and nests a whole agent inside run_dcf_subagent.
  // At five minutes it timed out mid-round while the agent ran on unheard.
  assert.equal(taskTimeoutMs({ agent: "financial_modeling", task: "value AAPL" }), min(15));
  assert.equal(taskTimeoutMs({ agent: "trading_operations", task: "start it" }), min(16));
  // An explicit request always wins, whatever the agent.
  assert.equal(taskTimeoutMs({ agent: "financial_modeling", task: "value AAPL", timeout_ms: 42 }), 42);
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
