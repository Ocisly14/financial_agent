import { test } from "node:test";
import assert from "node:assert/strict";
import { FinancialModelError } from "../errors.ts";
import {
  addDcfDetailLineItem,
  addRevenueStream,
  addSourceStatementRows,
  applyDcfCategoryGroups,
  applyStatementMappingPlans,
  createSkeleton,
  validateRoleCardinality,
  type Skeleton,
} from "../skeleton.ts";
import type { Period, Unit } from "../types.ts";

const USD: Unit = { kind: "currency", code: "USD" };
const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
  { id: "FY2027", label: "FY2027", start: "2027-01-01", end: "2027-12-31", cls: "forecast" },
  { id: "FY2028", label: "FY2028", start: "2028-01-01", end: "2028-12-31", cls: "forecast" },
  { id: "FY2029", label: "FY2029", start: "2029-01-01", end: "2029-12-31", cls: "forecast" },
  { id: "FY2030", label: "FY2030", start: "2030-01-01", end: "2030-12-31", cls: "forecast" },
];
const ACTUAL_PERIOD_IDS = PERIODS.filter((period) => period.cls === "actual").map((period) => period.id);
const FORECAST_PERIOD_IDS = PERIODS.filter((period) => period.cls === "forecast").map((period) => period.id);

function byId(skeleton: Skeleton, id: string) {
  const item = skeleton.lineItems.find((candidate) => candidate.id === id);
  assert.ok(item, `missing line item ${id}`);
  return item;
}

function assertFormula(
  skeleton: Skeleton,
  lineItemId: string,
  appliesTo: "historical" | "forecast",
  source: string,
  periodIds?: readonly string[],
): void {
  const formula = skeleton.formulas.find((candidate) =>
    candidate.lineItemId === lineItemId
    && candidate.appliesTo === appliesTo
    && candidate.source === source
    && (periodIds === undefined || JSON.stringify(candidate.periodIds) === JSON.stringify(periodIds)));
  assert.ok(formula, `missing ${appliesTo} formula for ${lineItemId}: ${source}`);
}

function invalidFormula(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) =>
    error instanceof FinancialModelError && error.code === "invalid_formula");
}

function withDisclosures(): Skeleton {
  let skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  for (const [id, label] of [
    ["products", "Products"],
    ["services", "Services"],
    ["eliminations", "Eliminations"],
    ["geography_us", "United States geography disclosure"],
  ] as const) {
    skeleton = addRevenueStream(skeleton, { id, label });
  }
  return skeleton;
}

test("creates every fixed role exactly once and repeated roles only where allowed", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  validateRoleCardinality(skeleton.lineItems);
  for (const role of [
    "revenue_root", "revenue_total", "operating_income", "tax_rate", "nopat",
    "depreciation_amortization", "ebitda", "capex", "operating_working_capital",
    "change_nwc", "fcff", "wacc", "terminal_growth", "exit_multiple",
    "cash_available_for_bridge", "non_operating_investments", "debt",
    "lease_liabilities", "preferred_equity", "non_controlling_interests",
    "diluted_shares",
  ] as const) {
    assert.equal(skeleton.lineItems.filter((item) => item.role === role).length, 1, role);
  }
  assert.equal(skeleton.lineItems.some((item) => (item.role as string) === "terminal_metric"), false);
});

test("creates all canonical mapping targets with their documented units", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  for (const id of [
    "cost_of_revenue", "gross_profit", "research_and_development", "operating_expenses",
    "cash_and_equivalents", "accounts_receivable", "accounts_payable", "total_assets",
    "operating_cash_flow", "reported_change_operating_assets_liabilities", "share_repurchases",
  ]) {
    assert.equal(byId(skeleton, id).role, "none");
    // "actual": history rows receive mapped filing facts, and the cells must surface them.
    assert.equal(byId(skeleton, id).historical, "actual");
  }
  assert.deepEqual(byId(skeleton, "diluted_eps").unit, { kind: "per_share", code: "USD" });
  assert.deepEqual(byId(skeleton, "diluted_shares").unit, { kind: "shares" });
});

