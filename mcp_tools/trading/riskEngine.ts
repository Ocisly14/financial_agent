import type {
  RiskContext,
  RiskDecision,
  RiskPreferences,
  RiskRuleId,
  RiskRuleResult,
  RiskVerdict,
  TradeIntent,
} from "./riskTypes.ts";
import { BACKSTOP_DENIED_ASSETS, DEFAULT_RISK_PREFERENCES } from "./riskTypes.ts";

// ── Rule helpers ──────────────────────────────────────────────────────────────
const WRITE_ACTIONS = new Set(["create_order", "cancel_order", "amend_order", "preview_order"]);

function allow(id: RiskRuleId): RiskRuleResult { return { id, verdict: "allow" }; }

// ── Rules (one function each) ─────────────────────────────────────────────────

function killSwitchRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (!ctx.preferences.kill_switch_active) return allow("killSwitch");
  if (WRITE_ACTIONS.has(intent.action)) {
    return { id: "killSwitch", verdict: "block", explanation: "Trading is currently disabled — kill switch active" };
  }
  return allow("killSwitch");
}

function liveTradingGlobalKillRule(intent: TradeIntent, _ctx: RiskContext): RiskRuleResult {
  const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
  const raw = process.env["LIVE_TRADING_GLOBAL_KILL"];
  const active = raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
  if (!active) return allow("liveTradingGlobalKill");
  if (intent.mode !== "live") return allow("liveTradingGlobalKill");
  if (!WRITE_ACTIONS.has(intent.action)) return allow("liveTradingGlobalKill");
  return {
    id: "liveTradingGlobalKill",
    verdict: "block",
    explanation: "Global live-trading kill switch is active — paper / shadow remain available",
  };
}

function unknownStateBlockerRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order") return allow("unknownStateBlocker");
  const unknown = ctx.unknown_state_orders_on_pair ?? 0;
  if (unknown > 0) {
    return {
      id: "unknownStateBlocker",
      verdict: "block",
      explanation: `${unknown} order(s) in unknown state on this pair — wait for reconciliation before submitting`,
      metadata: { unknown_state_orders_on_pair: unknown },
    };
  }
  return allow("unknownStateBlocker");
}

function assetAllowlistRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action === "get_balance") return allow("assetAllowlist");
  if (!intent.symbol) return allow("assetAllowlist");
  const base = extractBase(intent.symbol).toUpperCase();
  if (BACKSTOP_DENIED_ASSETS.has(base)) {
    return { id: "assetAllowlist", verdict: "block", explanation: `Asset ${base} is on the platform's restricted list`, metadata: { base } };
  }
  const prefs = ctx.preferences;
  const blocklist = prefs.asset_blocklist.map((s) => s.toUpperCase());
  const allowlist = prefs.asset_allowlist.map((s) => s.toUpperCase());
  if (blocklist.includes(base)) {
    return { id: "assetAllowlist", verdict: "block", explanation: `Asset ${base} is on your blocklist`, metadata: { base } };
  }
  if (allowlist.length > 0 && !allowlist.includes(base)) {
    return { id: "assetAllowlist", verdict: "block", explanation: `Asset ${base} is not on your allowlist`, metadata: { base, allowlist } };
  }
  return allow("assetAllowlist");
}

function leverageCapRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order") return allow("leverageCap");
  const raw = intent.margin_context?.leverage;
  if (raw === null || raw === undefined) return allow("leverageCap");
  const requested = typeof raw === "number" ? raw : Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(requested) || requested <= 1) return allow("leverageCap");
  const userMax = ctx.preferences.max_leverage;
  const effectiveMax = Number.isFinite(userMax) && userMax > 0 ? Math.min(userMax, 10) : 10;
  if (requested > effectiveMax) {
    return {
      id: "leverageCap",
      verdict: "block",
      explanation: `Requested leverage ${requested}x exceeds maximum ${effectiveMax}x`,
      metadata: { requested, effectiveMax },
    };
  }
  return allow("leverageCap");
}

function minOrderSizeRule(intent: TradeIntent, _ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order" && intent.action !== "preview_order") return allow("minOrderSize");
  const base = intent.size?.base_size;
  const quote = intent.size?.quote_size;
  const ok = (v: string | undefined) => typeof v === "string" && Number.isFinite(Number(v)) && Number(v) > 0;
  if (ok(base) || ok(quote)) return allow("minOrderSize");
  if (base === undefined && quote === undefined) {
    return { id: "minOrderSize", verdict: "block", explanation: "Order size missing: both base_size and quote_size are absent" };
  }
  return { id: "minOrderSize", verdict: "block", explanation: "Order size must be strictly positive" };
}

function maxOrderSizeRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order" && intent.action !== "preview_order") return allow("maxOrderSize");
  const max = ctx.preferences.max_order_notional_usd;
  const est = ctx.estimated_notional_usd;
  if (est === undefined || est <= 0) return allow("maxOrderSize");
  if (est > max) {
    return {
      id: "maxOrderSize",
      verdict: "block",
      explanation: `Order notional ${est.toFixed(2)} USD exceeds max ${max.toFixed(2)} USD`,
      metadata: { estimated_notional_usd: est, max_order_notional_usd: max },
    };
  }
  return allow("maxOrderSize");
}

function exposureCapRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order") return allow("exposureCap");
  const cap = ctx.preferences.max_order_notional_usd * 5;
  const open = ctx.open_exposure_usd ?? 0;
  const est = ctx.estimated_notional_usd ?? 0;
  const projected = open + est;
  if (projected > cap) {
    return {
      id: "exposureCap",
      verdict: "block",
      explanation: `Projected open exposure ${projected.toFixed(2)} USD exceeds cap ${cap.toFixed(2)} USD`,
      metadata: { open_exposure_usd: open, estimated_notional_usd: est, exposure_cap_usd: cap },
    };
  }
  return allow("exposureCap");
}

function dailyLossLimitRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order") return allow("dailyLossLimit");
  const limit = ctx.preferences.daily_loss_limit_usd;
  const pnl = ctx.rolling_24h_pnl_usd;
  if (pnl === undefined) return allow("dailyLossLimit");
  const loss = pnl < 0 ? -pnl : 0;
  if (loss >= limit) {
    return {
      id: "dailyLossLimit",
      verdict: "block",
      explanation: `24h realized loss ${loss.toFixed(2)} USD reached daily limit ${limit.toFixed(2)} USD`,
      metadata: { rolling_24h_pnl_usd: pnl, daily_loss_limit_usd: limit },
    };
  }
  return allow("dailyLossLimit");
}

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

function slippageCapRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order") return allow("slippageCap");
  const profileCap = ctx.preferences.slippage_bps_max;
  const userCap = intent.execution_constraints?.slippage_bps_max;
  const cap = userCap !== undefined ? Math.min(userCap, profileCap) : profileCap;
  const est = ctx.estimated_slippage_bps;
  if (est === undefined || est < 0) return allow("slippageCap");
  if (est > cap) {
    return {
      id: "slippageCap",
      verdict: "block",
      explanation: `Estimated slippage ${est} bps exceeds cap ${cap} bps`,
      metadata: { estimated_slippage_bps: est, slippage_bps_max: cap },
    };
  }
  return allow("slippageCap");
}

function priceDeviationRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order") return allow("priceDeviation");
  if (intent.order_type === "market" || intent.order_type === undefined) return allow("priceDeviation");
  const limitPriceRaw = intent.price_params?.limit_price;
  if (!limitPriceRaw) return allow("priceDeviation");
  const limit = Number.parseFloat(limitPriceRaw);
  if (!Number.isFinite(limit) || limit <= 0) return allow("priceDeviation");
  const mid = ctx.market_mid_usd;
  if (mid === undefined || !Number.isFinite(mid) || mid <= 0) return allow("priceDeviation");
  const profileCap = ctx.preferences.price_deviation_max_pct;
  const userCap = intent.execution_constraints?.price_deviation_max_pct;
  const cap = userCap !== undefined && Number.isFinite(userCap) ? Math.min(userCap, profileCap) : profileCap;
  const deviation = Math.abs(limit - mid) / mid;
  if (deviation > cap) {
    return {
      id: "priceDeviation",
      verdict: "block",
      explanation: `Limit price ${limit} differs from market ~${mid.toFixed(2)} by ${(deviation * 100).toFixed(2)}% — exceeds cap ${(cap * 100).toFixed(2)}%`,
      metadata: { limit_price: limit, market_mid_usd: mid, deviation_pct: deviation },
    };
  }
  return allow("priceDeviation");
}

function cooldownRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order" && intent.action !== "amend_order") return allow("cooldown");
  const last = ctx.last_failure_at_ms;
  if (last === undefined) return allow("cooldown");
  const now = ctx.now_ms ?? Date.now();
  const elapsedSec = Math.floor((now - last) / 1000);
  const cooldownSec = ctx.preferences.cooldown_seconds_after_fail;
  if (elapsedSec < cooldownSec) {
    return {
      id: "cooldown",
      verdict: "block",
      explanation: `Cooldown active: wait ${cooldownSec - elapsedSec}s after the previous failure`,
      metadata: { elapsed_seconds: elapsedSec, cooldown_seconds: cooldownSec },
    };
  }
  return allow("cooldown");
}

function marketDataFreshnessRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order" && intent.action !== "amend_order") return allow("marketDataFreshness");
  const age = ctx.market_data_age_ms;
  if (age === undefined) return allow("marketDataFreshness");
  const cap = ctx.preferences.market_data_freshness_max_ms;
  if (age > cap) {
    return {
      id: "marketDataFreshness",
      verdict: "block",
      explanation: `Market data is ${Math.round(age / 1000)}s stale (cap ${Math.round(cap / 1000)}s)`,
      metadata: { market_data_age_ms: age, cap_ms: cap },
    };
  }
  if (age > 5_000) {
    return {
      id: "marketDataFreshness",
      verdict: "downgrade_read_only",
      explanation: `Market data is ${Math.round(age / 1000)}s old`,
      metadata: { market_data_age_ms: age },
    };
  }
  return allow("marketDataFreshness");
}

function reconciliationHealthRule(intent: TradeIntent, ctx: RiskContext): RiskRuleResult {
  if (intent.action !== "create_order") return allow("reconciliationHealth");
  const stale = ctx.stale_reconciliation_count ?? 0;
  if (stale >= 3) {
    return {
      id: "reconciliationHealth",
      verdict: "block",
      explanation: `${stale} orders have not been acknowledged within 60s — system health degraded`,
      metadata: { stale_reconciliation_count: stale },
    };
  }
  return allow("reconciliationHealth");
}

// ── Ordered rule list ─────────────────────────────────────────────────────────
type RuleFn = (intent: TradeIntent, ctx: RiskContext) => RiskRuleResult;

const RULES: RuleFn[] = [
  killSwitchRule,
  liveTradingGlobalKillRule,
  unknownStateBlockerRule,
  assetAllowlistRule,
  leverageCapRule,
  minOrderSizeRule,
  maxOrderSizeRule,
  exposureCapRule,
  dailyLossLimitRule,
  maxDailyAutoTradesRule,
  slippageCapRule,
  priceDeviationRule,
  cooldownRule,
  marketDataFreshnessRule,
  reconciliationHealthRule,
];

const RULES_BY_ID: Record<RiskRuleId, RuleFn> = {
  killSwitch: killSwitchRule,
  liveTradingGlobalKill: liveTradingGlobalKillRule,
  unknownStateBlocker: unknownStateBlockerRule,
  assetAllowlist: assetAllowlistRule,
  leverageCap: leverageCapRule,
  minOrderSize: minOrderSizeRule,
  maxOrderSize: maxOrderSizeRule,
  exposureCap: exposureCapRule,
  dailyLossLimit: dailyLossLimitRule,
  maxDailyAutoTrades: maxDailyAutoTradesRule,
  slippageCap: slippageCapRule,
  priceDeviation: priceDeviationRule,
  cooldown: cooldownRule,
  marketDataFreshness: marketDataFreshnessRule,
  reconciliationHealth: reconciliationHealthRule,
};

const VERDICT_RANK: Record<RiskVerdict, number> = { allow: 0, downgrade_read_only: 1, block: 2 };

/**
 * Pure risk evaluation. Pass `rulesToRun` to run only a subset (e.g.
 * re-running priceDeviation + slippageCap at confirm time).
 */
export function evaluate(
  intent: TradeIntent,
  ctx: RiskContext,
  rulesToRun?: string[],
): RiskDecision {
  const activeRules: RuleFn[] =
    Array.isArray(rulesToRun) && rulesToRun.length > 0
      ? rulesToRun.map((id) => RULES_BY_ID[id as RiskRuleId]).filter((fn): fn is RuleFn => typeof fn === "function")
      : RULES;
  const rule_results = activeRules.map((r) => r(intent, ctx));
  let verdict: RiskVerdict = "allow";
  for (const r of rule_results) {
    if (VERDICT_RANK[r.verdict] > VERDICT_RANK[verdict]) verdict = r.verdict;
  }
  const rules_fired: RiskRuleId[] = rule_results.filter((r) => r.verdict !== "allow").map((r) => r.id);
  const seen = new Set<string>();
  const explanations: string[] = [];
  for (const r of rule_results) {
    if (r.verdict === "allow" || !r.explanation || seen.has(r.explanation)) continue;
    seen.add(r.explanation);
    explanations.push(r.explanation);
  }
  return { verdict, rules_fired, explanations, rule_results };
}

