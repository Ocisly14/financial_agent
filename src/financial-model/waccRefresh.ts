/**
 * Keeps a model's WACC parameters in step with its facts.
 *
 * Nothing has to ask for this. When committed facts change, the engine works out every term it can
 * reach and stores it, so the DCF Agent learns what it has and what is still missing as part of the
 * commit it just made — not by calling a tool to find out. What it does with that is its own
 * judgment: map a missing spine target, search a bond yield, or state the premium and finalize.
 */
import type { JsonObject } from "../framework/types.ts";
import type { FinancialModelSnapshot } from "./operations.ts";
import { deriveWaccParameters, type BetaOptions, type DerivationDeps } from "./waccDerivation.ts";
import { resolveWacc, WACC_PARAMETER_NAMES, type WaccParameterStore } from "./waccStore.ts";
import type { BarRepository } from "../data/stock/index.ts";

export type WaccStatus = {
  /** Terms the engine holds, with how each was arrived at. */
  parameters: Array<{ name: string; value: number; sourceType: string; derivation: Record<string, unknown> }>;
  /** Terms still needed, each saying what would supply it. */
  missing: Array<{ name: string; reason: string }>;
  /** Present once every term is in hand — a preview, not the model's committed WACC. */
  computed?: { wacc: number; costOfEquity: number; afterTaxCostOfDebt: number; equityWeight: number; debtWeight: number };
};

export type WaccRefreshDeps = {
  parameterStore: WaccParameterStore;
  barRepository?: () => Promise<BarRepository | undefined>;
  now?: () => Date;
};

/**
 * Recomputes the derivable terms and reports the whole picture.
 *
 * Never throws: this runs as a side effect of committing facts, and a WACC term the engine could not
 * work out must not cost the agent the commit it actually asked for.
 */
export async function refreshWaccParameters(deps: WaccRefreshDeps, input: {
  modelId: string;
  symbol: string;
  snapshot: FinancialModelSnapshot;
  beta?: BetaOptions;
}): Promise<WaccStatus | undefined> {
  try {
    const asOfDate = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
    const repository = await deps.barRepository?.();
    const derivationDeps: DerivationDeps = {
      dailyCloses: async (symbol, from, to) => repository === undefined ? []
        : (await repository.getBarsBetween(symbol, "1Day", from, to)).map((bar) => ({ t: bar.t, c: bar.c })),
    };
    const { derived, unreachable } = await deriveWaccParameters({ symbol: input.symbol, asOfDate,
      facts: input.snapshot.facts, lineItems: input.snapshot.lineItems, periods: input.snapshot.periods,
      deps: derivationDeps, ...(input.beta ? { beta: input.beta } : {}) });
    for (const parameter of derived) deps.parameterStore.put(input.modelId, parameter);

    const resolved = resolveWacc(deps.parameterStore, input.modelId);
    const reasons = new Map(unreachable.map((entry) => [entry.name, entry.reason]));
    return {
      parameters: resolved.parameters.map((parameter) => ({ name: parameter.name, value: parameter.value,
        sourceType: parameter.sourceType, derivation: parameter.derivation })),
      missing: resolved.complete ? [] : resolved.missing.map((name) =>
        ({ name, reason: reasons.get(name) ?? "not derived and not supplied" })),
      ...(resolved.complete ? { computed: { wacc: resolved.result.wacc, costOfEquity: resolved.result.costOfEquity,
        afterTaxCostOfDebt: resolved.result.afterTaxCostOfDebt, equityWeight: resolved.result.equityWeight,
        debtWeight: resolved.result.debtWeight } } : {}),
    };
  } catch { return undefined; }
}

/** One line the agent can act on without opening the payload. */
export function describeWaccStatus(status: WaccStatus | undefined): string {
  if (!status) return "";
  if (status.computed) {
    return ` WACC inputs are complete (${(status.computed.wacc * 100).toFixed(2)}% on current terms);`
      + " call compute_wacc with expectedRevision to make it official.";
  }
  const held = status.parameters.length;
  return ` WACC: ${held}/${WACC_PARAMETER_NAMES.length} term(s) derived, still missing `
    + `${status.missing.map((entry) => entry.name).join(", ")}.`;
}

export function waccStatusData(status: WaccStatus | undefined): JsonObject {
  return status === undefined ? {} : { wacc_status: status as unknown as JsonObject };
}
