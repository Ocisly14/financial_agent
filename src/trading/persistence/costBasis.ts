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
