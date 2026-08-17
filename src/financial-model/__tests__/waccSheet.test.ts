import { test } from "node:test";
import assert from "node:assert/strict";
import { FinancialModelError } from "../errors.ts";
import {
  applyComputedWaccInputs,
  createWaccSheet,
  missingWaccAgentJudgments,
  recalculateWaccSheet,
  setWaccInput,
  WACC_SHEET_ROW_IDS,
  type WaccSheet,
  type WaccSheetComputedInput,
} from "../waccSheet.ts";

const AS_OF = "2026-08-08";

function row(sheet: WaccSheet, rowId: string) {
  const found = sheet.rows.find((candidate) => candidate.rowId === rowId);
  assert.ok(found, `missing row ${rowId}`);
  return found;
}

function provenance(overrides: Partial<{ sourceType: string; sourceRefs: string[]; rationale: string }> = {}) {
  return {
    sourceType: overrides.sourceType ?? "computed",
    sourceRefs: overrides.sourceRefs ?? [],
    asOfDate: AS_OF,
    rationale: overrides.rationale ?? "test",
  };
}

test("createWaccSheet builds the 12-row skeleton plus the hidden cash row", () => {
  const sheet = createWaccSheet(AS_OF);
  assert.equal(sheet.asOfDate, AS_OF);
  assert.equal(sheet.rows.length, 13);
  for (const rowId of WACC_SHEET_ROW_IDS) {
    assert.ok(sheet.rows.some((candidate) => candidate.rowId === rowId), `missing public row ${rowId}`);
  }
  assert.ok(sheet.rows.some((candidate) => candidate.rowId === "cash_and_equivalents_value"));

  const cash = row(sheet, "cash_and_equivalents_value");
  assert.deepEqual(cash.unit, { kind: "currency", code: "USD" });
  assert.equal(cash.source, "computed");

  const beta = row(sheet, "beta");
  assert.equal(beta.source, "computed");
  assert.equal(beta.value, null);

  const rf = row(sheet, "risk_free_rate");
  assert.equal(rf.source, "empty");
  assert.equal(rf.value, null);

  const erp = row(sheet, "equity_risk_premium");
  assert.equal(erp.source, "empty");
});

test("locked formula rows are pre-populated and cannot be edited", () => {
  const sheet = createWaccSheet(AS_OF);
  const costOfEquity = row(sheet, "cost_of_equity");
  assert.equal(costOfEquity.source, "locked_formula");
  assert.equal(costOfEquity.formulaSource, "risk_free_rate + beta * equity_risk_premium");

  const netDebt = row(sheet, "net_debt");
  assert.equal(netDebt.formulaSource, "total_debt - cash_and_equivalents_value");

  const eOverV = row(sheet, "e_over_v");
  assert.equal(eOverV.formulaSource, "equity_value / (equity_value + total_debt)");

  const dOverV = row(sheet, "d_over_v");
  assert.equal(dOverV.formulaSource, "total_debt / (equity_value + total_debt)");

  const wacc = row(sheet, "wacc");
  assert.equal(wacc.source, "locked_formula");
  assert.equal(
    wacc.formulaSource,
    "e_over_v * cost_of_equity + d_over_v * cost_of_debt * (1 - effective_tax_rate)",
  );

  for (const rowId of ["cost_of_equity", "net_debt", "e_over_v", "d_over_v", "wacc"]) {
    assert.throws(
      () =>
        setWaccInput(sheet, {
          rowId: rowId as never,
          value: 1,
          sourceType: "user",
          sourceRefs: [],
          rationale: "nope",
          asOfDate: AS_OF,
        }),
      (error: unknown) => error instanceof FinancialModelError && error.code === "invalid_model_operation",
    );
  }
});

