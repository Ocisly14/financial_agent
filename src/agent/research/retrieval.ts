// Pure retrieval logic for the Research controller's `fetch_from_topic` tool.
//
// Safety boundary: the SMALL model that reads a Topic's turns only ever
// chooses (turn ids + scores). It never speaks the content back. This file
// is what makes that mechanical: it chunks turns for the model, and resolves
// the model's selections back to the *original* turn text — never through
// the model's own words. See docs/superpowers/specs/2026-07-30-research-layer-design.md §4.3.

export type IndexedTurn = { turn: number; user: string; reply: string };

export type Chunk = { turns: IndexedTurn[]; tokenEstimate: number };

export type Selection = { turn: number; score: number };

/**
 * Rough, cheap token-count ESTIMATE — not a real tokenizer.
 *
 * Heuristic: characters / 3, counting every character (including CJK)
 * uniformly. This intentionally avoids pulling in a tokenizer dependency.
 * It is good enough for packing chunks under a soft budget; callers must
 * not treat it as exact and should leave headroom rather than sizing
 * budgets to the byte.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function turnTokenEstimate(t: IndexedTurn): number {
  return estimateTokens(t.user) + estimateTokens(t.reply);
}

/**
 * Greedily packs turns into chunks bounded by `maxTokensPerChunk`.
 *
 * A single turn whose own size exceeds the budget still gets its own
 * chunk — it is never split mid-turn and never dropped. Order is preserved.
 */
export function chunkTurns(turns: IndexedTurn[], maxTokensPerChunk: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: IndexedTurn[] = [];
  let currentTokens = 0;

  for (const t of turns) {
    const tTokens = turnTokenEstimate(t);

    if (current.length > 0 && currentTokens + tTokens > maxTokensPerChunk) {
      chunks.push({ turns: current, tokenEstimate: currentTokens });
      current = [];
      currentTokens = 0;
    }

    current.push(t);
    currentTokens += tTokens;
  }

  if (current.length > 0) {
    chunks.push({ turns: current, tokenEstimate: currentTokens });
  }

  return chunks;
}

/**
 * Merges per-chunk selections into a single ranked, deduped, budget-capped
 * list of the original turns.
 *
 * - A turn selected by more than one chunk keeps its HIGHEST score.
 * - Result is sorted by score descending.
 * - Turns are accumulated (by their real token cost) until `budgetTokens`
 *   is hit; anything past that is dropped and `coverage` is "truncated".
 * - A selection naming a turn id that doesn't exist in `turns` resolves to
 *   nothing — it is never mapped onto some other turn.
 */
export function mergeSelections(
  perChunk: Selection[][],
  budgetTokens: number,
  turns: IndexedTurn[],
): { turns: IndexedTurn[]; coverage: "full" | "truncated" } {
  const byTurn = new Map<number, IndexedTurn>();
  for (const t of turns) byTurn.set(t.turn, t);

  const bestScore = new Map<number, number>();
  for (const selections of perChunk) {
    for (const sel of selections) {
      if (!byTurn.has(sel.turn)) continue; // hallucinated id: resolves to nothing
      const existing = bestScore.get(sel.turn);
      if (existing === undefined || sel.score > existing) {
        bestScore.set(sel.turn, sel.score);
      }
    }
  }

  const ranked = [...bestScore.entries()].sort((a, b) => b[1] - a[1]);

  const result: IndexedTurn[] = [];
  let usedTokens = 0;
  let truncated = false;

  for (const [turnId, _score] of ranked) {
    const t = byTurn.get(turnId)!;
    const cost = turnTokenEstimate(t);
    if (usedTokens + cost > budgetTokens) {
      truncated = true;
      break;
    }
    result.push(t);
    usedTokens += cost;
  }

  return { turns: result, coverage: truncated ? "truncated" : "full" };
}

/**
 * Renders a chunk for the SMALL model, prefixing every turn with `[turn N]`.
 * This prefix is the model's only means of citing a turn back to the tool;
 * without it the map-reduce selection scheme has nothing to resolve.
 */
export function renderChunkForModel(chunk: Chunk): string {
  return chunk.turns
    .map((t) => `[turn ${t.turn}]\nuser: ${t.user}\nreply: ${t.reply}`)
    .join("\n\n");
}

/**
 * True if `text` contains any digit character, ASCII or full-width
 * (U+FF10–U+FF19). Used to enforce that a SMALL model's `framing` sentence
 * never carries a number — numbers must always come from the original
 * turn text, never from a model's paraphrase.
 */
export function containsDigits(text: string): boolean {
  return /[0-9０-９]/.test(text);
}
