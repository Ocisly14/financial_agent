import assert from "node:assert/strict";
import test from "node:test";
import { cellKey } from "../dsl/graph.ts";
import { evaluate, quantize } from "../engine.ts";
import { FinancialModelError } from "../errors.ts";
import {
  DEFAULT_METRIC_DEFINITIONS,
  installDefaultMetrics,
  installRegisteredMetric,
} from "../metrics.ts";
import { addRevenueStream, createSkeleton, type Skeleton } from "../skeleton.ts";
import type { ActiveFact, Period, ValuationConfig } from "../types.ts";

const periods: Period[] = [
  { id: "FY2022", label: "FY2022", start: "2022-01-01", end: "2022-12-31", cls: "actual" },
  { id: "FY2023", label: "FY2023", start: "2023-01-01", end: "2023-12-31", cls: "actual" },
  { id: "TTM", label: "TTM", start: "2023-07-01", end: "2024-06-30", cls: "ttm" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" },
];

test("default registry installs the complete formula library and reuses skeleton drivers", () => {
  const base = createSkeleton({ currency: "USD", periods });
  const next = installDefaultMetrics(base, periods);
  assert.ok(next.lineItems.some((row) => row.id === "metric.roa" && row.unit.kind === "ratio"));
  assert.ok(next.formulas.some((formula) => formula.lineItemId === "metric.roa"
    && formula.source === "net_income / AVERAGE(total_assets, -1, 0)"));
  assert.equal(next.lineItems.filter((row) => row.id === "growth.revenue.total").length, 1);
  assert.equal(next.lineItems.filter((row) => row.id === "margin.operating").length, 1);
  const metricFormula = next.formulas.find((formula) => formula.lineItemId === "metric.net_debt")!;
  assert.deepEqual(metricFormula.periodIds, ["FY2022", "FY2023"]);
  assert.equal(metricFormula.periodIds?.includes("TTM"), false);
  assert.equal(Object.isFrozen(DEFAULT_METRIC_DEFINITIONS), true);
  assert.equal(DEFAULT_METRIC_DEFINITIONS.every((definition) => Object.isFrozen(definition)), true);
  for (const id of [
    "growth.revenue.total",
    "margin.operating",
    "tax_rate",
    "ratio.da_to_revenue",
    "ratio.capex_to_revenue",
    "ratio.operating_nwc_to_revenue",
  ]) {
    assert.ok(DEFAULT_METRIC_DEFINITIONS.some((definition) => definition.id === id));
    assert.equal(next.lineItems.filter((row) => row.id === id).length, 1);
  }
  assert.throws(() => installDefaultMetrics(next, periods), (error: unknown) =>
    error instanceof FinancialModelError && error.code === "invalid_model_operation");
});

test("default formulas include FCF, margins, leverage, returns, per-share, and CAGRs", () => {
  const next = installDefaultMetrics(createSkeleton({ currency: "USD", periods }), periods);
  const ids = new Set(next.formulas.map((formula) => formula.lineItemId));
  for (const id of [
    "metric.free_cash_flow", "metric.gross_margin", "metric.ebitda_margin", "metric.current_ratio",
    "metric.debt_to_equity", "metric.invested_capital", "metric.roa", "metric.roe", "metric.roic",
    "metric.fcf_per_share", "metric.revenue_cagr_3p", "metric.revenue_cagr_5p",
  ]) assert.ok(ids.has(id), id);
});

test("parameterized CAGR derives every writable field and validates the registry boundary", () => {
  const base = installDefaultMetrics(createSkeleton({ currency: "USD", periods }), periods);
  const next = installRegisteredMetric(base, periods, {
    registryId: "cagr", targetLineItemId: "operating_income", lookbackPeriods: 4,
  });
  const row = next.lineItems.find((item) => item.id === "metric.cagr.operating_income.4p")!;
  assert.deepEqual(row.unit, { kind: "percent" });
  assert.equal(row.historical, "formula");
  assert.equal(row.forecast, "none");
  assert.deepEqual(next.formulas.find((formula) => formula.lineItemId === row.id), {
    lineItemId: row.id, appliesTo: "historical", periodIds: ["FY2022", "FY2023"],
    source: "CAGR(operating_income, 4)",
  });
  for (const request of [
    { registryId: "cagr" as const, targetLineItemId: "accounts_receivable", lookbackPeriods: 3 },
    { registryId: "cagr" as const, targetLineItemId: "operating_income", lookbackPeriods: 1 },
    { registryId: "cagr" as const, targetLineItemId: "operating_income", lookbackPeriods: 11 },
    { registryId: "cagr" as const, targetLineItemId: "operating_income", lookbackPeriods: 2.5 },
  ]) assert.throws(() => installRegisteredMetric(base, periods, request), FinancialModelError);
  assert.throws(
    () => installRegisteredMetric(next, periods, {
      registryId: "cagr",
      targetLineItemId: "operating_income",
      lookbackPeriods: 4,
    }),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "invalid_model_operation",
  );

  const withStream = addRevenueStream(base, { id: "services", label: "Services" });
  const streamMetric = installRegisteredMetric(withStream, periods, {
    registryId: "cagr",
    targetLineItemId: "revenue.services",
    lookbackPeriods: 3,
  });
  assert.ok(streamMetric.lineItems.some((item) => item.id === "metric.cagr.revenue.services.3p"));
});

const ENGINE_PERIODS: Period[] = [
  { id: "FY2021", label: "FY2021", start: "2021-01-01", end: "2021-12-31", cls: "actual" },
  { id: "FY2022", label: "FY2022", start: "2022-01-01", end: "2022-12-31", cls: "actual" },
  { id: "FY2023", label: "FY2023", start: "2023-01-01", end: "2023-12-31", cls: "actual" },
];

const VALUATION_CONFIG: ValuationConfig = {
  anchorPeriodId: "FY2023",
  discountConvention: "year_end",
  exitTerminalMetric: "ebitda",
  sensitivity: {
    waccDeltas: [0],
    terminalGrowthDeltas: [0],
    exitMultipleDeltas: [0],
  },
  sourceType: "user",
  sourceRefs: ["test"],
  asOfDate: "2026-08-04",
  rationale: "Metric engine integration fixture",
};

const INPUT_ROWS = new Set([
  "total_assets",
  "shareholders_equity",
  "debt",
  "cash_and_equivalents",
  "short_term_investments",
  "revenue.total",
  "nopat",
  "net_income",
]);

function metricSkeleton(): Skeleton {
  const installed = installDefaultMetrics(
    createSkeleton({ currency: "USD", periods: ENGINE_PERIODS }),
    ENGINE_PERIODS,
  );
  return {
    ...installed,
    lineItems: installed.lineItems.map((item) =>
      INPUT_ROWS.has(item.id) ? { ...item, historical: "actual" as const } : item),
  };
}

function fact(
  skeleton: Skeleton,
  lineItemId: string,
  periodId: string,
  value: number,
): ActiveFact {
  const item = skeleton.lineItems.find((candidate) => candidate.id === lineItemId);
  assert.ok(item, lineItemId);
  return {
    factId: `${lineItemId}-${periodId}`,
    status: "committed",
    lineItemId,
    periodId,
    value,
    unit: structuredClone(item.unit),
    provenance: {
      sourceType: "test",
      sourceRefs: [`${lineItemId}:${periodId}`],
      asOfDate: "2026-08-04",
    },
  };
}

function baseFacts(skeleton: Skeleton): ActiveFact[] {
  const values: Record<string, Record<string, number>> = {
    total_assets: { FY2021: 700, FY2022: 800, FY2023: 1000 },
    shareholders_equity: { FY2021: 300, FY2022: 400, FY2023: 500 },
    debt: { FY2021: 180, FY2022: 200, FY2023: 250 },
    cash_and_equivalents: { FY2021: 80, FY2022: 100, FY2023: 100 },
    short_term_investments: { FY2021: 50, FY2022: 50, FY2023: 50 },
    nopat: { FY2021: 60, FY2022: 80, FY2023: 105 },
    net_income: { FY2021: 50, FY2022: 70, FY2023: 90 },
  };
  return Object.entries(values).flatMap(([lineItemId, byPeriod]) =>
    Object.entries(byPeriod).map(([periodId, value]) =>
      fact(skeleton, lineItemId, periodId, value)));
}

function calculate(skeleton: Skeleton, facts: readonly ActiveFact[]) {
  return evaluate({
    periods: skeleton.periods,
    lineItems: skeleton.lineItems,
    facts,
    assumptions: [],
    formulas: skeleton.formulas,
    valuationConfig: VALUATION_CONFIG,
  });
}

test("ROA, ROE, and ROIC use two-period average balances through the engine", () => {
  const skeleton = metricSkeleton();
  const result = calculate(skeleton, baseFacts(skeleton));

  assert.equal(result.cells.get(cellKey("metric.roa", "FY2021"))?.value, null);
  assert.deepEqual(
    result.cells.get(cellKey("metric.roa", "FY2021"))?.diagnostics,
    [{ code: "missing_input", refs: ["total_assets@<incomplete window>"] }],
  );
  assert.equal(
    result.cells.get(cellKey("metric.roa", "FY2022"))?.value,
    quantize(70 / ((700 + 800) / 2)),
  );
  assert.equal(result.cells.get(cellKey("metric.roa", "FY2023"))?.value, 0.1);
  assert.equal(result.cells.get(cellKey("metric.roe", "FY2022"))?.value, 0.2);
  assert.equal(result.cells.get(cellKey("metric.roe", "FY2023"))?.value, 0.2);

  assert.equal(result.cells.get(cellKey("metric.invested_capital", "FY2021"))?.value, 350);
  assert.equal(result.cells.get(cellKey("metric.invested_capital", "FY2022"))?.value, 450);
  assert.equal(result.cells.get(cellKey("metric.invested_capital", "FY2023"))?.value, 600);
  assert.equal(result.cells.get(cellKey("metric.roic", "FY2022"))?.value, 0.2);
  assert.equal(result.cells.get(cellKey("metric.roic", "FY2023"))?.value, 0.2);
});

test("missing short-term investments keeps net debt and ROIC missing rather than filling zero", () => {
  const skeleton = metricSkeleton();
  const facts = baseFacts(skeleton).filter(
    (candidate) => candidate.lineItemId !== "short_term_investments",
  );
  const result = calculate(skeleton, facts);
  const netDebt = result.cells.get(cellKey("metric.net_debt", "FY2023"))!;
  const roic = result.cells.get(cellKey("metric.roic", "FY2023"))!;

  assert.equal(netDebt.value, null);
  assert.equal(netDebt.diagnostics[0]?.code, "missing_input");
  assert.ok(netDebt.diagnostics[0]?.refs.includes(cellKey("short_term_investments", "FY2023")));
  assert.equal(roic.value, null);
  assert.equal(roic.diagnostics[0]?.code, "missing_input");
  assert.ok(roic.diagnostics[0]?.refs.some((ref) => ref.startsWith("short_term_investments@")));
});

test("zero revenue and average equity produce divide-by-zero diagnostics", () => {
  const skeleton = metricSkeleton();
  const facts = baseFacts(skeleton).map((candidate) =>
    candidate.lineItemId === "shareholders_equity"
      ? { ...candidate, value: 0 }
      : candidate);
  facts.push(fact(skeleton, "revenue.total", "FY2023", 0));
  const result = calculate(skeleton, facts);

  for (const metricId of ["metric.net_margin", "metric.roe"]) {
    const cell = result.cells.get(cellKey(metricId, "FY2023"))!;
    assert.equal(cell.value, null);
    assert.deepEqual(cell.diagnostics, [
      { code: "divide_by_zero", refs: [cellKey(metricId, "FY2023")] },
    ]);
  }
});

test("changing a source fact automatically recalculates every dependent metric", () => {
  const skeleton = metricSkeleton();
  const originalFacts = baseFacts(skeleton);
  const original = calculate(skeleton, originalFacts);
  const changedFacts = originalFacts.map((candidate) =>
    candidate.lineItemId === "net_income" && candidate.periodId === "FY2023"
      ? { ...candidate, value: 180 }
      : candidate);
  const changed = calculate(skeleton, changedFacts);

  assert.equal(original.cells.get(cellKey("metric.roa", "FY2023"))?.value, 0.1);
  assert.equal(changed.cells.get(cellKey("metric.roa", "FY2023"))?.value, 0.2);
  assert.equal(original.cells.get(cellKey("metric.roe", "FY2023"))?.value, 0.2);
  assert.equal(changed.cells.get(cellKey("metric.roe", "FY2023"))?.value, 0.4);
});
