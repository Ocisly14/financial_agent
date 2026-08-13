import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_VERSION } from "../engine.ts";
import { FinancialModelError } from "../errors.ts";
import { applyModelOperations, type FinancialModelSnapshot, type ModelOperation } from "../operations.ts";
import { addRevenueStream, addSourceStatementRows, createSkeleton } from "../skeleton.ts";
import type { Assumption, Fact, FactReviewDecision, Period, ValuationConfig } from "../types.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
  { id: "FY2027", label: "FY2027", start: "2027-01-01", end: "2027-12-31", cls: "forecast" },
];

const CONFIG: ValuationConfig = {
  anchorPeriodId: "FY2025",
  discountConvention: "year_end",
  exitTerminalMetric: "ebitda",
  sensitivity: { waccDeltas: [-0.01, 0, 0.01], terminalGrowthDeltas: [-0.005, 0, 0.005], exitMultipleDeltas: [-1, 0, 1] },
  sourceType: "user",
  sourceRefs: ["input"],
  asOfDate: "2026-08-04",
  rationale: "Test configuration",
};

function snapshot(options: { sources?: boolean; disclosures?: boolean } = {}): FinancialModelSnapshot {
  let skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  if (options.sources) {
    skeleton = addSourceStatementRows(skeleton, [
      { sourceLineItemId: "source.income_statement.revenue", statement: "income_statement", label: "Revenue", unit: { kind: "currency", code: "USD" }, order: 1 },
      { sourceLineItemId: "source.income_statement.costs", statement: "income_statement", label: "Costs", unit: { kind: "currency", code: "USD" }, order: 2 },
    ]);
  }
  if (options.disclosures) {
    skeleton = addRevenueStream(skeleton, { id: "products", label: "Products" });
    skeleton = addRevenueStream(skeleton, { id: "services", label: "Services" });
  }
  return {
    lifecycleStage: "draft",
    periods: structuredClone(PERIODS),
    lineItems: skeleton.lineItems,
    facts: [],
    factReviewDecisions: [],
    assumptions: [],
    formulas: skeleton.formulas,
    compiledFormulas: [],
    selectedHistoricalPeriodIds: [],
    categoryGroups: [],
    valuationConfig: structuredClone(CONFIG),
    cells: new Map(),
    diagnostics: [],
    reconciliationResults: [],
    valuation: null,
    waccSheet: null,
    engineVersion: ENGINE_VERSION,
  };
}

function assumption(id: string, lineItemId: string, periods: string[], values: number[]): Assumption {
  return {
    assumptionId: id,
    lineItemId,
    periods,
    payload: { kind: "values", values, unit: { kind: "percent" } },
    sourceType: "user",
    sourceRefs: ["test"],
    asOfDate: "2026-08-04",
    rationale: "Test assumption",
  };
}

function invalid(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) =>
    error instanceof FinancialModelError && error.code === "invalid_model_operation");
}

test("an empty mutation batch is rejected", () => {
  invalid(() => applyModelOperations(snapshot(), []));
});

test("several assumptions apply atomically to one cloned working copy", () => {
  const base = snapshot();
  const next = applyModelOperations(base, [
    { kind: "set_assumption", assumption: assumption("margin", "margin.operating", ["FY2026", "FY2027"], [0.1, 0.09]) },
    { kind: "set_assumption", assumption: assumption("growth", "terminal_growth", ["FY2027"], [0.03]) },
  ]);
  assert.equal(base.assumptions.length, 0);
  assert.deepEqual(next.assumptions.map((entry) => entry.assumptionId), ["margin", "growth"]);
});

test("a failed later operation leaves the input snapshot unchanged", () => {
  const base = snapshot();
  const before = structuredClone(base);
  invalid(() => applyModelOperations(base, [
    { kind: "set_assumption", assumption: assumption("margin", "margin.operating", ["FY2026"], [0.1]) },
    { kind: "add_line_item", lineItem: { parentId: "revenue", id: "Bad-Slug", label: "Bad" } },
  ]));
  assert.deepEqual(base, before);
});

