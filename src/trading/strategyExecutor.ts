import { randomUUID } from "node:crypto";
import { loadCostBasis, applyBuy, applySell } from "./persistence/costBasis.ts";
import { recordAutoTrade, utcDateString } from "./persistence/dailyPnl.ts";
import { appendExecution, listExecutions, type StoredStrategy } from "./persistence/strategyStore.ts";
import type { StrategyPhase } from "../../mcp_tools/trading/strategy/priceStrategy.ts";

export interface ExecutionOutcome {
  /** A paper fill or shadow signal was recorded. */
  placed: boolean;
  skipped?: boolean;
  blocked?: boolean;
  reason?: string;
  execution_id: string;
  fill_price?: number;
  quantity?: number;
  realized_pnl?: number;
}

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
    case "pct_of_portfolio":
      if (ctx.portfolioUsd <= 0) return { qty: 0, reason: "portfolio value unavailable — cannot size pct_of_portfolio" };
      if (currentPrice <= 0) return { qty: 0, reason: "no current price" };
      return { qty: (ctx.portfolioUsd * (size.value / 100)) / currentPrice };
    default:
      return { qty: 0, reason: `unsupported size type ${size.type}` };
  }
}

async function portfolioContext(strategy: StoredStrategy, currentPrice: number): Promise<{ positionQty: number; portfolioUsd: number }> {
  const positions = await loadCostBasis();
  let positionQty = positions[strategy.symbol]?.qty ?? 0;
  if (strategy.dsl.mode === "shadow") {
    const executions = await listExecutions(strategy.id);
    positionQty = executions.reduce((quantity, entry) => {
      const result = entry.order_result;
      const side = result?.["side"];
      const filled = result?.["quantity"];
      if (typeof filled !== "number") return quantity;
      if (side === "BUY") return quantity + filled;
      if (side === "SELL") return Math.max(0, quantity - filled);
      return quantity;
    }, positionQty);
  }
  let portfolioUsd = 0;
  for (const [ticker, position] of Object.entries(positions)) {
    const quantity = ticker === strategy.symbol ? positionQty : position.qty;
    if (quantity <= 0) continue;
    const price = ticker === strategy.symbol ? currentPrice : position.avg_cost_usd;
    portfolioUsd += quantity * price;
  }
  if (!positions[strategy.symbol] && positionQty > 0) portfolioUsd += positionQty * currentPrice;
  return { positionQty, portfolioUsd };
}

/**
 * Record a confirmed stock-strategy action. Paper mode records a simulated fill
 * and updates the local paper cost basis; shadow mode records the signal only.
 * No broker adapter is called from this path.
 */
export async function executeTrigger(
  strategy: StoredStrategy,
  phase: StrategyPhase,
  currentPrice: number,
  now: Date,
  triggerObserved?: Record<string, number | string>,
): Promise<ExecutionOutcome> {
  const executionId = `exec-${randomUUID()}`;
  const context = await portfolioContext(strategy, currentPrice);
  const sized = quantityFromSize(phase.action.size, currentPrice, context);
  if (sized.reason || sized.qty <= 0) {
    return { execution_id: executionId, placed: false, skipped: true, reason: sized.reason ?? "computed quantity is zero" };
  }
  if (phase.action.side === "SELL" && strategy.dsl.mode === "paper" && sized.qty > context.positionQty) {
    return {
      execution_id: executionId,
      placed: false,
      blocked: true,
      reason: `paper position has ${context.positionQty} ${strategy.symbol}; cannot sell ${sized.qty}`,
    };
  }

  const fillPrice = currentPrice;
  const notionalUsd = sized.qty * fillPrice;
  const maxNotional = strategy.dsl.guardrails?.max_notional_usd;
  if (maxNotional !== undefined && notionalUsd > maxNotional) {
    return {
      execution_id: executionId,
      placed: false,
      blocked: true,
      reason: `strategy max_notional_usd is ${maxNotional}; simulated action is ${notionalUsd}`,
    };
  }
  const totalBudget = strategy.dsl.guardrails?.total_budget_usd;
  if (phase.action.side === "BUY" && totalBudget !== undefined) {
    const prior = await listExecutions(strategy.id);
    const spent = prior.reduce((sum, entry) => {
      const result = entry.order_result;
      const side = result?.["side"];
      const quantity = result?.["quantity"];
      const price = result?.["fill_price"];
      return side === "BUY" && typeof quantity === "number" && typeof price === "number"
        ? sum + quantity * price
        : sum;
    }, 0);
    if (spent + notionalUsd > totalBudget) {
      return {
        execution_id: executionId,
        placed: false,
        blocked: true,
        reason: `strategy total_budget_usd is ${totalBudget}; ${spent} is already used and this action needs ${notionalUsd}`,
      };
    }
  }
  let realizedPnl = 0;
  if (strategy.dsl.mode === "paper") {
    if (phase.action.side === "BUY") await applyBuy(strategy.symbol, sized.qty, fillPrice);
    else realizedPnl = await applySell(strategy.symbol, sized.qty, fillPrice);
    await recordAutoTrade(utcDateString(now), realizedPnl);
  }

  await appendExecution({
    ts: now.toISOString(),
    strategy_id: strategy.id,
    phase_id: phase.id,
    phase_name: phase.name,
    execution_id: executionId,
    trigger_snapshot: {
      price: currentPrice,
      symbol: strategy.symbol,
      trigger_type: phase.price_trigger.type,
      quantity: sized.qty,
      ...(triggerObserved ?? {}),
    },
    order_result: {
      mode: strategy.dsl.mode,
      simulated: true,
      side: phase.action.side,
      quantity: sized.qty,
      fill_price: fillPrice,
      broker_order_submitted: false,
    },
    realized_pnl: realizedPnl,
  });

  return {
    execution_id: executionId,
    placed: true,
    fill_price: fillPrice,
    quantity: sized.qty,
    realized_pnl: realizedPnl,
  };
}
