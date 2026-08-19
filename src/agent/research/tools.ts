// The six tools of the Research controller (spec §4.1).
//
// The one idea this file exists to protect: **the controller delegates new
// work to a Topic, rather than bypassing it.** `dispatch_task` goes down
// exactly the path a human typing into the chat box goes down —
// `orchestrator.run({ sessionId: topicId, userMessage })`, the same call
// `handleChat` makes. Consequences:
//
//   - Nothing in src/framework/ or src/agent/prompts|subagents/ changes. The
//     Topic orchestrator does not know, and must not need to know, whether a
//     human or an agent is on the other end.
//   - Because the Topic's own orchestrator writes to its own session, facts
//     land on that Topic's timeline automatically. There is no fact-routing
//     code here and no classifier deciding "is this a fact or a reading".
//   - Recursion / concurrency / timeout guards (§4.4) live in THIS layer only.
//
// Historical questions use a read-only, ephemeral consultation of the Topic
// itself; no SMALL-model chunk selector is involved.

import { newId } from "../../framework/ids.ts";
import type { SessionRegistry } from "../../framework/sessionState.ts";
import type { ModelRouter } from "../../infra/llm/provider.ts";
import type {
  ResearchMember,
  TopicChartPreferenceRow,
  TopicSummary,
} from "../../infra/db/sqliteEventStore.ts";
import type { JsonObject, UserInputRequestView } from "../../framework/types.ts";
import { MAX_RANGE_DAYS, MIN_RANGE_DAYS, parseRangeDays } from "../../data/stock/index.ts";
import { mapWithConcurrency, Semaphore, TimeoutError, withTimeout } from "./concurrency.ts";
import { projectEvent } from "../../infra/events/sseProjector.ts";
import type { ActiveWorkspaceModel } from "../../framework/orchestrator.ts";

// ── guards (§4.4) ─────────────────────────────────────────────────────────
/** At most this many Topic task dispatches run at once, per Research turn. */
export const DISPATCH_TASK_CONCURRENCY = 3;
/** One `dispatch_task` waits at most this long; a timeout fails that member's
 *  attempt without aborting the whole controller turn. */
export const DISPATCH_TASK_TIMEOUT_MS = 6 * 60_000;

// ── collaborators ─────────────────────────────────────────────────────────

/** The store surface these tools use. Narrower than SqliteEventStore so tests
 *  can hand in a stub; every method here already exists (Task 1). */
export type ResearchToolStore = {
  createTopic(tenantId: string, topicId: string, name: string, createdAt?: number): TopicSummary;
  listTopics(tenantId: string): TopicSummary[];
  listTopicCharts(topicId: string): TopicChartPreferenceRow[];
  replaceTopicCharts(topicId: string, rows: TopicChartPreferenceRow[]): void;
  listResearchMembers(researchId: string): ResearchMember[];
  replaceResearchMembers(researchId: string, topicIds: string[]): void;
  setMemberSeenTurn(researchId: string, topicId: string, seenThroughTurn: number): void;
};

/** The existing OrchestratorRuntime, seen through the only method this layer
 *  is allowed to use — the same one `handleChat` calls. */
export type TopicOrchestrator = {
  run(input: {
    tenantId: string;
    sessionId: string;
    userMessage: string;
    allowUserInput?: boolean;
    /** Advisory model context for a member Topic's DCF agent. */
    activeModel?: ActiveWorkspaceModel;
  }): Promise<{ response: string }>;
  consult(input: {
    tenantId: string;
    sessionId: string;
    question: string;
    activeModel?: ActiveWorkspaceModel;
  }): Promise<{ response: string }>;
};

export type SessionAccess = Pick<SessionRegistry, "getOrCreate" | "loadEvents">;
/** Only the scheduling boundary is needed here; the toolset never reads or
 * writes digest state itself. */
export type TopicDigestSchedulerAccess = Pick<import("../../server/topicDigestScheduler.ts").TopicDigestScheduler, "schedule">;

