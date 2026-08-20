import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRuntime } from "../subagent.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateResult, LlmMessage, LlmProvider } from "../../infra/llm/provider.ts";
import { createSubagentRegistry } from "../../agent/subagents/registerSubagents.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { JsonObject } from "../types.ts";

/**
 * Handing one task's data to the next one by id.
 *
 * The orchestrator is the only actor holding every result, and a subagent reads
 * nothing but its own prompt — so anything one agent found reaches the next one
 * only because the orchestrator put it there. Retyping it into prose is a
 * transcription step, and a transcription step on a hundred rows of statement
 * data is a wrong number waiting to happen. So the data travels by id instead:
 * the orchestrator names a result, the host reads that result's own
 * `generation_context.data` out of the log, and no model retypes anything.
 *
 * Driven through the real Dispatcher, the real SubagentRuntime and the real
 * agent definitions, because what is being checked is what actually reaches the
 * provider.
 */

const registry = createSubagentRegistry();

/** Runs one dispatch, returning what the provider was sent and what the task ended as. */
async function drive(
  state: SessionState,
  request: Parameters<Dispatcher["dispatch"]>[0][number],
): Promise<{ prompts: string[]; state: SessionState }> {
  const prompts: string[] = [];
  const provider: LlmProvider = {
    name: "stub",
    async generate(messages: LlmMessage[]): Promise<GenerateResult> {
      // Only the user side, concatenated with nothing between: the split cuts
      // this into cache blocks, and what is asserted below is the byte sequence
      // those blocks reassemble into. (The system prompt names [PROGRESS SO FAR]
      // in its own prose, so including it would defeat every ordering check.)
      prompts.push(messages.filter((m) => m.role === "user").map((m) => m.content).join(""));
      return { text: "finishing", toolCalls: [{ name: "finish", input: { summary: "done" } }],
        metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };
  // The real definition's whole pool: the dispatcher resolves every name in it
  // before the run starts, and an unregistered one fails the task before a
  // prompt is ever built.
  const tools = new McpToolRegistry();
  for (const name of registry.get(request.agent).defaultTools) {
    tools.register({ name, description: "d", category: "non_trading",
      inputSchema: { type: "object" }, execute: async () => ({ summary: "ok" }) });
  }

  const dispatcher = new Dispatcher("room_1", registry,
    new SubagentRuntime(new ModelRouter(provider), tools), tools, state, "agent-1");
  await dispatcher.dispatch([request]);
  return { prompts, state };
}

/** A finished task_result carrying data, recorded the way a real subagent records one. */
function priorResult(state: SessionState, data: JsonObject): string {
  const thread = state.openThread("market_research");
  const dispatch = state.recordDispatch("market_research", "read AMZN's FY2025 filing", thread);
  const event = state.recordTaskResult("market_research", dispatch.event_id, {
    task_id: dispatch.event_id, agent: "market_research", status: "ok",
    summary: "pulled AMZN FY2025 segment revenue",
    generation_context: { data },
  });
  return event.event_id;
}

function session(): SessionState {
  const state = new SessionState("room_1", new Date().toISOString());
  state.beginTurn("value AMZN");
  return state;
}

test("a handed result's data reaches the subagent's prompt verbatim", async () => {
  const state = session();
  const sourceEventId = priorResult(state, { segments: [{ name: "AWS", revenue: 107_556_000_000 }] });

  const run = await drive(state, { agent: "market_data", task: "chart AMZN against that segment split",
    source_event_ids: [sourceEventId] });

  const prompt = run.prompts[0]!;
  assert.match(prompt, /\[DATA HANDED TO YOU\]/);
  // The exact number, not a paraphrase of it: the point of the id is that no
  // model retyped this on the way over.
  assert.match(prompt, /107556000000/);
  // Whose work it was and what they concluded — the receiving agent has never
  // seen this result and cannot read the payload without them.
  assert.match(prompt, /from market_research — pulled AMZN FY2025 segment revenue/);
});

test("the handed block sits above the progress region, where it is cached rather than re-sent", async () => {
  const state = session();
  const sourceEventId = priorResult(state, { segments: [{ name: "AWS", revenue: 107_556_000_000 }] });

  const run = await drive(state, { agent: "market_data", task: "chart AMZN",
    source_event_ids: [sourceEventId] });

  const prompt = run.prompts[0]!;
  const handed = prompt.indexOf("[DATA HANDED TO YOU]");
  assert.ok(handed >= 0, "the block has to be there before its position means anything");
  assert.ok(handed < prompt.indexOf("[PROGRESS SO FAR]"),
    "handed data must precede the progress region — it is fixed for the whole run, and below the "
    + "region it would push every step's cut point");
});

test("a task handed nothing is byte-identical to one from before handoffs existed", async () => {
  const state = session();

  const run = await drive(state, { agent: "market_data", task: "chart AMZN" });

  const prompt = run.prompts[0]!;
  assert.doesNotMatch(prompt, /DATA HANDED TO YOU/);
  // Not merely "the heading is absent": the bytes between the task and the
  // progress region must be exactly what they were, or every ordinary dispatch
  // pays a cache write for an empty slot.
  assert.match(prompt, /<\/task>\n\n\[PROGRESS SO FAR\]/);
});

test("naming a result that carries no data fails the task instead of running it short", async () => {
  const state = session();

  const run = await drive(state, { agent: "market_data", task: "chart AMZN",
    source_event_ids: ["evt_nothing_here"] });

  assert.equal(run.prompts.length, 0, "the subagent must not run at all — a task written around data "
    + "it never received would answer from nothing and look like it worked");
  const task = [...state.turnResults(1)].at(-1)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error?.code, "data_ref_not_found");
  assert.match(task.error!.message, /evt_nothing_here/);
});

test("an oversized handoff fails loudly rather than arriving truncated", async () => {
  const state = session();
  // Two results that are each fine and together are not.
  const wide = { rows: Array.from({ length: 400 }, (_v, i) => ({ id: `row_${i}`, label: "x".repeat(60), value: i })) };
  const first = priorResult(state, wide);
  const second = priorResult(state, wide);

  const run = await drive(state, { agent: "market_data", task: "chart AMZN",
    source_event_ids: [first, second] });

  assert.equal(run.prompts.length, 0);
  const task = [...state.turnResults(1)].at(-1)!;
  assert.equal(task.error?.code, "data_ref_too_large");
});

test("a result line prints the id a later dispatch has to name", () => {
  const state = session();
  const sourceEventId = priorResult(state, { segments: [] });

  const progress = state.projectForPrompt(1).currentTurnProgress;

  assert.match(progress, new RegExp(`source_event_id=${sourceEventId}`),
    "an id the orchestrator cannot see is an id it cannot pass");
});
