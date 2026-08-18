import { formatList, PromptRenderer } from "./prompt.ts";
import type { SkillRegistry } from "./skill.ts";
import type { Dispatcher } from "./dispatcher.ts";
import type { SubagentRegistry } from "./subagent.ts";
import type { ModelRouter } from "../infra/llm/provider.ts";
import { formatLatestInput, type LiveThread, type SessionRegistry, SessionState } from "./sessionState.ts";
import { maybeCompact } from "./contextCompaction.ts";
import type { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import type { PromptTemplate } from "./prompt.ts";
import type { AgentKind, JsonObject, OrchestratorStep, OrchestratorToolCall, SkillResult, TaskRequest, UserInputRequest, UserInputResponse } from "./types.ts";

/** Max orchestrator loop iterations per user turn — a runaway-loop backstop. */
const MAX_STEPS = 6;

/**
 * Strip a leading ```json / ``` fence and trailing ``` that some models
 * (notably Gemini) wrap structured output in. The brace scanner below also
 * tolerates fences, but removing them up front keeps logs and salvage clean.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i);
  const body = fenced?.[1];
  return body !== undefined ? body.trim() : trimmed;
}

/** Extract the first balanced JSON object from a possibly-noisy LLM string. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Decode the common JSON string escapes in a raw (possibly truncated) body. */
function decodeJsonString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break; // trailing backslash from a truncated stream
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      case "u": {
        const hex = body.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += next;
        }
        break;
      }
      default: out += next;
    }
    i += 1;
  }
  return out;
}

/**
 * Best-effort recovery of the `reply` field when JSON.parse fails — most often
 * because the stream was truncated mid-string (no closing quote/brace) or the
 * model emitted raw newlines / trailing commas. Returns the decoded markdown so
 * the user sees prose instead of a raw `{"reply": ...}` blob.
 */
