import { getSnapshotCached } from "../data/stock/alpacaClient.ts";
import { getSharedBarRepository } from "../data/stock/sharedRepository.ts";
import type { OhlcSample } from "../../mcp_tools/trading/strategy/priceTrigger.ts";

/** Latest stock price for strategy validation and monitoring. */
export async function fetchStockStrategyPrice(symbol: string): Promise<number> {
  const normalized = symbol.trim().toUpperCase();
  const snapshot = await getSnapshotCached(normalized, Date.now());
  if (
    snapshot.bidPrice !== null &&
    snapshot.askPrice !== null &&
    snapshot.bidPrice > 0 &&
    snapshot.askPrice > 0
  ) {
    return (snapshot.bidPrice + snapshot.askPrice) / 2;
  }
  if (snapshot.price !== null && snapshot.price > 0) return snapshot.price;
  throw new Error(`No current stock price is available for ${normalized}.`);
}

/** Recent one-minute stock bars from the shared local database (Alpaca-backed). */
export async function fetchStockStrategySamples(
  symbol: string,
  count: number,
): Promise<OhlcSample[]> {
  const repository = await getSharedBarRepository();
  if (!repository) throw new Error("Stock database is unavailable.");
  const bars = await repository.getBars(symbol.trim().toUpperCase(), "1Min", Math.max(1, count));
  return bars.map((bar) => ({
    ts: new Date(bar.t).getTime(),
    high: bar.h,
    low: bar.l,
    close: bar.c,
  })).filter((bar) => Number.isFinite(bar.ts));
}
