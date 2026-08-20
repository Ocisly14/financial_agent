import { foldUserInputRequest, type SessionEvent } from "../framework/sessionState.ts";
import type { ArtifactRef, JsonObject, UserInputRequestView } from "../framework/types.ts";
import { collectTurnSources, type CitationSource } from "../framework/citationSources.ts";

type ProgressTask = {
  taskId: string;
  description: string;
  status: "completed" | "error";
  agent?: string;
  /** The subagent conversation this round belongs to. Absent on dispatches
   *  recorded before threads existed. Not rendered yet — carried so the client
   *  can group rounds of one thread without a second round trip. */
  threadId?: string;
  summary?: string;
  /** The caller's dispatch when this task came from a nested delegate_to_agent;
   *  absent on orchestrator-rooted dispatches. The topology view draws its edges from this. */
  parentTaskId?: string;
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
      inputRequest?: UserInputRequestView;
    };
  };
  progressTasks?: ProgressTask[];
};

function turnDetails(events: readonly SessionEvent[], turn: number) {
  const artifacts: Array<ArtifactRef & { n: number }> = [];
  const visualizations: JsonObject[] = [];
  const progressTasks: ProgressTask[] = [];
  let inputRequest: UserInputRequestView | undefined;

  const requestEvent = events.find((event) => event.turn === turn && event.kind === "user_input_required");
  if (requestEvent) inputRequest = foldUserInputRequest(requestEvent, events);

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
    if (typeof dispatch.payload.child_thread_id === "string") task.threadId = dispatch.payload.child_thread_id;
    if (typeof dispatch.payload.parent_task_id === "string") task.parentTaskId = dispatch.payload.parent_task_id;
    if (typeof result?.payload.summary === "string") task.summary = result.payload.summary;
    progressTasks.push(task);
  }
  return { artifacts, visualizations, progressTasks, sources: collectTurnSources(events, turn), inputRequest };
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
      // A turn opened by answering an `ask_user` card is not something the user
      // said, and the card already shows what was chosen. Rendering it as a
      // bubble duplicated the card in prose. The event still exists — it opens
      // the turn and `foldUserInputRequest` reads it — it just isn't a message.
      if (event.payload.input_response) continue;
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
          ...(event.payload.final === true && details.inputRequest ? { inputRequest: details.inputRequest } : {}),
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
