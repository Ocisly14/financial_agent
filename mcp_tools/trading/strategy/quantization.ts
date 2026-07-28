import type { SymbolFilters } from "../../../src/trading/marketData.ts";

/** Number of decimal places implied by a step/tick string like "0.001" → 3, "1" → 0. */
function decimalsOf(step: string): number {
  if (!step.includes(".")) return 0;
  const frac = step.split(".")[1] ?? "";
  // Trailing zeros are significant for Binance step strings (e.g. "0.00100000"),
  // but the effective precision is the position of the last non-zero digit.
  const trimmed = frac.replace(/0+$/, "");
  return trimmed.length;
}

/** Floor `value` down to the nearest multiple of `step` (string step like "0.001"). */
export function floorToStep(value: number, step: string): number {
  const stepNum = Number.parseFloat(step);
  if (!(stepNum > 0)) return value;
  const floored = Math.floor(value / stepNum) * stepNum;
  // Re-round to the step's decimal precision to kill float drift (e.g. 0.1+0.2).
  return Number(floored.toFixed(decimalsOf(step)));
}

export interface QuantizeResult {
  ok: boolean;
  /** Step-aligned quantity (only meaningful when ok). */
  quantity: number;
  /** Reason the order should be skipped, when ok is false. */
  reason?: string;
}

/**
 * Quantize an order quantity against exchange filters.
 * - Floors quantity to LOT_SIZE step (flooring is safe for sells — never oversell).
 * - Rejects (ok:false) when the result is below minQty or below minNotional.
 */
export function quantizeQuantity(
  rawQuantity: number,
  referencePriceUsd: number,
  filters: SymbolFilters,
): QuantizeResult {
  const quantity = floorToStep(rawQuantity, filters.stepSize);
  if (quantity <= 0 || quantity < filters.minQty) {
    return { ok: false, quantity, reason: `quantity ${quantity} below minQty ${filters.minQty}` };
  }
  const notional = quantity * referencePriceUsd;
  if (filters.minNotional > 0 && notional < filters.minNotional) {
    return { ok: false, quantity, reason: `notional ${notional.toFixed(2)} below minNotional ${filters.minNotional}` };
  }
  return { ok: true, quantity };
}

/** Round a price to the PRICE_FILTER tick size. */
export function quantizePrice(price: number, filters: SymbolFilters): number {
  return floorToStep(price, filters.tickSize);
}

/** Protective limit price for a marketable-limit order: current ∓ slippage bps. */
export function protectiveLimitPrice(
  side: "BUY" | "SELL",
  currentPrice: number,
  maxSlippageBps: number,
  filters: SymbolFilters,
): number {
  const offset = currentPrice * (maxSlippageBps / 10_000);
  const raw = side === "SELL" ? currentPrice - offset : currentPrice + offset;
  return quantizePrice(raw, filters);
}
