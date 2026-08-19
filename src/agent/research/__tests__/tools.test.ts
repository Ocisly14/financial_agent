import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter, type GenerateOptions, type LlmMessage, type LlmProvider } from "../../../infra/llm/provider.ts";
import { SessionRegistry } from "../../../framework/sessionState.ts";
import { InMemoryEventStore } from "../../../framework/eventStore.ts";
import type { ResearchMember, TopicChartPreferenceRow, TopicSummary } from "../../../infra/db/sqliteEventStore.ts";
import { buildIndexedTurns } from "../../topicDigest.ts";
import {
  ResearchToolset,
  type ResearchFrame,
  type ResearchToolStore,
} from "../tools.ts";

// ── doubles ───────────────────────────────────────────────────────────────

/** Builds a `kind: "symbol"` row for test fixtures — the id is synthetic and
 *  unused by any assertion here, matching the "server always regenerates it"
 *  contract these tests exercise indirectly through `editTabs`. */
function symbolRow(
  symbol: string,
  opts: { range?: number | null; hidden?: boolean; sortOrder: number },
): TopicChartPreferenceRow {
  return {
    id: `chart_${symbol}`,
    kind: "symbol",
    symbol,
    range: opts.range ?? null,
    hidden: opts.hidden ?? false,
    sortOrder: opts.sortOrder,
  };
}

/** Narrows a mixed row list down to its symbol tickers — overlay rows have no
 *  single ticker, so callers that only ever seed symbol rows use this instead
 *  of an unsafe `.symbol` access on the union. */
function symbolsOf(rows: TopicChartPreferenceRow[]): string[] {
  return rows.filter((row): row is Extract<TopicChartPreferenceRow, { kind: "symbol" }> => row.kind === "symbol").map((row) => row.symbol);
}

/** Builds a `kind: "overlay"` row for test fixtures. */
function overlayRow(
  id: string,
  symbols: string[],
  opts: { range?: number; normalize?: "pct" | "index100"; hidden?: boolean; sortOrder: number },
): TopicChartPreferenceRow {
  const range = opts.range ?? 252;
  return {
    id,
    kind: "overlay",
    overlay: { symbols, range, normalize: opts.normalize ?? "pct" },
    range,
    hidden: opts.hidden ?? false,
    sortOrder: opts.sortOrder,
  };
}

class FakeStore implements ResearchToolStore {
  topics: TopicSummary[] = [];
  charts = new Map<string, TopicChartPreferenceRow[]>();
  members: ResearchMember[] = [];
  seen: Array<{ topicId: string; turn: number }> = [];

  createTopic(_tenantId: string, topicId: string, name: string, createdAt = Date.now()): TopicSummary {
    const topic: TopicSummary = {
      id: topicId, name, leadSymbol: null, subjectSymbols: [], createdAt, lastMessage: null, messageCount: 0,
      summary: null, category: null, categoryLocked: false,
    };
    this.topics.push(topic);
    return topic;
  }
  listTopics(): TopicSummary[] {
    return [...this.topics];
  }
  listTopicCharts(topicId: string): TopicChartPreferenceRow[] {
    return (this.charts.get(topicId) ?? []).map((row) => ({ ...row }));
  }
  replaceTopicCharts(topicId: string, rows: TopicChartPreferenceRow[]): void {
    this.charts.set(topicId, rows.map((row) => ({ ...row })));
  }
  listResearchMembers(): ResearchMember[] {
    return this.members.map((member) => ({ ...member }));
  }
  replaceResearchMembers(_researchId: string, topicIds: string[]): void {
    const previous = new Map(this.members.map((m) => [m.topicId, m]));
    this.members = topicIds.map((topicId, index) => ({
      topicId,
      sortOrder: index,
      digest: previous.get(topicId)?.digest ?? null,
      digestThroughTurn: previous.get(topicId)?.digestThroughTurn ?? 0,
      seenThroughTurn: previous.get(topicId)?.seenThroughTurn ?? 0,
    }));
  }
  setMemberSeenTurn(_researchId: string, topicId: string, seenThroughTurn: number): void {
    this.seen.push({ topicId, turn: seenThroughTurn });
  }
}

function routerReturning(reply: string | ((messages: LlmMessage[]) => string)): ModelRouter {
  const provider: LlmProvider = {
    name: "fake",
    async generate(messages: LlmMessage[], options: GenerateOptions) {
      const text = typeof reply === "string" ? reply : reply(messages);
      return {
        text,
        metrics: { tokens_in: 0, tokens_out: 0, ms: 0, model_class: options.modelClass, provider: "fake" },
      };
    },
  };
  return new ModelRouter(provider);
}

