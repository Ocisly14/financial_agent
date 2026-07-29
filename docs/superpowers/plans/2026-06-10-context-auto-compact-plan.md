# Context Auto-Compact + MongoDB Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `SessionState`'s event log to MongoDB (with in-memory fallback) and auto-compact older conversation turns into a rolling LLM summary once the orchestrator's prompt hits 60% of its context window.

**Architecture:** A pluggable `EventStore` interface (Mongo-backed or in-memory) that `SessionState` writes to fire-and-forget on every `record()` and that `SessionRegistry` uses to restore sessions on cold start. A separate `contextCompaction.ts` module checks token usage after each orchestrator turn, and when over threshold, summarizes turns older than the last N into a rolling cache (`summaryText` + `preservedData`), then trims those turns from the in-memory event array. `projectForPrompt` renders the cache when present.

**Tech Stack:** TypeScript (Node 23, `--experimental-strip-types`), `mongodb` npm driver, Node's built-in `node:test` test runner.

**Spec:** `docs/superpowers/specs/2026-06-09-context-auto-compact-design.md`

---

## File Structure

- **Create** `src/framework/eventStore.ts` — `EventStore` interface, `CompactionCache`/`PreservedDataEntry` types, `InMemoryEventStore` (test double + fallback persistence for environments without Mongo).
- **Create** `src/infra/db/mongoEventStore.ts` — `MongoEventStore implements EventStore` using the `mongodb` driver.
- **Create** `src/framework/contextCompaction.ts` — config constants, `compact()`, `maybeCompact()`.
- **Modify** `src/framework/sessionState.ts` — `SessionState` gains optional `EventStore`, persistence on `record()`, compaction-cache fields/accessors, `compactEvents()`, `static restore()`; `SessionRegistry.getOrCreate` becomes async, gains `getExisting()`.
- **Modify** `src/framework/orchestrator.ts` — await `getOrCreate`, record prompt tokens, call `maybeCompact` before building the prompt.
- **Modify** `src/agent/createApp.ts` — resolve `EventStore` (Mongo or none), pass to `SessionRegistry`, switch `dispatcherFactory` to `getExisting`.
- **Modify** `src/server/server.ts` — await `getOrCreate`.
- **Modify** `package.json` — add `mongodb` dependency.
- **Modify** `tsconfig.json` — include `test/**/*.ts`.
- **Tests** under `test/`: `eventStore.test.ts`, `sessionState.persistence.test.ts`, `contextCompaction.test.ts`, `sessionState.projection.test.ts`.

---

## Task 1: `EventStore` interface + types + `InMemoryEventStore`

**Files:**
- Create: `src/framework/eventStore.ts`
- Test: `test/eventStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/eventStore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventStore } from "../src/framework/eventStore.ts";
import type { SessionEvent } from "../src/framework/sessionState.ts";

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    event_id: "ev_1",
    parent_event_id: null,
    session_id: "sess_1",
    timestamp: "2026-06-10T00:00:00.000Z",
    source: "user",
    kind: "user_message",
    is_sidechain: false,
    turn: 1,
    payload: { content: "hi" },
    ...overrides,
  };
}

test("InMemoryEventStore appends and loads events per session", async () => {
  const store = new InMemoryEventStore();
  await store.appendEvent(makeEvent({ event_id: "ev_1" }));
  await store.appendEvent(makeEvent({ event_id: "ev_2", session_id: "sess_2" }));
  await store.appendEvent(makeEvent({ event_id: "ev_3" }));

  const sess1 = await store.loadEvents("sess_1");
  assert.equal(sess1.length, 2);
  assert.deepEqual(sess1.map((e) => e.event_id), ["ev_1", "ev_3"]);

  const sess2 = await store.loadEvents("sess_2");
  assert.equal(sess2.length, 1);
});

test("InMemoryEventStore round-trips compaction cache", async () => {
  const store = new InMemoryEventStore();
  assert.equal(await store.loadCompaction("sess_1"), undefined);

  await store.saveCompaction("sess_1", {
    summarizedThroughTurn: 2,
    summaryText: "user wants BTC analysis",
    preservedData: [{ turn: 2, agent: "onchain_data", data: { inflow: 100 } }],
  });

  const cache = await store.loadCompaction("sess_1");
  assert.deepEqual(cache, {
    summarizedThroughTurn: 2,
    summaryText: "user wants BTC analysis",
    preservedData: [{ turn: 2, agent: "onchain_data", data: { inflow: 100 } }],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test test/eventStore.test.ts`
Expected: FAIL — `Cannot find module '../src/framework/eventStore.ts'`

- [ ] **Step 3: Implement `src/framework/eventStore.ts`**

