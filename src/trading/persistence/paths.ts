import { join } from "node:path";

/** Root for all runtime-persisted state. Not committed to git. */
export const DATA_DIR = join(process.cwd(), "data");

export const strategiesDir = (): string => join(DATA_DIR, "strategies");
export const tradingDir = (): string => join(DATA_DIR, "trading");

export const strategyPath = (id: string): string => join(strategiesDir(), `strategy-${id}.json`);
export const executionsLogPath = (): string => join(strategiesDir(), "executions.log.jsonl");
export const costBasisPath = (): string => join(tradingDir(), "cost_basis.json");
export const dailyPnlPath = (utcDate: string): string => join(tradingDir(), `daily_pnl_${utcDate}.json`);
