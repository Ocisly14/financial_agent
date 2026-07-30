// src/framework/contextCompaction.ts
import type { ModelRouter } from "../infra/llm/provider.ts";
import type { GenerationContext } from "./types.ts";
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
    if (e.is_sidechain || e.turn < from || e.turn > targetThrough) continue;

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