/**
 * Frames the Research stream carries. Deliberately its OWN type rather than
 * the framework's `SSEEvent` union: adding a case there would mean editing a
 * frozen file, and these frames are a Research-layer concern anyway. Per §4.5
 * the driven Topic's own dispatch/tool_call frames are NOT forwarded — only
 * the one compressed `topic_dispatch` line.
 */
export type ResearchFrame =
  | {
      name: "topic_dispatch";
      data: { topicId: string; topicName: string; task: string; status: DispatchTaskStatus };
    }
  | { name: "topic_focus"; data: { topicId: string; symbol?: string } }
  | {
      /** Forwarded from the driven Topic so a Research workspace refreshes the
       * member model it is currently showing. */
      name: "model_revision";
      data: {
        display: "focus" | "silent";
        model_id: string;
        revision: number;
        lifecycle_stage: string;
        changed_sections: string[];
        changed_line_item_ids: string[];
        changed_period_ids: string[];
        change_kinds: string[];
      };
    }
  | {
      name: "member_input_request";
      data: { topicId: string; topicName: string; request: UserInputRequestView };
    }
  | {
      name: "layout_changed";
      data: {
        scope: "tabs" | "members";
        researchId: string;
        topicId?: string;
        /** §6: the change came from the agent, so the UI offers a single-level undo. */
        source: "agent";
        /** State to restore if the user takes that undo. */
        previous: TopicChartPreferenceRow[] | string[];
        next: TopicChartPreferenceRow[] | string[];
      };
    };

export type ResearchToolContext = {
  tenantId: string;
  researchId: string;
  researchName: string;
  store: ResearchToolStore;
  sessions: SessionAccess;
  orchestrator: TopicOrchestrator;
  topicDigests?: TopicDigestSchedulerAccess;
  modelRouter: ModelRouter;
  emit: (frame: ResearchFrame) => void;
  /** The model visible in the parent Research workspace, if its owner Topic
   * is the member being driven. It informs the member agent but never locks it
   * to that model. */
  activeModel?: ActiveWorkspaceModel & { topicId: string };
  /** Injectable for tests. */
  askTimeoutMs?: number;
  idFactory?: (prefix: string) => string;
};

// ── tool results ──────────────────────────────────────────────────────────

export type DispatchTaskStatus = "running" | "ok" | "failed" | "timeout" | "skipped" | "needs_input";

export type DispatchTaskResult = {
  topicId: string;
  topicName: string;
  status: Exclude<DispatchTaskStatus, "running">;
  /** The Topic's final reply text, on success. */
  reply?: string;
  /** Why it did not succeed. */
  reason?: string;
  /** Only present when status is needs_input: the member's own unanswered
   *  question left behind this turn. */
  request?: UserInputRequestView;
};

export type ConsultTopicResult = {
  topicId: string;
  topicName: string;
  status: "ok" | "failed" | "timeout";
  reply?: string;
  reason?: string;
};

export type TabOp =
  | { op: "add"; symbol: string; range?: number | null }
  | { op: "remove"; symbol: string };

export type MemberOp = { op: "add" | "remove"; topicId: string };

export type OverlayRow = Extract<TopicChartPreferenceRow, { kind: "overlay" }>;

/** What `edit_overlay` may change. Deliberately has no `symbols` field —
 *  design §4.1: changing the window is looking at the same comparison
 *  differently, changing the symbols is a different comparison. */
export type EditOverlayPatch = { range?: number; normalize?: string };

// ── overlay validation (design §2) ──────────────────────────────────────
// Byte-identical to client/src/lib/chartWorkspace.ts's `ticker()` / the
// server's `TICKER_PATTERN` in src/server/server.ts — each layer implements
// its own copy on purpose (see that file's comment on the same regex).
const TICKER_PATTERN = /^[A-Z][A-Z.-]{0,5}$/;
/** 252 trading days — one year. */
const DEFAULT_OVERLAY_RANGE = 252;

/**
 * A range reaching an agent tool is a WRITE, so it is rejected rather than
 * coerced: a silently substituted window is exactly how a "6M" request once
 * became a one-day intraday chart. Throwing hands the model a message it can
 * act on, which a fallback never does.
 */
