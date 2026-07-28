import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { newId } from "../../src/framework/ids.ts";

const SYMBOL_PATTERN = /\b(BTC|ETH|SOL|XRP|DOGE|BNB|ADA|MATIC|LINK|AVAX|LTC|DOT)\b/i;
const VALID_SIDES = ["BUY", "SELL"] as const;
const VALID_ORDER_TYPES = ["market", "limit", "stop_limit"] as const;
const KNOWN_QUOTES = ["USDT", "USDC", "USD", "BTC", "ETH", "BNB"] as const;

type OrderSide = typeof VALID_SIDES[number];
type OrderType = typeof VALID_ORDER_TYPES[number];

function detectSymbol(task: string): string | undefined {
  const m = task.match(SYMBOL_PATTERN);
  return m ? m[1]!.toUpperCase() : undefined;
}

function detectSide(task: string): OrderSide | undefined {
  if (/\b(buy|long)\b/i.test(task)) return "BUY";
  if (/\b(sell|short)\b/i.test(task)) return "SELL";
  return undefined;
}

function detectQuoteSize(task: string): number | undefined {
  // Matches "100 USDT", "$500", "500 USD"
  const m = task.match(/(\d+(?:\.\d+)?)\s*(?:USDT?|USD|\$)/i);
  return m ? parseFloat(m[1]!) : undefined;
}

function normalizeSymbolAndQuote(symbol: string, quoteInput: unknown): { symbol: string; quote: string } {
  const defaultQuote = typeof quoteInput === "string" && quoteInput.trim()
    ? quoteInput.trim().toUpperCase()
    : "USDT";
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

export function createCexPreviewOrderTool(): RegisteredTool {
  return {
    name: "cex_prepare_order",
    description:
      "Preview and validate ONE order the user wants to execute NOW — an immediate manual market/limit buy or sell. Returns an approval request for human confirmation; it does NOT submit the order. Use this ONLY for execute-now orders. Do NOT use it for anything that should fire on a future price condition (a % move within a window, crossing a price level, a trailing stop) or for any multi-step / multi-leg plan — those are auto-trading strategies; use cex_create_strategy instead. Even a single conditional leg like 'buy $300 if it drops 5%' is a strategy, not a prepared order.",
    category: "trading",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Natural-language trade request, e.g. 'Buy 0.1 BTC on Binance'.",
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
          description: "Trading symbol, e.g. 'BTC' or 'BTC/USDT'. Detected from task if omitted.",
        },
        quote: {
          type: "string",
          description: "Quote asset, e.g. 'USDT' (default), 'USD' for Coinbase.",
        },
        side: {
          type: "string",
          enum: ["BUY", "SELL"],
          description: "Order side: 'BUY' or 'SELL'.",
        },
        order_type: {
          type: "string",
          enum: ["market", "limit", "stop_limit"],
          description: "Order type: 'market', 'limit', or 'stop_limit'. Defaults to 'market'.",
        },
        base_size: {
          type: "number",
          description: "Amount of the base asset to buy/sell (e.g. 0.1 for 0.1 BTC).",
        },
        quote_size: {
          type: "number",
          description: "Amount in quote currency to spend/receive (e.g. 500 for $500 USD).",
        },
        limit_price: {
          type: "number",
          description: "Limit price for 'limit' or 'stop_limit' order types.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const task = typeof input["task"] === "string" ? input["task"] : "";
      const exchange = typeof input["exchange"] === "string" ? input["exchange"] : "binance";

      // Resolve symbol
      const detectedSymbol = typeof input["symbol"] === "string" && input["symbol"].trim()
        ? input["symbol"].trim().toUpperCase()
        : detectSymbol(task);

      if (!detectedSymbol) {
        const message = "Order preview failed: could not determine trading symbol. Please specify a symbol (e.g. BTC, ETH).";
        return {
          summary: message,
          error: { code: "missing_symbol", message },
        };
      }
      const { symbol: rawSymbol, quote } = normalizeSymbolAndQuote(detectedSymbol, input["quote"]);

      // Resolve side — explicit input wins, then detect from task text
      const rawSide = typeof input["side"] === "string" ? input["side"].toUpperCase() : detectSide(task)?.toUpperCase();
      if (!rawSide || !(VALID_SIDES as readonly string[]).includes(rawSide)) {
        const message = `Order preview failed: 'side' must be 'BUY' or 'SELL', got: ${rawSide ?? "(none)"}. Specify side explicitly or use keywords like 'buy'/'sell' in the task.`;
        return {
          summary: message,
          error: { code: "invalid_side", message },
        };
      }
      const side = rawSide as OrderSide;

      // Resolve order_type
      const rawOrderType = typeof input["order_type"] === "string" ? input["order_type"].toLowerCase() : "market";
      if (!(VALID_ORDER_TYPES as readonly string[]).includes(rawOrderType)) {
        const message = `Order preview failed: 'order_type' must be one of: market, limit, stop_limit. Got: ${rawOrderType}.`;
        return {
          summary: message,
          error: { code: "invalid_order_type", message },
        };
      }
      const orderType = rawOrderType as OrderType;

      // Resolve sizes — explicit input wins, then detect from task text
      const baseSize = typeof input["base_size"] === "number" ? input["base_size"] : undefined;
      const quoteSize = typeof input["quote_size"] === "number" ? input["quote_size"] : (detectQuoteSize(task) ?? undefined);
      const limitPrice = typeof input["limit_price"] === "number" ? input["limit_price"] : undefined;

      if (!baseSize && !quoteSize) {
        const message = "Order preview failed: either 'base_size' or 'quote_size' must be specified. Provide an amount like '100 USDT' or '0.1 BTC'.";
        return {
          summary: message,
          error: { code: "missing_size", message },
        };
      }

      if ((orderType === "limit" || orderType === "stop_limit") && !limitPrice) {
        const message = `Order preview failed: 'limit_price' is required for order_type '${orderType}'.`;
        return {
          summary: message,
          error: { code: "missing_limit_price", message },
        };
      }

      const orderPreview: JsonObject = {
        exchange,
        symbol: rawSymbol,
        quote,
        side,
        order_type: orderType,
        status: "pending_approval",
        ...(baseSize !== undefined ? { base_size: baseSize } : {}),
        ...(quoteSize !== undefined ? { quote_size: quoteSize } : {}),
        ...(limitPrice !== undefined ? { limit_price: limitPrice } : {}),
      };

      const approvalId = newId("approval");
      const sizeDescription = baseSize !== undefined
        ? String(baseSize)
        : `$${quoteSize}`;

      return {
        summary: `Order preview for ${side} ${sizeDescription} ${rawSymbol}/${quote} on ${exchange}. Awaiting approval.`,
        approval: {
          approval_id: approvalId,
          payload: {
            approval_id: approvalId,
            ...orderPreview,
          },
        },
      };
    },
  };
}