type Harness = {
  toolset: ResearchToolset;
  store: FakeStore;
  sessions: SessionRegistry;
  frames: ResearchFrame[];
  runs: Array<{ sessionId: string; userMessage: string; allowUserInput?: boolean; activeModel?: { modelId: string } }>;
};

function harness(options: {
  run?: (input: { sessionId: string; userMessage: string; allowUserInput?: boolean; activeModel?: { modelId: string } }) => Promise<{ response: string }>;
  router?: ModelRouter;
  askTimeoutMs?: number;
  activeModel?: {
    modelId: string; topicId: string; symbol: string; createdAt: string; updatedAt: string;
    currentRevision: number; lifecycleStage: string;
  };
  onDigestSchedule?: (topicId: string) => void;
} = {}): Harness {
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  const frames: ResearchFrame[] = [];
  const runs: Array<{ sessionId: string; userMessage: string; allowUserInput?: boolean; activeModel?: { modelId: string } }> = [];
  const toolset = new ResearchToolset({
    tenantId: "default",
    researchId: "res_1",
    researchName: "半导体估值",
    store,
    sessions,
    orchestrator: {
      async run(input) {
        runs.push(input);
        return options.run ? options.run(input) : { response: `reply to ${input.userMessage}` };
      },
      async consult(input) {
        return { response: `consultation for ${input.question}` };
      },
    },
    modelRouter: options.router ?? routerReturning("{}"),
    emit: (frame) => frames.push(frame),
    ...(options.onDigestSchedule ? { topicDigests: { schedule: options.onDigestSchedule } } : {}),
    ...(options.activeModel ? { activeModel: options.activeModel } : {}),
    ...(options.askTimeoutMs === undefined ? {} : { askTimeoutMs: options.askTimeoutMs }),
    idFactory: (prefix) => `${prefix}_test_${store.topics.length + 1}`,
  });
  toolset.beginTurn();
  return { toolset, store, sessions, frames, runs };
}

// ── dispatch_task: persistent Topic work ──────────────────────────────────

test("dispatch_task runs the Topic's own orchestrator and returns its final reply", async () => {
  const h = harness();
  h.store.createTopic("default", "room_a", "AAPL");
  h.store.replaceResearchMembers("res_1", ["room_a"]);

  const result = await h.toolset.dispatchTask("room_a", "渠道库存怎么样？");

  assert.equal(result.status, "ok");
  assert.equal(result.reply, "reply to 渠道库存怎么样？");
  assert.deepEqual(h.runs, [{ tenantId: "default", sessionId: "room_a", userMessage: "渠道库存怎么样？" }],
    "the background Topic run must not surface an input card outside the current Research");
});

test("dispatch_task arms the Topic digest scheduler after the driven turn completes", async () => {
  const scheduled: string[] = [];
  const h = harness({ onDigestSchedule: (topicId) => scheduled.push(topicId) });
  h.store.createTopic("default", "room_a", "AAPL");

  await h.toolset.dispatchTask("room_a", "Review the latest results");

  assert.deepEqual(scheduled, ["room_a"]);
});

test("a selected Research model is advisory context only for its owning member", async () => {
  const h = harness({ activeModel: {
    modelId: "model_aapl", topicId: "room_a", symbol: "AAPL", createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z", currentRevision: 7, lifecycleStage: "valued",
  } });
  h.store.createTopic("default", "room_a", "AAPL");
  h.store.createTopic("default", "room_b", "NVDA");
  h.store.replaceResearchMembers("res_1", ["room_a", "room_b"]);

  await h.toolset.dispatchTask("room_a", "revise the visible DCF");
  h.toolset.beginTurn();
  await h.toolset.dispatchTask("room_b", "compare margins");

  assert.equal(h.runs[0]?.activeModel?.modelId, "model_aapl");
  assert.equal(h.runs[1]?.activeModel, undefined);
});

