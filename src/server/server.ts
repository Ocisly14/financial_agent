import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../framework/ids.ts";
import { attachSse } from "../infra/events/sseProjector.ts";
import type { FinancialAgentApp } from "../agent/createApp.ts";
import type { TaskResult } from "../framework/types.ts";
import { handleStockQuote } from "./stockMarketRoutes.ts";
import { handleLinkPreview } from "./linkPreview.ts";
import { projectChatHistory } from "./chatHistory.ts";

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

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
): Promise<void> {
  let body: { message?: string; sessionId?: string };
  try {
    body = JSON.parse(await readBody(req)) as { message?: string; sessionId?: string };
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }

  const message = (body.message ?? "").trim();
  if (!message) return jsonError(res, 400, "message is required");

  const sessionId = body.sessionId ?? newId("sess");
  const agentId = (req.headers["x-agent-id"] as string | undefined) ?? "default";
  app.eventStore.ensureRoom(agentId, sessionId, defaultRoomName());

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Session-Id": sessionId,
  });

  const keepaliveMs = Number.parseInt(process.env["SSE_KEEPALIVE_INTERVAL"] ?? "15000", 10);
  const keepalive = setInterval(() => res.write(": ping\n\n"), keepaliveMs);
  const unsubscribe = attachSse(await app.sessions.getOrCreate(sessionId), (frame) => sseWrite(res, frame));
  activeWorkflows.set(agentId, { kind: "task_chain", startedAt: Date.now(), sessionId });

  try {
    await app.orchestrator.run({ sessionId, userMessage: message });
  } catch (error) {
    sseWrite(res, { type: "error", scope: "main", message: String(error) });
  } finally {
    clearInterval(keepalive);
    unsubscribe();
    activeWorkflows.delete(agentId);
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

async function handleCreateRoom(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  agentId: string,
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
  const roomId = newId("room");
  const room = app.eventStore.createRoom(agentId, roomId, body.name?.trim() || defaultRoomName());
  jsonOk(res, { success: true, room });
}

async function handleRenameRoom(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
  agentId: string,
  roomId: string,
): Promise<void> {
  let body: { name?: string };
  try {
    body = JSON.parse(await readBody(req)) as { name?: string };
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }
  const name = body.name?.trim();
  if (!name) return jsonError(res, 400, "name is required");
  if (!app.eventStore.renameRoom(agentId, roomId, name)) return jsonError(res, 404, "room not found");
  jsonOk(res, { success: true, message: "renamed", room: { id: roomId, name } });
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

      const roomsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/rooms$/);
      if (roomsMatch) {
        const agentId = decodeURIComponent(roomsMatch[1]!);
        if (method === "GET") return jsonOk(res, { success: true, rooms: app.eventStore.listRooms(agentId) });
        if (method === "POST") return await handleCreateRoom(req, res, app, agentId);
      }

      const roomMatch = pathname.match(/^\/api\/agents\/([^/]+)\/rooms\/([^/]+)$/);
      if (roomMatch) {
        const agentId = decodeURIComponent(roomMatch[1]!);
        const roomId = decodeURIComponent(roomMatch[2]!);
        if (method === "PUT") return await handleRenameRoom(req, res, app, agentId, roomId);
        if (method === "DELETE") {
          if (!app.eventStore.deleteRoom(agentId, roomId)) return jsonError(res, 404, "room not found");
          app.sessions.delete(roomId);
          return jsonOk(res, { success: true, message: "deleted" });
        }
      }

      if (method === "GET" && pathname === "/health") return jsonOk(res, { status: "ok" });

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
