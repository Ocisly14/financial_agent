import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, quantize, type EngineInput, type Formula } from "../engine.ts";
import { cellKey } from "../dsl/graph.ts";
import { FinancialModelError } from "../errors.ts";
import type {
  ActiveFact,
  Assumption,
  LineItem,
  Period,
  Unit,
  ValuationConfig,
} from "../types.ts";

const USD: Unit = { kind: "currency", code: "USD" };
const PCT: Unit = { kind: "percent" };

const PERIODS: Period[] = [
  {
    id: "FY2024",
    label: "FY2024",
    start: "2024-01-01",
    end: "2024-12-31",
    cls: "actual",
  },
  {
    id: "FY2025",
    label: "FY2025",
    start: "2025-01-01",
    end: "2025-12-31",
    cls: "actual",
  },
  {
    id: "FY2026",
    label: "FY2026",
    start: "2026-01-01",
    end: "2026-12-31",
    cls: "forecast",
  },
  {
    id: "FY2027",
    label: "FY2027",
    start: "2027-01-01",
    end: "2027-12-31",
    cls: "forecast",
  },
];

const ITEMS: LineItem[] = [
  {
    id: "revenue",
    label: "Revenue",
    role: "revenue_root",
    unit: USD,
    section: "revenue",
    order: 10,
    historical: "none",
    forecast: "none",
  },
  {
    id: "revenue.a",
    label: "A",
    parentId: "revenue",
    role: "revenue_stream",
    unit: USD,
    section: "revenue",
    order: 11,
    historical: "actual",
    forecast: "formula",
  },
  {
    id: "revenue.b",
    label: "B",
    parentId: "revenue",
    role: "revenue_stream",
    unit: USD,
    section: "revenue",
    order: 12,
    historical: "actual",
    forecast: "formula",
  },
  {
    id: "growth.revenue.a",
    label: "A growth",
    role: "none",
    unit: PCT,
    section: "revenue",
    order: 13,
    historical: "formula",
    forecast: "assumption",
  },
  {
    id: "growth.revenue.b",
    label: "B growth",
    role: "none",
    unit: PCT,
    section: "revenue",
    order: 14,
    historical: "formula",
    forecast: "assumption",
  },
  {
    id: "revenue.total",
    label: "Total revenue",
    role: "revenue_total",
    unit: USD,
    section: "revenue",
    order: 15,
    historical: "actual",
    forecast: "formula",
  },
  {
    id: "wacc",
    label: "WACC",
    role: "wacc",
    unit: PCT,
    section: "dcf",
    order: 16,
    historical: "none",
    forecast: "assumption",
  },
];

function fact(id: string, periodId: string, value: number): ActiveFact {
  return {
    factId: `${id}-${periodId}`,
    status: "committed",
    lineItemId: id,
    periodId,
    value,
    unit: USD,
    provenance: {
      sourceType: "company_disclosure",
      sourceRefs: ["https://example.com/10k"],
      asOfDate: "2026-01-01",
    },
  };
}

function assumption(lineItemId: string, periods: string[], values: number[]): Assumption {
  return {
    assumptionId: `${lineItemId}-${periods[0]}`,
    lineItemId,
    periods,
    payload: { kind: "values", values, unit: PCT },
    sourceType: "management_guidance",
    sourceRefs: ["https://example.com/call"],
    asOfDate: "2026-01-01",
    rationale: "Test assumption.",
  };
}

function notApplicable(lineItemId: string, periods: string[]): Assumption {
  return {
    assumptionId: `${lineItemId}-na`,
    lineItemId,
    periods,
    payload: { kind: "not_applicable" },
    sourceType: "company_disclosure",
    sourceRefs: ["https://example.com/10k"],
    asOfDate: "2026-01-01",
    rationale: "The component does not exist.",
  };
}

const VALUATION_CONFIG: ValuationConfig = {
  anchorPeriodId: "FY2025",
  discountConvention: "year_end",
  exitTerminalMetric: "fcff",
  sensitivity: {
    waccDeltas: [-0.01, 0, 0.01],
    terminalGrowthDeltas: [-0.005, 0, 0.005],
    exitMultipleDeltas: [-1, 0, 1],
  },
  sourceType: "analyst_inference",
  sourceRefs: ["https://example.com/methodology"],
  asOfDate: "2026-01-01",
  rationale: "Test valuation methodology.",
};

