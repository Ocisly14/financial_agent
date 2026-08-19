// Delegation smoke — proves the registered topology can actually delegate, with the real LLM.
//
// Three checks, cheapest first:
//   1. Guards (no LLM): an edge the topology never granted is refused; a cycle is refused.
//   2. Tool-level (real LLM, one agent): delegate_to_agent → market_research runs a real research
//      round and returns summary-only, with a thread id.
//   3. Nested (real LLM, both layers): financial_modeling is dispatched with its pool narrowed to
//      delegate_to_agent, so its only possible move is the delegation — proving the roster gate,
//      the {{delegates}} prompt, the nested Dispatcher path, and the summary return end to end.
//   4. Full chain (real LLM, three layers): the ORCHESTRATOR decides, with its full freedom and
//      financial_modeling's full pool — user message → orchestrator → financial_modeling →
//      market_research — and the run must end with the answer AND zero model mutations.
//
// Usage:
//   node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/smoke/delegation-smoke.ts
//   node --env-file=.env ... scripts/smoke/delegation-smoke.ts --tool-only   (guards + tool-level only)
import { createFinancialAgentApp } from "../../src/agent/createApp.ts";
import type { JsonObject } from "../../src/framework/types.ts";

const toolOnly = process.argv.includes("--tool-only");
const app = await createFinancialAgentApp();
const sessionId = `smoke-delegate-${Date.now()}`;
const TENANT = "smoke";
const state = await app.sessions.getOrCreate(sessionId);
state.beginTurn("delegation smoke");

const tool = app.toolRegistry.get("delegate_to_agent");
if (!tool) throw new Error("delegate_to_agent is not registered");
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "✔" : "✘"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// ── 1. guards: no tokens spent ─────────────────────────────────────────────
{
  const refused = await tool.execute({ agent: "market_data", task: "quote NVDA" },
    { sessionId, tenantId: TENANT, agentPath: "financial_modeling" });
  check(refused.error?.code === "agent_not_delegable",
    "an agent that never opted in is refused", refused.error?.code ?? refused.summary);

  const cycle = await tool.execute({ agent: "market_research", task: "loop" },
    { sessionId, tenantId: TENANT, agentPath: "financial_modeling>market_research" });
  check(cycle.error?.code === "delegation_cycle",
    "a call that would extend a chain onto itself is refused", cycle.error?.code ?? cycle.summary);
}

// ── 2. tool-level: one real research round ─────────────────────────────────
const RESEARCH_TASK = "Resolve NVIDIA's official SEC filer identity (CIK, exact registrant name) and the "
  + "filing date of its most recent 10-K, using SEC tools. Finish with one sentence stating both.";
{
  console.log("\n→ delegate_to_agent(market_research) with a real LLM …");
  const started = Date.now();
  const result = await tool.execute({ agent: "market_research", task: RESEARCH_TASK },
    { sessionId, tenantId: TENANT, agentPath: "financial_modeling" });
  const delegation = (result.generation_context?.data as JsonObject | undefined)?.["delegation"] as JsonObject | undefined;
  console.log(`  ${Math.round((Date.now() - started) / 1000)}s | status=${delegation?.["status"]} thread=${delegation?.["thread"]}`);
  console.log(`  summary: ${String(delegation?.["summary"] ?? result.summary).slice(0, 300)}`);
  check(delegation?.["status"] === "ok", "the delegated round completed");
  check(typeof delegation?.["thread"] === "string", "a thread id came back for continuation");
  check(delegation?.["data"] === undefined, "summary-only: no raw tool payloads crossed back");
  check(/NVIDIA|NVDA|0001045810/i.test(String(delegation?.["summary"] ?? "")),
    "the summary actually answers the question");
}

