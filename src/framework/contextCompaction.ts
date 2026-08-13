// src/framework/contextCompaction.ts
import { createLogger } from "../infra/logger/logger.ts";
import type { ModelRouter } from "../infra/llm/provider.ts";
import type { AgentKind, GenerationContext, JsonObject, JsonValue } from "./types.ts";
import type { PreservedDataEntry } from "./eventStore.ts";
import type { SessionState } from "./sessionState.ts";

const log = createLogger("compaction");

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Counts of turns and rounds index into event lists, so a fractional override
 *  would not mean "keep two and a half" — it would mean comparisons no turn
 *  number can satisfy. Reject it rather than silently mis-slice history. */
function envCount(name: string, fallback: number): number {
  const parsed = envNumber(name, fallback);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export const ORCHESTRATOR_CONTEXT_WINDOW_TOKENS = envNumber("ORCHESTRATOR_CONTEXT_WINDOW_TOKENS", 200_000);

export const COMPACTION_THRESHOLD_RATIO = envNumber("COMPACTION_THRESHOLD_RATIO", 0.6);

export const COMPACTION_KEEP_RECENT_TURNS = envCount("COMPACTION_KEEP_RECENT_TURNS", 3);

/**
 * The summary carries the NARRATIVE of the compacted turns. What each task
 * produced is not in here: that is merged deterministically into
 * [DATA FROM EARLIER TASKS], because a SMALL model retyping model ids,
 * revisions and figures would make the compacted context less trustworthy than
 * the original facts.
 */
const COMPACTION_SYSTEM_PROMPT = `You are compacting a long conversation between a user and a broad financial-market research, US stock and ETF analysis, and paper/shadow strategy agent.
Given the existing summary (if any) and the new conversation turns below, produce an updated summary under exactly these headings:

1. Primary Request and Intent: every explicit request the user has made, in their own terms.
2. Current Intent: what the user most recently wants. Be specific about what would count as done.
3. Timeline: the chronological sequence of what was asked, dispatched, and concluded — one line per event.
4. Key Analysis Concepts: the methods, assumptions and conventions in force (discount rates, growth assumptions, comparable sets, accounting adjustments, date ranges).
5. Errors and Fixes: what went wrong and how it was resolved. Call out anything the user corrected you on.
6. Problem Solving: problems settled, and any still open.
7. All User Messages: list every user message, condensed but complete. Do not drop any.

Rules:
- Merge repetition. If the same thing was said, asked or concluded several times, write it once.
- Cut filler: acknowledgements, restatements, narration of what you were about to do.
- Do not restate numeric data points (prices, indicator values, balances, revisions, ids). Those are preserved exactly elsewhere and paraphrasing them here would corrupt them.
- Preserve verbatim any constraint the user imposed on how to work.
Respond with the summary text only, no preamble.`;

const PRESERVED_SUMMARY_CHARS = 700;
const PRESERVED_SHAPE_FIELDS = 24;

/**
 * A nested block small enough to keep whole. This is what separates a computed
 * FACT SHEET from a SERIES: `daily.stats` (52-week high, drawdown, sma50) is
 * 334 characters on a 250-bar payload, while `daily.trend` — 120 downsampled
 * closes — is 1,551. The first is what a later turn quotes; the second is shape,
 * and shape is what `data_shape` plus a `read_compacted_task_data` call is for.
 */
const PRESERVED_BLOCK_CHARS = 600;

/**
 * Total verbatim budget per index.
 *
 * Deliberately a character budget and not a field count: counting fields is what
 * made this selection backwards. `get_stock_price` opens with eleven top-level
 * quote scalars (bid, ask, dayOpen…), so a twelve-FIELD cap was spent before
 * reaching `daily.stats` — the index kept the quote, which is stale four turns
 * later, and dropped the computed statistics, which are not.
 */
const PRESERVED_VALUES_CHARS = 1_200;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function valueShape(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).length})`;
  return typeof value;
}

/**
 * The durable event log retains the complete generation context.  The rolling
 * prompt must retain only a small, deterministic index pointing back to it:
 * having a SMALL model paraphrase financial values would make the compacted
 * context less trustworthy than the original facts.
 */
/**
 * Everything worth keeping verbatim, keyed by the dot path that would fetch it
 * back. Scalars and small computed blocks are kept; series and anything too big
 * are left to `data_shape`.
 *
 * Descends one level, which is where the derived figures live: a tool hands back
 * `{ symbol, price, daily: { recentBars, trend, stats } }`, so the statistics
 * this agent will actually quote later are never at the top.
 */
function preservedValues(raw: JsonObject): JsonObject {
  const values: JsonObject = {};
  let used = 0;
  const take = (path: string, value: JsonValue): void => {
    const cost = path.length + JSON.stringify(value).length + 4;
    if (used + cost > PRESERVED_VALUES_CHARS) return;
    values[path] = typeof value === "string" ? truncate(value, 180) : value;
    used += cost;
  };

  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object") {
      take(key, value);
    } else if (Array.isArray(value)) {
      continue; // a series: its length is in data_shape, its contents are a read away
    } else if (JSON.stringify(value).length <= PRESERVED_BLOCK_CHARS) {
      take(key, value);
    } else {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (Array.isArray(childValue)) continue;
        if (childValue !== null && typeof childValue === "object"
          && JSON.stringify(childValue).length > PRESERVED_BLOCK_CHARS) continue;
        take(`${key}.${childKey}`, childValue);
      }
    }
  }
  return values;
}

export function compactTaskResultData(event: {
  event_id: string;
  parent_event_id: string | null;
  payload: JsonObject;
}): JsonObject {
  const context = event.payload.generation_context as GenerationContext | undefined;
  const raw = context?.data ?? {};
  const shape: JsonObject = {};
  for (const [key, value] of Object.entries(raw).slice(0, PRESERVED_SHAPE_FIELDS)) shape[key] = valueShape(value);
  const values = preservedValues(raw);

  const data: JsonObject = {
    kind: "task_result_index",
    source_event_id: event.event_id,
    ...(event.parent_event_id ? { task_id: event.parent_event_id } : {}),
    status: typeof event.payload.status === "string" ? event.payload.status : "unknown",
    summary: truncate(String(event.payload.summary ?? ""), PRESERVED_SUMMARY_CHARS),
    data_keys: Object.keys(raw).slice(0, PRESERVED_SHAPE_FIELDS),
    data_shape: shape,
  };
  if (Object.keys(values).length > 0) data.values = values;
  return data;
}

/** Which entity a task result is ABOUT, when it says so itself. Read only from
 *  the scalar fields the index already extracted, so this stays a lookup rather
 *  than a second guess at the payload. */
function entityOf(data: JsonObject): string {
  const values = (data.values ?? data.scalar_fields ?? {}) as JsonObject;
  for (const field of ["model_id", "symbol", "strategy_id"]) {
    const value = values[field];
    if (typeof value === "string" && value !== "") return `${field}=${value}`;
  }
  return "";
}

/**
 * The same agent producing the same shape for the same entity is ONE thing that
 * happened N times, not N things — nine rounds on one DCF, twelve refreshes of
 * one quote. Left unmerged the index grows with the turn count and eventually
 * costs more than the history it replaced, and the model has to work out for
 * itself which of nine revisions is current.
 *
 * Merging is mechanical, never the summarizer's job: it keeps the newest
 * production's shape and pointer verbatim and adds a count. Rows whose
 * `data_keys` differ are different work and never merge.
 */
function mergePreserved(entries: PreservedDataEntry[]): PreservedDataEntry[] {
  const byKey = new Map<string, PreservedDataEntry>();
  const seenEvents = new Set<string>();
  for (const entry of entries) {
    if (entry.sourceEventId) {
      if (seenEvents.has(entry.sourceEventId)) continue;
      seenEvents.add(entry.sourceEventId);
    }
    const keys = Array.isArray(entry.data.data_keys) ? entry.data.data_keys.join(",") : "";
    const key = `${entry.agent}|${entityOf(entry.data)}|${keys}`;
    const prior = byKey.get(key);
    const calls = typeof prior?.data.calls === "number" ? prior.data.calls + 1 : 1;
    const firstTurn = prior ? (prior.data.first_turn as number | undefined) ?? prior.turn : entry.turn;
    byKey.delete(key); // re-insert so Map order tracks recency
    byKey.set(key, { ...entry, data: { ...entry.data, calls, first_turn: firstTurn } });
  }
  return [...byKey.values()];
}

export async function compact(
  state: SessionState,
  modelRouter: ModelRouter,
  from: number,
  targetThrough: number,
): Promise<void> {
  const turnLines: string[] = [];
  const newPreserved: PreservedDataEntry[] = [];

  for (const e of state.allEvents()) {
    if (e.thread_id !== state.mainThread || e.turn < from || e.turn > targetThrough) continue;

    if (e.kind === "user_message") {
      turnLines.push(`Turn ${e.turn}:\nUser: ${e.payload.content as string}`);
    } else if (e.kind === "reply" && e.payload.final === true) {
      turnLines.push(`You: ${e.payload.content as string}`);
    } else if (e.kind === "dispatch") {
      // Who was asked to do what is part of the account of a turn — the prompt
      // projection shows these lines, so a summary without them reads as if the
      // answers arrived from nowhere.
      turnLines.push(`[dispatch → ${e.payload.agent as string}] ${e.payload.task as string}`);
    } else if (e.kind === "task_result") {
      const gc = e.payload.generation_context as GenerationContext | undefined;
      if (gc?.data) newPreserved.push({
        turn: e.turn,
        agent: e.source,
        sourceEventId: e.event_id,
        data: compactTaskResultData(e),
      });
    }
  }

  const prior = state.compactionCache();
  const userContent = prior?.summaryText
    ? `Existing summary:\n${prior.summaryText}\n\nNew conversation turns:\n${turnLines.join("\n")}`
    : `New conversation turns:\n${turnLines.join("\n")}`;

  const completion = await modelRouter.generate(
    [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    { modelClass: "SMALL", temperature: 0.2, metadata: { mode: "compaction" } },
  );

  // The summary is the ONLY copy of these turns once the events are dropped, and
  // it is written over the previous summary, so an empty completion would erase
  // history in both directions at once. A compaction that produced nothing to
  // remember is not worth the turns it costs.
  const summaryText = completion.text.trim();
  if (summaryText === "") throw new Error("compaction produced an empty summary");

  // Apply only once the write that makes it durable has succeeded. A cache
  // installed over events that were never dropped renders the same history
  // twice — summary AND source — which grows the prompt that compaction was
  // called to shrink.
  state.setCompactionCache({
    summarizedThroughTurn: targetThrough,
    summaryText,
    preservedData: mergePreserved([...(prior?.preservedData ?? []), ...newPreserved]),
  });
  try {
    await state.persistCompactionCache();
  } catch (error) {
    state.setCompactionCache(prior);
    throw error;
  }
  state.compactEvents(targetThrough);
}

/**
 * Compact if the last prompt crossed the threshold.
 *
 * Compaction is an optimization on the way into a prompt, never a step the turn
 * depends on: the summarizer is a separate model call and the persist is a
 * separate database write, and neither failing says anything about the request
 * the user actually made. So a failure here is logged and the turn proceeds on
 * the uncompacted history — which is complete, merely larger.
 */
export async function maybeCompact(state: SessionState, modelRouter: ModelRouter, currentTurn: number): Promise<void> {
  const lastTokens = state.lastPromptTokensIn();
  if (lastTokens === undefined) return;

  const ratio = lastTokens / ORCHESTRATOR_CONTEXT_WINDOW_TOKENS;
  if (ratio < COMPACTION_THRESHOLD_RATIO) return;

  const targetThrough = currentTurn - 1 - COMPACTION_KEEP_RECENT_TURNS;
  const from = (state.compactionCache()?.summarizedThroughTurn ?? 0) + 1;
  if (from > targetThrough) return;

  try {
    await compact(state, modelRouter, from, targetThrough);
  } catch (error) {
    log.warn("session compaction failed; continuing on uncompacted history", {
      session_id: state.session_id, from, targetThrough,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** How much replayed thread history a subagent may carry into one prompt,
 *  measured in characters of rendered [PROGRESS SO FAR]. */
export const THREAD_PROGRESS_CHAR_BUDGET = envNumber("THREAD_PROGRESS_CHAR_BUDGET", 40_000);

/** Rounds left verbatim at the tail when a thread is folded. The current round
 * always counts as one, so the default keeps it and one prior round raw. */
export const THREAD_KEEP_RECENT_ROUNDS = envCount("THREAD_KEEP_RECENT_ROUNDS", 2);

const THREAD_COMPACTION_SYSTEM_PROMPT = `You are compacting the working history of a background analysis agent so it can keep going in a smaller context.
Summarize what it has established, what it tried that did not work, and any identifiers, handles, or figures a later step would need to avoid redoing the work.
Keep concrete values verbatim — model ids, revisions, tickers, dates, numbers. Drop narration.
Respond with the summary text only, no preamble.`;

/**
 * Fold the older rounds of one subagent thread into a summary note, once its
 * replayed history has outgrown the budget.
 *
 * The summary is written back into the log as an ordinary `subagent_note`
 * carrying `thread_summary: true`, which the trace projection treats as a
 * barrier: everything before it stops being replayed. Storing it as an event
 * rather than in the session's CompactionCache is deliberate — that cache is
 * per-session and indexed by turn, which is the wrong granularity for a thread
 * that spans turns, and an event survives a restart with no extra plumbing.
 */
export async function maybeCompactThread(
  state: SessionState,
  modelRouter: ModelRouter,
  agent: AgentKind,
  threadId: string,
  taskId: string,
): Promise<void> {
  const trace = state.subagentTraceEvents(threadId);
  const rendered = state.subagentProgressFromEvents(trace);
  if (rendered.length <= THREAD_PROGRESS_CHAR_BUDGET) return;

  // Select COMPLETE prior rounds from their task ids. In particular, never
  // fall back to splitting the current run halfway by character count: its
  // fresh tool evidence is exactly what the agent is still working from.
  const rounds: Array<{ taskId: string; start: number }> = [];
  for (const [index, event] of trace.entries()) {
    if (event.kind === "subagent_note" && event.payload.thread_summary === true) continue;
    const candidate = typeof event.payload.task_id === "string" ? event.payload.task_id : undefined;
    if (candidate && !rounds.some((round) => round.taskId === candidate)) rounds.push({ taskId: candidate, start: index });
  }
  const currentRound = rounds.findIndex((round) => round.taskId === taskId);
  if (currentRound <= 0) return;
  const firstKeptRound = Math.max(0, currentRound - (THREAD_KEEP_RECENT_ROUNDS - 1));
  const cut = rounds[firstKeptRound]!.start;
  if (cut <= 0) return;
  const older = state.subagentProgressFromEvents(trace.slice(0, cut));
  if (older.trim() === "") return;

  let summary: string;
  try {
    const completion = await modelRouter.generate(
      [
        { role: "system", content: THREAD_COMPACTION_SYSTEM_PROMPT },
        { role: "user", content: older },
      ],
      { modelClass: "SMALL", temperature: 0.2, metadata: { mode: "thread_compaction", agent } },
    );
    summary = completion.text.trim();
  } catch (error) {
    // Same rule as the session compactor: folding is how a long thread stays
    // affordable, not how it stays correct. Failing here would fail the round.
    log.warn("thread compaction failed; continuing on the unfolded thread", {
      thread_id: threadId, agent, error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // The barrier hides the rounds it replaces, so an empty note would delete them.
  if (summary === "") {
    log.warn("thread compaction produced an empty summary; leaving the thread unfolded", { thread_id: threadId, agent });
    return;
  }

  state.record(agent, "subagent_note", {
    task_id: taskId,
    step: 0,
    thread_summary: true,
    compacted_through_event_id: trace[cut - 1]!.event_id,
    note: `[earlier in this thread, summarized]\n${summary}`,
  }, { threadId });
}
