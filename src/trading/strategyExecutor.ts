import type { JsonObject } from "../framework/types.ts";
import { createCexCreateOrderTool } from "../../mcp_tools/trading/cexCreateOrderTool.ts";
import { binanceFetch } from "../../mcp_tools/trading/binanceClient.ts";
import { resolveCredentials } from "../../mcp_tools/trading/resolveCredentials.ts";
import { buildRiskContext, evaluate } from "../../mcp_tools/trading/riskEngine.ts";
import type { TradeIntent } from "../../mcp_tools/trading/riskTypes.ts";
import { fetchSymbolFilters, fetchMidPrice } from "./marketData.ts";
import { quantizeQuantity, protectiveLimitPrice } from "../../mcp_tools/trading/strategy/quantization.ts";
import { computeIntentHash, deriveClientOrderId } from "../../mcp_tools/trading/idempotency/intentHash.ts";
import { loadCostBasis, applyBuy, applySell } from "./persistence/costBasis.ts";
import { loadDailyPnl, recordAutoTrade, utcDateString } from "./persistence/dailyPnl.ts";
import { loadRiskConfig } from "./persistence/riskConfig.ts";
import { appendExecution, type StoredStrategy } from "./persistence/strategyStore.ts";
import type { StrategyPhase } from "../../mcp_tools/trading/strategy/priceStrategy.ts";

export interface ExecutionOutcome {
  /** A real or simulated order was submitted. */
  placed: boolean;
  /** Skipped before submission (e.g. below exchange minimums, unsupported sizing). */
  skipped?: boolean;
  /** Rejected by the auto-trade risk gate. */
  blocked?: boolean;
  reason?: string;
  execution_id: string;
  order_id?: string;
  client_order_id: string;
  fill_price?: number;
  realized_pnl?: number;
}

const KNOWN_QUOTES = ["USDT", "USDC", "USD", "BTC", "ETH", "BNB"];

/** Split a Binance pair symbol into base/quote (e.g. "BTCUSDT" → {base:"BTC", quote:"USDT"}). */
export function splitSymbol(symbol: string): { base: string; quote: string } {
  for (const q of KNOWN_QUOTES) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { base: symbol.slice(0, -q.length), quote: q };
    }
  }
  return { base: symbol, quote: "USDT" };
}

/** Live free balance of an asset; falls back to tracked cost-basis qty if creds are absent. */
async function resolvePositionQty(baseAsset: string): Promise<number> {
  try {
    const creds = resolveCredentials({} as JsonObject);
    if (creds.exchange === "binance") {
      const raw = (await binanceFetch(
        { apiKey: creds.apiKey, apiSecret: creds.apiSecret },
        "GET",
        "/api/v3/account",
      )) as { balances?: { asset?: string; free?: string }[] };
      const bal = raw.balances?.find((b) => b.asset === baseAsset);
      if (bal) return Number.parseFloat(bal.free ?? "0");
    }
  } catch {
    /* fall through to cost-basis */
  }
  const cb = await loadCostBasis();
  return cb[baseAsset]?.qty ?? 0;
}

const USD_STABLES: ReadonlySet<string> = new Set(["USDT", "USDC", "USD", "BUSD", "DAI", "FDUSD", "TUSD"]);

/**
 * Best-effort total portfolio value in USD: live exchange balances valued at market,
 * else tracked cost-basis positions valued at market (falling back to book cost when a
 * price is unavailable). Stablecoins count as $1; the symbol's own base reuses currentPrice.
 */
