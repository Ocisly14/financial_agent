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
  summaries = new Map<string, string>();
  writes: Array<{ topicId: string; summary: string; category: TopicCategory | null; throughTurn: number; metadata: { title: string | null; symbols: string[] } }> = [];

  isTopicDigestDue(topicId: string): boolean {
    const observed = this.logs.get(topicId) ?? 0;
    const through = this.digested.get(topicId) ?? 0;
    return through === 0 ? observed >= 1 : observed >= through + 3;
  }
  listDigestDueTopics(): string[] {
    return [...this.logs.keys()].filter((topicId) => this.isTopicDigestDue(topicId));
  }
  getTopicDigest(topicId: string): { summary: string | null; throughTurn: number } | null {
    if (!this.logs.has(topicId)) return null;
    return { summary: this.summaries.get(topicId) ?? null, throughTurn: this.digested.get(topicId) ?? 0 };
  }
  setTopicDigest(topicId: string, summary: string, category: TopicCategory | null, throughTurn: number, metadata: { title: string | null; symbols: string[] }): void {
    this.digested.set(topicId, throughTurn);
    this.summaries.set(topicId, summary);
    this.writes.push({ topicId, summary, category, throughTurn, metadata });
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

async function appendTurn(sessions: SessionRegistry, store: FakeStore, topicId: string): Promise<void> {
  const state = await sessions.getOrCreate(topicId);
  const turn = (store.logs.get(topicId) ?? 0) + 1;
  state.beginTurn(`问题 ${turn}`);
  state.recordReply(`答案 ${turn}`, true);
  store.logs.set(topicId, turn);
}

async function seed(sessions: SessionRegistry, store: FakeStore, topicId: string, turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) await appendTurn(sessions, store, topicId);
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

test("the first completed turn is digested immediately", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router, calls } = countingRouter();
  const scheduler = makeScheduler(store, sessions, router, 1_000);

  await seed(sessions, store, "room_a", 1);
  scheduler.schedule("room_a");
  await delay(15);

  assert.equal(calls(), 1, "the initial digest must not wait for the debounce");
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0]?.throughTurn, 1);
  scheduler.dispose();
});

test("updates only run after three new turns and consume exactly that batch", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  let lastPrompt = "";
  const { router, calls } = (() => {
    let count = 0;
    const provider: LlmProvider = {
      name: "fake",
      async generate(messages, options) {
        count++;
        lastPrompt = String(messages[messages.length - 1]?.content ?? "");
        return { text: `{"summary":"digest ${count}","category":"macro"}`, metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: options.modelClass, provider: "fake" } };
      },
    };
    return { router: new ModelRouter(provider), calls: () => count };
  })();
  const scheduler = makeScheduler(store, sessions, router, 10);

  await appendTurn(sessions, store, "room_a");
  scheduler.schedule("room_a");
  await delay(15);
  await appendTurn(sessions, store, "room_a");
  scheduler.schedule("room_a");
  await appendTurn(sessions, store, "room_a");
  scheduler.schedule("room_a");
  await delay(20);
  assert.equal(calls(), 1, "two new turns are retained but not summarised");

  await appendTurn(sessions, store, "room_a");
  scheduler.schedule("room_a");
  await delay(15);

  assert.equal(calls(), 2);
  assert.deepEqual(store.writes.map((write) => write.throughTurn), [1, 4]);
  assert.match(lastPrompt, /Existing digest[\s\S]*digest 1/);
  assert.match(lastPrompt, /\[turn 2\][\s\S]*\[turn 3\][\s\S]*\[turn 4\]/);
  assert.doesNotMatch(lastPrompt, /\[turn 1\]/);
  scheduler.dispose();
});

test("catch-up processes an old backlog as incremental batches", async () => {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router } = countingRouter();
  const scheduler = makeScheduler(store, sessions, router);

  await seed(sessions, store, "room_a", 4);
  scheduler.schedule("room_a");
  await delay(40);

  assert.deepEqual(store.writes.map((write) => write.throughTurn), [1, 4]);
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