test("set_assumption replaces only its explicit cells and preserves remaining path values", () => {
  let current = applyModelOperations(snapshot(), [{
    kind: "set_assumption",
    assumption: assumption("path", "margin.operating", ["FY2026", "FY2027"], [0.1, 0.09]),
  }]);
  current = applyModelOperations(current, [{
    kind: "set_assumption",
    assumption: assumption("replacement", "margin.operating", ["FY2027"], [0.08]),
  }]);
  assert.deepEqual(current.assumptions.map((entry) => [entry.assumptionId, entry.periods, entry.payload]), [
    ["path", ["FY2026"], { kind: "values", values: [0.1], unit: { kind: "percent" } }],
    ["replacement", ["FY2027"], { kind: "values", values: [0.08], unit: { kind: "percent" } }],
  ]);
});

test("source switching clears only that range and can be repopulated later in the batch", () => {
  const next = applyModelOperations(snapshot(), [
    { kind: "set_line_item_source", lineItemId: "operating_income", range: "forecast", source: "assumption" },
    {
      kind: "set_assumption",
      assumption: {
        ...assumption("oi", "operating_income", ["FY2026", "FY2027"], [100, 110]),
        payload: { kind: "values", values: [100, 110], unit: { kind: "currency", code: "USD" } },
      },
    },
  ]);
  assert.equal(next.lineItems.find((item) => item.id === "operating_income")?.forecast, "assumption");
  assert.equal(next.formulas.some((formula) => formula.lineItemId === "operating_income" && formula.appliesTo === "forecast"), false);
  assert.equal(next.assumptions.at(-1)?.assumptionId, "oi");
});

test("source switching rejects engine-native definitions", () => {
  const base = snapshot();
  const fcff = base.lineItems.find((item) => item.id === "fcff")!;
  fcff.forecast = "calculated";
  invalid(() => applyModelOperations(base, [{
    kind: "set_line_item_source", lineItemId: "fcff", range: "forecast", source: "formula",
  }]));
});

test("set_formula replaces explicit coverage without disturbing other periods", () => {
  const next = applyModelOperations(snapshot(), [{
    kind: "set_formula",
    formula: { lineItemId: "operating_income", appliesTo: "forecast", periodIds: ["FY2026"], source: "revenue.total * 0.2" },
  }]);
  assert.equal(next.formulas.some((formula) => formula.lineItemId === "operating_income"
    && formula.source === "revenue.total * 0.2"
    && JSON.stringify(formula.periodIds) === JSON.stringify(["FY2026"])), true);
  assert.equal(next.formulas.some((formula) => formula.lineItemId === "operating_income"
    && JSON.stringify(formula.periodIds) === JSON.stringify(["FY2027"])), false);
});

test("replace_fact retains predecessor, replacement, and paired decisions", () => {
  const base = snapshot({ sources: true });
  const predecessor: Fact = {
    factId: "old", status: "committed", lineItemId: "source.income_statement.revenue",
    periodId: "FY2025", value: 100, unit: { kind: "currency", code: "USD" },
    provenance: { sourceType: "filing", sourceRefs: ["old"], asOfDate: "2025-12-31" },
  };
  base.facts.push(predecessor);
  const replacement: Fact = {
    factId: "new", status: "staged", periodId: "FY2025", value: 105,
    unit: { kind: "currency", code: "USD" }, supersedesFactId: "old",
    provenance: { sourceType: "filing", sourceRefs: ["new"], asOfDate: "2026-01-31" },
  };
  const audit = (decisionId: string): Omit<FactReviewDecision, "action" | "factId"> => ({
    decisionId, rationale: "Restatement", reviewedBy: "agent", reviewedAt: "2026-08-04T00:00:00Z",
  });
  const next = applyModelOperations(base, [{
    kind: "replace_fact",
    replacement,
    commitDecision: { ...audit("commit"), factId: "new", action: "commit", mappedLineItemId: "source.income_statement.revenue" },
    supersedeDecision: { ...audit("supersede"), factId: "old", action: "supersede", replacementFactId: "new" },
  }]);
  assert.deepEqual(next.facts.map((fact) => [fact.factId, fact.status]), [["old", "superseded"], ["new", "committed"]]);
  assert.deepEqual(next.factReviewDecisions.map((decision) => decision.decisionId), ["commit", "supersede"]);
});