async function resolvePortfolioValueUsd(currentBase: string, currentPrice: number): Promise<number> {
  const priceUsd = async (asset: string): Promise<number> => {
    if (USD_STABLES.has(asset)) return 1;
    if (asset === currentBase && currentPrice > 0) return currentPrice;
    try { return await fetchMidPrice(`${asset}USDT`); } catch { return 0; }
  };

  // 1) Live balances (binance), valued at market.
  try {
    const creds = resolveCredentials({} as JsonObject);
    if (creds.exchange === "binance") {
      const raw = (await binanceFetch(
        { apiKey: creds.apiKey, apiSecret: creds.apiSecret },
        "GET",
        "/api/v3/account",
      )) as { balances?: { asset?: string; free?: string; locked?: string }[] };
      let total = 0;
      for (const b of raw.balances ?? []) {
        const qty = Number.parseFloat(b.free ?? "0") + Number.parseFloat(b.locked ?? "0");
        if (!b.asset || qty <= 0) continue;
        total += qty * (await priceUsd(b.asset));
      }
      if (total > 0) return total;
    }
  } catch {
    /* fall through to tracked cost basis */
  }

  // 2) Fallback: tracked cost-basis positions (paper / no creds).
  const cb = await loadCostBasis();
  let total = 0;
  for (const [asset, pos] of Object.entries(cb)) {
    if (pos.qty <= 0) continue;
    const px = await priceUsd(asset);
    total += pos.qty * (px > 0 ? px : pos.avg_cost_usd);
  }
  return total;
}

/**
 * Pure sizing math: turn an action.size spec into a raw base quantity.
 * I/O-derived inputs (current position qty, portfolio USD value) are passed in so this
 * stays unit-testable. Exported for tests.
 */
export function quantityFromSize(
  size: { type: string; value: number },
  currentPrice: number,
  ctx: { positionQty: number; portfolioUsd: number },
): { qty: number; reason?: string } {
  switch (size.type) {
    case "fixed_base_qty":
      return { qty: size.value };
    case "fixed_quote_usd":
      return { qty: currentPrice > 0 ? size.value / currentPrice : 0 };
    case "pct_of_position":
      return { qty: ctx.positionQty * (size.value / 100) };
    case "pct_of_portfolio": {
      if (ctx.portfolioUsd <= 0) return { qty: 0, reason: "portfolio value unavailable — cannot size pct_of_portfolio" };
      if (currentPrice <= 0) return { qty: 0, reason: "no current price" };
      return { qty: (ctx.portfolioUsd * (size.value / 100)) / currentPrice };
    }
    default:
      return { qty: 0, reason: `unsupported size type ${size.type}` };
  }
}

/** Compute the raw (un-quantized) base quantity the action wants to trade. */
async function computeRawQuantity(
  phase: StrategyPhase,
  base: string,
  currentPrice: number,
): Promise<{ qty: number; reason?: string }> {
  const action = phase.action;
  if (!action) return { qty: 0, reason: "strategy has no action block" };
  const size = action.size;
  // Resolve only the I/O the chosen sizing kind needs.
  const positionQty = size.type === "pct_of_position" ? await resolvePositionQty(base) : 0;
  const portfolioUsd = size.type === "pct_of_portfolio" ? await resolvePortfolioValueUsd(base, currentPrice) : 0;
  return quantityFromSize(size, currentPrice, { positionQty, portfolioUsd });
}

/**
 * Execute a confirmed strategy trigger: size → quantize → auto-trade risk gate →
 * place order (via the existing cex_create_order path) → update cost basis,
 * daily PnL, and the executions log. Returns an outcome; the caller (monitor)
 * owns the strategy state transition.
 */
