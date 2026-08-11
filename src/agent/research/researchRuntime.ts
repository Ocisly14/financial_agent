// The Research controller's runtime (spec §4).
//
// ── Why this is a fresh runtime and not a second OrchestratorRuntime ───────
//
// `OrchestratorRuntime`'s allowed-tool set is a private hardcoded field
// (`orchestrator.ts:177`, `ORCHESTRATOR_DIRECT_TOOLS`). Giving the controller a
// different toolset through that class would mean editing it — and "the
// existing agent stays byte-identical" is the hard constraint of this whole
// phase (spec §1). Independence is also an explicit product requirement: the
// controller's subordinates are whole Topics, not subagents, so it has no
// dispatcher, no subagent registry and no skills.
//
// The price is that the step loop below looks structurally similar to
// `orchestrator.ts`'s. **That duplication is deliberate and accepted.** Do not
// extract a shared base class and do not "DRY up" the two — extracting a base
// class is editing the existing agent by another name, and the moment the two
// loops share code the constraint above is gone. If a reviewer reads the
// similarity as a defect: it was chosen, with this reasoning, on purpose.
//
// ── What is genuinely different here ──────────────────────────────────────
//
//   - Actions are tool calls only, and there can be SEVERAL in one step: the
//     concurrency-3 guard (§4.4) only means something if the controller can
//     drive three Topics at once, which means one step must be able to issue
//     three `ask_topic` calls.
//   - Member context is supplied in three layers (§4.2): a one-time roster, a
//     per-turn external delta, and `fetch_from_topic` on demand.
//   - The history projection is this file's own (`renderHistory`), not
//     `SessionState.projectForPrompt`. That projection drops `tool_result`
//     events from PRIOR turns — which for the Topic agent is right (a subagent
//     result is summarised into the reply) but here would throw away the
//     controller's entire record of what it asked its members and what they
//     answered.
//   - Frames: the driven Topic's own dispatch/tool_call/task_done frames are
//     never forwarded (§4.5). The Topic writes them to ITS session; this
//     session only carries the one compressed `topic_dispatch` line the
//     toolset emits.

import { formatList, PromptRenderer, type PromptTemplate } from "../../framework/prompt.ts";
import { maybeCompact } from "../../framework/contextCompaction.ts";
import type { SessionEvent, SessionRegistry, SessionState } from "../../framework/sessionState.ts";
import type { JsonObject, UserInputRequest, UserInputResponse } from "../../framework/types.ts";
import type { ModelRouter } from "../../infra/llm/provider.ts";
import type { SkillRegistry } from "../../framework/skill.ts";
import type { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { TopicChartPreferenceRow } from "../../infra/db/sqliteEventStore.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { buildIndexedTurns, turnCountOf } from "../topicDigest.ts";
import { renderExternalDelta, renderRoster, type MemberFacts } from "./memberContext.ts";
import { RESEARCH_TOOL_SPECS } from "./researchPrompt.ts";
import {
  requireRangeDays,
  ResearchToolset,
  type EditOverlayPatch,
  type MemberOp,
  type ResearchFrame,
  type ResearchToolStore,
  type TabOp,
  type TopicOrchestrator,
} from "./tools.ts";

/** Runaway-loop backstop, same intent (and same number) as the Topic agent's. */
const MAX_STEPS = 6;

/** How many tool calls from one step run at once. `ask_topic` is additionally
 *  capped at 3 by the toolset's own semaphore (§4.4); this is only a ceiling on
 *  a step that asks for an absurd number of cheap calls. */
const MAX_PARALLEL_TOOL_CALLS = 6;

/** Roster budget, per §4.2.1's "~200 tokens/member". */
const ROSTER_TOKENS_PER_MEMBER = 200;
/** Even a huge Research must not spend the whole window on its roster. */
const ROSTER_MAX_TOKENS = 4_000;

/** Prior-turn tool results are truncated in the history projection; the current
 *  turn's are not. Without this a Research with twenty `ask_topic` turns behind
 *  it re-sends every member reply verbatim on every step. */
const PRIOR_TOOL_SUMMARY_CHARS = 1_200;

/** Name under which a roster block is recorded on the session log. It is a
 *  `tool_result` because that is an already-valid (source, kind) pair that the
 *  SSE projector renders as ZERO frames — the roster is context for the model,
 *  not something to show the user. */
const ROSTER_RECORD_NAME = "research_roster";

const TOOL_NAMES = new Set(RESEARCH_TOOL_SPECS.map((spec) => spec.name));

export type ResearchRuntimeStore = ResearchToolStore;

export type ResearchRuntimeDeps = {
  prompt: PromptTemplate;
  modelRouter: ModelRouter;
  store: ResearchRuntimeStore;
  sessions: SessionRegistry;
  /** The EXISTING, untouched Topic orchestrator. `ask_topic` calls exactly the
   *  method `handleChat` calls for a human turn. */
  topicOrchestrator: TopicOrchestrator;
  tools: McpToolRegistry;
  skills: SkillRegistry;
};

export type ResearchRunInput = {
  agentId: string;
  researchId: string;
  researchName: string;
  userMessage: string;
  inputResponse?: UserInputResponse;
  /** Research-layer frames (§4.5). The caller writes them to the SSE stream;
   *  standard reply/token/final frames still come from `attachSse`. */
  emit: (frame: ResearchFrame) => void;
};

export type ResearchRunResult = { response: string };

type ToolCall = { name: string; input: JsonObject };
type ResearchStep = { reply: string; skill: string | null; toolCalls: ToolCall[] };

// ── step parsing ──────────────────────────────────────────────────────────

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i);
  const body = fenced?.[1];
  return body !== undefined ? body.trim() : trimmed;
}

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

function asToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { name?: unknown; input?: unknown };
  if (typeof raw.name !== "string" || !TOOL_NAMES.has(raw.name)) return null;
  const input = raw.input && typeof raw.input === "object" && !Array.isArray(raw.input)
    ? (raw.input as JsonObject)
    : ({} as JsonObject);
  return { name: raw.name, input };
}

/**
 * Parses one controller completion. Unparseable output degrades to "this text
 * is the final answer" rather than to a retry loop — the same failure posture
 * the Topic agent takes, for the same reason: a user waiting on a Research turn
 * would rather get prose than a spinner.
 *
 * Accepts both `tool_calls` (the documented form, an array so one step can
 * drive several Topics at once) and a single `tool_call` object, because models
 * reach for the singular form regardless of what the prompt says.
 */
export function parseResearchStep(text: string): ResearchStep {
  const cleaned = stripCodeFence(text);
  const json = extractJsonObject(cleaned);
  if (!json) return { reply: text.trim(), skill: null, toolCalls: [] };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { reply: text.trim(), skill: null, toolCalls: [] };
  }

  const reply = typeof raw.reply === "string" ? raw.reply : "";
  const skill = typeof raw.skill === "string" && raw.skill.trim() ? raw.skill.trim() : null;
  const candidates = Array.isArray(raw.tool_calls)
    ? raw.tool_calls
    : raw.tool_call
      ? [raw.tool_call]
      : [];

  return {
    reply,
    skill,
    toolCalls: candidates.map(asToolCall).filter((call): call is ToolCall => call !== null),
  };
}

// ── the runtime ───────────────────────────────────────────────────────────

export class ResearchRuntime {
  private readonly renderer = new PromptRenderer();
  private readonly prompt: PromptTemplate;
  private readonly modelRouter: ModelRouter;
  private readonly store: ResearchRuntimeStore;
  private readonly sessions: SessionRegistry;
  private readonly topicOrchestrator: TopicOrchestrator;
  private readonly tools: McpToolRegistry;
  private readonly skills: SkillRegistry;

  constructor(deps: ResearchRuntimeDeps) {
    this.prompt = deps.prompt;
    this.modelRouter = deps.modelRouter;
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.topicOrchestrator = deps.topicOrchestrator;
    this.tools = deps.tools;
    this.skills = deps.skills;
  }

