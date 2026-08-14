import assert from "node:assert/strict";
import test from "node:test";
import { cellKey, type CellKey } from "../dsl/graph.ts";
import { explainFailedIdentity, reconcileDcf, type ReconciliationResult } from "../reconciliation.ts";
import { addRevenueStream, addSourceStatementRows, createSkeleton } from "../skeleton.ts";
import type { Cell, DcfCategoryGroup, Period, Unit } from "../types.ts";

const USD: Unit = { kind: "currency", code: "USD" };
const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "TTM", label: "TTM", start: "2025-04-01", end: "2026-03-31", cls: "ttm" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
];

function cell(value: number | null): Cell {
  return { value, unit: USD, diagnostics: [] };
}

function put(cells: Map<CellKey, Cell>, periodId: string, values: Record<string, number | null>): void {
  for (const [lineItemId, value] of Object.entries(values)) {
    cells.set(cellKey(lineItemId, periodId), cell(value));
  }
}

function categoryResults(results: readonly ReconciliationResult[]) {
  return results.filter((result) => result.kind === "category");
}

function identity(
  results: readonly ReconciliationResult[],
  periodId: string,
  name: Extract<ReconciliationResult, { kind: "accounting_identity" }>["identity"],
) {
  const result = results.find((candidate) =>
    candidate.kind === "accounting_identity"
    && candidate.periodId === periodId
    && candidate.identity === name);
  assert.ok(result, `missing ${name}@${periodId}`);
  return result;
}

function disclosureSkeleton() {
  let skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  for (const id of ["products", "services", "eliminations", "us", "international", "unused"] as const) {
    skeleton = addRevenueStream(skeleton, { id, label: id });
  }
  return skeleton;
}

test("arbitrary Agent category names and simultaneous disclosure groups reconcile independently", () => {
  const skeleton = disclosureSkeleton();
  const cells = new Map<CellKey, Cell>();
  put(cells, "FY2024", {
    "revenue.total": 100,
    "revenue.products": 70,
    "revenue.services": 35,
    "revenue.eliminations": 5,
    "revenue.us": 60,
    "revenue.international": 40,
  });
  const groups: DcfCategoryGroup[] = [
    {
      parentLineItemId: "revenue.total",
      category: "产品组合（管理层口径）",
      periodIds: ["FY2024"],
      members: [
        { lineItemId: "revenue.products", treatment: "add" },
        { lineItemId: "revenue.services", treatment: "add" },
        { lineItemId: "revenue.eliminations", treatment: "subtract" },
      ],
      reviewDecisionId: "product-review",
    },
    {
      parentLineItemId: "revenue.total",
      category: "Geography disclosed by management",
      periodIds: ["FY2024"],
      members: [
        { lineItemId: "revenue.us", treatment: "add" },
        { lineItemId: "revenue.international", treatment: "add" },
      ],
      reviewDecisionId: "geography-review",
    },
  ];

  const results = categoryResults(reconcileDcf({
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    cells,
    categoryGroups: groups,
  }));
  assert.deepEqual(results.map((result) => result.category), [
    "Geography disclosed by management",
    "产品组合（管理层口径）",
  ]);
  assert.deepEqual(results.map((result) => result.status), ["passed", "passed"]);
  assert.deepEqual(results.map((result) => result.calculated), [100, 100]);
  assert.deepEqual(results.map((result) => result.reviewDecisionId), [
    "geography-review",
    "product-review",
  ]);
  assert.deepEqual(results.map((result) => result.ruleId), [
    "category:revenue.total:Geography disclosed by management",
    "category:revenue.total:产品组合（管理层口径）",
  ]);
  assert.ok(results.every((result) => result.required));
});

test("subtract signs affect the sum while excluded members neither contribute nor require data", () => {
  const skeleton = disclosureSkeleton();
  const cells = new Map<CellKey, Cell>();
  put(cells, "FY2024", {
    "revenue.total": 100,
    "revenue.products": 70,
    "revenue.services": 35,
    "revenue.eliminations": 5,
    // revenue.unused is deliberately absent.
  });
  const results = categoryResults(reconcileDcf({
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    cells,
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "signed set",
      periodIds: ["FY2024", "TTM", "FY2026"],
      members: [
        { lineItemId: "revenue.unused", treatment: "exclude" },
        { lineItemId: "revenue.eliminations", treatment: "subtract" },
        { lineItemId: "revenue.services", treatment: "add" },
        { lineItemId: "revenue.products", treatment: "add" },
      ],
      reviewDecisionId: "signed-review",
    }],
  }));
  assert.equal(results.length, 1, "only actual covered periods produce results");
  assert.equal(results[0]?.status, "passed");
  assert.equal(results[0]?.calculated, 100);
  assert.equal(results[0]?.refs.includes(cellKey("revenue.unused", "FY2024")), false);
});

