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
//   schedule() — the in-process trigger. The first completed turn is immediate;
//                subsequent calls debounce until a full three-turn batch is due.
//   catchUp()  — the durable backstop. The due bit (`first turn`, or `turnCount
//                >= digest_through_turn + 3`) is in SQL, so anything a restart
//                ate can be found again on the next sidebar poll.

import { DIGEST_CONCURRENCY, buildIndexedTurns, generateDigest, type TopicHistorySource } from "../agent/topicDigest.ts";
import { mapWithConcurrency } from "../agent/research/concurrency.ts";
import type { ModelRouter } from "../infra/llm/provider.ts";
import type { TopicCategory } from "../infra/db/sqliteEventStore.ts";

/** How long a not-yet-complete three-turn batch must sit still before re-checking. */
export const DEBOUNCE_MS = 30_000;
/** The first digest covers one turn; every following digest incorporates three. */
export const DIGEST_UPDATE_TURN_BATCH = 3;

/** `catchUp` is driven by the sidebar poll, which the client repeats every 30s
 *  per open tab. Sweeping the whole agent that often is pointless — the debounce
 *  covers the live case, and this only exists to mop up after a restart. */
export const CATCH_UP_THROTTLE_MS = 60_000;

/** The slice of SqliteEventStore this scheduler needs. Narrow so tests can stub it. */
export type TopicDigestStore = {
  isTopicDigestDue(topicId: string): boolean;
  listDigestDueTopics(tenantId: string): string[];
  getTopicDigest(topicId: string): { summary: string | null; throughTurn: number } | null;
  setTopicDigest(
    topicId: string,
    summary: string,
    category: TopicCategory | null,
    throughTurn: number,
    metadata: { title: string | null; symbols: string[] },
  ): void;
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
   * Runs the first digest and every complete three-turn increment immediately.
   * Incomplete increments are merely debounced; their eventual third turn will
   * make the next call due immediately.
   *
   * Only ever call this for real Topics. A Research session has no `chat_rooms`
   * row, so scheduling one would write a digest into nothing.
   */
  schedule(topicId: string): void {
    if (this.store.isTopicDigestDue(topicId)) {
      const existing = this.timers.get(topicId);
      if (existing) clearTimeout(existing);
      this.timers.delete(topicId);
      void this.run(topicId);
      return;
    }

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
   * Re-summarises every Topic of one agent with a complete digest increment.
   *
   * Throttled per agent, and safe to call from a hot request path: it returns
   * as soon as the work is dispatched only if the caller does not await it.
   */
  async catchUp(tenantId: string, now = Date.now()): Promise<void> {
    // "Never swept" is absence, not timestamp 0 — the first sweep after a
    // restart is the one that matters most and must never be throttled away.
    const last = this.lastCatchUp.get(tenantId);
    if (last !== undefined && now - last < this.catchUpThrottleMs) return;
    this.lastCatchUp.set(tenantId, now);

    const due = this.store.listDigestDueTopics(tenantId).filter((topicId) => !this.inFlight.has(topicId));
    if (due.length === 0) return;
    await mapWithConcurrency(due, DIGEST_CONCURRENCY, (topicId) => this.run(topicId));
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

    // Re-check eligibility at fire time rather than trusting whoever scheduled
    // us. A catch-up sweep and a just-expired timer can both arrive here.
    if (!this.store.isTopicDigestDue(topicId)) return;

    this.inFlight.add(topicId);
    try {
      // A restart can leave several three-turn increments behind. Process them
      // serially: every model call sees only the previous digest plus one small
      // batch, never an ever-growing transcript.
      while (this.store.isTopicDigestDue(topicId)) {
        const state = this.store.getTopicDigest(topicId);
        const throughTurn = state?.throughTurn ?? 0;
        const turns = buildIndexedTurns(await this.sessions.loadEvents(topicId));
        const newTurns = turns.filter((turn) => turn.turn > throughTurn);
        const batchSize = throughTurn === 0 ? 1 : DIGEST_UPDATE_TURN_BATCH;
        const batch = newTurns.slice(0, batchSize);
        if (batch.length < batchSize) return;

        const { title, symbols, summary, category } = await generateDigest(batch, this.modelRouter, state?.summary);
        if (!summary) return;
        this.store.setTopicDigest(topicId, summary, category, batch[batch.length - 1]!.turn, { title, symbols });
      }
    } catch (error) {
      this.onError(topicId, error);
    } finally {
      this.inFlight.delete(topicId);
    }
  }
}
