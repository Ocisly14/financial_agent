// End-to-end capability test for the DCF Agent (`financial_modeling`).
//
// Unlike step1-8, which hand-build the data foundation and only hand the agent the last mile, this
// script injects ONE prompt and lets the agent do everything itself: extract the filings, delegate
// statement_unification and spine_mapping through run_dcf_subagent, author the forecast, complete
// the WACC sheet and terminal assumptions, and advance the model to `valued`. The script makes no
// modeling choice of its own — it only dispatches, records, and reports.
//
// EVERY step lands on disk as it happens (append-only, synchronous writes), so a run that is killed
// halfway still leaves a full trace to read:
//
//   <out>/run-config.json                  what was dispatched, against which provider and stores
//   <out>/events.jsonl                     every session event, in order, as it was recorded
//   <out>/notes.jsonl                      the agents' own step notes ("what I am doing and why")
//   <out>/steps/index.jsonl                one line per completed tool call — the quick scan
//   <out>/steps/NNNN-<agent>-<tool>.json   that call's full input, summary, error, generation_context
//   <out>/rounds/round-N.json              each dispatch: task text, result, lifecycle/revision after
//   <out>/model/meta.json                  the model the agent created
//   <out>/model/revisions.json             every revision header + change summary (the audit chain)
//   <out>/model/final-snapshot.json        the finished workbook
//   <out>/model/source-review.json         extraction + unified statements the subagents stored
//   <out>/summary.json                     the verdict
//
// Usage:
//   node --env-file=.env --experimental-strip-types --experimental-sqlite \
//     scripts/xbrl/e2e_test/dcf-agent-e2e.ts [SYMBOL] [--fresh]
//
// Env: E2E_SYMBOL, E2E_AGENT_OUTPUT_DIR, E2E_SESSION_ID, E2E_MAX_ROUNDS, E2E_ROUND_TIMEOUT_MIN,
//      E2E_PROMPT (override the injected prompt), E2E_MODEL_DB_PATH + E2E_RESUME_MODEL_ID for a
//      clean-session continuation of an existing model, plus the usual LLM provider vars.
// Needs a live LLM provider and network access to SEC/EDGAR.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionEvent } from "../../../src/framework/sessionState.ts";
import type { TaskRequest, TaskResult } from "../../../src/framework/types.ts";

// ── configuration ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const fresh = argv.includes("--fresh");
const positional = argv.filter((arg) => !arg.startsWith("--"));
const symbol = (process.env["E2E_SYMBOL"]?.trim() || positional[0]?.trim() || "AAPL").toUpperCase();
const outputDirectory = resolve(process.env["E2E_AGENT_OUTPUT_DIR"]?.trim()
  || join("data", "e2e-test", "dcf-agent", symbol.toLowerCase()));
const sessionId = process.env["E2E_SESSION_ID"]?.trim() || `e2e-dcf-agent-${symbol.toLowerCase()}`;
const agentId = `e2e-dcf-agent-${symbol.toLowerCase()}`;
const resumeModelId = process.env["E2E_RESUME_MODEL_ID"]?.trim() || undefined;
const modelDatabasePath = resolve(process.env["E2E_MODEL_DB_PATH"]?.trim() || join(outputDirectory, "financial-models.sqlite"));
// One dispatch is capped at the agent's own 30-step budget, which a from-scratch DCF outgrows: the
// data foundation alone (extract → unify → spine) is several steps that each nest a whole subagent.
// The agent pauses with a resume line instead of failing, so the round loop just dispatches its own
// thread again — continuity is the thread, not the model handle.
const maxRounds = Number(process.env["E2E_MAX_ROUNDS"] ?? 6);
const roundTimeoutMs = Number(process.env["E2E_ROUND_TIMEOUT_MIN"] ?? 60) * 60_000;

const initialPrompt = process.env["E2E_PROMPT"]?.trim()
  || `Build me a DCF valuation model for ${symbol} `;

const continuationPrompt = process.env["E2E_CONTINUATION_PROMPT"]?.trim() || `Continue the ${symbol} DCF in this same thread. Read the model first to `
  + `see what is already filled, keep what holds, redo nothing, and complete only what is still `
  + `missing through to the valued stage.`;