test("add_line_item creates a revenue row and companion driver atomically", () => {
  const next = applyModelOperations(snapshot(), [{
    kind: "add_line_item", lineItem: { parentId: "revenue", id: "services", label: "Services" },
  }]);
  assert.equal(next.lineItems.some((item) => item.id === "revenue.services" && item.role === "revenue_stream"), true);
  assert.equal(next.lineItems.some((item) => item.id === "growth.revenue.services"), true);
  assert.equal(next.formulas.some((formula) => formula.lineItemId === "revenue.services"), false);
});

test("a committed revenue stream can own its gross-profit detail", () => {
  const base = snapshot({ disclosures: true });
  const next = applyModelOperations(base, [{
    kind: "add_line_item",
    lineItem: { parentId: "revenue.products", id: "gross_profit", label: "Products gross profit" },
  } as unknown as ModelOperation]);

  const detail = next.lineItems.find((item) => item.id === "revenue.products.gross_profit");
  assert.equal(detail?.parentId, "revenue.products");
  assert.deepEqual(detail?.unit, { kind: "currency", code: "USD" });
});

test("an archived snapshot is immutable and advance_stage is no longer an operation", () => {
  const archived = snapshot();
  archived.lifecycleStage = "archived";
  invalid(() => applyModelOperations(archived, [{ kind: "set_valuation_config", config: archived.valuationConfig }]));
  // Lifecycle is derived by the engine now; the old advance_stage op no longer exists.
  const advance = { kind: "advance_stage", stage: "valued" } as unknown as ModelOperation;
  invalid(() => applyModelOperations(snapshot(), [advance]));
});

test("operation batch shape has no generic patch variant", () => {
  const operation = { kind: "patch", path: "lineItems[0].role", value: "fcff" } as unknown as ModelOperation;
  invalid(() => applyModelOperations(snapshot(), [operation]));
});

test("set_category_group persists arbitrary Chinese and English historical views independently", () => {
  const base = snapshot({ disclosures: true });
  const next = applyModelOperations(base, [
    {
      kind: "set_category_group",
      group: {
        parentLineItemId: "revenue.total", category: "产品类别", periodIds: ["FY2025", "FY2024"],
        members: [{ lineItemId: "revenue.products", treatment: "add" }],
        reviewDecisionId: "产品复核",
      },
    },
    {
      kind: "set_category_group",
      group: {
        parentLineItemId: "revenue.total", category: "geography", periodIds: ["FY2024", "FY2025"],
        members: [{ lineItemId: "revenue.services", treatment: "add" }],
        reviewDecisionId: "geography-review",
      },
    },
  ]);
  assert.deepEqual(next.categoryGroups.map((group) => [group.category, group.periodIds]), [
    ["geography", ["FY2024", "FY2025"]],
    ["产品类别", ["FY2024", "FY2025"]],
  ]);
  assert.equal(base.categoryGroups.length, 0);
});

test("set_category_group compiles forecast arithmetic and rejects a second category owner", () => {
  const base = snapshot({ disclosures: true });
  const product: ModelOperation = {
    kind: "set_category_group",
    group: {
      parentLineItemId: "revenue.total", category: "product", periodIds: ["FY2026"],
      members: [
        { lineItemId: "revenue.products", treatment: "add" },
        { lineItemId: "revenue.services", treatment: "subtract" },
      ],
      reviewDecisionId: "product-review",
    },
  };
  const next = applyModelOperations(base, [product]);
  assert.equal(next.formulas.some((formula) => formula.lineItemId === "revenue.total"
    && formula.source === "revenue.products - revenue.services"
    && JSON.stringify(formula.periodIds) === JSON.stringify(["FY2026"])), true);
  assert.throws(() => applyModelOperations(next, [{
    kind: "set_category_group",
    group: {
      parentLineItemId: "revenue.total", category: "geography", periodIds: ["FY2026"],
      members: [{ lineItemId: "revenue.services", treatment: "add" }],
      reviewDecisionId: "geography-review",
    },
  }]), FinancialModelError);
});

