import { newId } from "./ids.ts";
import type { AgentKind, ArtifactRef, GenerationContext, JsonObject, TaskResult } from "./types.ts";
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

export type Source = "user" | "orchestrator" | "market_data" | "market_research" | "trading_operations" | "skill";

export interface SessionEvent {
  event_id: string;
  parent_event_id: string | null;
  session_id: string;
  timestamp: string; // ISO UTC
  source: Source;
  kind: string;
  is_sidechain: boolean; // subagent-internal events; excluded from the orchestrator's context projection
  turn: number; // which user turn this belongs to
  payload: JsonObject;
}

const APPROVAL_TTL_MS = 15 * 60_000;

/** Allowed (source, kind) pairs. Lightweight fail-fast guard against dirty events. */
const KINDS: Record<Source, ReadonlySet<string>> = {
  user: new Set(["user_message"]),
  orchestrator: new Set(["reply", "dispatch", "skill_invoke", "error", "tool_use", "tool_result"]),
  market_data: new Set(["task_result", "tool_use", "tool_result"]),
  market_research: new Set(["task_result", "tool_use", "tool_result"]),
  trading_operations: new Set(["task_result", "tool_use", "tool_result", "approval_required", "approval_resolved"]),
  skill: new Set(["skill_invoke", "workflow_started", "workflow_step", "workflow_done"]),
};

export interface DerivedTask {
  task_id: string; // the dispatch event_id
  agent: AgentKind;
  task: string;
  status: "running" | "ok" | "failed" | "timeout";
  result?: TaskResult;
}

export interface DerivedWorkflow {
  workflow_id: string;
  skill: string;
  workflow: string;
  status: "running" | "ok" | "failed";
  steps: { step_id: string; title: string; status: string }[];
  summary?: string;
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

