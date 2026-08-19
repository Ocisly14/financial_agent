import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../framework/ids.ts";
import { attachSse } from "../infra/events/sseProjector.ts";
import type { FinancialAgentApp } from "../agent/createApp.ts";
import type { TopicChartPreferenceRow, TopicCategory } from "../infra/db/sqliteEventStore.ts";
import { asTopicCategory, TOPIC_CATEGORIES } from "../infra/db/sqliteEventStore.ts";
import type { TaskResult, UserInputAnswer, UserInputRequest, UserInputResponse } from "../framework/types.ts";
import { handleStockQuote, parseRangeDays } from "./stockMarketRoutes.ts";
import { handleStockQuoteStream } from "./quoteStreamRoute.ts";
import { handleLinkPreview } from "./linkPreview.ts";
import { projectChatHistory } from "./chatHistory.ts";
import { getModelContext, listTopicModels } from "./financialModelRoutes.ts";
import { getDefaultFinancialModelToolDeps } from "../../mcp_tools/financial-model/financialModelTools.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

type ActiveWorkflow = { kind: "task_chain"; startedAt: number; sessionId?: string };
const activeWorkflows = new Map<string, ActiveWorkflow>();

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Agent-Id");
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonOk(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: false, error: message }));
}

function findApprovalContext(
  app: FinancialAgentApp,
  threadId: string | undefined,
  approvalId: string | undefined,
) {
  if (!approvalId) return undefined;
  if (threadId) {
    const state = app.sessions.get(threadId);
    const pending = state?.pendingApproval(approvalId);
    if (state && pending) {
      const event = [...state.allEvents()].reverse().find(
        (candidate) => candidate.kind === "approval_required" && candidate.payload.approval_id === approvalId,
      );
      if (event) return { state, event, payload: pending.payload };
    }
  }
  return app.sessions.findPendingApproval(approvalId);
}

function recordApprovalTaskResult(
  approvalContext: ReturnType<typeof findApprovalContext>,
  approvalTaskId: string | undefined,
  approvalId: string | undefined,
  decision: string,
  result: TaskResult,
): void {
  if (!approvalContext || !approvalId || !approvalTaskId) return;
  approvalContext.state.record(
    "trading_operations",
    "approval_resolved",
    { approval_id: approvalId, decision, summary: result.summary },
    { parent: approvalContext.event.event_id },
  );
  approvalContext.state.recordTaskResult("trading_operations", approvalTaskId, result);
}

