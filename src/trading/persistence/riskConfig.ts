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
  max_order_notional_usd: 10_000,
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
