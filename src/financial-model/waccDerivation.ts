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
import { cellKey, type CellKey } from "./dsl/graph.ts";
import { effectiveTaxRates } from "./wacc.ts";
import type { Cell, Fact, LineItem, Period } from "./types.ts";

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
  /**
   * The risk-free anchor. 10Y, not 30Y, because the rate and the equity risk premium added to it
   * must be measured on the SAME instrument: the published implied-ERP estimates an analyst reaches
   * for (Damodaran's among them) are computed over the 10Y, so pairing them with the 30Y counts the
   * term premium twice — once inside the rate, once inside a premium calibrated without it.
   * A longer tenor is still defensible for a terminal-value-heavy issuer; it is then an override
   * with its own rationale, and the ERP owes the same adjustment.
   */
  treasuryRiskFree?: (asOfDate: string) => Promise<{ value: number; curveDate: string } | undefined>;
};

/** The WACC sheet's hidden `cash_and_equivalents_value` row is not one of the seven `WaccParameterName`
 * terms — it exists only so the sheet's locked `net_debt` formula has a value to subtract — so it is
 * kept out of `derived`/`WACC_PARAMETER_NAMES` entirely and reported through this narrower field. */
export type CashDerivation = {
  value: number;
  sourceType: WaccParameterSource;
  sourceRefs: string[];
  rationale: string;
  derivation: Record<string, unknown>;
};

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
  /** The recalculated workbook is authoritative. It incorporates an agent-authored formula (for
   * example, debt = borrowings + finance leases) instead of bypassing it for raw mapped facts. */
  cells?: ReadonlyMap<CellKey, Cell>;
  deps: DerivationDeps;
  beta?: BetaOptions;
}): Promise<DerivedParameters> {
  const derived: WaccParameterInput[] = [];
  let cashAndEquivalents: CashDerivation | undefined;
  const unreachable: DerivedParameters["unreachable"] = [];
  const actuals = actualPeriodIds(input.periods);
  const latest = actuals.at(-1);
  const base = { sourceRefs: [] as string[], asOfDate: input.asOfDate };

  const sourceTypeOf = (lineItemId: string): WaccParameterSource => {
    const item = input.lineItems.find((candidate) => candidate.id === lineItemId);
    if (input.cells === undefined || item?.historical === "actual") return "filing";
    return item?.historical === "assumption" ? "agent_estimate" : "computed";
  };
  const sourceRefOf = (lineItemId: string, periodId: string): string => {
    if (input.cells !== undefined) return `model:${cellKey(lineItemId, periodId)}`;
    return committed(input.facts, lineItemId, periodId)?.factId ?? `model:${cellKey(lineItemId, periodId)}`;
  };
  const valueAt = (lineItemId: string, periodId: string): number | undefined => {
    if (input.cells !== undefined) {
      const value = input.cells.get(cellKey(lineItemId, periodId))?.value;
      return value !== null && value !== undefined && Number.isFinite(value) ? value : undefined;
    }
    return committed(input.facts, lineItemId, periodId)?.value;
  };
  const seriesOf = (lineItemId: string): Record<string, number | null> =>
    Object.fromEntries(actuals.map((periodId) => [periodId, valueAt(lineItemId, periodId) ?? null]));

  // --- Effective tax rate: averaged, so one year's one-off charge cannot set every forecast period.
  try {
    const history = effectiveTaxRates({ periods: actuals,
      incomeTaxExpense: seriesOf("income_tax_expense"), pretaxIncome: seriesOf("pretax_income") });
    derived.push({ ...base, name: "taxRate", value: history.average, sourceType: "computed",
      sourceRefs: history.perPeriod.flatMap((entry) => [
        sourceRefOf("income_tax_expense", entry.periodId),
        sourceRefOf("pretax_income", entry.periodId),
      ]),
      derivation: { method: "mean of income_tax_expense / pretax_income", perPeriod: history.perPeriod },
      rationale: `Average effective rate over ${history.perPeriod.length} period(s).` });
  } catch (error) {
    unreachable.push({ name: "taxRate", reason: error instanceof Error ? error.message : String(error) });
  }

  // --- Total debt, at book. NOT net of cash: the weights describe how the firm is financed, and the
  // cash adjustment belongs in the enterprise-to-equity bridge instead.
  const debt = latest === undefined ? undefined : valueAt("debt", latest);
  if (debt !== undefined && latest !== undefined) {
    derived.push({ ...base, name: "totalDebt", value: debt, sourceType: sourceTypeOf("debt"),
      sourceRefs: [sourceRefOf("debt", latest)], derivation: { periodId: latest, basis: "book value, gross of cash" },
      rationale: `Total debt at ${latest}.` });
  } else {
    unreachable.push({ name: "totalDebt", reason: "no final workbook value for `debt`; map it or author its historical formula" });
  }

  // --- Cash and equivalents, at the latest committed period — feeds the sheet's locked `net_debt`
  // formula (total_debt - cash_and_equivalents_value); it is not one of the seven CAPM/WACC terms.
  const cash = latest === undefined ? undefined : valueAt("cash_and_equivalents", latest);
  if (cash !== undefined && latest !== undefined) {
    cashAndEquivalents = { value: cash, sourceType: sourceTypeOf("cash_and_equivalents"),
      sourceRefs: [sourceRefOf("cash_and_equivalents", latest)],
      derivation: { periodId: latest }, rationale: `Cash and equivalents at ${latest}.` };
  } else {
    unreachable.push({ name: "cash_and_equivalents_value",
      reason: "no final workbook value for `cash_and_equivalents`; map it or author its historical formula" });
  }

  // --- Market value of equity: diluted shares times the last close.
  const shares = latest === undefined ? undefined : valueAt("diluted_shares", latest);
  if (shares === undefined) {
    unreachable.push({ name: "equityValue", reason: "no final workbook value for `diluted_shares`; map it or author its historical formula" });
  } else {
    const close = await lastClose(input.deps, input.symbol, input.asOfDate);
    if (close === undefined) {
      unreachable.push({ name: "equityValue", reason: `no cached price for ${input.symbol}` });
    } else {
      derived.push({ ...base, name: "equityValue", value: shares * close.c, sourceType: "market",
        sourceRefs: [sourceRefOf("diluted_shares", latest!), `bars:${input.symbol}/1Day/${close.t}`],
        derivation: { dilutedShares: shares, close: close.c, closeDate: close.t, periodId: latest },
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
  const interest = latest === undefined ? undefined : valueAt("interest_expense", latest);
  const priorDebt = priorPeriod === undefined ? undefined : valueAt("debt", priorPeriod);
  if (interest !== undefined && debt !== undefined && priorDebt !== undefined && latest !== undefined && debt + priorDebt > 0) {
    const averageDebt = (debt + priorDebt) / 2;
    derived.push({ ...base, name: "costOfDebt", value: Math.abs(interest) / averageDebt,
      sourceType: sourceTypeOf("interest_expense") === "filing" && sourceTypeOf("debt") === "filing" ? "filing" : "computed",
      sourceRefs: [sourceRefOf("interest_expense", latest), sourceRefOf("debt", latest), sourceRefOf("debt", priorPeriod!)],
      derivation: { method: "interest expense / average total debt", averageDebt, periodId: latest },
      rationale: "Backward-looking; override with a current bond yield when one is available." });
  } else {
    unreachable.push({ name: "costOfDebt",
      reason: "needs final workbook values for `interest_expense` and `debt` in the two latest periods; otherwise search the issuer's bond yield and pass it as an override" });
  }

  // --- Risk-free rate: the 30-year Treasury constant-maturity yield, straight off treasury.gov's own
  // daily yield curve feed, when one is wired and resolves. Otherwise the agent supplies it.
  const treasury = input.deps.treasuryRiskFree ? await input.deps.treasuryRiskFree(input.asOfDate) : undefined;
  if (treasury) {
    derived.push({ ...base, name: "riskFreeRate", value: treasury.value, sourceType: "market",
      sourceRefs: [`treasury.gov:10y:${treasury.curveDate}`],
      derivation: { term: "10Y", curveDate: treasury.curveDate, feed: "treasury.gov" },
      rationale: `30-year constant-maturity Treasury yield as of ${treasury.curveDate} (treasury.gov daily yield curve).` });
  } else {
    unreachable.push({ name: "riskFreeRate", reason: "treasury.gov 10Y yield unavailable; supply it as an override" });
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
