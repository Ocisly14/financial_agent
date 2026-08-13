// Topic digests: the ~300-token "what is this Topic investigating, and where do
// its conclusions stand" blurb, plus the category that files the Topic in the
// sidebar. One SMALL-model call produces both.
//
// This used to live under research/ and write `research_members.digest`, which
// made a summary a property of a (Research × Topic) PAIR — so a Topic never
// pulled into a Research never had one, and the sidebar had nothing to show. It
// is now a property of the Topic itself: generated once, read by everyone
// (`researchRuntime.memberFacts` included).
//
// Two rules shape this file:
//
//  1. Generation is deliberately independent of the framework's context
//     compaction — whether `loadCompaction` has produced anything for that
//     Topic is none of this layer's business.
//  2. Nothing here decides WHEN to run. That is the scheduler's job
//     (src/server/topicDigestScheduler.ts), and it only spends a call on a
//     Topic whose log has moved past `digest_through_turn`.

import type { ModelRouter } from "../infra/llm/provider.ts";
import type { SessionEvent } from "../framework/sessionState.ts";
import type { SessionRegistry } from "../framework/sessionState.ts";
import { asTopicCategory, TOPIC_CATEGORIES, type TopicCategory } from "../infra/db/sqliteEventStore.ts";

export type IndexedTurn = { turn: number; user: string; reply: string };

/** Model calls for digests run at most this many at a time (spec: concurrency cap 3). */
export const DIGEST_CONCURRENCY = 3;

/** What this module needs from SessionRegistry — the durable log of a Topic. */
export type TopicHistorySource = Pick<SessionRegistry, "loadEvents">;

export type TopicDigest = {
  /** Short human-readable title for the Topic rail. */
  title: string | null;
  /** Explicit tickers discussed by the Topic, ordered by relevance. */
  symbols: string[];
  summary: string;
  category: TopicCategory | null;
};

const TICKER_PATTERN = /^[A-Z][A-Z.-]{0,5}$/;
const MAX_DIGEST_SYMBOLS = 6;

function asDigestTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 80) : null;
}

function asDigestSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const symbol = candidate.trim().toUpperCase();
    if (!TICKER_PATTERN.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
    if (symbols.length === MAX_DIGEST_SYMBOLS) break;
  }
  return symbols;
}

/**
 * Projects a Topic's event log into turn-indexed user/reply pairs.
 *
 * The index unit is the TURN, anchored on the final reply that turn gave the
 * user (spec §4.3): `session_events.turn` already exists, so the turn number
 * itself is the id and no new index structure is needed. Turns with no reply
 * yet (in flight, or ended in an error) still appear, with an empty reply —
 * dropping them would silently renumber nothing but would hide that the user
 * asked something.
 *
 * Note this does not go through `projectChatHistory`: that projection is built
 * for the web client and discards the turn number, which is exactly the field
 * this layer indexes on.
 */
export function buildIndexedTurns(events: readonly SessionEvent[]): IndexedTurn[] {
  const byTurn = new Map<number, { user: string[]; finalReply?: string; lastReply?: string }>();

  for (const event of events) {
    if (event.thread_id !== event.session_id) continue; // main thread only
    if (event.kind !== "user_message" && event.kind !== "reply") continue;
    const bucket = byTurn.get(event.turn) ?? { user: [] };
    if (event.kind === "user_message") {
      bucket.user.push(String(event.payload.content ?? ""));
    } else {
      const content = String(event.payload.content ?? "");
      bucket.lastReply = content;
      if (event.payload.final === true) bucket.finalReply = content;
    }
    byTurn.set(event.turn, bucket);
  }

  return [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, bucket]) => ({
      turn,
      user: bucket.user.join("\n"),
      reply: bucket.finalReply ?? bucket.lastReply ?? "",
    }));
}

/** Highest turn number present in a Topic's log — 0 for an untouched Topic. */
export function turnCountOf(turns: readonly IndexedTurn[]): number {
  return turns.reduce((max, t) => Math.max(max, t.turn), 0);
}

/** What each category means, as the model sees it. The wording is chosen so the
 *  boundaries fall where an analyst's NEXT ACTION differs — that is the whole
 *  point of the taxonomy, and a model told only the labels puts everything with
 *  a ticker in it under single_name. */
