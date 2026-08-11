import type { CitationSource } from "./citationSources.ts";
export type AgentKind = "market_data" | "market_research" | "trading_operations" | "financial_modeling";

/** The runtime companion to AgentKind, for the places that have to validate a
 *  string that came from a model or from a stored id. */
export const AGENT_KINDS: ReadonlySet<string> = new Set<AgentKind>([
  "market_data",
  "market_research",
  "trading_operations",
  "financial_modeling",
]);

export function isAgentKind(value: string): value is AgentKind {
  return AGENT_KINDS.has(value);
}

export type TaskStatus = "ok" | "failed" | "timeout";

export type SkillStatus = "loaded" | "ok" | "failed";

export type SkillLayer = "topic" | "research" | "agent";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ArtifactRef = {
  type: "file" | "url";
  ref: string;
  label?: string;
};

export type GenerationContext = {
  prompt?: string;
  data: JsonObject;
};

export type UserInputOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

export type UserInputQuestion = {
  id: string;
  header?: string;
  question: string;
  options: UserInputOption[];
  min_selections: number;
  max_selections: number;
};

export type UserInputRequest = {
  request_id: string;
  questions: UserInputQuestion[];
};

export type UserInputAnswer = {
  question_id: string;
  selected_option_ids: string[];
};

export type UserInputResponse = {
  request_id: string;
  answers: UserInputAnswer[];
};

/**
 * Who asked. Three actors can: the Topic agent the user is talking to, the
 * Research controller one layer above it, and the financial_modeling subagent
 * one layer below. Every card is labelled with this, so a question that came
 * from somewhere other than the visible speaker says so.
 *
 * It rides the event payload rather than the event's `source` field: the
 * Research controller is not a `Source` (its runtime records as `orchestrator`),
 * so `source` cannot express all three.
 */
export type UserInputAskedBy = "orchestrator" | "research_controller" | AgentKind;

export type UserInputRequestView = UserInputRequest & {
  status: "pending" | "answered" | "skipped";
  answers?: UserInputAnswer[];
  asked_by: UserInputAskedBy;
};

export type TaskRequest = {
  agent: AgentKind;
  task: string;
  /**
   * Continue an existing subagent thread instead of starting a fresh one. The
   * id names a conversation the caller has already seen come back from a prior
   * dispatch (`<topicId>:<agent>:<n>`); the run picks up that thread's whole
   * history. Absent = open a new thread.
   *
   * Naming a thread that does not exist, or one belonging to a different agent,
   * fails the task rather than silently opening a new one — silently starting
   * over is exactly the continuity loss threads exist to prevent.
   */
  thread?: string;
  /** The financial-model handle to refresh before mutating. Not a resumption
   *  key — continuity is `thread`. */
  model_id?: string;
  tools?: string[];
  timeout_ms?: number;
};

export type TaskResult = {
  task_id: string;
  agent: AgentKind;
  status: TaskStatus;
  summary: string;
  generation_context?: GenerationContext;
  artifacts?: ArtifactRef[];
  /** Structured UI-only chart sources; excluded from model prompt projection. */
  visualizations?: JsonObject[];
  error?: { code: string; message: string };
  metrics?: {
    ms: number;
    tool_calls: number;
    llm_calls?: number;
    tokens_in?: number;
    tokens_out?: number;
  };
};

export type SkillResult = {
  skill: string;
  workflow?: string;
  status: SkillStatus;
  summary: string;
  task_results?: TaskResult[];
  artifacts?: ArtifactRef[];
  error?: { code: string; message: string };
  /** 技能正文。渐进披露的第二级：只在 invoke 之后的轮次进入上下文。 */
  content?: string;
};

export type ToolCategory = "main" | "non_trading" | "trading";

export type JsonSchema = {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  description?: string;
  oneOf?: JsonSchema[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: JsonSchema;
};

export type ToolExecutionResult = {
  summary: string;
  generation_context?: GenerationContext;
  artifacts?: ArtifactRef[];
  /** Structured UI-only chart sources; excluded from generation_context. */
  visualizations?: JsonObject[];
  error?: { code: string; message: string };
  approval?: {
    approval_id: string;
    payload: JsonObject;
  };
  /** Turn-ending request rendered by the client as structured choices. */
  user_input_request?: UserInputRequest;
};

/**
 * One decision the orchestrator emits per loop iteration. `reply` is always the
 * user-facing message for this turn (a short status line when an action is taken,
 * the final answer when all action fields are null). `dispatch` / `skill` /
 * `tool_calls` may share a step; `skill` is exclusive of both.
 */
export type OrchestratorToolCall = { name: string; input: JsonObject };

export type OrchestratorStep = {
  reply: string;
  dispatch: TaskRequest[] | null;
  skill: string | null;
  /** Plural because reading two references should not cost two loop iterations
   *  out of the step budget. A single `tool_call` object is still parsed. */
  tool_calls: OrchestratorToolCall[] | null;
};

export type SSEEvent =
  | { type: "token"; delta: string }
  | { type: "step_reply"; content: string }
  | { type: "workflow_started"; workflow_id: string; skill: string; workflow: string; title?: string }
  | { type: "workflow_step"; workflow_id: string; step_id: string; title: string; status: "pending" | "running" | "done" | "failed"; pct?: number; note?: string }
  | { type: "workflow_done"; workflow_id: string; status: "ok" | "failed"; summary: string }
  | { type: "dispatch"; task_id: string; agent: AgentKind; task: string; thread_id: string }
  | { type: "progress"; task_id: string; phase: string; pct?: number; note?: string }
  | { type: "task_done"; task_id: string; status: TaskStatus; summary: string }
  | { type: "strategy_created"; strategy_id: string; status?: string; summary?: string }
  | { type: "artifact"; task_id: string; artifact: ArtifactRef }
  /** `display` is the producing tool's say in whether this belongs on screen.
   *  Defaults to `focus`; a tool sets `display: "silent"` in its output data
   *  for revisions the user did not ask to watch. */
  | { type: "model_revision"; display: "focus" | "silent";
      model_id: string; revision: number; lifecycle_stage: string;
      changed_sections: string[]; changed_line_item_ids: string[]; changed_period_ids: string[];
      change_kinds: string[] }
  | { type: "approval_required"; approval_id: string; payload: JsonObject }
  | { type: "error"; scope: "main" | "task"; task_id?: string; message: string }
  | { type: "final"; sessionId: string; response: string; artifacts: { n: number; type: "file" | "url"; ref: string; label: string }[]; visualizations: JsonObject[]; sources: CitationSource[]; input_request?: UserInputRequestView }
  | { type: "done"; reason: "complete" | "stopped" | "disconnected" };