  // ── single write entry ───────────────────────────────────────────────
  /** Append one event. Stamps id/timestamp; defaults parent to the last event
   *  and turn to the current turn. Validates (source, kind) fail-fast. */
  record(
    source: Source,
    kind: string,
    payload: JsonObject,
    opts: { parent?: string | null; isSidechain?: boolean; turn?: number } = {},
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
      is_sidechain: opts.isSidechain ?? false,
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
  beginTurn(content: string): number {
    this.turn += 1;
    this.record("user", "user_message", { content });
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

  /** Remove all events with `turn <= throughTurn` from the in-memory log.
   *  Safe to call after compact() has folded those turns into the
   *  compaction cache — the EventStore retains the full history. */
  compactEvents(throughTurn: number): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.turn <= throughTurn) this.events.splice(i, 1);
    }
  }

  recordReply(content: string, final: boolean): SessionEvent {
    return this.record("orchestrator", "reply", { content, final });
  }

  recordDispatch(agent: AgentKind, task: string): SessionEvent {
    return this.record("orchestrator", "dispatch", { agent, task });
  }

  recordTaskResult(agent: AgentKind, dispatchEventId: string, result: TaskResult): SessionEvent {
    // Idempotent: first writer wins. Guards the timeout race where a timed-out
    // subagent finishes late after the dispatcher already wrote the timeout result.
    const existing = this.events.find((e) => e.kind === "task_result" && e.parent_event_id === dispatchEventId);
    if (existing) return existing;
    const payload: JsonObject = { status: result.status, summary: result.summary };
    if (result.generation_context) payload.generation_context = result.generation_context as unknown as JsonObject;
    if (result.artifacts) payload.artifacts = result.artifacts as unknown as JsonObject[string];
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
      if (resultEv.payload.error) result.error = resultEv.payload.error as { code: string; message: string };
      if (resultEv.payload.metrics) result.metrics = resultEv.payload.metrics as unknown as NonNullable<TaskResult["metrics"]>;
      out.result = result;
    }
    return out;
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

  /** Render a subagent task's tool calls so far (its sidechain tool_result events)
   *  into [PROGRESS SO FAR] text. This is the subagent's loop context — it reads
   *  its own results back from the log to decide whether to call more tools.
   *  The actual structured `generation_context.data` is injected (not the tool's
   *  hand-written summary) so the decision is grounded in real values. */
  subagentProgress(dispatchEventId: string): string {
    const lines: string[] = [];
    for (const e of this.events) {
      if (!e.is_sidechain || e.kind !== "tool_result" || e.payload.task_id !== dispatchEventId) continue;
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

  /** Successful tool outputs for a subagent task, read from the log, used to
   *  assemble the task_result's generation_context. */
  subagentToolOutputs(dispatchEventId: string): { name: string; summary: string; generation_context?: GenerationContext; artifacts?: ArtifactRef[] }[] {
    const out: { name: string; summary: string; generation_context?: GenerationContext; artifacts?: ArtifactRef[] }[] = [];
    for (const e of this.events) {
      if (!e.is_sidechain || e.kind !== "tool_result" || e.payload.task_id !== dispatchEventId || e.payload.error) continue;
      const item: { name: string; summary: string; generation_context?: GenerationContext; artifacts?: ArtifactRef[] } = {
        name: (e.payload.name as string) ?? "tool",
        summary: e.payload.summary as string,
      };
      if (e.payload.generation_context) item.generation_context = e.payload.generation_context as unknown as GenerationContext;
      if (e.payload.artifacts) item.artifacts = e.payload.artifacts as unknown as ArtifactRef[];
      out.push(item);
    }
    return out;
  }

  subagentToolErrors(dispatchEventId: string): { name: string; code: string; message: string; summary?: string }[] {
    const out: { name: string; code: string; message: string; summary?: string }[] = [];
    for (const e of this.events) {
      if (!e.is_sidechain || e.kind !== "tool_result" || e.payload.task_id !== dispatchEventId) continue;
      const err = e.payload.error as { code?: string; message?: string } | undefined;
      if (!err) continue;
      const item: { name: string; code: string; message: string; summary?: string } = {
        name: (e.payload.name as string) ?? "tool",
        code: err.code ?? "tool_error",
        message: err.message ?? (e.payload.summary as string | undefined) ?? "Tool failed.",
      };
      if (typeof e.payload.summary === "string") item.summary = e.payload.summary;
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
   * Sidechain (subagent-internal) events are excluded. Artifacts are numbered
   * globally across the turn so the final answer can embed {{artifact:N}};
   * `artifacts` lists them in that order for the caller (server `final` event).
   */
  projectForPrompt(turn: number): { conversationSoFar: string; currentTurnProgress: string; artifacts: ArtifactRef[] } {
    const visible = this.events.filter((e) => !e.is_sidechain);

    const priorArtifacts: ArtifactRef[] = [];
    const priorLines: string[] = [];
    for (const e of visible.filter((e) => e.turn < turn)) {
      if (e.kind === "user_message") priorLines.push(`User: ${e.payload.content as string}`);
      else if (e.kind === "reply" && e.payload.final === true) priorLines.push(`You: ${e.payload.content as string}`);
      else if (e.kind === "dispatch") priorLines.push(`[dispatch → ${e.payload.agent}] ${e.payload.task as string}`);
      else if (e.kind === "approval_required" && this.isApprovalPendingEvent(e)) priorLines.push(this.formatApprovalRequiredLine(e));
      else if (e.kind === "task_result") priorLines.push(this.formatTaskResultLine(e, priorArtifacts));
    }

    const artifacts: ArtifactRef[] = [];
    const progressLines: string[] = [];
    for (const e of visible.filter((e) => e.turn === turn)) {
      if (e.kind === "reply") progressLines.push(`You: ${e.payload.content as string}`);
      else if (e.kind === "dispatch") progressLines.push(`[dispatch → ${e.payload.agent}] ${e.payload.task as string}`);
      else if (e.kind === "skill_invoke") progressLines.push(`[skill ${e.payload.skill as string}]`);
      else if (e.kind === "approval_required" && this.isApprovalPendingEvent(e)) progressLines.push(this.formatApprovalRequiredLine(e));
      else if (e.kind === "task_result") progressLines.push(this.formatTaskResultLine(e, artifacts));
      else if (e.kind === "tool_result" && !e.is_sidechain) {
        const name = e.payload.name as string;
        const err = e.payload.error as { message?: string } | undefined;
        if (err) {
          progressLines.push(`[${name} error] ${err.message ?? ""}`);
        } else {
          const gc = e.payload.generation_context as GenerationContext | undefined;
          const lines = [`[${name} result] ${e.payload.summary as string}`];
          if (gc) {
            lines.push(`  generation_context_prompt: ${gc.prompt}`);
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

  private formatTaskResultLine(e: SessionEvent, artifacts: ArtifactRef[]): string {
    const agent = e.source;
    const gc = e.payload.generation_context as GenerationContext | undefined;
    const evArtifacts = (e.payload.artifacts as ArtifactRef[] | undefined) ?? [];
    const error = e.payload.error as { code: string; message: string } | undefined;

    const parts: string[] = [`[${agent} result] status=${e.payload.status as string} | ${e.payload.summary as string}`];
    if (error) parts.push(`  error(${error.code}): ${error.message}`);
    if (gc) {
      parts.push(`  generation_context_prompt: ${gc.prompt}`);
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
    const payload = e.payload.payload as JsonObject | undefined;
    const summary = payload
      ? `${payload["side"] ?? "ORDER"} ${payload["symbol"] ?? ""} on ${payload["exchange"] ?? "exchange"}`.trim()
      : "trade order";
    return `[trade approval_required] approval_id=${e.payload.approval_id as string} | ${summary} is awaiting user approval; no order has been submitted yet.`;
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