function sseWrite(res: http.ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

type ChatBody = {
  message?: string;
  sessionId?: string;
  /** The model currently open in the caller's workspace. Advisory only: the
   * agent still decides whether that model is the right one for the request. */
  activeModelId?: unknown;
  inputResponse?: {
    requestId?: unknown;
    answers?: unknown;
  };
};

/** Long enough for a sentence or two of "none of these, I meant…", short enough
 *  that a pasted document cannot enter the turn through the answer card. */
const MAX_FREE_TEXT = 500;

export function validateUserInputAnswers(
  request: UserInputRequest,
  rawAnswers: unknown,
): { response: UserInputResponse; message: string } | { error: string } {
  if (!Array.isArray(rawAnswers)) return { error: "inputResponse.answers must be an array" };

  const byQuestion = new Map<string, { selected: string[]; freeText?: string }>();
  for (const raw of rawAnswers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: "each input response answer must be an object" };
    }
    const answer = raw as { questionId?: unknown; selectedOptionIds?: unknown; freeText?: unknown };
    if (typeof answer.questionId !== "string" || !Array.isArray(answer.selectedOptionIds)) {
      return { error: "each answer requires questionId and selectedOptionIds" };
    }
    if (byQuestion.has(answer.questionId)) return { error: `duplicate answer for question '${answer.questionId}'` };
    if (!answer.selectedOptionIds.every((id): id is string => typeof id === "string")) {
      return { error: `selectedOptionIds for '${answer.questionId}' must contain only strings` };
    }
    if (new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length) {
      return { error: `selectedOptionIds for '${answer.questionId}' must be unique` };
    }
    if (answer.freeText !== undefined && typeof answer.freeText !== "string") {
      return { error: `freeText for '${answer.questionId}' must be a string` };
    }
    // Whitespace-only is the same as never having typed: it must not consume a
    // selection slot, and it must not reach the agent as an empty quotation.
    const freeText = typeof answer.freeText === "string" ? answer.freeText.trim() : "";
    if (freeText.length > MAX_FREE_TEXT) {
      return { error: `freeText for '${answer.questionId}' must be at most ${MAX_FREE_TEXT} characters` };
    }
    byQuestion.set(answer.questionId, { selected: answer.selectedOptionIds, ...(freeText ? { freeText } : {}) });
  }

  if (byQuestion.size !== request.questions.length) {
    return { error: "answers must include every question exactly once" };
  }

  const answers: UserInputAnswer[] = [];
  const lines: string[] = [];
  for (const question of request.questions) {
    const answer = byQuestion.get(question.id);
    if (!answer) return { error: `missing answer for question '${question.id}'` };
    const { selected, freeText } = answer;
    // Free text is a selection, not an annotation on one: on a single-select
    // question typing an unlisted answer replaces the listed one.
    const count = selected.length + (freeText ? 1 : 0);
    if (count < question.min_selections || count > question.max_selections) {
      return {
        error: `question '${question.id}' requires ${question.min_selections}-${question.max_selections} selections`,
      };
    }
    const options = new Map(question.options.map((option) => [option.id, option]));
    const unknown = selected.find((id) => !options.has(id));
    if (unknown) return { error: `unknown option '${unknown}' for question '${question.id}'` };
    answers.push({
      question_id: question.id,
      selected_option_ids: selected,
      ...(freeText ? { free_text: freeText } : {}),
    });
    const parts = selected.map((id) => options.get(id)!.label);
    // Quoted and labelled so the agent can tell the user's own words from a
    // label it wrote itself.
    if (freeText) parts.push(`Other — "${freeText}"`);
    lines.push(`${question.question}: ${parts.join(", ")}`);
  }

  return {
    response: { request_id: request.request_id, answers },
    message: lines.join("\n"),
  };
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
): Promise<void> {
  let body: ChatBody;
  try {
    body = JSON.parse(await readBody(req)) as ChatBody;
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }

  if (body.inputResponse && !body.sessionId) {
    return jsonError(res, 400, "sessionId is required for inputResponse");
  }
  const sessionId = body.sessionId ?? newId("sess");
  const tenantId = (req.headers["x-agent-id"] as string | undefined) ?? "default";
  const state = await app.sessions.getOrCreate(sessionId);

  let message: string;
  let inputResponse: UserInputResponse | undefined;
  if (body.inputResponse) {
    const requestId = body.inputResponse.requestId;
    if (typeof requestId !== "string" || !requestId.trim()) {
      return jsonError(res, 400, "inputResponse.requestId is required");
    }
    const requestView = state.userInputRequest(requestId);
    if (!requestView) return jsonError(res, 404, "user input request not found");
    if (requestView.status !== "pending") return jsonError(res, 409, `user input request is ${requestView.status}`);
    const request = state.pendingUserInput(requestId)!;
    const validated = validateUserInputAnswers(request, body.inputResponse.answers);
    if ("error" in validated) return jsonError(res, 400, validated.error);
    inputResponse = validated.response;
    message = validated.message;
  } else {
    message = (body.message ?? "").trim();
    if (!message) return jsonError(res, 400, "message is required");
  }

  // A Research id is also its session id (spec §3), exactly like a Topic id.
  // So the ONE thing that decides which runtime handles this turn is whether a
  // `researches` row exists for it. Critically, a Research session must NOT go
  // through `ensureTopic`: that would insert a phantom `chat_rooms` row with
  // the same id, and the Research would then show up in the Topic sidebar and
  // shadow itself.
  const research = app.eventStore.getResearch(tenantId, sessionId);
  if (!research) app.eventStore.ensureTopic(tenantId, sessionId, defaultRoomName());

  let activeModel: {
    modelId: string;
    topicId: string;
    symbol: string;
    createdAt: string;
    updatedAt: string;
    currentRevision: number;
    lifecycleStage: string;
  } | undefined;
  if (body.activeModelId !== undefined) {
    if (typeof body.activeModelId !== "string" || !body.activeModelId.trim()) {
      return jsonError(res, 400, "activeModelId must be a non-empty string");
    }
    const model = getDefaultFinancialModelToolDeps().modelStore.getMeta(body.activeModelId);
    if (!model) return jsonError(res, 404, "active financial model not found");
    if (model.ownerTenantId !== tenantId) return jsonError(res, 403, "active financial model belongs to another agent");
    const belongsToSession = research
      ? app.eventStore.listResearchMembers(sessionId).some((member) => member.topicId === model.originSessionId)
      : model.originSessionId === sessionId;
    if (!belongsToSession) return jsonError(res, 400, "active financial model is not part of this workspace");
    activeModel = {
      modelId: model.modelId,
      topicId: model.originSessionId,
      symbol: model.symbol,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
      currentRevision: model.currentRevision,
      lifecycleStage: model.lifecycleStage,
    };
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Session-Id": sessionId,
  });

  const keepaliveMs = Number.parseInt(process.env["SSE_KEEPALIVE_INTERVAL"] ?? "15000", 10);
  const keepalive = setInterval(() => res.write(": ping\n\n"), keepaliveMs);
  const unsubscribe = attachSse(state, (frame) => sseWrite(res, frame));
  activeWorkflows.set(tenantId, { kind: "task_chain", startedAt: Date.now(), sessionId });

  try {
    if (research) {
      await app.researchRuntime.run({
        tenantId,
        researchId: sessionId,
        researchName: research.name,
        userMessage: message,
        ...(inputResponse ? { inputResponse } : {}),
        ...(activeModel ? { activeModel } : {}),
        // §4.5: the driven Topic's own dispatch / tool_call / task_done frames
        // are never forwarded here — they belong to that Topic's stream. What
        // reaches this stream is the one compressed line the toolset emits.
        emit: (frame) => sseWrite(res, { type: frame.name, ...frame.data }),
      });
      // `appendEvent` bumps `chat_rooms.updated_at`, which a Research has no row
      // in; without this the sidebar would order Researches by creation only.
      app.eventStore.renameResearch(tenantId, sessionId, research.name);
    } else {
      await app.orchestrator.run({
        tenantId,
        sessionId,
        userMessage: message,
        ...(inputResponse ? { inputResponse } : {}),
        ...(activeModel ? { activeModel } : {}),
      });
    }
  } catch (error) {
    sseWrite(res, { type: "error", scope: "main", message: String(error) });
  } finally {
    clearInterval(keepalive);
    unsubscribe();
    activeWorkflows.delete(tenantId);
    // The turn is over — the one moment at which this Topic's history is a
    // complete thought. Arming the debounce here (rather than when the user
    // sent the message) is what stops the summariser reading a half-streamed
    // reply. Research sessions are excluded: they have no `chat_rooms` row.
    if (!research) app.topicDigests.schedule(sessionId);
    res.end();
  }
}