const FORMULAS: Formula[] = [
  {
    lineItemId: "revenue.a",
    appliesTo: "forecast",
    source: "LAG(revenue.a, 1) * (1 + growth.revenue.a)",
  },
  {
    lineItemId: "revenue.b",
    appliesTo: "forecast",
    source: "LAG(revenue.b, 1) * (1 + growth.revenue.b)",
  },
  // Generated from the committed DcfCategoryGroup; the engine executes
  // the normalized formula and never infers membership from hierarchy children.
  {
    lineItemId: "revenue.total",
    appliesTo: "forecast",
    source: "revenue.a + revenue.b",
  },
];

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    periods: PERIODS,
    lineItems: ITEMS,
    facts: [
      fact("revenue.a", "FY2024", 100),
      fact("revenue.a", "FY2025", 110),
      fact("revenue.b", "FY2024", 50),
      fact("revenue.b", "FY2025", 60),
      fact("revenue.total", "FY2024", 150),
      fact("revenue.total", "FY2025", 170),
    ],
    assumptions: [
      assumption("growth.revenue.a", ["FY2026", "FY2027"], [0.10, 0.05]),
      assumption("growth.revenue.b", ["FY2026", "FY2027"], [0.20]),
      assumption("wacc", ["FY2026", "FY2027"], [0.10, 0.12]),
    ],
    formulas: FORMULAS,
    valuationConfig: VALUATION_CONFIG,
    ...overrides,
  };
}

test("historical total comes from the independent committed consolidated fact", () => {
  const output = evaluate(input());
  assert.equal(output.cells.get(cellKey("revenue.a", "FY2025"))?.value, 110);
  assert.equal(output.cells.get(cellKey("revenue.total", "FY2025"))?.value, 170);
});

test("duplicate active facts are rejected instead of using input order", () => {
  const duplicate = fact("revenue.total", "FY2025", 999);
  duplicate.factId = "duplicate-revenue-total-FY2025";
  assert.throws(
    () => evaluate(input({ facts: [...input().facts, duplicate] })),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "fact_conflict",
  );
});

test("forecast total executes the formula generated from the reviewed aggregation plan", () => {
  const output = evaluate(input());
  assert.equal(output.cells.get(cellKey("revenue.total", "FY2026"))?.value, 193);
});

test("a per-period assumption path drives each forecast year", () => {
  const output = evaluate(input());
  assert.equal(output.cells.get(cellKey("revenue.a", "FY2026"))?.value, 121);
  assert.equal(output.cells.get(cellKey("revenue.a", "FY2027"))?.value, 127.05);
});

test("a single-value assumption applies as a constant across its periods", () => {
  const output = evaluate(input());
  assert.equal(output.cells.get(cellKey("revenue.b", "FY2026"))?.value, 72);
  assert.equal(output.cells.get(cellKey("revenue.b", "FY2027"))?.value, 86.4);
});

test("a missing assumption yields null with a missing_input diagnostic, never zero", () => {
  const output = evaluate(input({
    assumptions: [assumption("growth.revenue.a", ["FY2026"], [0.10])],
  }));
  const cell = output.cells.get(cellKey("revenue.b", "FY2026"));
  assert.equal(cell?.value, null);
  assert.equal(cell?.diagnostics[0]?.code, "missing_input");
  assert.ok(cell?.diagnostics[0]?.refs.includes(cellKey("growth.revenue.b", "FY2026")));
});

test("missing propagates downstream and the diagnostic names the origin", () => {
  const output = evaluate(input({ assumptions: [] }));
  const total = output.cells.get(cellKey("revenue.total", "FY2026"));
  assert.equal(total?.value, null);
  assert.equal(total?.diagnostics[0]?.code, "missing_input");
  assert.ok(total?.diagnostics[0]?.refs.includes(cellKey("growth.revenue.a", "FY2026")));
  assert.ok(total?.diagnostics[0]?.refs.includes(cellKey("growth.revenue.b", "FY2026")));
});

