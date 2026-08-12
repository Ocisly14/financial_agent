// The six tools of the Research controller (spec §4.1).
//
// The one idea this file exists to protect: **the controller is the user's
// stand-in, not a wrapper around the existing agent.** `ask_topic` goes down
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
// The other invariant: in `fetch_from_topic`, the SMALL model only ever
// CHOOSES. Every number the controller sees is lifted verbatim from the
// original turn text. See §4.3.2.

import { newId } from "../../framework/ids.ts";
import type { SessionRegistry } from "../../framework/sessionState.ts";
import type { CompactionCache } from "../../framework/eventStore.ts";
import type { ModelRouter } from "../../infra/llm/provider.ts";
import type {
  ResearchMember,
  TopicChartPreferenceRow,
  TopicSummary,
} from "../../infra/db/sqliteEventStore.ts";
import type { UserInputRequestView } from "../../framework/types.ts";
import {
  chunkTurns,
  containsDigits,
  mergeSelections,
  renderChunkForModel,
  type IndexedTurn,
  type Selection,
} from "./retrieval.ts";
import { buildIndexedTurns } from "../topicDigest.ts";
import { MAX_RANGE_DAYS, MIN_RANGE_DAYS, parseRangeDays } from "../../data/stock/index.ts";
import { mapWithConcurrency, Semaphore, TimeoutError, withTimeout } from "./concurrency.ts";
import { projectEvent } from "../../infra/events/sseProjector.ts";
import type { ActiveWorkspaceModel } from "../../framework/orchestrator.ts";

// ── guards (§4.4) ─────────────────────────────────────────────────────────
/** At most this many Topics driven at once, per controller turn. */
export const ASK_TOPIC_CONCURRENCY = 3;
/** One `ask_topic` waits at most this long; a timeout fails that member's
 *  attempt without aborting the whole controller turn. */
export const ASK_TOPIC_TIMEOUT_MS = 6 * 60_000;

// ── retrieval budgets (§4.3.1) ────────────────────────────────────────────
const FETCH_CHUNK_TOKENS = 6_000;
const FETCH_EXCERPT_BUDGET_TOKENS = 4_000;
const FETCH_CHUNK_CONCURRENCY = 4;

// ── collaborators ─────────────────────────────────────────────────────────

/** The store surface these tools use. Narrower than SqliteEventStore so tests
 *  can hand in a stub; every method here already exists (Task 1). */
export type ResearchToolStore = {
  createTopic(agentId: string, topicId: string, name: string, createdAt?: number): TopicSummary;
  listTopics(agentId: string): TopicSummary[];
  listTopicCharts(topicId: string): TopicChartPreferenceRow[];
  replaceTopicCharts(topicId: string, rows: TopicChartPreferenceRow[]): void;
  listResearchMembers(researchId: string): ResearchMember[];
  replaceResearchMembers(researchId: string, topicIds: string[]): void;
  setMemberSeenTurn(researchId: string, topicId: string, seenThroughTurn: number): void;
  loadCompaction(sessionId: string): Promise<CompactionCache | undefined>;
};

/** The existing OrchestratorRuntime, seen through the only method this layer
 *  is allowed to use — the same one `handleChat` calls. */
export type TopicOrchestrator = {
  run(input: {
    agentId: string;
    sessionId: string;
    userMessage: string;
    allowUserInput?: boolean;
    /** Advisory model context for a member Topic's DCF agent. */
    activeModel?: ActiveWorkspaceModel;
  }): Promise<{ response: string }>;
};

export type SessionAccess = Pick<SessionRegistry, "getOrCreate" | "loadEvents">;

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
      data: { topicId: string; topicName: string; task: string; status: AskStatus };
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
  agentId: string;
  researchId: string;
  researchName: string;
  store: ResearchToolStore;
  sessions: SessionAccess;
  orchestrator: TopicOrchestrator;
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

