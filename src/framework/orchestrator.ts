import { formatList, PromptRenderer } from "./prompt.ts";
import type { SkillRegistry } from "./skill.ts";
import type { Dispatcher } from "./dispatcher.ts";
import type { SubagentRegistry } from "./subagent.ts";
import type { ModelRouter } from "../infra/llm/provider.ts";
import type { SessionRegistry } from "./sessionState.ts";
import { maybeCompact } from "./contextCompaction.ts";
import type { McpToolRegistry } from "../../mcp_tools/toolRegistry.ts";
import type { PromptTemplate } from "./prompt.ts";
import type { AgentKind, JsonObject, OrchestratorStep, SkillResult, TaskRequest } from "./types.ts";

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
  const endMatch = rest.match(/"\s*(?:,\s*"(?:dispatch|skill|tool_call)"|}\s*$)/);
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
  const rawFallback: OrchestratorStep = { reply: text.trim(), dispatch: null, skill: null, tool_call: null };
  const json = extractJsonObject(cleaned);

  if (json) {
    try {
      const raw = JSON.parse(json) as Record<string, unknown>;
      const reply = typeof raw.reply === "string" ? raw.reply : "";
      const dispatch = Array.isArray(raw.dispatch) ? (raw.dispatch as TaskRequest[]) : null;
      const skill = typeof raw.skill === "string" && raw.skill.trim() ? raw.skill.trim() : null;
      const toolCall =
        raw.tool_call && typeof raw.tool_call === "object" && typeof (raw.tool_call as { name?: unknown }).name === "string"
          ? (raw.tool_call as { name: string; input: JsonObject })
          : null;
      return { reply, dispatch, skill, tool_call: toolCall };
    } catch {
      // Fall through to salvage — most often a truncated or lightly-malformed
      // JSON string (raw newlines, trailing comma) that strict parsing rejects.
    }
  }

  // No complete object (truncated stream) or JSON.parse threw. Recover the
  // reply text so the user sees markdown, not a raw `{"reply": ...}` dump.
  const salvaged = salvageReply(cleaned);
  if (salvaged !== null) {
    return { reply: salvaged, dispatch: null, skill: null, tool_call: null };
  }
  return rawFallback;
}

export type OrchestratorInput = {
  sessionId: string;
  userMessage: string;
};

/** Result of a turn. Task results / artifacts are read from the session log
 *  (via the SSE projector / state.turnResults), not returned here. */
export type OrchestratorResult = {
  response: string;
  skill_result?: SkillResult;
};

/** Tools the orchestrator can call directly (by name). */
const ORCHESTRATOR_DIRECT_TOOLS = new Set<string>();

function normalizeToolError(output: { summary: string; error?: { code: string; message: string } }): { code: string; message: string } | undefined {
  if (output.error) return output.error;
  const summary = output.summary.trim();
  if (/^(.*\bfailed\b|failed\b|.*\berror\b|error\b|missing\b|invalid\b|unable\b|no token found\b)/i.test(summary)) {
    return { code: "tool_failed", message: summary };
  }
  return undefined;
}

export class OrchestratorRuntime {
  private readonly renderer = new PromptRenderer();
  private readonly prompt: PromptTemplate;
  private readonly modelRouter: ModelRouter;
  private readonly dispatcherFactory: (sessionId: string) => Dispatcher;
  private readonly subagents: SubagentRegistry;
  private readonly skills: SkillRegistry;
  private readonly tools: McpToolRegistry;
  private readonly sessions: SessionRegistry;
  private readonly orchestratorTools = ORCHESTRATOR_DIRECT_TOOLS;

  constructor(
    prompt: PromptTemplate,
    modelRouter: ModelRouter,
    dispatcherFactory: (sessionId: string) => Dispatcher,
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
    const turn = state.beginTurn(input.userMessage);
    await maybeCompact(state, this.modelRouter, turn);

    const dispatcher = this.dispatcherFactory(input.sessionId);
    const validAgents = new Set(this.subagents.list().map((agent) => agent.name));
    const validSkills = new Set(this.skills.list().map((skill) => skill.name));

    let skillResult: SkillResult | undefined;
    let finalReply = "";

    for (let step = 1; step <= MAX_STEPS; step++) {
      const proj = state.projectForPrompt(turn);
      const history = proj.currentTurnProgress
        ? `${proj.conversationSoFar}\n\n[CURRENT TURN PROGRESS]\n${proj.currentTurnProgress}`
        : proj.conversationSoFar;

      const rendered = this.renderer.render(this.prompt, {
        currentDate: new Date().toISOString().slice(0, 10),
        userMessage: input.userMessage,
        history,
        subagents: formatList(this.subagents.list().map((a) => ({ name: a.name, description: a.description }))),
        skills: formatList(this.skills.list().map((s) => ({ name: s.name, description: s.description }))),
        tools: formatList(this.tools.list()
          .filter((t) => this.orchestratorTools.has(t.name))
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

      // --- dispatch branch (highest priority of the mutually-exclusive actions) ---
      const tasks: TaskRequest[] = (stepObj.dispatch ?? [])
        .filter((t) => t && typeof t.task === "string" && t.task.trim() && validAgents.has(t.agent as AgentKind))
        .map((t) => ({ agent: t.agent as AgentKind, task: t.task.trim() }));

      if (tasks.length > 0) {
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
        if (status) state.recordReply(status, false);
        await dispatcher.dispatch(tasks); // subagents write their own task_result events
        continue;
      }

      // --- skill branch ---
      if (stepObj.skill && validSkills.has(stepObj.skill)) {
        if (status) state.recordReply(status, false);
        state.record("orchestrator", "skill_invoke", { skill: stepObj.skill });
        skillResult = await this.skills.invoke(stepObj.skill, {
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          dispatcher,
          state,
        });
        continue;
      }

      // --- direct tool_call branch (reserved for orchestrator-level tools) ---
      if (stepObj.tool_call && this.orchestratorTools.has(stepObj.tool_call.name)) {
        if (status) state.recordReply(status, false);
        const { name, input: toolInput } = stepObj.tool_call;
        state.record("orchestrator", "tool_use", { name, input: toolInput });
        try {
          const output = await this.tools.call(name, { ...toolInput }, { sessionId: input.sessionId });
          const toolResultPayload: JsonObject = { name, summary: output.summary };
          if (output.generation_context) toolResultPayload.generation_context = output.generation_context as unknown as JsonObject;
          if (output.visualizations?.length) toolResultPayload.visualizations = output.visualizations;
          const normalizedError = normalizeToolError(output);
          if (normalizedError) toolResultPayload.error = normalizedError;
          state.record("orchestrator", "tool_result", toolResultPayload);
        } catch (error) {
          state.record("orchestrator", "tool_result", { name, error: { code: "tool_error", message: error instanceof Error ? error.message : String(error) } });
        }
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
}
