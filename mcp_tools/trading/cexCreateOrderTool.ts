import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { resolveCredentials } from "./resolveCredentials.ts";
import { binanceFetch } from "./binanceClient.ts";
import { buildCoinbaseJwt, type CoinbaseCredentials } from "./coinbaseAuth.ts";
import { evaluate, buildRiskContext } from "./riskEngine.ts";
import type { TradeIntent } from "./riskTypes.ts";
import { executePaperOrder } from "./paperVenue.ts";
import { reconciliationService } from "../../src/trading/reconciliation.ts";
import { tradingPrefsStore, failureTimestamps } from "../../src/trading/stores.ts";

const VALID_SIDES = ["BUY", "SELL"] as const;
const VALID_ORDER_TYPES = ["market", "limit", "stop_limit"] as const;
const KNOWN_QUOTES = ["USDT", "USDC", "USD", "BTC", "ETH", "BNB"] as const;

type OrderSide = typeof VALID_SIDES[number];
type OrderType = typeof VALID_ORDER_TYPES[number];

// Coinbase POST requires a JSON body — coinbaseFetch only handles query params,
// so we build the request manually using the shared JWT helper.
async function coinbasePostOrder(
  creds: CoinbaseCredentials,
  body: Record<string, unknown>,
): Promise<unknown> {
  const path = "/api/v3/brokerage/orders";
  const jwt = buildCoinbaseJwt(creds, "POST", path);
  const response = await fetch(`https://api.coinbase.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Coinbase API error ${response.status}: ${text}`);
  }
  return response.json();
}

function buildBinanceOrderParams(
  symbol: string,
  quote: string,
  side: OrderSide,
  orderType: OrderType,
  baseSize: number | undefined,
  quoteSize: number | undefined,
  limitPrice: number | undefined,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    symbol: symbol + quote,
    side,
  };

  if (orderType === "market") {
    params["type"] = "MARKET";
    if (baseSize !== undefined) {
      params["quantity"] = baseSize;
    } else if (quoteSize !== undefined) {
      params["quoteOrderQty"] = quoteSize;
    }
  } else if (orderType === "limit") {
    params["type"] = "LIMIT";
    params["timeInForce"] = "GTC";
    params["quantity"] = baseSize ?? 0;
    params["price"] = limitPrice ?? 0;
  } else {
    // stop_limit
    params["type"] = "STOP_LOSS_LIMIT";
    params["timeInForce"] = "GTC";
    params["quantity"] = baseSize ?? 0;
    params["price"] = limitPrice ?? 0;
    params["stopPrice"] = limitPrice ?? 0;
  }

  return params;
}

function normalizeSymbolAndQuote(symbol: string, quoteInput: string): { symbol: string; quote: string } {
  const defaultQuote = quoteInput || "USDT";
  const cleaned = symbol.trim().toUpperCase();
  const pairMatch = cleaned.match(/^([A-Z0-9]+)[/_-]([A-Z0-9]+)$/);
  if (pairMatch) {
    return { symbol: pairMatch[1]!, quote: pairMatch[2]! };
  }
  const suffix = KNOWN_QUOTES.find((q) => cleaned.endsWith(q) && cleaned.length > q.length);
  if (suffix) {
    return { symbol: cleaned.slice(0, -suffix.length), quote: suffix };
  }
  return { symbol: cleaned, quote: defaultQuote };
}

function buildCoinbaseOrderBody(
  clientOrderId: string,
  symbol: string,
  quote: string,
  side: OrderSide,
  orderType: OrderType,
  baseSize: number | undefined,
  quoteSize: number | undefined,
  limitPrice: number | undefined,
): Record<string, unknown> {
  const productId = `${symbol}-${quote}`;
  const body: Record<string, unknown> = {
    client_order_id: clientOrderId,
    product_id: productId,
    side,
  };

  if (orderType === "market") {
    body["order_configuration"] = {
      market_market_ioc: {
        ...(quoteSize !== undefined ? { quote_size: String(quoteSize) } : {}),
        ...(baseSize !== undefined ? { base_size: String(baseSize) } : {}),
      },
    };
  } else if (orderType === "limit") {
    body["order_configuration"] = {
      limit_limit_gtc: {
        base_size: String(baseSize ?? 0),
        limit_price: String(limitPrice ?? 0),
        post_only: false,
      },
    };
  } else {
    // stop_limit — Coinbase uses stop_limit_stop_limit_gtc
    body["order_configuration"] = {
      stop_limit_stop_limit_gtc: {
        base_size: String(baseSize ?? 0),
        limit_price: String(limitPrice ?? 0),
        stop_price: String(limitPrice ?? 0),
        stop_direction: side === "BUY" ? "STOP_DIRECTION_STOP_UP" : "STOP_DIRECTION_STOP_DOWN",
      },
    };
  }

  return body;
}