test("division by zero is a diagnostic, not a thrown error", () => {
  const items: LineItem[] = [
    ...ITEMS,
    {
      id: "margin",
      label: "Margin",
      role: "none",
      unit: { kind: "ratio" },
      section: "metrics",
      order: 20,
      historical: "formula",
      forecast: "none",
    },
  ];
  const output = evaluate(input({
    lineItems: items,
    facts: [
      fact("revenue.a", "FY2024", 0),
      fact("revenue.b", "FY2024", 0),
      fact("revenue.total", "FY2024", 0),
    ],
    formulas: [
      ...FORMULAS,
      {
        lineItemId: "margin",
        appliesTo: "historical",
        source: "revenue.a / revenue.total",
      },
    ],
  }));
  const cell = output.cells.get(cellKey("margin", "FY2024"));
  assert.equal(cell?.value, null);
  assert.equal(cell?.diagnostics[0]?.code, "divide_by_zero");
});

test("incompatible units are rejected before any evaluation", () => {
  assert.throws(
    () => evaluate(input({
      formulas: [
        ...FORMULAS,
        {
          lineItemId: "revenue.total",
          appliesTo: "historical",
          source: "revenue.a + growth.revenue.a",
        },
      ],
    })),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "incompatible_units",
  );
});

test("YEAR_INDEX follows the discount convention and is null in history", () => {
  const items: LineItem[] = [
    ...ITEMS,
    {
      id: "disc",
      label: "Discount period",
      role: "none",
      unit: { kind: "number" },
      section: "dcf",
      order: 30,
      historical: "formula",
      forecast: "formula",
    },
  ];
  const formulas: Formula[] = [
    ...FORMULAS,
    { lineItemId: "disc", appliesTo: "historical", source: "YEAR_INDEX()" },
    { lineItemId: "disc", appliesTo: "forecast", source: "YEAR_INDEX()" },
  ];

  const yearEnd = evaluate(input({ lineItems: items, formulas }));
  assert.equal(yearEnd.cells.get(cellKey("disc", "FY2026"))?.value, 1);
  assert.equal(yearEnd.cells.get(cellKey("disc", "FY2027"))?.value, 2);
  assert.equal(yearEnd.cells.get(cellKey("disc", "FY2025"))?.value, null);
  assert.equal(
    yearEnd.cells.get(cellKey("disc", "FY2025"))?.diagnostics[0]?.code,
    "not_applicable",
  );

  const midYear = evaluate(input({
    lineItems: items,
    formulas,
    valuationConfig: { ...VALUATION_CONFIG, discountConvention: "mid_year" },
  }));
  assert.equal(midYear.cells.get(cellKey("disc", "FY2026"))?.value, 0.5);
  assert.equal(midYear.cells.get(cellKey("disc", "FY2027"))?.value, 1.5);

  const forecastAnchor = evaluate(input({
    lineItems: items,
    formulas,
    valuationConfig: { ...VALUATION_CONFIG, anchorPeriodId: "FY2026" },
  }));
  assert.equal(forecastAnchor.cells.get(cellKey("disc", "FY2026"))?.value, null);
  assert.equal(
    forecastAnchor.cells.get(cellKey("disc", "FY2026"))?.diagnostics[0]?.code,
    "not_applicable",
  );
  assert.equal(forecastAnchor.cells.get(cellKey("disc", "FY2027"))?.value, 1);
});

test("DISCOUNT_FACTOR accumulates a changing WACC path", () => {
  const items: LineItem[] = [
    ...ITEMS,
    {
      id: "discount.factor",
      label: "Discount factor",
      role: "none",
      unit: { kind: "ratio" },
      section: "dcf",
      order: 31,
      historical: "none",
      forecast: "formula",
    },
  ];
  const formulas: Formula[] = [
    ...FORMULAS,
    {
      lineItemId: "discount.factor",
      appliesTo: "forecast",
      source: "DISCOUNT_FACTOR(wacc)",
    },
  ];

  const yearEnd = evaluate(input({ lineItems: items, formulas }));
  assert.equal(yearEnd.cells.get(cellKey("discount.factor", "FY2026"))?.value, 1.1);
  assert.equal(yearEnd.cells.get(cellKey("discount.factor", "FY2027"))?.value, 1.232);

  const midYear = evaluate(input({
    lineItems: items,
    formulas,
    valuationConfig: { ...VALUATION_CONFIG, discountConvention: "mid_year" },
  }));
  assert.equal(
    midYear.cells.get(cellKey("discount.factor", "FY2026"))?.value,
    quantize(Math.sqrt(1.1)),
  );
  assert.equal(
    midYear.cells.get(cellKey("discount.factor", "FY2027"))?.value,
    quantize(1.1 * Math.sqrt(1.12)),
  );

  const forecastAnchor = evaluate(input({
    lineItems: items,
    formulas,
    valuationConfig: { ...VALUATION_CONFIG, anchorPeriodId: "FY2026" },
  }));
  assert.equal(
    forecastAnchor.cells.get(cellKey("discount.factor", "FY2026"))?.value,
    null,
  );
  assert.equal(
    forecastAnchor.cells.get(cellKey("discount.factor", "FY2027"))?.value,
    1.12,
  );
});