function salvageReply(text: string): string | null {
  const startMatch = text.match(/"reply"\s*:\s*"/);
  if (!startMatch || startMatch.index === undefined) return null;
  const bodyStart = startMatch.index + startMatch[0].length;
  const rest = text.slice(bodyStart);
  // Closing quote precedes either the next known key or the object end. If the
  // stream was truncated, no such marker exists — take everything that's left.
  const endMatch = rest.match(/"\s*(?:,\s*"(?:dispatch|skill|tool_calls?)"|}\s*$)/);
  const body = endMatch && endMatch.index !== undefined ? rest.slice(0, endMatch.index) : rest;
  const decoded = decodeJsonString(body).trim();
  return decoded.length > 0 ? decoded : null;
}

/**
 * Parse one orchestrator completion into an OrchestratorStep. On any failure,
 * fall back to treating the raw text as a terminal user-facing reply so the loop
 * still ends gracefully instead of looping or crashing.
 */
function parseStep(text: string): OrchestratorStep {
  const cleaned = stripCodeFence(text);
  const rawFallback: OrchestratorStep = { reply: text.trim(), dispatch: null, skill: null, tool_calls: null };
  const json = extractJsonObject(cleaned);

  if (json) {
    try {
      const raw = JSON.parse(json) as Record<string, unknown>;
      const reply = typeof raw.reply === "string" ? raw.reply : "";
      const dispatch = Array.isArray(raw.dispatch) ? (raw.dispatch as TaskRequest[]) : null;
      const skill = typeof raw.skill === "string" && raw.skill.trim() ? raw.skill.trim() : null;
      // The schema asks for `tool_calls: [...]`, but a model that has seen the
      // singular form elsewhere reverts to it often enough that refusing it
      // would cost a whole retry step for nothing.
      const toolCalls = normalizeToolCalls(raw.tool_calls ?? raw.tool_call);
      return { reply, dispatch, skill, tool_calls: toolCalls };
    } catch {
      // Fall through to salvage — most often a truncated or lightly-malformed
      // JSON string (raw newlines, trailing comma) that strict parsing rejects.
    }
  }

  // No complete object (truncated stream) or JSON.parse threw. Recover the
  // reply text so the user sees markdown, not a raw `{"reply": ...}` dump.
  const salvaged = salvageReply(cleaned);
  if (salvaged !== null) {
    return { reply: salvaged, dispatch: null, skill: null, tool_calls: null };
  }
  return rawFallback;
}

/** Accepts either `tool_calls: [...]` or a lone `tool_call: {...}`. */
function normalizeToolCalls(raw: unknown): OrchestratorToolCall[] | null {
  const items = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const calls = items.filter(
    (item): item is OrchestratorToolCall =>
      typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string",
  );
  return calls.length > 0 ? calls : null;
}

/** A compact, automatically derived description of the model open in the UI.
 * The workbook itself remains tool-readable rather than prompt-injected. */
export type ActiveWorkspaceModel = {
  modelId: string;
  symbol: string;
  createdAt: string;
  updatedAt: string;
  currentRevision: number;
  lifecycleStage: string;
};

export type OrchestratorInput = {
  sessionId: string;
  agentId: string;
  userMessage: string;
  inputResponse?: UserInputResponse;
  /** Model open in the caller's workspace; advisory context for DCF work. */
  activeModel?: ActiveWorkspaceModel;
  /** False for agent-to-agent Topic drives, where no human is watching that Topic stream. */
  allowUserInput?: boolean;
};

/** A read-only, non-persistent consultation of a Topic's current working context. */
export type TopicConsultationInput = {
  sessionId: string;
  agentId: string;
  question: string;
  activeModel?: ActiveWorkspaceModel;
};

/** Result of a turn. Task results / artifacts are read from the session log
 *  (via the SSE projector / state.turnResults), not returned here. */
export type OrchestratorResult = {
  response: string;
  skill_result?: SkillResult;
};

/** Tools the orchestrator can call directly (by name). */
const ORCHESTRATOR_DIRECT_TOOLS = new Set<string>(["read_skill_reference", "run_skill_script", "read_compacted_task_data", "ask_user"]);

/** How many subagent threads to show the orchestrator. Older ones are almost
 *  never what it wants to continue, and each line costs context. */
const MAX_LISTED_THREADS = 8;

/** The subagent conversations this topic has, most recently active last. */
function formatThreads(threads: LiveThread[]): string {
  if (threads.length === 0) return "(none yet — any dispatch you write now opens a new thread)";
  return threads.slice(-MAX_LISTED_THREADS).map((t) => {
    const rounds = `${t.rounds} round${t.rounds === 1 ? "" : "s"}`;
    const summary = t.last_summary ? ` — last result: ${t.last_summary.slice(0, 300)}` : "";
    return `- ${t.thread_id} (${t.agent}, ${rounds}, status=${t.status}) last task: ${t.last_task}${summary}`;
  }).join("\n");
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

export class OrchestratorRuntime {
  private readonly renderer = new PromptRenderer();
  private readonly prompt: PromptTemplate;
  private readonly modelRouter: ModelRouter;
  private readonly dispatcherFactory: (sessionId: string, agentId: string, state?: SessionState) => Dispatcher;
  private readonly subagents: SubagentRegistry;
  private readonly skills: SkillRegistry;
  private readonly tools: McpToolRegistry;
  private readonly sessions: SessionRegistry;
  private readonly orchestratorTools = ORCHESTRATOR_DIRECT_TOOLS;

  constructor(
    prompt: PromptTemplate,
    modelRouter: ModelRouter,
    dispatcherFactory: (sessionId: string, agentId: string, state?: SessionState) => Dispatcher,
    subagents: SubagentRegistry,
    skills: SkillRegistry,
    tools: McpToolRegistry,
    sessions: SessionRegistry,
  ) {
    this.prompt = prompt;
    this.modelRouter = modelRouter;
    this.dispatcherFactory = dispatcherFactory;
    this.subagents = subagents;
    this.skills = skills;
    this.tools = tools;
    this.sessions = sessions;
  }

  async run(input: OrchestratorInput): Promise<OrchestratorResult> {
    const state = await this.sessions.getOrCreate(input.sessionId);
    return this.runWithState(input, state, false);
  }

  /**
   * Answer from a disposable clone of the Topic's compact working state. The
   * original Topic's event log, model, tools, and UI stream remain untouched.
   */
  async consult(input: TopicConsultationInput): Promise<OrchestratorResult> {
    const source = await this.sessions.getOrCreate(input.sessionId);
    const state = SessionState.restore(
      source.session_id,
      source.started_at,
      structuredClone([...source.allEvents()]),
      source.compactionCache() ? structuredClone(source.compactionCache()) : undefined,
      undefined,
    );
    return this.runWithState({
      sessionId: input.sessionId,
      agentId: input.agentId,
      userMessage: input.question,
      ...(input.activeModel ? { activeModel: input.activeModel } : {}),
      allowUserInput: false,
    }, state, true);
  }

  private async runWithState(input: OrchestratorInput, state: SessionState, readOnlyConsultation: boolean): Promise<OrchestratorResult> {
    if (input.inputResponse && !state.pendingUserInput(input.inputResponse.request_id)) {
      throw new Error(`user input request '${input.inputResponse.request_id}' is no longer pending`);
    }
    const turn = state.beginTurn(input.userMessage, input.inputResponse);

    const dispatcher = this.dispatcherFactory(input.sessionId, input.agentId, state);
    // The same rule the orchestrator applies to its own ask_user below, pushed
    // down to the subagents it dispatches: no human on this stream, no asking.
    dispatcher.setUserInputAllowed(input.allowUserInput !== false);
    const validAgents = new Set(this.subagents.list().map((agent) => agent.name));
    const validSkills = new Set(this.skills.list().map((skill) => skill.name));

    let skillResult: SkillResult | undefined;
    let finalReply = "";
    const directTools = input.allowUserInput === false
      ? new Set([...this.orchestratorTools].filter((name) => name !== "ask_user"))
      : this.orchestratorTools;

    for (let step = 1; step <= MAX_STEPS; step++) {
      // Run before every prompt, not just at the start of a user turn. The
      // cutoff is deliberately before `turn`, so this never summarizes the
      // current request or its in-flight results.
      await maybeCompact(state, this.modelRouter, turn);
      const proj = state.projectForPrompt(turn);
      const history = proj.currentTurnProgress
        ? `${proj.conversationSoFar}\n\n[CURRENT TURN PROGRESS]\n${proj.currentTurnProgress}`
        : proj.conversationSoFar;

      const rendered = this.renderer.render(this.prompt, {
        currentDate: new Date().toISOString().slice(0, 10),
        latestInput: formatLatestInput(input.userMessage, Boolean(input.inputResponse)),
        history,
        threads: formatThreads(state.liveThreads()),
        activeModelContext: input.activeModel
          ? `The user is currently viewing this financial model:\n- Model ID: ${input.activeModel.modelId}\n- Symbol: ${input.activeModel.symbol}\n- Created: ${input.activeModel.createdAt}\n- Last updated: ${input.activeModel.updatedAt}\n- Current revision: ${input.activeModel.currentRevision}\n- Lifecycle stage: ${input.activeModel.lifecycleStage}\nIf their request concerns this DCF, prefer continuing it: dispatch financial_modeling with this model ID in model_id so the subagent can refresh its state first. This is advisory context, not a command to ignore evidence that a different model is needed.`
          : "No financial model is currently selected in the workspace.",
        consultationContext: readOnlyConsultation
          ? "This is a read-only consultation of an existing Topic for a Research controller. Answer from the Topic's existing context only. Do not dispatch agents, call tools, ask the user, create or modify models, or claim new research. Your reply is temporary and will not be written to the Topic history."
          : "Normal Topic turn: use the available actions when needed.",
        subagents: formatList(this.subagents.list().map((a) => ({ name: a.name, description: a.description }))),
        skills: formatList(this.skills.list().map((s) => ({ name: s.name, description: s.description }))),
        tools: formatList(this.tools.list()
          .filter((t) => directTools.has(t.name))
          .map((t) => ({ name: t.name, description: t.description }))),
      });

      let completionText: string;
      try {
        const completion = await this.modelRouter.generate(
          [
            { role: "system", content: rendered.system },
            { role: "user", content: rendered.prompt },
          ],
          { modelClass: "LARGE", temperature: 0.2, metadata: { mode: "orchestrator" } },
        );
        completionText = completion.text;
        state.recordPromptTokens(completion.metrics.tokens_in);
      } catch (error) {
        state.record("orchestrator", "error", { scope: "main", message: error instanceof Error ? error.message : String(error) });
        break;
      }

      const stepObj = parseStep(completionText);
      const status = stepObj.reply.trim();

      // A consultation is deliberately an answer-only view of the Topic. Even
      // if the model emits an action, it cannot mutate durable state or start
      // background work from this ephemeral session.
      if (readOnlyConsultation) {
        finalReply = status || "This Topic has no established answer for that question yet.";
        break;
      }

      // `skill` cannot share a step with anything else: it installs the guidance
      // and allowance that are meant to shape the NEXT step's decisions, so a
      // dispatch written in the same step was written blind to it. Resolving the
      // clash by branch order would drop an action the model asked for without
      // telling it — the failure then looks like the skill simply never ran.
      const otherAction = (stepObj.dispatch?.length ?? 0) > 0 || (stepObj.tool_calls?.length ?? 0) > 0;
      if (stepObj.skill && otherAction) {
        state.record("orchestrator", "error", {
          scope: "protocol",
          message:
            "skill is mutually exclusive with dispatch and tool_calls — invoke the skill alone, then act on its guidance in the next step",
        });
        continue;
      }

      const askUserCalls = (stepObj.tool_calls ?? []).filter((call) => call.name === "ask_user");
      const askUserMixed = askUserCalls.length > 0 && (
        askUserCalls.length > 1 ||
        (stepObj.dispatch?.length ?? 0) > 0 ||
        (stepObj.tool_calls?.length ?? 0) !== askUserCalls.length
      );
      if (askUserCalls.length > 0 && input.allowUserInput === false) {
        state.record("orchestrator", "error", {
          scope: "protocol",
          message: "ask_user is unavailable in an agent-to-agent Topic run; return the missing information to the caller instead",
        });
        continue;
      }
      if (askUserMixed) {
        state.record("orchestrator", "error", {
          scope: "protocol",
          message: "ask_user must be the only action in its step and may only be called once",
        });
        continue;
      }

      // --- dispatch + tool_calls: independent of each other, so they share a step ---
      const tasks: TaskRequest[] = (stepObj.dispatch ?? [])
        .filter((t) => t && typeof t.task === "string" && t.task.trim() && validAgents.has(t.agent as AgentKind))
        .map((t) => ({ agent: t.agent as AgentKind, task: t.task.trim(),
          ...(typeof t.thread === "string" && t.thread.trim() ? { thread: t.thread.trim() } : {}),
          // The completion can name another model when the task justifies it.
          // Otherwise carry the one the user is inspecting into the subagent's
          // prompt as the natural continuation point.
          ...(typeof t.model_id === "string" && t.model_id.trim()
            ? { model_id: t.model_id.trim() }
            : t.agent === "financial_modeling" && input.activeModel
              ? { model_id: input.activeModel.modelId }
              : {}),
          // Ids of earlier results whose data this task needs. Uncapped on purpose:
          // the caller passes an id precisely because it cannot see how much data
          // sits behind one, so a count it silently trimmed here would drop data
          // the task was written around. The dispatcher's size limit is the real
          // bound, and it fails the task out loud.
          ...(Array.isArray(t.source_event_ids)
            ? ((ids) => (ids.length > 0 ? { source_event_ids: ids } : {}))(
              t.source_event_ids.filter((id): id is string => typeof id === "string" && id.trim() !== "")
                .map((id) => id.trim()))
            : {}) }));

      const toolCalls = (stepObj.tool_calls ?? []).filter((call) => directTools.has(call.name));

      if (tasks.length > 0 || toolCalls.length > 0) {
        const tradingRetryBlocked = tasks.some((task) => task.agent === "trading_operations")
          ? [...state.turnResults(turn)].reverse().find(
              (result) =>
                result.agent === "trading_operations" &&
                (result.status !== "ok" || result.generation_context?.data?.["rejected"] === true),
            )
          : undefined;
        if (tradingRetryBlocked) {
          finalReply = tradingRetryBlocked.summary;
          break;
        }
        const isAskingUser = toolCalls.some((call) => call.name === "ask_user");
        if (status && !isAskingUser) state.recordReply(status, false);
        const [, toolOutcomes] = await Promise.all([
          // Subagents write their own task_result events.
          tasks.length > 0 ? dispatcher.dispatch(tasks) : Promise.resolve(),
          Promise.all(toolCalls.map((call) => this.runOrchestratorTool(call, input.sessionId, input.agentId, state))),
        ]);
        if (toolOutcomes.some(Boolean)) {
          finalReply = status || "Please answer the questions below.";
          break;
        }
        // A dispatched subagent may have asked the user itself (only
        // financial_modeling can). It records the request on the main channel
        // and pauses; the turn has to end here or the card never renders.
        // `status` was already recorded as this step's progress line, so the
        // final reply must be its own sentence rather than a repeat.
        if (tasks.length > 0 && state.userInputRequestForTurn(turn)?.status === "pending") {
          finalReply = "Please answer the questions below to continue.";
          break;
        }
        continue;
      }

      // --- skill branch ---
      if (stepObj.skill && validSkills.has(stepObj.skill)) {
        if (status) state.recordReply(status, false);
        state.record("orchestrator", "skill_invoke", { skill: stepObj.skill });
        // Sections + granted tools must be installed before invoke() runs: a
        // code-backed workflow can dispatch from inside invoke(), and a dispatch
        // that happened before the install would run without the skill's grant.
        const invoked = this.skills.get(stepObj.skill);
        if (invoked) {
          dispatcher.setSkillSections(invoked.agentSections);
          dispatcher.setSkillTools(invoked.tools);
        }
        skillResult = await this.skills.invoke(stepObj.skill, {
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          dispatcher,
          state,
        });
        state.record("orchestrator", "skill_result", {
          skill: skillResult.skill,
          summary: skillResult.summary,
          ...(skillResult.content ? { content: skillResult.content } : {}),
        });
        continue;
      }

      // --- terminal: no action requested → reply is the final answer ---
      finalReply = stepObj.reply;
      break;
    }

    if (!finalReply.trim()) {
      finalReply = state.turnResults(turn).length
        ? "Sorry — I ran into a problem while putting the results together. Please try again."
        : "Sorry — I couldn't complete that request. Please rephrase or try again.";
      state.record("orchestrator", "error", { scope: "main", message: "orchestrator produced no final reply" });
    }

    // The terminal reply event drives token + final + done frames via the projector.
    state.recordReply(finalReply, true);

    const result: OrchestratorResult = { response: finalReply };
    if (skillResult) result.skill_result = skillResult;
    return result;
  }

  /** One orchestrator-level tool call. Never throws: a failed tool is a
   *  `tool_result` the model can read and react to, not a dead turn. */
  private async runOrchestratorTool(
    call: OrchestratorToolCall,
    sessionId: string,
    agentId: string,
    state: SessionState,
  ): Promise<UserInputRequest | undefined> {
    const { name, input: toolInput } = call;
    state.record("orchestrator", "tool_use", { name, input: toolInput });
    try {
      const output = await this.tools.call(name, { ...toolInput }, { sessionId, agentId });
      const toolResultPayload: JsonObject = { name, summary: output.summary };
      if (output.generation_context) toolResultPayload.generation_context = output.generation_context as unknown as JsonObject;
      if (output.visualizations?.length) toolResultPayload.visualizations = output.visualizations;
      const normalizedError = normalizeToolError(output);
      if (normalizedError) toolResultPayload.error = normalizedError;
      state.record("orchestrator", "tool_result", toolResultPayload);
      if (output.user_input_request) {
        state.recordUserInputRequest(output.user_input_request);
        return output.user_input_request;
      }
    } catch (error) {
      state.record("orchestrator", "tool_result", {
        name,
        error: { code: "tool_error", message: error instanceof Error ? error.message : String(error) },
      });
    }
    return undefined;
  }
}