test("missing required cells yield insufficient_data and never synthesize zero", () => {
  const skeleton = disclosureSkeleton();
  const cells = new Map<CellKey, Cell>();
  put(cells, "FY2024", { "revenue.total": 100, "revenue.products": 70 });
  put(cells, "FY2025", { "revenue.products": 70, "revenue.services": 30 });
  const group: DcfCategoryGroup = {
    parentLineItemId: "revenue.total",
    category: "required data",
    periodIds: ["FY2024", "FY2025"],
    members: [
      { lineItemId: "revenue.products", treatment: "add" },
      { lineItemId: "revenue.services", treatment: "add" },
    ],
    reviewDecisionId: "missing-review",
  };
  const results = categoryResults(reconcileDcf({
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    cells,
    categoryGroups: [group],
  }));
  assert.deepEqual(results.map((result) => ({
    periodId: result.periodId,
    status: result.status,
    actual: result.actual,
    calculated: result.calculated,
    residual: result.residual,
  })), [
    { periodId: "FY2024", status: "insufficient_data", actual: 100, calculated: null, residual: null },
    { periodId: "FY2025", status: "insufficient_data", actual: null, calculated: null, residual: null },
  ]);
});

test("material residuals fail while floating-point noise passes the documented tolerance", () => {
  const skeleton = disclosureSkeleton();
  const cells = new Map<CellKey, Cell>();
  put(cells, "FY2024", { "revenue.total": 100, "revenue.products": 99 });
  put(cells, "FY2025", { "revenue.total": 100.00000005, "revenue.products": 100 });
  const results = categoryResults(reconcileDcf({
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    cells,
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "tolerance",
      periodIds: ["FY2024", "FY2025"],
      members: [{ lineItemId: "revenue.products", treatment: "add" }],
      reviewDecisionId: "tolerance-review",
    }],
  }));
  assert.deepEqual(results.map((result) => result.status), ["failed", "passed"]);
  assert.equal(results[0]?.residual, 1);
  assert.equal(results[0]?.difference, 1);
  assert.equal(results[0]?.tolerance, 0.000001);
  assert.ok(Math.abs(results[1]?.residual ?? 1) < (results[1]?.tolerance ?? 0));
});

test("all built-in DCF accounting identities reconcile over actual periods", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  const cells = new Map<CellKey, Cell>();
  put(cells, "FY2024", {
    "revenue.total": 1000,
    cost_of_revenue: 600,
    gross_profit: 400,
    research_and_development: 50,
    selling_and_marketing: 60,
    general_and_administrative: 40,
    other_operating_expenses: 10,
    operating_expenses: 160,
    operating_income: 240,
    tax_rate: 0.2,
    depreciation_amortization: 30,
    ebitda: 270,
    interest_income: 5,
    interest_expense: 15,
    non_operating_income_expense: -10,
    pretax_income: 220,
    income_tax_expense: 44,
    net_income: 176,
    accounts_receivable: 100,
    inventory: 50,
    other_operating_current_assets: 20,
    accounts_payable: 60,
    deferred_revenue: 20,
    accrued_operating_liabilities: 10,
    other_operating_current_liabilities: 5,
    operating_working_capital: 75,
    change_nwc: 8,
    nopat: 192,
    capital_expenditures: 40,
    fcff: 174,
  });
  put(cells, "FY2025", {
    "revenue.total": 1100,
    cost_of_revenue: 650,
    gross_profit: 450,
    research_and_development: 55,
    selling_and_marketing: 65,
    general_and_administrative: 45,
    other_operating_expenses: 10,
    operating_expenses: 175,
    operating_income: 275,
    tax_rate: 0.2,
    depreciation_amortization: 35,
    ebitda: 310,
    interest_income: 6,
    interest_expense: 16,
    non_operating_income_expense: -5,
    pretax_income: 260,
    income_tax_expense: 52,
    net_income: 208,
    accounts_receivable: 110,
    inventory: 55,
    other_operating_current_assets: 25,
    accounts_payable: 65,
    deferred_revenue: 22,
    accrued_operating_liabilities: 12,
    other_operating_current_liabilities: 6,
    operating_working_capital: 85,
    change_nwc: 10,
    nopat: 220,
    capital_expenditures: 50,
    fcff: 195,
  });

  const results = reconcileDcf({
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    cells,
    categoryGroups: [],
  });
  const firstActual = results.filter((result) => result.periodId === "FY2024");
  const secondActual = results.filter((result) => result.periodId === "FY2025");
  assert.deepEqual(firstActual.map((result) => result.kind === "accounting_identity" && result.identity), [
    "gross_profit",
    "operating_expenses_detail",
    "operating_income",
    "ebitda",
    "pretax_income",
    "net_income",
    "nopat",
    "operating_working_capital",
    "change_nwc",
    "fcff",
  ]);
  assert.deepEqual(firstActual.map((result) => result.status), [
    "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "not_applicable", "passed",
  ]);
  assert.ok(secondActual.every((result) => result.status === "passed"));
  assert.ok(secondActual.every((result) => result.required));
  assert.equal(identity(results, "FY2025", "fcff").ruleId, "accounting_identity:fcff");
  assert.equal(identity(results, "FY2025", "change_nwc").calculated, 10);
  assert.deepEqual(identity(results, "FY2025", "change_nwc").refs, [
    cellKey("change_nwc", "FY2025"),
    cellKey("operating_working_capital", "FY2025"),
    cellKey("operating_working_capital", "FY2024"),
  ]);
});