test("uses the documented DCF formulas and positive-outflow sign convention", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  assertFormula(skeleton, "growth.revenue.total", "historical", "YOY(revenue.total)", ACTUAL_PERIOD_IDS);
  assertFormula(skeleton, "revenue.total", "forecast",
    "LAG(revenue.total, 1) * (1 + growth.revenue.total)", FORECAST_PERIOD_IDS);
  assertFormula(skeleton, "nopat", "forecast", "operating_income * (1 - tax_rate)");
  assertFormula(skeleton, "ebitda", "forecast", "operating_income + depreciation_amortization");
  assertFormula(skeleton, "change_nwc", "forecast",
    "operating_working_capital - LAG(operating_working_capital, 1)");
  assertFormula(skeleton, "fcff", "forecast",
    "nopat + depreciation_amortization - capital_expenditures - change_nwc");
});

test("keeps raw cash separate from bridge-available cash", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  assert.equal(byId(skeleton, "cash_and_equivalents").role, "none");
  assert.equal(byId(skeleton, "cash_available_for_bridge").role, "cash_available_for_bridge");
  assert.equal(byId(skeleton, "cash_available_for_bridge").historical, "actual");
});

test("adds prepared statement rows in reserved hidden sections without mutating the base", () => {
  const base = createSkeleton({ currency: "USD", periods: PERIODS });
  const next = addSourceStatementRows(base, [
    { sourceLineItemId: "source.balance_sheet.inventory", label: "Inventories", statement: "balance_sheet", unit: USD, order: 2 },
    { sourceLineItemId: "source.income_statement.sales", label: "Net sales", statement: "income_statement", unit: USD, order: 1 },
  ]);
  assert.equal(base.lineItems.some((item) => item.id.startsWith("source.")), false);
  assert.equal(byId(next, "source.income_statement.sales").section, "source_income_statement");
  assert.equal(byId(next, "source.balance_sheet.inventory").section, "source_balance_sheet");
  assert.equal(byId(next, "source.balance_sheet.inventory").historical, "actual");
  assert.equal(byId(next, "source.balance_sheet.inventory").forecast, "none");
  invalidFormula(() => addSourceStatementRows(base, [{
    sourceLineItemId: "source.balance_sheet.bad",
    label: "Wrong statement",
    statement: "income_statement",
    unit: USD,
    order: 1,
  }]));
});

test("adding a revenue stream creates its value and growth rows atomically", () => {
  const base = createSkeleton({ currency: "USD", periods: PERIODS });
  const next = addRevenueStream(base, { id: "services", label: "Services" });
  assert.equal(base.lineItems.some((item) => item.id === "revenue.services"), false);
  assert.equal(byId(next, "revenue.services").role, "revenue_stream");
  assert.equal(byId(next, "growth.revenue.services").historical, "formula");
  assert.equal(byId(next, "growth.revenue.services").forecast, "assumption");
  assertFormula(next, "growth.revenue.services", "historical",
    "YOY(revenue.services)", ACTUAL_PERIOD_IDS);
  assertFormula(next, "revenue.services", "forecast",
    "LAG(revenue.services, 1) * (1 + growth.revenue.services)", FORECAST_PERIOD_IDS);
  invalidFormula(() => addRevenueStream(next, { id: "services", label: "Duplicate" }));
  invalidFormula(() => addRevenueStream(base, { id: "Not-Semantic", label: "Bad" }));
});

