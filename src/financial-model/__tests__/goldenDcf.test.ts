import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinancialModelError } from "../errors.ts";
import type { FinancialModelSnapshot, ModelOperation } from "../operations.ts";
import { FinancialModelService } from "../service.ts";
import { financialModelSnapshotCodec } from "../snapshotCodec.ts";
import { SqliteModelStore, type SnapshotCodec } from "../store.ts";
import type {
  Assumption, Fact, Period, PreparedStatementRow, Unit, ValuationConfig,
} from "../types.ts";
import type { WaccSheetComputedInput } from "../waccSheet.ts";
import type { RevisionChangeSummary, WorkbookRowView } from "../views.ts";

const USD: Unit = { kind: "currency", code: "USD" };
const SHARES: Unit = { kind: "shares" };
const PERIODS: Period[] = [
  { id: "FY2021", label: "FY2021", start: "2021-01-01", end: "2021-12-31", cls: "actual" },
  { id: "FY2022", label: "FY2022", start: "2022-01-01", end: "2022-12-31", cls: "actual" },
  { id: "FY2023", label: "FY2023", start: "2023-01-01", end: "2023-12-31", cls: "actual" },
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "forecast" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
];
const ACTUALS = ["FY2021", "FY2022", "FY2023"];
const FORECASTS = ["FY2024", "FY2025", "FY2026"];

type SourceDefinition = PreparedStatementRow & { values: number[] };
let nextSourceOrder = 1;
const SOURCES: SourceDefinition[] = [
  source("income_statement", "revenue", "Revenue", [100, 110, 120]),
  source("income_statement", "cost_of_revenue", "Cost of revenue", [66, 72.6, 79.2]),
  source("income_statement", "gross_profit", "Gross profit", [34, 37.4, 40.8]),
  source("income_statement", "operating_income", "Operating income", [20, 22, 24]),
  source("income_statement", "da", "D&A", [5, 5.5, 6]),
  source("income_statement", "pretax", "Pretax income", [20, 22, 24]),
  source("income_statement", "tax", "Income tax expense", [5, 5.5, 6]),
  source("income_statement", "net_income", "Net income", [15, 16.5, 18]),
  source("income_statement", "rd", "Research and development", [6, 6.6, 7.2]),
  source("income_statement", "sga", "Selling and administrative", [8, 8.8, 9.6]),
  source("cash_flow_statement", "capex", "Capital expenditures", [4, 4.4, 4.8]),
  source("balance_sheet", "ar", "Accounts receivable", [10, 11, 12]),
  source("balance_sheet", "inventory", "Inventory", [5, 5.5, 6]),
  source("balance_sheet", "ap", "Accounts payable", [8, 8.5, 9]),
  source("balance_sheet", "assets", "Total assets", [200, 220, 240]),
  source("balance_sheet", "equity", "Shareholders equity", [100, 110, 120]),
  source("balance_sheet", "cash", "Cash", [8, 9, 10]),
  source("balance_sheet", "sti", "Short-term investments", [2, 2, 2]),
  source("balance_sheet", "debt", "Debt", [28, 29, 30]),
  source("balance_sheet", "shares", "Diluted shares", [10, 10, 10], SHARES),
];

const HISTORICAL_EXPECTED = {
  operatingNwc: [7, 8, 9],
};
const FORECAST_EXPECTED = {
  revenue: [132, 145.2, 159.72],
  operatingIncome: [26.4, 29.04, 31.944],
  nopat: [19.8, 21.78, 23.958],
  da: [6.6, 7.26, 7.986],
  capex: [5.28, 5.808, 6.3888],
  operatingNwc: [9.9, 10.89, 11.979],
  changeNwc: [0.9, 0.99, 1.089],
  fcff: [20.22, 22.242, 24.4662],
};
// WACC is a flat 0.10 in every forecast period (see WACC_COMPUTED_INPUTS / setWaccInputOp below): the
// sheet's locked formula collapses to cost_of_equity alone once total_debt is zero, so d_over_v drops
// out and wacc = cost_of_equity = risk_free_rate + beta * equity_risk_premium = 0.04 + 1 * 0.06.
const VALUATION_EXPECTED = {
  discountFactors: [1.1, 1.21, 1.331],
  explicitPresentValue: 55.145454545455,
  perpetuityTerminalValue: 360.002657142857,
  perpetuityEnterpriseValue: 325.620779221,
  perpetuityEquityValue: 307.620779221,
  perpetuityPerShare: 30.7620779221,
  exitTerminalValue: 319.44,
  exitEnterpriseValue: 295.145454545,
  exitEquityValue: 277.145454545,
  exitPerShare: 27.7145454545,
};

