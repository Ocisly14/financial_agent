import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRouter, type GenerateOptions, type LlmMessage, type LlmProvider } from "../../infra/llm/provider.ts";
import { SessionRegistry } from "../../framework/sessionState.ts";
import { InMemoryEventStore } from "../../framework/eventStore.ts";
import type { TopicCategory } from "../../infra/db/sqliteEventStore.ts";
import { TopicDigestScheduler, type TopicDigestStore } from "../topicDigestScheduler.ts";

// What matters here is the SPENDING policy: a burst of turns must cost one model
// call, a Topic that hasn't moved must cost none, and two triggers arriving for
// the same Topic must not both pay.

class FakeStore implements TopicDigestStore {
  /** topicId -> the turn its digest was last written through. */
  digested = new Map<string, number>();
  /** topicId -> the turn its log actually reaches. */
  logs = new Map<string, number>();
  writes: Array<{ topicId: string; summary: string; category: TopicCategory | null; throughTurn: number }> = [];

  isTopicDigestStale(topicId: string): boolean {
    return (this.logs.get(topicId) ?? 0) > (this.digested.get(topicId) ?? 0);
  }
  listStaleTopics(): string[] {
    return [...this.logs.keys()].filter((topicId) => this.isTopicDigestStale(topicId));
  }
  setTopicDigest(topicId: string, summary: string, category: TopicCategory | null, throughTurn: number): void {
    this.digested.set(topicId, throughTurn);
    this.writes.push({ topicId, summary, category, throughTurn });
  }
}

function countingRouter(options: { delayMs?: number } = {}): { router: ModelRouter; calls: () => number; peak: () => number } {
  let calls = 0;
  let inFlight = 0;
  let peak = 0;
  const provider: LlmProvider = {
    name: "fake",
    async generate(_messages: LlmMessage[], generateOptions: GenerateOptions) {
      calls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (options.delayMs) await delay(options.delayMs);
      inFlight--;
      return {
        text: `{"summary": "缩要 #${calls}", "category": "macro"}`,
        metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: generateOptions.modelClass, provider: "fake" },
      };
    },
  };
  return { router: new ModelRouter(provider), calls: () => calls, peak: () => peak };
}

async function seed(sessions: SessionRegistry, store: FakeStore, topicId: string, turns: number): Promise<void> {
  const state = await sessions.getOrCreate(topicId);
  for (let i = 1; i <= turns; i++) {
    state.beginTurn(`问题 ${i}`);
    state.recordReply(`答案 ${i}`, true);
  }
  store.logs.set(topicId, turns);
}

function makeScheduler(store: FakeStore, sessions: SessionRegistry, router: ModelRouter, debounceMs = 10) {
  return new TopicDigestScheduler({
    store,
    sessions,
    modelRouter: router,
    debounceMs,
    catchUpThrottleMs: 0,
    onError: () => {},
  });
}

test("a burst of turns costs one model call, not one per turn", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router, calls } = countingRouter();
  const scheduler = makeScheduler(store, sessions, router, 30);

  await seed(sessions, store, "room_a", 1);
  // Five turns landing inside one debounce window — each one pushes the
  // deadline out, which is the whole point.
  for (let i = 0; i < 5; i++) {
    scheduler.schedule("room_a");
    await delay(5);
  }
  await delay(80);

  assert.equal(calls(), 1, "re-arming the timer must replace the pending run, not queue another");
  assert.equal(store.writes.length, 1);
  scheduler.dispose();
});

test("a topic that has not moved past its digest spends nothing", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router, calls } = countingRouter();
  const scheduler = makeScheduler(store, sessions, router);

  await seed(sessions, store, "room_a", 3);
  store.digested.set("room_a", 3);

  scheduler.schedule("room_a");
  await delay(40);

  assert.equal(calls(), 0, "staleness is re-checked at fire time, not trusted from the scheduling");
  scheduler.dispose();
});

test("the digest is written through the turn actually read", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router } = countingRouter();
  const scheduler = makeScheduler(store, sessions, router);

  await seed(sessions, store, "room_a", 4);
  scheduler.schedule("room_a");
  await delay(40);

  assert.deepEqual(store.writes, [{ topicId: "room_a", summary: "缩要 #1", category: "macro", throughTurn: 4 }]);
  scheduler.dispose();
});

test("catchUp refreshes every stale topic, at most 3 model calls at a time", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router, calls, peak } = countingRouter({ delayMs: 5 });
  const scheduler = makeScheduler(store, sessions, router);

  for (let i = 0; i < 7; i++) await seed(sessions, store, `room_${i}`, 2);
  await seed(sessions, store, "room_fresh", 2);
  store.digested.set("room_fresh", 2);

  await scheduler.catchUp("agent_1");

  assert.equal(calls(), 7, "all seven stale topics are refreshed, the fresh one is skipped");
  assert.equal(peak(), 3, "concurrency cap is 3");
  scheduler.dispose();
});

test("catchUp is throttled per agent", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router, calls } = countingRouter();
  const scheduler = new TopicDigestScheduler({
    store, sessions, modelRouter: router, debounceMs: 10, catchUpThrottleMs: 60_000, onError: () => {},
  });

  await seed(sessions, store, "room_a", 1);
  await scheduler.catchUp("agent_1", 1_000);
  store.digested.delete("room_a"); // dirty again
  await scheduler.catchUp("agent_1", 2_000);

  assert.equal(calls(), 1, "the sidebar polls every 30s per tab; sweeping on each poll is waste");
  scheduler.dispose();
});

test("a topic already being digested is not started a second time", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router, calls } = countingRouter({ delayMs: 40 });
  const scheduler = makeScheduler(store, sessions, router);

  await seed(sessions, store, "room_a", 2);

  // A catch-up sweep and an expiring debounce racing for the same Topic.
  const sweep = scheduler.catchUp("agent_1");
  scheduler.schedule("room_a");
  await delay(30); // debounce (10ms) fires while the sweep's call is still in flight
  await sweep;
  await delay(60);

  assert.equal(calls(), 1, "the in-flight guard must make the loser cost nothing");
  scheduler.dispose();
});

test("one topic's failure neither throws nor blocks the others", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  let call = 0;
  const provider: LlmProvider = {
    name: "fake",
    async generate(_messages, options) {
      call++;
      if (call === 1) throw new Error("provider exploded");
      return { text: '{"summary": "缩要", "category": "macro"}', metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: options.modelClass, provider: "fake" } };
    },
  };
  const errors: string[] = [];
  const scheduler = new TopicDigestScheduler({
    store, sessions, modelRouter: new ModelRouter(provider),
    debounceMs: 10, catchUpThrottleMs: 0, onError: (topicId) => errors.push(topicId),
  });

  await seed(sessions, store, "room_a", 1);
  await seed(sessions, store, "room_b", 1);

  await scheduler.catchUp("agent_1");

  assert.equal(errors.length, 1, "the failure is reported, not swallowed silently");
  assert.equal(store.writes.length, 1, "the survivor is still written");
  scheduler.dispose();
});
