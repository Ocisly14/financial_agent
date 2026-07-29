export type AgentKind = "market_data" | "market_research" | "trading_operations";

export type TaskStatus = "ok" | "failed" | "timeout";

export type SkillStatus = "loaded" | "ok" | "failed";

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

export type TaskRequest = {
  agent: AgentKind;
  task: string;
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
};

export type ToolCategory = "main" | "non_trading" | "trading";

export type JsonSchema = {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  description?: string;
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
};

/**
 * One decision the orchestrator emits per loop iteration. `reply` is always the
 * user-facing message for this turn (a short status line when an action is taken,
 * the final answer when all action fields are null). `dispatch` / `skill` /
 * `tool_call` are mutually exclusive — at most one is non-null per step.
 */
export type OrchestratorStep = {
  reply: string;
  dispatch: TaskRequest[] | null;
  skill: string | null;
  tool_call: { name: string; input: JsonObject } | null;
};

export type SSEEvent =
  | { type: "token"; delta: string }
  | { type: "step_reply"; content: string }
  | { type: "workflow_started"; workflow_id: string; skill: string; workflow: string; title?: string }
  | { type: "workflow_step"; workflow_id: string; step_id: string; title: string; status: "pending" | "running" | "done" | "failed"; pct?: number; note?: string }
  | { type: "workflow_done"; workflow_id: string; status: "ok" | "failed"; summary: string }
  | { type: "dispatch"; task_id: string; agent: AgentKind; task: string }
  | { type: "progress"; task_id: string; phase: string; pct?: number; note?: string }
  | { type: "task_done"; task_id: string; status: TaskStatus; summary: string }
  | { type: "strategy_created"; strategy_id: string; status?: string; summary?: string }
  | { type: "artifact"; task_id: string; artifact: ArtifactRef }
  | { type: "approval_required"; approval_id: string; payload: JsonObject }
  | { type: "error"; scope: "main" | "task"; task_id?: string; message: string }
  | { type: "final"; sessionId: string; response: string; artifacts: { n: number; type: "file" | "url"; ref: string; label: string }[]; visualizations: JsonObject[] }
  | { type: "done"; reason: "complete" | "stopped" | "disconnected" };
