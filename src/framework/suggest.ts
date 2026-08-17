/**
 * Near misses for a name the caller got wrong, best first.
 *
 * Five separate failures in one AMZN run were a name that does not exist — `marketable_securities`
 * for a row filed as `source.balance_sheet.marketable_securities.<hash>`, `margin.operating.aws` for
 * a namespaced metric, `history` for a section that is not a time filter. Patching each error
 * message in turn is whack-a-mole; a rejected name should carry its near misses wherever the
 * candidate set is known.
 *
 * Scoring is by shared words, not edit distance. What an agent writes is usually the right words
 * under the wrong prefix or namespace, which edit distance scores as far away and token overlap
 * scores as adjacent — `marketable_securities` is 30 edits from its source id and shares every word
 * with it. A whole-string substring hit counts as a full match for the same reason.
 */
export function suggestCandidates(value: string, candidates: Iterable<string>, limit = 10): string[] {
  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/i).filter((part) => part.length > 0);
  const wanted = words(value);
  if (wanted.length === 0) return [];
  const normalized = wanted.join("_");

  const scored: Array<{ candidate: string; score: number }> = [];
  for (const candidate of candidates) {
    const have = new Set(words(candidate));
    const matched = wanted.filter((word) => have.has(word)).length;
    // A substring hit is a full match: the caller wrote the whole name, just not the whole id.
    const score = candidate.toLowerCase().replace(/[^a-z0-9]+/g, "_").includes(normalized)
      ? 1 : matched / wanted.length;
    // Below half the words in common, a "did you mean" is noise wearing the shape of help.
    if (score >= 0.5) scored.push({ candidate, score });
  }
  // Ties break toward the shorter name: a canonical row beats the source row that quotes it.
  scored.sort((left, right) => right.score - left.score
    || left.candidate.length - right.candidate.length
    || (left.candidate < right.candidate ? -1 : 1));
  return scored.slice(0, limit).map((entry) => entry.candidate);
}

/** One searchable namespace: what its names are, and the one call that reads them. */
export type NameSpace = { kind: string; how: string; names: Iterable<string> };

/**
 * A `did you mean` clause, grouped by namespace, or nothing when no candidate is close enough.
 *
 * The grouping is the point. A bare list of names trades an unknown name for an unknown call — the
 * agent that guessed `marketable_securities` needs to learn both that the row exists under a source
 * id and that one `get_unified_rows { rowIds }` fetches it. Each namespace is capped on its own so a
 * crowded space cannot bury a single exact hit in a sparse one.
 */
export function suggestionClause(value: string, spaces: readonly NameSpace[]): string {
  const groups = spaces.flatMap((space) => {
    const found = suggestCandidates(value, space.names);
    return found.length === 0 ? [] : [`${space.kind}: ${found.join(", ")} (read with ${space.how})`];
  });
  return groups.length === 0 ? "" : ` Did you mean — ${groups.join("; ")}?`;
}