test("a reviewed statement plan maps several source categories into one canonical DCF row", () => {
  const withSources = addSourceStatementRows(createSkeleton({ currency: "USD", periods: PERIODS }), [
    { sourceLineItemId: "source.income_statement.r_and_d", label: "Research and development", statement: "income_statement", unit: USD, order: 1 },
    { sourceLineItemId: "source.income_statement.sga", label: "Selling, general and administrative", statement: "income_statement", unit: USD, order: 2 },
  ]);
  const mapped = applyStatementMappingPlans(withSources, [{
    targetLineItemId: "operating_expenses",
    periodIds: ["FY2024", "FY2025"],
    members: [
      { sourceLineItemId: "source.income_statement.r_and_d", treatment: "add" },
      { sourceLineItemId: "source.income_statement.sga", treatment: "add" },
    ],
    reviewDecisionId: "review-map-1",
  }]);
  assertFormula(mapped, "operating_expenses", "historical",
    "source.income_statement.r_and_d + source.income_statement.sga", ["FY2024", "FY2025"]);
  assert.equal(byId(mapped, "operating_expenses").historical, "formula");
});

test("rejects duplicate fixed roles", () => {
  const disclosures = withDisclosures();
  const duplicateRole = {
    ...disclosures.lineItems[0]!,
    id: "duplicate_fcff",
    role: "fcff" as const,
  };
  invalidFormula(() => validateRoleCardinality([...disclosures.lineItems, duplicateRole]));
});

test("adds historical DCF detail rows under safe aggregate parents", () => {
  const base = createSkeleton({ currency: "USD", periods: PERIODS });
  const next = addDcfDetailLineItem(base, {
    parentLineItemId: "operating_expenses",
    id: "cloud_infrastructure",
    label: "Cloud infrastructure",
  });
  const detail = byId(next, "operating_expenses.cloud_infrastructure");
  assert.equal(detail.parentId, "operating_expenses");
  assert.equal(detail.role, "none");
  assert.deepEqual(detail.unit, byId(next, "operating_expenses").unit);
  assert.equal(detail.section, byId(next, "operating_expenses").section);
  assert.equal(detail.historical, "actual");
  assert.equal(detail.forecast, "none");
  assert.equal(base.lineItems.some((item) => item.id === detail.id), false);
  invalidFormula(() => addDcfDetailLineItem(base, {
    parentLineItemId: "fcff",
    id: "unsafe",
    label: "Unsafe",
  }));
});

test("arbitrary Chinese and English category groups may overlap historical periods independently", () => {
  const disclosures = withDisclosures();
  const grouped = applyDcfCategoryGroups(disclosures, [
    {
      parentLineItemId: "revenue.total", category: "产品类别", periodIds: ["FY2024", "FY2025"],
      members: [
        { lineItemId: "revenue.products", treatment: "add" },
        { lineItemId: "revenue.services", treatment: "add" },
      ],
      reviewDecisionId: "category-product",
    },
    {
      parentLineItemId: "revenue.total", category: "geography", periodIds: ["FY2024", "FY2025"],
      members: [{ lineItemId: "revenue.geography_us", treatment: "add" }],
      reviewDecisionId: "category-geography",
    },
  ]);
  assertFormula(grouped, "revenue.total", "forecast",
    "LAG(revenue.total, 1) * (1 + growth.revenue.total)", FORECAST_PERIOD_IDS);
});

test("a forecast category group compiles a signed parent formula for only its periods", () => {
  const grouped = applyDcfCategoryGroups(withDisclosures(), [{
    parentLineItemId: "revenue.total", category: "product", periodIds: ["FY2026", "FY2027"],
    members: [
      { lineItemId: "revenue.services", treatment: "add" },
      { lineItemId: "revenue.products", treatment: "add" },
      { lineItemId: "revenue.eliminations", treatment: "subtract" },
      { lineItemId: "revenue.geography_us", treatment: "exclude" },
    ],
    reviewDecisionId: "forecast-product",
  }]);
  assertFormula(grouped, "revenue.total", "forecast",
    "revenue.products + revenue.services - revenue.eliminations", ["FY2026", "FY2027"]);
  assertFormula(grouped, "revenue.total", "forecast",
    "LAG(revenue.total, 1) * (1 + growth.revenue.total)", ["FY2028", "FY2029", "FY2030"]);
});

