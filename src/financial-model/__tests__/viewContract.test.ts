import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot, ModelOperation } from "../operations.ts";
import { FinancialModelService, type CreateModelInput, type RevisionChangeSummary } from "../service.ts";
import { financialModelSnapshotCodec } from "../snapshotCodec.ts";
import { InMemoryModelStore } from "../store.ts";
import type { ModelContextView } from "../views.ts";
import type { Fact, Period, Unit, ValuationConfig } from "../types.ts";
import type { WaccSheetComputedInput } from "../waccSheet.ts";

/**
 * `client/src/types/financialModel.ts` hand-mirrors these view types, because
 * the client bundle must not import from `src/`. A rename on this side would
 * otherwise silently blank a column in the UI. This test is the tripwire:
 * every key the client reads is asserted present on a real model's JSON.
 * Adding fields stays free; renaming one fails here.
 */
const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" },
];

function createTestService(): FinancialModelService {
  const store = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  const service = new FinancialModelService(store, "contract-session");
  const input: CreateModelInput = {
    modelId: "contract-model",
    ownerTenantId: "agent-1",
    originSessionId: "topic-1",
    symbol: "TEST",
    metadata: { companyName: "Synthetic Company" },
    reportingCurrency: "USD",
    periods: PERIODS,
    preparedStatementRows: [{
      sourceLineItemId: "source.income_statement.revenue",
      statement: "income_statement",
      label: "Revenue",
      unit: { kind: "currency", code: "USD" },
      order: 1,
    }],
  };
  service.createModel(input);
  return service;
}

function buildContext(): ModelContextView {
  return createTestService().getModel("contract-model") as ModelContextView;
}

const USD: Unit = { kind: "currency", code: "USD" };
const SHARES: Unit = { kind: "shares" };
const PERCENT: Unit = { kind: "percent" };
const RATIO: Unit = { kind: "ratio" };

/**
 * `buildContext()` above deliberately stays a bare skeleton (no committed history), so it never
 * carries a populated `valuation`, non-trivial `assumptions[]`, or reconciliation results with real
 * numbers behind them — exactly the structures Criticals 1-3 (Assumption, TerminalMethodResult,
 * SensitivityMatrix) lived in undetected. This second fixture drives a model all the way to
 * `valued` through nothing but the public `FinancialModelService` API, the same sequence
 * `goldenDcf.test.ts` exercises (staged spine facts -> forecast assumptions -> WACC sheet ->
 * valuation config), trimmed to the minimum periods/facts that still clear every lifecycle gate:
 * one actual period and one forecast period.
 */
const VALUATION_PERIODS: Period[] = [
  { id: "FY2023", label: "FY2023", start: "2023-01-01", end: "2023-12-31", cls: "actual" },
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "forecast" },
];

function spineFact(lineItemId: string, periodId: string, value: number, unit: Unit = USD): Fact {
  return {
    factId: `${lineItemId}@${periodId}`,
    status: "staged",
    lineItemId,
    periodId,
    value,
    unit,
    provenance: { sourceType: "unified_statements", sourceRefs: [`unified.${lineItemId}`], asOfDate: "2024-02-01" },
  };
}

function notApplicableOp(lineItemId: string, periods: string[]): ModelOperation {
  return {
    kind: "set_formula",
    formula: { lineItemId, appliesTo: "historical", periodIds: periods, source: "0" },
  };
}

function assumptionOp(lineItemId: string, periods: string[], values: number[], unit: Unit): ModelOperation {
  return {
    kind: "set_assumption",
    assumption: {
      assumptionId: `a:${lineItemId}`, lineItemId, periods, payload: { kind: "values", values, unit },
      sourceType: "analyst_inference", sourceRefs: ["contract-test"], asOfDate: "2023-12-31",
      rationale: "contract fixture assumption",
    },
  };
}

function forecastFormulaOp(lineItemId: string, source: string): ModelOperation {
  return { kind: "set_formula", formula: { lineItemId, appliesTo: "forecast", periodIds: ["FY2024"], source } };
}

function historicalFormulaOp(lineItemId: string, source: string): ModelOperation {
  return { kind: "set_formula", formula: { lineItemId, appliesTo: "historical", periodIds: ["FY2023"], source } };
}