const CATEGORY_GUIDE = [
  "- single_name: one company's fundamentals, valuation, earnings, or management.",
  "- comparative: two or more names weighed against each other — pairs, leader vs laggard, relative value.",
  "- sector: an industry or theme as a whole (semiconductors, AI compute, biotech, defense).",
  "- macro: rates, inflation, employment, central banks, fiscal policy, geopolitics, currencies.",
  "- strategy: a trading or investing RULE — technical setups, factors, backtests, timing systems.",
  "- portfolio: holdings, allocation, exposure, hedging, drawdown.",
].join("\n");

const DIGEST_SYSTEM = [
  "You are generating a \"Topic digest\" for an investment-research workspace.",
  "You are given the conversation history of a Topic (an ongoing research conversation).",
  "",
  "Reply with ONE JSON object and nothing else:",
  '{"title": "...", "symbols": ["..."], "summary": "...", "category": "<one of the slugs below>"}',
  "",
  "title: a concise, specific 2–7-word label for the Topic rail. Include the primary ticker when one exists (for example, \"AAPL valuation\"). Do not use generic labels such as \"Chat\" or \"Research\".",
  "symbols: the 0–6 publicly traded ticker symbols actually discussed, uppercase, in relevance order. Use [] for a macro/topic with no listed-company focus. Never infer a ticker from an ordinary word.",
  "summary: no more than 300 tokens, covering two things —",
  "1) what this Topic is investigating (a ticker / macro theme / question of interest);",
  "2) where its conclusions stand (confirmed judgments, unresolved disagreements, what to check next).",
  "Write the blurb itself — no title, no bullet prefix, no pleasantries.",
  "If there is no conclusion yet, say so plainly — do not invent one.",
  "Write the summary in the language the conversation is in.",
  "",
  "category: exactly one of these slugs, chosen by what the reader would do next.",
  CATEGORY_GUIDE,
  "Asset class is NOT a category: a Bitcoin or crude-oil Topic is still single_name, macro, or strategy",
  "depending on what is being asked. If genuinely none fit, use null.",
].join("\n");

/**
 * Pulls the digest out of a model reply.
 *
 * Tolerant on purpose. A SMALL model wraps JSON in prose or fences often enough
 * that strict parsing would throw away a perfectly good summary over a
 * formatting slip — and the summary is the expensive part. So: try the fenced
 * or bare JSON object, and if there is no usable object at all, treat the whole
 * reply as the summary with no category. A missing category self-heals on the
 * next turn; a discarded summary costs another model call.
 */
export function parseDigestReply(text: string): TopicDigest {
  const raw = text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (summary) {
        return {
          title: asDigestTitle(parsed.title),
          symbols: asDigestSymbols(parsed.symbols),
          summary,
          category: asTopicCategory(parsed.category),
        };
      }
    } catch {
      // Fall through to the whole-reply fallback below.
    }
  }
  // Strip a leading fence line, if the reply was fenced but unparsable.
  const fallback = raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  return { title: null, symbols: [], summary: fallback, category: null };
}

/**
 * Generates one Topic's digest and category with a SMALL model. After the
 * first turn, callers pass the prior digest and exactly the next three turns;
 * the model therefore updates its state instead of re-reading a Topic's full
 * history on every refresh.
 *
 * Returns an empty summary for an empty history WITHOUT calling a model: asking
 * a model to summarise a conversation that hasn't happened yields a confident
 * description of nothing.
 */
export async function generateDigest(
  turns: IndexedTurn[],
  modelRouter: ModelRouter,
  previousDigest?: string | null,
): Promise<TopicDigest> {
  if (turns.length === 0) return { title: null, symbols: [], summary: "", category: null };

  const transcript = turns
    .map((t) => `[turn ${t.turn}]\nUser: ${t.user}\nReply: ${t.reply}`)
    .join("\n\n");
  const prior = previousDigest?.trim()
    ? `Existing digest (preserve still-valid conclusions from it):\n${previousDigest.trim()}\n\n`
    : "";

  const completion = await modelRouter.generate(
    [
      { role: "system", content: DIGEST_SYSTEM },
      {
        role: "user",
        content:
          `${prior}New conversation turns to incorporate:\n\n${transcript}\n\n` +
          `Update the digest using the existing digest and only these new turns. ` +
          `Please give the digest as JSON. Valid categories: ${TOPIC_CATEGORIES.join(", ")}.`,
      },
    ],
    { modelClass: "SMALL", temperature: 0.2, metadata: { mode: "topic_digest" } },
  );

  return parseDigestReply(completion.text);
}
