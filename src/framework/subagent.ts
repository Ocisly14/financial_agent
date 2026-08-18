import type { LlmMessage, LlmToolCall, LlmToolSpec, ModelClass, ModelRouter } from "../infra/llm/provider.ts";
import { PromptRenderer, type PromptTemplate } from "./prompt.ts";
import type { AgentKind, JsonObject, JsonSchema, JsonValue, TaskRequest, TaskResult, ToolDefinition, UserInputRequest } from "./types.ts";
import type { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import { newId } from "./ids.ts";
import type { SessionState } from "./sessionState.ts";
import type { SkillRegistry } from "./skill.ts";
import { INVOKE_SKILL } from "./skillTools.ts";
import { assertToolAllowedForAgent } from "./toolAccess.ts";
import { maybeCompactThread } from "./contextCompaction.ts";
import { createLogger } from "../infra/logger/logger.ts";

const log = createLogger("subagent");

/** Max tool-calling iterations per subagent task — a runaway-loop backstop. */
const DEFAULT_MAX_TOOL_STEPS = 5;
const APPROVAL_WAIT_MS = 15 * 60_000;

export type SubagentDefinition = {
  name: AgentKind;
  description: string;
  modelClass: ModelClass;
  defaultTools: string[];
  /**
   * agent 层技能的名字。归属声明在这里而不是技能的 frontmatter 里，理由和
   * defaultTools 一样：一个 agent 能用什么，应该在注册表一处看全，而不是散到
   * skills/ 目录里反查谁认领了它。
   */
  skills?: string[];
  systemPrompt: PromptTemplate;
  maxToolSteps?: number;
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

type ToolCall = { id: string; tool: string; input: JsonObject };
type SubagentStep =
  | { action: "call_tool"; calls: ToolCall[] }
  | { action: "finish"; summary: string };

function toToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const tool = typeof o.tool === "string" ? o.tool.trim() : "";
  if (!tool) return null;
  const input = o.input && typeof o.input === "object" ? (o.input as JsonObject) : {};
  return { id: newId("toolcall"), tool, input };
}

/**
 * Parse one subagent loop completion into an action. Accepts `calls: [{tool,input}]`
 * (one or more INDEPENDENT tools to run in parallel) or the single `{tool,input}`
 * shorthand. Falls back to `finish` on any parse failure so the loop always
 * terminates gracefully.
 */
export function parseSubagentStep(text: string): SubagentStep {
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
  if (s.oneOf?.length) {
    s.oneOf.forEach((variant, index) => {
      lines.push(`${indent}variant ${index + 1}:`);
      renderSchemaFields(variant, indent + "  ", lines, depth + 1);
    });
    return;
  }
  if (depth > 6 || s.type !== "object" || !s.properties) return;
  const required = new Set(s.required ?? []);
  for (const [key, child] of Object.entries(s.properties)) {
    const mark = required.has(key) ? "*" : "";
    const desc = child.description ? `  — ${child.description}` : "";
    lines.push(`${indent}${key}${mark}: ${typeLabel(child)}${desc}`);
    if (child.type === "object" && (child.properties || child.oneOf)) {
      renderSchemaFields(child, indent + "  ", lines, depth + 1);
    } else if (child.type === "array" && child.items?.type === "object" && (child.items.properties || child.items.oneOf)) {
      renderSchemaFields(child.items, indent + "  ", lines, depth + 1);
    }
  }
}

/** Render a tool's argument schema as a structured block. `task` is filtered as a
 *  guard: no tool declares it any more, and none should — it was a framework-injected
 *  parameter that no `execute` ever read. */
function formatToolArgs(schema: JsonSchema | undefined): string {
  if (!schema) return "";
  if (schema.oneOf?.length) {
    const lines: string[] = [];
    renderSchemaFields(schema, "      ", lines, 0);
    return lines.length > 0 ? `\n    input fields (* = required):\n${lines.join("\n")}` : "";
  }
  if (!schema.properties) return "";
  const visible = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => k !== "task"));
  if (Object.keys(visible).length === 0) return "";
  const node: JsonSchema = { type: "object", properties: visible };
  if (schema.required) node.required = schema.required;
  const lines: string[] = [];
  renderSchemaFields(node, "      ", lines, 0);
  return lines.length > 0 ? `\n    input fields (* = required):\n${lines.join("\n")}` : "";
}

/** Render the allowed-tool list with their structured arg schemas for the prompt. */
/** The explicit finish tool: with native function calling the model ends the
 * loop by calling this, so the summary arrives as a schema-required argument
 * instead of free text — an empty-summary "finish" cannot exist on this path. */
const FINISH_TOOL: LlmToolSpec = {
  name: "finish",
  description: "Finish the task. Call this when the task is satisfied (or no available tool fits) — never alongside other tool calls.",
  inputSchema: {
    type: "object",
    required: ["summary"],
    properties: {
      summary: { type: "string", description: "What you accomplished and, for model work, the model_id so a later task can resume. Must not be empty." },
    },
  },
};

/** Tool specs handed to the provider for native function calling: every allowed
 * tool plus the explicit finish tool. */
export function buildLoopToolSpecs(tools: ToolDefinition[]): LlmToolSpec[] {
  return [
    ...tools.map((tool): LlmToolSpec => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as unknown as JsonObject,
    })),
    FINISH_TOOL,
  ];
}

/** 每步的请求前缀(tools + system + task)在 dispatch 内一字不变,只有
 * [PROGRESS SO FAR] 之后在长。在 marker 处切开并打 cache 标记,provider 就能
 * 把静态前缀走缓存读,每步只为动态尾部付全价。marker 缺失时退化为整段发送。 */
const PROGRESS_MARKER = "[PROGRESS SO FAR]";

/**
 * Below this, a third breakpoint is not worth its own cache write: providers bill a write above the
 * read they save, and they round a cached prefix down to their own block size, so a short one can
 * cost more than it returns.
 */
const MIN_ROLLING_CACHE_CHARS = 4000;

/**
 * How much of `progress` the previous step already sent, byte for byte. A provider matches a cached
 * prefix by bytes, so this is the only honest place to cut — whatever the projection's shape, this
 * finds however much of it happens to have held still.
 */
function commonPrefixLength(current: string, previous: string): number {
  const limit = Math.min(current.length, previous.length);
  let index = 0;
  while (index < limit && current.charCodeAt(index) === previous.charCodeAt(index)) index += 1;
  return index;
}

/** What a step has to remember for the next one: the region it sent, and where it cut it. */
export type ProgressCache = { progress: string; cuts: readonly number[] };

/**
 * The progress region holds everything the run has learned — tens of thousands of characters of
 * playbook text among them — and re-sending it at full price every step is most of what a long
 * dispatch costs. So it is cut into blocks and the newest boundaries carry cache breakpoints.
 *
 * The cuts are APPEND-ONLY, and that is the load-bearing part. Cutting at a freshly computed offset
 * every step shipped once, and it was worse than no caching at all: the block that ended at the
 * previous step's boundary was no longer sent as its own block, nothing matched, and every step
 * wrote a fresh full-region entry it never read back — moving 39k tokens from the 1.0x full price
 * to the 1.25x write price. A cut, once made, therefore stays a cut; a step only adds a new one
 * after it, and only once enough has accrued to be worth its own write.
 */