// ── 3. nested: financial_modeling delegates, for real ──────────────────────
if (!toolOnly) {
  console.log("\n→ financial_modeling → delegate_to_agent → market_research, both layers on the real LLM …");
  const dispatcher = app.createDispatcher(sessionId, TENANT, state);
  dispatcher.setUserInputAllowed(false);
  const started = Date.now();
  const { result, threadId } = await dispatcher.runOne({
    agent: "financial_modeling",
    task: "Do NOT build or touch any financial model. Use delegate_to_agent to ask market_research: "
      + `"${RESEARCH_TASK}" Then finish, quoting what it reported and the thread id it ran on.`,
    // The pool narrowed to the one capability under test: the agent's only possible move is the
    // delegation, so the run proves the roster gate + prompt + nested path rather than a DCF.
    tools: ["delegate_to_agent"],
    timeout_ms: 6 * 60_000,
  });
  console.log(`  ${Math.round((Date.now() - started) / 1000)}s | status=${result.status} (dcf thread ${threadId})`);
  console.log(`  finish summary: ${result.summary.slice(0, 300)}`);
  check(result.status === "ok", "the caller's round completed");

  const events = state.allEvents();
  const nestedDispatch = events.find((e) => e.kind === "dispatch" && e.payload["agent"] === "market_research");
  check(Boolean(nestedDispatch), "a dispatch → market_research was recorded on the main thread");
  const nestedResult = events.find((e) => e.kind === "task_result"
    && e.parent_event_id === nestedDispatch?.event_id);
  check(nestedResult?.payload["status"] === "ok", "the nested round wrote its own task_result");
  const delegationToolResult = events.find((e) => e.kind === "tool_result"
    && e.payload["name"] === "delegate_to_agent" && e.payload["error"] === undefined);
  check(Boolean(delegationToolResult), "the caller received the delegation payload in its own transcript");
}

// ── 4. full chain: orchestrator → financial_modeling → market_research ─────
if (!toolOnly) {
  console.log("\n→ full chain: user message → orchestrator → financial_modeling → market_research …");
  const chainSession = `${sessionId}-chain`;
  await app.sessions.getOrCreate(chainSession);
  const started = Date.now();
  const { response } = await app.orchestrator.run({
    sessionId: chainSession,
    tenantId: TENANT,
    // No pool narrowing this time: financial_modeling has everything, and only the instructions
    // keep it off the model tools. That is the honest test — the real system runs this way.
    userMessage: "Route this through the DCF agent, deliberately: dispatch financial_modeling with this "
      + "exact instruction: 'Do NOT create, load, or modify any financial model. Use delegate_to_agent "
      + "to ask market_research for NVIDIA's official SEC filer identity (CIK and exact registrant name) "
      + "and the filing date of its most recent 10-K, then finish by quoting its answer.' "
      + "Do not dispatch market_research yourself — the point of this request is to exercise "
      + "financial_modeling's own delegation. Then give me what came back.",
    allowUserInput: false,
  });
  const chainState = app.sessions.getExisting(chainSession);
  const events = chainState.allEvents();
  console.log(`  ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  final reply: ${response.slice(0, 300)}`);

  const fmDispatch = events.find((e) => e.kind === "dispatch" && e.payload["agent"] === "financial_modeling");
  check(Boolean(fmDispatch), "the orchestrator dispatched financial_modeling");
  // The layer seam: only the MIDDLE agent could have written this event.
  const fmDelegates = events.find((e) => e.kind === "tool_use"
    && e.source === "financial_modeling" && e.payload["name"] === "delegate_to_agent");
  check(Boolean(fmDelegates), "financial_modeling itself issued the delegate_to_agent call");
  const mrDispatch = events.find((e) => e.kind === "dispatch" && e.payload["agent"] === "market_research");
  const mrResult = events.find((e) => e.kind === "task_result" && e.parent_event_id === mrDispatch?.event_id);
  check(mrResult?.payload["status"] === "ok", "market_research completed at the bottom of the chain");
  const fmResult = events.find((e) => e.kind === "task_result" && e.parent_event_id === fmDispatch?.event_id);
  check(fmResult?.payload["status"] === "ok", "financial_modeling completed in the middle");
  const modelTouches = events.filter((e) => e.kind === "tool_use"
    && ["create_financial_model", "apply_financial_model_operations", "archive_financial_model",
      "extract_filing_statements"].includes(String(e.payload["name"])));
  check(modelTouches.length === 0, "no model was created or mutated anywhere in the chain",
    modelTouches.map((e) => String(e.payload["name"])).join(","));
  check(/0001045810|NVIDIA CORP/i.test(response), "the answer survived two relays back to the user");
}

console.log(failures === 0 ? "\nPASS — the topology delegates." : `\nFAIL — ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