function buildValuedContext(): ModelContextView {
  const store = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  const service = new FinancialModelService(store, "contract-valuation-session");
  const modelId = "contract-valued-model";
  service.createModel({
    modelId, ownerTenantId: "agent-1", originSessionId: "topic-1", symbol: "TEST",
    metadata: { companyName: "Synthetic Valued Co" }, reportingCurrency: "USD",
    periods: VALUATION_PERIODS, preparedStatementRows: [],
  });

  const facts: Fact[] = [
    spineFact("revenue.total", "FY2023", 100),
    spineFact("cost_of_revenue", "FY2023", 66),
    spineFact("gross_profit", "FY2023", 34),
    spineFact("operating_income", "FY2023", 20),
    spineFact("depreciation_amortization", "FY2023", 5),
    spineFact("pretax_income", "FY2023", 20),
    spineFact("income_tax_expense", "FY2023", 5),
    spineFact("net_income", "FY2023", 15),
    spineFact("operating_expenses", "FY2023", 14),
    spineFact("capital_expenditures", "FY2023", 4),
    spineFact("accounts_receivable", "FY2023", 10),
    spineFact("inventory", "FY2023", 5),
    spineFact("accounts_payable", "FY2023", 8),
    spineFact("debt", "FY2023", 28),
    spineFact("cash_available_for_bridge", "FY2023", 8),
    spineFact("non_operating_investments", "FY2023", 2),
    spineFact("diluted_shares", "FY2023", 10, SHARES),
  ];
  let current = service.commitSpineFacts(modelId, 0, { facts, historicalPeriodIds: ["FY2023"] });
  assert.equal(current.currentWorkbook.mode, "dcf");
  assert.equal(current.status, "history_committed");

  current = service.applyOperations(modelId, current.revision, [
    notApplicableOp("lease_liabilities", ["FY2023"]),
    notApplicableOp("preferred_equity", ["FY2023"]),
    notApplicableOp("non_controlling_interests", ["FY2023"]),
    historicalFormulaOp("tax_rate", "income_tax_expense / pretax_income"),
    historicalFormulaOp("ebitda", "operating_income + depreciation_amortization"),
    historicalFormulaOp("nopat", "operating_income * (1 - tax_rate)"),
    historicalFormulaOp("operating_working_capital", "accounts_receivable + inventory - accounts_payable"),
    historicalFormulaOp("change_nwc", "operating_working_capital - LAG(operating_working_capital, 1)"),
    historicalFormulaOp("fcff", "nopat + depreciation_amortization - capital_expenditures - change_nwc"),
    forecastFormulaOp("revenue.total", "LAG(revenue.total, 1) * (1 + growth.revenue.total)"),
    forecastFormulaOp("operating_income", "revenue.total * margin.operating"),
    forecastFormulaOp("ebitda", "operating_income + depreciation_amortization"),
    forecastFormulaOp("nopat", "operating_income * (1 - tax_rate)"),
    forecastFormulaOp("depreciation_amortization", "revenue.total * ratio.da_to_revenue"),
    forecastFormulaOp("capital_expenditures", "revenue.total * ratio.capex_to_revenue"),
    forecastFormulaOp("operating_working_capital", "revenue.total * ratio.operating_nwc_to_revenue"),
    forecastFormulaOp("change_nwc", "operating_working_capital - LAG(operating_working_capital, 1)"),
    forecastFormulaOp("fcff", "nopat + depreciation_amortization - capital_expenditures - change_nwc"),
    assumptionOp("growth.revenue.total", ["FY2024"], [0.10], PERCENT),
    assumptionOp("margin.operating", ["FY2024"], [0.20], PERCENT),
    assumptionOp("tax_rate", ["FY2024"], [0.25], PERCENT),
    assumptionOp("ratio.da_to_revenue", ["FY2024"], [0.05], RATIO),
    assumptionOp("ratio.capex_to_revenue", ["FY2024"], [0.04], RATIO),
    assumptionOp("ratio.operating_nwc_to_revenue", ["FY2024"], [0.075], RATIO),
    assumptionOp("terminal_growth", ["FY2024"], [0.03], PERCENT),
    assumptionOp("exit_multiple", ["FY2024"], [8], RATIO),
  ]);
  assert.equal(current.status, "operations_fcff");
  assert.equal(current.currentWorkbook.valuation, null, "wacc is not resolved yet");

  const waccInputs: WaccSheetComputedInput[] = [
    { rowId: "beta", value: 1, provenance: { sourceType: "computed", sourceRefs: ["contract-beta"], asOfDate: "2023-12-31", rationale: "contract fixture beta" } },
    { rowId: "cost_of_debt", value: 0.05, provenance: { sourceType: "filing", sourceRefs: ["contract-bond"], asOfDate: "2023-12-31", rationale: "contract fixture cost of debt (unused: total_debt is zero)" } },
    { rowId: "equity_value", value: 100, provenance: { sourceType: "market", sourceRefs: ["contract-market"], asOfDate: "2023-12-31", rationale: "contract fixture equity value" } },
    { rowId: "total_debt", value: 0, provenance: { sourceType: "filing", sourceRefs: ["contract-debt"], asOfDate: "2023-12-31", rationale: "contract fixture total debt" } },
    { rowId: "effective_tax_rate", value: 0.25, provenance: { sourceType: "computed", sourceRefs: ["contract-tax"], asOfDate: "2023-12-31", rationale: "contract fixture tax rate" } },
    { rowId: "cash_and_equivalents_value", value: 0, provenance: { sourceType: "filing", sourceRefs: ["contract-cash"], asOfDate: "2023-12-31", rationale: "contract fixture cash" } },
  ];
  current = service.refreshWaccSheet(modelId, current.revision, waccInputs);
  current = service.applyOperations(modelId, current.revision, [
    { kind: "set_wacc_input", input: { rowId: "risk_free_rate", value: 0.04, sourceType: "market", sourceRefs: ["contract-treasury"], rationale: "contract fixture risk-free rate" } },
    { kind: "set_wacc_input", input: { rowId: "equity_risk_premium", value: 0.06, sourceType: "market", sourceRefs: ["contract-erp"], rationale: "contract fixture equity risk premium" } },
  ]);
  assert.equal(current.currentWorkbook.valuation, null, "the valuation config judgments are still unmade");

  const valuationConfig: ValuationConfig = {
    anchorPeriodId: "FY2023", discountConvention: "year_end", exitTerminalMetric: "ebitda",
    sensitivity: { waccDeltas: [0], terminalGrowthDeltas: [0], exitMultipleDeltas: [0] },
    sourceType: "analyst_inference", sourceRefs: ["contract-methodology"], asOfDate: "2023-12-31",
    rationale: "contract fixture valuation methodology",
  };
  current = service.applyOperations(modelId, current.revision, [
    { kind: "set_valuation_config", config: valuationConfig },
  ]);
  assert.equal(current.status, "valued", "contract fixture must reach `valued` to exercise the valuation/assumption/reconciliation shapes");

  return service.getModel(modelId) as ModelContextView;
}