export type AskStatus = "running" | "ok" | "failed" | "timeout" | "skipped" | "needs_input";

export type AskTopicResult = {
  topicId: string;
  topicName: string;
  status: Exclude<AskStatus, "running">;
  /** The Topic's final reply text, on success. */
  reply?: string;
  /** Why it did not succeed. */
  reason?: string;
  /** Only present when status is needs_input: the member's own unanswered
   *  question left behind this turn. */
  request?: UserInputRequestView;
};

export type FetchExcerpt = { turn: number; user: string; reply: string };

export type FetchFromTopicResult = {
  /** One sentence on why these were chosen. Empty when the model tried to put
   *  a number in it — see §4.3.2. */
  framing: string;
  excerpts: FetchExcerpt[];
  data: Array<{ index: number; turn: number; agent: string; data: unknown }>;
  charts: TopicChartPreferenceRow[];
  coverage: string;
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

// ── selection parsing ─────────────────────────────────────────────────────

type ChunkSelection = { framing: string; turns: Selection[]; data: number[]; charts: string[] };

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parses one SMALL-model reply into a selection. Anything unparseable
 *  degrades to "this chunk selected nothing" — never to invented content. */
export function parseChunkSelection(text: string): ChunkSelection {
  const empty: ChunkSelection = { framing: "", turns: [], data: [], charts: [] };
  const json = extractJsonObject(text);
  if (!json) return empty;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return empty;
  }

  const turns: Selection[] = Array.isArray(raw.turns)
    ? raw.turns
        .map((entry) => entry as { turn?: unknown; score?: unknown })
        .filter((entry) => typeof entry?.turn === "number" && Number.isFinite(entry.turn))
        .map((entry) => ({
          turn: entry.turn as number,
          score: typeof entry.score === "number" && Number.isFinite(entry.score) ? entry.score : 0,
        }))
    : [];

  const data = Array.isArray(raw.data)
    ? raw.data.filter((value): value is number => typeof value === "number" && Number.isInteger(value))
    : [];
  const charts = Array.isArray(raw.charts)
    ? raw.charts.filter((value): value is string => typeof value === "string")
    : [];

  return { framing: typeof raw.framing === "string" ? raw.framing.trim() : "", turns, data, charts };
}

const FETCH_SYSTEM = [
  "You are a retrieval assistant. You are given a numbered slice of conversation and a retrieval need.",
  "Your ONLY job is to SELECT: pick out the turn numbers, preservedData indices, and chart symbols relevant to the need.",
  "You must NEVER restate, summarize, or paraphrase any content from the slice, and above all NEVER write out any number —",
  "everything will be resolved by the tool from the original text using the indices you give.",
  "Output JSON only:",
  '{"framing":"one sentence on why these were chosen (must not contain any number)","turns":[{"turn":3,"score":0.9}],"data":[0],"charts":["AAPL"]}',
  "Return empty arrays if nothing is relevant.",
].join("\n");

// ── the toolset ───────────────────────────────────────────────────────────

/**
 * One instance per Research session. `beginTurn()` resets the per-turn guards;
 * the caller (the Research runtime, a later task) calls it once at the top of
 * each controller turn.
 */
export class ResearchToolset {
  private readonly ctx: ResearchToolContext;
  private readonly askSemaphore = new Semaphore(ASK_TOPIC_CONCURRENCY);
  /** Recursion depth 1: a Topic already driven THIS turn cannot be re-entered. */
  private drivenThisTurn = new Set<string>();
  /** The active skill's `## for: topic` section. Becomes visible text on the
   *  member Topic's own timeline, so it is written in the user's voice and
   *  carries no internal marker here. */
  private topicSection = "";

  constructor(ctx: ResearchToolContext) {
    this.ctx = ctx;
  }

  /** Resets per-turn state. Call once at the start of every controller turn.
   *  Deliberately does NOT reset `topicSection` — the skill is invoked
   *  within the turn, and resetting here would erase it within that same
   *  turn. */
  beginTurn(): void {
    this.drivenThisTurn = new Set<string>();
  }

