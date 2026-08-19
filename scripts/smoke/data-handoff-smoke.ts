/**
 * Smoke test for the dispatch data handoff, against a real model.
 *
 * The unit tests prove the plumbing: given ids, the data reaches the prompt.
 * They cannot prove the part that only a real model does — that it recognises
 * an id on a result line and puts it in the next dispatch. So this drives two
 * real turns through the real orchestrator prompt and checks what the second
 * dispatch actually carried.
 *
 * Tools are stubbed, deliberately: the number handed over has to be one no
 * model could produce from memory, or "it appeared in the prompt" proves
 * nothing. Everything else — prompts, registry, dispatcher, subagent loop — is
 * the production wiring.
 *
 * Run with:
 *   LLM_PROVIDER=deepseek node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/smoke/data-handoff-smoke.ts
 *
 * Any real provider works; it costs ~9 model calls. Falls back to whatever
 * LLM_PROVIDER names, so leaving it unset runs against the configured default.
 */

import { Dispatcher } from "../../src/framework/dispatcher.ts";
import { OrchestratorRuntime } from "../../src/framework/orchestrator.ts";
import { SessionRegistry, type SessionState } from "../../src/framework/sessionState.ts";
import { SkillRegistry } from "../../src/framework/skill.ts";
import { SubagentRuntime } from "../../src/framework/subagent.ts";
import { ModelRouter, type GenerateOptions, type GenerateResult, type LlmMessage, type LlmProvider } from "../../src/infra/llm/provider.ts";
import { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import { orchestratorPrompt } from "../../src/agent/prompts/orchestratorPrompt.ts";
import { resolveLlmProvider } from "../../src/agent/createApp.ts";
import { createSubagentRegistry } from "../../src/agent/subagents/registerSubagents.ts";

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";

/** The figure that has to survive the trip. No model knows it; only the stub emits it. */
const INVENTORY_UNITS = 41_337_211;
const CHANNEL_DATA = {
  ticker: "AAPL",
  as_of: "2026-08-14",
  channel_inventory_units: INVENTORY_UNITS,
  days_on_hand: 63.4,
  note: "distributor sell-in minus sell-through, internal channel feed",
};

type Call = { mode: string; agent?: string; prompt: string; text: string };

/** Every call the run made, with the user half of what was sent. */
const calls: Call[] = [];

function capturing(inner: LlmProvider): LlmProvider {
  return {
    name: inner.name,
    async generate(messages: LlmMessage[], options: GenerateOptions): Promise<GenerateResult> {
      const result = await inner.generate(messages, options);
      const meta = options.metadata ?? {};
      calls.push({
        mode: String(meta["mode"] ?? "orchestrator"),
        agent: typeof meta["agent"] === "string" ? meta["agent"] : undefined,
        prompt: messages.filter((m) => m.role === "user").map((m) => m.content).join(""),
        text: result.text,
      });
      return result;
    },
  };
}

async function main(): Promise<void> {
  const subagents = createSubagentRegistry();
  const tools = new McpToolRegistry();
  // One stub per tool the two agents can reach. market_research's tools all
  // return the channel payload so the test does not depend on which one the
  // agent picks; market_data's return something inert.
  const research = new Set(subagents.get("market_research").defaultTools);
  for (const agent of ["market_research", "market_data"] as const) {
    for (const name of subagents.get(agent).defaultTools) {
      if (tools.get(name)) continue;
      const data = research.has(name) ? CHANNEL_DATA : { ticker: "AAPL", last: 231.19, change_pct: 0.4 };
      tools.register({ name, description: "stubbed for smoke test", category: "non_trading",
        inputSchema: { type: "object" },
        execute: async () => ({ summary: `${name} ok`, generation_context: { data } }) });
    }
  }

  const router = new ModelRouter(capturing(resolveLlmProvider()));
  const sessions = new SessionRegistry();
  const subagentRuntime = new SubagentRuntime(router, tools);
  const orchestrator = new OrchestratorRuntime(
    orchestratorPrompt, router,
    (sessionId, tenantId, state?: SessionState) =>
      new Dispatcher(sessionId, subagents, subagentRuntime, tools, state ?? sessions.getExisting(sessionId), tenantId),
    subagents, new SkillRegistry(), tools, sessions,
  );

  const sessionId = `smoke-handoff-${Date.now()}`;
  const run = (userMessage: string) => orchestrator.run({ sessionId, tenantId: "smoke", userMessage, allowUserInput: false });

  console.log(`${BOLD}Dispatch data handoff — live model smoke test${RESET}`);
  console.log(`${DIM}provider=${process.env["LLM_PROVIDER"] ?? "(unset)"} session=${sessionId}${RESET}\n`);

  console.log(`${BOLD}Turn 1${RESET} — 帮我查一下 AAPL 最新的渠道库存数据。`);
  const first = await run("帮我查一下 AAPL 最新的渠道库存数据。");
  console.log(`${DIM}${first.response.slice(0, 300)}${RESET}\n`);
  const afterFirst = calls.length;

  console.log(`${BOLD}Turn 2${RESET} — 把刚才那份渠道库存数据交给行情侧的同事，让他们结合 AAPL 的价格一起看，他们需要拿到完整的库存数字。`);
  const second = await run("把刚才那份渠道库存数据交给行情侧的同事，让他们结合 AAPL 的价格一起看，他们需要拿到完整的库存数字。");
  console.log(`${DIM}${second.response.slice(0, 300)}${RESET}\n`);

  const turn1 = calls.slice(0, afterFirst);
  const turn2 = calls.slice(afterFirst);
  const state = sessions.getExisting(sessionId);
  const turn2Orchestrator = turn2.filter((c) => c.mode !== "subagent");
  const handed = turn2.filter((c) => c.mode === "subagent" && c.prompt.includes("[DATA HANDED TO YOU]"));

  const results: { label: string; ok: boolean; detail?: string }[] = [
    {
      label: "turn 1 dispatched a subagent, and it was handed nothing (there was nothing to hand)",
      ok: turn1.some((c) => c.mode === "subagent") && !turn1.some((c) => c.prompt.includes("[DATA HANDED TO YOU]")),
    },
    {
      label: "the id was visible to the orchestrator on turn 2",
      ok: turn2Orchestrator.some((c) => c.prompt.includes("source_event_id=")),
      detail: "no source_event_id= in the orchestrator's prompt — it had no id to pass",
    },
    {
      label: "the model put an id on its turn-2 dispatch, and the data was rendered into that subagent's prompt",
      ok: handed.length > 0,
      detail: `turn-2 subagent calls: ${turn2.filter((c) => c.mode === "subagent").map((c) => c.agent).join(", ") || "none"}`,
    },
    {
      label: `the handed data arrived verbatim (${INVENTORY_UNITS} present, untyped by any model)`,
      ok: handed.some((c) => c.prompt.includes(String(INVENTORY_UNITS))),
    },
    {
      label: "the receiving agent was not the one that produced the data",
      ok: handed.some((c) => c.agent !== "market_research"),
      detail: `handed to: ${handed.map((c) => c.agent).join(", ") || "nobody"}`,
    },
  ];

  console.log(`${BOLD}Checks${RESET}`);
  for (const r of results) {
    console.log(r.ok ? `${GREEN}✔${RESET} ${r.label}` : `${RED}✘${RESET} ${r.label}${r.detail ? `\n   ${DIM}${r.detail}${RESET}` : ""}`);
  }

  const handedBlock = handed[0]?.prompt.match(/\[DATA HANDED TO YOU\][\s\S]{0,420}/)?.[0];
  if (handedBlock) console.log(`\n${BOLD}What the receiving agent actually saw${RESET}\n${DIM}${handedBlock}${RESET}`);
  if (state) {
    const dispatches = state.projectForPrompt(state.currentTurn).currentTurnProgress
      .split("\n").filter((line) => line.startsWith("[dispatch"));
    if (dispatches.length > 0) console.log(`\n${BOLD}Turn-2 dispatches${RESET}\n${DIM}${dispatches.join("\n")}${RESET}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? GREEN + "all checks passed" : RED + failed + " check(s) failed"}${RESET} ${DIM}(${calls.length} model calls)${RESET}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
