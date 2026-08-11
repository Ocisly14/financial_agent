/**
 * What the engine can work out on its own, so the DCF Agent is only ever asked for what genuinely has
 * no measurable source.
 *
 * Every term here is derived from data the model already holds — committed facts on the canonical
 * spine, and the cached price bars — and each one records how it was derived. A term the engine
 * cannot reach is not filled with a plausible default: it is reported missing, with the reason, so
 * the agent supplies it deliberately rather than inheriting a number nobody chose.
 */
import { computeBeta, type PriceBar } from "../infra/market/beta.ts";
import { effectiveTaxRates } from "./wacc.ts";
import type { Fact, LineItem, Period } from "./types.ts";

/** The seven CAPM/capital-structure terms this module can derive. */
export type WaccParameterName =
  "beta" | "riskFreeRate" | "equityRiskPremium" | "costOfDebt" | "taxRate" | "equityValue" | "totalDebt";

export type WaccParameterSource =
  /** Derived by the engine from data it holds — beta from bars, the tax rate from the income statement. */
  | "computed"
  /** Read off the issuer's filings. */
  | "filing"
  /** A market observation: a Treasury yield, a closing price. */
  | "market"
  /** Found by the agent through search, e.g. an issuer's bond yield or rating. */
  | "search"
  /** The agent's own judgment. The equity risk premium has no measurable source and lands here. */
  | "agent_estimate";

export type WaccParameterInput = {
  name: WaccParameterName;
  value: number;
  sourceType: WaccParameterSource;
  sourceRefs: string[];
  /**
   * How the value was arrived at, in whatever shape the producer needs: beta records its window,
   * frequency, market proxy, feed, and observation counts; the tax rate records its per-period rates.
   * Free-form on purpose — the alternative is a column per producer.
   */
  derivation: Record<string, unknown>;
  asOfDate: string;
  rationale: string;
};

/** SPY tracks the S&P 500 and is what the bar cache already holds; named so the choice is visible. */
export const MARKET_PROXY = "SPY";
export const DEFAULT_BETA_YEARS = 10;

export type BetaOptions = {
  /** History window. The agent may widen it; five years is the conventional default. */
  years?: number;
  marketProxy?: string;
};

export type DerivationDeps = {
  /** Daily closes for a ticker over an inclusive date range, from the local cache. */
  dailyCloses: (symbol: string, from: string, to: string) => Promise<PriceBar[]>;
  /** The official 30-year Treasury yield as of a date, when a feed is wired; absent or a failed
   * resolution both leave riskFreeRate unreachable rather than fabricating a value. */
  treasury30y?: (asOfDate: string) => Promise<{ value: number; curveDate: string } | undefined>;
};

/** The WACC sheet's hidden `cash_and_equivalents_value` row is not one of the seven `WaccParameterName`
 * terms — it exists only so the sheet's locked `net_debt` formula has a value to subtract — so it is
 * kept out of `derived`/`WACC_PARAMETER_NAMES` entirely and reported through this narrower field. */
export type CashDerivation = { value: number; sourceRefs: string[]; rationale: string; derivation: Record<string, unknown> };

export type DerivedParameters = {
  derived: WaccParameterInput[];
  /** Cash and equivalents at the latest committed period, when the spine has it. */
  cashAndEquivalents?: CashDerivation;
  /** Terms the engine could not reach, each with the reason — never silently absent. */
  unreachable: Array<{ name: WaccParameterName | "cash_and_equivalents_value"; reason: string }>;
};

/** Committed value of one spine line item in one period, or null. Staged facts are not evidence yet. */
function committed(facts: readonly Fact[], lineItemId: string, periodId: string): Fact | undefined {
  return facts.find((fact) => fact.status === "committed"
    && fact.lineItemId === lineItemId && fact.periodId === periodId);
}

function actualPeriodIds(periods: readonly Period[]): string[] {
  return periods.filter((period) => period.cls === "actual").map((period) => period.id);
}