export function splitForPromptCache(system: string, prompt: string, previous?: ProgressCache):
{ messages: LlmMessage[]; cuts: number[] } {
  const index = prompt.indexOf(PROGRESS_MARKER);
  if (index <= 0) {
    return { messages: [{ role: "system", content: system, cache: true }, { role: "user", content: prompt }], cuts: [] };
  }
  const head = { role: "system" as const, content: system, cache: true };
  const staticPrefix = { role: "user" as const, content: prompt.slice(0, index), cache: true };
  const progress = prompt.slice(index);

  const shared = previous === undefined ? 0 : commonPrefixLength(progress, previous.progress);
  // A cut past the shared prefix names an offset whose block content has since changed, so its
  // entry is unreachable however we slice this request — drop it rather than carry it forward.
  const kept = (previous?.cuts ?? []).filter((cut) => cut <= shared);
  const newest = kept[kept.length - 1] ?? 0;
  const cuts = shared - newest >= MIN_ROLLING_CACHE_CHARS ? [...kept, shared] : [...kept];
  if (cuts.length === 0) return { messages: [head, staticPrefix, { role: "user", content: progress }], cuts };

  const blocks: LlmMessage[] = [];
  let start = 0;
  for (const cut of cuts) {
    blocks.push({ role: "user", content: progress.slice(start, cut) });
    start = cut;
  }
  // An empty trailing block is not a text block a provider will accept, so a step whose region is
  // byte-identical to the last one ends on its final cut instead.
  const tail = progress.slice(start);
  if (tail.length > 0) blocks.push({ role: "user", content: tail });

  // Anthropic allows four breakpoints and system + static prefix take two. Spend the rest on the
  // two newest cuts: the older of them is what the previous step wrote and this one reads back,
  // the newer is what this step writes for the next.
  const atACut = tail.length > 0 ? blocks.length - 1 : blocks.length;
  for (let i = Math.max(0, atACut - 2); i < atACut; i += 1) blocks[i]!.cache = true;
  return { messages: [head, staticPrefix, ...blocks], cuts };
}

/** The progress region of a rendered prompt, or undefined when it carries none. */
export function progressRegion(prompt: string): string | undefined {
  const index = prompt.indexOf(PROGRESS_MARKER);
  return index <= 0 ? undefined : prompt.slice(index);
}

/** Map a native tool-call answer onto the loop's step shape. finish only counts
 * when it is the sole call; mixed in with real calls it is dropped so the work
 * runs and the model gets another chance to finish cleanly next step. */
export function stepFromToolCalls(calls: LlmToolCall[]): SubagentStep {
  const finish = calls.find((call) => call.name === FINISH_TOOL.name);
  if (finish && calls.every((call) => call.name === FINISH_TOOL.name)) {
    const summary = typeof finish.input["summary"] === "string" ? finish.input["summary"].trim() : "";
    return { action: "finish", summary };
  }
  const toolCalls = calls
    .filter((call) => call.name !== FINISH_TOOL.name)
    .map((call): ToolCall => ({ id: call.id ?? newId("toolcall"), tool: call.name, input: call.input }));
  return { action: "call_tool", calls: toolCalls };
}

/** Render tools as prompt text. The subagent loop no longer uses this — the tools
 *  reach the model as native specs (buildLoopToolSpecs), of which this rendering is
 *  a strictly lossier copy. Kept for the eval harnesses that prompt without tools. */
export function formatAllowedTools(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "None";
  return tools.map((tool) => `- ${tool.name}: ${tool.description}${formatToolArgs(tool.inputSchema)}`).join("\n");
}

/**
 * A tool declares failure with its `error` field, and nothing else counts.
 *
 * This used to also sniff the summary for "failed", "error", "missing" and friends, on the theory
 * that a tool might report trouble in prose alone. No tool ever did — but plenty report a standing
 * condition in a summary that succeeded, and those were reclassified as failures. The reference case
 * is `get_financial_model`: "Loaded financial model fm_X revision 7 (draft); required DCF
 * reconciliation checks failed." is a successful read whose last clause names what still blocks the
 * lifecycle. Marked as an error, it was then dropped by `subagentToolOutputs` — which skips errored
 * results — so the overview the agent had just asked for never reached its context. It read again,
 * and again: ten identical reads in one AMZN run, ~580KB of answers discarded before delivery.
 *
 * Guessing was never the more reliable signal, only the more eager one.
 */
function normalizeToolError(output: { summary: string; error?: { code: string; message: string } }): { code: string; message: string } | undefined {
  return output.error;
}

/** Keep the provider-visible result identical to the structured evidence the next prompt renders,
 * while retaining the native call id required by OpenAI, Anthropic, and Gemini tool protocols. */
function nativeToolResult(call: ToolCall, toolName: string, data: unknown, isError: boolean): LlmMessage {
  let content: string;
  try { content = JSON.stringify(data); }
  catch { content = JSON.stringify({ summary: "tool returned unserializable data" }); }
  return { role: "tool", content, toolCallId: call.id, toolName, ...(isError ? { toolResultIsError: true } : {}) };
}

export type RunSubagentInput = {
  sessionId: string;
  agentId: string;
  /** The dispatch this run answers — where its task_result is written. */
  taskId: string;
  request: TaskRequest;
  /**
   * Earlier results' data, already resolved from `request.source_event_ids` and
   * rendered as the block that sits above [PROGRESS SO FAR]. Empty for a task
   * that was handed nothing — and then the prompt is byte-identical to one
   * built before handoffs existed, which is what keeps the cached prefix of
   * every ordinary dispatch intact.
   */
  handedData?: string;
  allowedTools: ToolDefinition[];
  /** Cancels every provider request in this run when the caller's overall deadline expires. */
  signal?: AbortSignal;
  /**
   * Tools scoped to this run, resolved before the shared registry. The DCF mapping agents need it:
   * their tools close over the model they were pinned to and the decision they have submitted so
   * far, so they cannot live in a process-wide registry two concurrent runs would share.
   */
  toolRegistry?: McpToolRegistry;
  state: SessionState;       // the session event log — subagent records its internal trace here
  /**
   * The conversation this run belongs to. Every event the agent writes is
   * stamped with it, and [PROGRESS SO FAR] is projected from it — so a second
   * dispatch naming the same thread comes back to its own notes and tool
   * results instead of re-deriving them from the model alone.
   *
   * A thread outlives any one dispatch: `taskId` says which round this is,
   * `threadId` says which conversation the rounds belong to.
   */
  threadId: string;
};

export class SubagentRuntime {
  private readonly renderer = new PromptRenderer();
  private readonly modelRouter: ModelRouter;
  private readonly toolRegistry: McpToolRegistry;
  private readonly skills: SkillRegistry | undefined;

  constructor(
    modelRouter: ModelRouter,
    toolRegistry: McpToolRegistry,
    /** Absent in harnesses that prompt without skills; the roster then renders as "(none)". */
    skills?: SkillRegistry,
  ) {
    this.modelRouter = modelRouter;
    this.toolRegistry = toolRegistry;
    this.skills = skills;
  }