test("the user_message written on the topic carries origin, unchanged content, and no framework edit", async () => {
  // The fake stands in for OrchestratorRuntime.run: the ONLY thing it does
  // that matters here is `state.beginTurn(userMessage)` — the untouched
  // framework call that writes the user_message event.
  let sessions: SessionRegistry;
  const h = harness({
    run: async (input) => {
      const state = await sessions.getOrCreate(input.sessionId);
      state.beginTurn(input.userMessage);
      return { response: "ok" };
    },
  });
  sessions = h.sessions;
  h.store.createTopic("default", "room_a", "AAPL");
  h.store.replaceResearchMembers("res_1", ["room_a"]);

  await h.toolset.dispatchTask("room_a", "查一下渠道库存");

  const state = await h.sessions.getOrCreate("room_a");
  const userEvent = state.allEvents().find((e) => e.kind === "user_message");
  assert.deepEqual(userEvent?.payload.origin, { researchId: "res_1", researchName: "半导体估值" });
  assert.equal(userEvent?.payload.content, "查一下渠道库存", "content is untouched");

  // And the origin stamp is scoped to the message we sent: a turn the human
  // types afterwards on the same Topic must stay unlabelled.
  state.beginTurn("我自己打的问题");
  const human = state.allEvents().filter((e) => e.kind === "user_message").at(-1);
  assert.equal(human?.payload.origin, undefined);
  assert.deepEqual(h.store.seen, [{ topicId: "room_a", turn: 1 }], "a drive it caused is not an external change");
});

test("a topic already driven this turn is not re-entered (recursion depth 1)", async () => {
  const h = harness();
  h.store.createTopic("default", "room_a", "AAPL");

  const first = await h.toolset.dispatchTask("room_a", "问题一");
  const second = await h.toolset.dispatchTask("room_a", "问题二");

  assert.equal(first.status, "ok");
  assert.equal(second.status, "skipped");
  assert.equal(h.runs.length, 1, "the second call must never reach the orchestrator");

  h.toolset.beginTurn();
  const nextTurn = await h.toolset.dispatchTask("room_a", "下一轮的问题");
  assert.equal(nextTurn.status, "ok", "the guard is per turn, not forever");
});

test("at most 3 topics are driven at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const h = harness({
    run: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { response: "ok" };
    },
  });
  const ids = ["a", "b", "c", "d", "e", "f"].map((suffix) => `room_${suffix}`);
  for (const id of ids) h.store.createTopic("default", id, id);

  const results = await Promise.all(ids.map((id) => h.toolset.dispatchTask(id, "go")));

  assert.equal(peak, 3, "concurrency cap is 3");
  assert.deepEqual(results.map((r) => r.status), ids.map(() => "ok"), "all six still run, queued");
});

test("a timed-out dispatch_task fails only that member, and the turn goes on", async () => {
  const h = harness({
    askTimeoutMs: 20,
    run: async (input) =>
      input.sessionId === "room_slow"
        ? new Promise((resolve) => setTimeout(() => resolve({ response: "late" }), 200))
        : { response: "fast" },
  });
  h.store.createTopic("default", "room_slow", "slow");
  h.store.createTopic("default", "room_fast", "fast");

  const [slow, fast] = await Promise.all([
    h.toolset.dispatchTask("room_slow", "go"),
    h.toolset.dispatchTask("room_fast", "go"),
  ]);

  assert.equal(slow!.status, "timeout");
  assert.equal(fast!.status, "ok", "one member's timeout must not abort the whole turn");
});

test("consult_topic is ephemeral: it asks the Topic but writes no member turn", async () => {
  let consulted: { sessionId: string; question: string } | undefined;
  const store = new FakeStore();
  const sessions = new SessionRegistry(new InMemoryEventStore());
  store.createTopic("default", "room_a", "AAPL");
  const toolset = new ResearchToolset({
    tenantId: "default", researchId: "res_1", researchName: "Research", store, sessions,
    orchestrator: {
      async run() { return { response: "unused" }; },
      async consult(input) { consulted = input; return { response: "AAPL's established view is constructive." }; },
    },
    modelRouter: routerReturning("{}"), emit: () => {},
  });

  const result = await toolset.consultTopic("room_a", "What is the established view?");
  assert.equal(result.status, "ok");
  assert.equal(result.reply, "AAPL's established view is constructive.");
  assert.match(consulted!.question, /established Topic context only/);
  assert.equal((await sessions.getOrCreate("room_a")).allEvents().length, 0);
});

// ── layout tools ─────────────────────────────────────────────────────────

test("focus emits a frame and writes nothing", async () => {
  const h = harness();
  h.store.charts.set("room_a", [symbolRow("AAPL", { sortOrder: 0 })]);

  h.toolset.focus("room_a", "nvda");

  assert.deepEqual(h.frames, [{ name: "topic_focus", data: { topicId: "room_a", symbol: "NVDA" } }]);
  assert.deepEqual(symbolsOf(h.store.listTopicCharts("room_a")), ["AAPL"], "nothing persisted");
});

