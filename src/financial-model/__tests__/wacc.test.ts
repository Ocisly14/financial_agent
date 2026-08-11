import assert from "node:assert/strict";
import test from "node:test";
import { computeWacc, effectiveTaxRates } from "../wacc.ts";

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} !== ${expected}`);

test("WACC weights equity and after-tax debt by market capital structure", () => {
  const result = computeWacc({
    beta: 1.2, riskFreeRate: 0.045, equityRiskPremium: 0.05,
    costOfDebt: 0.04, taxRate: 0.2,
    equityValue: 800, totalDebt: 200,
  });
  close(result.costOfEquity, 0.045 + 1.2 * 0.05); // 10.5%
  close(result.afterTaxCostOfDebt, 0.04 * 0.8); // 3.2%
  close(result.equityWeight, 0.8);
  close(result.debtWeight, 0.2);
  close(result.wacc, 0.8 * 0.105 + 0.2 * 0.032); // 9.04%
});

test("the debt weight uses total debt, so holding cash does not change it", () => {
  const base = { beta: 1, riskFreeRate: 0.04, equityRiskPremium: 0.05, costOfDebt: 0.05,
    taxRate: 0.21, equityValue: 900, totalDebt: 100 };
  // Netting 60 of cash out of debt would lift the equity weight from 90% to ~95.7% and move WACC.
  const asTotal = computeWacc(base);
  const asNet = computeWacc({ ...base, totalDebt: 40 });
  close(asTotal.debtWeight, 0.1);
  close(asNet.debtWeight, 40 / 940);
  assert.ok(asTotal.wacc !== asNet.wacc);
});

test("a capital structure that sums to zero is refused", () => {
  assert.throws(() => computeWacc({ beta: 1, riskFreeRate: 0.04, equityRiskPremium: 0.05,
    costOfDebt: 0.05, taxRate: 0.2, equityValue: 0, totalDebt: 0 }), /must be positive/);
});

test("the effective tax rate averages the periods, so a one-off year cannot set the forecast", () => {
  // Apple's real shape: FY2024 carries the EU State Aid charge.
  const periods = ["FY2021", "FY2022", "FY2023", "FY2024", "FY2025"];
  const history = effectiveTaxRates({
    periods,
    incomeTaxExpense: { FY2021: 14_527, FY2022: 19_300, FY2023: 16_741, FY2024: 29_749, FY2025: 20_664 },
    pretaxIncome: { FY2021: 109_207, FY2022: 119_103, FY2023: 113_736, FY2024: 123_485, FY2025: 132_700 },
  });
  assert.equal(history.perPeriod.length, 5);
  close(history.perPeriod[3]!.rate, 29_749 / 123_485, 1e-6); // 24.1%, the outlier
  // The average sits with the other four years rather than being dragged to the outlier.
  assert.ok(history.average > 0.15 && history.average < 0.18, `${history.average}`);
});

test("a period missing either figure is skipped, and no usable period at all is an error", () => {
  const history = effectiveTaxRates({
    periods: ["FY2024", "FY2025"],
    incomeTaxExpense: { FY2024: null, FY2025: 20 },
    pretaxIncome: { FY2024: 100, FY2025: 100 },
  });
  assert.deepEqual(history.perPeriod.map((p) => p.periodId), ["FY2025"]);

  assert.throws(() => effectiveTaxRates({ periods: ["FY2025"],
    incomeTaxExpense: { FY2025: 20 }, pretaxIncome: { FY2025: 0 } }), /no period has both/);
});