  /** The agent's own skill roster, rendered for its prompt. Names come from the
   *  subagent registry, descriptions from the skill files. */
  private renderSkillRoster(definition: SubagentDefinition): string {
    const names = definition.skills ?? [];
    if (names.length === 0 || !this.skills) return "(none)";
    const lines = names.flatMap((name) => {
      const skill = this.skills!.get(name, "agent");
      return skill ? [`- ${skill.name}: ${skill.description}`] : [];
    });
    return lines.length ? lines.join("\n") : "(none)";
  }

  /**
   * Fold the tools an invoked skill declares into the live set, so the agent can
   * call them from its next step. A name that is unregistered, or that the
   * category gate refuses for this agent, is skipped with a warning rather than
   * failing the task: a skill over-declaring one tool should not cost a DCF its
   * whole round.
   */
  private grantSkillTools(definition: SubagentDefinition, granted: unknown, allowed: Map<string, ToolDefinition>): void {
    if (!Array.isArray(granted)) return;
    for (const name of granted) {
      if (typeof name !== "string" || allowed.has(name)) continue;
      const tool = this.toolRegistry.get(name);
      if (!tool) {
        log.warn(`[${definition.name}] skill grants unregistered tool: ${name}`);
        continue;
      }
      try {
        assertToolAllowedForAgent(definition.name, name, tool.category);
      } catch (error) {
        log.warn(`[${definition.name}] skill grant refused by category gate: ${name}`,
          { error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const { execute: _execute, ...spec } = tool;
      allowed.set(name, spec);
      log.info(`[${definition.name}] skill granted tool: ${name}`);
    }
  }

  /**
   * Run the subagent's tool-calling loop and WRITE its own task_result to the
   * session event log. The result is also RETURNED, for the hosts that drive an
   * agent directly rather than through the dispatcher: the DCF mapping agents
   * report to their caller through the summary the agent wrote at finish, and
   * reading it back out of the log by taskId would be the same value at more
   * cost. Callers that only care about the log may ignore it.
   * Internal tool_use/tool_result go on the agent's own thread. (Timeout /
   * subagent-throw is handled by the dispatcher, which writes the failure result.)
   */
  async run(definition: SubagentDefinition, input: RunSubagentInput): Promise<TaskResult | undefined> {
    const started = Date.now();
    const { state, threadId } = input;
    // Live, not a snapshot: invoke_skill folds the skill's declared tools in here
    // and the next step's specs are built from it.
    const allowed = new Map(input.allowedTools.map((tool) => [tool.name, tool]));
    const skillRoster = this.renderSkillRoster(definition);
    let finishSummary = "";
    let llmCalls = 0;
    let awaitingApproval = false;
    let pendingApprovalId: string | undefined;
    let recoveredRevisionConflict = false;
    let pendingUserInput: UserInputRequest | undefined;

    log.info(`[${definition.name}] start task`, { task: input.request.task, taskId: input.taskId, threadId });

    // A thread the agent has already worked in: mark the seam. Without it the
    // notes read as one run whose step counter inexplicably restarts, and work
    // it already finished looks like work still to do.
    const priorRounds = state.subagentNotes({ thread: threadId }).length > 0;
    if (priorRounds) {
      const answered = state.threadPausedOnQuestion(threadId, input.taskId);
      state.record(definition.name, "subagent_note", { task_id: input.taskId, step: 0,
        note: answered
          ? "[resumed] The user has answered the question above — their decision is in the task text. "
            + "Everything before this line is your own work from before the question; do not redo it and do not ask again. Step numbering restarts here."
          : `[new round] The orchestrator dispatched a follow-up task in this same thread: "${input.request.task}". `
            + "Everything before this line is your own earlier work here; do not redo it. Step numbering restarts here." },
      { threadId, parent: input.taskId });
    }

    // A thread that has run for many rounds can out-grow the prompt on its own.
    // Fold its older rounds before rendering, so continuity costs bounded
    // context rather than unbounded.
    await maybeCompactThread(state, this.modelRouter, definition.name, threadId, input.taskId);

    if (definition.name === "financial_modeling" && input.request.model_id && allowed.has("get_financial_model")) {
      await this.runToolCall(definition, input, { id: newId("toolcall"), tool: "get_financial_model", input: { modelId: input.request.model_id } }, allowed);
    }

    const maxToolSteps = definition.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS;
    let exhausted = true;
    /** Set only by the provider call below, which is the one failure that ends the loop outright. */
    let llmFailure: { code: string; message: string } | undefined;
    /** Last step's progress region and the cuts it made in it, so this step can re-send those blocks
     *  byte-identically — which is what makes the entry the last step wrote readable now. */
    let previousCache: ProgressCache | undefined;
    /** The immediately preceding native tool exchange. It is appended after the rendered evidence
     * so providers can associate a result with the call that caused it. */
    let nativeToolTranscript: LlmMessage[] = [];
    for (let step = 1; step <= maxToolSteps; step++) {
      // Compact only completed earlier rounds before every prompt. The current
      // dispatch remains verbatim, even if it is itself large.
      await maybeCompactThread(state, this.modelRouter, definition.name, threadId, input.taskId);
      // Loop context is read back from the log: the subagent sees its own prior
      // tool results (state) and decides whether to call another tool or finish.
      const rendered = this.renderer.render(definition.systemPrompt, {
        task: input.request.task,
        skills: skillRoster,
        // Constant for the whole run — resolved once at dispatch, above the
        // progress region and never rewritten, so it costs one cache write and
        // is read back on every step after it.
        handedData: input.handedData ?? "",
        modelContext: input.request.model_id
          ? `The user is currently viewing model ${input.request.model_id}. Prefer continuing it: refresh it before any mutation and keep your work in that model unless the task or evidence gives a concrete reason to select or create another model.`
          : "No existing model handle was supplied.",
        // The step counter belongs BELOW the progress region, never inside it. It changes every
        // step, and a provider matches a cached prefix by bytes — at the head of the region it
        // moved the divergence point to the first digit and made the rolling breakpoint unreachable.
        // Everything that changes on every step lives here, below {{progress}} — never inside it.
        // The live revision belongs to this slot for the same reason the step counter does: it moves
        // whenever the agent writes, and inside the region it would split the projection at whatever
        // offset it happened to sit. The agent still needs it (a mutation must state the revision it
        // is based on), so it is stated here, where being volatile costs nothing.
        stepBudget: ((): string => {
          const budget = `(you are at step ${step} of your ${maxToolSteps}-step budget)`;
          if (definition.name !== "financial_modeling") return budget;
          const live = latestFinancialModelState(state.subagentToolOutputs({ thread: threadId }));
          if (live.revision === undefined && live.model_id === undefined) return budget;
          const stamp = [
            ...(live.model_id === undefined ? [] : [`model ${live.model_id}`]),
            ...(live.revision === undefined ? [] : [`revision ${live.revision}`]),
            ...(live.lifecycle_stage === undefined ? [] : [`stage ${live.lifecycle_stage}`]),
          ].join(", ");
          return `[LIVE MODEL STATE] ${stamp} — this is the current revision; base your next mutation on it.\n${budget}`;
        })(),
        progress: (definition.name === "financial_modeling"
          // Thread scope, not task scope: continuing a thread means the agent
          // comes back to everything it has done here, not just this round.
          ? projectFinancialModelProgress(state.subagentToolOutputs({ thread: threadId }), state.subagentToolErrors({ thread: threadId }),
            state.subagentNotes({ thread: threadId }))
          : state.subagentProgress({ thread: threadId })),
      });

      let completionText: string;
      let completionToolCalls: LlmToolCall[] | undefined;
      // Recorded before the call, not after: a step that throws still told the next one what it sent,
      // and a retry that re-renders the same progress should read it from cache rather than re-pay.
      const progressSent = progressRegion(rendered.prompt);
      const split = splitForPromptCache(rendered.system, rendered.prompt, previousCache);
      try {
        const completion = await this.modelRouter.generate(
          nativeToolTranscript.length > 0 ? [...split.messages, ...nativeToolTranscript] : split.messages,
          // Built from the live set, so a skill's grant reaches the model. This is
          // the one thing that can change the cached request prefix mid-run; an
          // invoke_skill therefore costs one cache miss, and only one.
          { modelClass: definition.modelClass, temperature: 0.1, metadata: { mode: "subagent", agent: definition.name },
            tools: buildLoopToolSpecs([...allowed.values()]), ...(input.signal ? { signal: input.signal } : {}) },
        );
        completionText = completion.text;
        completionToolCalls = completion.toolCalls;
        llmCalls++;
        previousCache = progressSent === undefined ? undefined : { progress: progressSent, cuts: split.cuts };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`[${definition.name}] LLM call failed at step ${step}`, { error: message });
        // Recorded, not just logged: this is what ended the run, and without it the result falls
        // back to whichever tool error came first — which the agent may well have recovered from
        // twenty steps ago. A caller reading "unknown section" when the provider actually refused
        // the request diagnoses the wrong thing, and a run loop deciding whether to retry cannot
        // tell a spent budget from a spent account.
        llmFailure = { code: "llm_call_failed", message: `LLM call failed at step ${step}: ${message}` };
        break;
      }

      // Native function calls are schema-constrained JSON — no text parsing, no
      // brace-balance failure mode. Text parsing remains the fallback for
      // providers (and the mock) that answered with plain text.
      const stepObj = completionToolCalls?.length
        ? stepFromToolCalls(completionToolCalls)
        : parseSubagentStep(completionText);

      // 工具调用旁的文本是模型本步的 note("这一步在做什么")。记录并循环注入,
      // 让它的推理跨步存活——否则每一步的结论随 completion 蒸发,模型会在
      // 不变的上下文里重复同一个动作。
      if (completionToolCalls?.length && completionText.trim() !== "") {
        const note = completionText.trim().slice(0, 500);
        log.info(`[${definition.name}] step ${step} note`, { note });
        state.record(definition.name, "subagent_note", { task_id: input.taskId, step, note },
          { threadId, parent: input.taskId });
      }
      if (stepObj.action === "finish") {
        // tool_choice 是 auto:模型可能只输出思考文本而不调任何工具。这不是收工——
        // 打回让它行动,并把它的文本原样带回,让这段推理跨步存活。
        const proseOnly = !completionToolCalls?.length && extractJsonObject(completionText) === null && completionText.trim() !== "";
        if (proseOnly) {
          log.info(`[${definition.name}] prose-only reply at step ${step}; nudging to act`, {});
          state.record(definition.name, "tool_result", { task_id: input.taskId, name: `${definition.name}_runtime`, step,
            error: { code: "no_action_taken",
              message: `You replied with text but called no tool. Your note (kept for you): "${completionText.trim().slice(0, 600)}". Now act on it: call the tools it implies, or call finish with your summary.` } },
          { threadId, parent: input.taskId });
          continue;
        }
        // 解析兜底会把残缺输出当成 finish:空文本,或想调工具但 JSON 没写对
        // (实测出现过长 batch 每个对象漏一个闭合括号)。这些不是真正的收工——
        // 打回重试,由步数预算兜底终止。
        const attemptedToolCall = /"action"\s*:\s*"call_tool"|"calls"\s*:\s*\[/.test(stepObj.summary);
        if (stepObj.summary === "" || attemptedToolCall) {
          log.warn(`[${definition.name}] unparseable completion at step ${step}; retrying instead of finishing`,
            { attempted_tool_call: attemptedToolCall });
          state.record(definition.name, "tool_result", { task_id: input.taskId, name: `${definition.name}_runtime`, step,
            error: { code: "unparseable_step",
              message: attemptedToolCall
                ? "Your last reply looked like a tool call but was not valid JSON (likely unbalanced braces — check that every object is fully closed). Re-send it as strict JSON; if the batch is long, split it into smaller operation batches across steps."
                : "Your last reply was empty or finished without a summary. Call one of the provided tools, or call finish with a non-empty summary." } },
          { threadId, parent: input.taskId });
          continue;
        }
        exhausted = false;
        log.info(`[${definition.name}] finish at step ${step}`, { summary: stepObj.summary });
        finishSummary = stepObj.summary;
        break;
      }

      log.info(`[${definition.name}] step ${step} — calling tools`, { tools: stepObj.calls.map((c) => c.tool) });

      // ask_user ends the turn. Anything sharing its step would run, produce a
      // result nobody reads (the loop stops), and be replayed on the resuming
      // dispatch — so refuse the step and let the model re-issue the ask alone.
      if (stepObj.calls.some((call) => call.tool === "ask_user") && stepObj.calls.length > 1) {
        state.record(definition.name, "tool_result", { task_id: input.taskId, name: `${definition.name}_runtime`, step,
          error: { code: "user_input_must_be_solo",
            message: "ask_user ends your turn, so it must be the only call in its step. Re-issue it alone, or do the other work first and ask afterwards." } },
        { threadId, parent: input.taskId });
        continue;
      }

      if (definition.name === "financial_modeling" && violatesFinancialMutationSeriality(stepObj.calls)) {
        state.record(definition.name, "tool_result", { task_id: input.taskId, name: "financial_modeling_runtime", step,
          error: { code: "financial_mutation_serialization_required",
            message: "A revision mutation must be the only call in its step. Combine dependent changes into one ordered operations batch, then inspect the result in a later step." } },
        { threadId, parent: input.taskId });
        continue;
      }

      // Run this step's tool calls in parallel — they are independent (any tool
      // whose choice depends on a prior result is issued in a later iteration).
      const toolResults = await Promise.all(stepObj.calls.map((call) => this.runToolCall(definition, input, call, allowed, step)));
      // The provider's own calls, in the order stepFromToolCalls kept them, so each replayed call
      // can be given back its signature. Gemini 3.x rejects the whole request when a functionCall
      // it minted comes back without one, and the args alone do not carry it.
      const signedCalls = (completionToolCalls ?? []).filter((call) => call.name !== FINISH_TOOL.name);
      nativeToolTranscript = [{ role: "assistant", content: completionText,
        toolCalls: stepObj.calls.map((call, index) => ({ id: call.id, name: call.tool, input: call.input,
          ...(signedCalls[index]?.signature ? { signature: signedCalls[index]!.signature } : {}) })) },
      ...toolResults.map((result) => result.nativeToolResult).filter((message): message is LlmMessage => message !== undefined)];
      if (definition.name === "financial_modeling" && allowed.has("get_financial_model")) {
        const stepConflict = toolResults.some((result) => result.errorCode === "revision_conflict");
        const modelId = stepConflict
          ? latestFinancialModelState(state.subagentToolOutputs({ thread: threadId })).model_id ?? input.request.model_id
          : undefined;
        if (modelId) {
          const refresh = await this.runToolCall(definition, input, { id: newId("toolcall"), tool: "get_financial_model", input: { modelId } }, allowed);
          recoveredRevisionConflict = refresh.errorCode === undefined;
        }
      }
      // A question is turn-ending: record it on the main channel so the client
      // renders the card, then stop. The answer does not come back into this
      // run — the user's reply starts a new turn, and the orchestrator resumes
      // this work by dispatching this thread again, per the summary below.
      pendingUserInput = toolResults.find((result) => result.userInputRequest)?.userInputRequest;
      if (pendingUserInput) {
        exhausted = false;
        log.info(`[${definition.name}] paused for user input`, { request_id: pendingUserInput.request_id, threadId });
        // The question goes on the main thread so the user sees it, tagged with
        // the thread it came from so the answer can be routed straight back.
        state.recordUserInputRequest(pendingUserInput, definition.name, threadId);
        break;
      }

      awaitingApproval = awaitingApproval || toolResults.some((result) => result.awaitingApproval);
      pendingApprovalId = toolResults.find((result) => result.approvalId)?.approvalId ?? pendingApprovalId;
      if (awaitingApproval) {
        exhausted = false;
        log.info(`[${definition.name}] awaiting approval`, { taskId: input.taskId });
        break;
      }
    }

    if (awaitingApproval) {
      const resolved = await waitForTaskResult(state, input.taskId, APPROVAL_WAIT_MS);
      if (!resolved) {
        if (pendingApprovalId) {
          state.record(
            definition.name,
            "approval_resolved",
            { approval_id: pendingApprovalId, decision: "timeout", from_thread: threadId },
            { parent: input.taskId },
          );
        }
        state.recordTaskResult(definition.name, input.taskId, {
          task_id: input.taskId,
          agent: definition.name,
          status: "timeout",
          summary: "Timed out waiting for user approval. The strategy was not activated.",
          error: { code: "approval_timeout", message: "Timed out waiting for user approval. The strategy was not activated." },
        });
      }
      return state.task(input.taskId)?.result;
    }

    // Assemble the task_result from the tool outputs read back from the log.
    // TASK scope, not thread: this round reports the work it did. Widening it
    // to the thread would re-attach every earlier round's artifacts to every
    // later result.
    const outputs = state.subagentToolOutputs({ task: input.taskId });
    const toolErrors = state.subagentToolErrors({ task: input.taskId });
    const generationContexts = outputs.map((o) => o.generation_context).filter((c): c is NonNullable<typeof c> => Boolean(c));
    // 运行时自愈类错误(串行纠正、重试提示)不算任务失败;而 agent 干净收工时,
    // 中途已被它克服的工具报错也不该盖过 finish 总结。
    const RUNTIME_NUDGE_CODES = new Set(["financial_mutation_serialization_required", "unparseable_step", "no_action_taken",
      "user_input_must_be_solo"]);
    // Only a fault the agent never got past ended the run. A tool error is fed back to it and
    // normally corrected a step or two later, so the errors that count are the ones with no
    // successful call after them — otherwise a spent step budget three steps past a corrected fault
    // reports as "failed", carrying a message that was already stale, and a caller built to resume a
    // pause stops instead. (AAPL: sourceType rejected at step 27, fixed and committed at 29-30,
    // budget spent at 30 — reported as a failure, and five of six rounds never ran.)
    const outcomes = state.subagentToolOutcomes({ task: input.taskId });
    const lastSuccess = outcomes.reduce((latest, outcome, index) => (outcome.error ? latest : index), -1);
    const firstToolError = outcomes.slice(lastSuccess + 1)
      .map((outcome) => outcome.error)
      .find((error): error is { code: string; message: string } => error !== undefined
        && !RUNTIME_NUDGE_CODES.has(error.code)
        && !(recoveredRevisionConflict && error.code === "revision_conflict"));
    const finished = finishSummary !== "";
    // Thread scope: this describes where the WORK stands, and the model handle
    // may well have been established in an earlier round of this thread.
    const latestModel = latestFinancialModelState(state.subagentToolOutputs({ thread: threadId }));
    const pausedForInput = pendingUserInput
      ? `Paused on ${pendingUserInput.questions.length} question${pendingUserInput.questions.length === 1 ? "" : "s"} for the user`
        + `; dispatch thread ${threadId} again with their answer and I pick up where I stopped.`
      : undefined;
    const result: TaskResult = {
      task_id: input.taskId,
      agent: definition.name,
      status: !finished && !pausedForInput && (llmFailure ?? firstToolError) ? "failed" : "ok",
      // No clean finish means no summary the agent stands behind. Say which it was —
      // a host that reports this upward must not pass "completed task" off as an account
      // of work that stopped mid-stride.
      summary: pausedForInput ?? (finished ? finishSummary : (llmFailure?.message ?? firstToolError?.message ?? (exhausted
        ? (definition.name === "financial_modeling"
          ? `Paused after ${maxToolSteps} tool steps; dispatch thread ${threadId} again to continue ${latestModel.model_id ?? input.request.model_id ?? "the model"} at revision ${latestModel.revision ?? "unknown"} (${latestModel.lifecycle_stage ?? "unknown stage"}).`
          : `${definition.name} stopped after ${maxToolSteps} tool steps without writing a finish summary.`)
        : `${definition.name} completed task.`))),
      artifacts: outputs.flatMap((o) => o.artifacts ?? []),
      visualizations: outputs.flatMap((o) => o.visualizations ?? []),
      metrics: { ms: Date.now() - started, tool_calls: outputs.length + toolErrors.length, llm_calls: llmCalls },
    };
    const cause = llmFailure ?? firstToolError;
    if (!finished && !pausedForInput && cause) {
      result.error = { code: cause.code, message: cause.message };
    }

    log.info(`[${definition.name}] done`, { ms: Date.now() - started, tool_calls: outputs.length, llm_calls: llmCalls });
    if (generationContexts.length > 0) {
      const prompts = [...new Set(generationContexts.map((context) => context.prompt?.trim()).filter((prompt): prompt is string => Boolean(prompt)))];
      result.generation_context = definition.name === "financial_modeling"
        ? { data: { task: input.request.task, ...projectFinancialModelData(outputs) } }
        : { data: { task: input.request.task,
          tool_outputs: outputs.map((o) => ({ tool: o.name, summary: o.summary, data: o.generation_context?.data ?? {} })) } };
      if (prompts.length > 0) result.generation_context.prompt = prompts.join("\n\n");
    }
    state.recordTaskResult(definition.name, input.taskId, result);
    return result;
  }

  /** Execute one tool call and record its tool_use/tool_result (and any approval)
   *  as sidechain events. Used in parallel for a step's independent calls. */
  private async runToolCall(
    definition: SubagentDefinition,
    input: RunSubagentInput,
    call: ToolCall,
    allowed: Map<string, ToolDefinition>,
    step?: number,
  ): Promise<{ awaitingApproval: boolean; approvalId?: string; errorCode?: string;
    userInputRequest?: UserInputRequest; nativeToolResult?: LlmMessage }> {
    const { state, threadId } = input;
    const tool = allowed.get(call.tool);
    if (!tool) {
      log.warn(`[${definition.name}] invalid tool requested: ${call.tool}`);
      // Record the invalid choice so the next iteration sees it.
      state.record(
        definition.name,
        "tool_result",
        { task_id: input.taskId, name: call.tool, error: { code: "invalid_tool", message: `"${call.tool}" is not an allowed tool — choose from the allowed list or finish.` } },
        { threadId, parent: input.taskId },
      );
      return { awaitingApproval: false, errorCode: "invalid_tool",
        nativeToolResult: nativeToolResult(call, call.tool, { error: "invalid_tool", message: `"${call.tool}" is not an allowed tool — choose from the allowed list or finish.` }, true) };
    }

    // Ownership lives here rather than in the tool: `execute` is a pure
    // (input) => result and does not know who called it. A name outside this
    // agent's roster never reaches the registry, so no other agent's guidance
    // can enter this context.
    if (tool.name === INVOKE_SKILL) {
      const requested = typeof call.input["skill"] === "string" ? call.input["skill"] : "";
      const roster = definition.skills ?? [];
      if (!roster.includes(requested)) {
        const message = `"${requested}" is not one of your skills — choose from: ${roster.join(", ") || "(none)"}.`;
        log.warn(`[${definition.name}] skill outside roster: ${requested}`);
        state.record(
          definition.name,
          "tool_result",
          { task_id: input.taskId, name: tool.name, error: { code: "skill_not_allowed", message } },
          { threadId, parent: input.taskId },
        );
        return { awaitingApproval: false, errorCode: "skill_not_allowed",
          nativeToolResult: nativeToolResult(call, tool.name, { error: "skill_not_allowed", message }, true) };
      }
    }

    const callInput: JsonObject = { ...call.input };
    const toolUseId = newId("tooluse");
    const useEv = state.record(
      definition.name,
      "tool_use",
      { tool_use_id: toolUseId, task_id: input.taskId, name: tool.name, input: callInput },
      { threadId, parent: input.taskId },
    );

    log.info(`[${definition.name}] tool call: ${tool.name}`, { input: call.input });

    let output: Awaited<ReturnType<McpToolRegistry["call"]>>;
    try {
      // Run-scoped first, shared second, so a run only has to register what is peculiar to it and
      // still reaches `invoke_skill` and the rest from the process registry.
      const registry = input.toolRegistry?.get(tool.name) ? input.toolRegistry : this.toolRegistry;
      output = await registry.call(tool.name, callInput, {
        sessionId: input.sessionId,
        agentId: input.agentId,
        taskId: input.taskId,
      });
    } catch (error) {
      log.error(`[${definition.name}] tool error: ${tool.name}`, { error: error instanceof Error ? error.message : String(error) });
      state.record(
        definition.name,
        "tool_result",
        { tool_use_id: toolUseId, task_id: input.taskId, name: tool.name, error: { code: "tool_error", message: error instanceof Error ? error.message : String(error) } },
        { threadId, parent: useEv.event_id },
      );
      return { awaitingApproval: false, errorCode: "tool_error",
        nativeToolResult: nativeToolResult(call, tool.name, { error: "tool_error", message: error instanceof Error ? error.message : String(error) }, true) };
    }

    log.info(`[${definition.name}] tool result: ${tool.name}`, { summary: output.summary });

    const normalizedError = normalizeToolError(output);
    const toolResultPayload: JsonObject = { tool_use_id: toolUseId, task_id: input.taskId, name: tool.name, summary: output.summary,
      ...(step === undefined ? {} : { step }) };
    if (output.generation_context) toolResultPayload.generation_context = output.generation_context as unknown as JsonObject;
    if (normalizedError) toolResultPayload.error = normalizedError;
    if (output.artifacts?.length) toolResultPayload.artifacts = output.artifacts as unknown as JsonObject[string];
    if (output.visualizations?.length) toolResultPayload.visualizations = output.visualizations;
    state.record(definition.name, "tool_result", toolResultPayload, { threadId, parent: useEv.event_id });

    if (tool.name === INVOKE_SKILL && !normalizedError) {
      this.grantSkillTools(definition, output.generation_context?.data?.["tools"], allowed);
    }

    if (output.approval) {
      log.info(`[${definition.name}] approval required`, { approval_id: output.approval.approval_id });
      // Approval state lives in the log: approval_required with no matching
      // approval_resolved (within TTL) is pending. No separate store.
      //
      // Like a question, this goes on the MAIN thread — it has to reach the
      // user — and carries the thread it came from rather than being buried in
      // the agent's own trace where nobody would see it.
      state.record(
        definition.name,
        "approval_required",
        { approval_id: output.approval.approval_id, payload: output.approval.payload, from_thread: threadId },
        { parent: input.taskId },
      );
      return { awaitingApproval: true, approvalId: output.approval.approval_id,
        nativeToolResult: nativeToolResult(call, tool.name, output.generation_context?.data ?? { summary: output.summary }, Boolean(normalizedError)) };
    }

    if (output.user_input_request) {
      return { awaitingApproval: false, userInputRequest: output.user_input_request,
        nativeToolResult: nativeToolResult(call, tool.name, output.generation_context?.data ?? { summary: output.summary }, Boolean(normalizedError)) };
    }

    return normalizedError
      ? { awaitingApproval: false, errorCode: normalizedError.code,
        nativeToolResult: nativeToolResult(call, tool.name, output.generation_context?.data ?? { summary: output.summary }, true) }
      : { awaitingApproval: false,
        nativeToolResult: nativeToolResult(call, tool.name, output.generation_context?.data ?? { summary: output.summary }, false) };
  }
}

function latestFinancialModelState(outputs: ReturnType<SessionState["subagentToolOutputs"]>): {
  model_id?: string; revision?: number; lifecycle_stage?: string;
} {
  for (const output of [...outputs].reverse()) {
    const data = output.generation_context?.data;
    if (!data) continue;
    const result: { model_id?: string; revision?: number; lifecycle_stage?: string } = {};
    if (typeof data["model_id"] === "string") result.model_id = data["model_id"];
    if (typeof data["revision"] === "number") result.revision = data["revision"];
    if (typeof data["lifecycle_stage"] === "string") result.lifecycle_stage = data["lifecycle_stage"];
    if (Object.keys(result).length > 0) return result;
  }
  return {};
}

/** 查询类工具:结果不进 active_model_context,但 agent 的后续判断依赖它们,
 * 所以全部保留,否则 agent 会因为看不到结果而无限重查。 */
const FINANCIAL_QUERY_TOOLS = new Set([
  "financial_search", "get_treasury_yield", "list_unified_statements", "get_unified_rows", "calculate_model_rows",
]);

/** Narrow reads must compose, but an agent can still issue arbitrary selectors. Keep a useful working
 * set rather than letting a long run grow its prompt without bound; the projection tells it if an
 * older slice was evicted, so an intentional reread is never mistaken for a missing tool result. */
const MAX_WORKBOOK_SLICES = 16;
/** Approx. 30k tokens of structured workbook evidence, leaving room for playbooks, notes, and tool specs. */
const MAX_WORKBOOK_SLICE_CONTEXT_CHARS = 120_000;

/** 提取结果里唯一跨步必需的是 ingestionRunId 和覆盖率;诊断按 playbook 只在覆盖率
 *  短缺时才用来判断,所以留计数加一个样本,不把 309 条原样搬进上下文。 */
function compactExtraction(raw: JsonObject): JsonObject {
  const diagnostics = Array.isArray(raw["diagnostics"]) ? raw["diagnostics"] : [];
  return {
    ...(raw["ingestionRunId"] !== undefined ? { ingestionRunId: raw["ingestionRunId"] } : {}),
    ...(raw["statementCoverage"] !== undefined ? { statementCoverage: raw["statementCoverage"] } : {}),
    ...(raw["filingInsightSetId"] !== undefined ? { filingInsightSetId: raw["filingInsightSetId"] } : {}),
    ...(raw["status"] !== undefined ? { status: raw["status"] } : {}),
    diagnostic_count: diagnostics.length,
    ...(diagnostics.length ? { diagnostic_sample: diagnostics.slice(0, 5) as JsonValue } : {}),
  };
}

function projectFinancialModelData(outputs: ReturnType<SessionState["subagentToolOutputs"]>): JsonObject {
  const revisions: JsonValue[] = [];
  let active: JsonObject = {};
  // The live revision is deliberately NOT a field of `active` — it changes on every mutation and is
  // rendered below the progress region instead. The slice-invalidation logic still needs to know
  // which revision the context is standing on, so it is tracked here rather than read back out of
  // the projection. Reading it from `active` is what made the two concerns one; they are not.
  let activeRevision: number | undefined;
  // A narrowed workbook read is evidence the agent explicitly asked for.  Unlike the overview,
  // multiple sections are meant to be read together (for example revenue plus history before a
  // forecast), so keep every distinct slice of the current revision instead of letting whichever
  // parallel call finishes last erase the others.  A new revision invalidates the whole cache.
  type CachedWorkbookSlice = { slice: JsonObject; sections: Set<string> };
  const workbookSlices = new Map<string, CachedWorkbookSlice>();
  let workbookSliceChars = 0;
  let evictedWorkbookSlices = 0;
  const subagentResults: JsonValue[] = [];
  const skillReferences = new Map<string, JsonValue>();
  // 技能正文必须跨步存活:这份投影就是 agent 每一步的全部上下文,漏掉它等于
  // invoke 完下一步方法论就没了。
  const skillGuidance = new Map<string, JsonValue>();
  const queryResults: JsonValue[] = [];
  let extraction: JsonObject | undefined;
  // Unknown tools get one durable slot per tool name. A fixed "last N events" window previously
  // forgot a successful tool after enough unrelated calls, which has the same repeat-loop failure
  // mode as dropping a workbook slice.
  const otherResults = new Map<string, JsonValue>();
  for (const output of outputs) {
    const data = output.generation_context?.data;
    if (data) {
      if (output.name === "read_skill_reference" && typeof data["content"] === "string") {
        skillReferences.set(`${data["skill"]}/${data["path"]}`, data["content"]);
        continue;
      }
      if (output.name === INVOKE_SKILL && typeof data["content"] === "string") {
        skillGuidance.set(String(data["skill"]), data["content"]);
        continue;
      }
      let captured = false;
      if (data["revision_summary"] && typeof data["revision_summary"] === "object") { revisions.push(data["revision_summary"]); captured = true; }
      if (output.name === "run_dcf_subagent") { subagentResults.push(data); captured = true; }
      if (FINANCIAL_QUERY_TOOLS.has(output.name)) { queryResults.push({ tool: output.name, data }); captured = true; }
      // 提取结果单独一格,后一次覆盖前一次:agent 需要的是 ingestionRunId 和覆盖率,
      // 不是 309 条诊断乘以重试次数。没有这一格,提取就等于没发生过,agent 会一直重跑。
      if (data["extraction"] && typeof data["extraction"] === "object") {
        extraction = compactExtraction(data["extraction"] as JsonObject);
        captured = true;
      }
      if (typeof data["model_id"] === "string") {
        const modelId = data["model_id"];
        const revision = typeof data["revision"] === "number" ? data["revision"] : undefined;
        const currentModelId = typeof active["model_id"] === "string" ? active["model_id"] : undefined;
        const currentRevision = activeRevision;
        const changesModel = currentModelId !== undefined && currentModelId !== modelId;
        const advancesRevision = revision !== undefined && (currentRevision === undefined || revision > currentRevision);
        // Explicit historical reads must not make the current model context regress. They remain
        // visible in the tool trace, but forecasts and mutations should be grounded in the latest
        // revision the agent has already observed.
        if (currentModelId === modelId && revision !== undefined && currentRevision !== undefined && revision < currentRevision) {
          captured = true;
          continue;
        }
        // A mutation carries model_change_context, so its prior slices remain available as explicitly
        // revision-stamped history. A different model, or an unexplained revision advance, still
        // invalidates the cache conservatively.
        const hasChangeContext = data["model_change_context"] !== undefined;
        if (changesModel || (advancesRevision && !hasChangeContext)) {
          workbookSlices.clear();
          workbookSliceChars = 0;
          evictedWorkbookSlices = 0;
        }
        const retained = changesModel || advancesRevision ? {} : active;
        const incomingSlices = [
          ...(data["workbook_slice"] !== undefined ? [data["workbook_slice"]] : []),
        ];
        for (const rawSlice of incomingSlices) {
          if (!rawSlice || typeof rawSlice !== "object" || Array.isArray(rawSlice)) continue;
          const slice = rawSlice as JsonObject;
          const key = JSON.stringify(slice);
          // Refreshing an existing slice makes it most-recently used without duplicating it.
          if (workbookSlices.has(key)) {
            workbookSlices.delete(key);
            workbookSliceChars -= key.length;
          }
          const rows = Array.isArray(slice["rows"]) ? slice["rows"] : [];
          const sections = new Set(rows.flatMap((row) => row && typeof row === "object" && !Array.isArray(row)
            && typeof (row as JsonObject)["section"] === "string" ? [(row as JsonObject)["section"] as string] : []));
          // A source-statement row has no DCF section field.  Treat an unclassifiable slice as
          // revision-bound, so it is still conservatively dropped on a normal revision advance.
          if (sections.size === 0) sections.add("<unknown>");
          // Once the agent reads a section at the current revision, that fresh slice supersedes an
          // older one for the same section. Other older sections remain historical working memory.
          if (revision !== undefined) {
            for (const [cachedKey, cached] of workbookSlices) {
              const cachedRevision = typeof cached.slice["revision"] === "number" ? cached.slice["revision"] : undefined;
              if (cachedRevision !== revision && [...cached.sections].some((section) => sections.has(section))) {
                workbookSlices.delete(cachedKey);
                workbookSliceChars -= cachedKey.length;
              }
            }
          }
          workbookSlices.set(key, { slice, sections });
          workbookSliceChars += key.length;
          // Keep the newly requested slice even if it alone exceeds the budget: hiding the result
          // the agent explicitly asked for recreates the repeat-loop we are preventing.
          while (workbookSlices.size > MAX_WORKBOOK_SLICES
            || (workbookSliceChars > MAX_WORKBOOK_SLICE_CONTEXT_CHARS && workbookSlices.size > 1)) {
            const oldest = workbookSlices.keys().next().value!;
            workbookSlices.delete(oldest);
            workbookSliceChars -= oldest.length;
            evictedWorkbookSlices += 1;
          }
        }
        // Key order inside this object is the same caching decision as the order of the projection
        // that holds it, and it matters more here, because this is the largest object in the
        // projection and it is rebuilt on every model read or write.
        //
        // `revision` used to sit second. It advances on every mutation, so a mutation step's cache
        // ended 40 bytes into a 28k object and the whole of it — workbook slices the agent had read
        // many steps ago and that had not changed since — was re-billed uncached. Measured on a TSLA
        // run: mutation steps read back 20,441 cached tokens where the steps around them read 49,058.
        //
        // It is no longer here at all: the one value that changes on literally every mutation is
        // rendered into the volatile {{stepBudget}} slot, BELOW the progress region, so it cannot
        // divide this object at any offset. Ordering alone would have been a convention held up by a
        // test; keeping it out of the region is structural. What stays here is the big, slow-moving
        // evidence, and the counters, which only move when the slices above them move anyway.
        active = { ...retained,
          ...(data["filing_insights"] !== undefined ? { filing_insights: data["filing_insights"] } : {}),
          ...(workbookSlices.size > 0 ? { workbook_slices: [...workbookSlices.values()].map((cached) => cached.slice) } : {}),
          ...(data["revision_history"] !== undefined ? { revision_history: data["revision_history"] } : {}),
          // model_overview is what both the read and the write answer with. Narrow reads accumulate
          // in workbook_slices for this revision; neither carries a whole workbook any more.
          ...(data["model_overview"] ? { model_overview: data["model_overview"] } : {}),
          ...(data["model_change_context"] ? { model_change_context: data["model_change_context"] } : {}),
          // Counters and stamps: small, and they move whenever anything above them moves.
          ...(workbookSlices.size > 0 ? { workbook_slices_context_chars: workbookSliceChars } : {}),
          ...(evictedWorkbookSlices > 0 ? { workbook_slices_evicted: evictedWorkbookSlices } : {}),
          ...(workbookSlices.size > 0 && [...workbookSlices.values()].some((cached) => cached.slice["revision"] !== revision)
            ? { workbook_slices_notice: "Slices from an earlier revision are historical context only; reread that section before using current values." } : {}),
          model_id: modelId,
          ...(typeof data["lifecycle_stage"] === "string" ? { lifecycle_stage: data["lifecycle_stage"] } : {}) };
        activeRevision = revision ?? (changesModel ? undefined : currentRevision);
        captured = true;
      }
      if (captured) continue;
    }
    // 兜底。上面每一个分支都是白名单,而白名单漏掉一个工具的后果不是"少点信息",
    // 是那次调用在 agent 眼里从未发生——它会照着看得见的证据重跑,直到步数耗尽。
    // summary 本来就是为压缩而写的,足够它知道自己做过什么。
    otherResults.set(output.name, { tool: output.name, summary: output.summary });
  }
  // Key order is a caching decision, not a reading one. A provider caches a request by byte prefix,
  // so the first field that changes between two steps ends the cache — and everything after it is
  // re-billed even if it is identical. `active_model_context` used to sit second: it is rewritten on
  // every model read or write, which left a common prefix of 76 bytes out of 38k and put the tens of
  // thousands of characters of never-changing playbook text behind it, paid for again every step.
  //
  // So: what never changes first, then what only ever grows at its own end, then what is rewritten
  // or windowed. It reads better this way too — the freshest state ends up nearest the question.
  // Ordered by how likely a field is to be UNCHANGED between two consecutive steps, most likely
  // first. Not by "static, then append-only, then rewritten" — that reading is wrong and cost real
  // money. A provider matches a byte prefix, so an append is a divergence point exactly like a
  // rewrite: everything below it is re-billed whether or not it changed. `revision_summaries` grows
  // by one small entry on every mutation, and ordering it above `active_model_context` therefore
  // re-bills the tens of thousands of tokens of workbook slices underneath it — slices that are
  // deliberately retained across a mutation precisely so they can be read from cache.
  //
  // So the question to ask of each field is not "does it only grow?" but "will this step change it?",
  // and the big, slow-moving evidence goes above the small, per-step bookkeeping.
  return {
    skill_guidance: Object.fromEntries(skillGuidance),
    skill_references: Object.fromEntries(skillReferences),
    ...(extraction ? { latest_extraction: extraction } : {}),
    // Untouched by a mutation step: these move only when their own tool is called.
    query_results: queryResults,
    other_results: [...otherResults.values()],
    latest_subagent_results: subagentResults.slice(-2),
    // Large, and stable across a mutation up to the per-step stamps at its own end.
    active_model_context: active,
    // One small entry per mutation — last, so it cannot push anything above it out of the cache.
    revision_summaries: revisions,
  };
}

export function projectFinancialModelProgress(
  outputs: ReturnType<SessionState["subagentToolOutputs"]>,
  errors: ReturnType<SessionState["subagentToolErrors"]>,
  notes: { step: number; note: string }[],
): string {
  if (outputs.length === 0 && errors.length === 0 && notes.length === 0) return "(no tools called yet)";
  // 步号是时间坐标:模型由此能看出"报错发生在很多步之前,此后没再失败",
  // 以及自己的 note 是否在原地重复。
  return JSON.stringify({ ...projectFinancialModelData(outputs),
    step_notes: notes.map((entry) => `step ${entry.step}: ${entry.note}`),
    errors: errors.slice(-2).map((error) => ({ ...(error.step === undefined ? {} : { at_step: error.step }),
      tool: error.name, code: error.code, message: error.message })) });
}

const FINANCIAL_MUTATION_TOOLS = new Set([
  "create_financial_model", "apply_financial_model_operations", "archive_financial_model",
]);
function violatesFinancialMutationSeriality(calls: ToolCall[]): boolean {
  return calls.some((call) => FINANCIAL_MUTATION_TOOLS.has(call.tool)) && calls.length !== 1;
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
