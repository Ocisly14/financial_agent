import { readJson, writeJsonAtomic } from "./atomicJson.ts";
import { dailyPnlPath } from "./paths.ts";

export interface DailyPnl {
  date: string; // YYYY-MM-DD (UTC)
  realized_pnl_usd: number;
  trade_count: number;
}

/** UTC calendar date string (YYYY-MM-DD) for a given instant. */
export function utcDateString(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export async function loadDailyPnl(date: string): Promise<DailyPnl> {
  return readJson<DailyPnl>(dailyPnlPath(date), { date, realized_pnl_usd: 0, trade_count: 0 });
}

/**
 * Record one realized auto-trade for the given UTC date: add realized PnL and
 * increment the trade count. New day -> fresh file (rollover is implicit because
 * the path is keyed by date). Persists and returns the updated record.
 */
export async function recordAutoTrade(date: string, realizedPnlUsd: number): Promise<DailyPnl> {
  const cur = await loadDailyPnl(date);
  const next: DailyPnl = {
    date,
    realized_pnl_usd: cur.realized_pnl_usd + realizedPnlUsd,
    trade_count: cur.trade_count + 1,
  };
  await writeJsonAtomic(dailyPnlPath(date), next);
  return next;
}
