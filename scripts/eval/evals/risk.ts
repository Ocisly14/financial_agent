import { evaluate } from "../../../src/trading/cex/riskEngine.ts";
import { DEFAULT_RISK_PREFERENCES } from "../../../src/trading/cex/riskTypes.ts";
import type { RiskContext, RiskRuleId, TradeIntent } from "../../../src/trading/cex/riskTypes.ts";
import { pct } from "../lib/metrics.ts";
import type { EvalResult } from "../lib/report.ts";

const FIXED_NOW = 1_750_000_000_000; // fixed timestamp; cooldown/global cases are deterministic

type RiskCase = {
  id: string;
  rule: RiskRuleId;
  kind: "violation" | "legal";
  intent: TradeIntent;
  ctx: RiskContext;
  needsGlobalKillEnv?: boolean;
};

const baseIntent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  action: "create_order", mode: "paper", symbol: "BTCUSDT", side: "BUY",
  order_type: "market", size: { quote_size: "100" }, ...over,
});

const baseCtx = (over: Partial<RiskContext> = {}): RiskContext => ({
  preferences: { ...DEFAULT_RISK_PREFERENCES, ...(over.preferences ?? {}) },
  now_ms: FIXED_NOW,
  ...over,
});

const VIOLATIONS: RiskCase[] = [
  { id: "killSwitch", rule: "killSwitch", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ preferences: { ...DEFAULT_RISK_PREFERENCES, kill_switch_active: true } }) },
  { id: "liveTradingGlobalKill", rule: "liveTradingGlobalKill", kind: "violation",
    intent: baseIntent({ mode: "live" }), ctx: baseCtx(), needsGlobalKillEnv: true },
  { id: "unknownStateBlocker", rule: "unknownStateBlocker", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ unknown_state_orders_on_pair: 2 }) },
  { id: "assetAllowlist", rule: "assetAllowlist", kind: "violation",
    intent: baseIntent({ symbol: "LUNA-USD" }), ctx: baseCtx() },
  { id: "leverageCap", rule: "leverageCap", kind: "violation",
    intent: baseIntent({ margin_context: { leverage: 10 } }), ctx: baseCtx() },
  { id: "minOrderSize", rule: "minOrderSize", kind: "violation",
    intent: baseIntent({ size: { quote_size: "0" } }), ctx: baseCtx() },
  { id: "maxOrderSize", rule: "maxOrderSize", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ estimated_notional_usd: 20_000 }) },
  { id: "exposureCap", rule: "exposureCap", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ open_exposure_usd: 60_000, estimated_notional_usd: 1_000 }) },
  { id: "dailyLossLimit", rule: "dailyLossLimit", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ rolling_24h_pnl_usd: -250 }) },
  { id: "maxDailyAutoTrades", rule: "maxDailyAutoTrades", kind: "violation",
    intent: baseIntent({ source: "auto_strategy" }), ctx: baseCtx({ daily_auto_trade_count: 50 }) },
  { id: "slippageCap", rule: "slippageCap", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ estimated_slippage_bps: 100 }) },
  { id: "priceDeviation", rule: "priceDeviation", kind: "violation",
    intent: baseIntent({ order_type: "limit", price_params: { limit_price: "70000" } }),
    ctx: baseCtx({ market_mid_usd: 100_000 }) },
  { id: "cooldown", rule: "cooldown", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ last_failure_at_ms: FIXED_NOW - 10_000 }) },
  { id: "marketDataFreshness", rule: "marketDataFreshness", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ market_data_age_ms: 60_000 }) },
  { id: "reconciliationHealth", rule: "reconciliationHealth", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ stale_reconciliation_count: 5 }) },
];

const LEGAL: RiskCase[] = [
  { id: "legal-market-buy", rule: "minOrderSize", kind: "legal", intent: baseIntent(), ctx: baseCtx() },
  { id: "legal-limit-near-mid", rule: "priceDeviation", kind: "legal",
    intent: baseIntent({ order_type: "limit", price_params: { limit_price: "100050" } }),
    ctx: baseCtx({ market_mid_usd: 100_000 }) },
  { id: "legal-auto-low-count", rule: "maxDailyAutoTrades", kind: "legal",
    intent: baseIntent({ source: "auto_strategy" }), ctx: baseCtx({ daily_auto_trade_count: 3 }) },
  { id: "legal-leverage-ok", rule: "leverageCap", kind: "legal",
    intent: baseIntent({ margin_context: { leverage: 2 } }), ctx: baseCtx() },
  { id: "legal-fresh-data", rule: "marketDataFreshness", kind: "legal",
    intent: baseIntent(), ctx: baseCtx({ market_data_age_ms: 1_000 }) },
];

function runCase(c: RiskCase): { blocked: boolean; firedTarget: boolean } {
  const prev = process.env["LIVE_TRADING_GLOBAL_KILL"];
  if (c.needsGlobalKillEnv) process.env["LIVE_TRADING_GLOBAL_KILL"] = "1";
  try {
    const d = evaluate(c.intent, c.ctx);
    return { blocked: d.verdict !== "allow", firedTarget: d.rules_fired.includes(c.rule) };
  } finally {
    if (c.needsGlobalKillEnv) {
      if (prev === undefined) delete process.env["LIVE_TRADING_GLOBAL_KILL"];
      else process.env["LIVE_TRADING_GLOBAL_KILL"] = prev;
    }
  }
}

export function runRiskEval(): EvalResult {
  const gateViolations: string[] = [];
  let blockedViolations = 0;
  for (const c of VIOLATIONS) {
    const { blocked, firedTarget } = runCase(c);
    if (!blocked || !firedTarget) {
      gateViolations.push(`③ violation '${c.id}' not blocked by rule ${c.rule} (blocked=${blocked}, firedTarget=${firedTarget})`);
    } else blockedViolations++;
  }
  let falseBlocks = 0;
  for (const c of LEGAL) {
    const { blocked } = runCase(c);
    if (blocked) { falseBlocks++; gateViolations.push(`③ legal order '${c.id}' was wrongly blocked`); }
  }

  const recallVal = VIOLATIONS.length === 0 ? 1 : blockedViolations / VIOLATIONS.length;
  return {
    category: "③ risk",
    metrics: { recall: recallVal, violations: VIOLATIONS.length, blocked: blockedViolations, legal: LEGAL.length, falseBlocks },
    gateViolations,
    lines: [
      `③ risk:     blocked ${blockedViolations}/${VIOLATIONS.length} violations (recall ${pct(recallVal)}) · ` +
        `${falseBlocks}/${LEGAL.length} false blocks   [15 rule categories]`,
    ],
  };
}
