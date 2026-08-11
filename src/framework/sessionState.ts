import { newId } from "./ids.ts";
import { isAgentKind } from "./types.ts";
import type {
  AgentKind,
  ArtifactRef,
  GenerationContext,
  JsonObject,
  TaskResult,
  UserInputAskedBy,
  UserInputRequest,
  UserInputRequestView,
  UserInputResponse,
} from "./types.ts";
import type { CompactionCache, EventStore } from "./eventStore.ts";

/**
 * SessionState — a single append-only event log per session that is the ONE
 * source of truth for everything a session does: user messages, the
 * orchestrator's replies/dispatches/skill-invocations, each subagent's
 * task_result, and (as sidechain) each subagent's internal tool_use/tool_result.
 *
 * Operational state that used to live in separate Map stores is now DERIVED from
 * the log, not stored twice:
 *   - task status  ← a `dispatch` with no child `task_result` is in-flight; else done/failed.
 *   - approvals    ← an `approval_required` with no `approval_resolved` and within TTL is pending.
 *   - workflow     ← `workflow_started/step/done` events fold into a progress view.
 *
 * The orchestrator's prompt context is a PROJECTION of the log (projectForPrompt),
 * which replaces the old transcript-store + in-memory loopLog split — so a turn
 * is fully recoverable from the log alone.
 *
 * The event log is durable state. The EventBus (SSE) is a separate real-time
 * transport; the two are not the same concern.
 */

export type Source = "user" | "orchestrator" | "market_data" | "market_research" | "trading_operations" | "financial_modeling" | "skill";

export interface SessionEvent {
  event_id: string;
  parent_event_id: string | null;
  session_id: string;
  timestamp: string; // ISO UTC
  source: Source;
  kind: string;
  /**
   * Which agent loop's conversation this event belongs to.
   *
   * The main conversation — what the user is talking to — has the session_id
   * itself as its thread id. A subagent thread is `<session_id>:<agent>:<n>`,
   * so the id says which conversation it hangs off, whose it is, and which of
   * that agent's threads it is, without a lookup.
   *
   * This replaced an `is_sidechain` boolean, which answered "is this inside
   * some subagent?" without saying which one. Everything that used to read
   * that flag now compares against a thread id instead.
   */
  thread_id: string;
  turn: number; // which user turn this belongs to
  payload: JsonObject;
}

const THREAD_SEPARATOR = ":";

/** Neither a session id (`room_<uuid>`) nor an agent name contains a colon, so
 *  a three-way split is unambiguous. */
export function parseThreadId(threadId: string): { session_id: string; agent: AgentKind; n: number } | undefined {
  const parts = threadId.split(THREAD_SEPARATOR);
  if (parts.length !== 3) return undefined;
  const [sessionId, agent, rawN] = parts as [string, string, string];
  if (!isAgentKind(agent)) return undefined;
  const n = Number(rawN);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return { session_id: sessionId, agent, n };
}

const APPROVAL_TTL_MS = 15 * 60_000;

/** Allowed (source, kind) pairs. Lightweight fail-fast guard against dirty events. */
const KINDS: Record<Source, ReadonlySet<string>> = {
  user: new Set(["user_message"]),
  orchestrator: new Set(["reply", "dispatch", "skill_invoke", "skill_result", "error", "tool_use", "tool_result", "user_input_required"]),
  market_data: new Set(["task_result", "tool_use", "tool_result", "subagent_note"]),
  market_research: new Set(["task_result", "tool_use", "tool_result", "subagent_note"]),
  trading_operations: new Set(["task_result", "tool_use", "tool_result", "approval_required", "approval_resolved", "subagent_note"]),
  financial_modeling: new Set(["task_result", "tool_use", "tool_result", "subagent_note"]),
  skill: new Set(["skill_invoke", "workflow_started", "workflow_step", "workflow_done"]),
};

export interface DerivedTask {
  task_id: string; // the dispatch event_id
  agent: AgentKind;
  task: string;
  status: "running" | "ok" | "failed" | "timeout";
  result?: TaskResult;
}

/**
 * Which slice of a subagent's trace to read. Every projection takes one, so
 * the choice is visible at each call site rather than baked into a method name.
 *
 *  - `{ thread }` — every round of that conversation. The agent's own prompt is
 *    built from this: continuing a thread means coming back to your own work.
 *  - `{ task }` — one dispatch. A task_result is assembled from this: a round
 *    reports what it did, not what the whole thread has ever produced.
 */