/** Fills every WACC-sheet row the engine can derive, hand-supplied here since the golden fixture has
 * no bar repository. Chosen so total_debt is zero: the capital-structure weight on cost_of_debt drops
 * out entirely, leaving wacc = cost_of_equity, deterministic and independent of cost_of_debt/tax. */
const WACC_COMPUTED_INPUTS: WaccSheetComputedInput[] = [
  { rowId: "beta", value: 1, provenance: { sourceType: "computed", sourceRefs: ["golden-beta"], asOfDate: "2023-12-31", rationale: "Golden fixture beta." } },
  { rowId: "risk_free_rate", value: 0.04, provenance: { sourceType: "market", sourceRefs: ["golden-treasury-candidate"], asOfDate: "2023-12-31", rationale: "Golden fixture Treasury candidate; agent must select the duration." } },
  { rowId: "cost_of_debt", value: 0.05, provenance: { sourceType: "filing", sourceRefs: ["golden-bond"], asOfDate: "2023-12-31", rationale: "Golden fixture cost of debt (unused: total_debt is zero)." } },
  { rowId: "equity_value", value: 100, provenance: { sourceType: "market", sourceRefs: ["golden-market"], asOfDate: "2023-12-31", rationale: "Golden fixture equity value." } },
  { rowId: "total_debt", value: 0, provenance: { sourceType: "filing", sourceRefs: ["golden-debt"], asOfDate: "2023-12-31", rationale: "Golden fixture total debt." } },
  { rowId: "effective_tax_rate", value: 0.25, provenance: { sourceType: "computed", sourceRefs: ["golden-tax"], asOfDate: "2023-12-31", rationale: "Golden fixture tax rate (unused: total_debt is zero)." } },
  { rowId: "cash_and_equivalents_value", value: 0, provenance: { sourceType: "filing", sourceRefs: ["golden-cash"], asOfDate: "2023-12-31", rationale: "Golden fixture cash." } },
];

function setWaccInputOp(rowId: "risk_free_rate" | "equity_risk_premium", value: number, rationale: string): ModelOperation {
  return { kind: "set_wacc_input", input: {
    rowId, value,
    sourceType: rowId === "equity_risk_premium" ? "agent_estimate" : "market",
    sourceRefs: rowId === "equity_risk_premium" ? [] : ["golden-treasury"],
    rationale,
  } };
}

function setForecastFormula(lineItemId: string, source: string): ModelOperation {
  return { kind: "set_formula", formula: { lineItemId, appliesTo: "forecast", periodIds: FORECASTS, source } };
}

function setHistoricalFormula(lineItemId: string, source: string): ModelOperation {
  return { kind: "set_formula", formula: { lineItemId, appliesTo: "historical", periodIds: ACTUALS, source } };
}