export async function deriveWaccParameters(input: {
  symbol: string;
  asOfDate: string;
  facts: readonly Fact[];
  lineItems: readonly LineItem[];
  periods: readonly Period[];
  deps: DerivationDeps;
  beta?: BetaOptions;
}): Promise<DerivedParameters> {
  const derived: WaccParameterInput[] = [];
  let cashAndEquivalents: CashDerivation | undefined;
  const unreachable: DerivedParameters["unreachable"] = [];
  const actuals = actualPeriodIds(input.periods);
  const latest = actuals.at(-1);
  const base = { sourceRefs: [] as string[], asOfDate: input.asOfDate };

  const seriesOf = (lineItemId: string): Record<string, number | null> =>
    Object.fromEntries(actuals.map((periodId) => [periodId, committed(input.facts, lineItemId, periodId)?.value ?? null]));

  // --- Effective tax rate: averaged, so one year's one-off charge cannot set every forecast period.
  try {
    const history = effectiveTaxRates({ periods: actuals,
      incomeTaxExpense: seriesOf("income_tax_expense"), pretaxIncome: seriesOf("pretax_income") });
    derived.push({ ...base, name: "taxRate", value: history.average, sourceType: "computed",
      sourceRefs: history.perPeriod.map((entry) => `spine.income_tax_expense.${entry.periodId}`),
      derivation: { method: "mean of income_tax_expense / pretax_income", perPeriod: history.perPeriod },
      rationale: `Average effective rate over ${history.perPeriod.length} period(s).` });
  } catch (error) {
    unreachable.push({ name: "taxRate", reason: error instanceof Error ? error.message : String(error) });
  }

  // --- Total debt, at book. NOT net of cash: the weights describe how the firm is financed, and the
  // cash adjustment belongs in the enterprise-to-equity bridge instead.
  const debt = latest === undefined ? undefined : committed(input.facts, "debt", latest);
  if (debt) {
    derived.push({ ...base, name: "totalDebt", value: debt.value, sourceType: "filing",
      sourceRefs: [debt.factId], derivation: { periodId: latest, basis: "book value, gross of cash" },
      rationale: `Total debt at ${latest}.` });
  } else {
    unreachable.push({ name: "totalDebt", reason: "no committed value for spine target `debt`; map it in spine_mapping" });
  }

  // --- Cash and equivalents, at the latest committed period — feeds the sheet's locked `net_debt`
  // formula (total_debt - cash_and_equivalents_value); it is not one of the seven CAPM/WACC terms.
  const cash = latest === undefined ? undefined : committed(input.facts, "cash_and_equivalents", latest);
  if (cash) {
    cashAndEquivalents = { value: cash.value, sourceRefs: [cash.factId],
      derivation: { periodId: latest }, rationale: `Cash and equivalents at ${latest}.` };
  } else {
    unreachable.push({ name: "cash_and_equivalents_value",
      reason: "no committed value for spine target `cash_and_equivalents`; map it in spine_mapping" });
  }

  // --- Market value of equity: diluted shares times the last close.
  const shares = latest === undefined ? undefined : committed(input.facts, "diluted_shares", latest);
  if (!shares) {
    unreachable.push({ name: "equityValue", reason: "no committed value for spine target `diluted_shares`; map it in spine_mapping" });
  } else {
    const close = await lastClose(input.deps, input.symbol, input.asOfDate);
    if (close === undefined) {
      unreachable.push({ name: "equityValue", reason: `no cached price for ${input.symbol}` });
    } else {
      derived.push({ ...base, name: "equityValue", value: shares.value * close.c, sourceType: "market",
        sourceRefs: [shares.factId, `bars:${input.symbol}/1Day/${close.t}`],
        derivation: { dilutedShares: shares.value, close: close.c, closeDate: close.t, periodId: latest },
        rationale: `${input.symbol} close on ${close.t} times diluted shares at ${latest}.` });
    }
  }

  // --- Levered beta from log returns against the market proxy.
  const years = input.beta?.years ?? DEFAULT_BETA_YEARS;
  const proxy = input.beta?.marketProxy ?? MARKET_PROXY;
  const from = yearsBefore(input.asOfDate, years);
  try {
    const [asset, market] = await Promise.all([
      input.deps.dailyCloses(input.symbol, from, input.asOfDate),
      input.deps.dailyCloses(proxy, from, input.asOfDate),
    ]);
    const result = computeBeta({ asset, market });
    derived.push({ ...base, name: "beta", value: result.average, sourceType: "computed",
      sourceRefs: [`bars:${input.symbol}/1Day`, `bars:${proxy}/1Day`],
      derivation: { years, marketProxy: proxy, returns: "natural log", daily: result.daily, weekly: result.weekly,
        dailyObservations: result.dailyObservations, weeklyObservations: result.weeklyObservations,
        from: result.from, to: result.to },
      rationale: `Mean of daily and weekly beta over ${years} year(s) against ${proxy}.` });
  } catch (error) {
    unreachable.push({ name: "beta", reason: error instanceof Error ? error.message : String(error) });
  }

  // --- Cost of debt from the filings: interest expense over average debt across the year. This is a
  // backward-looking average of debt the issuer already carries, so it lags a repricing; the agent
  // overrides it with a current bond yield when it has one.
  const priorPeriod = actuals.at(-2);
  const interest = latest === undefined ? undefined : committed(input.facts, "interest_expense", latest);
  const priorDebt = priorPeriod === undefined ? undefined : committed(input.facts, "debt", priorPeriod);
  if (interest && debt && priorDebt && debt.value + priorDebt.value > 0) {
    const averageDebt = (debt.value + priorDebt.value) / 2;
    derived.push({ ...base, name: "costOfDebt", value: Math.abs(interest.value) / averageDebt, sourceType: "filing",
      sourceRefs: [interest.factId, debt.factId, priorDebt.factId],
      derivation: { method: "interest expense / average total debt", averageDebt, periodId: latest },
      rationale: "Backward-looking; override with a current bond yield when one is available." });
  } else {
    unreachable.push({ name: "costOfDebt",
      reason: "needs committed `interest_expense` and `debt` in the two latest periods; otherwise search the issuer's bond yield and pass it as an override" });
  }

  // --- Risk-free rate: the 30-year Treasury constant-maturity yield, straight off treasury.gov's own
  // daily yield curve feed, when one is wired and resolves. Otherwise the agent supplies it.
  const treasury = input.deps.treasury30y ? await input.deps.treasury30y(input.asOfDate) : undefined;
  if (treasury) {
    derived.push({ ...base, name: "riskFreeRate", value: treasury.value, sourceType: "market",
      sourceRefs: [`treasury.gov:30y:${treasury.curveDate}`],
      derivation: { term: "30Y", curveDate: treasury.curveDate, feed: "treasury.gov" },
      rationale: `30-year constant-maturity Treasury yield as of ${treasury.curveDate} (treasury.gov daily yield curve).` });
  } else {
    unreachable.push({ name: "riskFreeRate", reason: "treasury.gov 30Y yield unavailable; supply it as an override" });
  }

  // --- The one term the engine has no source for at all.
  unreachable.push({ name: "equityRiskPremium", reason: "no measurable source by nature; state it as an override" });

  return { derived, unreachable, ...(cashAndEquivalents ? { cashAndEquivalents } : {}) };
}

async function lastClose(deps: DerivationDeps, symbol: string, asOfDate: string): Promise<PriceBar | undefined> {
  // A fortnight back covers holidays and long weekends without reaching into a stale quarter.
  const bars = await deps.dailyCloses(symbol, yearsBefore(asOfDate, 0.04), asOfDate);
  return bars.at(-1);
}

function yearsBefore(isoDate: string, years: number): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - Math.round(years * 365.25));
  return date.toISOString().slice(0, 10);
}
