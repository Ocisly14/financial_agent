import type { SessionEvent } from "../framework/sessionState.ts";
import type { ArtifactRef, JsonObject } from "../framework/types.ts";
import { collectTurnSources, type CitationSource } from "../framework/citationSources.ts";

type ProgressTask = {
  taskId: string;
  description: string;
  status: "completed" | "error";
  agent?: string;
  summary?: string;
};

export type ChatHistoryMessage = {
  id: string;
  user: "user" | "system";
  userId?: string;
  text: string;
  createdAt: number;
  /** Present when a Research controller sent this message on the user's behalf
   *  rather than the user typing it. The client labels those turns so a reader
   *  months later can tell what they asked from what was asked for them. */
  origin?: { researchId: string; researchName: string };
  source?: "regular_message";
  content?: {
    text: string;
    source: "regular_message";
    metadata?: {
      artifacts: Array<ArtifactRef & { n: number }>;
      visualizations: JsonObject[];
      sources: CitationSource[];
    };
  };
  progressTasks?: ProgressTask[];
};

function turnDetails(events: readonly SessionEvent[], turn: number) {
  const artifacts: Array<ArtifactRef & { n: number }> = [];
  const visualizations: JsonObject[] = [];
  const progressTasks: ProgressTask[] = [];

  for (const dispatch of events) {
    if (dispatch.turn !== turn || dispatch.kind !== "dispatch") continue;
    const result = events.find(
      (event) => event.kind === "task_result" && event.parent_event_id === dispatch.event_id,
    );
    if (result) {
      for (const artifact of (result.payload.artifacts as ArtifactRef[] | undefined) ?? []) {
        artifacts.push({ ...artifact, n: artifacts.length + 1 });
      }
      visualizations.push(...((result.payload.visualizations as JsonObject[] | undefined) ?? []));
    }
    const task: ProgressTask = {
      taskId: dispatch.event_id,
      description: String(dispatch.payload.task ?? ""),
      status: result?.payload.status === "ok" ? "completed" : "error",
    };
    if (typeof dispatch.payload.agent === "string") task.agent = dispatch.payload.agent;
    if (typeof result?.payload.summary === "string") task.summary = result.payload.summary;
    progressTasks.push(task);
  }
  return { artifacts, visualizations, progressTasks, sources: collectTurnSources(events, turn) };
}

function replaceArtifactMarkers(text: string, artifacts: Array<ArtifactRef & { n: number }>): string {
  const byNumber = new Map(artifacts.map((artifact) => [artifact.n, artifact]));
  return text
    .replace(/\{\{artifact:(\d+)\}\}/g, (_match, value: string) => byNumber.get(Number(value))?.label ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Project the append-only agent event log into the message objects rendered by the web client. */
export function projectChatHistory(events: readonly SessionEvent[]): ChatHistoryMessage[] {
  const messages: ChatHistoryMessage[] = [];
  for (const event of events) {
    const createdAt = Date.parse(event.timestamp);
    if (event.kind === "user_message") {
      const origin = event.payload.origin as ChatHistoryMessage["origin"] | undefined;
      messages.push({
        id: event.event_id,
        user: "user",
        text: String(event.payload.content ?? ""),
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        ...(origin?.researchId ? { origin } : {}),
      });
      continue;
    }
    if (event.kind !== "reply") continue;

    const details = turnDetails(events, event.turn);
    const text = event.payload.final === true
      ? replaceArtifactMarkers(String(event.payload.content ?? ""), details.artifacts)
      : String(event.payload.content ?? "");
    const message: ChatHistoryMessage = {
      id: event.event_id,
      user: "system",
      userId: "default",
      text,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      source: "regular_message",
      content: {
        text,
        source: "regular_message",
        metadata: {
          artifacts: details.artifacts,
          visualizations: details.visualizations,
          sources: details.sources,
        },
      },
    };
    if (event.payload.final === true && details.progressTasks.length > 0) {
      message.progressTasks = details.progressTasks;
    }
    messages.push(message);
  }
  return messages;
}
