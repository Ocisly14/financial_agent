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
    | "relative_change"
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
  mode: "paper" | "shadow";
  phases: StrategyPhase[];
  guardrails?: { max_notional_usd?: number; total_budget_usd?: number };
  [k: string]: any;
}

export interface StrategyPhase {
  id: string;
  name: string;
  status: "waiting" | "active" | "running" | "completed" | "paused" | "cancelled" | "failed";
  depends_on: string[];
  activate_on: "first_fill" | "phase_completed";
  price_anchor?: { type: "phase_fill"; phase_id: string };
  cancel_group?: string;
  price_trigger: PriceTrigger;
  action: StrategyAction;
  recurrence: StrategyRecurrence;
  last_fill?: { execution_id: string; price: number; quantity: number; side: "BUY" | "SELL"; at: string };
  cancel_reason?: string;
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

/** What kind of investigation a Topic is. Mirrors `TOPIC_CATEGORIES` in
 *  src/infra/db/sqliteEventStore.ts — the array ORDER is also the order the
 *  rail prints the groups in, so the two must not drift.
 *
 *  Each boundary falls where the reader's next action differs, which is why
 *  asset class (crypto / commodities / FX) is deliberately absent: it is an
 *  orthogonal axis that surfaces through `leadSymbol` instead. */
export const TOPIC_CATEGORIES = [
  "single_name",
  "comparative",
  "sector",
  "macro",
  "strategy",
  "portfolio",
] as const;

export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

export type TopicSummary = {
  id: string;
  name: string;
  /** Derived from the topic's charts — the first visible chart (lowest sort order). Never written directly. */
  leadSymbol: string | null;
  createdAt: number;
  lastMessage: { text: string; createdAt: number } | null;
  messageCount: number;
  /** Background SMALL-model blurb. Null until the topic has had a turn. */
  summary: string | null;
  category: TopicCategory | null;
  /** True once the user picked the category by hand — the model stops overwriting it. */
  categoryLocked: boolean;
};

/** A multi-ticker comparison a topic_charts row of kind "overlay" carries.
 *  Mirrors `OverlaySpec` in src/infra/db/sqliteEventStore.ts. */
/** `range` is a number of trading days — see client/src/lib/stockChart.ts. */
export type OverlaySpec = { symbols: string[]; range: number; normalize: "pct" | "index100" };

/** The user's intent for the chart-tab set. Does not include study content — that's derived from
 *  messages. A discriminated union, not two nullable fields, mirroring
 *  `TopicChartPreferenceRow` in src/infra/db/sqliteEventStore.ts byte for byte: a nullable-both-fields
 *  shape would push every use site back to hand-rolled null checks instead of letting the compiler
 *  force the branch. */
export type TopicChartPreference =
  | { id: string; kind: "symbol"; symbol: string; /** null means follow the range derived from the messages. */ range: number | null; hidden: boolean; sortOrder: number }
  | { id: string; kind: "overlay"; overlay: OverlaySpec; range: number | null; hidden: boolean; sortOrder: number };

// ── Research (phase 2 research layer, docs/superpowers/specs/2026-07-30-research-layer-design.md) ──
// A Research groups several Topics under one controller agent that can ask
// them questions and compare them. Its id doubles as its chat session id,
// exactly like a Topic (see src/server/server.ts).

export type ResearchSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
};

/** A Research's member, resolved server-side to the same shape the Topic
 *  routes return (GET/PUT .../researches/:id/members). A member whose Topic
 *  was deleted is silently skipped rather than returned as a hole — see
 *  `researchMembers()` in src/server/server.ts. */
export type ResearchMember = TopicSummary;

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