test("golden service workflow maps statements once and produces a deterministic DCF valuation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "golden-dcf-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "models.sqlite");
  let store = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(
    databasePath,
    financialModelSnapshotCodec,
  );
  const service = new FinancialModelService(store, "golden-session");

  // The three revisions the production path actually walks: a value-free model, the filing import
  // (source rows plus their staged evidence facts), then spine_mapping's canonical facts committed
  // straight onto the spine — no review ceremony in between.
  const created = service.createModel({
    modelId: "golden-dcf", ownerTenantId: "agent", originSessionId: "golden-session",
    symbol: "GOLD", metadata: { companyName: "Golden Co" }, reportingCurrency: "USD",
    periods: PERIODS, preparedStatementRows: [],
  });
  assert.equal(created.revision, 0);

  const imported = service.stagePreparedStatements(
    "golden-dcf", 0, SOURCES.map(({ values: _values, ...row }) => row), buildFacts(),
  );
  assert.equal(imported.revision, 1);
  assert.equal(imported.currentWorkbook.mode, "statement_mapping");

  const reviewed = service.commitSpineFacts("golden-dcf", 1, {
    facts: buildSpineFacts(), historicalPeriodIds: ACTUALS,
  });
  assert.equal(reviewed.revision, 2);
  assert.equal(reviewed.currentWorkbook.mode, "dcf");
  assert.equal("sourceStatementReview" in reviewed.currentWorkbook, false);

  // The filing import stays readable as evidence after the spine commits over it.
  const sourceAudit = service.getModel("golden-dcf", { section: "source_income_statement" });
  assert.ok("rows" in sourceAudit);
  assert.equal(sourceAudit.rows.length, 10);

  // Lifecycle is derived: committing the spine alone reads as history_committed.
  assert.equal(reviewed.status, "history_committed");

  const revenueResult = service.applyOperations("golden-dcf", 2, [
    setHistoricalFormula("tax_rate", "income_tax_expense / pretax_income"),
    setHistoricalFormula("ebitda", "operating_income + depreciation_amortization"),
    setHistoricalFormula("nopat", "operating_income * (1 - tax_rate)"),
    setHistoricalFormula("operating_working_capital", "accounts_receivable + inventory - accounts_payable"),
    setHistoricalFormula("change_nwc", "operating_working_capital - LAG(operating_working_capital, 1)"),
    setHistoricalFormula("fcff", "nopat + depreciation_amortization - capital_expenditures - change_nwc"),
    setForecastFormula("revenue.total", "LAG(revenue.total, 1) * (1 + growth.revenue.total)"),
    setAssumption("growth.revenue.total", FORECASTS, [0.10]),
  ]);
  assert.equal(revenueResult.revision, 3);
  assert.equal(revenueResult.status, "revenue_forecast");
  assertRowValues(revenueResult.currentWorkbook.sections.revenue, "revenue.total", FORECASTS, FORECAST_EXPECTED.revenue);

  const operatingResult = service.applyOperations("golden-dcf", 3, [
    setForecastFormula("operating_income", "revenue.total * margin.operating"),
    setForecastFormula("ebitda", "operating_income + depreciation_amortization"),
    setForecastFormula("nopat", "operating_income * (1 - tax_rate)"),
    setForecastFormula("depreciation_amortization", "revenue.total * ratio.da_to_revenue"),
    setForecastFormula("capital_expenditures", "revenue.total * ratio.capex_to_revenue"),
    setForecastFormula("operating_working_capital", "revenue.total * ratio.operating_nwc_to_revenue"),
    setForecastFormula("change_nwc", "operating_working_capital - LAG(operating_working_capital, 1)"),
    setForecastFormula("fcff", "nopat + depreciation_amortization - capital_expenditures - change_nwc"),
    setAssumption("margin.operating", FORECASTS, [0.20]),
    setAssumption("tax_rate", FORECASTS, [0.25]),
    setAssumption("ratio.da_to_revenue", FORECASTS, [0.05]),
    setAssumption("ratio.capex_to_revenue", FORECASTS, [0.04]),
    setAssumption("ratio.operating_nwc_to_revenue", FORECASTS, [0.075]),
  ]);
  assert.equal(operatingResult.revision, 4);
  assert.equal(operatingResult.status, "operations_fcff");
  assertRowValues(operatingResult.currentWorkbook.sections.operations, "operating_income", FORECASTS, FORECAST_EXPECTED.operatingIncome);
  assertRowValues(operatingResult.currentWorkbook.sections.operations, "nopat", FORECASTS, FORECAST_EXPECTED.nopat);
  assertRowValues(operatingResult.currentWorkbook.sections.operations, "depreciation_amortization", FORECASTS, FORECAST_EXPECTED.da);
  assertRowValues(operatingResult.currentWorkbook.sections.operations, "capital_expenditures", FORECASTS, FORECAST_EXPECTED.capex);
  assertRowValues(operatingResult.currentWorkbook.sections.operations, "operating_working_capital", ACTUALS, HISTORICAL_EXPECTED.operatingNwc);
  assertRowValues(operatingResult.currentWorkbook.sections.operations, "operating_working_capital", FORECASTS, FORECAST_EXPECTED.operatingNwc);
  assertRowValues(operatingResult.currentWorkbook.sections.operations, "change_nwc", FORECASTS, FORECAST_EXPECTED.changeNwc);
  assertRowValues(operatingResult.currentWorkbook.sections.dcf, "fcff", FORECASTS, FORECAST_EXPECTED.fcff);

  // A new model makes no valuation judgments for you: the three decisions start null and carry no
  // provenance, because there is nobody to attribute a value nobody chose.
  const fresh = operatingResult.currentWorkbook.valuationConfig;
  assert.equal(fresh.discountConvention, null);
  assert.equal(fresh.exitTerminalMetric, null);
  assert.equal(fresh.sensitivity, null);
  assert.equal(fresh.sourceType ?? null, null);

  // With the WACC sheet's wacc row still unresolved, the terminal/bridge batch commits fine but the
  // model simply reads as not-yet-valued: valuation stays null until the discount rate exists.
  const terminalSet = service.applyOperations("golden-dcf", 4, [
    setAssumption("terminal_growth", ["FY2026"], [0.03]),
    setAssumption("exit_multiple", ["FY2026"], [8]),
    notApplicable("lease_liabilities", ["FY2023"]),
    notApplicable("preferred_equity", ["FY2023"]),
    notApplicable("non_controlling_interests", ["FY2023"]),
  ]);
  assert.equal(terminalSet.revision, 5);
  assert.equal(terminalSet.status, "operations_fcff");
  assert.equal(terminalSet.currentWorkbook.valuation ?? null, null);

  // The sheet is the single source for wacc: the engine derives what it can (here hand-supplied, since
  // the fixture has no bar repository), while the agent supplies ERP and explicitly selects the
  // Treasury duration before valuation.
  const waccRefreshed = service.refreshWaccSheet("golden-dcf", 5, WACC_COMPUTED_INPUTS);
  assert.equal(waccRefreshed.revision, 6);
  const waccResolved = service.applyOperations("golden-dcf", 6, [
    setWaccInputOp("equity_risk_premium", 0.06, "Golden fixture equity risk premium — analyst judgment."),
  ]);
  assert.equal(waccResolved.revision, 7);
  const waccRow = waccResolved.currentWorkbook.waccSheet!.rows.find((row) => row.rowId === "wacc")!;
  assert.equal(waccRow.value, 0.10);
  // A numerically resolved WACC is not an approved discount rate while the Treasury candidate has
  // not been selected by the agent.
  assert.equal(waccResolved.status, "operations_fcff");
  assert.equal(waccResolved.currentWorkbook.valuation ?? null, null);

  const unconfirmed = service.applyOperations("golden-dcf", 7, [
    { kind: "set_valuation_config", config: valuationConfig() },
  ]);
  assert.equal(unconfirmed.revision, 8);
  assert.equal(unconfirmed.status, "operations_fcff");
  assert.equal(unconfirmed.currentWorkbook.valuation ?? null, null);

  // Selecting the candidate rate is the final WACC judgment and immediately unlocks valuation.
  const valued = service.applyOperations("golden-dcf", 8, [
    setWaccInputOp("risk_free_rate", 0.04, "Golden fixture selected 30-year risk-free rate."),
  ]);
  assert.equal(valued.revision, 9);
  assert.equal(valued.currentWorkbook.valuationConfig.sourceType, "analyst_inference");
  assert.equal(valued.status, "valued");
  const valuation = valued.currentWorkbook.valuation!;
  assert.deepEqual(valuation.explicitPeriods.map((period) => period.fcff), FORECAST_EXPECTED.fcff);
  assert.deepEqual(valuation.explicitPeriods.map((period) => period.wacc), [0.10, 0.10, 0.10]);
  assert.deepEqual(valuation.explicitPeriods.map((period) => period.discountFactor), VALUATION_EXPECTED.discountFactors);
  assertClose(valuation.explicitPeriods.reduce((sum, period) => sum + period.presentValue, 0), VALUATION_EXPECTED.explicitPresentValue);
  assertClose(valuation.perpetuityGrowth.terminalValue, VALUATION_EXPECTED.perpetuityTerminalValue);
  assertClose(valuation.perpetuityGrowth.enterpriseValue, VALUATION_EXPECTED.perpetuityEnterpriseValue);
  assertClose(valuation.perpetuityGrowth.equityValue, VALUATION_EXPECTED.perpetuityEquityValue);
  assertClose(valuation.perpetuityGrowth.impliedValuePerShare, VALUATION_EXPECTED.perpetuityPerShare);
  assertClose(valuation.exitMultiple.terminalValue, VALUATION_EXPECTED.exitTerminalValue);
  assertClose(valuation.exitMultiple.enterpriseValue, VALUATION_EXPECTED.exitEnterpriseValue);
  assertClose(valuation.exitMultiple.equityValue, VALUATION_EXPECTED.exitEquityValue);
  assertClose(valuation.exitMultiple.impliedValuePerShare, VALUATION_EXPECTED.exitPerShare);
  assert.equal(valuation.perpetuityGrowth.method, "perpetuity_growth");
  assert.equal(valuation.exitMultiple.method, "exit_multiple");
  assertSensitivityMatrix(valuation.waccByGrowth, "growth");
  assertSensitivityMatrix(valuation.waccByMultiple, "multiple");
  for (const period of valuation.explicitPeriods) {
    assert.ok(period.refs.length >= 2, `${period.periodId} must retain FCFF and WACC lineage`);
    assert.ok(period.refs.every((ref) => !ref.startsWith("source.")));
  }
  for (const method of [valuation.perpetuityGrowth, valuation.exitMultiple]) {
    assert.ok(method.refs.length > 0);
    assert.ok(method.refs.every((ref) => !ref.startsWith("source.")));
    assert.ok(method.bridge.every((adjustment) => adjustment.refs.length === 1));
  }
  assert.equal((valuation as unknown as Record<string, unknown>)["blended"], undefined);

  const context = service.getModel("golden-dcf");
  assert.ok("currentWorkbook" in context);
  assert.deepEqual(context.revisionHistory.map((revision) => revision.revision), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(context.currentWorkbook.revision, 9);
  assert.equal(context.currentWorkbook.mode, "dcf");
  assert.equal(store.getRevision("golden-dcf")?.revision, 9);
  const goldenAgentContext = JSON.stringify(context);
  const valuedSnapshot = financialModelSnapshotCodec.encode(
    store.getRevision("golden-dcf")!.snapshot,
  );
  store.close();

  let decodeCount = 0;
  const instrumentedCodec: SnapshotCodec<FinancialModelSnapshot> = {
    encode: (snapshot) => financialModelSnapshotCodec.encode(snapshot),
    decode: (json) => {
      decodeCount += 1;
      return financialModelSnapshotCodec.decode(json);
    },
  };
  store = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(
    databasePath,
    instrumentedCodec,
  );
  t.after(() => store.close());
  const reopenedService = new FinancialModelService(store, "golden-session");
  assert.equal(JSON.stringify(reopenedService.getModel("golden-dcf")), goldenAgentContext);
  assert.equal(decodeCount, 1, "revision headers must not decode historical snapshots");

  // set_wacc_input is idempotent when replayed with the same value/rationale (asOfDate re-defaults to
  // the sheet's own fixed date each time), so replaying it changes nothing byte-for-byte — the same
  // repeatability guarantee the old wacc assumption replay exercised.
  const repeatedOnce = reopenedService.applyOperations("golden-dcf", 9, [
    setWaccInputOp("risk_free_rate", 0.04, "Golden fixture selected 30-year risk-free rate."),
  ]);
  assert.equal(repeatedOnce.revision, 10);
  assertSnapshotBytes(
    financialModelSnapshotCodec.encode(store.getRevision("golden-dcf")!.snapshot),
    valuedSnapshot,
  );
  const repeatedTwice = reopenedService.applyOperations("golden-dcf", 10, [
    setWaccInputOp("risk_free_rate", 0.04, "Golden fixture selected 30-year risk-free rate."),
  ]);
  assert.equal(repeatedTwice.revision, 11);
  assertSnapshotBytes(
    financialModelSnapshotCodec.encode(store.getRevision("golden-dcf")!.snapshot),
    valuedSnapshot,
  );
});