test("edit_tabs persists, marks the change as the agent's, and reports the previous state for undo", () => {
  const h = harness();
  h.store.charts.set("room_a", [symbolRow("AAPL", { range: 252, sortOrder: 0 })]);

  const result = h.toolset.editTabs("room_a", [{ op: "add", symbol: "nvda" }]);

  assert.deepEqual(symbolsOf(result.charts), ["AAPL", "NVDA"]);
  assert.deepEqual(symbolsOf(h.store.listTopicCharts("room_a")), ["AAPL", "NVDA"], "persisted");
  const frame = h.frames.at(-1);
  assert.equal(frame?.name, "layout_changed");
  assert.equal(frame?.name === "layout_changed" && frame.data.source, "agent");
  assert.deepEqual(symbolsOf(result.previous), ["AAPL"]);
});

test("edit_tabs remove deletes the tab outright — hidden is no longer a veto over the agent", () => {
  const h = harness();
  h.store.charts.set("room_a", [
    symbolRow("AAPL", { hidden: true, sortOrder: 0 }),
    symbolRow("NVDA", { sortOrder: 1 }),
  ]);

  // A tab the user had hidden can be re-added by the agent: `hidden` is not a
  // standing veto, it was one deletion (spec §6).
  const readded = h.toolset.editTabs("room_a", [{ op: "add", symbol: "AAPL" }]);
  assert.equal(readded.charts.find((c) => c.kind === "symbol" && c.symbol === "AAPL")?.hidden, false);

  const removed = h.toolset.editTabs("room_a", [{ op: "remove", symbol: "AAPL" }]);
  assert.deepEqual(symbolsOf(removed.charts), ["NVDA"]);
});

test("edit_members adds and removes without deleting the topic", () => {
  const h = harness();
  h.store.createTopic("default", "room_a", "AAPL");
  h.store.createTopic("default", "room_b", "NVDA");
  h.store.replaceResearchMembers("res_1", ["room_a"]);

  const added = h.toolset.editMembers([{ op: "add", topicId: "room_b" }]);
  assert.deepEqual(added.members, ["room_a", "room_b"]);

  const removed = h.toolset.editMembers([{ op: "remove", topicId: "room_a" }]);
  assert.deepEqual(removed.members, ["room_b"]);
  assert.deepEqual(h.store.listTopics().map((t) => t.id), ["room_a", "room_b"], "the topic itself survives");
});

test("edit_members ignores an unknown topic id", () => {
  const h = harness();
  const result = h.toolset.editMembers([{ op: "add", topicId: "room_nope" }]);
  assert.deepEqual(result.members, []);
});

// ── overlay ─────────────────────────────────────────────────────────────

test("overlay persists a new selected tab at sortOrder 0, shifting existing rows back", () => {
  const h = harness();
  h.store.charts.set("room_a", [symbolRow("AAPL", { range: 252, sortOrder: 0 })]);

  const result = h.toolset.overlay("room_a", ["nvda", "aapl", "amd"]);

  assert.equal(result.chart.kind, "overlay");
  assert.equal(result.chart.sortOrder, 0);
  assert.deepEqual(result.chart.overlay.symbols, ["NVDA", "AAPL", "AMD"]);
  assert.equal(result.chart.overlay.normalize, "pct", "defaults to pct");
  const persisted = h.store.listTopicCharts("room_a");
  assert.deepEqual(
    persisted.map((row) => [row.kind, row.sortOrder]),
    [["overlay", 0], ["symbol", 1]],
    "the overlay tab is at the front; the existing tab shifted back",
  );
});

test("overlay defaults range to the member's own current lead chart range", () => {
  const h = harness();
  h.store.charts.set("room_a", [
    symbolRow("SPY", { hidden: true, range: 1, sortOrder: 0 }),
    symbolRow("AAPL", { range: 63, sortOrder: 1 }),
  ]);

  const result = h.toolset.overlay("room_a", ["AAPL", "NVDA"]);

  assert.equal(result.chart.overlay.range, 63, "the hidden row is skipped; AAPL is the visible lead");
});

test("overlay falls back to a default range when the member has no existing charts", () => {
  const h = harness();
  const result = h.toolset.overlay("room_a", ["AAPL", "NVDA"]);
  assert.equal(typeof result.chart.overlay.range, "number");
  assert.ok(Number.isInteger(result.chart.overlay.range) && result.chart.overlay.range > 0);
});