/**
 * Build a RiskContext from the in-memory prefs store record.
 * `overrides` is a flat Record<string, number> to avoid exactOptionalPropertyTypes
 * issues at call sites — only numeric context fields are supported here.
 */
export function buildRiskContext(
  prefsRecord: Record<string, unknown> | null,
  overrides?: Record<string, number>,
): RiskContext {
  const prefs: RiskPreferences = {
    max_order_notional_usd: Number(prefsRecord?.["max_order_notional_usd"] ?? DEFAULT_RISK_PREFERENCES.max_order_notional_usd),
    daily_loss_limit_usd: Number(prefsRecord?.["daily_loss_limit_usd"] ?? DEFAULT_RISK_PREFERENCES.daily_loss_limit_usd),
    slippage_bps_max: Number(prefsRecord?.["slippage_bps_max"] ?? DEFAULT_RISK_PREFERENCES.slippage_bps_max),
    asset_allowlist: Array.isArray(prefsRecord?.["asset_allowlist"]) ? prefsRecord["asset_allowlist"] as string[] : DEFAULT_RISK_PREFERENCES.asset_allowlist,
    asset_blocklist: Array.isArray(prefsRecord?.["asset_blocklist"]) ? prefsRecord["asset_blocklist"] as string[] : DEFAULT_RISK_PREFERENCES.asset_blocklist,
    cooldown_seconds_after_fail: Number(prefsRecord?.["cooldown_seconds_after_fail"] ?? DEFAULT_RISK_PREFERENCES.cooldown_seconds_after_fail),
    kill_switch_active: Boolean(prefsRecord?.["kill_switch_active"] ?? false),
    default_mode: (prefsRecord?.["default_mode"] as "live" | "paper" | "shadow") ?? DEFAULT_RISK_PREFERENCES.default_mode,
    market_data_freshness_max_ms: Number(prefsRecord?.["market_data_freshness_max_ms"] ?? DEFAULT_RISK_PREFERENCES.market_data_freshness_max_ms),
    price_deviation_max_pct: Number(prefsRecord?.["price_deviation_max_pct"] ?? DEFAULT_RISK_PREFERENCES.price_deviation_max_pct),
    max_leverage: Number(prefsRecord?.["max_leverage"] ?? DEFAULT_RISK_PREFERENCES.max_leverage),
    max_daily_auto_trades: Number(prefsRecord?.["max_daily_auto_trades"] ?? DEFAULT_RISK_PREFERENCES.max_daily_auto_trades),
  };
  const ctx: RiskContext = { preferences: prefs, now_ms: Date.now() };
  if (overrides) {
    if ("estimated_notional_usd" in overrides) ctx.estimated_notional_usd = overrides["estimated_notional_usd"];
    if ("market_mid_usd" in overrides) ctx.market_mid_usd = overrides["market_mid_usd"];
    if ("market_data_age_ms" in overrides) ctx.market_data_age_ms = overrides["market_data_age_ms"];
    if ("last_failure_at_ms" in overrides) ctx.last_failure_at_ms = overrides["last_failure_at_ms"];
    if ("estimated_slippage_bps" in overrides) ctx.estimated_slippage_bps = overrides["estimated_slippage_bps"];
    if ("rolling_24h_pnl_usd" in overrides) ctx.rolling_24h_pnl_usd = overrides["rolling_24h_pnl_usd"];
    if ("open_exposure_usd" in overrides) ctx.open_exposure_usd = overrides["open_exposure_usd"];
    if ("stale_reconciliation_count" in overrides) ctx.stale_reconciliation_count = overrides["stale_reconciliation_count"];
    if ("unknown_state_orders_on_pair" in overrides) ctx.unknown_state_orders_on_pair = overrides["unknown_state_orders_on_pair"];
    if ("daily_auto_trade_count" in overrides) ctx.daily_auto_trade_count = overrides["daily_auto_trade_count"];
  }
  return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractBase(symbol: string): string {
  const dashIdx = symbol.indexOf("-");
  if (dashIdx > 0) return symbol.slice(0, dashIdx);
  return symbol.length > 3 ? symbol.slice(0, 3) : symbol;
}

export type { TradeIntent, RiskContext, RiskDecision, RiskPreferences, RiskRuleId, RiskRuleResult, RiskVerdict };
