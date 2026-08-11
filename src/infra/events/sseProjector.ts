import { createLogger } from "../logger/logger.ts";
import type { SessionEvent, SessionState } from "../../framework/sessionState.ts";
import type { AgentKind, ArtifactRef, JsonObject, JsonValue, SSEEvent } from "../../framework/types.ts";
import { collectTurnSources } from "../../framework/citationSources.ts";

const log = createLogger("orchestrator");

/**
 * Pure projection: one appended SessionEvent → zero or more SSE frames. This is
 * the ONLY place events become SSE; no agent emits frames directly. `state` is
 * read only to derive the terminal `final` frame (response + numbered artifacts).
 */
export function projectEvent(event: SessionEvent, state: SessionState): SSEEvent[] {
  const p = event.payload;
  switch (event.kind) {
    case "dispatch":
      return [
        { type: "progress", task_id: event.event_id, phase: "subagent_started", pct: 5, note: `${p.agent as string} subagent started` },
        { type: "dispatch", task_id: event.event_id, agent: p.agent as AgentKind, task: p.task as string },
      ];
    case "task_result":
      return [
        { type: "task_done", task_id: event.parent_event_id ?? event.event_id, status: p.status as "ok" | "failed" | "timeout", summary: p.summary as string },
        ...strategyCreatedFrames(p),
      ];
    case "tool_use": {
      const toolInput = p.input as { task?: string; query?: string } | undefined;
      const note = toolInput?.query || toolInput?.task || (p.name as string);
      return [{ type: "progress", task_id: (p.task_id as string) ?? event.parent_event_id ?? "", phase: "tool_call", note }];
    }
    case "tool_result": {
      const taskId = (p.task_id as string) ?? "";
      return ((p.artifacts as ArtifactRef[] | undefined) ?? []).map((artifact) => ({ type: "artifact", task_id: taskId, artifact }));
    }
    case "approval_required":
      return [{ type: "approval_required", approval_id: p.approval_id as string, payload: p.payload as Record<string, never> }];
    case "workflow_started":
      return [{ type: "workflow_started", workflow_id: p.workflow_id as string, skill: p.skill as string, workflow: p.workflow as string, title: p.title as string }];
    case "workflow_step":
      return [{ type: "workflow_step", workflow_id: p.workflow_id as string, step_id: p.step_id as string, title: p.title as string, status: p.status as "pending" | "running" | "done" | "failed", pct: p.pct as number }];
    case "workflow_done":
      return [{ type: "workflow_done", workflow_id: p.workflow_id as string, status: p.status as "ok" | "failed", summary: p.summary as string }];
    case "error":
      // A protocol violation is the orchestrator talking to itself: it reads the
      // message back on the next step and corrects. Surfacing it would show the
      // user an error for something that self-heals within the same turn.
      if (p.scope === "protocol") return [];
      return [{ type: "error", scope: (p.scope as "main" | "task") ?? "main", message: p.message as string }];
    case "reply":
      if (p.final !== true) return [{ type: "step_reply", content: p.content as string }];
      return [...tokenize(p.content as string), buildFinal(event, state), { type: "done", reason: "complete" }];
    default:
      return []; // user_message, skill_invoke, approval_resolved
  }
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function strategyCreatedFrames(payload: JsonObject): SSEEvent[] {
  if (payload.status !== "ok") return [];
  const generationContext = asObject(payload.generation_context);
  const data = asObject(generationContext?.data);
  if (!data) return [];

  const outputs = Array.isArray(data.tool_outputs) ? data.tool_outputs : [];
  return outputs
    .map((value) => asObject(value))
    .filter((output) => output?.tool === "create_strategy")
    .map((output) => asObject(output?.data))
    .filter((createData): createData is JsonObject => typeof createData?.strategy_id === "string")
    .map((createData) => {
      const frame: SSEEvent = { type: "strategy_created", strategy_id: createData.strategy_id as string };
      if (typeof createData.status === "string") frame.status = createData.status;
      if (typeof createData.summary === "string") frame.summary = createData.summary;
      else if (typeof payload.summary === "string") frame.summary = payload.summary;
      return frame;
    });
}

function tokenize(reply: string): SSEEvent[] {
  const frames: SSEEvent[] = [];
  for (const token of reply.split(/(\s+)/)) {
    if (token) frames.push({ type: "token", delta: token });
  }
  return frames;
}

function buildFinal(event: SessionEvent, state: SessionState): SSEEvent {
  const artifacts: { n: number; type: "file" | "url"; ref: string; label: string }[] = [];
  const visualizations: JsonObject[] = [];
  let n = 1;
  for (const result of state.turnResults(event.turn)) {
    visualizations.push(...(result.visualizations ?? []));
    for (const a of result.artifacts ?? []) {
      artifacts.push({ n: n++, type: a.type, ref: a.ref, label: a.label ?? "" });
    }
  }
  const inputRequest = state.userInputRequestForTurn(event.turn);
  return {
    type: "final",
    sessionId: state.session_id,
    response: event.payload.content as string,
    artifacts,
    visualizations,
    sources: collectTurnSources(state.allEvents(), event.turn),
    ...(inputRequest ? { input_request: inputRequest } : {}),
  };
}

/**
 * Attach an SSE sink to a session's event log: every newly recorded event is
 * projected and written. Status replies (reply final=false) are logged to the
 * terminal here, keeping agents free of side channels. Returns an unsubscribe.
 * (No replay of prior events — one POST = one turn; reconnect replay is out of scope.)
 */
export function attachSse(state: SessionState, write: (frame: SSEEvent) => void): () => void {
  return state.subscribe((event) => {
    for (const frame of projectEvent(event, state)) write(frame);
  });
}