if (fresh) {
  console.log(`# --fresh: removing ${outputDirectory}`);
  rmSync(outputDirectory, { recursive: true, force: true });
}
mkdirSync(join(outputDirectory, "steps"), { recursive: true });
mkdirSync(join(outputDirectory, "rounds"), { recursive: true });
mkdirSync(join(outputDirectory, "model"), { recursive: true });

// The stores are read from env lazily, at first use — so pointing them into this run's directory has
// to happen before the app is constructed, and the app is therefore imported dynamically below.
// Keeping them here (rather than in data/) means a run is self-contained and `--fresh` truly resets.
process.env["SESSION_DB_PATH"] = join(outputDirectory, "sessions.sqlite");
process.env["FINANCIAL_MODEL_DB_PATH"] = modelDatabasePath;

const { createFinancialAgentApp, resolveLlmProvider } = await import("../../../src/agent/createApp.ts");
const { getDefaultFinancialModelToolDeps } = await import("../../../mcp_tools/financial-model/financialModelTools.ts");
// A snapshot's `cells` is a Map, which JSON.stringify writes as `{}` — the one field a reader most
// needs from the dump would go missing silently. The codec's wire form is what the store persists,
// so the artifact on disk says exactly what the database says.
const { financialModelSnapshotCodec } = await import("../../../src/financial-model/snapshotCodec.ts");

const providerName = resolveLlmProvider().constructor.name;
if (providerName === "MockLlmProvider") {
  console.error("No LLM provider configured — this test drives the real agent loop and cannot run on the mock.\n"
    + "Set ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_VERTEX_PROJECT (or LLM_PROVIDER) and retry.");
  process.exit(2);
}

