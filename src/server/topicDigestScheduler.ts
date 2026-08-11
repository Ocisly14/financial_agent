// Decides WHEN a Topic gets re-summarised. The summarising itself is
// src/agent/topicDigest.ts; this file spends no model calls of its own.
//
// The anchor is "30 seconds after a TURN ENDS", not "30 seconds after the user
// stops typing". An agent turn can stream for minutes, so a timer started when
// the user hits send would fire mid-stream, hand the model half a turn, and
// produce a summary and category drawn from an unfinished thought — which then
// has to be redone once the turn actually ends, at double the cost. `handleChat`
// already has the exact boundary we want in its `finally` block.
//
// Two layers, because neither alone is enough:
//
//   schedule() — the in-process debounce. Fast and precise, but a Map of
//                timers dies with the process.
//   catchUp()  — the durable backstop. The dirty bit (`turnCount >
//                digest_through_turn`) is in SQL, so anything a restart ate can
//                be found again on the next sidebar poll, without loading a
//                single event payload.

import { DIGEST_CONCURRENCY, buildIndexedTurns, generateDigest, turnCountOf, type TopicHistorySource } from "../agent/topicDigest.ts";
import { mapWithConcurrency } from "../agent/research/concurrency.ts";
import type { ModelRouter } from "../infra/llm/provider.ts";
import type { TopicCategory } from "../infra/db/sqliteEventStore.ts";

/** How long a Topic must sit still after a turn before it is worth summarising. */
export const DEBOUNCE_MS = 30_000;

/** `catchUp` is driven by the sidebar poll, which the client repeats every 30s
 *  per open tab. Sweeping the whole agent that often is pointless — the debounce
 *  covers the live case, and this only exists to mop up after a restart. */
export const CATCH_UP_THROTTLE_MS = 60_000;

/** The slice of SqliteEventStore this scheduler needs. Narrow so tests can stub it. */
export type TopicDigestStore = {
  isTopicDigestStale(topicId: string): boolean;
  listStaleTopics(agentId: string): string[];
  setTopicDigest(topicId: string, summary: string, category: TopicCategory | null, throughTurn: number): void;
};

export type TopicDigestSchedulerOptions = {
  store: TopicDigestStore;
  sessions: TopicHistorySource;
  modelRouter: ModelRouter;
  /** Overridden in tests to avoid waiting out a real 30 seconds. */
  debounceMs?: number;
  catchUpThrottleMs?: number;
  /** Where a failed digest is reported. Defaults to console.warn. */
  onError?: (topicId: string, error: unknown) => void;
};

export class TopicDigestScheduler {
  private readonly store: TopicDigestStore;
  private readonly sessions: TopicHistorySource;
  private readonly modelRouter: ModelRouter;
  private readonly debounceMs: number;
  private readonly catchUpThrottleMs: number;
  private readonly onError: (topicId: string, error: unknown) => void;

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly lastCatchUp = new Map<string, number>();

  constructor(options: TopicDigestSchedulerOptions) {
    this.store = options.store;
    this.sessions = options.sessions;
    this.modelRouter = options.modelRouter;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.catchUpThrottleMs = options.catchUpThrottleMs ?? CATCH_UP_THROTTLE_MS;
    this.onError = options.onError ?? ((topicId, error) => {
      console.warn(`[topic-digest] ${topicId} failed:`, error);
    });
  }

  /**
   * Arms (or re-arms) the debounce for one Topic. A rapid back-and-forth keeps
   * pushing the deadline out, so a ten-turn conversation costs ONE model call
   * at the end of it rather than ten.
   *
   * Only ever call this for real Topics. A Research session has no `chat_rooms`
   * row, so scheduling one would write a digest into nothing.
   */
  schedule(topicId: string): void {
    const existing = this.timers.get(topicId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(topicId);
      void this.run(topicId);
    }, this.debounceMs);
    // Node keeps the process alive for a pending timer; a summary that has not
    // come due yet must not be the reason a server refuses to shut down.
    timer.unref?.();
    this.timers.set(topicId, timer);
  }

  /**
   * Re-summarises every Topic of one agent whose log has outrun its digest.
   *
   * Throttled per agent, and safe to call from a hot request path: it returns
   * as soon as the work is dispatched only if the caller does not await it.
   */
  async catchUp(agentId: string, now = Date.now()): Promise<void> {
    // "Never swept" is absence, not timestamp 0 — the first sweep after a
    // restart is the one that matters most and must never be throttled away.
    const last = this.lastCatchUp.get(agentId);
    if (last !== undefined && now - last < this.catchUpThrottleMs) return;
    this.lastCatchUp.set(agentId, now);

    const stale = this.store.listStaleTopics(agentId).filter((topicId) => !this.inFlight.has(topicId));
    if (stale.length === 0) return;
    await mapWithConcurrency(stale, DIGEST_CONCURRENCY, (topicId) => this.run(topicId));
  }

  /** Cancels every pending timer. For tests and clean shutdown. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * One Topic's refresh. Never throws: this runs detached from any request, so
   * a failure here has no one to report to but the log, and must not become an
   * unhandled rejection.
   */
  private async run(topicId: string): Promise<void> {
    if (this.inFlight.has(topicId)) return;

    // Re-check staleness at fire time rather than trusting whoever scheduled us.
    // A catch-up sweep and an expiring debounce can both arrive for the same
    // Topic, and the loser should cost nothing.
    if (!this.store.isTopicDigestStale(topicId)) return;

    this.inFlight.add(topicId);
    try {
      const turns = buildIndexedTurns(await this.sessions.loadEvents(topicId));
      const observedTurn = turnCountOf(turns);
      if (observedTurn === 0) return;

      const { summary, category } = await generateDigest(turns, this.modelRouter);
      if (!summary) return;
      this.store.setTopicDigest(topicId, summary, category, observedTurn);
    } catch (error) {
      this.onError(topicId, error);
    } finally {
      this.inFlight.delete(topicId);
    }
  }
}
