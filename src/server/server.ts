import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../framework/ids.ts";
import { attachSse } from "../infra/events/sseProjector.ts";
import type { FinancialAgentApp } from "../agent/createApp.ts";
import type { JsonObject, TaskResult, ToolExecutionResult } from "../framework/types.ts";
import { binanceFetch } from "../../mcp_tools/trading/binanceClient.ts";
import { coinbaseFetch } from "../../mcp_tools/trading/coinbaseAuth.ts";
import { reconciliationService } from "../trading/reconciliation.ts";
import { fetchCandles } from "../trading/marketData.ts";
import { handleStockQuote } from "./stockMarketRoutes.ts";
import {
  killSwitchStore,
  consentStore,
  tradingPrefsStore,
  activeWorkflows,
} from "../trading/stores.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// client/dist is two levels up from src/server/
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");
// Public market-data host (klines/ticker/depth/exchangeInfo). Defaults to
// Binance's official, non-geo-restricted data mirror; override per region.
const BINANCE_DATA_BASE = process.env["BINANCE_DATA_BASE"] || "https://data-api.binance.vision";

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


// ── Static exchange registry ───────────────────────────────────────────────────
const SUPPORTED_EXCHANGES = [
  {
    id: "binance",
    name: "Binance",
    defaultAuthType: "api_key",
    authTypes: [
      {
        type: "api_key",
        fields: [
          { id: "api_key", label: "API Key", type: "secret" as const, required: true },
          { id: "api_secret", label: "API Secret", type: "secret" as const, required: true },
        ],
      },
    ],
  },
  {
    id: "coinbase",
    name: "Coinbase Advanced Trade",
    defaultAuthType: "cdp_key",
    authTypes: [
      {
        type: "cdp_key",
        fields: [
          { id: "api_key_name", label: "API Key Name", type: "string" as const, required: true, description: "CDP key path, e.g. organizations/.../apiKeys/..." },
          { id: "api_secret", label: "Private Key (PEM)", type: "secret" as const, required: true },
        ],
      },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function setCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonOk(res: http.ServerResponse, data: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonError(res: http.ServerResponse, status: number, message: string) {
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
        (e) => e.kind === "approval_required" && e.payload.approval_id === approvalId,
      );
      if (event) return { state, event, payload: pending.payload };
    }
  }
  return app.sessions.findPendingApproval(approvalId);
}

function isOrderFailure(output: ToolExecutionResult): boolean {
  const data = output.generation_context?.data;
  return Boolean(output.error || data?.["error"] || data?.["blocked"] || /\b(failed|blocked)\b/i.test(output.summary));
}

function responseOrderFromResult(output: ToolExecutionResult, fallback: JsonObject): JsonObject {
  const data = output.generation_context?.data ?? {};
  const order: JsonObject = {
    orderId: data["orderId"] ?? data["order_id"] ?? fallback["client_order_id"] ?? "unknown",
    status: data["status"] ?? (isOrderFailure(output) ? "failed" : "submitted"),
  };
  const exchange = data["exchange"] ?? fallback["exchange"];
  const symbol = data["symbol"] ?? fallback["symbol"];
  const side = data["side"] ?? fallback["side"];
  if (exchange !== undefined) order["exchange"] = exchange;
  if (symbol !== undefined) order["symbol"] = symbol;
  if (side !== undefined) order["side"] = side;
  if (data["paper"] !== undefined) order["paper"] = data["paper"];
  if (data["fillPrice"] !== undefined) order["fillPrice"] = data["fillPrice"];
  return order;
}

function normalizeOrderSymbol(symbol: string, quoteInput: unknown): { symbol: string; quote: string } {
  const defaultQuote = typeof quoteInput === "string" && quoteInput.trim()
    ? quoteInput.trim().toUpperCase()
    : "USDT";
  const cleaned = symbol.trim().toUpperCase();
  const pairMatch = cleaned.match(/^([A-Z0-9]+)[/_-]([A-Z0-9]+)$/);
  if (pairMatch) return { symbol: pairMatch[1]!, quote: pairMatch[2]! };
  for (const quote of ["USDT", "USDC", "USD", "BTC", "ETH", "BNB"]) {
    if (cleaned.endsWith(quote) && cleaned.length > quote.length) {
      return { symbol: cleaned.slice(0, -quote.length), quote };
    }
  }
  return { symbol: cleaned, quote: defaultQuote };
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseOrderConfiguration(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function firstOrderConfigInner(value: unknown): Record<string, unknown> {
  const config = parseOrderConfiguration(value);
  if (!config) return {};
  for (const inner of Object.values(config)) {
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return {};
}

function recordApprovalTaskResult(
  approvalContext: ReturnType<typeof findApprovalContext>,
  approvalTaskId: string | undefined,
  approvalId: string | undefined,
  decision: string,
  result: TaskResult,
) {
  if (!approvalContext || !approvalId || !approvalTaskId) return;
  approvalContext.state.record(
    "trading_operations",
    "approval_resolved",
    { approval_id: approvalId, decision, summary: result.summary },
    { parent: approvalContext.event.event_id },
  );
  approvalContext.state.recordTaskResult("trading_operations", approvalTaskId, result);
}

function sseWrite(res: http.ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Resolve Binance creds from env — credential fields in the trading UI are
// optional; fall back to server-side env vars so the UI works without
// exposing keys in query strings.
function getBinanceCreds(sp: URLSearchParams) {
  return {
    apiKey: sp.get("api_key") ?? process.env["BINANCE_API_KEY"] ?? "",
    apiSecret: sp.get("api_secret") ?? process.env["BINANCE_API_SECRET"] ?? "",
  };
}

function getCoinbaseCreds(sp: URLSearchParams) {
  return {
    apiKeyName: sp.get("api_key_name") ?? process.env["COINBASE_API_KEY_NAME"] ?? "",
    apiKeySecret: sp.get("api_secret") ?? process.env["COINBASE_PRIVATE_KEY"] ?? "",
  };
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
) {
  let body: { message?: string; sessionId?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message is required" }));
    return;
  }

  const sessionId = body.sessionId ?? newId("sess");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Session-Id": sessionId,
  });

  const keepaliveMs = parseInt(process.env["SSE_KEEPALIVE_INTERVAL"] ?? "15000");
  const keepalive = setInterval(() => res.write(": ping\n\n"), keepaliveMs);
  const unsub = attachSse(await app.sessions.getOrCreate(sessionId), (frame) => sseWrite(res, frame));

  // Track workflow as active for the Stop-button rehydration route
  const agentIdHeader = (req.headers["x-agent-id"] as string | undefined) ?? "default";
  activeWorkflows.set(agentIdHeader, { kind: "task_chain", startedAt: Date.now(), sessionId });

  try {
    await app.orchestrator.run({ sessionId, userMessage: message });
  } catch (err) {
    sseWrite(res, { type: "error", scope: "main", message: String(err) });
  } finally {
    clearInterval(keepalive);
    unsub();
    activeWorkflows.delete(agentIdHeader);
    res.end();
  }
}

async function handleStatic(pathname: string, res: http.ServerResponse) {
  const safePath = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  const ext = path.extname(safePath);
  const filePath = path.join(CLIENT_DIST, safePath);

  if (!path.resolve(filePath).startsWith(CLIENT_DIST)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
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

// GET /agents/:agentId/cex/account-snapshot?venue=binance&base=BTC&quote=USDT
async function handleCexAccountSnapshot(sp: URLSearchParams, res: http.ServerResponse) {
  const venue = (sp.get("venue") ?? "binance").toLowerCase();
  const base = (sp.get("base") ?? "BTC").toUpperCase();
  const quote = (sp.get("quote") ?? "USDT").toUpperCase();

  try {
    if (venue === "coinbase") {
      const creds = getCoinbaseCreds(sp);
      if (!creds.apiKeyName || !creds.apiKeySecret) {
        return jsonOk(res, { snapshot: null, error: "Coinbase credentials not configured" });
      }
      const raw = await coinbaseFetch(creds, "GET", "/api/v3/brokerage/accounts") as {
        accounts?: Array<{ currency?: string; available_balance?: { value?: string }; hold?: { value?: string } }>;
      };
      const accounts = raw.accounts ?? [];
      const baseAcct = accounts.find((a) => a.currency === base);
      const quoteAcct = accounts.find((a) => a.currency === (quote === "USDT" ? "USD" : quote));
      return jsonOk(res, {
        snapshot: {
          baseAsset: base,
          quoteAsset: quote,
          baseAvailable: baseAcct?.available_balance?.value ?? "0",
          quoteAvailable: quoteAcct?.available_balance?.value ?? "0",
          feeBps: 10,
        },
      });
    }

    // Binance
    const creds = getBinanceCreds(sp);
    if (!creds.apiKey || !creds.apiSecret) {
      return jsonOk(res, { snapshot: null, error: "Binance credentials not configured" });
    }
    const raw = await binanceFetch(creds, "GET", "/api/v3/account") as {
      balances?: Array<{ asset?: string; free?: string; locked?: string }>;
      makerCommission?: number;
      takerCommission?: number;
    };
    const balances = raw.balances ?? [];
    const baseAcct = balances.find((b) => b.asset === base);
    const quoteAcct = balances.find((b) => b.asset === quote);
    return jsonOk(res, {
      snapshot: {
        baseAsset: base,
        quoteAsset: quote,
        baseAvailable: baseAcct?.free ?? "0",
        quoteAvailable: quoteAcct?.free ?? "0",
        feeBps: Math.max(raw.makerCommission ?? 10, raw.takerCommission ?? 10),
      },
    });
  } catch (err) {
    return jsonOk(res, { snapshot: null, error: String(err) });
  }
}

// GET /agents/:agentId/cex/market-snapshot?symbol=BTC&venue=binance&side=BUY&limit_price=...
async function handleCexMarketSnapshot(sp: URLSearchParams, res: http.ServerResponse) {
  const symbol = (sp.get("symbol") ?? "BTC").toUpperCase();
  const binanceSymbol = symbol + "USDT";
  const fetchedAtMs = Date.now();

  try {
    // All public Binance endpoints — no auth needed
    const [bookRaw, statsRaw, depthRaw] = await Promise.all([
      fetch(`${BINANCE_DATA_BASE}/api/v3/ticker/bookTicker?symbol=${binanceSymbol}`).then((r) => r.json()) as Promise<{
        bidPrice?: string; bidQty?: string; askPrice?: string; askQty?: string;
      }>,
      fetch(`${BINANCE_DATA_BASE}/api/v3/ticker/24hr?symbol=${binanceSymbol}`).then((r) => r.json()) as Promise<{
        lastPrice?: string; priceChangePercent?: string; highPrice?: string;
        lowPrice?: string; volume?: string; quoteVolume?: string;
      }>,
      fetch(`${BINANCE_DATA_BASE}/api/v3/depth?symbol=${binanceSymbol}&limit=5`).then((r) => r.json()) as Promise<{
        bids?: [string, string][]; asks?: [string, string][];
      }>,
    ]);

    const bid = bookRaw.bidPrice ?? "";
    const ask = bookRaw.askPrice ?? "";
    const bidNum = parseFloat(bid);
    const askNum = parseFloat(ask);
    const spreadBps = bidNum > 0 && askNum > 0
      ? Math.round(((askNum - bidNum) / bidNum) * 10000)
      : undefined;

    const limitPriceStr = sp.get("limit_price");
    const side = sp.get("side") as "BUY" | "SELL" | null;
    let estFillPrice: number | undefined;
    let slippageBps: number | undefined;
    if (limitPriceStr && side) {
      const lp = parseFloat(limitPriceStr);
      const ref = side === "BUY" ? askNum : bidNum;
      if (ref > 0) {
        estFillPrice = ref;
        slippageBps = Math.round(Math.abs((lp - ref) / ref) * 10000);
      }
    }

    return jsonOk(res, {
      market_snapshot: {
        symbol,
        bid,
        bid_qty: bookRaw.bidQty,
        ask,
        ask_qty: bookRaw.askQty,
        spread_bps: spreadBps,
        price_change_pct: statsRaw.priceChangePercent,
        high_24h: statsRaw.highPrice,
        low_24h: statsRaw.lowPrice,
        volume_24h: statsRaw.volume,
        quote_volume_24h: statsRaw.quoteVolume,
        depth_bids: (depthRaw.bids ?? []).map(([price, qty]) => ({ price, qty })),
        depth_asks: (depthRaw.asks ?? []).map(([price, qty]) => ({ price, qty })),
        ...(estFillPrice !== undefined ? { est_fill_price: estFillPrice } : {}),
        ...(slippageBps !== undefined ? { slippage_vs_limit_bps: slippageBps } : {}),
        fetched_at_ms: fetchedAtMs,
      },
      symbol_verification: {
        matches: true,
        extracted_symbol: symbol,
        user_text_asset_mentions: [symbol],
      },
    });
  } catch (err) {
    return jsonOk(res, {
      market_snapshot: null,
      symbol_verification: {
        matches: false,
        extracted_symbol: symbol,
        user_text_asset_mentions: [],
        reason: String(err),
      },
    });
  }
}

// GET /agents/:agentId/cex/klines?symbol=BTCUSDT&interval=1m&limit=200
// Public Binance historical candles — real OHLCV for the Strategy Floor scope.
async function handleCexKlines(sp: URLSearchParams, res: http.ServerResponse) {
  const symbol = (sp.get("symbol") ?? "BTCUSDT").toUpperCase();
  const interval = sp.get("interval") ?? "1m";
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? "200") || 200, 1), 1000);
  try {
    const candles = await fetchCandles(symbol, interval, limit);
    return jsonOk(res, { symbol, interval, candles, fetched_at_ms: Date.now() });
  } catch (err) {
    return jsonOk(res, { symbol, interval, candles: [], fetched_at_ms: Date.now(), error: String(err) });
  }
}

// GET /agents/:agentId/cex/products?venue=binance
async function handleCexProducts(sp: URLSearchParams, res: http.ServerResponse) {
  const venue = (sp.get("venue") ?? "binance").toLowerCase();

  try {
    if (venue === "coinbase") {
      // Coinbase public products endpoint
      const raw = await fetch("https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT&limit=300")
        .then((r) => r.json()) as { products?: Array<{ product_id?: string; base_currency_id?: string; quote_currency_id?: string }> };
      const products = (raw.products ?? [])
        .filter((p) => ["USD", "USDT", "USDC"].includes(p.quote_currency_id ?? ""))
        .map((p) => ({
          product_id: p.product_id ?? "",
          base_asset: p.base_currency_id ?? "",
          quote_asset: p.quote_currency_id ?? "",
        }));
      return jsonOk(res, { venue, products, fetched_at_ms: Date.now() });
    }

    // Binance public exchangeInfo
    const raw = await fetch(`${BINANCE_DATA_BASE}/api/v3/exchangeInfo`)
      .then((r) => r.json()) as {
        symbols?: Array<{
          symbol?: string; baseAsset?: string; quoteAsset?: string;
          status?: string; isSpotTradingAllowed?: boolean;
        }>;
      };
    const products = (raw.symbols ?? [])
      .filter(
        (s) =>
          s.status === "TRADING" &&
          s.isSpotTradingAllowed &&
          ["USDT", "USDC", "USD"].includes(s.quoteAsset ?? ""),
      )
      .map((s) => ({
        product_id: s.symbol ?? "",
        base_asset: s.baseAsset ?? "",
        quote_asset: s.quoteAsset ?? "",
      }));
    return jsonOk(res, { venue, products, fetched_at_ms: Date.now() });
  } catch (err) {
    return jsonOk(res, { venue, products: [], fetched_at_ms: Date.now(), error: String(err) });
  }
}

// POST /agents/:agentId/cex-workflow/approval  or  /agents/:agentId/human-input/approval
async function handleCexApproval(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: FinancialAgentApp,
) {
  let body: {
    decision?: string;
    parameters?: Record<string, unknown>;
    approvalId?: string;
    threadId?: string;
    confirmationLevel?: number;
  };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }

  const approvalContext = findApprovalContext(app, body.threadId, body.approvalId);
  const approvalTaskId = approvalContext?.event.parent_event_id ?? undefined;

  if (!body.approvalId) {
    return jsonError(res, 400, "approvalId is required");
  }
  if (!approvalContext || !approvalTaskId) {
    return jsonError(res, 404, "Approval not found or expired");
  }

  if (body.decision === "rejected") {
    if (approvalContext && body.approvalId && approvalTaskId) {
      approvalContext.state.record(
        "trading_operations",
        "approval_resolved",
        { approval_id: body.approvalId, decision: "rejected" },
        { parent: approvalContext.event.event_id },
      );
      approvalContext.state.recordTaskResult("trading_operations", approvalTaskId, {
        task_id: approvalTaskId,
        agent: "trading_operations",
        status: "failed",
        summary: "Order rejected by user. No order was submitted.",
        error: { code: "approval_rejected", message: "Order rejected by user. No order was submitted." },
        generation_context: {
          prompt: "The user rejected the trading approval. Tell the user no order was submitted.",
          data: { rejected: true, approval_id: body.approvalId },
        },
      });
    }
    return jsonOk(res, { success: true, rejected: true });
  }

  // Kill-switch guard
  const killActive = killSwitchStore.get("default") ?? false;
  if (killActive) {
    const summary = "Order failed: Kill switch is active — trading is disabled.";
    recordApprovalTaskResult(approvalContext, approvalTaskId, body.approvalId, "failed", {
      task_id: approvalTaskId ?? "unknown",
      agent: "trading_operations",
      status: "failed",
      summary,
      error: { code: "order_failed", message: summary },
      generation_context: {
        prompt: "Order submission failed because the kill switch is active. Tell the user no order was submitted.",
        data: { error: "Kill switch is active — trading is disabled." },
      },
    });
    return jsonOk(res, { success: false, error: "Kill switch is active — trading is disabled." });
  }

  const p = body.parameters ?? {};
  const exchange = String(p["exchange"] ?? "binance").toLowerCase();
  const normalizedSymbol = normalizeOrderSymbol(String(p["symbol"] ?? p["base_asset"] ?? ""), p["quote"]);
  const symbol = normalizedSymbol.symbol;
  const quote = normalizedSymbol.quote;
  const side = String(p["side"] ?? "").toUpperCase() as "BUY" | "SELL";
  const orderType = String(p["order_type"] ?? p["type"] ?? "market").toLowerCase();
  const orderConfigInner = firstOrderConfigInner(p["order_configuration"]);
  const baseSize = asFiniteNumber(p["base_size"]) ?? asFiniteNumber(orderConfigInner["base_size"]);
  const quoteSize =
    asFiniteNumber(p["quote_size"]) ??
    asFiniteNumber(p["quote_order_qty"]) ??
    asFiniteNumber(orderConfigInner["quote_size"]) ??
    asFiniteNumber(orderConfigInner["quote_order_qty"]);
  const limitPrice =
    asFiniteNumber(p["limit_price"]) ??
    asFiniteNumber(p["price"]) ??
    asFiniteNumber(orderConfigInner["limit_price"]) ??
    asFiniteNumber(orderConfigInner["price"]) ??
    asFiniteNumber(orderConfigInner["stop_price"]);

  if (!symbol || !side) {
    const summary = "Order failed: order parameters incomplete; symbol and side are required.";
    recordApprovalTaskResult(approvalContext, approvalTaskId, body.approvalId, "failed", {
      task_id: approvalTaskId ?? "unknown",
      agent: "trading_operations",
      status: "failed",
      summary,
      error: { code: "order_failed", message: summary },
      generation_context: {
        prompt: "Order submission failed because required order parameters were missing. Tell the user no order was submitted.",
        data: { exchange, symbol, side, error: "Order parameters incomplete: symbol and side are required." },
      },
    });
    return jsonOk(res, { success: false, error: "Order parameters incomplete: symbol and side are required." });
  }

  try {
    const orderInput: JsonObject = {
      ...(p as JsonObject),
      task: String(p["task"] ?? "Execute approved CEX order."),
      exchange,
      symbol,
      quote,
      side,
      order_type: orderType,
      ...(baseSize !== undefined ? { base_size: baseSize } : {}),
      ...(quoteSize !== undefined ? { quote_size: quoteSize } : {}),
      ...(limitPrice !== undefined ? { limit_price: limitPrice } : {}),
      ...(body.approvalId ? { client_order_id: body.approvalId } : {}),
    };
    const toolContext: { sessionId: string; taskId?: string } = {
      sessionId: body.threadId ?? approvalContext?.state.session_id ?? "default",
    };
    if (approvalTaskId) toolContext.taskId = approvalTaskId;
    const output = await app.toolRegistry.call("cex_create_order", orderInput, toolContext);
    const failed = isOrderFailure(output);

    if (approvalContext && body.approvalId && approvalTaskId) {
      approvalContext.state.record(
        "trading_operations",
        "approval_resolved",
        { approval_id: body.approvalId, decision: failed ? "failed" : "approved", summary: output.summary },
        { parent: approvalContext.event.event_id },
      );
      approvalContext.state.recordTaskResult("trading_operations", approvalTaskId, {
        task_id: approvalTaskId,
        agent: "trading_operations",
        status: failed ? "failed" : "ok",
        summary: output.summary,
        ...(output.generation_context ? { generation_context: output.generation_context } : {}),
        ...(failed ? { error: output.error ?? { code: "order_failed", message: output.summary } } : {}),
      });
    }

    return jsonOk(res, {
      success: !failed,
      ...(failed ? { error: output.summary } : {}),
      order: responseOrderFromResult(output, orderInput),
    });
  } catch (err) {
    const message = String(err);
    if (approvalContext && body.approvalId && approvalTaskId) {
      approvalContext.state.record(
        "trading_operations",
        "approval_resolved",
        { approval_id: body.approvalId, decision: "failed", summary: message },
        { parent: approvalContext.event.event_id },
      );
      approvalContext.state.recordTaskResult("trading_operations", approvalTaskId, {
        task_id: approvalTaskId,
        agent: "trading_operations",
        status: "failed",
        summary: `Order failed: ${message}`,
        error: { code: "order_failed", message },
        generation_context: {
          prompt: `Order submission failed. Error: ${message}`,
          data: { exchange, symbol, side, error: message },
        },
      });
    }
    return jsonOk(res, { success: false, error: message });
  }
}

// PUT /user/trading/kill-switch
async function handleKillSwitch(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: { active?: boolean; reason?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }
  const active = Boolean(body.active);
  killSwitchStore.set("default", active);
  return jsonOk(res, { success: true, kill_switch_active: active });
}

// GET /user/trading/preferences
function handleGetTradingPreferences(res: http.ServerResponse) {
  const prefs = tradingPrefsStore.get("default") ?? null;
  const killActive = killSwitchStore.get("default") ?? false;
  return jsonOk(res, {
    success: true,
    preferences: prefs ? { ...prefs, kill_switch_active: killActive } : { kill_switch_active: killActive },
  });
}

// PUT /user/trading/preferences
async function handleSetTradingPreferences(req: http.IncomingMessage, res: http.ServerResponse) {
  let patch: Record<string, unknown>;
  try {
    patch = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }
  const existing = tradingPrefsStore.get("default") ?? {};
  tradingPrefsStore.set("default", { ...existing, ...patch });
  return jsonOk(res, { success: true });
}

// GET /user/orders?limit=50&venue=binance&state=OPEN
async function handleListOrders(sp: URLSearchParams, res: http.ServerResponse) {
  const venue = (sp.get("venue") ?? "binance").toLowerCase();
  const limit = parseInt(sp.get("limit") ?? "50");

  try {
    let orders: unknown[];
    if (venue === "coinbase") {
      const creds = getCoinbaseCreds(sp);
      if (!creds.apiKeyName) return jsonOk(res, { success: true, orders: [] });
      const raw = await coinbaseFetch(creds, "GET", "/api/v3/brokerage/orders/historical/batch", {
        order_status: sp.get("state") ?? "OPEN",
        limit: String(limit),
      }) as { orders?: unknown[] };
      orders = raw.orders ?? [];
    } else {
      const creds = getBinanceCreds(sp);
      if (!creds.apiKey) return jsonOk(res, { success: true, orders: [] });
      const raw = await binanceFetch(creds, "GET", "/api/v3/openOrders");
      orders = Array.isArray(raw) ? raw : [];
    }
    return jsonOk(res, { success: true, orders });
  } catch (err) {
    return jsonOk(res, { success: true, orders: [], error: String(err) });
  }
}

// GET /user/consent/:consentType?version=v1
function handleGetConsent(consentType: string, version: string, res: http.ServerResponse) {
  const key = `${consentType}:${version}`;
  const stored = consentStore.get(key);
  return jsonOk(res, {
    success: true,
    consent: stored ? { consent_type: consentType, version, accepted: true, acceptedAt: stored.acceptedAt } : null,
  });
}

// POST /user/consent
async function handleRecordConsent(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: { consent_type?: string; version?: string; accepted?: boolean };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "Invalid JSON body");
  }
  const consentType = body.consent_type ?? "";
  const version = body.version ?? "v1";
  if (consentType) {
    consentStore.set(`${consentType}:${version}`, { version, acceptedAt: Date.now() });
  }
  return jsonOk(res, { success: true });
}