test("forecast category ambiguity, source rows, incompatible units, duplicates, and empty groups are rejected", () => {
  const disclosures = withDisclosures();
  invalidFormula(() => applyDcfCategoryGroups(disclosures, [
    {
      parentLineItemId: "revenue.total", category: "product", periodIds: ["FY2026"],
      members: [{ lineItemId: "revenue.products", treatment: "add" }], reviewDecisionId: "one",
    },
    {
      parentLineItemId: "revenue.total", category: "geography", periodIds: ["FY2026"],
      members: [{ lineItemId: "revenue.geography_us", treatment: "add" }], reviewDecisionId: "two",
    },
  ]));

  const withSource = addSourceStatementRows(disclosures, [{
    sourceLineItemId: "source.income_statement.sales", statement: "income_statement",
    label: "Sales", unit: USD, order: 1,
  }]);
  invalidFormula(() => applyDcfCategoryGroups(withSource, [{
    parentLineItemId: "revenue.total", category: "source", periodIds: ["FY2024"],
    members: [{ lineItemId: "source.income_statement.sales", treatment: "add" }],
    reviewDecisionId: "source-member",
  }]));
  invalidFormula(() => applyDcfCategoryGroups(disclosures, [{
    parentLineItemId: "revenue.total", category: "units", periodIds: ["FY2024"],
    members: [{ lineItemId: "diluted_eps", treatment: "add" }], reviewDecisionId: "units",
  }]));
  invalidFormula(() => applyDcfCategoryGroups(disclosures, [{
    parentLineItemId: "revenue.total", category: "duplicate", periodIds: ["FY2024"],
    members: [
      { lineItemId: "revenue.products", treatment: "add" },
      { lineItemId: "revenue.products", treatment: "exclude" },
    ], reviewDecisionId: "duplicate",
  }]));
  invalidFormula(() => applyDcfCategoryGroups(disclosures, [{
    parentLineItemId: "revenue.total", category: "empty", periodIds: ["FY2024"],
    members: [{ lineItemId: "revenue.products", treatment: "exclude" }], reviewDecisionId: "empty",
  }]));
});

test("statement mappings may target Agent-created DCF detail rows", () => {
  let skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  skeleton = addDcfDetailLineItem(skeleton, {
    parentLineItemId: "cost_of_revenue",
    id: "hosting",
    label: "Hosting costs",
  });
  skeleton = addSourceStatementRows(skeleton, [{
    sourceLineItemId: "source.income_statement.hosting", statement: "income_statement",
    label: "Hosting", unit: USD, order: 1,
  }]);
  const mapped = applyStatementMappingPlans(skeleton, [{
    targetLineItemId: "cost_of_revenue.hosting", periodIds: ["FY2024", "FY2025"],
    members: [{ sourceLineItemId: "source.income_statement.hosting", treatment: "add" }],
    reviewDecisionId: "map-hosting",
  }]);
  assertFormula(mapped, "cost_of_revenue.hosting", "historical",
    "source.income_statement.hosting", ["FY2024", "FY2025"]);
});

test("statement mappings may target Agent-created revenue stream value rows", () => {
  let skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  skeleton = addRevenueStream(skeleton, { id: "services", label: "Services" });
  skeleton = addSourceStatementRows(skeleton, [{
    sourceLineItemId: "source.income_statement.services", statement: "income_statement",
    label: "Services revenue", unit: USD, order: 1,
  }]);
  const mapped = applyStatementMappingPlans(skeleton, [{
    targetLineItemId: "revenue.services", periodIds: ["FY2024", "FY2025"],
    members: [{ sourceLineItemId: "source.income_statement.services", treatment: "add" }],
    reviewDecisionId: "map-services",
  }]);
  assertFormula(mapped, "revenue.services", "historical",
    "source.income_statement.services", ["FY2024", "FY2025"]);
});