test("built-in failures and missing inputs are reported independently", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  const cells = new Map<CellKey, Cell>();
  put(cells, "FY2025", {
    pretax_income: 260,
    income_tax_expense: 52,
    net_income: 207,
    operating_income: 275,
    interest_income: 6,
    non_operating_income_expense: -5,
    // interest_expense is deliberately missing.
  });
  const results = reconcileDcf({
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    cells,
    categoryGroups: [],
  });
  assert.equal(identity(results, "FY2025", "pretax_income").status, "insufficient_data");
  assert.equal(identity(results, "FY2025", "pretax_income").calculated, null);
  assert.equal(identity(results, "FY2025", "net_income").status, "failed");
  assert.equal(identity(results, "FY2025", "net_income").residual, -1);
});

test("source-statement rows are never accepted as reconciliation members", () => {
  const base = createSkeleton({ currency: "USD", periods: PERIODS });
  const skeleton = addSourceStatementRows(base, [{
    sourceLineItemId: "source.income_statement.sales",
    statement: "income_statement",
    label: "Sales",
    unit: USD,
    order: 1,
  }]);
  const cells = new Map<CellKey, Cell>();
  put(cells, "FY2024", {
    "revenue.total": 100,
    "source.income_statement.sales": 100,
  });
  const result = categoryResults(reconcileDcf({
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    cells,
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "raw source is not DCF",
      periodIds: ["FY2024"],
      members: [{ lineItemId: "source.income_statement.sales", treatment: "add" }],
      reviewDecisionId: "source-review",
    }],
  }))[0];
  assert.equal(result?.status, "not_applicable");
  assert.equal(result?.calculated, null);
});

test("result order is authoritative period then stable category and rule order", () => {
  const skeleton = disclosureSkeleton();
  const groups: DcfCategoryGroup[] = [
    {
      parentLineItemId: "revenue.total",
      category: "zeta",
      periodIds: ["FY2025", "FY2024"],
      members: [{ lineItemId: "revenue.products", treatment: "add" }],
      reviewDecisionId: "z",
    },
    {
      parentLineItemId: "revenue.total",
      category: "alpha",
      periodIds: ["FY2024", "FY2025"],
      members: [{ lineItemId: "revenue.services", treatment: "add" }],
      reviewDecisionId: "a",
    },
  ];
  const first = reconcileDcf({ periods: PERIODS, lineItems: skeleton.lineItems, cells: new Map(), categoryGroups: groups });
  const second = reconcileDcf({ periods: PERIODS, lineItems: [...skeleton.lineItems].reverse(), cells: new Map(), categoryGroups: [...groups].reverse() });
  const key = (result: ReconciliationResult) => result.kind === "category"
    ? `${result.periodId}:category:${result.category}`
    : `${result.periodId}:identity:${result.identity}`;
  assert.deepEqual(first.map(key), second.map(key));
  assert.deepEqual(first.slice(0, 3).map(key), [
    "FY2024:category:alpha",
    "FY2024:category:zeta",
    "FY2024:identity:gross_profit",
  ]);
  assert.equal(first[12]?.periodId, "FY2025");
});

/**
 * A failed identity says the parent and the sum disagree, and nothing about which component is
 * wrong — so an agent goes reading the workbook to find out, which is where an AMZN run spent ten
 * consecutive steps and never got there. The whole diagnosis is already available at read time: a
 * component carrying the wrong polarity moves the sum by exactly twice its own value, so the
 * residual names it.
 */
test("a failed identity names the component whose sign would explain the residual", () => {
  const children = [
    { lineItemId: "operating_expenses.fulfillment", value: 75_111_000_000 },
    { lineItemId: "operating_expenses.marketing", value: 32_551_000_000 },
    // Stored income-positive from XBRL while its siblings are expense-positive: the whole defect.
    { lineItemId: "operating_expenses.other_operating_expense_income_net", value: -62_000_000 },
  ];

  const explained = explainFailedIdentity({ residual: -124_000_000, tolerance: 25 }, children);

  assert.deepEqual(explained.polaritySuspects, ["operating_expenses.other_operating_expense_income_net"]);
  assert.equal(explained.components.length, 3, "and every component's value ships, suspect or not");
});

test("a residual that matches no component's sign flip accuses nobody", () => {
  const children = [
    { lineItemId: "operating_expenses.fulfillment", value: 75_111_000_000 },
    { lineItemId: "operating_expenses.marketing", value: 32_551_000_000 },
  ];

  const explained = explainFailedIdentity({ residual: -124_000_000, tolerance: 25 }, children);

  assert.deepEqual(explained.polaritySuspects, [],
    "a wrong guess sends the agent chasing a component that is fine");
});

test("two components that would each explain the residual are both named", () => {
  const children = [
    { lineItemId: "a", value: -62_000_000 },
    { lineItemId: "b", value: -62_000_000 },
  ];

  const explained = explainFailedIdentity({ residual: -124_000_000, tolerance: 25 }, children);

  assert.deepEqual(explained.polaritySuspects, ["a", "b"], "ambiguity is reported, not resolved");
});
