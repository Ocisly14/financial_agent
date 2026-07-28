import { readdir } from "node:fs/promises";
import type { PriceStrategyDSL } from "../../../mcp_tools/trading/strategy/priceStrategy.ts";
import { readJson, writeJsonAtomic, appendJsonl, readJsonl } from "./atomicJson.ts";
import { strategiesDir, strategyPath, executionsLogPath } from "./paths.ts";

export type StrategyLifecycle =
  | "draft"
  | "pending_approval"
  | "active"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface StoredStrategy {
  id: string;
  owner: string;
  symbol: string;
  status: StrategyLifecycle;
  created_at: string;
  dsl: PriceStrategyDSL;
  running?: { execution_id: string; phase_id: string; order_id?: string; started_at: string };
  failure_reason?: string;
}

export interface ExecutionLogEntry {
  ts: string;
  strategy_id: string;
  phase_id: string;
  phase_name: string;
  execution_id: string;
  order_id?: string;
  client_order_id?: string;
  trigger_snapshot?: Record<string, unknown>;
  order_result?: Record<string, unknown>;
  realized_pnl?: number;
}

export async function saveStrategy(strategy: StoredStrategy): Promise<void> {
  await writeJsonAtomic(strategyPath(strategy.id), strategy);
}

export async function loadStrategy(id: string): Promise<StoredStrategy | undefined> {
  const s = await readJson<unknown>(strategyPath(id), null);
  return isStoredStrategy(s) ? s : undefined;
}

function isStoredStrategy(value: unknown): value is StoredStrategy {
  if (!value || typeof value !== "object") return false;
  const s = value as { dsl?: { phases?: unknown }; id?: unknown; symbol?: unknown; status?: unknown };
  return (
    typeof s.id === "string" &&
    typeof s.symbol === "string" &&
    typeof s.status === "string" &&
    Boolean(s.dsl) &&
    Array.isArray(s.dsl?.phases) &&
    s.dsl.phases.length > 0
  );
}

/** Load every persisted strategy. Optionally filter by lifecycle status. */
export async function listStrategies(status?: StrategyLifecycle): Promise<StoredStrategy[]> {
  let files: string[];
  try {
    files = await readdir(strategiesDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const ids = files
    .filter((f) => f.startsWith("strategy-") && f.endsWith(".json"))
    .map((f) => f.slice("strategy-".length, -".json".length));
  const loaded = await Promise.all(ids.map((id) => loadStrategy(id)));
  const all = loaded.filter((s): s is StoredStrategy => s !== undefined);
  return status ? all.filter((s) => s.status === status) : all;
}

export async function appendExecution(entry: ExecutionLogEntry): Promise<void> {
  await appendJsonl(executionsLogPath(), entry);
}

/** Read the executions log, optionally filtered to one strategy. */
export async function listExecutions(strategyId?: string): Promise<ExecutionLogEntry[]> {
  const all = await readJsonl<ExecutionLogEntry>(executionsLogPath());
  return strategyId ? all.filter((e) => e.strategy_id === strategyId) : all;
}

export type ManageOp = "pause" | "resume" | "cancel";

/**
 * Apply a pause/resume/cancel lifecycle transition to a strategy. Mutates
 * `strategy` in place on success; the caller is responsible for persisting
 * via `saveStrategy`.
 */
export function applyStrategyOp(
  strategy: StoredStrategy,
  op: ManageOp,
): { ok: true; strategy: StoredStrategy } | { ok: false; error: string } {
  if (op === "cancel") {
    if (strategy.status === "completed" || strategy.status === "cancelled") {
      return { ok: false, error: `Strategy ${strategy.id} is already ${strategy.status}.` };
    }
    strategy.status = "cancelled";
    return { ok: true, strategy };
  }

  if (op === "pause") {
    if (strategy.status !== "active") {
      return { ok: false, error: `Strategy ${strategy.id} cannot be paused from status '${strategy.status}'.` };
    }
    strategy.status = "paused";
    return { ok: true, strategy };
  }

  // resume
  if (strategy.status !== "paused") {
    return { ok: false, error: `Strategy ${strategy.id} cannot be resumed from status '${strategy.status}'.` };
  }
  strategy.status = "active";
  return { ok: true, strategy };
}