export function createCexCreateOrderTool(): RegisteredTool {
  return {
    name: "cex_create_order",
    description:
      "EXECUTE a single, already-approved order on a centralized exchange (Binance or Coinbase) — the final submit step. Places the order immediately at current market/limit terms; it does NOT preview. Call ONLY after the user has explicitly approved that specific order. NOT for price-conditional, triggered, recurring, or multi-step orders — anything that should fire on a future price condition is an auto-trading strategy (use cex_create_strategy). Returns the exchange order ID and status.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task", "symbol", "side", "order_type"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language description of the trade being executed.",
        },
        exchange: {
          type: "string",
          description: "Exchange to trade on: 'coinbase' or 'binance'. Defaults to 'binance'.",
        },
        api_key: {
          type: "string",
          description: "API key for Binance.",
        },
        api_secret: {
          type: "string",
          description: "API secret for Binance, or EC private key PEM for Coinbase.",
        },
        api_key_name: {
          type: "string",
          description: "API key name (path) for Coinbase Advanced Trade.",
        },
        symbol: {
          type: "string",
          description: "Base asset symbol, e.g. 'BTC', 'ETH'.",
        },
        quote: {
          type: "string",
          description: "Quote asset, e.g. 'USDT' (default), 'USD' for Coinbase.",
        },
        side: {
          type: "string",
          enum: ["BUY", "SELL"],
          description: "Order side.",
        },
        order_type: {
          type: "string",
          enum: ["market", "limit", "stop_limit"],
          description: "Order type.",
        },
        base_size: {
          type: "number",
          description: "Amount of the base asset (e.g. 0.1 for 0.1 BTC).",
        },
        quote_size: {
          type: "number",
          description: "Amount in quote currency (e.g. 500 for $500 USDT).",
        },
        limit_price: {
          type: "number",
          description: "Limit price for 'limit' or 'stop_limit' orders.",
        },
        client_order_id: {
          type: "string",
          description: "Optional idempotency key. A unique ID is generated if omitted.",
        },
        mode: {
          type: "string",
          enum: ["paper", "live", "shadow"],
          description: "Optional execution mode override. Takes precedence over the user's default_mode. Used by auto-strategies to honor their own paper/live setting.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);

      const exchange = str(input["exchange"]) || "binance";
      const symbolInput = str(input["symbol"]).toUpperCase();
      const rawSide = str(input["side"]).toUpperCase();
      const rawOrderType = str(input["order_type"]).toLowerCase();
      const normalized = normalizeSymbolAndQuote(symbolInput, str(input["quote"]).toUpperCase() || "USDT");
      const rawSymbol = normalized.symbol;
      const quote = normalized.quote;
      const baseSize = num(input["base_size"]);
      const quoteSize = num(input["quote_size"]);
      const limitPrice = num(input["limit_price"]);
      const clientOrderId = str(input["client_order_id"]) || `senti-${Date.now()}`;

      if (!rawSymbol) {
        const message = "Order failed: symbol is required.";
        return { summary: message, error: { code: "missing_symbol", message } };
      }
      if (!(VALID_SIDES as readonly string[]).includes(rawSide)) {
        const message = `Order failed: side must be BUY or SELL, got '${rawSide}'.`;
        return { summary: message, error: { code: "invalid_side", message } };
      }
      if (!(VALID_ORDER_TYPES as readonly string[]).includes(rawOrderType)) {
        const message = `Order failed: order_type must be market, limit, or stop_limit, got '${rawOrderType}'.`;
        return { summary: message, error: { code: "invalid_order_type", message } };
      }
      if (!baseSize && !quoteSize) {
        const message = "Order failed: either base_size or quote_size is required.";
        return { summary: message, error: { code: "missing_size", message } };
      }
      if ((rawOrderType === "limit" || rawOrderType === "stop_limit") && !limitPrice) {
        const message = `Order failed: limit_price is required for '${rawOrderType}' orders.`;
        return { summary: message, error: { code: "missing_limit_price", message } };
      }

      const side = rawSide as OrderSide;
      const orderType = rawOrderType as OrderType;

      // ── Derive userId for per-user state lookups ──────────────────────────
      const userId = str(input["user_id"]) || "default";
      const prefsRecord = tradingPrefsStore.get(userId) ?? null;
      // Explicit `mode` input wins (e.g. an auto-strategy passes its own mode);
      // otherwise fall back to the user's default_mode, then "live".
      const modeOverride = str(input["mode"]).toLowerCase();
      const tradingMode: "live" | "paper" | "shadow" =
        modeOverride === "paper" || modeOverride === "live" || modeOverride === "shadow"
          ? modeOverride
          : ((prefsRecord?.["default_mode"] as "live" | "paper" | "shadow") ?? "live");

      // ── Risk engine pre-check ─────────────────────────────────────────────
      let estimatedNotionalUsd: number | undefined;
      let marketMidUsd: number | undefined;
      let marketDataAgeMs: number | undefined;
      try {
        const binanceQuote = quote === "USD" ? "USDT" : quote;
        const binanceSymbol = rawSymbol + binanceQuote;
        const t0 = Date.now();
        const bookRaw = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${binanceSymbol}`)
          .then((r) => r.json()) as { bidPrice?: string; askPrice?: string };
        const bid = parseFloat(bookRaw.bidPrice ?? "0");
        const ask = parseFloat(bookRaw.askPrice ?? "0");
        if (bid > 0 && ask > 0) {
          marketMidUsd = (bid + ask) / 2;
          marketDataAgeMs = Date.now() - t0;
          if (baseSize !== undefined) estimatedNotionalUsd = baseSize * marketMidUsd;
          else if (quoteSize !== undefined) estimatedNotionalUsd = quoteSize;
        }
      } catch { /* fail-open */ }

      const intent: TradeIntent = {
        action: "create_order",
        mode: tradingMode,
        symbol: rawSymbol,
        side,
        order_type: orderType,
        size: {
          ...(baseSize !== undefined ? { base_size: String(baseSize) } : {}),
          ...(quoteSize !== undefined ? { quote_size: String(quoteSize) } : {}),
        },
        ...(limitPrice !== undefined ? { price_params: { limit_price: String(limitPrice) } } : {}),
      };

      // Build risk context, only passing defined optional values (exactOptionalPropertyTypes)
      const riskOverrides: Record<string, number> = {};
      if (estimatedNotionalUsd !== undefined) riskOverrides["estimated_notional_usd"] = estimatedNotionalUsd;
      if (marketMidUsd !== undefined) riskOverrides["market_mid_usd"] = marketMidUsd;
      if (marketDataAgeMs !== undefined) riskOverrides["market_data_age_ms"] = marketDataAgeMs;
      const lastFail = failureTimestamps.get(userId);
      if (lastFail !== undefined) riskOverrides["last_failure_at_ms"] = lastFail;
      riskOverrides["unknown_state_orders_on_pair"] = reconciliationService.getUnknownStateCount(userId, rawSymbol);
      riskOverrides["stale_reconciliation_count"] = reconciliationService.getStaleCount(userId);
      const riskCtx = buildRiskContext(prefsRecord, riskOverrides);

      const riskDecision = evaluate(intent, riskCtx);
      if (riskDecision.verdict === "block") {
        failureTimestamps.set(userId, Date.now());
        const message = `Order blocked by risk engine: ${riskDecision.explanations.join("; ")}`;
        return {
          summary: message,
          error: { code: "risk_blocked", message },
          generation_context: {
            prompt: "The order was rejected by the risk engine before submission. Explain which rule fired and why, and suggest how the user can resolve it (e.g., adjust size, wait for cooldown, check allowlist).",
            data: { blocked: true, rules_fired: riskDecision.rules_fired, explanations: riskDecision.explanations },
          },
        };
      }

      // ── Paper mode: route to in-memory simulator ──────────────────────────
      if (tradingMode === "paper") {
        try {
          const paperOrder = await executePaperOrder(userId, rawSymbol, side, baseSize, quoteSize);
          const sizeDesc = baseSize !== undefined ? `${baseSize} ${rawSymbol}` : `${quoteSize} ${quote}`;
          return {
            summary: `[PAPER] Order filled: ${side} ${sizeDesc}. Fill price: ${paperOrder.fills[0]?.price ?? "N/A"}, Order ID: ${paperOrder.orderId}.`,
            generation_context: {
              prompt: "This was a paper trade (simulated). Report the fill price, order ID and remind the user this was not a real trade.",
              data: { paper: true, orderId: paperOrder.orderId, status: "FILLED", fillPrice: paperOrder.fills[0]?.price ?? null, symbol: rawSymbol, side, baseSize: baseSize ?? null, quoteSize: quoteSize ?? null },
            },
          };
        } catch (err) {
          const message = `[PAPER] Order failed: ${err instanceof Error ? err.message : String(err)}`;
          return { summary: message, error: { code: "paper_order_failed", message } };
        }
      }

      try {
        const creds = resolveCredentials(input);
        let result: unknown;

        if (creds.exchange === "coinbase") {
          const body = buildCoinbaseOrderBody(
            clientOrderId,
            rawSymbol,
            quote === "USDT" ? "USD" : quote, // Coinbase uses USD not USDT
            side,
            orderType,
            baseSize,
            quoteSize,
            limitPrice,
          );
          result = await coinbasePostOrder(creds, body);
        } else {
          const params = buildBinanceOrderParams(
            rawSymbol,
            quote === "USD" ? "USDT" : quote,
            side,
            orderType,
            baseSize,
            quoteSize,
            limitPrice,
          );
          result = await binanceFetch(creds, "POST", "/api/v3/order", params);
        }

        const r = result as Record<string, unknown>;
        const successResp = r["success_response"] as Record<string, unknown> | undefined;
        const orderId = String(r["orderId"] ?? r["order_id"] ?? successResp?.["order_id"] ?? clientOrderId);
        const status = String(r["status"] ?? successResp?.["status"] ?? "submitted");
        const sizeDesc = baseSize !== undefined ? `${baseSize} ${rawSymbol}` : `${quoteSize} ${quote}`;

        // Register with reconciliation service for async fill tracking
        const creds2 = resolveCredentials(input);
        const reconCreds =
          creds2.exchange === "coinbase"
            ? { apiKeyName: creds2.apiKeyName, apiKeySecret: creds2.apiKeySecret }
            : { apiKey: creds2.apiKey, apiSecret: creds2.apiSecret };
        reconciliationService.registerOrder({
          clientOrderId,
          exchangeOrderId: orderId,
          userId,
          venue: creds2.exchange === "coinbase" ? "coinbase" : "binance",
          symbol: rawSymbol,
          side,
          credentials: reconCreds,
        });

        return {
          summary: `Order submitted: ${side} ${sizeDesc} on ${exchange}. Order ID: ${orderId}, Status: ${status}.`,
          generation_context: {
            prompt: [
              "The trade order has been submitted to the exchange.",
              "Report the order ID, status, side, symbol, size, and exchange to the user.",
              "If the order is FILLED, confirm the execution. If PENDING/NEW, note it is queued.",
            ].join("\n"),
            data: {
              exchange,
              orderId,
              status,
              symbol: rawSymbol,
              side,
              orderType,
              baseSize: baseSize ?? null,
              quoteSize: quoteSize ?? null,
              limitPrice: limitPrice ?? null,
            },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failureTimestamps.set(userId, Date.now());
        return {
          summary: `Order failed on ${exchange}: ${message}`,
          error: { code: "exchange_order_failed", message: `Order failed on ${exchange}: ${message}` },
          generation_context: {
            prompt: `Order submission failed. Error: ${message}`,
            data: { exchange, error: message },
          },
        };
      }
    },
  };
}