// ── disk sinks: written synchronously as events arrive, never buffered ───────
const write = (name: string, value: unknown): void =>
  writeFileSync(join(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
const append = (name: string, value: unknown): void =>
  appendFileSync(join(outputDirectory, name), `${JSON.stringify(value)}\n`, "utf8");

write("run-config.json", { symbol, sessionId, agentId, outputDirectory, modelDatabasePath, resumeModelId, provider: providerName,
  maxRounds, roundTimeoutMs, fresh, initialPrompt, continuationPrompt, startedAt: new Date().toISOString() });

console.log(`# DCF Agent end-to-end — ${symbol} via ${providerName} → ${outputDirectory}`);
console.log(`# prompt: ${initialPrompt.slice(0, 160)}…\n`);

const app = await createFinancialAgentApp();
const deps = getDefaultFinancialModelToolDeps();
const state = await app.sessions.getOrCreate(sessionId);

/**
 * One file per completed tool call. The pairing is by `tool_use_id` because a step may run several
 * calls in parallel and the nested mapping subagents write onto this same log — without the id, a
 * result would be filed under whichever call happened to be recorded last.
 */
const pending = new Map<string, { seq: number; agent: string; tool: string; input: unknown; at: number }>();
let stepSeq = 0;
const slug = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48);

state.subscribe((event: SessionEvent) => {
  append("events.jsonl", event);
  const payload = event.payload as Record<string, unknown>;

  if (event.kind === "subagent_note") {
    append("notes.jsonl", { at: event.timestamp, agent: event.source, thread: event.thread_id,
      step: payload["step"], note: payload["note"] });
    return;
  }
  if (event.kind === "tool_use") {
    const seq = ++stepSeq;
    const tool = String(payload["name"] ?? "unknown");
    pending.set(String(payload["tool_use_id"]), { seq, agent: String(event.source), tool, input: payload["input"], at: Date.now() });
    console.log(`  [${String(seq).padStart(4, "0")}] ${event.source} → ${tool}`);
    return;
  }
  if (event.kind !== "tool_result") return;

  const useId = typeof payload["tool_use_id"] === "string" ? payload["tool_use_id"] : undefined;
  const opened = useId ? pending.get(useId) : undefined;
  if (useId) pending.delete(useId);
  // A tool_result with no tool_use is a runtime nudge (seriality refusal, unparseable step): it never
  // had a call of its own, so it gets its own sequence number rather than being dropped.
  const seq = opened?.seq ?? ++stepSeq;
  const tool = opened?.tool ?? String(payload["name"] ?? "runtime");
  const record = {
    seq, agent: opened?.agent ?? String(event.source), tool,
    step: payload["step"] ?? null,
    thread: event.thread_id, task_id: payload["task_id"] ?? null,
    at: event.timestamp, ms: opened ? Date.now() - opened.at : null,
    input: opened?.input ?? null,
    summary: payload["summary"] ?? null,
    error: payload["error"] ?? null,
    generation_context: payload["generation_context"] ?? null,
  };
  write(join("steps", `${String(seq).padStart(4, "0")}-${slug(record.agent)}-${slug(tool)}.json`), record);
  append(join("steps", "index.jsonl"), { seq: record.seq, agent: record.agent, tool: record.tool,
    step: record.step, ms: record.ms, error: record.error,
    summary: typeof record.summary === "string" ? record.summary.slice(0, 300) : null });
  const failed = record.error ? ` ERROR ${(record.error as { code?: string }).code ?? ""}` : "";
  console.log(`  [${String(seq).padStart(4, "0")}] ${record.agent} ← ${tool}${failed}: `
    + `${String(record.summary ?? "").slice(0, 160).replace(/\n/g, " ")}`);
});

// ── the round loop: dispatch, record, continue the same thread ───────────────
// No human is watching this stream, so ask_user is taken off the pool — a question here would stall
// the run against an empty seat until the timeout. The agent's other judgment calls stay its own.
const dispatcher = app.createDispatcher(sessionId, agentId);
dispatcher.setUserInputAllowed(false);

const findModel = (): ReturnType<typeof deps.modelStore.list>[number] | undefined =>
  resumeModelId === undefined
    ? deps.modelStore.list({ ownerAgentId: agentId, symbol }).at(-1)
    : deps.modelStore.list({ ownerAgentId: agentId, symbol }).find((model) => model.modelId === resumeModelId);

state.beginTurn(initialPrompt);

let threadId: string | undefined;
let lastResult: TaskResult | undefined;
const rounds: Record<string, unknown>[] = [];

for (let round = 1; round <= maxRounds; round++) {
  const task = round === 1
    ? (resumeModelId === undefined ? initialPrompt
      : `Resume model ${resumeModelId} from its current revision. ${continuationPrompt}`)
    : continuationPrompt;
  const request: TaskRequest = { agent: "financial_modeling", task, timeout_ms: roundTimeoutMs,
    ...(threadId ? { thread: threadId } : {}),
    ...(resumeModelId === undefined ? {} : { model_id: resumeModelId }) };
  console.log(`\n## round ${round}/${maxRounds}${threadId ? ` (thread ${threadId})` : " (new thread)"}`);
  const startedAt = Date.now();
  const [dispatched] = dispatcher.dispatchAsync([request]);
  const taskId = dispatched!.task_id;
  threadId = state.allEvents().find((e) => e.event_id === taskId)?.payload["child_thread_id"] as string | undefined;
  // Slack over the per-round timeout so the dispatcher's own timeout result is what we read, rather
  // than racing it and reporting an await_timeout that hides the real one.
  const [result] = await dispatcher.awaitTask([taskId], roundTimeoutMs + 60_000);
  lastResult = result;

  const model = findModel();
  const entry = { round, taskId, threadId, task, elapsedMs: Date.now() - startedAt,
    status: result!.status, summary: result!.summary, error: result!.error ?? null, metrics: result!.metrics ?? null,
    modelId: model?.modelId ?? null, lifecycleAfter: model?.lifecycleStage ?? null,
    revisionAfter: model?.currentRevision ?? null };
  rounds.push(entry);
  write(join("rounds", `round-${round}.json`), entry);
  console.log(`   → ${result!.status} after ${(entry.elapsedMs / 1000).toFixed(0)}s; `
    + `model ${entry.modelId ?? "(none yet)"} rev ${entry.revisionAfter ?? "-"} (${entry.lifecycleAfter ?? "-"})`);
  console.log(`   summary: ${result!.summary.slice(0, 400)}`);

  if (model?.lifecycleStage === "valued") { console.log(`\n   valued at round ${round} — stopping.`); break; }
  // A hard failure is not something another round recovers from; a pause or an early finish short of
  // `valued` is, and continuing the thread is exactly how the agent is designed to be resumed.
  if (result!.status === "failed") { console.log(`\n   failed — stopping.`); break; }
  // A timeout is the one status the dispatcher synthesizes itself, without metrics — so `llm_calls`
  // reads 0 even for a round that worked the whole window. Nested subagents persist as they go, so
  // whatever the thread reached is on disk and the next round resumes from it; that is what the
  // round loop and `continuationPrompt` exist for. This must be read before the dead-provider check
  // below, which would otherwise take the missing metrics for a provider that was never reached.
  if (result!.status === "timeout") {
    console.log(`\n   timed out after ${(roundTimeoutMs / 60_000).toFixed(0)}min at lifecycle `
      + `"${entry.lifecycleAfter ?? "-"}" — resuming the thread in the next round.`);
    continue;
  }
  // A round that never reached the provider is reported as an ordinary step-budget pause (the loop
  // breaks on the LLM error with its "exhausted" flag still set). Left alone it would look like
  // progress and burn every remaining round against a dead provider, so read the metrics instead of
  // the summary: zero LLM calls means nothing happened.
  if ((result!.metrics?.["llm_calls"] ?? 0) === 0) {
    console.log(`\n   round made 0 LLM calls — the provider is unreachable, not the agent stalling. Stopping.`);
    break;
  }
}

// ── the model the agent built, as the record of what it actually did ─────────
const model = findModel();
let verdict: Record<string, unknown> = { pass: false, reason: "the agent never created a model" };

if (model) {
  const revision = deps.modelStore.getRevision(model.modelId)!;
  const snapshot = revision.snapshot;
  write(join("model", "meta.json"), model);
  write(join("model", "revisions.json"), deps.modelStore.listRevisionHeaders(model.modelId));
  write(join("model", "final-snapshot.json"), JSON.parse(financialModelSnapshotCodec.encode(snapshot)));
  const sourceReview = deps.sourceReviewStore.get(model.modelId);
  if (sourceReview) write(join("model", "source-review.json"), sourceReview);

  const wacc = snapshot.waccSheet?.rows.find((row) => row.rowId === "wacc")?.value ?? null;
  const valuation = snapshot.valuation as unknown as Record<string, Record<string, number>> | null;
  const assumptions = snapshot.assumptions.map((a) => ({ lineItemId: a.lineItemId,
    values: a.payload.kind === "values" ? a.payload.values : "n/a", sourceType: a.sourceType, rationale: a.rationale }));
  const customRows = snapshot.lineItems.filter((item) => item.id.startsWith("metric.custom."))
    .map((item) => ({ id: item.id, description: item.description }));

  console.log(`\n## Agent's assumptions (${assumptions.length})`);
  for (const a of assumptions) {
    console.log(`  ${a.lineItemId}: [${Array.isArray(a.values) ? a.values.join(", ") : a.values}] (${a.sourceType})`
      + ` — ${a.rationale.slice(0, 120)}`);
  }
  console.log(`\n## Agent's custom analysis rows (${customRows.length})`);
  for (const row of customRows) console.log(`  ${row.id} — ${(row.description ?? "").slice(0, 110)}`);
  console.log(`\nWACC: ${wacc === null ? "unresolved" : `${(wacc * 100).toFixed(2)}%`}`);
  if (valuation) {
    console.log(`Perpetuity: $${valuation["perpetuityGrowth"]?.["impliedValuePerShare"]?.toFixed(2)} /sh`
      + ` | Exit: $${valuation["exitMultiple"]?.["impliedValuePerShare"]?.toFixed(2)} /sh`);
  }

  verdict = snapshot.lifecycleStage === "valued" && valuation
    ? { pass: true, reason: `reached valued at revision ${revision.revision} in ${rounds.length} round(s)` }
    : { pass: false, reason: `stopped at lifecycle "${snapshot.lifecycleStage}" after ${rounds.length} round(s)` };
  Object.assign(verdict, { modelId: model.modelId, revision: revision.revision,
    lifecycle: snapshot.lifecycleStage, wacc, valuation,
    assumptionCount: assumptions.length, customRowCount: customRows.length });
}

write("summary.json", { ...verdict, symbol, sessionId, threadId, provider: providerName,
  toolCalls: stepSeq, rounds, finalSummary: lastResult?.summary ?? null, finishedAt: new Date().toISOString() });

console.log(`\nArtifacts: ${outputDirectory}`);
if (verdict["pass"]) {
  console.log(`**PASS** — ${verdict["reason"]}.`);
} else {
  console.log(`**FAIL** — ${verdict["reason"]}.`);
  process.exit(1);
}
