import test from "node:test";
import assert from "node:assert/strict";
import { progressRegion, SubagentRuntime } from "../subagent.ts";
import { SessionState } from "../sessionState.ts";
import { ModelRouter } from "../../infra/llm/provider.ts";
import type { GenerateResult, LlmMessage, LlmProvider } from "../../infra/llm/provider.ts";
import { createSubagentRegistry } from "../../agent/subagents/registerSubagents.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { AgentKind, JsonObject } from "../types.ts";

/**
 * The DCF pipeline is three agents with three different progress projections — financial_modeling
 * has its own (`projectFinancialModelProgress`), while statement_unification and spine_mapping share
 * the generic one — and each renders into its own real prompt template. What a step's tools returned
 * has to reach the NEXT step's prompt, and the bytes that carry it have to hold still so the request
 * can be cached. Both properties have broken in production, so both are pinned here per agent,
 * against the real definitions rather than a stand-in template.
 */

const registry = createSubagentRegistry();

/** A payload the size of a real one: small enough to read, past MIN_ROLLING_CACHE_CHARS by enough
 *  that a step which returns one is worth its own cache write. */
const bulk = (marker: string, rows: number): JsonObject => ({
  marker,
  rows: Array.from({ length: rows }, (_value, index) => ({
    id: `${marker}_row_${index}`, label: `${marker} line item ${index}`,
    periods: ["FY2021", "FY2022", "FY2023", "FY2024", "FY2025"], value: index * 1000,
  })),
});

type Step = { tool: string; data: JsonObject };

/** Runs one agent's real definition against scripted tool results, returning the messages the
 *  provider saw at each step. */
async function drive(agent: AgentKind, script: Step[]): Promise<LlmMessage[][]> {
  const definition = registry.get(agent);
  const sent: LlmMessage[][] = [];
  const provider: LlmProvider = {
    name: "stub",
    async generate(messages: LlmMessage[]): Promise<GenerateResult> {
      sent.push(messages);
      const step = script[sent.length - 1];
      const toolCalls = step === undefined
        ? [{ name: "finish", input: { summary: "done" } }]
        : [{ name: step.tool, input: {} }];
      return { text: `step ${sent.length}: calling ${step?.tool ?? "finish"}`, toolCalls,
        metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "stub" } };
    },
  };

  const tools = new McpToolRegistry();
  // One queue per tool NAME, not one payload: an agent calls the same tool repeatedly with different
  // results (two read_skill_reference calls are two different playbooks), and collapsing them to the
  // last payload would quietly test a run that never happens.
  const queues = new Map<string, JsonObject[]>();
  for (const step of script) queues.set(step.tool, [...(queues.get(step.tool) ?? []), step.data]);
  for (const [name, payloads] of queues) {
    const pending = [...payloads];
    tools.register({ name, description: "d", category: "non_trading", inputSchema: { type: "object" },
      execute: async () => ({ summary: `${name} ok`,
        generation_context: { data: pending.length > 1 ? pending.shift()! : pending[0]! } }) });
  }

  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  const thread = state.openThread(agent);
  const dispatch = state.recordDispatch(agent, "value AMZN", thread);

  await new SubagentRuntime(new ModelRouter(provider), tools).run(definition, {
    sessionId: "s", agentId: "agent-1", taskId: dispatch.event_id,
    request: { agent, task: "value AMZN" },
    allowedTools: [...queues.keys()].map((name) => {
      const { execute: _execute, ...rest } = tools.get(name)!;
      return rest;
    }),
    state, threadId: thread,
  });
  return sent;
}

/** Everything below the system block, as the model reads it. */
const promptOf = (messages: LlmMessage[]) => messages.slice(1).map((message) => message.content).join("");
const cachedBlocks = (messages: LlmMessage[]) => messages.filter((message) => message.cache === true);

/**
 * Two properties every agent in the pipeline must hold, whatever its projection — checked on the
 * last two steps, which is where it matters and where the comparison is meaningful.
 *
 * It has to be the last two: a step that reads a NEW playbook inserts bytes into the middle-front of
 * financial_modeling's projection (`skill_references` is rendered before everything that grows), so
 * it legitimately invalidates the earlier cut. That is the projection working as designed — the
 * ordering comment on `projectFinancialModelData` puts never-changes first precisely so this is rare
 * — not a boundary that moved on its own.
 */
function assertStableInjection(sent: LlmMessage[][], step: number, needle: RegExp): void {
  const current = sent[step]!;
  const previous = sent[step - 1]!;
  assert.match(promptOf(current), needle, "the earlier step's tool data reached this prompt");
  // The step counter is volatile; anything above it in the region must not be.
  const region = promptOf(current);
  assert.ok(region.indexOf(`(you are at step ${step + 1}`) > region.search(needle),
    "the step budget line renders below the progress region, not inside it");
  // Whatever the previous step cached must arrive byte-identical, or its entry is rewritten.
  for (let i = 2; i < Math.min(current.length, previous.length) - 1; i += 1) {
    assert.equal(current[i]!.content, previous[i]!.content, `block ${i} moved between steps`);
  }
  assert.ok(cachedBlocks(current).length <= 4, "Anthropic allows four breakpoints");
}

