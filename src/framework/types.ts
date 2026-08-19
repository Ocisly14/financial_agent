import type { CitationSource } from "./citationSources.ts";
/**
 * Every agent in the system, at whatever level it sits. statement_unification and spine_mapping
 * report to financial_modeling rather than to the Topic orchestrator, but they are agents in the
 * same sense as the rest: same runtime, same tool shape, same session events. The hierarchy is who
 * dispatches whom, not what kind of thing they are.
 */
export type AgentKind = "market_data" | "market_research" | "trading_operations" | "financial_modeling"
  | "statement_unification" | "spine_mapping";

/** The runtime companion to AgentKind, for the places that have to validate a
 *  string that came from a model or from a stored id. */
export const AGENT_KINDS: ReadonlySet<string> = new Set<AgentKind>([
  "market_data",
  "market_research",
  "trading_operations",
  "financial_modeling",
  "statement_unification",
  "spine_mapping",
]);

export function isAgentKind(value: string): value is AgentKind {
  return AGENT_KINDS.has(value);
}

export type TaskStatus = "ok" | "failed" | "timeout";

export type SkillStatus = "loaded" | "ok" | "failed";

export type SkillLayer = "topic" | "research" | "agent";

/**
 * How an agent behaves when *another agent* hands it work. Its presence on a
 * definition is the opt-in: an agent without one can only be dispatched by the
 * orchestrator, so nothing becomes reachable from inside a run by accident.
 */
export type DelegationPolicy = {
  /**
   * What the caller gets back. `summary` hands over only the account the agent
   * wrote when it finished; `summary_and_data` also passes its
   * generation_context.
   *
   * `summary` is the one to reach for. A task result's `data` is every tool
   * payload the agent collected — for a research agent that is the full text of
   * every search it ran, which is precisely the cost delegating was supposed to
   * keep out of the caller's context.
   */
  returns: "summary" | "summary_and_data";
  /** Ceiling on one delegated round. Sits inside the caller's own deadline. */
  timeoutMs: number;
};

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
  /**
   * What the user typed into the question's free-text field, trimmed. Every
   * question carries one, so the offered options are never the whole answer
   * space. Present only when non-empty, and when present it counts as one
   * selection against `min_selections`/`max_selections` — an unlisted answer
   * displaces a listed one rather than riding along beside it.
   */
  free_text?: string;
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
  /**
   * Earlier task results whose data this task needs verbatim, named by the
   * `source_event_id` the caller saw on their result lines. The host reads each
   * one's `generation_context.data` out of the log and renders it into the
   * subagent's prompt.
   *
   * This exists because the caller is the only actor holding every result, and
   * retyping numbers out of one result into a task's prose is a transcription
   * step that can silently get them wrong. Passing the id moves the data
   * without a model in the middle of it. What the id CANNOT carry is why that
   * data matters here — that still belongs in `task`.
   */
  source_event_ids?: string[];
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
 * the final answer when all action fields are null). Handing work to an agent is
 * a `delegate_to_agent` entry in `tool_calls`, and loading a skill is an
 * `invoke_skill` entry — the same contracts every agent uses, no fields of
 * their own. invoke_skill is exclusive: alone in its step.
 */
export type OrchestratorToolCall = { name: string; input: JsonObject };

export type OrchestratorStep = {
  reply: string;
  /** Every action is an entry here — delegate_to_agent to hand work to an agent, invoke_skill to
   *  load guidance (alone in its step), the direct tools otherwise. Plural because reading two
   *  references should not cost two loop iterations out of the step budget; a single `tool_call`
   *  object is still parsed. */
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