  /** Called by the Research runtime after a skill is invoked. */
  setTopicSection(section: string): void {
    this.topicSection = section.trim();
  }

  private newId(prefix: string): string {
    return (this.ctx.idFactory ?? newId)(prefix);
  }

  private topicName(topicId: string): string {
    return this.ctx.store.listTopics(this.ctx.agentId).find((t) => t.id === topicId)?.name ?? topicId;
  }

  // ── ask_topic ───────────────────────────────────────────────────────────
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
  async askTopic(topicId: string, message: string): Promise<AskTopicResult> {
    const topicName = this.topicName(topicId);
    const trimmed = message.trim();
    if (!trimmed) {
      return { topicId, topicName, status: "failed", reason: "message is empty" };
    }
    // Appended after the empty-message check: a message that's only guidance,
    // with no instruction, should not count as a valid drive.
    const task = this.topicSection ? `${trimmed}\n\n${this.topicSection}` : trimmed;
    if (this.drivenThisTurn.has(topicId)) {
      // Recursion depth 1 (§4.4): one drive per Topic per controller turn.
      const result: AskTopicResult = {
        topicId,
        topicName,
        status: "skipped",
        reason: "this topic was already driven in this turn",
      };
      this.ctx.emit({ name: "topic_dispatch", data: { topicId, topicName, task, status: "skipped" } });
      return result;
    }
    this.drivenThisTurn.add(topicId);

    const release = await this.askSemaphore.acquire();
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
        const result = await withTimeout(
          this.ctx.orchestrator.run({
            agentId: this.ctx.agentId,
            sessionId: topicId,
            userMessage: task,
            ...(this.ctx.activeModel?.topicId === topicId ? { activeModel: this.ctx.activeModel } : {}),
          }),
          this.ctx.askTimeoutMs ?? ASK_TOPIC_TIMEOUT_MS,
          `ask_topic(${topicId})`,
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
    this.ctx.store.createTopic(this.ctx.agentId, topicId, trimmed);
    const members = this.ctx.store.listResearchMembers(this.ctx.researchId).map((m) => m.topicId);
    const next = [...members, topicId];
    this.ctx.store.replaceResearchMembers(this.ctx.researchId, next);
    this.ctx.emit({
      name: "layout_changed",
      data: { scope: "members", researchId: this.ctx.researchId, source: "agent", previous: members, next },
    });
    return { topicId, name: trimmed, members: next };
  }

  // ── fetch_from_topic ────────────────────────────────────────────────────
  /**
   * Reads a Topic WITH A QUESTION IN HAND (§4.3).
   *
   * Map-reduce: chunk the turns, ask a SMALL model per chunk which turns are
   * relevant, then merge the selections mechanically — no second model pass,
   * because ranking has nothing to understand and another pass is another
   * chance to distort.
   *
   * The model's answers are ids. Every excerpt returned here is read back out
   * of the original turn, byte for byte. Its `framing` is checked with
   * `containsDigits`: a framing with a number in it is dropped, the excerpts
   * are kept. Losing one explanatory sentence is cheap; a paraphrased P/E is
   * not.
   */
  async fetchFromTopic(topicId: string, need: string): Promise<FetchFromTopicResult> {
    const turns = buildIndexedTurns(await this.ctx.sessions.loadEvents(topicId));
    const compaction = await this.ctx.store.loadCompaction(topicId);
    const preserved = compaction?.preservedData ?? [];
    const charts = this.ctx.store.listTopicCharts(topicId);

    if (turns.length === 0 && preserved.length === 0) {
      return { framing: "", excerpts: [], data: [], charts: [], coverage: "This Topic has no conversation history yet" };
    }

    const sidecar = this.renderSidecar(preserved, charts);
    const chunks = chunkTurns(turns, FETCH_CHUNK_TOKENS);

    const selections = await mapWithConcurrency(chunks, FETCH_CHUNK_CONCURRENCY, async (chunk) => {
      try {
        const completion = await this.ctx.modelRouter.generate(
          [
            { role: "system", content: FETCH_SYSTEM },
            {
              role: "user",
              content: [
                `Retrieval need: ${need}`,
                "",
                "Conversation slice:",
                renderChunkForModel(chunk),
                sidecar,
              ].join("\n"),
            },
          ],
          { modelClass: "SMALL", temperature: 0, metadata: { mode: "research_fetch" } },
        );
        return parseChunkSelection(completion.text);
      } catch {
        return { framing: "", turns: [], data: [], charts: [] } as ChunkSelection;
      }
    });

    const merged = mergeSelections(
      selections.map((s) => s.turns),
      FETCH_EXCERPT_BUDGET_TOKENS,
      turns,
    );

    // Excerpts are resolved from `turns` — the ORIGINAL text — never from
    // anything the model wrote.
    const excerpts: FetchExcerpt[] = merged.turns.map((t) => ({ turn: t.turn, user: t.user, reply: t.reply }));

    const dataIndices = [...new Set(selections.flatMap((s) => s.data))]
      .filter((index) => index >= 0 && index < preserved.length)
      .sort((a, b) => a - b);
    const data = dataIndices.map((index) => ({
      index,
      turn: preserved[index]!.turn,
      agent: preserved[index]!.agent,
      data: preserved[index]!.data,
    }));

    const wantedSymbols = new Set(selections.flatMap((s) => s.charts).map((s) => s.toUpperCase()));
    // Overlay rows have no single ticker to match against the model's symbol picks — that
    // resolution is edit_overlay/overlay-tool territory (a later task), not this fetch path.
    const selectedCharts = charts.filter(
      (chart) => chart.kind === "symbol" && wantedSymbols.has(chart.symbol.toUpperCase()),
    );

    return {
      framing: this.pickFraming(selections, merged.turns),
      excerpts,
      data,
      charts: selectedCharts,
      coverage:
        merged.coverage === "full"
          ? `Covered all ${turns.length} turns`
          : `${turns.length} turns total; budget limited the return to the ${excerpts.length} most relevant`,
    };
  }

  /** The numbered preservedData / chart block appended to every chunk prompt:
   *  without indices the model has nothing to cite (§4.3.2). */
  private renderSidecar(
    preserved: CompactionCache["preservedData"],
    charts: TopicChartPreferenceRow[],
  ): string {
    const parts: string[] = [];
    if (preserved.length > 0) {
      parts.push(
        "",
        "Preserved structured data (reference by index):",
        ...preserved.map((entry, index) => `[data ${index}] turn ${entry.turn} · ${entry.agent} · ${JSON.stringify(entry.data)}`),
      );
    }
    const symbolCharts = charts.filter((c): c is Extract<TopicChartPreferenceRow, { kind: "symbol" }> => c.kind === "symbol");
    if (symbolCharts.length > 0) {
      parts.push("", `This Topic's charts (reference by symbol): ${symbolCharts.map((c) => c.symbol).join(", ")}`);
    }
    return parts.join("\n");
  }

  /** Framing of the chunk that produced the top-ranked turn; dropped entirely
   *  if it contains a digit (§4.3.2). */
  private pickFraming(selections: ChunkSelection[], rankedTurns: IndexedTurn[]): string {
    const top = rankedTurns[0]?.turn;
    const owner =
      top === undefined
        ? undefined
        : selections.find((s) => s.turns.some((sel) => sel.turn === top) && s.framing);
    const framing = (owner ?? selections.find((s) => s.framing))?.framing ?? "";
    return containsDigits(framing) ? "" : framing;
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
    const known = new Set(this.ctx.store.listTopics(this.ctx.agentId).map((t) => t.id));
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