async function handleChatHistory(
  res: http.ServerResponse,
  app: FinancialAgentApp,
  sessionId: string,
  searchParams: URLSearchParams,
): Promise<void> {
  const allMessages = projectChatHistory(await app.sessions.loadEvents(sessionId));
  const requestedLimit = Number.parseInt(searchParams.get("limit") ?? "200", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 200;
  const before = searchParams.get("before");
  const beforeIndex = before ? allMessages.findIndex((message) => message.id === before) : -1;
  const end = beforeIndex >= 0 ? beforeIndex : allMessages.length;
  const start = Math.max(0, end - limit);
  const messages = allMessages.slice(start, end);
  jsonOk(res, { sessionId, messages, hasMore: start > 0, oldestId: messages[0]?.id });
}

function defaultRoomName(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `Chat ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

async function handleCreateTopic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  tenantId: string,
): Promise<void> {
  let body: { name?: string } = {};
  const rawBody = await readBody(req);
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as { name?: string };
    } catch {
      return jsonError(res, 400, "Invalid JSON body");
    }
  }
  const topicId = newId("room");
  const topic = app.eventStore.createTopic(tenantId, topicId, body.name?.trim() || defaultRoomName());
  jsonOk(res, { success: true, topic });
}

async function handleUpdateTopic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  tenantId: string,
  topicId: string,
): Promise<void> {
  let body: { name?: string; category?: string | null };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "invalid json");
  }

  const patch: { name?: string; category?: TopicCategory | null } = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return jsonError(res, 400, "name must not be empty");
    patch.name = name;
  }
  if (body.category !== undefined) {
    // `null` is the "back to automatic" signal, not an invalid category — it
    // clears the lock and lets the next digest choose again.
    if (body.category !== null && asTopicCategory(body.category) === null) {
      return jsonError(res, 400, `category must be null or one of: ${TOPIC_CATEGORIES.join(", ")}`);
    }
    patch.category = body.category === null ? null : asTopicCategory(body.category);
  }

  if (!app.eventStore.updateTopic(tenantId, topicId, patch)) {
    return jsonError(res, 404, "topic not found");
  }
  jsonOk(res, { success: true, topic: { id: topicId, ...patch } });
}

// Byte-identical to the ticker regex in client/src/lib/chartWorkspace.ts's `ticker()` — a
// mismatch here would let the frontend display a symbol the backend refuses to store.
const TICKER_PATTERN = /^[A-Z][A-Z.-]{0,5}$/;

function normalizeTicker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const symbol = value.trim().toUpperCase();
  return TICKER_PATTERN.test(symbol) ? symbol : undefined;
}

/** Same rules as chartWorkspace.ts's overlay parsing (design §2): dedupe, keep 2-6 valid
 *  tickers (truncating past 6 rather than rejecting), fall back to "pct" for an unrecognised
 *  normalize value. Returns undefined when fewer than 2 valid symbols survive. */
function normalizeOverlaySymbols(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const candidate of value) {
    const symbol = normalizeTicker(candidate);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  const truncated = symbols.slice(0, 6);
  return truncated.length >= 2 ? truncated : undefined;
}

function normalizeMode(value: unknown): "pct" | "index100" {
  return value === "index100" ? "index100" : "pct";
}

/** The window an overlay gets when neither the row nor the request names one. */
const DEFAULT_OVERLAY_RANGE_DAYS = 252;

/**
 * A range that is absent stays absent (null means "follow the derived range");
 * a range that is PRESENT must be a whole number of trading days within the
 * servable window, or the whole write is rejected.
 *
 * This is the boundary the original bug walked straight through: an unknown
 * "6M" was stored verbatim and every reader downstream quietly degraded it to
 * a one-day intraday chart. Rejecting here means nothing downstream ever has
 * to guess.
 */
function chartRange(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  return parseRangeDays(value) ?? "invalid";
}

/**
 * Validates a whole `charts` payload into storable rows. Exported for tests:
 * the reject-on-write posture is the point of this change, so it needs
 * coverage without standing up an HTTP server.
 */
export function parseTopicChartRows(
  charts: unknown[],
  makeId: () => string = () => newId("chart"),
): { rows: TopicChartPreferenceRow[] } | { error: string } {
  const rows: TopicChartPreferenceRow[] = [];
  for (const [index, candidate] of charts.entries()) {
    const item = candidate as Record<string, unknown>;
    const range = chartRange(item?.range);
    if (range === "invalid") return { error: `invalid range at index ${index}` };
    const hidden = item?.hidden === true;
    const sortOrder = typeof item?.sortOrder === "number" ? item.sortOrder : index;

    if (item?.kind === "overlay") {
      const overlay = (item as { overlay?: Record<string, unknown> }).overlay;
      const symbols = normalizeOverlaySymbols(overlay?.symbols);
      if (!symbols) return { error: `invalid overlay at index ${index}` };
      const requested = chartRange(overlay?.range);
      if (requested === "invalid") return { error: `invalid overlay range at index ${index}` };
      rows.push({
        id: makeId(),
        kind: "overlay",
        overlay: {
          symbols,
          range: requested ?? range ?? DEFAULT_OVERLAY_RANGE_DAYS,
          normalize: normalizeMode(overlay?.normalize),
        },
        range,
        hidden,
        sortOrder,
      });
      continue;
    }

    const symbol = normalizeTicker(item?.symbol);
    if (!symbol) return { error: `invalid symbol at index ${index}` };
    rows.push({ id: makeId(), kind: "symbol", symbol, range, hidden, sortOrder });
  }
  return { rows };
}

async function handleReplaceTopicCharts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  topicId: string,
): Promise<void> {
  let body: { charts?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "invalid json");
  }
  if (!Array.isArray(body.charts)) return jsonError(res, 400, "charts must be an array");

  const parsed = parseTopicChartRows(body.charts);
  if ("error" in parsed) return jsonError(res, 400, parsed.error);

  app.eventStore.replaceTopicCharts(topicId, parsed.rows);
  jsonOk(res, { success: true, charts: app.eventStore.listTopicCharts(topicId) });
}

// ── Research routes (spec §8) ──────────────────────────────────────────────
//
// A Research groups several Topics and compares them. Its id is also its
// session id, so `POST /api/chat` with a research id talks to the controller
// (see handleChat). Membership is always written as a WHOLE SET — the client
// sends the list it wants, the store keeps each surviving member's digest and
// seen marker so a membership edit never re-bills a model call.

/** Members resolved to the same TopicSummary shape the Topic routes return,
 *  in membership order. A member whose Topic was deleted is skipped rather
 *  than returned as a hole. */
function researchMembers(app: FinancialAgentApp, tenantId: string, researchId: string) {
  const topics = new Map(app.eventStore.listTopics(tenantId).map((topic) => [topic.id, topic]));
  return app.eventStore
    .listResearchMembers(researchId)
    .map((member) => topics.get(member.topicId))
    .filter((topic): topic is NonNullable<typeof topic> => topic !== undefined);
}

/** §7.4: an unnamed Research is named after what it compares. */
function defaultResearchName(app: FinancialAgentApp, tenantId: string, topicIds: string[]): string {
  const topics = new Map(app.eventStore.listTopics(tenantId).map((topic) => [topic.id, topic]));
  const labels = topicIds
    .map((topicId) => topics.get(topicId))
    .filter((topic): topic is NonNullable<typeof topic> => topic !== undefined)
    .map((topic) => topic.leadSymbol ?? topic.name);
  return labels.length ? labels.join(" · ") : "New Research";
}

async function handleCreateResearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  tenantId: string,
): Promise<void> {
  let body: { name?: string; topicIds?: unknown } = {};
  const rawBody = await readBody(req);
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as { name?: string; topicIds?: unknown };
    } catch {
      return jsonError(res, 400, "invalid json");
    }
  }
  const topicIds = Array.isArray(body.topicIds)
    ? body.topicIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  const researchId = newId("research");
  const name = body.name?.trim() || defaultResearchName(app, tenantId, topicIds);
  const research = app.eventStore.createResearch(tenantId, researchId, name);
  if (topicIds.length) app.eventStore.replaceResearchMembers(researchId, topicIds);

  jsonOk(res, {
    success: true,
    research: { ...research, memberCount: topicIds.length },
    members: researchMembers(app, tenantId, researchId),
  });
}

async function handleUpdateResearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  tenantId: string,
  researchId: string,
): Promise<void> {
  let body: { name?: string };
  try {
    body = JSON.parse(await readBody(req)) as { name?: string };
  } catch {
    return jsonError(res, 400, "invalid json");
  }
  if (body.name === undefined) return jsonError(res, 400, "name is required");
  const name = body.name.trim();
  if (!name) return jsonError(res, 400, "name must not be empty");
  if (!app.eventStore.renameResearch(tenantId, researchId, name)) {
    return jsonError(res, 404, "research not found");
  }
  jsonOk(res, { success: true, research: app.eventStore.getResearch(tenantId, researchId) });
}

async function handleReplaceResearchMembers(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  tenantId: string,
  researchId: string,
): Promise<void> {
  if (!app.eventStore.getResearch(tenantId, researchId)) return jsonError(res, 404, "research not found");

  let body: { topicIds?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { topicIds?: unknown };
  } catch {
    return jsonError(res, 400, "invalid json");
  }
  if (!Array.isArray(body.topicIds)) return jsonError(res, 400, "topicIds must be an array");

  // Only Topics that actually belong to this agent, de-duplicated, order kept.
  const known = new Set(app.eventStore.listTopics(tenantId).map((topic) => topic.id));
  const topicIds: string[] = [];
  for (const candidate of body.topicIds) {
    if (typeof candidate !== "string" || !known.has(candidate) || topicIds.includes(candidate)) continue;
    topicIds.push(candidate);
  }

  app.eventStore.replaceResearchMembers(researchId, topicIds);
  jsonOk(res, { success: true, members: researchMembers(app, tenantId, researchId) });
}

async function handleStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const safePath = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  const filePath = path.join(CLIENT_DIST, safePath);
  if (!path.resolve(filePath).startsWith(CLIENT_DIST)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(safePath)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    try {
      const content = await fs.readFile(path.join(CLIENT_DIST, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }
}

async function activateStrategy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  id: string,
): Promise<void> {
  const body = JSON.parse(await readBody(req)) as {
    decision?: string;
    threadId?: string;
    approvalId?: string;
  };
  const { loadStrategy, saveStrategy } = await import("../trading/persistence/strategyStore.ts");
  const strategy = await loadStrategy(id);
  if (!strategy) return jsonError(res, 404, "not_found");
  if (strategy.status !== "pending_approval") {
    return jsonError(res, 409, `cannot activate from status '${strategy.status}'`);
  }

  const rejected = body.decision === "reject";
  strategy.status = rejected ? "draft" : "active";
  await saveStrategy(strategy);
  // The monitor idles at a slow heartbeat when nothing is active; this is the
  // moment that stops being true.
  if (!rejected) {
    const { wakeMonitor } = await import("../trading/strategyMonitor.ts");
    wakeMonitor();
  }
  const approvalId = body.approvalId ?? id;
  const approvalContext = findApprovalContext(app, body.threadId, approvalId);
  const approvalTaskId = approvalContext?.event.parent_event_id ?? undefined;
  const summary = rejected
    ? `Strategy ${id} activation rejected. Strategy returned to draft.`
    : `Strategy ${id} activated. The monitor may now evaluate and record matching paper/shadow phases.`;
  recordApprovalTaskResult(approvalContext, approvalTaskId, approvalId, rejected ? "rejected" : "approved", {
    task_id: approvalTaskId ?? "unknown",
    agent: "trading_operations",
    status: rejected ? "failed" : "ok",
    summary,
    ...(rejected ? { error: { code: "approval_rejected", message: summary } } : {}),
    generation_context: {
      prompt: rejected
        ? "The user rejected strategy activation. Tell the user the strategy is back in draft."
        : "The user approved strategy activation. Tell the user the strategy is active.",
      data: { strategy_id: id, status: strategy.status, rejected },
    },
  });
  jsonOk(res, { success: true, status: strategy.status });
}

export function createHttpServer(app: FinancialAgentApp): http.Server {
  return http.createServer(async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname, searchParams } = url;
    const method = req.method ?? "GET";

    try {
      if (method === "POST" && pathname === "/api/chat") return await handleChat(req, res, app);

      const historyMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (method === "GET" && historyMatch) {
        return await handleChatHistory(res, app, decodeURIComponent(historyMatch[1]!), searchParams);
      }

      const topicsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topics$/);
      if (topicsMatch) {
        const tenantId = decodeURIComponent(topicsMatch[1]!);
        if (method === "GET") {
          jsonOk(res, { success: true, topics: app.eventStore.listTopics(tenantId) });
          // Backstop for digests a restart lost, AFTER the response is out so
          // the sidebar never waits on a model call. Throttled inside, because
          // the client repeats this poll every 30s per open tab.
          void app.topicDigests.catchUp(tenantId);
          return;
        }
        if (method === "POST") return await handleCreateTopic(req, res, app, tenantId);
      }

      const topicModelsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topics\/([^/]+)\/models$/);
      if (topicModelsMatch && method === "GET") {
        const result = listTopicModels(
          { modelStore: getDefaultFinancialModelToolDeps().modelStore },
          decodeURIComponent(topicModelsMatch[1]!),
          decodeURIComponent(topicModelsMatch[2]!),
        );
        return jsonOk(res, { success: true, ...result.body });
      }

      const financialModelMatch = pathname.match(/^\/api\/financial-models\/([^/]+)$/);
      if (financialModelMatch && method === "GET") {
        const financialDeps = getDefaultFinancialModelToolDeps();
        const result = getModelContext(
          { modelStore: financialDeps.modelStore, sourceReviewStore: financialDeps.sourceReviewStore },
          decodeURIComponent(financialModelMatch[1]!),
        );
        if (result.status === 404) return jsonError(res, 404, result.body.error);
        return jsonOk(res, { success: true, ...result.body });
      }

      const topicChartsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topics\/([^/]+)\/charts$/);
      if (topicChartsMatch) {
        const topicId = decodeURIComponent(topicChartsMatch[2]!);
        if (method === "GET") {
          return jsonOk(res, { success: true, charts: app.eventStore.listTopicCharts(topicId) });
        }
        if (method === "PUT") return await handleReplaceTopicCharts(req, res, app, topicId);
      }

      const topicMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topics\/([^/]+)$/);
      if (topicMatch) {
        const tenantId = decodeURIComponent(topicMatch[1]!);
        const topicId = decodeURIComponent(topicMatch[2]!);
        if (method === "PUT") return await handleUpdateTopic(req, res, app, tenantId, topicId);
        if (method === "DELETE") {
          if (!app.eventStore.deleteTopic(tenantId, topicId)) return jsonError(res, 404, "topic not found");
          app.sessions.delete(topicId);
          return jsonOk(res, { success: true, message: "deleted" });
        }
      }

      const researchesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/researches$/);
      if (researchesMatch) {
        const tenantId = decodeURIComponent(researchesMatch[1]!);
        if (method === "GET") return jsonOk(res, { success: true, researches: app.eventStore.listResearches(tenantId) });
        if (method === "POST") return await handleCreateResearch(req, res, app, tenantId);
      }

      // Matched before the bare /researches/:id route below, which would
      // otherwise swallow "/members" as part of the id.
      const researchMembersMatch = pathname.match(/^\/api\/agents\/([^/]+)\/researches\/([^/]+)\/members$/);
      if (researchMembersMatch) {
        const tenantId = decodeURIComponent(researchMembersMatch[1]!);
        const researchId = decodeURIComponent(researchMembersMatch[2]!);
        if (method === "GET") {
          if (!app.eventStore.getResearch(tenantId, researchId)) return jsonError(res, 404, "research not found");
          return jsonOk(res, { success: true, members: researchMembers(app, tenantId, researchId) });
        }
        if (method === "PUT") return await handleReplaceResearchMembers(req, res, app, tenantId, researchId);
      }

      const researchMatch = pathname.match(/^\/api\/agents\/([^/]+)\/researches\/([^/]+)$/);
      if (researchMatch) {
        const tenantId = decodeURIComponent(researchMatch[1]!);
        const researchId = decodeURIComponent(researchMatch[2]!);
        if (method === "GET") {
          const research = app.eventStore.getResearch(tenantId, researchId);
          if (!research) return jsonError(res, 404, "research not found");
          return jsonOk(res, { success: true, research, members: researchMembers(app, tenantId, researchId) });
        }
        if (method === "PUT") return await handleUpdateResearch(req, res, app, tenantId, researchId);
        if (method === "DELETE") {
          if (!app.eventStore.deleteResearch(tenantId, researchId)) return jsonError(res, 404, "research not found");
          // Members are NOT deleted: a Topic outlives any Research it is in (§3).
          app.sessions.delete(researchId);
          return jsonOk(res, { success: true, message: "deleted" });
        }
      }

      if (method === "GET" && pathname === "/health") return jsonOk(res, { status: "ok" });

      const stockStreamMatch = pathname.match(/^\/market\/stocks\/([^/?]+)\/stream$/);
      if (method === "GET" && stockStreamMatch) {
        return handleStockQuoteStream(stockStreamMatch[1]!, res);
      }

      const stockQuoteMatch = pathname.match(/^\/market\/stocks\/([^/?]+)$/);
      if (method === "GET" && stockQuoteMatch) {
        return await handleStockQuote(stockQuoteMatch[1]!, searchParams, res);
      }

      if (method === "GET" && pathname === "/link-preview") {
        return await handleLinkPreview(searchParams, res);
      }

      const workflowMatch = pathname.match(/^\/agents\/([^/]+)\/active-workflow$/);
      if (workflowMatch && method === "GET") {
        const workflow = activeWorkflows.get(workflowMatch[1]!);
        return jsonOk(res, {
          active: Boolean(workflow),
          ...(workflow ? { kind: workflow.kind, startedAt: new Date(workflow.startedAt).toISOString() } : {}),
        });
      }

      if (method === "GET" && pathname === "/user/strategies") {
        const { listStrategies } = await import("../trading/persistence/strategyStore.ts");
        return jsonOk(res, { success: true, strategies: await listStrategies() });
      }

      const activateMatch = pathname.match(/^\/user\/strategies\/([^/]+)\/activate$/);
      if (method === "POST" && activateMatch) {
        return await activateStrategy(req, res, app, activateMatch[1]!);
      }

      const statusMatch = pathname.match(/^\/user\/strategies\/([^/]+)\/status$/);
      if (method === "PUT" && statusMatch) {
        const body = JSON.parse(await readBody(req)) as { op?: string };
        const { loadStrategy, saveStrategy, applyStrategyOp } = await import("../trading/persistence/strategyStore.ts");
        const strategy = await loadStrategy(statusMatch[1]!);
        if (!strategy) return jsonError(res, 404, "not_found");
        const result = applyStrategyOp(strategy, (body.op ?? "") as "pause" | "resume" | "cancel");
        if (!result.ok) return jsonError(res, 409, result.error);
        await saveStrategy(result.strategy);
        return jsonOk(res, { success: true, status: result.strategy.status });
      }

      const detailMatch = pathname.match(/^\/user\/strategies\/([^/]+)$/);
      if (method === "GET" && detailMatch) {
        const { loadStrategy, listExecutions } = await import("../trading/persistence/strategyStore.ts");
        const strategy = await loadStrategy(detailMatch[1]!);
        if (!strategy) return jsonError(res, 404, "not_found");
        return jsonOk(res, {
          success: true,
          strategy,
          executions: await listExecutions(detailMatch[1]!),
        });
      }

      if (method === "GET" && pathname === "/user/notifications") {
        return jsonOk(res, { success: true, notifications: [] });
      }

      if (method === "GET") return await handleStatic(pathname, res);
      jsonError(res, 404, "Not found");
    } catch (error) {
      if (!res.headersSent) jsonError(res, 500, String(error));
    }
  });
}