test("explicit N/A stays distinct from missing and propagates through DSL references", () => {
  const items: LineItem[] = [
    ...ITEMS,
    {
      id: "preferred_equity",
      label: "Preferred equity",
      role: "preferred_equity",
      unit: USD,
      section: "dcf",
      order: 32,
      historical: "none",
      forecast: "assumption",
    },
    {
      id: "preferred_equity.echo",
      label: "Preferred equity echo",
      role: "none",
      unit: USD,
      section: "dcf",
      order: 33,
      historical: "none",
      forecast: "formula",
    },
  ];
  const formulas: Formula[] = [
    ...FORMULAS,
    {
      lineItemId: "preferred_equity.echo",
      appliesTo: "forecast",
      source: "preferred_equity",
    },
  ];
  const output = evaluate(input({
    lineItems: items,
    formulas,
    assumptions: [
      ...input().assumptions,
      notApplicable("preferred_equity", ["FY2026", "FY2027"]),
    ],
  }));
  assert.equal(
    output.cells.get(cellKey("preferred_equity", "FY2026"))?.diagnostics[0]?.code,
    "not_applicable",
  );
  assert.equal(
    output.cells.get(cellKey("preferred_equity.echo", "FY2026"))?.diagnostics[0]?.code,
    "not_applicable",
  );

  const missing = evaluate(input({ lineItems: items, formulas }));
  assert.equal(
    missing.cells.get(cellKey("preferred_equity", "FY2026"))?.diagnostics[0]?.code,
    "missing_input",
  );
});

test("overlapping assumptions are rejected instead of using input order", () => {
  const duplicate = assumption("growth.revenue.a", ["FY2026"], [0.30]);
  assert.throws(
    () => evaluate(input({ assumptions: [...input().assumptions, duplicate] })),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "invalid_assumption",
  );
});

test("quantize removes float64 tails", () => {
  assert.equal(quantize(0.1 + 0.2), 0.3);
  assert.equal(quantize(1 / 3), 0.333333333333);
});

test("explicit periodIds select different formulas for forecast years", () => {
  const formulas: Formula[] = [
    ...FORMULAS.filter((formula) => formula.lineItemId !== "revenue.total"),
    {
      lineItemId: "revenue.total",
      appliesTo: "forecast",
      periodIds: ["FY2026"],
      source: "revenue.a",
    },
    {
      lineItemId: "revenue.total",
      appliesTo: "forecast",
      periodIds: ["FY2027"],
      source: "revenue.b",
    },
  ];
  const output = evaluate(input({ formulas }));
  assert.equal(output.cells.get(cellKey("revenue.total", "FY2026"))?.value, 121);
  assert.equal(output.cells.get(cellKey("revenue.total", "FY2027"))?.value, 86.4);
});

test("overlapping explicit and class-wide formulas are rejected before evaluation", () => {
  assert.throws(
    () => evaluate(input({
      formulas: [
        ...FORMULAS,
        {
          lineItemId: "revenue.total",
          appliesTo: "forecast",
          periodIds: ["FY2026"],
          source: "revenue.a",
        },
      ],
    })),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "invalid_formula",
  );
});

test("evaluation is deterministic when non-semantic input collections are reordered", () => {
  const first = evaluate(input());
  const original = input();
  const second = evaluate({
    ...original,
    lineItems: [...original.lineItems].reverse(),
    facts: [...original.facts].reverse(),
    assumptions: [...original.assumptions].reverse(),
    formulas: [...original.formulas].reverse(),
  });
  assert.deepEqual(second.order, first.order);
  assert.deepEqual([...second.cells], [...first.cells]);
});

test("reversing periods is rejected because period order is model semantics", () => {
  const original = input();
  assert.throws(
    () => evaluate({ ...original, periods: [...original.periods].reverse() }),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "incompatible_periods",
  );
});