  async run(input: ResearchRunInput): Promise<ResearchRunResult> {
    const state = await this.sessions.getOrCreate(input.researchId);
    if (input.inputResponse && !state.pendingUserInput(input.inputResponse.request_id)) {
      throw new Error(`user input request '${input.inputResponse.request_id}' is no longer pending`);
    }
    const turn = state.beginTurn(input.userMessage, input.inputResponse);
    await maybeCompact(state, this.modelRouter, turn);

    const toolset = new ResearchToolset({
      agentId: input.agentId,
      researchId: input.researchId,
      researchName: input.researchName,
      store: this.store,
      sessions: this.sessions,
      orchestrator: this.topicOrchestrator,
      modelRouter: this.modelRouter,
      emit: input.emit,
    });
    toolset.beginTurn();

    const { roster, externalDelta } = await this.buildMemberContext(input, state);
    const tools = formatList(RESEARCH_TOOL_SPECS);
    const researchSkills = this.skills.list("research");
    const skills = researchSkills.length
      ? formatList(researchSkills.map((skill) => ({ name: skill.name, description: skill.description })))
      : "(No skills are available.)";

    let finalReply = "";

    for (let step = 1; step <= MAX_STEPS; step++) {
      const rendered = this.renderer.render(this.prompt, {
        currentDate: new Date().toISOString().slice(0, 10),
        userMessage: input.userMessage,
        history: this.renderHistory(state, turn),
        roster,
        externalDelta,
        tools,
        skills,
      });

      let completionText: string;
      try {
        const completion = await this.modelRouter.generate(
          [
            { role: "system", content: rendered.system },
            { role: "user", content: rendered.prompt },
          ],
          { modelClass: "LARGE", temperature: 0.2, metadata: { mode: "research_controller" } },
        );
        completionText = completion.text;
        state.recordPromptTokens(completion.metrics.tokens_in);
      } catch (error) {
        state.record("orchestrator", "error", {
          scope: "main",
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      const parsed = parseResearchStep(completionText);
      const status = parsed.reply.trim();

      if (parsed.skill) {
        if (parsed.toolCalls.length > 0) {
          state.record("orchestrator", "error", {
            scope: "protocol",
            message:
              "skill is exclusive with tool_calls — invoke the skill alone, then act on its guidance in the next step",
          });
          continue;
        }
        const skill = this.skills.get(parsed.skill, "research");
        if (!skill) {
          const available = researchSkills.map((s) => s.name).join(", ") || "(none)";
          state.record("orchestrator", "error", {
            scope: "protocol",
            message: `unknown skill '${parsed.skill}'; available skills: ${available}`,
          });
          continue;
        }
        if (status) state.recordReply(status, false);
        state.record("orchestrator", "skill_invoke", { skill: skill.name });
        // The section has to land here: the ask_topic written next step is what carries it.
        toolset.setTopicSection(skill.topicSection ?? "");
        const result = await this.skills.invoke(skill.name, {
          sessionId: state.session_id,
          userMessage: input.userMessage,
          state,
        });
        state.record("orchestrator", "skill_result", {
          skill: result.skill,
          status: result.status,
          summary: result.summary,
          ...(result.content ? { content: result.content } : {}),
        });
        continue;
      }

      const askUserCalls = parsed.toolCalls.filter((call) => call.name === "ask_user");
      if (askUserCalls.length > 0 && (askUserCalls.length > 1 || parsed.toolCalls.length !== 1)) {
        state.record("orchestrator", "error", {
          scope: "protocol",
          message: "ask_user must be the only tool call in its step and may only be called once",
        });
        continue;
      }

      if (parsed.toolCalls.length === 0) {
        finalReply = parsed.reply;
        break;
      }

      const isAskingUser = askUserCalls.length === 1;
      if (status && !isAskingUser) state.recordReply(status, false);
      // Calls in one step run together: three `ask_topic`s issued at once is the
      // whole reason the concurrency guard exists.
      const outcomes = await mapWithConcurrency(parsed.toolCalls, MAX_PARALLEL_TOOL_CALLS, (call) =>
        this.invokeTool(toolset, state, input.agentId, call),
      );
      if (outcomes.some(Boolean)) {
        finalReply = status || "Please answer the questions below.";
        break;
      }
    }

    if (!finalReply.trim()) {
      finalReply = "Sorry — this turn didn't produce a result. Please try again, or rephrase.";
      state.record("orchestrator", "error", { scope: "main", message: "research controller produced no final reply" });
    }

    // Drives token + final + done frames through the SSE projector.
    state.recordReply(finalReply, true);
    return { response: finalReply };
  }

  // ── member context (§4.2) ───────────────────────────────────────────────

  /**
   * Builds the two injected member layers.
   *
   * The roster is rendered for a member on the ONE turn it first appears and
   * never again (§4.2.1) — including members added later by the user through
   * the UI, which the controller's own history would otherwise never mention.
   * "Already introduced" is read back off the session log, so it survives a
   * restart. The external delta then covers only members the controller has
   * already met.
   *
   * Digests are NOT generated here. Each Topic summarises itself in the
   * background (src/server/topicDigestScheduler.ts) and this layer reads the
   * result off the Topic row, so opening a Research costs no model calls beyond
   * its own turn — and a member that has never been opened in a Research still
   * arrives with a digest already written.
   */
  private async buildMemberContext(
    input: ResearchRunInput,
    state: SessionState,
  ): Promise<{ roster: string; externalDelta: string }> {
    const facts = await this.memberFacts(input.agentId, input.researchId);
    if (facts.length === 0) {
      return {
        roster: "(This Research has no members yet. Use create_topic to start a line of investigation, or edit_members to add an existing Topic.)",
        externalDelta: "",
      };
    }

    const introduced = this.introducedTopicIds(state);
    const newcomers = facts.filter((fact) => !introduced.has(fact.topicId));
    const known = facts.filter((fact) => introduced.has(fact.topicId));

    const roster = newcomers.length
      ? renderRoster(newcomers, Math.min(ROSTER_TOKENS_PER_MEMBER * newcomers.length, ROSTER_MAX_TOKENS))
      : "";
    if (roster) {
      state.record("orchestrator", "tool_result", {
        name: ROSTER_RECORD_NAME,
        summary: roster,
        topics: newcomers.map((fact) => fact.topicId),
      });
    }

    const externalDelta = renderExternalDelta(known);

    // Everything above has now been shown to the controller, so none of it is
    // "external" next turn (§4.2.3). Without this the same delta line would be
    // repeated every turn until the controller happened to drive that member.
    for (const fact of facts) {
      if (fact.turnCount > fact.seenThroughTurn) {
        this.store.setMemberSeenTurn(input.researchId, fact.topicId, fact.turnCount);
      }
    }

    return { roster, externalDelta };
  }

  /** Members already introduced in a previous roster block, read off the log. */
  private introducedTopicIds(state: SessionState): Set<string> {
    const seen = new Set<string>();
    for (const event of state.allEvents()) {
      if (event.kind !== "tool_result" || event.payload.name !== ROSTER_RECORD_NAME) continue;
      for (const topicId of (event.payload.topics as string[] | undefined) ?? []) seen.add(topicId);
    }
    return seen;
  }

  private async memberFacts(agentId: string, researchId: string): Promise<MemberFacts[]> {
    const members = this.store.listResearchMembers(researchId);
    if (members.length === 0) return [];

    const topics = new Map(this.store.listTopics(agentId).map((topic) => [topic.id, topic]));

    return mapWithConcurrency(members, 3, async (member): Promise<MemberFacts> => {
      const topic = topics.get(member.topicId);
      const turns = buildIndexedTurns(await this.sessions.loadEvents(member.topicId));
      const charts = this.store.listTopicCharts(member.topicId);
      return {
        topicId: member.topicId,
        name: topic?.name ?? member.topicId,
        leadSymbol: topic?.leadSymbol ?? null,
        chartSymbols: charts
          .filter((chart): chart is Extract<TopicChartPreferenceRow, { kind: "symbol" }> => chart.kind === "symbol" && !chart.hidden)
          .map((chart) => chart.symbol),
        turnCount: turnCountOf(turns),
        lastActivityMs: topic?.lastMessage?.createdAt ?? topic?.createdAt ?? 0,
        digest: topic?.summary ?? null,
        seenThroughTurn: member.seenThroughTurn,
      };
    });
  }

  // ── history projection ──────────────────────────────────────────────────

  /**
   * This session's own history. Deliberately not `projectForPrompt`: that one
   * drops prior-turn `tool_result` events, which here ARE the record of what
   * the controller asked each member and what it got back — the thing §4.2.1
   * says replaces a re-rendered roster.
   */
  private renderHistory(state: SessionState, turn: number): string {
    const compaction = state.compactionCache();
    const prior: string[] = [];
    const current: string[] = [];

    for (const event of state.allEvents()) {
      if (event.is_sidechain) continue;
      const isCurrent = event.turn === turn;
      const line = this.renderEventLine(event, isCurrent);
      if (!line) continue;
      (isCurrent ? current : prior).push(line);
    }

    const parts: string[] = [];
    if (compaction) {
      parts.push("[SUMMARY OF EARLIER CONVERSATION]", compaction.summaryText);
      const dataLines = compaction.preservedData.map(
        (entry) => `- turn ${entry.turn} (${entry.agent}): ${JSON.stringify(entry.data)}`,
      );
      if (dataLines.length) parts.push("", "[DATA PRESERVED FROM EARLIER CONVERSATION]", dataLines.join("\n"));
      parts.push("", "[RECENT CONVERSATION]");
    }
    parts.push(prior.length ? prior.join("\n") : "(No earlier conversation yet.)");
    if (current.length) parts.push("", "[CURRENT TURN PROGRESS]", current.join("\n"));
    return parts.join("\n");
  }

  private renderEventLine(event: SessionEvent, isCurrent: boolean): string | null {
    const payload = event.payload;
    switch (event.kind) {
      case "user_message":
        return `User: ${String(payload.content ?? "")}`;
      case "reply":
        if (payload.final !== true && !isCurrent) return null; // status lines of past turns are noise
        return `You: ${String(payload.content ?? "")}`;
      case "tool_use":
        return `[called ${String(payload.name ?? "tool")}] ${JSON.stringify(payload.input ?? {})}`;
      case "tool_result": {
        const name = String(payload.name ?? "tool");
        const error = payload.error as { message?: string } | undefined;
        if (error) return `[${name} failed] ${error.message ?? ""}`;
        const summary = String(payload.summary ?? "");
        const body = isCurrent ? summary : truncate(summary, PRIOR_TOOL_SUMMARY_CHARS);
        return name === ROSTER_RECORD_NAME ? `[MEMBER ROSTER]\n${body}` : `[${name} result]\n${body}`;
      }
      case "error":
        return `[runtime error] ${String(payload.message ?? "")}`;
      case "skill_result": {
        const raw = String(payload.content ?? "");
        // Same truncation the tool_result case applies, for the same reason: the
        // skill body is guidance for the turn that invoked it. Re-sending it in
        // full on every later step grows the prompt without adding anything the
        // controller has not already acted on.
        const content = isCurrent ? raw : truncate(raw, PRIOR_TOOL_SUMMARY_CHARS);
        const head = `[skill ${String(payload.skill ?? "")}] ${String(payload.summary ?? "")}`;
        return content ? `${head}\n${content}` : head;
      }
      default:
        return null;
    }
  }

  // ── tool invocation ─────────────────────────────────────────────────────

  /**
   * Runs one tool call and writes both the call and its result to the log.
   *
   * A tool that throws is recorded as a failed `tool_result` and the turn
   * continues: one member being unreachable is that member's failure, not the
   * Research's (§4.4). Bad arguments are reported back to the model in the same
   * shape, so it can correct itself on the next step rather than crash the turn.
   */
  private async invokeTool(toolset: ResearchToolset, state: SessionState, agentId: string, call: ToolCall): Promise<UserInputRequest | undefined> {
    state.record("orchestrator", "tool_use", { name: call.name, input: call.input });
    try {
      if (call.name === "ask_user") {
        const output = await this.tools.call("ask_user", call.input, { sessionId: state.session_id, agentId });
        const payload: JsonObject = { name: call.name, summary: output.summary };
        if (output.error) payload.error = output.error;
        state.record("orchestrator", "tool_result", payload);
        if (output.user_input_request) {
          state.recordUserInputRequest(output.user_input_request);
          return output.user_input_request;
        }
        return undefined;
      }
      const { summary, data } = await this.executeTool(toolset, call);
      const payload: JsonObject = { name: call.name, summary };
      if (data !== undefined) payload.data = data as JsonObject[string];
      state.record("orchestrator", "tool_result", payload);
    } catch (error) {
      state.record("orchestrator", "tool_result", {
        name: call.name,
        error: { code: "research_tool_error", message: error instanceof Error ? error.message : String(error) },
      });
    }
    return undefined;
  }

  private async executeTool(
    toolset: ResearchToolset,
    call: ToolCall,
  ): Promise<{ summary: string; data?: unknown }> {
    const input = call.input;

    switch (call.name) {
      case "ask_topic": {
        const topicId = requireString(input, "topic_id");
        const message = requireString(input, "message");
        const result = await toolset.askTopic(topicId, message);
        const summary =
          result.status === "ok"
            ? `[${result.topicName}] answered:\n${result.reply ?? ""}`
            : result.status === "needs_input"
              // Say plainly that this is an open question, not an empty answer —
              // otherwise the controller reads the gap as "no data" and fills it in.
              ? `[${result.topicName}] is waiting on the user's answer to a question of its own and did not report this turn. Do not substitute another member's figures for it; once the user answers, fetch_from_topic will have its reply.`
              : `[${result.topicName}] ${result.status} this turn: ${result.reason ?? "unknown reason"}`;
        return { summary, data: result };
      }

      case "create_topic": {
        const name = requireString(input, "name");
        const result = toolset.createTopic(name);
        return {
          summary: `Created Topic "${result.name}" (id: ${result.topicId}) and added it as a member. It has no history yet.`,
          data: result,
        };
      }

      case "fetch_from_topic": {
        const topicId = requireString(input, "topic_id");
        const need = requireString(input, "need");
        const result = await toolset.fetchFromTopic(topicId, need);
        return { summary: renderFetchResult(result), data: result };
      }

      case "focus": {
        const topicId = requireString(input, "topic_id");
        const symbol = typeof input.symbol === "string" ? input.symbol : undefined;
        const result = toolset.focus(topicId, symbol);
        return {
          summary: `Focus switched to ${topicId}${result.symbol ? ` · ${result.symbol}` : ""} (instantaneous, no persistent state changed).`,
          data: result,
        };
      }

      case "edit_tabs": {
        const topicId = requireString(input, "topic_id");
        const result = toolset.editTabs(topicId, parseTabOps(input.ops));
        return {
          summary: `${topicId}'s chart tabs are now: ${result.charts
            .filter((chart): chart is Extract<TopicChartPreferenceRow, { kind: "symbol" }> => chart.kind === "symbol")
            .map((chart) => chart.symbol)
            .join(", ") || "(empty)"}`,
          data: result,
        };
      }

      case "overlay": {
        const topicId = requireString(input, "topic_id");
        const symbols = parseSymbolsInput(input.symbols);
        const range = input.range === undefined || input.range === null
          ? undefined
          : requireRangeDays(input.range);
        const normalize = typeof input.normalize === "string" ? input.normalize : undefined;
        const result = toolset.overlay(topicId, symbols, range, normalize);
        return {
          summary: `Created overlay tab "${result.chart.overlay.symbols.join("+")}" (${result.chart.overlay.normalize}, ${result.chart.overlay.range}) on ${topicId}, selected.`,
          data: result,
        };
      }

      case "edit_overlay": {
        const topicId = requireString(input, "topic_id");
        const chartId = requireString(input, "chart_id");
        const patch = parseEditOverlayPatch(input);
        const result = toolset.editOverlay(topicId, chartId, patch);
        return {
          summary: `Overlay tab "${result.chart.overlay.symbols.join("+")}" on ${topicId} is now ${result.chart.overlay.normalize}, ${result.chart.overlay.range}.`,
          data: result,
        };
      }

      case "edit_members": {
        const result = toolset.editMembers(parseMemberOps(input.ops));
        return {
          summary: `This Research's members are now: ${result.members.join(", ") || "(empty)"}`,
          data: result,
        };
      }

      default:
        throw new Error(`unknown tool: ${call.name}`);
    }
  }
}

// ── argument parsing ──────────────────────────────────────────────────────

function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

/** Unknown ops are dropped rather than throwing: a step with three good ops and
 *  one typo should apply the three. */
function parseTabOps(value: unknown): TabOp[] {
  if (!Array.isArray(value)) throw new Error('"ops" is required and must be an array');
  const ops: TabOp[] = [];
  for (const entry of value) {
    const raw = entry as { op?: unknown; symbol?: unknown; range?: unknown };
    if (typeof raw?.symbol !== "string" || !raw.symbol.trim()) continue;
    const symbol = raw.symbol.trim();
    if (raw.op === "add") {
      const op: TabOp = { op: "add", symbol };
      if (raw.range !== undefined && raw.range !== null) op.range = requireRangeDays(raw.range);
      ops.push(op);
    } else if (raw.op === "remove") {
      ops.push({ op: raw.op, symbol });
    }
  }
  if (ops.length === 0) throw new Error('"ops" contained no valid operation');
  return ops;
}

/** Coarse pre-filter only — real validation (ticker regex, dedupe, 2-6 range)
 *  happens in `ResearchToolset.overlay` (design §2). This just makes sure we
 *  hand it an array of strings rather than throwing on a malformed shape. */
function parseSymbolsInput(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('"symbols" is required and must be an array of tickers');
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseEditOverlayPatch(input: JsonObject): EditOverlayPatch {
  const patch: EditOverlayPatch = {};
  if (input.range !== undefined && input.range !== null) patch.range = requireRangeDays(input.range);
  if (typeof input.normalize === "string") patch.normalize = input.normalize;
  return patch;
}

function parseMemberOps(value: unknown): MemberOp[] {
  if (!Array.isArray(value)) throw new Error('"ops" is required and must be an array');
  const ops: MemberOp[] = [];
  for (const entry of value) {
    const raw = entry as { op?: unknown; topic_id?: unknown; topicId?: unknown };
    const topicId = typeof raw?.topic_id === "string" ? raw.topic_id : typeof raw?.topicId === "string" ? raw.topicId : "";
    if (!topicId.trim()) continue;
    if (raw.op === "add" || raw.op === "remove") ops.push({ op: raw.op, topicId: topicId.trim() });
  }
  if (ops.length === 0) throw new Error('"ops" contained no valid operation');
  return ops;
}

// ── result rendering ──────────────────────────────────────────────────────

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…(truncated)`;
}

/**
 * Renders a `fetch_from_topic` result for the model. Excerpts go in VERBATIM —
 * every number the controller ever sees has to be the original text (§4.3.2),
 * and this is the last place that could quietly paraphrase one.
 */
function renderFetchResult(result: {
  framing: string;
  excerpts: Array<{ turn: number; user: string; reply: string }>;
  data: Array<{ index: number; turn: number; agent: string; data: unknown }>;
  charts: TopicChartPreferenceRow[];
  coverage: string;
}): string {
  const parts: string[] = [];
  if (result.framing) parts.push(result.framing);
  parts.push(`Coverage: ${result.coverage}`);
  for (const excerpt of result.excerpts) {
    parts.push(`[turn ${excerpt.turn}]\nUser: ${excerpt.user}\nReply: ${excerpt.reply}`);
  }
  for (const entry of result.data) {
    parts.push(`[data ${entry.index}] turn ${entry.turn} · ${entry.agent} · ${JSON.stringify(entry.data)}`);
  }
  const symbolCharts = result.charts.filter(
    (chart): chart is Extract<TopicChartPreferenceRow, { kind: "symbol" }> => chart.kind === "symbol",
  );
  if (symbolCharts.length) {
    parts.push(`Related charts: ${symbolCharts.map((chart) => chart.symbol).join(", ")}`);
  }
  if (result.excerpts.length === 0 && result.data.length === 0) {
    parts.push("(No content found relevant to this question.)");
  }
  return parts.join("\n\n");
}