function assertHasKeys(value: unknown, keys: string[], label: string): void {
  assert.ok(value && typeof value === "object", `${label} should be an object`);
  for (const key of keys) {
    assert.ok(key in (value as Record<string, unknown>), `${label} is missing key "${key}"`);
  }
}

test("model context view exposes the top-level keys the client mirrors", () => {
  const context = buildContext();
  assertHasKeys(context, ["model", "revisionHistory", "currentWorkbook"], "ModelContextView");
  assertHasKeys(context.model, ["modelId", "symbol", "currentRevision", "lifecycleStage", "ownerTenantId", "originSessionId"], "ModelView");
});

test("current workbook exposes the keys the client mirrors", () => {
  const workbook = buildContext().currentWorkbook;
  assertHasKeys(workbook, [
    "modelId", "revision", "lifecycleStage", "periods", "sections",
    "categoryGroups", "reconciliationResults", "valuationConfig",
    "diagnostics", "valuation", "waccSheet", "mode",
  ], "CurrentWorkbookView");
  assertHasKeys(workbook.sections, ["history", "metrics", "revenue", "operations", "dcf"], "sections");
});

test("periods expose the keys the client mirrors", () => {
  const period = buildContext().currentWorkbook.periods[0];
  assertHasKeys(period, ["id", "label", "start", "end", "cls"], "Period");
});

test("workbook rows and cells expose the keys the client mirrors", () => {
  const rows = buildContext().currentWorkbook.sections.operations;
  assert.ok(rows.length > 0, "operations section should have rows");
  const row = rows[0]!;
  assertHasKeys(row, [
    "lineItemId", "label", "section", "role", "unit", "order",
    "sources", "formulas", "assumptions", "cells",
  ], "WorkbookRowView");
  const cell = row.cells[PERIODS[0]!.id];
  assertHasKeys(cell, ["value", "status", "source", "diagnostics", "dependencies"], "WorkbookCellView");
});

test("the wacc sheet exposes the keys the client mirrors", () => {
  const waccSheet = buildContext().currentWorkbook.waccSheet;
  assert.ok(waccSheet, "a new model should already carry a wacc sheet");
  assertHasKeys(waccSheet, ["asOfDate", "rows"], "WaccSheet");
  assertHasKeys(waccSheet.rows[0], ["rowId", "label", "unit", "source", "value", "missingInputs"], "WaccSheetRow");
});

