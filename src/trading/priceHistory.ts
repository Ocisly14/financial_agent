import type { OhlcSample } from "../../mcp_tools/trading/strategy/priceTrigger.ts";
import { fetchStockStrategyPrice, fetchStockStrategySamples } from "./stockStrategyMarketData.ts";

/**
 * In-memory rolling OHLC buffer per stock symbol. Historical samples come from
 * the shared local stock database; current prices come from Alpaca snapshots.
 */

const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const buffers = new Map<string, OhlcSample[]>();

/** Replace a symbol's buffer with backfilled klines covering >= windowMinutes. */
export async function backfill(symbol: string, windowMinutes: number): Promise<void> {
  const limit = Math.min(Math.max(windowMinutes + 5, 10), 10_000);
  buffers.set(symbol, await fetchStockStrategySamples(symbol, limit));
}

/** Append a single price sample and prune anything older than the retention window. */
export function appendPrice(symbol: string, price: number, ts: number): void {
  const buf = buffers.get(symbol) ?? [];
  buf.push({ ts, high: price, low: price, close: price });
  const cutoff = ts - RETAIN_MS;
  buffers.set(symbol, buf.filter((s) => s.ts >= cutoff));
}

/** Poll the latest stock price, append it to the buffer, and return it. */
export async function pollPrice(symbol: string, now: number): Promise<number> {
  const price = await fetchStockStrategyPrice(symbol);
  if (price > 0) appendPrice(symbol, price, now);
  return price;
}

/** Samples within the last `windowMinutes` (used for rolling-window trigger evaluation). */
export function windowSamples(symbol: string, windowMinutes: number, now: number): OhlcSample[] {
  const cutoff = now - windowMinutes * 60 * 1000;
  return (buffers.get(symbol) ?? []).filter((s) => s.ts >= cutoff);
}

/** Whether the buffer spans at least `windowMinutes` (armed for evaluation). */
export function isArmed(symbol: string, windowMinutes: number, now: number): boolean {
  const buf = buffers.get(symbol) ?? [];
  const oldest = buf[0];
  if (oldest === undefined) return false;
  return now - oldest.ts >= windowMinutes * 60 * 1000;
}

/** Test/maintenance helper: clear all buffers. */
export function resetBuffers(): void {
  buffers.clear();
}
