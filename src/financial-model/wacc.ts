/**
 * WACC from measured inputs. Nothing here is estimated: every term is either computed from market
 * data and the filings, or supplied as a named assumption the caller had to state.
 *
 *   Re   = rf + beta * ERP                          (CAPM)
 *   WACC = E/(D+E) * Re + D/(D+E) * Rd * (1 - t)
 *
 * D is TOTAL debt, not net debt. The weights describe how the firm is financed; netting cash out of
 * them would apply the cash adjustment twice, once here and again in the enterprise-to-equity bridge
 * where it belongs.
 */

export type WaccInputs = {
  /** Levered beta, normally the daily/weekly average from `computeBeta`. */
  beta: number;
  /** Risk-free rate as a decimal, e.g. 0.0465 for the 30-year Treasury at 4.65%. */
  riskFreeRate: number;
  /** Equity risk premium as a decimal. The one term with no measurable source — state it. */
  equityRiskPremium: number;
  /** Pre-tax cost of debt as a decimal, principal-weighted across the issuer's instruments. */
  costOfDebt: number;
  /** Effective tax rate as a decimal. */
  taxRate: number;
  /** Market value of equity: diluted shares times price. */
  equityValue: number;
  /** Total debt at book, the market-value proxy. NOT net of cash. */
  totalDebt: number;
};

export type WaccResult = WaccInputs & {
  /** Cost of equity from CAPM. */
  costOfEquity: number;
  /** After-tax cost of debt, the figure that actually enters the weighted average. */
  afterTaxCostOfDebt: number;
  equityWeight: number;
  debtWeight: number;
  wacc: number;
};

/** Effective tax rate per period, and the average the model uses unless the caller overrides it. */
export type TaxRateHistory = {
  perPeriod: Array<{ periodId: string; rate: number }>;
  /** Mean across the periods with both figures. A single year can be dominated by a one-off charge. */
  average: number;
};

/**
 * Effective tax rate = income tax expense / pretax income, per period.
 *
 * The average is the default rather than the latest year on purpose: Apple's FY2024 rate is 24.1%
 * against 13-16% either side of it, entirely because of the EU State Aid charge. Taking the latest
 * year would carry that one-off into every forecast period.
 */
export function effectiveTaxRates(input: {
  periods: readonly string[];
  incomeTaxExpense: Readonly<Record<string, number | null | undefined>>;
  pretaxIncome: Readonly<Record<string, number | null | undefined>>;
}): TaxRateHistory {
  const perPeriod: TaxRateHistory["perPeriod"] = [];
  for (const periodId of input.periods) {
    const tax = input.incomeTaxExpense[periodId];
    const pretax = input.pretaxIncome[periodId];
    if (typeof tax !== "number" || typeof pretax !== "number" || pretax === 0) continue;
    perPeriod.push({ periodId, rate: tax / pretax });
  }
  if (perPeriod.length === 0) throw new Error("no period has both income tax expense and pretax income");
  return { perPeriod, average: perPeriod.reduce((sum, entry) => sum + entry.rate, 0) / perPeriod.length };
}

export function computeWacc(inputs: WaccInputs): WaccResult {
  const capital = inputs.equityValue + inputs.totalDebt;
  if (capital <= 0) throw new Error("equity value plus total debt must be positive");
  const costOfEquity = inputs.riskFreeRate + inputs.beta * inputs.equityRiskPremium;
  const afterTaxCostOfDebt = inputs.costOfDebt * (1 - inputs.taxRate);
  const equityWeight = inputs.equityValue / capital;
  const debtWeight = inputs.totalDebt / capital;
  return {
    ...inputs,
    costOfEquity,
    afterTaxCostOfDebt,
    equityWeight,
    debtWeight,
    wacc: equityWeight * costOfEquity + debtWeight * afterTaxCostOfDebt,
  };
}