```typescript
// src/framework/eventStore.ts
import type { JsonObject } from "./types.ts";
import type { SessionEvent } from "./sessionState.ts";

export type PreservedDataEntry = {
  turn: number;
  agent: string;
  data: JsonObject;
};

export type CompactionCache = {
  summarizedThroughTurn: number;
  summaryText: string;
  preservedData: PreservedDataEntry[];
};

/** Pluggable persistence for the session event log. `record()` writes
 *  fire-and-forget; `SessionRegistry` reads on cold start to restore a session. */
export interface EventStore {
  appendEvent(event: SessionEvent): Promise<void>;
  loadEvents(sessionId: string): Promise<SessionEvent[]>;
  loadCompaction(sessionId: string): Promise<CompactionCache | undefined>;
  saveCompaction(sessionId: string, cache: CompactionCache): Promise<void>;
}

/** In-memory EventStore — used in tests, and as a safe default when no
 *  database is configured (data does not survive a process restart). */
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, SessionEvent[]>();
  private readonly compactions = new Map<string, CompactionCache>();

  async appendEvent(event: SessionEvent): Promise<void> {
    const list = this.events.get(event.session_id) ?? [];
    list.push(event);
    this.events.set(event.session_id, list);
  }

  async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    return [...(this.events.get(sessionId) ?? [])];
  }

  async loadCompaction(sessionId: string): Promise<CompactionCache | undefined> {
    const cache = this.compactions.get(sessionId);
    return cache ? { ...cache, preservedData: [...cache.preservedData] } : undefined;
  }

  async saveCompaction(sessionId: string, cache: CompactionCache): Promise<void> {
    this.compactions.set(sessionId, { ...cache, preservedData: [...cache.preservedData] });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test test/eventStore.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/framework/eventStore.ts test/eventStore.test.ts
git commit -m "feat: add EventStore interface and in-memory implementation"
```

---

## Task 2: Wire `EventStore` into `SessionState` (persistence + compaction-cache fields)

**Files:**
- Modify: `src/framework/sessionState.ts`
- Test: `test/sessionState.persistence.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/sessionState.persistence.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../src/framework/sessionState.ts";
import { InMemoryEventStore } from "../src/framework/eventStore.ts";

test("record() persists events to the EventStore", async () => {
  const store = new InMemoryEventStore();
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z", store);

  state.beginTurn("hello");
  state.recordReply("hi there", true);

  // appendEvent is fire-and-forget; give the microtask queue a tick.
  await new Promise((r) => setTimeout(r, 0));

  const persisted = await store.loadEvents("sess_1");
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0]?.kind, "user_message");
  assert.equal(persisted[1]?.kind, "reply");
});

test("compaction cache getter/setter and recordPromptTokens", () => {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");

  assert.equal(state.compactionCache(), undefined);
  assert.equal(state.lastPromptTokensIn(), undefined);

  state.recordPromptTokens(12345);
  assert.equal(state.lastPromptTokensIn(), 12345);

  state.setCompactionCache({
    summarizedThroughTurn: 1,
    summaryText: "summary",
    preservedData: [],
  });
  assert.deepEqual(state.compactionCache(), {
    summarizedThroughTurn: 1,
    summaryText: "summary",
    preservedData: [],
  });
});

test("compactEvents removes events at or below the given turn", () => {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");
  state.beginTurn("turn 1"); // turn 1
  state.recordReply("reply 1", true);
  state.beginTurn("turn 2"); // turn 2
  state.recordReply("reply 2", true);
  state.beginTurn("turn 3"); // turn 3
  state.recordReply("reply 3", true);

  state.compactEvents(2);

  const remainingTurns = state.allEvents().map((e) => e.turn);
  assert.deepEqual(remainingTurns, [3, 3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test test/sessionState.persistence.test.ts`
Expected: FAIL — `state.compactionCache is not a function` (constructor accepts only 2 args today, no persistence)

- [ ] **Step 3: Implement the changes in `src/framework/sessionState.ts`**

Add the import at the top of the file:

```typescript
import type { CompactionCache, EventStore } from "./eventStore.ts";
```

Update the `SessionState` class — constructor, new fields, and new methods. Replace lines 67-78 (the class header through the constructor):

```typescript
export class SessionState {
  readonly session_id: string;
  readonly started_at: string;
  readonly version = "1" as const;
  private readonly events: SessionEvent[] = [];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly store?: EventStore;
  private turn = 0;
  private promptTokensIn?: number;
  private compaction?: CompactionCache;

  constructor(sessionId: string, startedAt: string, store?: EventStore) {
    this.session_id = sessionId;
    this.started_at = startedAt;
    this.store = store;
  }
```

In `record()`, add persistence as the last step before `return event;` (still inside the existing method body, after the `for (const listener of this.listeners) listener(event);` loop):

```typescript
    if (this.store) {
      this.store.appendEvent(event).catch((err) => {
        console.error(`[sessionState] failed to persist event ${event.event_id}:`, err);
      });
    }
    return event;
```