function source(
  statement: PreparedStatementRow["statement"], slug: string, label: string, values: number[], unit: Unit = USD,
): SourceDefinition {
  return { sourceLineItemId: `source.${statement}.${slug}`, statement, label, unit, order: nextSourceOrder++, values };
}

function buildFacts(): Fact[] {
  return SOURCES.flatMap((definition) => ACTUALS.map((periodId, index) => ({
    factId: `${definition.sourceLineItemId}@${periodId}`, status: "staged" as const,
    lineItemId: definition.sourceLineItemId, periodId, value: definition.values[index]!, unit: definition.unit,
    provenance: { sourceType: "company_disclosure", sourceRefs: ["golden-10k"], asOfDate: "2024-02-01" },
  })));
}

/** What spine_mapping produces for this fixture: canonical spine targets fed by the same filing rows
 *  the source statements carry, so every golden number stays single-sourced in SOURCES. A target with
 *  no periodIds covers all three actuals; the bridge rows are point-in-time at FY2023. The operating
 *  working-capital identity is not listed — commitSpineFacts installs it. */
const SPINE: { target: string; parts: [PreparedStatementRow["statement"], string][]; periodIds?: string[]; unit?: Unit }[] = [
  { target: "revenue.total", parts: [["income_statement", "revenue"]] },
  { target: "cost_of_revenue", parts: [["income_statement", "cost_of_revenue"]] },
  { target: "gross_profit", parts: [["income_statement", "gross_profit"]] },
  { target: "operating_income", parts: [["income_statement", "operating_income"]] },
  { target: "depreciation_amortization", parts: [["income_statement", "da"]] },
  { target: "pretax_income", parts: [["income_statement", "pretax"]] },
  { target: "income_tax_expense", parts: [["income_statement", "tax"]] },
  { target: "net_income", parts: [["income_statement", "net_income"]] },
  { target: "operating_expenses", parts: [["income_statement", "rd"], ["income_statement", "sga"]] },
  { target: "capital_expenditures", parts: [["cash_flow_statement", "capex"]] },
  { target: "accounts_receivable", parts: [["balance_sheet", "ar"]] },
  { target: "inventory", parts: [["balance_sheet", "inventory"]] },
  { target: "accounts_payable", parts: [["balance_sheet", "ap"]] },
  { target: "total_assets", parts: [["balance_sheet", "assets"]] },
  { target: "shareholders_equity", parts: [["balance_sheet", "equity"]] },
  { target: "cash_and_equivalents", parts: [["balance_sheet", "cash"]] },
  { target: "short_term_investments", parts: [["balance_sheet", "sti"]] },
  { target: "debt", parts: [["balance_sheet", "debt"]] },
  { target: "cash_available_for_bridge", parts: [["balance_sheet", "cash"]], periodIds: ["FY2023"] },
  { target: "non_operating_investments", parts: [["balance_sheet", "sti"]], periodIds: ["FY2023"] },
  { target: "diluted_shares", parts: [["balance_sheet", "shares"]], periodIds: ["FY2023"], unit: SHARES },
];

