import type { ModelClass, ModelRouter } from "../infra/llm/provider.ts";
import { PromptRenderer, type PromptTemplate } from "./prompt.ts";
import type { AgentKind, JsonObject, JsonSchema, TaskRequest, TaskResult, ToolDefinition } from "./types.ts";
import type { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import { newId } from "./ids.ts";
import type { SessionState } from "./sessionState.ts";
import { createLogger } from "../infra/logger/logger.ts";

const log = createLogger("subagent");

/** Max tool-calling iterations per subagent task — a runaway-loop backstop. */
const MAX_TOOL_STEPS = 5;
const APPROVAL_WAIT_MS = 15 * 60_000;

export type SubagentDefinition = {
  name: AgentKind;
  description: string;
  modelClass: ModelClass;
  defaultTools: string[];
  systemPrompt: PromptTemplate;
};

export class SubagentRegistry {
  private readonly definitions = new Map<AgentKind, SubagentDefinition>();

  register(definition: SubagentDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`duplicate subagent registered: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  get(name: AgentKind): SubagentDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`subagent not found: ${name}`);
    return definition;
  }

  list(): SubagentDefinition[] {
    return [...this.definitions.values()];
  }
}

/** Extract the first balanced JSON object from a possibly-noisy LLM string. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

type ToolCall = { tool: string; input: JsonObject };
type SubagentStep =
  | { action: "call_tool"; calls: ToolCall[] }
  | { action: "finish"; summary: string };

function toToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const tool = typeof o.tool === "string" ? o.tool.trim() : "";
  if (!tool) return null;
  const input = o.input && typeof o.input === "object" ? (o.input as JsonObject) : {};
  return { tool, input };
}

/**
 * Parse one subagent loop completion into an action. Accepts `calls: [{tool,input}]`
 * (one or more INDEPENDENT tools to run in parallel) or the single `{tool,input}`
 * shorthand. Falls back to `finish` on any parse failure so the loop always
 * terminates gracefully.
 */
function parseSubagentStep(text: string): SubagentStep {
  const json = extractJsonObject(text);
  const finish = (summary = ""): SubagentStep => ({ action: "finish", summary });
  if (!json) return finish(text.trim());
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return finish(text.trim());
  }
  if (Array.isArray(raw.calls)) {
    const calls = raw.calls.map(toToolCall).filter((c): c is ToolCall => c !== null);
    if (calls.length > 0) return { action: "call_tool", calls };
  }
  const single = toToolCall(raw);
  if (single && raw.action !== "finish") return { action: "call_tool", calls: [single] };
  return finish(typeof raw.summary === "string" ? raw.summary.trim() : "");
}

/** A leaf type label: enum values when present, else the JSON type (or array element type). */
function typeLabel(s: JsonSchema): string {
  if (s.enum && s.enum.length > 0) return s.enum.join("|");
  if (s.type === "array") {
    const it = s.items;
    if (it?.enum && it.enum.length > 0) return `array of ${it.enum.join("|")}`;
    return `array of ${it?.type ?? "any"}`;
  }
  return s.type || "any";
}

/** Recursively render an object schema's fields as an indented, token-light tree (* = required). */
function renderSchemaFields(s: JsonSchema, indent: string, lines: string[], depth: number): void {
  if (depth > 6 || s.type !== "object" || !s.properties) return;
  const required = new Set(s.required ?? []);
  for (const [key, child] of Object.entries(s.properties)) {
    const mark = required.has(key) ? "*" : "";
    const desc = child.description ? `  — ${child.description}` : "";
    lines.push(`${indent}${key}${mark}: ${typeLabel(child)}${desc}`);
    if (child.type === "object" && child.properties) {
      renderSchemaFields(child, indent + "  ", lines, depth + 1);
    } else if (child.type === "array" && child.items?.type === "object" && child.items.properties) {
      renderSchemaFields(child.items, indent + "  ", lines, depth + 1);
    }
  }
}

/** Render a tool's argument schema (excluding the auto-supplied `task`) as a structured block. */
function formatToolArgs(schema: JsonSchema | undefined): string {
  if (!schema?.properties) return "";
  const visible = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => k !== "task"));
  if (Object.keys(visible).length === 0) return "";
  const node: JsonSchema = { type: "object", properties: visible };
  if (schema.required) node.required = schema.required;
  const lines: string[] = [];
  renderSchemaFields(node, "      ", lines, 0);
  return lines.length > 0 ? `\n    args (* = required):\n${lines.join("\n")}` : "";
}

/** Render the allowed-tool list with their structured arg schemas for the prompt. */
export function formatAllowedTools(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "None";
  return tools.map((tool) => `- ${tool.name}: ${tool.description}${formatToolArgs(tool.inputSchema)}`).join("\n");
}

function normalizeToolError(output: { summary: string; error?: { code: string; message: string } }): { code: string; message: string } | undefined {
  if (output.error) return output.error;
  const summary = output.summary.trim();
  if (/^(.*\bfailed\b|failed\b|.*\berror\b|error\b|missing\b|invalid\b|unable\b|no token found\b)/i.test(summary)) {
    return { code: "tool_failed", message: summary };
  }
  return undefined;
}

export type RunSubagentInput = {
  sessionId: string;
  taskId: string;
  request: TaskRequest;
  allowedTools: ToolDefinition[];
  state: SessionState;       // the session event log — subagent records its internal trace here
  parentEventId: string;     // the dispatch event this task hangs off (parent for sidechain events)
};

export class SubagentRuntime {
  private readonly renderer = new PromptRenderer();
  private readonly modelRouter: ModelRouter;
  private readonly toolRegistry: McpToolRegistry;

  constructor(
    modelRouter: ModelRouter,
    toolRegistry: McpToolRegistry,
  ) {
    this.modelRouter = modelRouter;
    this.toolRegistry = toolRegistry;
  }

  /**
   * Run the subagent's tool-calling loop and WRITE its own task_result to the
   * session event log. Returns nothing — the subagent interacts only with state.
   * Internal tool_use/tool_result are recorded as sidechain events. (Timeout /
   * subagent-throw is handled by the dispatcher, which writes the failure result.)
   */
  async run(definition: SubagentDefinition, input: RunSubagentInput): Promise<void> {
    const started = Date.now();
    const { state, parentEventId } = input;
    const allowed = new Map(input.allowedTools.map((tool) => [tool.name, tool]));
    const toolsBlock = formatAllowedTools(input.allowedTools);
    let finishSummary = "";
    let llmCalls = 0;
    let awaitingApproval = false;
    let pendingApprovalId: string | undefined;

    log.info(`[${definition.name}] start task`, { task: input.request.task, taskId: input.taskId });

    for (let step = 1; step <= MAX_TOOL_STEPS; step++) {
      // Loop context is read back from the log: the subagent sees its own prior
      // tool results (state) and decides whether to call another tool or finish.
      const rendered = this.renderer.render(definition.systemPrompt, {
        task: input.request.task,
        allowedTools: toolsBlock,
        progress: state.subagentProgress(parentEventId),
      });

      let completionText: string;
      try {
        const completion = await this.modelRouter.generate(
          [
            { role: "system", content: rendered.system },
            { role: "user", content: rendered.prompt },
          ],
          { modelClass: definition.modelClass, temperature: 0.1, metadata: { mode: "subagent", agent: definition.name } },
        );
        completionText = completion.text;
        llmCalls++;
      } catch (error) {
        log.error(`[${definition.name}] LLM call failed at step ${step}`, { error: error instanceof Error ? error.message : String(error) });
        break;
      }

      const stepObj = parseSubagentStep(completionText);
      if (stepObj.action === "finish") {
        log.info(`[${definition.name}] finish at step ${step}`, { summary: stepObj.summary });
        finishSummary = stepObj.summary;
        break;
      }

      log.info(`[${definition.name}] step ${step} — calling tools`, { tools: stepObj.calls.map((c) => c.tool) });

      // Run this step's tool calls in parallel — they are independent (any tool
      // whose choice depends on a prior result is issued in a later iteration).
      const toolResults = await Promise.all(stepObj.calls.map((call) => this.runToolCall(definition, input, call, allowed)));
      awaitingApproval = awaitingApproval || toolResults.some((result) => result.awaitingApproval);
      pendingApprovalId = toolResults.find((result) => result.approvalId)?.approvalId ?? pendingApprovalId;
      if (awaitingApproval) {
        log.info(`[${definition.name}] awaiting approval`, { taskId: input.taskId });
        break;
      }
    }

    if (awaitingApproval) {
      const resolved = await waitForTaskResult(state, parentEventId, APPROVAL_WAIT_MS);
      if (!resolved) {
        if (pendingApprovalId) {
          state.record(
            definition.name,
            "approval_resolved",
            { approval_id: pendingApprovalId, decision: "timeout" },
            { parent: parentEventId },
          );
        }
        state.recordTaskResult(definition.name, parentEventId, {
          task_id: parentEventId,
          agent: definition.name,
          status: "timeout",
          summary: "Timed out waiting for user approval. No order was submitted.",
          error: { code: "approval_timeout", message: "Timed out waiting for user approval. No order was submitted." },
        });
      }
      return;
    }

    // Assemble the task_result from the tool outputs read back from the log.
    const outputs = state.subagentToolOutputs(parentEventId);
    const toolErrors = state.subagentToolErrors(parentEventId);
    const generationContexts = outputs.map((o) => o.generation_context).filter((c): c is NonNullable<typeof c> => Boolean(c));
    const firstToolError = toolErrors[0];
    const result: TaskResult = {
      task_id: parentEventId,
      agent: definition.name,
      status: firstToolError ? "failed" : "ok",
      summary: firstToolError?.message ?? (finishSummary || `${definition.name} completed task.`),
      artifacts: outputs.flatMap((o) => o.artifacts ?? []),
      visualizations: outputs.flatMap((o) => o.visualizations ?? []),
      metrics: { ms: Date.now() - started, tool_calls: outputs.length + toolErrors.length, llm_calls: llmCalls },
    };
    if (firstToolError) {
      result.error = { code: firstToolError.code, message: firstToolError.message };
    }

    log.info(`[${definition.name}] done`, { ms: Date.now() - started, tool_calls: outputs.length, llm_calls: llmCalls });
    if (generationContexts.length > 0) {
      const prompts = [...new Set(generationContexts.map((context) => context.prompt?.trim()).filter((prompt): prompt is string => Boolean(prompt)))];
      result.generation_context = {
        data: {
          task: input.request.task,
          tool_outputs: outputs.map((o) => ({ tool: o.name, summary: o.summary, data: o.generation_context?.data ?? {} })),
        },
      };
      if (prompts.length > 0) result.generation_context.prompt = prompts.join("\n\n");
    }
    state.recordTaskResult(definition.name, parentEventId, result);
  }

  /** Execute one tool call and record its tool_use/tool_result (and any approval)
   *  as sidechain events. Used in parallel for a step's independent calls. */
  private async runToolCall(
    definition: SubagentDefinition,
    input: RunSubagentInput,
    call: ToolCall,
    allowed: Map<string, ToolDefinition>,
  ): Promise<{ awaitingApproval: boolean; approvalId?: string }> {
    const { state, parentEventId } = input;
    const tool = allowed.get(call.tool);
    if (!tool) {
      log.warn(`[${definition.name}] invalid tool requested: ${call.tool}`);
      // Record the invalid choice so the next iteration sees it.
      state.record(
        definition.name,
        "tool_result",
        { task_id: parentEventId, name: call.tool, error: { code: "invalid_tool", message: `"${call.tool}" is not an allowed tool — choose from the allowed list or finish.` } },
        { isSidechain: true, parent: parentEventId },
      );
      return { awaitingApproval: false };
    }

    const callInput: JsonObject = { task: input.request.task, ...call.input };
    const toolUseId = newId("tooluse");
    const useEv = state.record(
      definition.name,
      "tool_use",
      { tool_use_id: toolUseId, task_id: parentEventId, name: tool.name, input: callInput },
      { isSidechain: true, parent: parentEventId },
    );

    log.info(`[${definition.name}] tool call: ${tool.name}`, { input: call.input });

    let output: Awaited<ReturnType<McpToolRegistry["call"]>>;
    try {
      output = await this.toolRegistry.call(tool.name, callInput, { sessionId: input.sessionId, taskId: input.taskId });
    } catch (error) {
      log.error(`[${definition.name}] tool error: ${tool.name}`, { error: error instanceof Error ? error.message : String(error) });
      state.record(
        definition.name,
        "tool_result",
        { tool_use_id: toolUseId, task_id: parentEventId, name: tool.name, error: { code: "tool_error", message: error instanceof Error ? error.message : String(error) } },
        { isSidechain: true, parent: useEv.event_id },
      );
      return { awaitingApproval: false };
    }

    log.info(`[${definition.name}] tool result: ${tool.name}`, { summary: output.summary });

    const normalizedError = normalizeToolError(output);
    const toolResultPayload: JsonObject = { tool_use_id: toolUseId, task_id: parentEventId, name: tool.name, summary: output.summary };
    if (output.generation_context) toolResultPayload.generation_context = output.generation_context as unknown as JsonObject;
    if (normalizedError) toolResultPayload.error = normalizedError;
    if (output.artifacts?.length) toolResultPayload.artifacts = output.artifacts as unknown as JsonObject[string];
    if (output.visualizations?.length) toolResultPayload.visualizations = output.visualizations;
    state.record(definition.name, "tool_result", toolResultPayload, { isSidechain: true, parent: useEv.event_id });

    if (output.approval) {
      log.info(`[${definition.name}] approval required`, { approval_id: output.approval.approval_id });
      // Approval state lives in the log: approval_required with no matching
      // approval_resolved (within TTL) is pending. No separate store.
      state.record(
        definition.name,
        "approval_required",
        { approval_id: output.approval.approval_id, payload: output.approval.payload },
        { parent: parentEventId },
      );
      return { awaitingApproval: true, approvalId: output.approval.approval_id };
    }

    return { awaitingApproval: false };
  }
}

function waitForTaskResult(state: SessionState, dispatchEventId: string, timeoutMs: number): Promise<boolean> {
  if (state.task(dispatchEventId)?.result) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (resolved: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(resolved);
    };
    const unsubscribe = state.subscribe((event) => {
      if (event.kind === "task_result" && event.parent_event_id === dispatchEventId) {
        finish(true);
      }
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