export async function executeTrigger(
  strategy: StoredStrategy,
  phase: StrategyPhase,
  currentPrice: number,
  now: Date,
): Promise<ExecutionOutcome> {
  const action = phase.action;
  const triggerCount = phase.recurrence?.trigger_count ?? 0;
  const { base, quote } = splitSymbol(strategy.symbol);
  const clientOrderId = deriveClientOrderId(
    computeIntentHash({ strategy_id: strategy.id, phase_id: phase.id, trigger_count: triggerCount, symbol: strategy.symbol, side: action?.side }),
    "binance",
  );
  const execution_id = `exec-${strategy.id}-${phase.id}-${triggerCount}`;
  const base_result: Pick<ExecutionOutcome, "execution_id" | "client_order_id"> = { execution_id, client_order_id: clientOrderId };

  if (!action) return { ...base_result, placed: false, skipped: true, reason: "no action block" };

  const { qty: rawQty, reason: sizeReason } = await computeRawQuantity(phase, base, currentPrice);
  if (sizeReason || rawQty <= 0) {
    return { ...base_result, placed: false, skipped: true, reason: sizeReason ?? "computed quantity is zero" };
  }

  // Quantize to exchange filters.
  const filters = await fetchSymbolFilters(strategy.symbol);
  const q = quantizeQuantity(rawQty, currentPrice, filters);
  if (!q.ok) {
    return { ...base_result, placed: false, skipped: true, reason: q.reason ?? "below exchange minimum" };
  }
  const quantity = q.quantity;

  // Map order type; marketable_limit → protective limit price.
  const orderType = action.order_type === "marketable_limit" ? "limit" : "market";
  const limitPrice =
    action.order_type === "marketable_limit"
      ? protectiveLimitPrice(action.side, currentPrice, action.max_slippage_bps, filters)
      : undefined;

  // ── Auto-trade risk gate (enforces maxDailyAutoTrades + dailyLossLimit etc.) ──
  const config = await loadRiskConfig();
  const today = utcDateString(now);
  const daily = await loadDailyPnl(today);
  const intent: TradeIntent = {
    action: "create_order",
    source: "auto_strategy",
    mode: strategy.dsl.mode,
    symbol: strategy.symbol,
    side: action.side,
    order_type: orderType,
    size: { base_size: String(quantity) },
    ...(limitPrice !== undefined ? { price_params: { limit_price: String(limitPrice) } } : {}),
  };
  const prefsRecord: Record<string, unknown> = {
    max_order_notional_usd: config.max_order_notional_usd,
    daily_loss_limit_usd: config.daily_loss_limit_usd,
    max_daily_auto_trades: config.max_daily_auto_trades,
  };
  const overrides: Record<string, number> = {
    estimated_notional_usd: quantity * currentPrice,
    market_mid_usd: currentPrice,
    daily_auto_trade_count: daily.trade_count,
    rolling_24h_pnl_usd: daily.realized_pnl_usd,
  };
  const decision = evaluate(intent, buildRiskContext(prefsRecord, overrides));
  if (decision.verdict === "block") {
    return { ...base_result, placed: false, blocked: true, reason: decision.explanations.join("; ") };
  }

  // ── Place the order via the existing order path (handles paper/live + reconciliation) ──
  const tool = createCexCreateOrderTool();
  const input: JsonObject = {
    symbol: strategy.symbol,
    side: action.side,
    order_type: orderType,
    base_size: quantity,
    client_order_id: clientOrderId,
    user_id: strategy.owner,
    strategy_id: strategy.id,
    phase_id: phase.id,
    source: "auto_strategy",
    mode: strategy.dsl.mode,
    ...(limitPrice !== undefined ? { limit_price: limitPrice } : {}),
  };
  const res = await tool.execute(input, { sessionId: `strategy-monitor:${strategy.id}` });
  if (res.error) {
    return { ...base_result, placed: false, reason: res.error.message };
  }

  const data = (res.generation_context?.data ?? {}) as Record<string, unknown>;
  const fillPrice = typeof data["fillPrice"] === "number" ? (data["fillPrice"] as number) : limitPrice ?? currentPrice;
  const orderId = data["orderId"] !== undefined ? String(data["orderId"]) : undefined;

  // ── Update cost basis + realized PnL ──
  let realized = 0;
  if (action.side === "BUY") {
    await applyBuy(base, quantity, fillPrice);
  } else {
    realized = await applySell(base, quantity, fillPrice);
  }
  await recordAutoTrade(today, realized);

  await appendExecution({
    ts: now.toISOString(),
    strategy_id: strategy.id,
    phase_id: phase.id,
    phase_name: phase.name,
    execution_id,
    ...(orderId !== undefined ? { order_id: orderId } : {}),
    client_order_id: clientOrderId,
    trigger_snapshot: { price: currentPrice, symbol: strategy.symbol, quote, quantity },
    order_result: data,
    realized_pnl: realized,
  });

  return {
    ...base_result,
    placed: true,
    ...(orderId !== undefined ? { order_id: orderId } : {}),
    fill_price: fillPrice,
    realized_pnl: realized,
  };
}