test("overlay dedupes, drops invalid tickers, and truncates over 6 to 6", () => {
  const h = harness();
  const result = h.toolset.overlay("room_a", [
    "aapl", "AAPL", "not-a-ticker!", "nvda", "amd", "msft", "goog", "meta", "tsla",
  ]);
  assert.deepEqual(result.chart.overlay.symbols, ["AAPL", "NVDA", "AMD", "MSFT", "GOOG", "META"]);
});

test("overlay throws when fewer than 2 valid tickers survive validation", () => {
  const h = harness();
  assert.throws(() => h.toolset.overlay("room_a", ["AAPL", "not valid!"]));
  assert.throws(() => h.toolset.overlay("room_a", []));
});

test("overlay falls back to pct for an unrecognised normalize value", () => {
  const h = harness();
  const result = h.toolset.overlay("room_a", ["AAPL", "NVDA"], undefined, "zscore");
  assert.equal(result.chart.overlay.normalize, "pct");
});

test("overlay accepts an explicit range and index100 normalize", () => {
  const h = harness();
  const result = h.toolset.overlay("room_a", ["AAPL", "NVDA"], 5, "index100");
  assert.equal(result.chart.overlay.range, 5);
  assert.equal(result.chart.overlay.normalize, "index100");
});

// ── edit_overlay: window changes, never symbols ───────────────────────────

test("edit_overlay adjusts range and normalize on an existing overlay tab", () => {
  const h = harness();
  h.store.charts.set("room_a", [overlayRow("chart_1", ["AAPL", "NVDA"], { range: 252, sortOrder: 0 })]);

  const result = h.toolset.editOverlay("room_a", "chart_1", { range: 63, normalize: "index100" });

  assert.equal(result.chart.overlay.range, 63);
  assert.equal(result.chart.overlay.normalize, "index100");
  assert.deepEqual(result.chart.overlay.symbols, ["AAPL", "NVDA"], "symbols untouched");
});

test("edit_overlay has no way to change symbols — the patch type has no such field", () => {
  const h = harness();
  h.store.charts.set("room_a", [overlayRow("chart_1", ["AAPL", "NVDA"], { sortOrder: 0 })]);

  // Even a runtime object smuggling a `symbols` key in has no effect: the
  // implementation always reads `existing.overlay.symbols`, never `patch`.
  const sneaky = { range: 63, symbols: ["TSLA", "GME"] } as unknown as { range?: number; normalize?: string };
  const result = h.toolset.editOverlay("room_a", "chart_1", sneaky);

  assert.deepEqual(result.chart.overlay.symbols, ["AAPL", "NVDA"]);
});

test("edit_overlay throws for an unknown chart id", () => {
  const h = harness();
  h.store.charts.set("room_a", [overlayRow("chart_1", ["AAPL", "NVDA"], { sortOrder: 0 })]);
  assert.throws(() => h.toolset.editOverlay("room_a", "chart_nope", { range: 63 }));
});

// ── edit_tabs narrows to kind='symbol' only ────────────────────────────────

test("edit_tabs leaves overlay rows untouched, even when an op targets one of its tickers", () => {
  const h = harness();
  h.store.charts.set("room_a", [
    symbolRow("AAPL", { sortOrder: 0 }),
    overlayRow("chart_1", ["AAPL", "NVDA"], { sortOrder: 1 }),
  ]);

  const result = h.toolset.editTabs("room_a", [{ op: "remove", symbol: "AAPL" }]);

  // The symbol tab is gone, but the overlay row (which also references
  // "AAPL") survives untouched — edit_tabs never reaches into it.
  assert.deepEqual(symbolsOf(result.charts), []);
  const overlays = result.charts.filter((row): row is Extract<TopicChartPreferenceRow, { kind: "overlay" }> => row.kind === "overlay");
  assert.deepEqual(overlays.map((row) => row.overlay.symbols), [["AAPL", "NVDA"]]);
});

test("create_topic creates the topic and joins it to this research", () => {
  const h = harness();
  const created = h.toolset.createTopic("  台积电产能  ");

  assert.equal(created.name, "台积电产能");
  assert.deepEqual(h.store.listTopics().map((t) => t.name), ["台积电产能"]);
  assert.deepEqual(h.store.listResearchMembers().map((m) => m.topicId), [created.topicId]);
});

// ── turn projection ───────────────────────────────────────────────────────

