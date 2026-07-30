import { getSnapshotCached } from "../data/stock/alpacaClient.ts";
import { getSharedBarRepository } from "../data/stock/sharedRepository.ts";
import type { OhlcSample } from "../../mcp_tools/trading/strategy/priceTrigger.ts";
import type { PriceTrigger } from "../../mcp_tools/trading/strategy/priceTrigger.ts";
import { loadTechnicalBars } from "../../mcp_tools/technical/stockTechnicalData.ts";

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

/**
 * Time-aligned bars for RSI/MACD/MA strategy evaluation. The latest stored bar
 * is treated as the current forming bar by replacing its close with the latest
 * snapshot price; this avoids inventing a new bar on every monitor poll.
 */
export async function fetchStockTechnicalStrategySamples(
  symbol: string,
  trigger: PriceTrigger,
  historyBars: number,
  currentPrice: number,
): Promise<OhlcSample[]> {
  if (!("timeframe" in trigger)) throw new Error("Technical trigger timeframe is missing.");
  const loaded = await loadTechnicalBars(
    { symbol, timeframe: trigger.timeframe, history_bars: historyBars },
    Math.min(historyBars, technicalMinimum(trigger)),
    historyBars,
  );
  if (!loaded.ok) throw new Error(loaded.result.error?.message ?? loaded.result.summary);
  const samples = loaded.value.bars.map((bar) => ({
    ts: new Date(bar.t).getTime(),
    high: bar.h,
    low: bar.l,
    close: bar.c,
  })).filter((bar) => Number.isFinite(bar.ts));
  const latest = samples.at(-1);
  if (latest && currentPrice > 0) {
    latest.close = currentPrice;
    latest.high = Math.max(latest.high, currentPrice);
    latest.low = Math.min(latest.low, currentPrice);
  }
  return samples;
}

function technicalMinimum(trigger: PriceTrigger): number {
  if (trigger.type === "rsi_threshold") return trigger.period + 1;
  if (trigger.type === "macd_cross") return trigger.slow_period + trigger.signal_period + 1;
  if (trigger.type === "moving_average_cross") return trigger.slow_period + 1;
  return 2;
}
