import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter, type GenerateOptions, type LlmMessage, type LlmProvider } from "../../../infra/llm/provider.ts";
import { SessionRegistry } from "../../../framework/sessionState.ts";
import { InMemoryEventStore } from "../../../framework/eventStore.ts";
import type { ResearchMember } from "../../../infra/db/sqliteEventStore.ts";
import { generateDigest, refreshStaleDigests, type DigestStore } from "../digest.ts";

// The digest's TEXT quality needs real credentials and is checked by hand (see
// the task report). What is checked here is the part that must never depend on
// a model: when a call is spent, how many run at once, and what is written back.

class FakeDigestStore implements DigestStore {
  members: ResearchMember[] = [];
  writes: Array<{ topicId: string; digest: string; throughTurn: number }> = [];

  listResearchMembers(): ResearchMember[] {
    return this.members.map((m) => ({ ...m }));
  }
  setMemberDigest(_researchId: string, topicId: string, digest: string, digestThroughTurn: number): void {
    this.writes.push({ topicId, digest, throughTurn: digestThroughTurn });
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
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      inFlight--;
      return {
        text: `缩要 #${calls}`,
        metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: generateOptions.modelClass, provider: "fake" },
      };
    },
  };
  return { router: new ModelRouter(provider), calls: () => calls, peak: () => peak };
}

const member = (topicId: string, digestThroughTurn: number): ResearchMember =>
  ({ topicId, sortOrder: 0, digest: digestThroughTurn > 0 ? "旧缩要" : null, digestThroughTurn, seenThroughTurn: 0 });

async function seed(sessions: SessionRegistry, topicId: string, turns: number): Promise<void> {
  const state = await sessions.getOrCreate(topicId);
  for (let i = 1; i <= turns; i++) {
    state.beginTurn(`问题 ${i}`);
    state.recordReply(`答案 ${i}`, true);
  }
}

test("a digest is generated with the SMALL model class", async () => {
  let seenClass: string | undefined;
  const provider: LlmProvider = {
    name: "fake",
    async generate(_messages, options) {
      seenClass = options.modelClass;
      return { text: "  某缩要  ", metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: options.modelClass, provider: "fake" } };
    },
  };
  const digest = await generateDigest([{ turn: 1, user: "q", reply: "a" }], new ModelRouter(provider));
  assert.equal(seenClass, "SMALL");
  assert.equal(digest, "某缩要", "trimmed");
});

test("an empty history spends no model call", async () => {
  const { router, calls } = countingRouter();
  assert.equal(await generateDigest([], router), "");
  assert.equal(calls(), 0, "summarising a conversation that hasn't happened invents one");
});

test("only members whose topic moved past digest_through_turn are refreshed", async () => {
  const store = new FakeDigestStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router, calls } = countingRouter();

  store.members = [member("room_stale", 1), member("room_current", 3), member("room_empty", 0)];
  await seed(sessions, "room_stale", 4);
  await seed(sessions, "room_current", 3);

  const outcomes = await refreshStaleDigests("res_1", store, sessions, router);

  assert.equal(calls(), 1, "a topic that hasn't progressed costs nothing");
  assert.deepEqual(store.writes, [{ topicId: "room_stale", digest: "缩要 #1", throughTurn: 4 }]);
  assert.deepEqual(outcomes.map((o) => [o.topicId, o.status]), [["room_stale", "refreshed"]]);
});

test("digest refresh runs at most 3 model calls at a time", async () => {
  const store = new FakeDigestStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const { router, peak, calls } = countingRouter({ delayMs: 5 });

  store.members = [];
  for (let i = 0; i < 7; i++) {
    store.members.push(member(`room_${i}`, 0));
    await seed(sessions, `room_${i}`, 2);
  }

  await refreshStaleDigests("res_1", store, sessions, router);

  assert.equal(calls(), 7, "all seven are refreshed");
  assert.equal(peak(), 3, "concurrency cap is 3");
});

test("one member's failure does not fail the batch", async () => {
  const store = new FakeDigestStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  let call = 0;
  const provider: LlmProvider = {
    name: "fake",
    async generate(_messages, options) {
      call++;
      if (call === 1) throw new Error("provider exploded");
      return { text: "缩要", metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: options.modelClass, provider: "fake" } };
    },
  };
  store.members = [member("room_a", 0), member("room_b", 0)];
  await seed(sessions, "room_a", 1);
  await seed(sessions, "room_b", 1);

  const outcomes = await refreshStaleDigests("res_1", store, sessions, new ModelRouter(provider));

  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["error", "refreshed"]);
  assert.equal(store.writes.length, 1, "the survivor still gets written");
});