// ── setTopicSection: the skill's `## for: topic` text ──────────────────────

test("setTopicSection appends its text to the message dispatch_task sends", async () => {
  const h = harness();
  h.store.createTopic("default", "room_a", "AAPL");
  h.toolset.setTopicSection("请给出具体读数和日期。");

  await h.toolset.dispatchTask("room_a", "渠道库存怎么样？");

  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0]!.userMessage, "渠道库存怎么样？\n\n请给出具体读数和日期。");
});

test("without a topic section the message is unchanged", async () => {
  const h = harness();
  h.store.createTopic("default", "room_a", "AAPL");

  await h.toolset.dispatchTask("room_a", "渠道库存怎么样？");

  assert.equal(h.runs[0]!.userMessage, "渠道库存怎么样？");
});

test("an empty message is still rejected before the section is appended", async () => {
  const h = harness();
  h.store.createTopic("default", "room_a", "AAPL");
  h.toolset.setTopicSection("请给出具体读数和日期。");

  const result = await h.toolset.dispatchTask("room_a", "   ");

  assert.equal(result.status, "failed");
  assert.equal(h.runs.length, 0);
});

test("buildIndexedTurns pairs each turn with its final reply and keeps the turn number", async () => {
  const h = harness();
  const state = await h.sessions.getOrCreate("room_a");
  state.beginTurn("问题一");
  state.recordReply("正在查…", false);
  state.recordReply("答案一", true);
  state.beginTurn("问题二");
  state.recordReply("答案二", true);

  const turns = buildIndexedTurns(state.allEvents());
  assert.deepEqual(turns, [
    { turn: 1, user: "问题一", reply: "答案一" },
    { turn: 2, user: "问题二", reply: "答案二" },
  ]);
});

// ── dispatch_task: a member may ask the user back ──────────────────────────

test("a member that leaves a pending question comes back as needs_input", async () => {
  const h = harness({
    // The driven Topic calls ask_user: its run() returns immediately and the
    // request is recorded on that Topic's own session.
    run: async (input) => {
      const state = await h.sessions.getOrCreate(input.sessionId);
      state.recordUserInputRequest({
        request_id: "req_1",
        questions: [{
          id: "q1",
          question: "Which fiscal year?",
          options: [{ id: "fy25", label: "FY25" }, { id: "fy26", label: "FY26" }],
          min_selections: 1,
          max_selections: 1,
        }],
      });
      return { response: "Please answer the questions below." };
    },
  });

  const result = await h.toolset.dispatchTask("room_a", "渠道库存怎么样？");

  assert.equal(result.status, "needs_input");
  assert.equal(result.request?.request_id, "req_1");
  assert.equal(result.request?.status, "pending");
});

test("needs_input emits a member_input_request frame carrying the member's identity", async () => {
  const h = harness({
    run: async (input) => {
      const state = await h.sessions.getOrCreate(input.sessionId);
      // Asked from one layer further in: the member Topic's own DCF subagent.
      state.recordUserInputRequest({
        request_id: "req_1",
        questions: [{
          id: "q1",
          question: "Which fiscal year?",
          options: [{ id: "fy25", label: "FY25" }, { id: "fy26", label: "FY26" }],
          min_selections: 1,
          max_selections: 1,
        }],
      }, "financial_modeling");
      return { response: "Please answer the questions below." };
    },
  });

  await h.toolset.dispatchTask("room_a", "渠道库存怎么样？");

  const frame = h.frames.find((f) => f.name === "member_input_request");
  assert.ok(frame, "a member_input_request frame should be emitted");
  assert.equal(frame.data.topicId, "room_a");
  assert.equal(frame.data.request.request_id, "req_1");
  // Both layers survive the hop: which member, and who inside it asked. The
  // controller's window renders them together ("<topic> · DCF modeling agent").
  assert.equal(frame.data.request.asked_by, "financial_modeling");
});

test("a member that answers normally is unaffected", async () => {
  const h = harness();   // default run() just returns a reply

  const result = await h.toolset.dispatchTask("room_a", "渠道库存怎么样？");

  assert.equal(result.status, "ok");
  assert.equal(result.request, undefined);
  assert.equal(h.frames.filter((f) => f.name === "member_input_request").length, 0);
});

test("the driven Topic is no longer forbidden from asking the user", async () => {
  const h = harness();
  await h.toolset.dispatchTask("room_a", "渠道库存怎么样？");
  assert.equal(h.runs[0]!.allowUserInput, undefined);
});