// GET /trading/exchanges
function handleGetExchanges(res: http.ServerResponse) {
  return jsonOk(res, { success: true, exchanges: SUPPORTED_EXCHANGES });
}

// ── Route dispatcher ───────────────────────────────────────────────────────────
export function createHttpServer(app: FinancialAgentApp): http.Server {
  return http.createServer(async (req, res) => {
    setCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost`);
    const { pathname } = url;
    const sp = url.searchParams;
    const method = req.method ?? "GET";

    try {
      // ── Chat (SSE) ────────────────────────────────────────────────────────
      if (method === "POST" && pathname === "/api/chat") {
        return await handleChat(req, res, app);
      }

      // ── Health ────────────────────────────────────────────────────────────
      if (method === "GET" && pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // ── Stock market data (backs the inline <StockChart /> component) ──────
      const stockQuoteMatch = pathname.match(/^\/market\/stocks\/([^/?]+)$/);
      if (method === "GET" && stockQuoteMatch) {
        return await handleStockQuote(stockQuoteMatch[1]!, sp, res);
      }

      // ── Exchange registry ──────────────────────────────────────────────────
      if (method === "GET" && pathname === "/trading/exchanges") {
        return handleGetExchanges(res);
      }

      // ── CEX agent routes  /agents/:agentId/cex/* ──────────────────────────
      const agentCexMatch = pathname.match(/^\/agents\/([^/]+)\/cex\/([^/?]+)/);
      if (agentCexMatch) {
        const sub = agentCexMatch[2];
        if (method === "GET" && sub === "account-snapshot") return await handleCexAccountSnapshot(sp, res);
        if (method === "GET" && sub === "market-snapshot")  return await handleCexMarketSnapshot(sp, res);
        if (method === "GET" && sub === "klines")           return await handleCexKlines(sp, res);
        if (method === "GET" && sub === "products")         return await handleCexProducts(sp, res);
      }

      // ── CEX / human-input approval  /agents/:agentId/cex-workflow/approval
      //                                /agents/:agentId/human-input/approval
      if (
        method === "POST" &&
        (pathname.match(/^\/agents\/[^/]+\/cex-workflow\/approval$/) ||
         pathname.match(/^\/agents\/[^/]+\/human-input\/approval$/))
      ) {
        return await handleCexApproval(req, res, app);
      }

      // ── Kill switch ────────────────────────────────────────────────────────
      if (method === "PUT" && pathname === "/user/trading/kill-switch") {
        return await handleKillSwitch(req, res);
      }

      // ── Trading preferences ────────────────────────────────────────────────
      if (pathname === "/user/trading/preferences") {
        if (method === "GET")  return handleGetTradingPreferences(res);
        if (method === "PUT")  return await handleSetTradingPreferences(req, res);
      }

      // ── Orders ────────────────────────────────────────────────────────────
      if (method === "GET" && pathname === "/user/orders") {
        return await handleListOrders(sp, res);
      }

      // ── Consent ───────────────────────────────────────────────────────────
      const consentMatch = pathname.match(/^\/user\/consent\/([^/?]+)/);
      if (consentMatch) {
        if (method === "GET") {
          return handleGetConsent(consentMatch[1] ?? "", sp.get("version") ?? "v1", res);
        }
      }
      if (method === "POST" && pathname === "/user/consent") {
        return await handleRecordConsent(req, res);
      }

      // ── Active workflow status  GET /agents/:agentId/active-workflow ────────
      const activeWfMatch = pathname.match(/^\/agents\/([^/]+)\/active-workflow$/);
      if (activeWfMatch && method === "GET") {
        const agentId = activeWfMatch[1] ?? "";
        const wf = activeWorkflows.get(agentId);
        return jsonOk(res, {
          active: !!wf,
          ...(wf ? { kind: wf.kind, startedAt: new Date(wf.startedAt).toISOString() } : {}),
        });
      }

      // ── Reconciliation status  GET /user/orders/:clientOrderId/status ───────
      const reconMatch = pathname.match(/^\/user\/orders\/([^/?]+)\/status$/);
      if (reconMatch && method === "GET") {
        const clientOrderId = decodeURIComponent(reconMatch[1] ?? "");
        const order = reconciliationService.getOrder(clientOrderId);
        if (!order) return jsonError(res, 404, "Order not found");
        return jsonOk(res, { success: true, order: { clientOrderId: order.clientOrderId, exchangeOrderId: order.exchangeOrderId, state: order.state, fillQty: order.fillQty ?? null, fillPrice: order.fillPrice ?? null, updatedAtMs: order.updatedAtMs } });
      }

      // ── Paper account  GET /user/paper/balances  GET /user/paper/orders ─────
      if (method === "GET" && pathname === "/user/paper/balances") {
        const { getPaperBalances } = await import("../../mcp_tools/trading/paperVenue.ts");
        const userId = sp.get("user_id") ?? "default";
        return jsonOk(res, { success: true, balances: getPaperBalances(userId) });
      }
      if (method === "GET" && pathname === "/user/paper/orders") {
        const { getPaperOrders } = await import("../../mcp_tools/trading/paperVenue.ts");
        const userId = sp.get("user_id") ?? "default";
        return jsonOk(res, { success: true, orders: getPaperOrders(userId) });
      }
      if (method === "POST" && pathname === "/user/paper/reset") {
        const { resetPaperAccount } = await import("../../mcp_tools/trading/paperVenue.ts");
        const body = JSON.parse(await readBody(req)) as { user_id?: string };
        resetPaperAccount(body.user_id ?? "default");
        return jsonOk(res, { success: true });
      }

      // ── Auto-trading strategies ───────────────────────────────────────────
      if (method === "GET" && pathname === "/user/strategies") {
        const { listStrategies } = await import("../trading/persistence/strategyStore.ts");
        return jsonOk(res, { success: true, strategies: await listStrategies() });
      }
      // Frontend activation confirmation: pending_approval → active (or → draft on reject).
      const stratActivate = pathname.match(/^\/user\/strategies\/([^/]+)\/activate$/);
      if (method === "POST" && stratActivate) {
        const id = stratActivate[1] ?? "";
        const body = JSON.parse(await readBody(req)) as { decision?: string; threadId?: string; approvalId?: string };
        const { loadStrategy, saveStrategy } = await import("../trading/persistence/strategyStore.ts");
        const s = await loadStrategy(id);
        if (!s) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "not_found" }));
        }
        if (s.status !== "pending_approval") {
          res.writeHead(409, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: `cannot activate from status '${s.status}'` }));
        }
        const rejected = body.decision === "reject";
        s.status = rejected ? "draft" : "active";
        await saveStrategy(s);
        const approvalId = body.approvalId ?? id;
        const approvalContext = findApprovalContext(app, body.threadId, approvalId);
        const approvalTaskId = approvalContext?.event.parent_event_id ?? undefined;
        const summary = rejected
          ? `Strategy ${id} activation rejected. Strategy returned to draft.`
          : `Strategy ${id} activated. The monitor may now execute matching phases.`;
        recordApprovalTaskResult(
          approvalContext,
          approvalTaskId,
          approvalId,
          rejected ? "rejected" : "approved",
          {
            task_id: approvalTaskId ?? "unknown",
            agent: "trading_operations",
            status: rejected ? "failed" : "ok",
            summary,
            ...(rejected
              ? { error: { code: "approval_rejected", message: summary } }
              : {}),
            generation_context: {
              prompt: rejected
                ? "The user rejected strategy activation. Tell the user the strategy is back in draft."
                : "The user approved strategy activation. Tell the user the strategy is active.",
              data: { strategy_id: id, status: s.status, rejected },
            },
          },
        );
        return jsonOk(res, { success: true, status: s.status });
      }

      // Strategy detail: config + execution history.
      const stratDetail = pathname.match(/^\/user\/strategies\/([^/]+)$/);
      if (method === "GET" && stratDetail) {
        const id = stratDetail[1] ?? "";
        const { loadStrategy, listExecutions } = await import("../trading/persistence/strategyStore.ts");
        const strategy = await loadStrategy(id);
        if (!strategy) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "not_found" }));
        }
        const executions = await listExecutions(id);
        return jsonOk(res, { success: true, strategy, executions });
      }

      // Pause/resume/cancel.
      const stratStatus = pathname.match(/^\/user\/strategies\/([^/]+)\/status$/);
      if (method === "PUT" && stratStatus) {
        const id = stratStatus[1] ?? "";
        const body = JSON.parse(await readBody(req)) as { op?: string };
        const { loadStrategy, saveStrategy, applyStrategyOp } = await import("../trading/persistence/strategyStore.ts");
        const s = await loadStrategy(id);
        if (!s) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "not_found" }));
        }
        const result = applyStrategyOp(s, (body.op ?? "") as "pause" | "resume" | "cancel");
        if (!result.ok) {
          res.writeHead(409, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: result.error }));
        }
        await saveStrategy(result.strategy);
        return jsonOk(res, { success: true, status: result.strategy.status });
      }

      // ── Stub endpoints (components call but are non-critical) ─────────────
      if (method === "GET" && pathname === "/user/notifications") {
        return jsonOk(res, { success: true, notifications: [] });
      }

      // ── Static / SPA fallback ──────────────────────────────────────────────
      if (method === "GET") {
        return await handleStatic(pathname, res);
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });
}