Add the new accessor methods. Insert them after `get currentTurn()` (after line 124's closing brace):

```typescript
  /** Tokens used by the most recent main-agent ("orchestrator") LLM call.
   *  Used by contextCompaction to decide whether to compact. */
  recordPromptTokens(tokensIn: number): void {
    this.promptTokensIn = tokensIn;
  }

  lastPromptTokensIn(): number | undefined {
    return this.promptTokensIn;
  }

  compactionCache(): CompactionCache | undefined {
    return this.compaction;
  }

  setCompactionCache(cache: CompactionCache): void {
    this.compaction = cache;
  }

  /** Remove all events with `turn <= throughTurn` from the in-memory log.
   *  Safe to call after compact() has folded those turns into the
   *  compaction cache — the EventStore retains the full history. */
  compactEvents(throughTurn: number): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.turn <= throughTurn) this.events.splice(i, 1);
    }
  }
```

Finally, add a static restore factory at the bottom of the class, right before the closing brace (after `allEvents()`, around line 355):

```typescript
  /** Reconstruct a SessionState from previously persisted events + compaction
   *  cache (used by SessionRegistry on cold start). */
  static restore(
    sessionId: string,
    startedAt: string,
    events: SessionEvent[],
    compaction: CompactionCache | undefined,
    store: EventStore | undefined,
  ): SessionState {
    const state = new SessionState(sessionId, startedAt, store);
    state.events.push(...events);
    state.turn = events.reduce((max, e) => Math.max(max, e.turn), 0);
    if (compaction) state.compaction = compaction;
    return state;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test test/sessionState.persistence.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full existing test suite to check for regressions**

Run: `node --env-file=.env --experimental-strip-types scripts/test-agent.ts`
Expected: same pass/fail counts as before this change (no new failures)

- [ ] **Step 6: Commit**

```bash
git add src/framework/sessionState.ts test/sessionState.persistence.test.ts
git commit -m "feat: add EventStore persistence and compaction-cache fields to SessionState"
```

---

## Task 3: `SessionRegistry` — async `getOrCreate`, `getExisting`, restore-from-store

**Files:**
- Modify: `src/framework/sessionState.ts`
- Test: `test/sessionState.persistence.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/sessionState.persistence.test.ts`:

```typescript
import { SessionRegistry } from "../src/framework/sessionState.ts";

test("SessionRegistry restores a session from the EventStore on cold start", async () => {
  const store = new InMemoryEventStore();

  // First registry: create a session and write a couple of events.
  const registry1 = new SessionRegistry(store);
  const state1 = await registry1.getOrCreate("sess_restore");
  state1.beginTurn("hello");
  state1.recordReply("hi", true);
  await new Promise((r) => setTimeout(r, 0)); // let fire-and-forget writes land
  state1.setCompactionCache({ summarizedThroughTurn: 0, summaryText: "", preservedData: [] });

  // Second registry (simulating a process restart): same store, fresh map.
  const registry2 = new SessionRegistry(store);
  const state2 = await registry2.getOrCreate("sess_restore");

  assert.equal(state2.allEvents().length, 2);
  assert.equal(state2.currentTurn, 1);
});

test("SessionRegistry.getExisting throws for an unknown session", () => {
  const registry = new SessionRegistry();
  assert.throws(() => registry.getExisting("nope"), /session not found/);
});

test("SessionRegistry.getExisting returns a session created via getOrCreate", async () => {
  const registry = new SessionRegistry();
  const created = await registry.getOrCreate("sess_x");
  assert.equal(registry.getExisting("sess_x"), created);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test test/sessionState.persistence.test.ts`
Expected: FAIL — `registry1.getOrCreate(...).then is not a function` (currently sync) and `getExisting is not a function`

- [ ] **Step 3: Implement the changes in `src/framework/sessionState.ts`**

Replace the `SessionRegistry` class (lines 359-374) with:

```typescript
/** Holds one SessionState per session id (replaces the global Stores object). */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly store?: EventStore;

  constructor(store?: EventStore) {
    this.store = store;
  }

  /** Return the in-memory session, restoring it from the EventStore on cold
   *  start if one is configured and has prior events for this session. */
  async getOrCreate(sessionId: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    let state: SessionState;
    if (this.store) {
      const events = await this.store.loadEvents(sessionId);
      if (events.length > 0) {
        const compaction = await this.store.loadCompaction(sessionId);
        state = SessionState.restore(sessionId, events[0]!.timestamp, events, compaction, this.store);
      } else {
        state = new SessionState(sessionId, new Date().toISOString(), this.store);
      }
    } else {
      state = new SessionState(sessionId, new Date().toISOString(), this.store);
    }
    this.sessions.set(sessionId, state);
    return state;
  }

  /** Synchronous lookup for a session that getOrCreate has already resolved
   *  this request — used by code that runs after the orchestrator's initial
   *  await getOrCreate(). Throws if the session isn't in memory yet. */
  getExisting(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`session not found: ${sessionId}`);
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test test/sessionState.persistence.test.ts`
Expected: PASS (6 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/framework/sessionState.ts test/sessionState.persistence.test.ts
git commit -m "feat: make SessionRegistry.getOrCreate async with EventStore restore, add getExisting"
```

---

## Task 4: Update call sites for async `getOrCreate`

**Files:**
- Modify: `src/framework/orchestrator.ts:111,114`
- Modify: `src/agent/createApp.ts:31-32`
- Modify: `src/server/server.ts:153`

- [ ] **Step 1: Update `src/framework/orchestrator.ts`**

Line 111-114 currently:

```typescript
    const state = this.sessions.getOrCreate(input.sessionId);
    const turn = state.beginTurn(input.userMessage);

    const dispatcher = this.dispatcherFactory(input.sessionId);
```

Change to:

```typescript
    const state = await this.sessions.getOrCreate(input.sessionId);
    const turn = state.beginTurn(input.userMessage);

    const dispatcher = this.dispatcherFactory(input.sessionId);
```

(`run()` is already `async`, so `await` is valid here. `dispatcherFactory` will use `getExisting` after Task 5's change to `createApp.ts`, so it stays synchronous.)

- [ ] **Step 2: Update `src/agent/createApp.ts`**

Lines 31-32 currently:

```typescript
  const dispatcherFactory = (sessionId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime, toolRegistry, sessions.getOrCreate(sessionId));
```

Change to:

```typescript
  const dispatcherFactory = (sessionId: string) =>
    new Dispatcher(sessionId, subagents, subagentRuntime, toolRegistry, sessions.getExisting(sessionId));
```

This is safe because `dispatcherFactory` is only called from `orchestrator.run()` (orchestrator.ts:114), which has already `await`ed `sessions.getOrCreate(input.sessionId)` on the line before — the session is guaranteed to be in the registry's in-memory map by then.

- [ ] **Step 3: Update `src/server/server.ts`**

Line 153 currently:

```typescript
  const unsub = attachSse(app.sessions.getOrCreate(sessionId), (frame) => sseWrite(res, frame));
```

Change to:

```typescript
  const unsub = attachSse(await app.sessions.getOrCreate(sessionId), (frame) => sseWrite(res, frame));
```

(`handleChat` is already `async`.)

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: no new TypeScript errors

- [ ] **Step 5: Run the smoke test**

Run: `node --env-file=.env --experimental-strip-types scripts/test-agent.ts`
Expected: same pass/fail counts as before (mock LLM provider, no Mongo configured yet → `SessionRegistry` constructed with no store, behaves exactly as before)

- [ ] **Step 6: Commit**

```bash
git add src/framework/orchestrator.ts src/agent/createApp.ts src/server/server.ts
git commit -m "refactor: await SessionRegistry.getOrCreate at call sites, use getExisting in dispatcherFactory"
```

---

## Task 5: `MongoEventStore`

**Files:**
- Create: `src/infra/db/mongoEventStore.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the `mongodb` dependency**

```bash
pnpm add mongodb
```

Expected: `package.json` `dependencies` gains `"mongodb": "^6.x.x"`, `pnpm-lock.yaml` updates.

- [ ] **Step 2: Implement `src/infra/db/mongoEventStore.ts`**

```typescript
// src/infra/db/mongoEventStore.ts
import { MongoClient, type Collection } from "mongodb";
import { createLogger } from "../logger/logger.ts";
import type { CompactionCache, EventStore, PreservedDataEntry } from "../../framework/eventStore.ts";
import type { SessionEvent } from "../../framework/sessionState.ts";

const log = createLogger("mongo-event-store");

type CompactionDoc = {
  session_id: string;
  summarizedThroughTurn: number;
  summaryText: string;
  preservedData: PreservedDataEntry[];
  updatedAt: string;
};

/** MongoDB-backed EventStore. Connect with `MongoEventStore.connect(uri)`. */
export class MongoEventStore implements EventStore {
  private readonly client: MongoClient;
  private readonly events: Collection<SessionEvent>;
  private readonly compactions: Collection<CompactionDoc>;

  private constructor(client: MongoClient, events: Collection<SessionEvent>, compactions: Collection<CompactionDoc>) {
    this.client = client;
    this.events = events;
    this.compactions = compactions;
  }

  static async connect(uri: string): Promise<MongoEventStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    const db = client.db();
    const events = db.collection<SessionEvent>("session_events");
    const compactions = db.collection<CompactionDoc>("session_compaction");
    await events.createIndex({ session_id: 1, event_id: 1 }, { unique: true });
    await events.createIndex({ session_id: 1, turn: 1 });
    log.info(`connected to ${uri}`);
    return new MongoEventStore(client, events, compactions);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    await this.events.insertOne({ ...event });
  }

  async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    const docs = await this.events
      .find({ session_id: sessionId }, { projection: { _id: 0 } })
      .sort({ timestamp: 1 })
      .toArray();
    return docs as unknown as SessionEvent[];
  }

  async loadCompaction(sessionId: string): Promise<CompactionCache | undefined> {
    const doc = await this.compactions.findOne({ session_id: sessionId }, { projection: { _id: 0 } });
    if (!doc) return undefined;
    return {
      summarizedThroughTurn: doc.summarizedThroughTurn,
      summaryText: doc.summaryText,
      preservedData: doc.preservedData,
    };
  }

  async saveCompaction(sessionId: string, cache: CompactionCache): Promise<void> {
    await this.compactions.updateOne(
      { session_id: sessionId },
      { $set: { ...cache, session_id: sessionId, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: no new TypeScript errors (the `mongodb` package ships its own types)

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/infra/db/mongoEventStore.ts
git commit -m "feat: add MongoEventStore implementation of EventStore"
```

---

## Task 6: Wire `MongoEventStore` into `createApp.ts` (with fallback)

**Files:**
- Modify: `src/agent/createApp.ts`

- [ ] **Step 1: Add a `resolveEventStore` helper and use it**

Add this import near the top of `src/agent/createApp.ts`:

```typescript
import { MongoEventStore } from "../infra/db/mongoEventStore.ts";
import type { EventStore } from "../framework/eventStore.ts";
```

Replace `const sessions = new SessionRegistry();` (line 20) with:

```typescript
  const eventStore = await resolveEventStore();
  const sessions = new SessionRegistry(eventStore);
```

Add the helper function near the bottom of the file, alongside `resolveLlmProvider` and `resolveSkillsPath`:

```typescript
async function resolveEventStore(): Promise<EventStore | undefined> {
  const uri = process.env["MONGODB_URI"] ?? "mongodb://localhost:27017/financial-agent";
  try {
    return await MongoEventStore.connect(uri);
  } catch (err) {
    console.warn(
      `[sessions] could not connect to MongoDB at ${uri}; sessions will not persist across restarts: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: no new TypeScript errors

- [ ] **Step 3: Run the smoke test without a local Mongo running**

Run: `node --env-file=.env --experimental-strip-types scripts/test-agent.ts`
Expected: a `[sessions] could not connect to MongoDB ...` warning is printed, then the smoke test runs and passes exactly as before (graceful fallback to in-memory)

- [ ] **Step 4: (Optional, if Docker available) Run the smoke test with a local Mongo**

```bash
docker run -d --name financial-agent-mongo -p 27017:27017 mongo:7
node --env-file=.env --experimental-strip-types scripts/test-agent.ts
```

Expected: a `[mongo-event-store] connected to mongodb://localhost:27017/financial-agent` log line, smoke test passes, and `mongosh financial-agent --eval "db.session_events.countDocuments()"` returns a count > 0

- [ ] **Step 5: Commit**

```bash
git add src/agent/createApp.ts
git commit -m "feat: wire MongoEventStore into createFinancialAgentApp with in-memory fallback"
```

---

## Task 7: `contextCompaction.ts` — config + `compact()`

**Files:**
- Create: `src/framework/contextCompaction.ts`
- Test: `test/contextCompaction.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/contextCompaction.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../src/framework/sessionState.ts";
import { ModelRouter, type LlmProvider } from "../src/infra/llm/provider.ts";
import { compact } from "../src/framework/contextCompaction.ts";

function fakeProvider(summaryText: string): LlmProvider {
  return {
    name: "fake",
    async generate(messages) {
      return {
        text: summaryText,
        metrics: { tokens_in: 10, tokens_out: 10, ms: 1, model_class: "SMALL", provider: "fake" },
      };
    },
  };
}

function buildSession(): SessionState {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");

  // Turn 1
  state.beginTurn("What's BTC's on-chain inflow looking like?");
  const dispatch = state.recordDispatch("onchain_data", "fetch BTC exchange inflow/outflow");
  state.recordTaskResult("onchain_data", dispatch.event_id, {
    task_id: dispatch.event_id,
    agent: "onchain_data",
    status: "ok",
    summary: "Inflow is up 12% over 24h",
    generation_context: { prompt: "compute inflow/outflow for BTC", data: { inflow: 1200, outflow: 900 } },
    artifacts: [{ type: "file", ref: "./reports/flow.txt", label: "Flow data" }],
  });
  state.recordReply("BTC inflows are up 12% over the last 24h.", true);

  // Turn 2
  state.beginTurn("What about ETH?");
  state.recordReply("ETH inflows are roughly flat.", true);

  return state;
}

test("compact() summarizes turns 1..targetThrough and preserves task data without prompt/artifacts", async () => {
  const state = buildSession();
  const router = new ModelRouter(fakeProvider("User is researching BTC and ETH on-chain flows."));

  await compact(state, router, 1, 1);

  const cache = state.compactionCache();
  assert.ok(cache);
  assert.equal(cache!.summarizedThroughTurn, 1);
  assert.equal(cache!.summaryText, "User is researching BTC and ETH on-chain flows.");
  assert.deepEqual(cache!.preservedData, [
    { turn: 1, agent: "onchain_data", data: { inflow: 1200, outflow: 900 } },
  ]);

  // Turn 1 events have been trimmed from the in-memory log.
  const remainingTurns = new Set(state.allEvents().map((e) => e.turn));
  assert.deepEqual([...remainingTurns], [2]);
});

test("compact() merges with an existing summary on a second call", async () => {
  const state = buildSession();
  state.beginTurn("And SOL?"); // turn 3
  state.recordReply("SOL inflows are up slightly.", true);

  const router1 = new ModelRouter(fakeProvider("Summary through turn 1."));
  await compact(state, router1, 1, 1);

  const router2 = new ModelRouter(fakeProvider("Summary through turn 2, building on turn 1."));
  await compact(state, router2, 2, 2);

  const cache = state.compactionCache();
  assert.equal(cache!.summarizedThroughTurn, 2);
  assert.equal(cache!.summaryText, "Summary through turn 2, building on turn 1.");
  assert.deepEqual(new Set(state.allEvents().map((e) => e.turn)), new Set([3]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test test/contextCompaction.test.ts`
Expected: FAIL — `Cannot find module '../src/framework/contextCompaction.ts'`

- [ ] **Step 3: Implement `src/framework/contextCompaction.ts`**

```typescript
// src/framework/contextCompaction.ts
import type { ModelRouter } from "../infra/llm/provider.ts";
import type { GenerationContext } from "./types.ts";
import type { PreservedDataEntry } from "./eventStore.ts";
import type { SessionState } from "./sessionState.ts";

/** Main-agent (LARGE modelClass) context window in tokens, used to compute
 *  the 60% threshold. anthropicProvider's default LARGE model (claude-opus-4-8)
 *  has a 200k window; if switching to googleProvider's gemini-2.5-pro
 *  (1M window) this should be raised to ~1000000, or compaction will trigger
 *  far earlier than necessary. */
export const ORCHESTRATOR_CONTEXT_WINDOW_TOKENS = Number(
  process.env["ORCHESTRATOR_CONTEXT_WINDOW_TOKENS"] ?? 200_000,
);

/** Fraction of the context window that triggers compaction. */
export const COMPACTION_THRESHOLD_RATIO = Number(process.env["COMPACTION_THRESHOLD_RATIO"] ?? 0.6);

/** Number of most-recent prior turns kept verbatim (never compacted). */
export const COMPACTION_KEEP_RECENT_TURNS = Number(process.env["COMPACTION_KEEP_RECENT_TURNS"] ?? 3);

const COMPACTION_SYSTEM_PROMPT = `You are compacting a long conversation between a user and a crypto trading/analysis agent.
Given the existing summary (if any) and the new conversation turns below, produce an updated, concise summary.
Focus on the user's intent, preferences, and any conclusions or decisions already established.
Do not restate specific numeric data points (prices, indicator values, balances) — those are preserved separately.
Respond with the summary text only, no preamble.`;

/** Fold turns [from, targetThrough] into the rolling compaction cache:
 *  - user/assistant turn text → merged into a new LLM-generated summary
 *  - task_result generation_context.data → appended to preservedData verbatim
 *  - generation_context.prompt and UI-only visualizations are dropped entirely
 *  Then trims those turns from the in-memory event log (the EventStore, if
 *  configured, retains the full history). */
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
  state.compactEvents(targetThrough);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test test/contextCompaction.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/framework/contextCompaction.ts test/contextCompaction.test.ts
git commit -m "feat: add compact() — rolling summary + preserved task data + memory trim"
```

---

## Task 8: `maybeCompact()` trigger logic

**Files:**
- Modify: `src/framework/contextCompaction.ts`
- Test: `test/contextCompaction.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/contextCompaction.test.ts`:

```typescript
import { maybeCompact } from "../src/framework/contextCompaction.ts";

function buildFiveTurnSession(): SessionState {
  const state = new SessionState("sess_2", "2026-06-10T00:00:00.000Z");
  for (let i = 1; i <= 5; i++) {
    state.beginTurn(`question ${i}`);
    state.recordReply(`answer ${i}`, true);
  }
  return state;
}

test("maybeCompact does nothing below the threshold", async () => {
  const state = buildFiveTurnSession();
  state.recordPromptTokens(Math.floor(0.5 * 200_000)); // 50% < 60%
  const router = new ModelRouter(fakeProvider("should not be called"));

  await maybeCompact(state, router, 6);

  assert.equal(state.compactionCache(), undefined);
  assert.equal(state.allEvents().length, 10); // 5 turns * 2 events, nothing trimmed
});

test("maybeCompact compacts turns older than the last N when over threshold", async () => {
  const state = buildFiveTurnSession();
  state.recordPromptTokens(Math.floor(0.7 * 200_000)); // 70% >= 60%
  const router = new ModelRouter(fakeProvider("Summary of turns 1-2."));

  // currentTurn=6, KEEP_RECENT_TURNS=3 → targetThrough = 6 - 1 - 3 = 2
  await maybeCompact(state, router, 6);

  const cache = state.compactionCache();
  assert.ok(cache);
  assert.equal(cache!.summarizedThroughTurn, 2);
  assert.deepEqual(new Set(state.allEvents().map((e) => e.turn)), new Set([3, 4, 5]));
});

test("maybeCompact is a no-op when no prompt tokens have been recorded yet", async () => {
  const state = buildFiveTurnSession();
  const router = new ModelRouter(fakeProvider("should not be called"));

  await maybeCompact(state, router, 6);

  assert.equal(state.compactionCache(), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test test/contextCompaction.test.ts`
Expected: FAIL — `maybeCompact is not a function`

- [ ] **Step 3: Implement `maybeCompact` in `src/framework/contextCompaction.ts`**

Append to the bottom of the file:

```typescript
/** Checks the previous orchestrator turn's prompt-token usage and, if it's at
 *  or above COMPACTION_THRESHOLD_RATIO of the context window, folds turns
 *  older than the last COMPACTION_KEEP_RECENT_TURNS into the rolling
 *  compaction cache. No-op if nothing new needs folding. */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test test/contextCompaction.test.ts`
Expected: PASS (5 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/framework/contextCompaction.ts test/contextCompaction.test.ts
git commit -m "feat: add maybeCompact() threshold check"
```

---

## Task 9: `projectForPrompt` renders the compaction cache

**Files:**
- Modify: `src/framework/sessionState.ts`
- Test: `test/sessionState.projection.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/sessionState.projection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../src/framework/sessionState.ts";

test("projectForPrompt without a compaction cache renders prior turns as before", () => {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");
  state.beginTurn("turn 1 question");
  state.recordReply("turn 1 answer", true);
  state.beginTurn("turn 2 question");

  const proj = state.projectForPrompt(2);

  assert.equal(proj.conversationSoFar, "User: turn 1 question\nYou: turn 1 answer");
  assert.ok(!proj.conversationSoFar.includes("[EARLIER CONVERSATION SUMMARY]"));
});

test("projectForPrompt with a compaction cache prepends summary + preserved data", () => {
  const state = new SessionState("sess_1", "2026-06-10T00:00:00.000Z");
  // Simulate post-compaction state: turns 1-2 trimmed, turn 3 remains.
  state.beginTurn("turn 3 question"); // turn 1 in this fresh state's counter terms
  state.recordReply("turn 3 answer", true);
  state.setCompactionCache({
    summarizedThroughTurn: 2,
    summaryText: "User has been asking about BTC and ETH on-chain flows.",
    preservedData: [
      { turn: 1, agent: "onchain_data", data: { inflow: 1200 } },
      { turn: 2, agent: "technical", data: { rsi: 58 } },
    ],
  });

  const proj = state.projectForPrompt(2);

  assert.match(proj.conversationSoFar, /^\[EARLIER CONVERSATION SUMMARY\]/);
  assert.match(proj.conversationSoFar, /User has been asking about BTC and ETH on-chain flows\./);
  assert.match(proj.conversationSoFar, /\[DATA FROM EARLIER TASKS\]/);
  assert.match(proj.conversationSoFar, /- turn 1 \(onchain_data\): \{"inflow":1200\}/);
  assert.match(proj.conversationSoFar, /- turn 2 \(technical\): \{"rsi":58\}/);
  assert.match(proj.conversationSoFar, /\[RECENT CONVERSATION\]\nUser: turn 3 question\nYou: turn 3 answer/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test test/sessionState.projection.test.ts`
Expected: FAIL — second test's assertions on `[EARLIER CONVERSATION SUMMARY]` fail (current `conversationSoFar` doesn't render the cache)

- [ ] **Step 3: Implement the rendering change in `src/framework/sessionState.ts`**

In `projectForPrompt`, replace the return statement's `conversationSoFar` field. The method currently ends with:

```typescript
    return {
      conversationSoFar: priorLines.length ? priorLines.join("\n") : "(no prior conversation)",
      currentTurnProgress: progressLines.join("\n"),
      artifacts,
    };
  }
```

Replace it with:

```typescript
    return {
      conversationSoFar: this.renderConversationSoFar(priorLines),
      currentTurnProgress: progressLines.join("\n"),
      artifacts,
    };
  }

  private renderConversationSoFar(priorLines: string[]): string {
    if (!this.compaction) {
      return priorLines.length ? priorLines.join("\n") : "(no prior conversation)";
    }
    const dataLines = this.compaction.preservedData.map(
      (d) => `- turn ${d.turn} (${d.agent}): ${JSON.stringify(d.data)}`,
    );
    return [
      "[EARLIER CONVERSATION SUMMARY]",
      this.compaction.summaryText,
      "",
      "[DATA FROM EARLIER TASKS]",
      dataLines.length ? dataLines.join("\n") : "(none)",
      "",
      "[RECENT CONVERSATION]",
      priorLines.length ? priorLines.join("\n") : "(no recent conversation)",
    ].join("\n");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test test/sessionState.projection.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/framework/sessionState.ts test/sessionState.projection.test.ts
git commit -m "feat: render compaction summary + preserved data in projectForPrompt"
```

---

## Task 10: Wire the trigger into `orchestrator.run()`

**Files:**
- Modify: `src/framework/orchestrator.ts`

- [ ] **Step 1: Import the new module**

Add near the other framework imports at the top of `src/framework/orchestrator.ts`:

```typescript
import { maybeCompact } from "./contextCompaction.ts";
```

- [ ] **Step 2: Call `maybeCompact` before the step loop**

After `const turn = state.beginTurn(input.userMessage);` and before `const dispatcher = this.dispatcherFactory(input.sessionId);` (orchestrator.ts:112-114), insert:

```typescript
    await maybeCompact(state, this.modelRouter, turn);
```

So the block reads:

```typescript
    const state = await this.sessions.getOrCreate(input.sessionId);
    const turn = state.beginTurn(input.userMessage);

    await maybeCompact(state, this.modelRouter, turn);

    const dispatcher = this.dispatcherFactory(input.sessionId);
```

- [ ] **Step 3: Record prompt tokens after each orchestrator LLM call**

The orchestrator LLM call is at orchestrator.ts:142-150:

```typescript
      let completionText: string;
      try {
        const completion = await this.modelRouter.generate(
          [
            { role: "system", content: rendered.system },
            { role: "user", content: rendered.prompt },
          ],
          { modelClass: "LARGE", temperature: 0.2, metadata: { mode: "orchestrator" } },
        );
        completionText = completion.text;
      } catch (error) {
```

Change the `try` body to also record tokens:

```typescript
      let completionText: string;
      try {
        const completion = await this.modelRouter.generate(
          [
            { role: "system", content: rendered.system },
            { role: "user", content: rendered.prompt },
          ],
          { modelClass: "LARGE", temperature: 0.2, metadata: { mode: "orchestrator" } },
        );
        completionText = completion.text;
        state.recordPromptTokens(completion.metrics.tokens_in);
      } catch (error) {
```

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: no new TypeScript errors

- [ ] **Step 5: Run the smoke test**

Run: `node --env-file=.env --experimental-strip-types scripts/test-agent.ts`
Expected: same pass/fail counts as before — with `MockLlmProvider`, `tokens_in` is small (estimated from prompt length / 4) and stays well under 60% of 200,000, so `maybeCompact` is a no-op and behavior is unchanged

- [ ] **Step 6: Commit**

```bash
git add src/framework/orchestrator.ts
git commit -m "feat: trigger context auto-compaction at the start of each orchestrator turn"
```

---

## Task 11: tsconfig + final verification

**Files:**
- Modify: `tsconfig.json`

- [ ] **Step 1: Add `test/**/*.ts` to the TypeScript project**

In `tsconfig.json`, the `include` array currently is:

```json
  "include": ["src/**/*.ts", "mcp_tools/**/*.ts", "tests/**/*.ts"]
```

Change to:

```json
  "include": ["src/**/*.ts", "mcp_tools/**/*.ts", "tests/**/*.ts", "test/**/*.ts"]
```

- [ ] **Step 2: Full typecheck**

Run: `pnpm build`
Expected: no errors

- [ ] **Step 3: Run all new unit tests together**

Run: `node --experimental-strip-types --test test/eventStore.test.ts test/sessionState.persistence.test.ts test/contextCompaction.test.ts test/sessionState.projection.test.ts`
Expected: all pass (13 tests total across the four files)

- [ ] **Step 4: Run the end-to-end smoke test**

Run: `node --env-file=.env --experimental-strip-types scripts/test-agent.ts`
Expected: same pass/fail counts as the baseline run before this plan started

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json
git commit -m "chore: include test/**/*.ts in tsconfig"
```

---

## Spec Coverage Check

- §3 MongoDB schema/write/restore → Tasks 1, 2, 3, 5, 6.
- §4 Trigger mechanism (`lastPromptTokensIn`, 60% ratio, last-N-turns) → Tasks 2, 8, 10.
- §5 Compaction algorithm (rolling summary, preservedData, drop prompt/artifacts, memory trim) → Tasks 7, 8.
- §6 Prompt rendering (`[EARLIER CONVERSATION SUMMARY]` / `[DATA FROM EARLIER TASKS]` / `[RECENT CONVERSATION]`, backward-compatible when no cache) → Task 9.
- §7 Config (`ORCHESTRATOR_CONTEXT_WINDOW_TOKENS`, `COMPACTION_THRESHOLD_RATIO`, `COMPACTION_KEEP_RECENT_TURNS`, `MONGODB_URI`) → Tasks 6, 7.
- §9 Verification plan → covered by each task's TDD steps plus Task 11's combined run.