test("revision summaries expose the keys the model_revision frame is built from", () => {
  // `revisionHistory` is every prior revision header, excluding the current one
  // (see `buildModelContextView`'s `headers.slice(0, -1)`), so a freshly created
  // model — one revision, no history yet — has to be advanced once before any
  // summary exists to assert keys against.
  const service = createTestService();
  service.applyOperations("contract-model", 0, [{
    kind: "set_wacc_input",
    input: {
      rowId: "equity_risk_premium",
      value: 0.05,
      sourceType: "analyst_inference",
      sourceRefs: [],
      rationale: "contract test seed",
      asOfDate: "2024-01-01",
    },
  }]);
  const context = service.getModel("contract-model") as ModelContextView;
  const [summary] = context.revisionHistory;
  assertHasKeys(summary, [
    "revision", "parentRevision", "lifecycleStage", "createdAt",
    "changes", "changedSections", "warningCount", "blockerCount",
  ], "RevisionSummary");
});

// --- Deep tripwires: Criticals 1-3 renamed or reshaped fields that live *inside* valuation,
// assumptions[], and reconciliationResults[] — one level deeper than the assertions above reach.
// These run against `buildValuedContext()`'s real `valued` model so a genuinely wrong field name
// (not just a missing top-level key) fails here the way it silently didn't before.

test("valuation exposes the renamed terminal fields and the sensitivity cell-object shape the client mirrors", () => {
  const valuation = buildValuedContext().currentWorkbook.valuation;
  assert.ok(valuation, "the contract fixture must reach `valued`");
  assertHasKeys(valuation, [
    "explicitPeriods", "perpetuityGrowth", "exitMultiple", "waccByGrowth", "waccByMultiple",
  ], "ValuationOutput");

  for (const [label, method] of [
    ["perpetuityGrowth", valuation.perpetuityGrowth],
    ["exitMultiple", valuation.exitMultiple],
  ] as const) {
    // terminalPresentValue / impliedValuePerShare are the two Critical-2 renames
    // (presentValueOfTerminal -> terminalPresentValue, valuePerShare -> impliedValuePerShare).
    assertHasKeys(method, [
      "method", "explicitPeriods", "terminalValue", "terminalPresentValue",
      "terminalValuePercentOfEnterpriseValue", "enterpriseValue", "equityValue",
      "dilutedShares", "impliedValuePerShare",
    ], label);
  }

  for (const [label, matrix] of [
    ["waccByGrowth", valuation.waccByGrowth],
    ["waccByMultiple", valuation.waccByMultiple],
  ] as const) {
    assertHasKeys(matrix, ["rowVariable", "columnVariable", "rowDeltas", "columnDeltas", "cells"], label);
    // Critical 3: `cells` holds CELL OBJECTS, not bare numbers — descend into one and assert its keys
    // rather than just checking `cells` exists, or a `number[][]` mirror would pass this test too.
    const cell = matrix.cells[0]?.[0];
    assert.ok(cell && typeof cell === "object", `${label} cells[0][0] should be an object, not a bare number`);
    assertHasKeys(cell, ["rowDelta", "columnDelta", "impliedValuePerShare"], `${label} cell`);
  }
});

test("a workbook row's assumptions expose the plural periods/payload shape and flat provenance the client mirrors", () => {
  const rows = buildValuedContext().currentWorkbook.sections.revenue;
  const row = rows.find((candidate) => candidate.lineItemId === "growth.revenue.total");
  assert.ok(row, "growth.revenue.total row must exist");
  assert.ok(row.assumptions.length > 0, "growth.revenue.total must carry the forecast assumption set in the fixture");
  // Critical 1: `periods` (plural) + `payload`, not one `periodId` + one `value`; provenance
  // (sourceType/sourceRefs/asOfDate/rationale) is flat and required, not a nested optional object.
  assertHasKeys(row.assumptions[0], [
    "assumptionId", "lineItemId", "periods", "payload", "sourceType", "sourceRefs", "asOfDate", "rationale",
  ], "Assumption");
  assert.ok(Array.isArray(row.assumptions[0]!.periods), "Assumption.periods must be an array");
  assert.ok(!("periodId" in row.assumptions[0]!), "Assumption must not carry the old singular periodId");
  assert.ok(!("value" in row.assumptions[0]!), "Assumption must not carry the old singular value");
});

test("reconciliation results expose the discriminated-union keys the client mirrors, including the kind discriminant", () => {
  const results = buildValuedContext().currentWorkbook.reconciliationResults;
  assert.ok(results.length > 0, "a model with a committed actual period always produces accounting-identity checks");
  const result = results.find((candidate) => candidate.kind === "accounting_identity");
  assert.ok(result, "expected at least one accounting_identity reconciliation result");
  // Critical 4: a discriminated union, not a flat object — `identity` lives only on this arm.
  assertHasKeys(result, [
    "kind", "ruleId", "periodId", "status", "required", "actual", "calculated",
    "residual", "difference", "tolerance", "refs", "identity", "parentLineItemId",
  ], "ReconciliationResult (accounting_identity)");
  assert.equal(result!.kind, "accounting_identity");
});