function buildSpineFacts(): Fact[] {
  const sourceValues = (statement: PreparedStatementRow["statement"], slug: string): number[] =>
    SOURCES.find((definition) => definition.sourceLineItemId === `source.${statement}.${slug}`)!.values;
  return SPINE.flatMap((entry) => (entry.periodIds ?? ACTUALS).map((periodId) => {
    const index = ACTUALS.indexOf(periodId);
    return {
      factId: `${entry.target}@${periodId}`, status: "staged" as const,
      lineItemId: entry.target, periodId,
      value: entry.parts.reduce((sum, [statement, slug]) => sum + sourceValues(statement, slug)[index]!, 0),
      unit: entry.unit ?? USD,
      provenance: { sourceType: "unified_statements", sourceRefs: [`unified.${entry.target}`], asOfDate: "2024-02-01" },
    };
  }));
}

function setAssumption(lineItemId: string, periods: string[], values: number[]): ModelOperation {
  const percent = new Set(["growth.revenue.total", "margin.operating", "tax_rate", "wacc", "terminal_growth"]);
  const assumption: Assumption = {
    assumptionId: `assumption:${lineItemId}`, lineItemId, periods: [...periods],
    payload: { kind: "values", values: [...values], unit: { kind: percent.has(lineItemId) ? "percent" : "ratio" } },
    sourceType: "analyst_inference", sourceRefs: ["golden-methodology"], asOfDate: "2023-12-31",
    rationale: "Hand-computed golden assumption",
  };
  return { kind: "set_assumption", assumption };
}