test("category group exact coverage is replaceable but same-category partial overlap is rejected", () => {
  const base = snapshot({ disclosures: true });
  const first = applyModelOperations(base, [{
    kind: "set_category_group",
    group: {
      parentLineItemId: "revenue.total", category: "product", periodIds: ["FY2026", "FY2027"],
      members: [{ lineItemId: "revenue.products", treatment: "add" }], reviewDecisionId: "first",
    },
  }]);
  const replaced = applyModelOperations(first, [{
    kind: "set_category_group",
    group: {
      parentLineItemId: "revenue.total", category: "product", periodIds: ["FY2027", "FY2026"],
      members: [{ lineItemId: "revenue.services", treatment: "add" }], reviewDecisionId: "replacement",
    },
  }]);
  assert.equal(replaced.categoryGroups.length, 1);
  assert.equal(replaced.categoryGroups[0]?.reviewDecisionId, "replacement");
  assert.throws(() => applyModelOperations(first, [{
    kind: "set_category_group",
    group: {
      parentLineItemId: "revenue.total", category: "product", periodIds: ["FY2027"],
      members: [{ lineItemId: "revenue.services", treatment: "add" }], reviewDecisionId: "partial",
    },
  }]), FinancialModelError);
});

test("add_line_item creates non-revenue DCF details that a formula may drive", () => {
  const base = snapshot({ sources: true });
  const next = applyModelOperations(base, [
    {
      kind: "add_line_item",
      lineItem: { parentId: "operating_expenses", id: "hosting", label: "Hosting expense" },
    },
    {
      kind: "set_line_item_source",
      lineItemId: "operating_expenses.hosting", range: "historical", source: "formula",
    },
    {
      kind: "set_formula",
      formula: { lineItemId: "operating_expenses.hosting", appliesTo: "historical",
        source: "revenue.total * 0.1", periodIds: ["FY2024", "FY2025"] },
    },
  ]);
  const detail = next.lineItems.find((item) => item.id === "operating_expenses.hosting")!;
  // The row is born inert on both sides; set_line_item_source is what opens it to a formula.
  assert.equal(detail.historical, "formula");
  assert.equal(detail.forecast, "none");
  assert.deepEqual(detail.unit, next.lineItems.find((item) => item.id === "operating_expenses")?.unit);
  assert.equal(next.formulas.some((formula) => formula.lineItemId === detail.id
    && formula.source === "revenue.total * 0.1"), true);
});

test("category groups reject source-statement rows as DCF members", () => {
  assert.throws(() => applyModelOperations(snapshot({ sources: true }), [{
    kind: "set_category_group",
    group: {
      parentLineItemId: "revenue.total", category: "invalid-source", periodIds: ["FY2024"],
      members: [{ lineItemId: "source.income_statement.revenue", treatment: "add" }],
      reviewDecisionId: "invalid",
    },
  }]), FinancialModelError);
});

test("replace_fact decisions are stamped by the host, not by the caller", () => {
  const base = snapshot({ sources: true });
  base.facts.push({
    factId: "old", status: "committed", lineItemId: "source.income_statement.revenue",
    periodId: "FY2025", value: 100, unit: { kind: "currency", code: "USD" },
    provenance: { sourceType: "filing", sourceRefs: ["old"], asOfDate: "2025-12-31" },
  });
  const audit = (decisionId: string): Omit<FactReviewDecision, "action" | "factId"> => ({
    decisionId, rationale: "Restatement", reviewedBy: "agent", reviewedAt: "2019-01-01T00:00:00.000Z",
  });
  const before = new Date().toISOString();

  const next = applyModelOperations(base, [{
    kind: "replace_fact",
    replacement: {
      factId: "new", status: "staged", periodId: "FY2025", value: 105,
      unit: { kind: "currency", code: "USD" }, supersedesFactId: "old",
      provenance: { sourceType: "filing", sourceRefs: ["new"], asOfDate: "2026-01-31" },
    },
    commitDecision: { ...audit("commit"), factId: "new", action: "commit", mappedLineItemId: "source.income_statement.revenue" },
    supersedeDecision: { ...audit("supersede"), factId: "old", action: "supersede", replacementFactId: "new" },
  }]);

  const after = new Date().toISOString();
  for (const decision of next.factReviewDecisions) {
    assert.ok(decision.reviewedAt >= before && decision.reviewedAt <= after,
      `${decision.decisionId} kept the caller's timestamp ${decision.reviewedAt}`);
  }
});
