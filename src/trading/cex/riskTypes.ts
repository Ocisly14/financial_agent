export type RiskVerdict = "allow" | "block" | "downgrade_read_only";

export type RiskRuleId =
  | "minOrderSize"
  | "maxOrderSize"
  | "dailyLossLimit"
  | "exposureCap"
  | "slippageCap"
  | "priceDeviation"
  | "assetAllowlist"
  | "leverageCap"
  | "cooldown"
  | "killSwitch"
  | "liveTradingGlobalKill"
  | "marketDataFreshness"
  | "reconciliationHealth"
  | "unknownStateBlocker"
  | "maxDailyAutoTrades";

export interface RiskRuleResult {
  id: RiskRuleId;
  verdict: RiskVerdict;
  explanation?: string;
  metadata?: Record<string, unknown>;
}

export interface RiskDecision {
  verdict: RiskVerdict;
  rules_fired: RiskRuleId[];
  explanations: string[];
  rule_results: RiskRuleResult[];
}

/** Simplified intent shape used by the risk engine. */
export interface TradeIntent {
  action: string;
  /** "auto_strategy" orders are subject to the maxDailyAutoTrades cap. Defaults to "manual" when absent. */
  source?: "manual" | "auto_strategy";
  mode: "live" | "paper" | "shadow";
  symbol?: string;
  side?: "BUY" | "SELL";
  size?: { base_size?: string; quote_size?: string };
  order_type?: "market" | "limit" | "stop_limit";
  price_params?: { limit_price?: string; stop_price?: string };
  margin_context?: { leverage?: string | number; margin_type?: string };
  execution_constraints?: {
    slippage_bps_max?: number;
    price_deviation_max_pct?: number;
  };
}

export interface RiskPreferences {
  max_order_notional_usd: number;
  daily_loss_limit_usd: number;
  slippage_bps_max: number;
  asset_allowlist: string[];
  asset_blocklist: string[];
  cooldown_seconds_after_fail: number;
  kill_switch_active: boolean;
  default_mode: "live" | "paper" | "shadow";
  market_data_freshness_max_ms: number;
  price_deviation_max_pct: number;
  max_leverage: number;
  max_daily_auto_trades: number;
}

export interface RiskContext {
  preferences: RiskPreferences;
  rolling_24h_pnl_usd?: number;
  open_exposure_usd?: number;
  estimated_notional_usd?: number;
  estimated_slippage_bps?: number;
  market_data_age_ms?: number;
  market_mid_usd?: number;
  last_failure_at_ms?: number;
  stale_reconciliation_count?: number;
  unknown_state_orders_on_pair?: number;
  /** Count of auto-strategy trades already executed in the current UTC day. */
  daily_auto_trade_count?: number;
  now_ms?: number;
}

export const BACKSTOP_DENIED_ASSETS: ReadonlySet<string> = new Set([
  "LUNA", "LUNC", "UST", "USTC", "FTT", "FTX",
]);

export const DEFAULT_RISK_PREFERENCES: RiskPreferences = {
  max_order_notional_usd: 10_000,
  daily_loss_limit_usd: 200,
  slippage_bps_max: 50,
  asset_allowlist: ["BTC", "ETH", "SOL", "USDT", "USDC"],
  asset_blocklist: [],
  cooldown_seconds_after_fail: 60,
  kill_switch_active: false,
  default_mode: "live",
  market_data_freshness_max_ms: 30_000,
  price_deviation_max_pct: 0.2,
  max_leverage: 5,
  max_daily_auto_trades: 50,
};