function notApplicable(lineItemId: string, periods: string[]): ModelOperation {
  return { kind: "set_formula", formula: {
    lineItemId, appliesTo: "historical", periodIds: periods, source: "0",
  } };
}

function valuationConfig(): ValuationConfig {
  return { anchorPeriodId: "FY2023", discountConvention: "year_end", exitTerminalMetric: "ebitda",
    sensitivity: { waccDeltas: [-0.01, 0, 0.01], terminalGrowthDeltas: [-0.005, 0, 0.005], exitMultipleDeltas: [-1, 0, 1] },
    sourceType: "analyst_inference", sourceRefs: ["golden-methodology"], asOfDate: "2023-12-31",
    rationale: "Hand-computed DCF methodology" };
}

function assertRowValues(rows: WorkbookRowView[], id: string, periods: string[], expected: number[]): void {
  const row = rows.find((candidate) => candidate.lineItemId === id);
  assert.ok(row, `missing workbook row ${id}`);
  periods.forEach((periodId, index) => assert.equal(row.cells[periodId]?.value, expected[index], `${id}@${periodId}`));
}

function cellValue(rows: WorkbookRowView[], id: string, periodId: string): number | null | undefined {
  return rows.find((row) => row.lineItemId === id)?.cells[periodId]?.value;
}

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

