// Renders what the Research controller agent sees about its member Topics.
//
// Three layers, each answering a different question (see
// docs/superpowers/specs/2026-07-30-research-layer-design.md §4.2):
//
//   - renderRoster        — "who's here, roughly what are they" — once, at
//                            the start of the Research conversation.
//   - renderExternalDelta — "what changed that I didn't cause" — every
//                            turn, almost always empty.
//   - staleDigests        — "whose summary needs refreshing" — decides
//                            when to spend a model call, never spends one
//                            itself.
//
// All three are pure: no I/O, no model calls. Callers (a later task) supply
// MemberFacts already loaded from storage.

import { estimateTokens } from "./tokenEstimate.ts";

export type MemberFacts = {
  topicId: string;
  name: string;
  leadSymbol: string | null;
  chartSymbols: string[];
  turnCount: number;
  lastActivityMs: number;
  digest: string | null;
  seenThroughTurn: number;
};

/**
 * Renders one member's roster block: identity plus its digest.
 * Kept separate from renderRoster so token estimation and text generation
 * use the exact same string.
 */
function renderMemberBlock(m: MemberFacts): string {
  const lines: string[] = [];
  const identityBits = [m.leadSymbol ?? m.name];
  if (m.chartSymbols.length > 0) identityBits.push(`charts: ${m.chartSymbols.join(", ")}`);
  identityBits.push(`${m.turnCount} turns`);
  identityBits.push(`last active: ${new Date(m.lastActivityMs).toISOString()}`);
  lines.push(`[${m.topicId}] ${m.name} · ${identityBits.join(" · ")}`);
  lines.push(m.digest ? `digest: ${m.digest}` : `digest: (none yet)`);
  return lines.join("\n");
}

/**
 * Renders the one-time opening roster: identity plus digest for every
 * member, ~200 tokens each. Injected once at the start of the Research
 * conversation — not every turn (see module doc).
 *
 * When members don't fit `budgetTokens`, the least recently active are
 * dropped first, and the result says how many were dropped. A silently
 * shortened roster would leave the controller with a wrong model of its
 * own world.
 */
export function renderRoster(members: MemberFacts[], budgetTokens: number): string {
  if (members.length === 0) return "";

  const byRecency = [...members].sort((a, b) => b.lastActivityMs - a.lastActivityMs);

  const included: string[] = [];
  let usedTokens = 0;
  let droppedCount = 0;

  for (const m of byRecency) {
    const block = renderMemberBlock(m);
    const cost = estimateTokens(block);
    if (usedTokens + cost > budgetTokens) {
      droppedCount++;
      continue;
    }
    included.push(block);
    usedTokens += cost;
  }

  const parts = [...included];
  if (droppedCount > 0) {
    parts.push(`(${droppedCount} more members omitted due to the token budget)`);
  }
  return parts.join("\n\n");
}

/**
 * Renders the per-turn external-change delta: members whose turn count has
 * advanced past what the controller last saw (`seenThroughTurn`) — changes
 * it did not cause itself (the user chatting with the Topic directly, or
 * another Research driving the same Topic).
 *
 * Returns the empty string when nothing changed — not a blank line, not a
 * placeholder. An empty section that appears every turn trains the model
 * to skip it.
 */
export function renderExternalDelta(members: MemberFacts[]): string {
  const advanced = members.filter((m) => m.turnCount > m.seenThroughTurn);
  if (advanced.length === 0) return "";

  const lines = advanced.map((m) => {
    const gap = m.turnCount - m.seenThroughTurn;
    const digestSuffix = m.digest ? ` · latest conclusion: ${m.digest}` : "";
    return `[EXTERNAL UPDATE] ${m.name} gained ${gap} turn(s) since you last checked${digestSuffix}`;
  });
  return lines.join("\n");
}

/**
 * Returns the topicIds whose digest is stale: the Topic has moved past
 * `digestThroughTurn`. A brand-new Topic with zero turns is NOT stale —
 * there's nothing to summarise yet, and calling a model on an empty
 * conversation produces a confident description of nothing. That edge case
 * falls out of the same comparison: turnCount (0) is never greater than
 * digestThroughTurn (>= 0), so it's never flagged.
 */
export function staleDigests(
  members: Array<MemberFacts & { digestThroughTurn: number }>,
): string[] {
  return members
    .filter((m) => m.turnCount > m.digestThroughTurn)
    .map((m) => m.topicId);
}
