// Local core type definitions used across the client.
// These are minimal, intentionally-loose shapes for symbols the UI references
// at compile time only (all import sites use `import type`, so nothing here
// ships at runtime). They mirror the permissive shapes the original
// @elizaos/core exposed, so verbatim-copied components type-check unchanged.

export type UUID = string;

export interface Character {
  name?: string;
  username?: string;
  system?: string;
  bio?: string | string[];
  lore?: string[];
  modelProvider?: string;
  settings?: Record<string, any>;
  [k: string]: any;
}

export interface Content {
  text?: string;
  action?: string;
  source?: string;
  url?: string;
  inReplyTo?: UUID;
  attachments?: any[];
  [k: string]: any;
}

// CEX trading types — the original @elizaos/core shapes were richer than we
// need (this UI is present-but-inert here). Keep them fully permissive so the
// verbatim-copied trading dialogs type-check without reproducing the schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type cexParamDef = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CEXCanonicalExchangeCapabilities = any;

// Auto-trading strategy types — mirrors src/trading/persistence/strategyStore.ts
// and mcp_tools/trading/strategy/{priceStrategy,priceTrigger}.ts. Kept minimal
// and permissive (extra fields via [k: string]: any) since the client never
// imports server-side paths directly.

export type StrategyLifecycle =
  | "draft"
  | "pending_approval"
  | "active"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface PriceTrigger {
  type:
    | "rolling_change"
    | "absolute_threshold"
    | "trailing_stop"
    | "rsi_threshold"
    | "macd_cross"
    | "moving_average_cross";
  direction: "up" | "down" | "above" | "below" | "bullish" | "bearish";
  pct?: number;
  window_minutes?: number;
  price?: number;
  reference_price?: number;
  threshold?: number;
  period?: number;
  fast_period?: number;
  slow_period?: number;
  signal_period?: number;
  average_type?: "sma" | "ema";
  timeframe?: string;
  confirm_samples?: number;
  [k: string]: any;
}

export interface StrategyAction {
  side: "BUY" | "SELL";
  size: {
    type: "pct_of_position" | "pct_of_portfolio" | "fixed_quote_usd" | "fixed_base_qty";
    value: number;
  };
  order_type: "market" | "marketable_limit";
  max_slippage_bps?: number;
  [k: string]: any;
}

export interface StrategyRecurrence {
  mode: "one_shot" | "recurring";
  cooldown_minutes?: number;
  reanchor?: boolean;
  max_triggers?: number;
  trigger_count?: number;
  [k: string]: any;
}

export interface PriceStrategyDSL {
  name: string;
  symbol: string;
  mode: "paper" | "shadow" | "live";
  phases: StrategyPhase[];
  guardrails?: { max_notional_usd?: number; total_budget_usd?: number };
  [k: string]: any;
}

export interface StrategyPhase {
  id: string;
  name: string;
  status: "active" | "running" | "completed" | "paused" | "failed";
  price_trigger: PriceTrigger;
  action: StrategyAction;
  recurrence: StrategyRecurrence;
  failure_reason?: string;
  [k: string]: any;
}

export interface StoredStrategy {
  id: string;
  owner: string;
  symbol: string;
  status: StrategyLifecycle;
  created_at: string;
  dsl: PriceStrategyDSL;
  running?: { execution_id: string; order_id?: string; started_at: string };
  failure_reason?: string;
  [k: string]: any;
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
  [k: string]: any;
}