test("financial_modeling: a playbook read and a subagent report reach the next step's prompt", async () => {
  const sent = await drive("financial_modeling", [
    { tool: "read_skill_reference", data: { skill: "dcf-modeling", path: "02-unification.md",
      content: `UNIFICATION PLAYBOOK\n${"guidance line\n".repeat(1200)}` } },
    { tool: "run_dcf_subagent", data: { subagent: "statement_unification",
      account: "unified 76 row(s) over 5 period(s)", ...bulk("unified", 120) } },
    { tool: "read_skill_reference", data: { skill: "dcf-modeling", path: "03-spine-and-commit.md",
      content: `SPINE PLAYBOOK\n${"commit guidance\n".repeat(1200)}` } },
    { tool: "run_dcf_subagent", data: { subagent: "spine_mapping",
      account: "mapped 61 row(s) onto the spine", ...bulk("mapped", 120) } },
  ]);

  // The playbook body must survive into later steps — this projection drops it once, and the agent
  // then re-reads the same file every step.
  assert.match(promptOf(sent[4]!), /UNIFICATION PLAYBOOK/);
  assert.match(promptOf(sent[4]!), /SPINE PLAYBOOK/, "both playbooks, not just the latest");
  // The seam between agents: what the delegated subagent reported is the orchestrator's only view
  // of that work, and it rides in on run_dcf_subagent's data.
  assert.match(promptOf(sent[4]!), /unified 76 row\(s\) over 5 period\(s\)/);
  assertStableInjection(sent, 4, /UNIFICATION PLAYBOOK/);
});

test("statement_unification: the concept inventory reaches the next step's prompt", async () => {
  const sent = await drive("statement_unification", [
    { tool: "load_concept_inventory", data: bulk("inventory", 150) },
    { tool: "list_dimension_axes", data: bulk("axes", 150) },
    { tool: "patch_unification_decision", data: bulk("patched", 150) },
  ]);

  assert.match(promptOf(sent[3]!), /\[load_concept_inventory\] \{/, "injected as structured data, not as its summary");
  assert.match(promptOf(sent[3]!), /inventory_row_149/, "the whole payload, not a truncation");
  assertStableInjection(sent, 3, /inventory_row_0/);
});

test("spine_mapping: the loaded unified statements reach the next step's prompt", async () => {
  const sent = await drive("spine_mapping", [
    { tool: "load_unified_statements", data: bulk("unified", 150) },
    { tool: "load_spine_targets", data: bulk("targets", 150) },
    { tool: "patch_spine_mapping", data: bulk("mapped", 150) },
  ]);

  assert.match(promptOf(sent[3]!), /\[load_unified_statements\] \{/);
  assertStableInjection(sent, 3, /unified_row_0/);
});

/**
 * The cost consequence, stated as the property that actually pays: by the last step of a dispatch,
 * almost every byte the run has accumulated is inside a block the previous step already sent under
 * the same boundaries. That is what turns a re-sent region from full price into a cache read.
 */
test("by the last step, the bulk of the region is in blocks the previous step also sent", async () => {
  const sent = await drive("statement_unification", [
    { tool: "load_concept_inventory", data: bulk("inventory", 150) },
    { tool: "list_dimension_axes", data: bulk("axes", 150) },
    { tool: "patch_unification_decision", data: bulk("patched", 150) },
  ]);

  const last = sent[3]!;
  const carried = last.slice(2, -1).reduce((sum, message) => sum + message.content.length, 0);
  const fresh = last.at(-1)!.content.length;
  assert.ok(carried > fresh,
    `only ${carried} carried bytes against ${fresh} fresh ones — the region is being re-cut, not appended to`);
});

/**
 * The guard that would have caught the original defect directly, rather than through its cost.
 *
 * Two dispatches given the identical tool results must render the identical progress region, byte
 * for byte. Anything per-run or per-step that leaks into the region — a step counter, a timestamp,
 * a uuid, a duration — breaks this immediately, and breaks prompt caching for every agent at the
 * same time. Run it for all three, because each builds its region differently.
 */
for (const agent of ["financial_modeling", "statement_unification", "spine_mapping"] as const) {
  test(`${agent}: identical tool results render a byte-identical progress region`, async () => {
    const script = [
      { tool: agent === "financial_modeling" ? "run_dcf_subagent" : "load_unified_statements", data: bulk("first", 60) },
      { tool: agent === "financial_modeling" ? "financial_search" : "load_spine_targets", data: bulk("second", 60) },
    ];

    const [runA, runB] = await Promise.all([drive(agent, script), drive(agent, script)]);
    const regionOf = (messages: LlmMessage[]) => progressRegion(promptOf(messages));

    assert.equal(regionOf(runB[2]!), regionOf(runA[2]!),
      "the same work rendered differently twice — something per-run or per-step is inside the region");
  });
}

/**
 * The step note is the only thing that survives between steps — a subagent's own reasoning does not,
 * and on DeepSeek the reasoning stream is discarded outright. A note that only says where the run
 * stands lets the next step re-derive the same standing and act on none of it: one AMZN run wrote
 * six consecutive notes all saying "resuming at revision 3, the blocker is gross_profit" and issued
 * six reads without a single write. An expectation makes the drift visible to the agent itself.
 */
test("every subagent's note contract asks for the next step, not just this one", async () => {
  const prompts = await import("../../agent/prompts/subagentPrompts.ts");
  const templates = Object.values(prompts).filter((value) =>
    typeof value === "object" && value !== null && "system" in value);

  assert.ok(templates.length >= 6, `only found ${templates.length} prompt templates`);
  for (const template of templates) {
    if (!template.system.includes("ONE short line of text")) continue;
    assert.match(template.system, /what you expect to do next/,
      "a note that never states an intention cannot show the next step that it drifted");
  }
});