test("recalculateWaccSheet names missing direct inputs without expanding the chain", () => {
  const sheet = recalculateWaccSheet(createWaccSheet(AS_OF));
  const costOfEquity = row(sheet, "cost_of_equity");
  assert.equal(costOfEquity.value, null);
  assert.deepEqual(
    [...costOfEquity.missingInputs].sort(),
    ["beta", "equity_risk_premium", "risk_free_rate"],
  );

  const wacc = row(sheet, "wacc");
  assert.equal(wacc.value, null);
  // wacc references cost_of_equity/e_over_v/d_over_v/cost_of_debt/effective_tax_rate directly;
  // it must NOT reach past cost_of_equity into risk_free_rate/beta/equity_risk_premium.
  assert.ok(!wacc.missingInputs.includes("risk_free_rate"));
  assert.ok(!wacc.missingInputs.includes("beta"));
});

test("only the irreducible WACC judgments require agent confirmation", () => {
  let sheet = createWaccSheet(AS_OF);
  sheet = applyComputedWaccInputs(sheet, [
    { rowId: "risk_free_rate", value: 0.04, provenance: provenance({ rationale: "Treasury candidate" }) },
    { rowId: "beta", value: 1.1, provenance: provenance() },
    { rowId: "equity_value", value: 100, provenance: provenance() },
    { rowId: "total_debt", value: 20, provenance: provenance() },
    { rowId: "cost_of_debt", value: 0.05, provenance: provenance() },
    { rowId: "effective_tax_rate", value: 0.21, provenance: provenance() },
  ]);
  assert.deepEqual(missingWaccAgentJudgments(sheet), ["risk_free_rate", "equity_risk_premium"]);
  sheet = setWaccInput(sheet, {
    rowId: "risk_free_rate", value: 0.04, sourceType: "market", sourceRefs: ["treasury:30y"],
    rationale: "Selected 30-year rate for the forecast duration.", asOfDate: AS_OF,
  });
  sheet = setWaccInput(sheet, {
    rowId: "equity_risk_premium", value: 0.05, sourceType: "agent_estimate", sourceRefs: [],
    rationale: "Long-run ERP judgment.", asOfDate: AS_OF,
  });
  assert.deepEqual(missingWaccAgentJudgments(sheet), []);
});

test("applyComputedWaccInputs fills engine-measured rows but never overwrites an agent-authored row", () => {
  let sheet = createWaccSheet(AS_OF);
  sheet = setWaccInput(sheet, {
    rowId: "cost_of_debt",
    value: 0.09,
    sourceType: "search",
    sourceRefs: ["bond-yield"],
    rationale: "current issuer bond yield",
    asOfDate: AS_OF,
  });
  sheet = setWaccInput(sheet, {
    rowId: "risk_free_rate",
    value: 0.044,
    sourceType: "market",
    sourceRefs: ["treasury:30y-manual"],
    rationale: "agent-supplied 30y yield, ahead of any feed refresh",
    asOfDate: AS_OF,
  });

  const inputs: WaccSheetComputedInput[] = [
    { rowId: "beta", value: 1.2, provenance: provenance() },
    { rowId: "cost_of_debt", value: 0.03, provenance: provenance() },
    { rowId: "equity_value", value: 3e12, provenance: provenance() },
    { rowId: "total_debt", value: 1e11, provenance: provenance() },
    { rowId: "effective_tax_rate", value: 0.15, provenance: provenance() },
    { rowId: "cash_and_equivalents_value", value: 3e10, provenance: provenance() },
    { rowId: "risk_free_rate", value: 0.0486, provenance: provenance() },
  ];
  sheet = applyComputedWaccInputs(sheet, inputs);

  assert.equal(row(sheet, "beta").value, 1.2);
  assert.equal(row(sheet, "beta").source, "computed");
  assert.equal(row(sheet, "equity_value").value, 3e12);
  assert.equal(row(sheet, "total_debt").value, 1e11);
  assert.equal(row(sheet, "effective_tax_rate").value, 0.15);
  assert.equal(row(sheet, "cash_and_equivalents_value").value, 3e10);

  // cost_of_debt was set by the agent above; the computed refresh must not clobber it.
  assert.equal(row(sheet, "cost_of_debt").value, 0.09);
  assert.equal(row(sheet, "cost_of_debt").source, "agent");

  // risk_free_rate was likewise set by the agent above; the Treasury-feed refresh must not clobber it.
  assert.equal(row(sheet, "risk_free_rate").value, 0.044);
  assert.equal(row(sheet, "risk_free_rate").source, "agent");
});