export type TraceScope = { thread: string } | { task: string };

/** A subagent conversation the orchestrator can address. Derived from the
 *  dispatch/task_result pairs on the main thread. */
export interface LiveThread {
  thread_id: string;
  agent: AgentKind;
  rounds: number;
  last_turn: number;
  last_task: string;
  status: DerivedTask["status"];
  last_summary?: string;
}

export interface DerivedWorkflow {
  workflow_id: string;
  skill: string;
  workflow: string;
  status: "running" | "ok" | "failed";
  steps: { step_id: string; title: string; status: string }[];
  summary?: string;
}

/**
 * Fold one `user_input_required` event into its view: the request, who asked,
 * and the append-only status the first later user turn decides (it either
 * answers this exact request or skips it by moving on).
 *
 * A free function over a plain event list because the HTTP history assembler
 * (`src/server/chatHistory.ts`) folds the same event from a bare array without
 * a SessionState — it used to carry its own copy of this logic, and the two
 * drifting apart would mean a card that reads differently live and on reload.
 *
 * `asked_by` defaults to `orchestrator`: events recorded before the field
 * existed are all the Topic agent's own questions.
 */
export function foldUserInputRequest(event: SessionEvent, events: readonly SessionEvent[]): UserInputRequestView {
  const request = event.payload.request as unknown as UserInputRequest;
  const asked_by = (event.payload.asked_by as UserInputAskedBy | undefined) ?? "orchestrator";
  const nextUserMessage = events.find(
    (candidate) => candidate.kind === "user_message" && candidate.turn > event.turn,
  );
  if (!nextUserMessage) return { ...request, asked_by, status: "pending" };
  const response = nextUserMessage.payload.input_response as unknown as UserInputResponse | undefined;
  if (nextUserMessage.payload.response_to === request.request_id && response) {
    return { ...request, asked_by, status: "answered", answers: response.answers };
  }
  return { ...request, asked_by, status: "skipped" };
}

export class SessionState {
  readonly session_id: string;
  readonly started_at: string;
  readonly version = "1" as const;
  private readonly events: SessionEvent[] = [];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly store: EventStore | undefined;
  private turn = 0;
  private promptTokensIn?: number;
  private compaction?: CompactionCache;
  /**
   * Highest thread number handed out per agent. Deliberately NOT derived from
   * the in-memory log on demand: `compactEvents` drops old events, so counting
   * them would let the numbering wrap around and reuse a live thread's id.
   * Seeded from the full durable log in `restore()`.
   */
  private readonly threadCounters = new Map<AgentKind, number>();

  constructor(sessionId: string, startedAt: string, store?: EventStore) {
    this.session_id = sessionId;
    this.started_at = startedAt;
    this.store = store;
  }

  /** Subscribe to appended events (the SSE projector's hook). Returns an unsubscribe. */
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── threads ──────────────────────────────────────────────────────────
  /** The main conversation's thread — the one the user is in. */
  get mainThread(): string {
    return this.session_id;
  }

  /**
   * Mint the next thread for this agent. Called synchronously from
   * `Dispatcher.recordDispatch`, which is why two tasks dispatched to the same
   * agent in one orchestrator step get distinct numbers: `Promise.all` over a
   * `.map` runs each task's synchronous prefix to completion before starting
   * the next, and this method never awaits.
   */
  openThread(agent: AgentKind): string {
    const n = (this.threadCounters.get(agent) ?? 0) + 1;
    this.threadCounters.set(agent, n);
    return `${this.session_id}${THREAD_SEPARATOR}${agent}${THREAD_SEPARATOR}${n}`;
  }

