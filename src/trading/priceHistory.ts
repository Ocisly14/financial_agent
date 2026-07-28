import type { OhlcSample } from "../../mcp_tools/trading/strategy/priceTrigger.ts";
import { fetchKlines, fetchMidPrice } from "./marketData.ts";

/**
 * In-memory rolling OHLC buffer per symbol (~1h retained). Backfilled from
 * Binance klines on activation/restart so rolling-window triggers evaluate
 * immediately; appended to each poll from the live mid price.
 */

const RETAIN_MS = 60 * 60 * 1000; // keep ~1 hour
const buffers = new Map<string, OhlcSample[]>();

/** Replace a symbol's buffer with backfilled klines covering >= windowMinutes. */
export async function backfill(symbol: string, windowMinutes: number): Promise<void> {
  const limit = Math.min(Math.max(windowMinutes + 5, 10), 60);
  const klines = await fetchKlines(symbol, "1m", limit);
  buffers.set(symbol, klines);
}

/** Append a single price sample and prune anything older than the retention window. */
export function appendPrice(symbol: string, price: number, ts: number): void {
  const buf = buffers.get(symbol) ?? [];
  buf.push({ ts, high: price, low: price, close: price });
  const cutoff = ts - RETAIN_MS;
  buffers.set(symbol, buf.filter((s) => s.ts >= cutoff));
}

/** Poll the live mid price, append it to the buffer, and return it (0 if unavailable). */
export async function pollPrice(symbol: string, now: number): Promise<number> {
  const price = await fetchMidPrice(symbol);
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