export function requireRangeDays(value: unknown): number {
  const days = parseRangeDays(value);
  if (days === undefined) {
    throw new Error(
      `"range" must be a whole number of trading days between ${MIN_RANGE_DAYS} and ${MAX_RANGE_DAYS} ` +
      `(21 = 1 month, 63 = 3 months, 126 = 6 months, 252 = 1 year)`,
    );
  }
  return days;
}

function normalizeTicker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const symbol = value.trim().toUpperCase();
  return TICKER_PATTERN.test(symbol) ? symbol : undefined;
}

/** Dedupes, validates every ticker, and truncates to the 6-line legibility
 *  ceiling (design §2) — keeping the first 6 rather than rejecting the whole
 *  call. A single bad ticker drops that symbol, not the whole call. */
function cleanOverlaySymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const candidate of value) {
    const symbol = normalizeTicker(candidate);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols.slice(0, 6);
}

/** An unrecognised normalize mode falls back to "pct" rather than throwing —
 *  storage and messages both outlive the build that wrote them. */
function normalizeMode(value: unknown): "pct" | "index100" {
  return value === "index100" ? "index100" : "pct";
}

// ── the toolset ───────────────────────────────────────────────────────────

/**
 * One instance per Research session. `beginTurn()` resets the per-turn guards;
 * the caller (the Research runtime, a later task) calls it once at the top of
 * each controller turn.
 */
export class ResearchToolset {
  private readonly ctx: ResearchToolContext;
  private readonly dispatchSemaphore = new Semaphore(DISPATCH_TASK_CONCURRENCY);
  /** Recursion depth 1: a Topic already driven THIS turn cannot be re-entered. */
  private drivenThisTurn = new Set<string>();

  constructor(ctx: ResearchToolContext) {
    this.ctx = ctx;
  }

  /** Resets per-turn state. Call once at the start of every controller turn. */
  beginTurn(): void {
    this.drivenThisTurn = new Set<string>();
  }

  private newId(prefix: string): string {
    return (this.ctx.idFactory ?? newId)(prefix);
  }

  private topicName(topicId: string): string {
    return this.ctx.store.listTopics(this.ctx.tenantId).find((t) => t.id === topicId)?.name ?? topicId;
  }

