// src/framework/contextCompaction.ts
import type { ModelRouter } from "../infra/llm/provider.ts";
import type { AgentKind, GenerationContext } from "./types.ts";
import type { PreservedDataEntry } from "./eventStore.ts";
import type { SessionState } from "./sessionState.ts";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const ORCHESTRATOR_CONTEXT_WINDOW_TOKENS = envNumber("ORCHESTRATOR_CONTEXT_WINDOW_TOKENS", 200_000);

export const COMPACTION_THRESHOLD_RATIO = envNumber("COMPACTION_THRESHOLD_RATIO", 0.6);

export const COMPACTION_KEEP_RECENT_TURNS = envNumber("COMPACTION_KEEP_RECENT_TURNS", 3);

const COMPACTION_SYSTEM_PROMPT = `You are compacting a long conversation between a user and a broad financial-market research, US stock and ETF analysis, and paper/shadow strategy agent.
Given the existing summary (if any) and the new conversation turns below, produce an updated, concise summary.
Focus on the user's intent, preferences, and any conclusions or decisions already established.
Do not restate specific numeric data points (prices, indicator values, balances) — those are preserved separately.
Respond with the summary text only, no preamble.`;

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
    } else if (e.kind === "task_result") {
      const gc = e.payload.generation_context as GenerationContext | undefined;
      if (gc?.data) newPreserved.push({ turn: e.turn, agent: e.source, data: gc.data });
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

  state.setCompactionCache({
    summarizedThroughTurn: targetThrough,
    summaryText: completion.text.trim(),
    preservedData: [...(prior?.preservedData ?? []), ...newPreserved],
  });
  await state.persistCompactionCache();
  state.compactEvents(targetThrough);
}

export async function maybeCompact(state: SessionState, modelRouter: ModelRouter, currentTurn: number): Promise<void> {
  const lastTokens = state.lastPromptTokensIn();
  if (lastTokens === undefined) return;

  const ratio = lastTokens / ORCHESTRATOR_CONTEXT_WINDOW_TOKENS;
  if (ratio < COMPACTION_THRESHOLD_RATIO) return;

  const targetThrough = currentTurn - 1 - COMPACTION_KEEP_RECENT_TURNS;
  const from = (state.compactionCache()?.summarizedThroughTurn ?? 0) + 1;
  if (from > targetThrough) return;

  await compact(state, modelRouter, from, targetThrough);
}

/** How much replayed thread history a subagent may carry into one prompt,
 *  measured in characters of rendered [PROGRESS SO FAR]. */
export const THREAD_PROGRESS_CHAR_BUDGET = envNumber("THREAD_PROGRESS_CHAR_BUDGET", 40_000);

/** Rounds left verbatim at the tail when a thread is folded. Two is enough for
 *  the agent to see what it was in the middle of; older rounds survive as prose. */
export const THREAD_KEEP_RECENT_ROUNDS = envNumber("THREAD_KEEP_RECENT_ROUNDS", 2);

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
  const rendered = state.subagentProgress({ thread: threadId });
  if (rendered.length <= THREAD_PROGRESS_CHAR_BUDGET) return;

  // Round boundaries are the seam notes a resuming run writes (step 0). Keep
  // the last few rounds verbatim; everything above them gets folded.
  const lines = rendered.split("\n");
  const boundaries = lines.reduce<number[]>((acc, line, i) => {
    if (line.startsWith("[note step 0]")) acc.push(i);
    return acc;
  }, []);
  const cut = boundaries.length > THREAD_KEEP_RECENT_ROUNDS
    ? boundaries[boundaries.length - THREAD_KEEP_RECENT_ROUNDS]!
    : Math.floor(lines.length / 2);
  const older = lines.slice(0, cut).join("\n");
  if (older.trim() === "") return;

  const completion = await modelRouter.generate(
    [
      { role: "system", content: THREAD_COMPACTION_SYSTEM_PROMPT },
      { role: "user", content: older },
    ],
    { modelClass: "SMALL", temperature: 0.2, metadata: { mode: "thread_compaction", agent } },
  );

  state.record(agent, "subagent_note", {
    task_id: taskId,
    step: 0,
    thread_summary: true,
    note: `[earlier in this thread, summarized]\n${completion.text.trim()}`,
  }, { threadId });
}
