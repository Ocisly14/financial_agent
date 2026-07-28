# Auto-Trading Strategy — Plan 2: Persistence + Risk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Workflow constraints for this plan (user preferences):**
> - **No per-task tests.** Implementers write IMPLEMENTATION CODE ONLY. Testing is a single unified pass at the very end, run only when the user asks. (Each task may run `npx tsc --noEmit -p .` to confirm it compiles.)
> - **No autonomous commits.** Do NOT run `git commit`/`git add`. Leave all changes uncommitted; the user commits after review.

**Goal:** Add the durable, file-based persistence layer for the strategy engine (strategies, cost basis, daily PnL, global risk config — all atomic JSON) plus the `maxDailyAutoTrades` risk rule, so guardrails survive restarts and cannot be reset by a crash.

**Architecture:** A small set of focused modules under `src/trading/persistence/` (matching the existing `src/trading/` home for runtime state like `stores.ts`/`reconciliation.ts`). One atomic-IO helper underpins per-domain stores (strategy, cost basis, daily PnL, risk config). The risk engine (`mcp_tools/trading/`) gains one new rule that reads a persisted per-day auto-trade counter. All persisted under a repo-root `data/` directory.

**Tech Stack:** TypeScript (ESM, NodeNext, strict — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node `fs/promises`. Depends on Plan 1's `StrategyDSL` type.

**Spec:** `docs/superpowers/specs/2026-06-10-auto-trading-strategy-design.md` (§6 persistence, §7 cost-basis/daily-PnL, §8 risk integration / `maxDailyAutoTrades`, §8.1 risk_config).

> **Note (not a task step):** `data/` holds runtime state and should not be committed. Add a `data/` line to `.gitignore` when the user is ready to commit — do NOT create a commit for it here.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/trading/persistence/paths.ts` | Resolve all on-disk paths under `data/` |
| `src/trading/persistence/atomicJson.ts` | Atomic JSON write (tmp+rename), JSON read-with-fallback, JSONL append/read |
| `src/trading/persistence/riskConfig.ts` | Global guardrail defaults store (`risk_config.json`) |
| `src/trading/persistence/costBasis.ts` | Per-asset moving-average cost basis; realize PnL on sell |
| `src/trading/persistence/dailyPnl.ts` | Per-UTC-day realized PnL + trade count, with date rollover |
| `src/trading/persistence/strategyStore.ts` | `StoredStrategy` type + CRUD + executions JSONL |
| `mcp_tools/trading/riskTypes.ts` | add `maxDailyAutoTrades` rule id, pref, context field, intent `source` |
| `mcp_tools/trading/riskEngine.ts` | implement + register `maxDailyAutoTradesRule` |

---

## Task 1: Path resolution + atomic JSON IO

**Files:**
- Create: `src/trading/persistence/paths.ts`
- Create: `src/trading/persistence/atomicJson.ts`

- [ ] **Step 1: Create `src/trading/persistence/paths.ts`**

```typescript
import { join } from "node:path";

/** Root for all runtime-persisted state. Not committed to git. */
export const DATA_DIR = join(process.cwd(), "data");

export const strategiesDir = (): string => join(DATA_DIR, "strategies");
export const tradingDir = (): string => join(DATA_DIR, "trading");

export const strategyPath = (id: string): string => join(strategiesDir(), `strategy-${id}.json`);
export const executionsLogPath = (): string => join(strategiesDir(), "executions.log.jsonl");
export const costBasisPath = (): string => join(tradingDir(), "cost_basis.json");
export const dailyPnlPath = (utcDate: string): string => join(tradingDir(), `daily_pnl_${utcDate}.json`);
export const riskConfigPath = (): string => join(tradingDir(), "risk_config.json");
```

- [ ] **Step 2: Create `src/trading/persistence/atomicJson.ts`**

```typescript
import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

let tmpCounter = 0;

/** Read JSON; return `fallback` if the file does not exist. Other errors propagate. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/** Atomically write JSON: write a temp file then rename over the target. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

/** Append one JSON line to a .jsonl file (creating dirs/file as needed). */
export async function appendJsonl(path: string, entry: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Read all JSON lines from a .jsonl file; empty array if the file is missing. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit -p .`
Expected: no errors attributable to these two new files.

---

## Task 2: Global risk config store

Persists the global guardrail defaults the front-end settings page will edit (spec §8.1). Includes the new `max_daily_auto_trades` default.

**Files:**
- Create: `src/trading/persistence/riskConfig.ts`

- [ ] **Step 1: Create `src/trading/persistence/riskConfig.ts`**

```typescript
import { readJson, writeJsonAtomic } from "./atomicJson.ts";
import { riskConfigPath } from "./paths.ts";

/** Global guardrail defaults. All optional at the strategy level; these are the fallback values. */
export interface RiskConfig {
  max_order_notional_usd: number;
  daily_loss_limit_usd: number;
  max_daily_auto_trades: number;
  default_max_slippage_bps: number;
  default_confirm_samples: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  max_order_notional_usd: 1_000,
  daily_loss_limit_usd: 200,
  max_daily_auto_trades: 50,
  default_max_slippage_bps: 50,
  default_confirm_samples: 2,
};

/** Load the persisted risk config, falling back to defaults (and filling any missing keys). */
export async function loadRiskConfig(): Promise<RiskConfig> {
  const stored = await readJson<Partial<RiskConfig>>(riskConfigPath(), {});
  return { ...DEFAULT_RISK_CONFIG, ...stored };
}

/** Persist a full or partial risk config (merged over current values). */
export async function saveRiskConfig(patch: Partial<RiskConfig>): Promise<RiskConfig> {
  const next = { ...(await loadRiskConfig()), ...patch };
  await writeJsonAtomic(riskConfigPath(), next);
  return next;
}
```

- [ ] **Step 2: Type check** — `npx tsc --noEmit -p .` (no errors from this file).

---

## Task 3: Cost-basis store

Per-asset moving weighted-average cost; realize PnL on sells (spec §7.1).

**Files:**
- Create: `src/trading/persistence/costBasis.ts`

- [ ] **Step 1: Create `src/trading/persistence/costBasis.ts`**

```typescript
import { readJson, writeJsonAtomic } from "./atomicJson.ts";
import { costBasisPath } from "./paths.ts";

export interface AssetCostBasis {
  qty: number;
  avg_cost_usd: number;
}

export type CostBasisMap = Record<string, AssetCostBasis>;

export async function loadCostBasis(): Promise<CostBasisMap> {
  return readJson<CostBasisMap>(costBasisPath(), {});
}

/** Record a BUY fill: update qty and moving weighted-average cost. Persists and returns the new entry. */
export async function applyBuy(asset: string, qty: number, priceUsd: number): Promise<AssetCostBasis> {
  const map = await loadCostBasis();
  const prev = map[asset] ?? { qty: 0, avg_cost_usd: 0 };
  const newQty = prev.qty + qty;
  const newAvg = newQty > 0 ? (prev.qty * prev.avg_cost_usd + qty * priceUsd) / newQty : 0;
  const next: AssetCostBasis = { qty: newQty, avg_cost_usd: newAvg };
  map[asset] = next;
  await writeJsonAtomic(costBasisPath(), map);
  return next;
}

/**
 * Record a SELL fill: realize PnL against the average cost and reduce qty.
 * Average cost is unchanged by a sell. Returns the realized PnL in USD.
 */
export async function applySell(asset: string, qty: number, priceUsd: number): Promise<number> {
  const map = await loadCostBasis();
  const prev = map[asset] ?? { qty: 0, avg_cost_usd: 0 };
  const soldQty = Math.min(qty, prev.qty);
  const realized = (priceUsd - prev.avg_cost_usd) * soldQty;
  const newQty = Math.max(0, prev.qty - qty);
  map[asset] = { qty: newQty, avg_cost_usd: newQty > 0 ? prev.avg_cost_usd : 0 };
  await writeJsonAtomic(costBasisPath(), map);
  return realized;
}
```

- [ ] **Step 2: Type check** — `npx tsc --noEmit -p .` (no errors from this file).

---

## Task 4: Daily PnL + trade-count store

Per-UTC-day realized PnL and auto-trade count, with date rollover (spec §7.1). Drives `dailyLossLimit` and `maxDailyAutoTrades` reads.

**Files:**
- Create: `src/trading/persistence/dailyPnl.ts`

- [ ] **Step 1: Create `src/trading/persistence/dailyPnl.ts`**

```typescript
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
 * increment the trade count. New day → fresh file (rollover is implicit because
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
```

- [ ] **Step 2: Type check** — `npx tsc --noEmit -p .` (no errors from this file).

---

## Task 5: Strategy store (CRUD + executions log)

Persist each strategy as its own file plus an append-only executions log. The stored shape wraps Plan 1's `StrategyDSL` with lifecycle metadata (the lifecycle states are richer than the DSL's internal `status`, so we keep them separate).

**Files:**
- Create: `src/trading/persistence/strategyStore.ts`

- [ ] **Step 1: Create `src/trading/persistence/strategyStore.ts`**

```typescript
import { readdir } from "node:fs/promises";
import type { StrategyDSL } from "../../../mcp_tools/trading/strategy/strategyDSL.ts";
import { readJson, writeJsonAtomic, appendJsonl, readJsonl } from "./atomicJson.ts";
import { strategiesDir, strategyPath, executionsLogPath } from "./paths.ts";

export type StrategyLifecycle =
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
  dsl: StrategyDSL;
  running?: { execution_id: string; order_id?: string; started_at: string };
  failure_reason?: string;
}

export interface ExecutionLogEntry {
  ts: string;
  strategy_id: string;
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
  const s = await readJson<StoredStrategy | null>(strategyPath(id), null);
  return s ?? undefined;
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
```

- [ ] **Step 2: Type check** — `npx tsc --noEmit -p .` (no errors from this file; confirm the `StrategyDSL` import path resolves).

---

## Task 6: `maxDailyAutoTrades` risk rule

Add the per-day auto-trade cap (spec §8). Mirrors `dailyLossLimitRule`. Only applies to auto-strategy orders, so we add a `source` discriminator to `TradeIntent`.

**Files:**
- Modify: `mcp_tools/trading/riskTypes.ts`
- Modify: `mcp_tools/trading/riskEngine.ts`

- [ ] **Step 1: Extend types in `mcp_tools/trading/riskTypes.ts`**

1a. Add `"maxDailyAutoTrades"` to the `RiskRuleId` union (append after `"unknownStateBlocker"`):

```typescript
  | "unknownStateBlocker"
  | "maxDailyAutoTrades";
```

1b. Add a `source` field to `TradeIntent` (after the `action: string;` line):

```typescript
  /** "auto_strategy" orders are subject to the maxDailyAutoTrades cap. Defaults to "manual" when absent. */
  source?: "manual" | "auto_strategy";
```

1c. Add a preference to `RiskPreferences` (after `max_leverage: number;`):

```typescript
  max_daily_auto_trades: number;
```

1d. Add the matching default to `DEFAULT_RISK_PREFERENCES` (after `max_leverage: 5,`):

```typescript
  max_daily_auto_trades: 50,
```

1e. Add a context field to `RiskContext` (after `unknown_state_orders_on_pair?: number;`):

```typescript
  /** Count of auto-strategy trades already executed in the current UTC day. */
  daily_auto_trade_count?: number;
```

- [ ] **Step 2: Implement the rule in `mcp_tools/trading/riskEngine.ts`**

2a. Add the rule function immediately after `dailyLossLimitRule` (after its closing brace, before `slippageCapRule`):

```typescript
function maxDailyAutoTradesRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order") return allow("maxDailyAutoTrades");
  if (intent.source !== "auto_strategy") return allow("maxDailyAutoTrades");
  const cap = ctx.preferences.max_daily_auto_trades;
  const count = ctx.daily_auto_trade_count ?? 0;
  if (count >= cap) {
    return {
      id: "maxDailyAutoTrades",
      verdict: "block",
      explanation: `Auto-trade count ${count} reached the daily cap of ${cap}`,
      metadata: { daily_auto_trade_count: count, max_daily_auto_trades: cap },
    };
  }
  return allow("maxDailyAutoTrades");
}
```

2b. Register it in the `RULES` array, immediately after `dailyLossLimitRule,`:

```typescript
  dailyLossLimitRule,
  maxDailyAutoTradesRule,
```

2c. Register it in `RULES_BY_ID`, immediately after the `dailyLossLimit: dailyLossLimitRule,` line:

```typescript
  dailyLossLimit: dailyLossLimitRule,
  maxDailyAutoTrades: maxDailyAutoTradesRule,
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit -p .`
Expected: no errors. (The `RULES_BY_ID` object is typed `Record<RiskRuleId, RuleFn>`, so the new id MUST be added to both the union and this map, or tsc fails — that exhaustiveness is the safety net.)

---

## Self-Review Notes (coverage vs spec)

- §6 persistence layout (strategy files + executions jsonl + cost_basis + daily_pnl + risk_config, atomic writes): Tasks 1–5 ✅
- §7.1 cost basis (moving weighted avg, realize on sell) + daily PnL (realized + trade_count, UTC rollover): Tasks 3–4 ✅
- §8 `maxDailyAutoTrades` (persisted count, blocks auto orders only, restart-safe): Task 6 ✅ (the persisted count is produced by Task 4's `recordAutoTrade`; wiring the count INTO `RiskContext.daily_auto_trade_count` at order time happens in Plan 3's monitor/execution path)
- §8.1 risk_config global defaults + read/write: Task 2 ✅
- Deferred to Plan 3: reading these stores during the monitor loop, updating cost basis / daily PnL on fills, populating `RiskContext` from the persisted stores.

## Deferred to the final unified test pass (per user preference — not in this plan)

When the user asks, write+run tests covering: atomicJson round-trip + ENOENT fallback; cost-basis buy-then-sell realized PnL; daily PnL accumulation + date keying; strategyStore save/load/list/executions; risk engine blocking an `auto_strategy` order at the cap and allowing a `manual` one.