  // ── dispatch_task ───────────────────────────────────────────────────────
  /**
   * Delivers `message` to a Topic AS THE USER and waits for its final reply.
   *
   * This is the whole architecture in one method: it calls the untouched
   * `orchestrator.run` with that Topic's session id. The Topic answers, writes
   * its own events to its own timeline, and never learns who asked.
   *
   * The `user_message` event it writes carries `origin` (§5) so the timeline
   * stays honest about which turns the user typed and which were asked on
   * their behalf. See `stampOrigin` for why that needs no framework change.
   */
  async dispatchTask(topicId: string, message: string): Promise<DispatchTaskResult> {
    const topicName = this.topicName(topicId);
    const trimmed = message.trim();
    if (!trimmed) {
      return { topicId, topicName, status: "failed", reason: "message is empty" };
    }
    // Exactly what the controller wrote. A skill's guidance used to be appended here behind its
    // back; a skill acts on its READER now — the controller carries what a drive needs into the
    // message itself.
    const task = trimmed;
    if (this.drivenThisTurn.has(topicId)) {
      // Recursion depth 1 (§4.4): one drive per Topic per controller turn.
      const result: DispatchTaskResult = {
        topicId,
        topicName,
        status: "skipped",
        reason: "this topic was already driven in this turn",
      };
      this.ctx.emit({ name: "topic_dispatch", data: { topicId, topicName, task, status: "skipped" } });
      return result;
    }
    this.drivenThisTurn.add(topicId);

    const release = await this.dispatchSemaphore.acquire();
    this.ctx.emit({ name: "topic_dispatch", data: { topicId, topicName, task, status: "running" } });

    try {
      // The member's own state, so we can see whether this turn left a question
      // behind. `getOrCreate` is registry-cached — this is not a second load.
      const memberState = await this.ctx.sessions.getOrCreate(topicId);

      // Research subscribes to its own session, while a member Topic writes
      // model revisions to its separate session. Relay only revision frames so
      // the currently visible member workbook refetches without duplicating
      // the member's chat or progress stream in the Research conversation.
      const unforwardModelRevisions = memberState.subscribe((event) => {
        for (const frame of projectEvent(event, memberState)) {
          if (frame.type !== "model_revision") continue;
          this.ctx.emit({
            name: "model_revision",
            data: {
              display: frame.display,
              model_id: frame.model_id,
              revision: frame.revision,
              lifecycle_stage: frame.lifecycle_stage,
              changed_sections: frame.changed_sections,
              changed_line_item_ids: frame.changed_line_item_ids,
              changed_period_ids: frame.changed_period_ids,
              change_kinds: frame.change_kinds,
            },
          });
        }
      });

      const unstamp = await this.stampOrigin(topicId, task);
      let response: string;
      try {
        const topicRun = this.ctx.orchestrator.run({
          tenantId: this.ctx.tenantId,
          sessionId: topicId,
          userMessage: task,
          ...(this.ctx.activeModel?.topicId === topicId ? { activeModel: this.ctx.activeModel } : {}),
        });
        // Do this on the underlying run rather than after `withTimeout`: a
        // timed-out controller tool does not cancel the Topic's work. Once that
        // work eventually settles it still deserves the same digest check as a
        // human-originated request.
        void topicRun.then(
          () => this.ctx.topicDigests?.schedule(topicId),
          () => this.ctx.topicDigests?.schedule(topicId),
        );
        const result = await withTimeout(
          topicRun,
          this.ctx.askTimeoutMs ?? DISPATCH_TASK_TIMEOUT_MS,
          `dispatch_task(${topicId})`,
        );
        response = result.response;
      } finally {
        unstamp();
        unforwardModelRevisions();
      }

      // Changes this controller caused are not "external" (§4.2.3), so move the
      // seen marker past them before the next turn's delta is computed. This
      // runs for a needs_input turn too: the member really did produce events.
      await this.markSeen(topicId);

      // The member asked the user something. The request stays on ITS session —
      // the answer will arrive there, through the ordinary resume path. All we
      // do is tell the controller, and hand the UI enough to render the card.
      //
      // Checked against `currentTurn` (read AFTER run() returns) rather than a
      // turn number captured before the call: the real orchestrator's run()
      // begins a new turn as its first step, so this lands on that new turn in
      // production; a run() that never begins a turn (as in the "member asks
      // immediately" test double) still lands correctly because the turn never
      // moved. A `turnBefore + 1` guess is wrong whenever run() does not begin
      // exactly one new turn.
      const pending = memberState.userInputRequestForTurn(memberState.currentTurn);
      if (pending && pending.status === "pending") {
        this.ctx.emit({ name: "member_input_request", data: { topicId, topicName, request: pending } });
        this.ctx.emit({ name: "topic_dispatch", data: { topicId, topicName, task, status: "needs_input" } });
        return { topicId, topicName, status: "needs_input", reply: response, request: pending };
      }

      this.ctx.emit({ name: "topic_dispatch", data: { topicId, topicName, task, status: "ok" } });
      return { topicId, topicName, status: "ok", reply: response };
    } catch (error) {
      const timedOut = error instanceof TimeoutError;
      const status = timedOut ? "timeout" : "failed";
      this.ctx.emit({ name: "topic_dispatch", data: { topicId, topicName, task, status } });
      // A failure here is this member's failure for this turn, not the turn's.
      return {
        topicId,
        topicName,
        status,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      release();
    }
  }

  /** A non-persistent answer from a member Topic's existing context. Unlike
   * dispatch_task, this never adds a user turn, runs tools, or changes the model. */
  async consultTopic(topicId: string, question: string): Promise<ConsultTopicResult> {
    const topicName = this.topicName(topicId);
    const trimmed = question.trim();
    if (!trimmed) return { topicId, topicName, status: "failed", reason: "question is empty" };
    try {
      const result = await withTimeout(
        this.ctx.orchestrator.consult({
          tenantId: this.ctx.tenantId,
          sessionId: topicId,
          question: `Answer from your established Topic context only; do not do new research. Question: ${trimmed}`,
          ...(this.ctx.activeModel?.topicId === topicId ? { activeModel: this.ctx.activeModel } : {}),
        }),
        this.ctx.askTimeoutMs ?? DISPATCH_TASK_TIMEOUT_MS,
        `consult_topic(${topicId})`,
      );
      return { topicId, topicName, status: "ok", reply: result.response };
    } catch (error) {
      return { topicId, topicName, status: error instanceof TimeoutError ? "timeout" : "failed",
        reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Attaches `origin` to the next `user_message` this Topic records, WITHOUT
   * touching the framework.
   *
   * `SessionState.record` notifies its subscribers before handing the event to
   * the EventStore, and it hands over the same object it notified with — so a
   * subscriber that adds a field to `payload` has added it both to the
   * in-memory log and to the row that gets persisted. `subscribe` is a public,
   * already-used extension point (the SSE projector rides it). The
   * orchestrator never reads `payload.origin`, which is exactly what §5 asks
   * for: the field affects recording and rendering, nothing else.
   *
   * Returns an unsubscribe; the stamp fires at most once and only for the
   * message we are sending, so a concurrent human turn on the same Topic can
   * never be mislabelled.
   */
  private async stampOrigin(topicId: string, message: string): Promise<() => void> {
    const state = await this.ctx.sessions.getOrCreate(topicId);
    const origin = { researchId: this.ctx.researchId, researchName: this.ctx.researchName };
    let stamped = false;
    const unsubscribe = state.subscribe((event) => {
      if (stamped) return;
      if (event.kind !== "user_message") return;
      if (String(event.payload.content ?? "") !== message) return;
      event.payload.origin = origin;
      stamped = true;
    });
    return unsubscribe;
  }

  private async markSeen(topicId: string): Promise<void> {
    const isMember = this.ctx.store
      .listResearchMembers(this.ctx.researchId)
      .some((m) => m.topicId === topicId);
    if (!isMember) return;
    const state = await this.ctx.sessions.getOrCreate(topicId);
    this.ctx.store.setMemberSeenTurn(this.ctx.researchId, topicId, state.currentTurn);
  }

  // ── create_topic ────────────────────────────────────────────────────────
  /** Creates a Topic and adds it as a member of this Research. */
  createTopic(name: string): { topicId: string; name: string; members: string[] } {
    const trimmed = name.trim() || "New Topic";
    // Prefix kept as `room` on purpose: it is the existing id convention for a
    // session row (the table is still named chat_rooms). Everything the code
    // *says* is `topic`.
    const topicId = this.newId("room");
    this.ctx.store.createTopic(this.ctx.tenantId, topicId, trimmed);
    const members = this.ctx.store.listResearchMembers(this.ctx.researchId).map((m) => m.topicId);
    const next = [...members, topicId];
    this.ctx.store.replaceResearchMembers(this.ctx.researchId, next);
    this.ctx.emit({
      name: "layout_changed",
      data: { scope: "members", researchId: this.ctx.researchId, source: "agent", previous: members, next },
    });
    return { topicId, name: trimmed, members: next };
  }

  // ── focus ───────────────────────────────────────────────────────────────
  /**
   * Moves the user's attention. TRANSIENT: one SSE frame, zero writes. It is a
   * separate tool from `edit_tabs` precisely so that "what can be undone" is a
   * distinction in the type system rather than a runtime judgement (§4.1).
   */
  focus(topicId: string, symbol?: string): { topicId: string; symbol?: string } {
    const data: { topicId: string; symbol?: string } = { topicId };
    if (symbol) data.symbol = symbol.toUpperCase();
    this.ctx.emit({ name: "topic_focus", data });
    return data;
  }

  // ── edit_tabs ───────────────────────────────────────────────────────────
  /**
   * Adds / removes / pins chart tabs on a Topic. PERSISTENT.
   *
   * §6: `hidden` is no longer a veto over the agent — `remove` is a deletion,
   * not a hide. The change is emitted with `source: 'agent'` and the previous
   * rows so the UI can offer the single-level undo.
   */
  editTabs(topicId: string, ops: TabOp[]): { charts: TopicChartPreferenceRow[]; previous: TopicChartPreferenceRow[] } {
    const previous = this.ctx.store.listTopicCharts(topicId);
    // edit_tabs only ever operates on kind='symbol' rows (spec §6.2): overlay tabs are created by
    // `overlay` and modified by `edit_overlay`, and their symbol set is not editable in place.
    // Overlay rows are carried through untouched.
    const overlays = previous.filter((row): row is Extract<TopicChartPreferenceRow, { kind: "overlay" }> => row.kind === "overlay");
    const rows = previous
      .filter((row): row is Extract<TopicChartPreferenceRow, { kind: "symbol" }> => row.kind === "symbol")
      .map((row) => ({ ...row }));

    for (const op of ops) {
      const symbol = op.symbol.toUpperCase();
      const index = rows.findIndex((row) => row.symbol.toUpperCase() === symbol);
      if (op.op === "add") {
        const next: Extract<TopicChartPreferenceRow, { kind: "symbol" }> = {
          id: index >= 0 ? rows[index]!.id : this.newId("chart"),
          kind: "symbol",
          symbol,
          range: op.range ?? null,
          hidden: false,
          sortOrder: index >= 0 ? rows[index]!.sortOrder : rows.length,
        };
        if (index >= 0) rows[index] = next;
        else rows.push(next);
      } else if (op.op === "remove") {
        if (index >= 0) rows.splice(index, 1);
      }
    }

    const normalized: TopicChartPreferenceRow[] = [...rows.map((row, index) => ({ ...row, sortOrder: index })), ...overlays];
    this.ctx.store.replaceTopicCharts(topicId, normalized);
    this.ctx.emit({
      name: "layout_changed",
      data: {
        scope: "tabs",
        researchId: this.ctx.researchId,
        topicId,
        source: "agent",
        previous,
        next: normalized,
      },
    });
    return { charts: normalized, previous };
  }

  // ── overlay ─────────────────────────────────────────────────────────────
  /**
   * Creates a normalized multi-symbol comparison chart and persists it as a
   * new tab on `topicId` IMMEDIATELY (design §1③, §6): `sortOrder` 0 — the
   * project's "new tabs go to the front" rule — and selected. There is no
   * "keep it?" gate; existing rows shift back by one. The user deletes it if
   * they don't want it, exactly like any other tab.
   *
   * `range` defaults to `topicId`'s own current lead chart's range (its
   * first visible tab by `sortOrder`) — reading "the currently focused
   * member's range" (design §4) as the range already showing on the member
   * this overlay is being added to. `normalize` defaults to "pct" (§3.1).
   *
   * Throws if fewer than 2 valid, distinct tickers survive validation —
   * unlike the passive chartWorkspace parser (which silently downgrades to
   * "no chart"), this is an explicit creation call, so the agent should be
   * told it failed and can retry with corrected input.
   */
  overlay(
    topicId: string,
    symbols: string[],
    range?: number | null,
    normalize?: string,
  ): { chart: OverlayRow; charts: TopicChartPreferenceRow[]; previous: TopicChartPreferenceRow[] } {
    const cleanSymbols = cleanOverlaySymbols(symbols);
    if (cleanSymbols.length < 2) {
      throw new Error("overlay needs at least 2 valid, distinct ticker symbols (e.g. AAPL, NVDA)");
    }

    const previous = this.ctx.store.listTopicCharts(topicId);
    const resolvedRange = range === undefined || range === null
      ? this.defaultOverlayRange(previous)
      : requireRangeDays(range);
    const resolvedNormalize = normalizeMode(normalize);

    const chart: OverlayRow = {
      id: this.newId("chart"),
      kind: "overlay",
      overlay: { symbols: cleanSymbols, range: resolvedRange, normalize: resolvedNormalize },
      range: resolvedRange,
      hidden: false,
      sortOrder: 0,
    };

    // "New tabs go to the front": the overlay takes sortOrder 0, everything
    // else shifts back by one, relative order otherwise unchanged.
    const shifted = previous.map((row) => ({ ...row, sortOrder: row.sortOrder + 1 }));
    const next: TopicChartPreferenceRow[] = [chart, ...shifted];
    this.ctx.store.replaceTopicCharts(topicId, next);
    this.ctx.emit({
      name: "layout_changed",
      data: { scope: "tabs", researchId: this.ctx.researchId, topicId, source: "agent", previous, next },
    });
    return { chart, charts: next, previous };
  }

  private defaultOverlayRange(charts: TopicChartPreferenceRow[]): number {
    const lead = charts
      .filter((row) => !row.hidden)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
    return lead?.range ?? DEFAULT_OVERLAY_RANGE;
  }

  // ── edit_overlay ────────────────────────────────────────────────────────
  /**
   * Adjusts `range` and/or `normalize` on an existing overlay tab. PERSISTED —
   * this row is already a persisted tab, so it falls under the "agent has
   * full authority, the user can undo" rule (spec §6).
   *
   * Deliberately CANNOT touch `symbols`: `EditOverlayPatch` has no `symbols`
   * field, so there is nothing in `patch` that could reach it even if a
   * caller tried — `symbols` is always carried through unchanged from the
   * existing row. Design §4.1: changing the window is looking at the same
   * comparison differently; changing the symbols is a different comparison.
   * Swapping symbols in place means calling `overlay` for a new chart.
   */
  editOverlay(
    topicId: string,
    chartId: string,
    patch: EditOverlayPatch,
  ): { chart: OverlayRow; charts: TopicChartPreferenceRow[]; previous: TopicChartPreferenceRow[] } {
    const previous = this.ctx.store.listTopicCharts(topicId);
    const index = previous.findIndex((row) => row.kind === "overlay" && row.id === chartId);
    if (index === -1) {
      throw new Error(`no overlay chart with id "${chartId}" on this topic`);
    }
    const existing = previous[index] as OverlayRow;

    const nextRange = patch.range === undefined ? existing.overlay.range : requireRangeDays(patch.range);
    const nextNormalize = patch.normalize !== undefined ? normalizeMode(patch.normalize) : existing.overlay.normalize;

    const updated: OverlayRow = {
      ...existing,
      overlay: { symbols: existing.overlay.symbols, range: nextRange, normalize: nextNormalize },
      range: nextRange,
    };

    const next = [...previous];
    next[index] = updated;
    this.ctx.store.replaceTopicCharts(topicId, next);
    this.ctx.emit({
      name: "layout_changed",
      data: { scope: "tabs", researchId: this.ctx.researchId, topicId, source: "agent", previous, next },
    });
    return { chart: updated, charts: next, previous };
  }

  // ── edit_members ────────────────────────────────────────────────────────
  /**
   * Adds / removes member Topics. PERSISTENT. Removing a member never deletes
   * the Topic: a Topic outlives any Research it is in, and may belong to
   * several at once (§3).
   */
  editMembers(ops: MemberOp[]): { members: string[]; previous: string[] } {
    const previous = this.ctx.store.listResearchMembers(this.ctx.researchId).map((m) => m.topicId);
    const known = new Set(this.ctx.store.listTopics(this.ctx.tenantId).map((t) => t.id));
    let next = [...previous];

    for (const op of ops) {
      if (op.op === "add") {
        if (!known.has(op.topicId) || next.includes(op.topicId)) continue;
        next.push(op.topicId);
      } else {
        next = next.filter((id) => id !== op.topicId);
      }
    }

    this.ctx.store.replaceResearchMembers(this.ctx.researchId, next);
    this.ctx.emit({
      name: "layout_changed",
      data: { scope: "members", researchId: this.ctx.researchId, source: "agent", previous, next },
    });
    return { members: next, previous };
  }
}