function assertSnapshotBytes(actual: string, expected: string): void {
  const limit = Math.min(actual.length, expected.length);
  let offset = 0;
  while (offset < limit && actual[offset] === expected[offset]) offset += 1;
  assert.equal(actual, expected, `snapshot differs at byte ${offset}: actual=${actual.slice(offset, offset + 160)} expected=${expected.slice(offset, offset + 160)}`);
}

function assertSensitivityMatrix(
  matrix: { rowDeltas: number[]; columnDeltas: number[]; cells: Array<Array<{
    rowDelta: number; columnDelta: number; impliedValuePerShare: number | null;
    diagnostics: unknown[];
  }>> },
  method: "growth" | "multiple",
): void {
  assert.deepEqual(matrix.rowDeltas, [-0.01, 0, 0.01]);
  const expectedColumns = method === "growth" ? [-0.005, 0, 0.005] : [-1, 0, 1];
  assert.deepEqual(matrix.columnDeltas, expectedColumns);
  matrix.rowDeltas.forEach((rowDelta, rowIndex) => {
    expectedColumns.forEach((columnDelta, columnIndex) => {
      const cell = matrix.cells[rowIndex]?.[columnIndex];
      assert.ok(cell, `missing ${method} sensitivity cell ${rowIndex},${columnIndex}`);
      assert.equal(cell.rowDelta, rowDelta);
      assert.equal(cell.columnDelta, columnDelta);
      assert.deepEqual(cell.diagnostics, []);
      assert.ok(cell.impliedValuePerShare !== null);
      assertClose(
        cell.impliedValuePerShare,
        handComputedSensitivity(method, rowDelta, columnDelta),
      );
    });
  });
}

function handComputedSensitivity(
  method: "growth" | "multiple",
  waccDelta: number,
  terminalDelta: number,
): number {
  const wacc = [0.10, 0.10, 0.10].map((value) => value + waccDelta);
  const factors: number[] = [];
  let factor = 1;
  for (const rate of wacc) {
    factor *= 1 + rate;
    factors.push(factor);
  }
  const explicitPresentValue = FORECAST_EXPECTED.fcff.reduce(
    (total, fcff, index) => total + fcff / factors[index]!,
    0,
  );
  const terminalValue = method === "growth"
    ? FORECAST_EXPECTED.fcff[2]! * (1 + 0.03 + terminalDelta)
      / (wacc[2]! - 0.03 - terminalDelta)
    : 39.93 * (8 + terminalDelta);
  // Historical bridge is cash 10 + short-term investments 2 - debt 30;
  // diluted shares are 10. These are literal fixture inputs, not production output.
  return (explicitPresentValue + terminalValue / factors[2]! - 18) / 10;
}