test("setWaccInput accepts agent overrides for measured inputs and rejects locked rows", () => {
  const sheet = createWaccSheet(AS_OF);
  const overridden = setWaccInput(sheet, {
    rowId: "total_debt",
    formula: "100 + 25",
    sourceType: "filing_calculation",
    sourceRefs: ["model:debt@FY2025"],
    rationale: "Use the agent-authored total-debt calculation in the final workbook.",
    asOfDate: AS_OF,
  });
  assert.equal(row(overridden, "total_debt").source, "agent");
  assert.equal(row(overridden, "total_debt").formulaSource, "100 + 25");
  assert.throws(
    () =>
      setWaccInput(sheet, {
        rowId: "wacc",
        value: 1,
        sourceType: "user",
        sourceRefs: [],
        rationale: "nope",
        asOfDate: AS_OF,
      }),
    (error: unknown) => error instanceof FinancialModelError && error.code === "invalid_model_operation",
  );
});

test("a formula referencing an unknown row or a function call is rejected", () => {
  let sheet = createWaccSheet(AS_OF);
  sheet = setWaccInput(sheet, {
    rowId: "risk_free_rate",
    formula: "not_a_row + 1",
    sourceType: "user",
    sourceRefs: [],
    rationale: "bad ref",
    asOfDate: AS_OF,
  });
  assert.throws(
    () => recalculateWaccSheet(sheet),
    (error: unknown) => error instanceof FinancialModelError && error.code === "invalid_formula",
  );

  let sheet2 = createWaccSheet(AS_OF);
  sheet2 = setWaccInput(sheet2, {
    rowId: "risk_free_rate",
    formula: "SUM(beta, 1, 1)",
    sourceType: "user",
    sourceRefs: [],
    rationale: "no functions on scalars",
    asOfDate: AS_OF,
  });
  assert.throws(
    () => recalculateWaccSheet(sheet2),
    (error: unknown) => error instanceof FinancialModelError && error.code === "invalid_formula",
  );
});

test("chained fill computes wacc end to end", () => {
  let sheet = createWaccSheet(AS_OF);

  const inputs: WaccSheetComputedInput[] = [
    { rowId: "beta", value: 1.2, provenance: provenance() },
    { rowId: "cost_of_debt", value: 0.03, provenance: provenance() },
    { rowId: "equity_value", value: 3e12, provenance: provenance() },
    { rowId: "total_debt", value: 1e11, provenance: provenance() },
    { rowId: "effective_tax_rate", value: 0.15, provenance: provenance() },
    { rowId: "cash_and_equivalents_value", value: 3e10, provenance: provenance() },
  ];
  sheet = applyComputedWaccInputs(sheet, inputs);

  sheet = setWaccInput(sheet, {
    rowId: "risk_free_rate",
    value: 0.04,
    sourceType: "market",
    sourceRefs: ["ust-30y"],
    rationale: "30y treasury",
    asOfDate: AS_OF,
  });
  sheet = setWaccInput(sheet, {
    rowId: "equity_risk_premium",
    value: 0.05,
    sourceType: "agent_estimate",
    sourceRefs: [],
    rationale: "Damodaran ERP",
    asOfDate: AS_OF,
  });

  sheet = recalculateWaccSheet(sheet);

  const equity = 3e12;
  const debt = 1e11;
  const v = equity + debt;
  const eOverV = equity / v;
  const dOverV = debt / v;
  const costOfEquity = 0.04 + 1.2 * 0.05;
  const expectedWacc = eOverV * costOfEquity + dOverV * 0.03 * (1 - 0.15);

  const wacc = row(sheet, "wacc");
  assert.ok(wacc.value !== null);
  assert.ok(Math.abs((wacc.value as number) - expectedWacc) < 1e-9, `${wacc.value} !== ${expectedWacc}`);
  assert.deepEqual(wacc.missingInputs, []);

  const netDebt = row(sheet, "net_debt");
  assert.equal(netDebt.value, debt - 3e10);
});
