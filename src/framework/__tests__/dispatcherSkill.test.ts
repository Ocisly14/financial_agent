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

/**
 * A skill acts on its READER. The Dispatcher used to relay a skill's `## for:` sections into
 * dispatched task text and widen pools with its `tools:` — a side-channel the orchestrator could
 * not see and the topology did not declare. Both are gone: what a task carries is exactly what its
 * author wrote, and what an agent can reach is exactly its topology pool.
 */
test("a dispatched task reaches the subagent verbatim — nothing is appended behind its author", async () => {
  const { dispatcher, seen } = harness();

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.task, "analyse NVDA");
});

test("the dispatch event records the user's task, exactly", async () => {
  const { dispatcher, state } = harness();

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  const dispatchEvent = state.allEvents().find((e) => e.kind === "dispatch");
  assert.equal(dispatchEvent?.payload["task"], "analyse NVDA");
});