  /**
   * The agent a thread belongs to, or undefined if this session never opened
   * it. Answered from the counter map rather than by scanning the log, so it
   * stays correct after compaction has dropped the opening dispatch out of
   * memory.
   */
  threadOwner(threadId: string): AgentKind | undefined {
    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.session_id !== this.session_id) return undefined;
    if (parsed.n > (this.threadCounters.get(parsed.agent) ?? 0)) return undefined;
    return parsed.agent;
  }

  // ── single write entry ───────────────────────────────────────────────
  /** Append one event. Stamps id/timestamp; defaults parent to the last event,
   *  turn to the current turn, and thread to the main conversation. Validates
   *  (source, kind) fail-fast. */
  record(
    source: Source,
    kind: string,
    payload: JsonObject,
    opts: { parent?: string | null; threadId?: string; turn?: number } = {},
  ): SessionEvent {
    if (!KINDS[source]?.has(kind)) {
      throw new Error(`invalid event (source=${source}, kind=${kind})`);
    }
    const event: SessionEvent = {
      event_id: newId("ev"),
      parent_event_id: opts.parent !== undefined ? opts.parent : (this.events.at(-1)?.event_id ?? null),
      session_id: this.session_id,
      timestamp: new Date().toISOString(),
      source,
      kind,
      thread_id: opts.threadId ?? this.mainThread,
      turn: opts.turn ?? this.turn,
      payload,
    };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    if (this.store) {
      this.store.appendEvent(event).catch((err) => {
        console.error(`[sessionState] failed to persist event ${event.event_id}:`, err);
      });
    }
    return event;
  }

  // ── convenience writers ──────────────────────────────────────────────
  /** Start a new user turn and record the message. Returns the new turn number. */
  beginTurn(content: string, inputResponse?: UserInputResponse): number {
    this.turn += 1;
    const payload: JsonObject = { content };
    if (inputResponse) {
      payload.response_to = inputResponse.request_id;
      payload.input_response = inputResponse as unknown as JsonObject;
    }
    this.record("user", "user_message", payload);
    return this.turn;
  }

  get currentTurn(): number {
    return this.turn;
  }

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

  /** Persist the current compaction cache to the EventStore, if configured.
   *  No-op when there's no store or no cache yet. */
  async persistCompactionCache(): Promise<void> {
    if (!this.store || !this.compaction) return;
    await this.store.saveCompaction(this.session_id, this.compaction);
  }

  /**
   * Remove events with `turn <= throughTurn` from the in-memory log. Safe to
   * call after compact() has folded those turns into the compaction cache —
   * the EventStore retains the full history.
   *
   * Events belonging to a subagent thread that is still being dispatched to
   * survive: dropping them would make the next round of a long-running thread
   * come back to an amnesiac agent. They cost the orchestrator nothing to keep
   * — its own projection never looks at another thread — and the size of any
   * one thread is bounded separately, by the thread-level cap in
   * contextCompaction.
   */
  compactEvents(throughTurn: number): void {
    const liveThreads = new Set<string>();
    for (const e of this.events) {
      if (e.kind === "dispatch" && e.turn > throughTurn && typeof e.payload.child_thread_id === "string") {
        liveThreads.add(e.payload.child_thread_id);
      }
    }
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.turn > throughTurn) continue;
      if (e.thread_id !== this.mainThread && liveThreads.has(e.thread_id)) continue;
      this.events.splice(i, 1);
    }
  }

  recordReply(content: string, final: boolean): SessionEvent {
    return this.record("orchestrator", "reply", { content, final });
  }

  /**
   * The orchestrator handing work to a subagent. This event lives on the MAIN
   * thread — the orchestrator wrote it and reads it back — and points at the
   * child thread the work runs in. That pointer is the seam between the two
   * conversations, and it is how the orchestrator learns the id of a thread it
   * just opened.
   */
  recordDispatch(agent: AgentKind, task: string, childThreadId: string): SessionEvent {
    return this.record("orchestrator", "dispatch", { agent, task, child_thread_id: childThreadId });
  }

  recordTaskResult(agent: AgentKind, dispatchEventId: string, result: TaskResult): SessionEvent {
    // Idempotent: first writer wins. Guards the timeout race where a timed-out
    // subagent finishes late after the dispatcher already wrote the timeout result.
    const existing = this.events.find((e) => e.kind === "task_result" && e.parent_event_id === dispatchEventId);
    if (existing) return existing;
    const payload: JsonObject = { status: result.status, summary: result.summary };
    if (result.generation_context) payload.generation_context = result.generation_context as unknown as JsonObject;
    if (result.artifacts) payload.artifacts = result.artifacts as unknown as JsonObject[string];
    if (result.visualizations) payload.visualizations = result.visualizations;
    if (result.error) payload.error = result.error;
    if (result.metrics) payload.metrics = result.metrics as unknown as JsonObject;
    return this.record(agent, "task_result", payload, { parent: dispatchEventId });
  }

  // ── derived views (replace the old Map stores) ───────────────────────
  /** Task = a dispatch event; its status is derived from whether a child
   *  task_result exists. Replaces the old tasks store. */
  task(dispatchEventId: string): DerivedTask | undefined {
    const dispatch = this.events.find((e) => e.event_id === dispatchEventId && e.kind === "dispatch");
    if (!dispatch) return undefined;
    const agent = dispatch.payload.agent as AgentKind;
    const resultEv = this.events.find((e) => e.kind === "task_result" && e.parent_event_id === dispatchEventId);
    const status = (resultEv?.payload.status as DerivedTask["status"]) ?? "running";
    const out: DerivedTask = {
      task_id: dispatchEventId,
      agent,
      task: dispatch.payload.task as string,
      status,
    };
    if (resultEv) {
      const result: TaskResult = {
        task_id: dispatchEventId,
        agent,
        status: status as TaskResult["status"],
        summary: resultEv.payload.summary as string,
      };
      if (resultEv.payload.generation_context) result.generation_context = resultEv.payload.generation_context as unknown as GenerationContext;
      if (resultEv.payload.artifacts) result.artifacts = resultEv.payload.artifacts as unknown as ArtifactRef[];
      if (resultEv.payload.visualizations) result.visualizations = resultEv.payload.visualizations as JsonObject[];
      if (resultEv.payload.error) result.error = resultEv.payload.error as { code: string; message: string };
      if (resultEv.payload.metrics) result.metrics = resultEv.payload.metrics as unknown as NonNullable<TaskResult["metrics"]>;
      out.result = result;
    }
    return out;
  }

  /**
   * The subagent conversations this topic has, most recently active last —
   * what the orchestrator picks from when it wants to continue work rather
   * than start over.
   *
   * Dispatches written before threads existed have no `child_thread_id` and are
   * skipped. That is correct: those runs were one-shot, and there is no trace
   * to come back to.
   */
  liveThreads(): LiveThread[] {
    const byThread = new Map<string, LiveThread>();
    for (const e of this.events) {
      if (e.kind !== "dispatch") continue;
      const threadId = e.payload.child_thread_id;
      if (typeof threadId !== "string") continue;
      const derived = this.task(e.event_id);
      const entry: LiveThread = {
        thread_id: threadId,
        agent: e.payload.agent as AgentKind,
        rounds: (byThread.get(threadId)?.rounds ?? 0) + 1,
        last_turn: e.turn,
        last_task: e.payload.task as string,
        status: derived?.status ?? "running",
      };
      if (derived?.result?.summary) entry.last_summary = derived.result.summary;
      byThread.delete(threadId); // re-insert so Map order tracks recency
      byThread.set(threadId, entry);
    }
    return [...byThread.values()];
  }

  /** All task results for a turn, in dispatch order. Replaces collecting the
   *  dispatcher's return values. */
  turnResults(turn: number): TaskResult[] {
    const out: TaskResult[] = [];
    for (const e of this.events) {
      if (e.kind !== "dispatch" || e.turn !== turn) continue;
      const result = this.task(e.event_id)?.result;
      if (result) out.push(result);
    }
    return out;
  }

  /**
   * The events of a subagent trace, in order, narrowed to a scope.
   *
   * Everything below `[PROGRESS SO FAR]` in the thread is replayed from here,
   * and anything on the main thread is excluded — a question a subagent raised
   * to the user is recorded on the main thread on purpose, and must not read
   * back as one of the agent's own tool results.
   */
  private *trace(scope: TraceScope): Generator<SessionEvent> {
    const all = this.events.filter((e) =>
      e.thread_id !== this.mainThread
      && ("thread" in scope ? e.thread_id === scope.thread : e.payload.task_id === scope.task));
    // A thread summary is a barrier: the rounds before it have been folded into
    // it, so replaying them too would defeat the fold.
    let barrier = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i]!;
      if (e.kind === "subagent_note" && e.payload.thread_summary === true) { barrier = i; break; }
    }
    yield* barrier === -1 ? all : all.slice(barrier);
  }

  /** Render a subagent's work so far into [PROGRESS SO FAR] text. This is its
   *  loop context — it reads its own results back from the log to decide
   *  whether to call more tools. The structured `generation_context.data` is
   *  injected (not the tool's hand-written summary) so the decision is grounded
   *  in real values. Scope this to the THREAD: the point of a thread is that
   *  the agent comes back to what it already did. */
  subagentProgress(scope: TraceScope): string {
    const lines: string[] = [];
    for (const e of this.trace(scope)) {
      // 每步的 note 与工具结果按时间交错:模型上一步"打算做什么"的一行字
      // 跨步存活,是它自己的连续性记忆。
      if (e.kind === "subagent_note") {
        const step = typeof e.payload.step === "number" ? ` step ${e.payload.step}` : "";
        lines.push(`[note${step}] ${e.payload.note as string}`);
        continue;
      }
      if (e.kind !== "tool_result") continue;
      const name = (e.payload.name as string) ?? "tool";
      const err = e.payload.error as { message?: string } | undefined;
      if (err) {
        lines.push(`[${name} error] ${err.message ?? ""}`);
        continue;
      }
      const gc = e.payload.generation_context as GenerationContext | undefined;
      const body = gc ? JSON.stringify(gc.data) : (e.payload.summary as string);
      lines.push(`[${name}] ${body}`);
    }
    return lines.length ? lines.join("\n") : "(no tools called yet)";
  }

  /** Successful tool outputs, read from the log. Scope this to the TASK when
   *  assembling a task_result — a round reports the work it did, not every
   *  artifact the thread has ever produced. */
  subagentToolOutputs(scope: TraceScope): { name: string; summary: string; generation_context?: GenerationContext; artifacts?: ArtifactRef[]; visualizations?: JsonObject[] }[] {
    const out: { name: string; summary: string; generation_context?: GenerationContext; artifacts?: ArtifactRef[]; visualizations?: JsonObject[] }[] = [];
    for (const e of this.trace(scope)) {
      if (e.kind !== "tool_result" || e.payload.error) continue;
      const item: { name: string; summary: string; generation_context?: GenerationContext; artifacts?: ArtifactRef[]; visualizations?: JsonObject[] } = {
        name: (e.payload.name as string) ?? "tool",
        summary: e.payload.summary as string,
      };
      if (e.payload.generation_context) item.generation_context = e.payload.generation_context as unknown as GenerationContext;
      if (e.payload.artifacts) item.artifacts = e.payload.artifacts as unknown as ArtifactRef[];
      if (e.payload.visualizations) item.visualizations = e.payload.visualizations as JsonObject[];
      out.push(item);
    }
    return out;
  }

  /** Every per-step note the subagent wrote, in order, with the step it was
   * written at — the step numbers are what let the model see its own repetition
   * ("I have said 'check once' for ten steps straight"). */
  subagentNotes(scope: TraceScope): { step: number; note: string }[] {
    const notes: { step: number; note: string }[] = [];
    for (const e of this.trace(scope)) {
      if (e.kind !== "subagent_note") continue;
      if (typeof e.payload.note === "string") {
        notes.push({ step: typeof e.payload.step === "number" ? e.payload.step : 0, note: e.payload.note });
      }
    }
    return notes;
  }

  subagentToolErrors(scope: TraceScope): { name: string; code: string; message: string; summary?: string; step?: number }[] {
    const out: { name: string; code: string; message: string; summary?: string; step?: number }[] = [];
    for (const e of this.trace(scope)) {
      if (e.kind !== "tool_result") continue;
      const err = e.payload.error as { code?: string; message?: string } | undefined;
      if (!err) continue;
      const item: { name: string; code: string; message: string; summary?: string; step?: number } = {
        name: (e.payload.name as string) ?? "tool",
        code: err.code ?? "tool_error",
        message: err.message ?? (e.payload.summary as string | undefined) ?? "Tool failed.",
      };
      if (typeof e.payload.summary === "string") item.summary = e.payload.summary;
      if (typeof e.payload.step === "number") item.step = e.payload.step;
      out.push(item);
    }
    return out;
  }

  /** A pending approval = approval_required with no approval_resolved and within TTL.
   *  Replaces the old approvals store. */
  pendingApproval(approvalId: string): { approval_id: string; payload: JsonObject } | undefined {
    const req = [...this.events].reverse().find(
      (e) => e.kind === "approval_required" && e.payload.approval_id === approvalId,
    );
    if (!req) return undefined;
    const resolved = this.events.some(
      (e) => e.kind === "approval_resolved" && e.payload.approval_id === approvalId,
    );
    if (resolved) return undefined;
    if (Date.now() - new Date(req.timestamp).getTime() > APPROVAL_TTL_MS) return undefined;
    return { approval_id: approvalId, payload: req.payload.payload as JsonObject };
  }

  /**
   * `askedBy` names the actor behind the question — the Topic agent by default,
   * but also the financial_modeling subagent below it or the Research
   * controller above it. It is a payload field, not the event's `source`,
   * because the controller records through this same orchestrator channel.
   *
   * A question is one of the two ways a subagent deliberately speaks past its
   * own thread: it has to reach the user, so the event goes on the MAIN thread
   * (that is what puts the card in front of them). `fromThread` records where
   * it came from, so the answer can be routed back by dispatching that thread
   * again. Nothing has to be guessed from the agent name or the model handle.
   */
  recordUserInputRequest(
    request: UserInputRequest,
    askedBy: UserInputAskedBy = "orchestrator",
    fromThread?: string,
  ): SessionEvent {
    return this.record("orchestrator", "user_input_required", {
      request: request as unknown as JsonObject,
      asked_by: askedBy,
      ...(fromThread ? { from_thread: fromThread } : {}),
    });
  }

  /**
   * Whether this thread's previous round ended by asking the user something,
   * rather than by finishing work. The seam note a resuming run writes says
   * different things in the two cases — "your question was answered, do not ask
   * again" versus "here is more work in the same thread" — and getting it wrong
   * is how an agent ends up re-asking a question the user already answered.
   *
   * `currentTaskId` is this round's dispatch, which is already in the log by the
   * time the run starts and would otherwise be the first thing found.
   */
  threadPausedOnQuestion(threadId: string, currentTaskId: string): boolean {
    const cutoff = this.events.findIndex((e) => e.event_id === currentTaskId);
    const before = cutoff === -1 ? this.events : this.events.slice(0, cutoff);
    for (let i = before.length - 1; i >= 0; i--) {
      const e = before[i]!;
      if (e.kind === "user_input_required" && e.payload.from_thread === threadId) return true;
      if (e.kind === "dispatch" && e.payload.child_thread_id === threadId) return false;
    }
    return false;
  }

  /** The request plus its append-only derived state. The first later user turn
   *  either answers this exact request or skips it by moving on. */
  userInputRequest(requestId: string): UserInputRequestView | undefined {
    const event = [...this.events].reverse().find((candidate) => {
      if (candidate.kind !== "user_input_required") return false;
      const request = candidate.payload.request as unknown as UserInputRequest | undefined;
      return request?.request_id === requestId;
    });
    if (!event) return undefined;
    return this.userInputViewForEvent(event);
  }

  pendingUserInput(requestId: string): UserInputRequest | undefined {
    const view = this.userInputRequest(requestId);
    if (!view || view.status !== "pending") return undefined;
    const { status: _status, answers: _answers, asked_by: _askedBy, ...request } = view;
    return request;
  }

  userInputRequestForTurn(turn: number): UserInputRequestView | undefined {
    const event = this.events.find((candidate) => candidate.turn === turn && candidate.kind === "user_input_required");
    return event ? this.userInputViewForEvent(event) : undefined;
  }

  private userInputViewForEvent(event: SessionEvent): UserInputRequestView {
    return foldUserInputRequest(event, this.events);
  }

  /** Fold workflow_* events into a progress view. Replaces the old workflows store. */
  workflow(workflowId: string): DerivedWorkflow | undefined {
    const evs = this.events.filter((e) => e.payload.workflow_id === workflowId);
    const started = evs.find((e) => e.kind === "workflow_started");
    if (!started) return undefined;
    const done = evs.find((e) => e.kind === "workflow_done");
    // Collapse step events to the latest status per step_id (running → done).
    const stepMap = new Map<string, { step_id: string; title: string; status: string }>();
    for (const e of evs.filter((e) => e.kind === "workflow_step")) {
      stepMap.set(e.payload.step_id as string, {
        step_id: e.payload.step_id as string,
        title: e.payload.title as string,
        status: e.payload.status as string,
      });
    }
    const steps = [...stepMap.values()];
    const out: DerivedWorkflow = {
      workflow_id: workflowId,
      skill: started.payload.skill as string,
      workflow: started.payload.workflow as string,
      status: (done?.payload.status as DerivedWorkflow["status"]) ?? "running",
      steps,
    };
    if (done?.payload.summary) out.summary = done.payload.summary as string;
    return out;
  }

  // ── prompt projection (replaces renderHistory + loopLog) ─────────────
  /**
   * Build the orchestrator's context for the given turn from the log alone:
   *  - conversationSoFar: prior turns' user_message + final replies
   *  - currentTurnProgress: this turn's dispatches, task_results, and status replies
   * Only the main thread is read: a subagent's own loop is its business, and
   * the orchestrator sees it as one task_result line. Artifacts are numbered
   * globally across the turn so the final answer can embed {{artifact:N}};
   * `artifacts` lists them in that order for the caller (server `final` event).
   */
  projectForPrompt(turn: number): { conversationSoFar: string; currentTurnProgress: string; artifacts: ArtifactRef[] } {
    const visible = this.events.filter((e) => e.thread_id === this.mainThread);

    const priorArtifacts: ArtifactRef[] = [];
    const priorLines: string[] = [];
    for (const e of visible.filter((e) => e.turn < turn)) {
      if (e.kind === "user_message") priorLines.push(`User: ${e.payload.content as string}`);
      else if (e.kind === "reply" && e.payload.final === true) priorLines.push(`You: ${e.payload.content as string}`);
      else if (e.kind === "dispatch") priorLines.push(this.formatDispatchLine(e));
      else if (e.kind === "approval_required" && this.isApprovalPendingEvent(e)) priorLines.push(this.formatApprovalRequiredLine(e));
      else if (e.kind === "task_result") priorLines.push(this.formatTaskResultLine(e, priorArtifacts));
    }

    const artifacts: ArtifactRef[] = [];
    const progressLines: string[] = [];
    for (const e of visible.filter((e) => e.turn === turn)) {
      if (e.kind === "reply") progressLines.push(`You: ${e.payload.content as string}`);
      else if (e.kind === "dispatch") progressLines.push(this.formatDispatchLine(e));
      else if (e.kind === "skill_invoke") progressLines.push(`[skill ${e.payload.skill as string}]`);
      // The orchestrator's own errors — a malformed step, a protocol violation —
      // are the one class of failure it can actually correct, but only if it can
      // see them. Without this the same bad step just repeats until the budget runs out.
      else if (e.kind === "error") progressLines.push(`[error] ${e.payload.message as string}`);
      else if (e.kind === "skill_result") {
        const content = e.payload.content as string | undefined;
        progressLines.push(
          content
            ? `[skill ${e.payload.skill as string}]\n${content}`
            : `[skill ${e.payload.skill as string}] ${e.payload.summary as string}`,
        );
      }
      else if (e.kind === "approval_required" && this.isApprovalPendingEvent(e)) progressLines.push(this.formatApprovalRequiredLine(e));
      else if (e.kind === "user_input_required") progressLines.push(this.formatUserInputRequiredLine(e));
      else if (e.kind === "task_result") progressLines.push(this.formatTaskResultLine(e, artifacts));
      else if (e.kind === "tool_result") {
        const name = e.payload.name as string;
        const err = e.payload.error as { message?: string } | undefined;
        if (err) {
          progressLines.push(`[${name} error] ${err.message ?? ""}`);
        } else {
          const gc = e.payload.generation_context as GenerationContext | undefined;
          const lines = [`[${name} result] ${e.payload.summary as string}`];
          if (gc) {
            if (gc.prompt) lines.push(`  generation_context_prompt: ${gc.prompt}`);
            lines.push(`  generation_data: ${JSON.stringify(gc.data)}`);
          }
          progressLines.push(lines.join("\n"));
        }
      }
    }

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

  /** Echoes the thread the work went into, so the orchestrator learns the id of
   *  a thread it just opened and can name it on a later turn. */
  private formatDispatchLine(e: SessionEvent): string {
    const threadId = e.payload.child_thread_id;
    const thread = typeof threadId === "string" ? ` thread=${threadId}` : "";
    return `[dispatch → ${e.payload.agent}${thread}] ${e.payload.task as string}`;
  }

  private formatTaskResultLine(e: SessionEvent, artifacts: ArtifactRef[]): string {
    const agent = e.source;
    const gc = e.payload.generation_context as GenerationContext | undefined;
    const evArtifacts = (e.payload.artifacts as ArtifactRef[] | undefined) ?? [];
    const error = e.payload.error as { code: string; message: string } | undefined;

    const parts: string[] = [`[${agent} result] status=${e.payload.status as string} | ${e.payload.summary as string}`];
    if (error) parts.push(`  error(${error.code}): ${error.message}`);
    if (gc) {
      if (gc.prompt) parts.push(`  generation_context_prompt: ${gc.prompt}`);
      parts.push(`  generation_data: ${JSON.stringify(gc.data)}`);
    }
    for (const artifact of evArtifacts) {
      artifacts.push(artifact);
      const n = artifacts.length;
      parts.push(`  artifact ${n}: ${artifact.type} "${artifact.label ?? artifact.ref}" — embed with {{artifact:${n}}}`);
    }
    return parts.join("\n");
  }

  private formatApprovalRequiredLine(e: SessionEvent): string {
    const approvalId = e.payload.approval_id as string;
    const payload = e.payload.payload as JsonObject | undefined;
    const summary = payload
      ? String(payload["summary"] ?? `strategy ${String(payload["strategy_id"] ?? approvalId)}`)
      : `strategy ${approvalId}`;
    return `[strategy approval_required] approval_id=${approvalId} | ${summary} is awaiting user approval; the strategy has not been activated yet.`;
  }

  private formatUserInputRequiredLine(e: SessionEvent): string {
    const request = e.payload.request as unknown as UserInputRequest;
    const questions = request.questions.map((question) => question.question).join(" | ");
    return `[user input requested] request_id=${request.request_id} | ${questions}`;
  }

  private isApprovalPendingEvent(e: SessionEvent): boolean {
    const approvalId = e.payload.approval_id as string;
    const resolved = this.events.some(
      (event) => event.kind === "approval_resolved" && event.payload.approval_id === approvalId,
    );
    if (resolved) return false;
    return Date.now() - new Date(e.timestamp).getTime() <= APPROVAL_TTL_MS;
  }

  // ── serialization ────────────────────────────────────────────────────
  snapshot(): JsonObject {
    return {
      session_id: this.session_id,
      started_at: this.started_at,
      version: this.version,
      events: this.events as unknown as JsonObject[string],
    };
  }

  allEvents(): readonly SessionEvent[] {
    return this.events;
  }

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
    // Seed the thread counters from the FULL durable log, not from whatever is
    // still in memory — this is the one place that sees every thread the
    // session ever opened, so it is the only place the numbering can be made
    // safe against reuse.
    for (const e of events) {
      const parsed = parseThreadId(e.thread_id);
      if (!parsed || parsed.session_id !== sessionId) continue;
      const seen = state.threadCounters.get(parsed.agent) ?? 0;
      if (parsed.n > seen) state.threadCounters.set(parsed.agent, parsed.n);
    }
    if (compaction) state.compaction = compaction;
    return state;
  }
}

/** Holds one SessionState per session id (replaces the global Stores object). */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly store: EventStore | undefined;

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

  /** Load the complete durable event log for chat-history projection.
   *  Unlike SessionState.allEvents(), this still includes compacted turns. */
  async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    if (this.store) return this.store.loadEvents(sessionId);
    const state = await this.getOrCreate(sessionId);
    return [...state.allEvents()];
  }

  /** Evict a deleted room so a later request cannot reuse stale in-memory events. */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  findPendingApproval(approvalId: string): { state: SessionState; event: SessionEvent; payload: JsonObject } | undefined {
    for (const state of this.sessions.values()) {
      const pending = state.pendingApproval(approvalId);
      if (!pending) continue;
      const event = [...state.allEvents()].reverse().find(
        (e) => e.kind === "approval_required" && e.payload.approval_id === approvalId,
      );
      if (!event) continue;
      return { state, event, payload: pending.payload };
    }
    return undefined;
  }
}
