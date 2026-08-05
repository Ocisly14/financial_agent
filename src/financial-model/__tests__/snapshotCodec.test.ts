import { test } from "node:test";
import assert from "node:assert/strict";
import { cellKey } from "../dsl/graph.ts";
import { parseFormula } from "../dsl/parser.ts";
import { FinancialModelError } from "../errors.ts";
import type { FinancialModelSnapshot } from "../operations.ts";
import {
  addRevenueStream,
  addSourceStatementRows,
  createSkeleton,
} from "../skeleton.ts";
import { financialModelSnapshotCodec } from "../snapshotCodec.ts";
import type { Cell, Period, Unit, ValuationConfig } from "../types.ts";

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
];

const CONFIG: ValuationConfig = {
  anchorPeriodId: "FY2025",
  discountConvention: "year_end",
  exitTerminalMetric: "ebitda",
  sensitivity: {
    waccDeltas: [-0.01, 0, 0.01],
    terminalGrowthDeltas: [-0.005, 0, 0.005],
    exitMultipleDeltas: [-1, 0, 1],
  },
  sourceType: "analyst_inference",
  sourceRefs: ["https://example.com/methodology"],
  asOfDate: "2026-01-01",
  rationale: "Auditable methodology.",
};

function cell(value: number | null, unit: Unit): Cell {
  return {
    value,
    unit,
    diagnostics: value === null
      ? [{ code: "missing_input", refs: ["revenue.total@FY2024"] }]
      : [],
  };
}

function snapshot(): FinancialModelSnapshot {
  let skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  skeleton = addRevenueStream(skeleton, { id: "product", label: "Product" });
  skeleton = addSourceStatementRows(skeleton, [
    {
      sourceLineItemId: "source.income_statement.revenue",
      statement: "income_statement",
      label: "Reported revenue",
      unit: USD,
      order: 1,
    },
    {
      sourceLineItemId: "source.balance_sheet.cash",
      statement: "balance_sheet",
      label: "Cash",
      unit: USD,
      order: 1,
    },
    {
      sourceLineItemId: "source.cash_flow_statement.capex",
      statement: "cash_flow_statement",
      label: "Capital expenditure",
      unit: USD,
      order: 1,
    },
  ]);

  const formulas = skeleton.formulas.map((formula) => ({
    ...formula,
    ...(formula.periodIds === undefined ? {} : { periodIds: [...formula.periodIds] }),
  }));
  const cells = new Map<string, Cell>();
  cells.set(cellKey("wacc", "FY2026"), cell(0.1, PCT));
  cells.set(cellKey("revenue.total", "FY2025"), cell(110, USD));
  cells.set(cellKey("revenue.total", "FY2024"), cell(100, USD));

  return {
    lifecycleStage: "draft",
    periods: PERIODS.map((period) => ({ ...period })),
    lineItems: skeleton.lineItems.map((item) => ({ ...item, unit: { ...item.unit } })),
    facts: [
      {
        factId: "fact-revenue-2024",
        status: "rejected",
        lineItemId: "source.income_statement.revenue",
        periodId: "FY2024",
        value: 99,
        unit: USD,
        provenance: {
          sourceType: "company_disclosure",
          sourceRefs: ["https://example.com/10k"],
          asOfDate: "2026-01-01",
          decimals: -6,
          accession: "0000000000-26-000001",
          concept: "us-gaap:Revenue",
          filingUrl: "https://example.com/filing",
        },
      },
    ],
    factReviewDecisions: [
      {
        decisionId: "decision-reject-revenue",
        factId: "fact-revenue-2024",
        action: "reject",
        rationale: "A more precise consolidated fact was selected.",
        reviewedBy: "agent:test",
        reviewedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    assumptions: [
      {
        assumptionId: "wacc-forecast",
        lineItemId: "wacc",
        periods: ["FY2026"],
        payload: { kind: "values", values: [0.1], unit: PCT },
        sourceType: "analyst_inference",
        sourceRefs: ["https://example.com/wacc"],
        asOfDate: "2026-01-01",
        rationale: "Capital structure estimate.",
      },
    ],
    formulas,
    compiledFormulas: formulas.map((formula) => ({
      ...formula,
      ast: parseFormula(formula.source),
    })),
    selectedHistoricalPeriodIds: ["FY2024", "FY2025"],
    statementMappingPlans: [
      {
        targetLineItemId: "revenue.total",
        periodIds: ["FY2024"],
        members: [
          {
            sourceLineItemId: "source.income_statement.revenue",
            treatment: "add",
          },
        ],
        reviewDecisionId: "mapping-revenue-2024",
      },
    ],
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "产品披露",
      periodIds: ["FY2024"],
      members: [{ lineItemId: "revenue.product", treatment: "add" }],
      reviewDecisionId: "review-product-category",
    }],
    proposedStatementMappings: [
      {
        targetLineItemId: "revenue.total",
        periodIds: ["FY2025"],
        members: [
          {
            sourceLineItemId: "source.income_statement.revenue",
            treatment: "add",
          },
        ],
      },
    ],
    valuationConfig: structuredClone(CONFIG),
    cells,
    diagnostics: [{ code: "missing_input", refs: [cellKey("fcff", "FY2026")] }],
    mappingDiagnostics: [
      {
        code: "missing_input",
        refs: [cellKey("source.income_statement.revenue", "FY2025")],
      },
    ],
    reconciliationResults: [{
      kind: "category",
      ruleId: "category:revenue.total:产品披露:review-product-category",
      periodId: "FY2024",
      status: "insufficient_data",
      required: true,
      actual: null,
      calculated: null,
      residual: null,
      difference: null,
      tolerance: 0.000001,
      refs: [cellKey("revenue.total", "FY2024"), cellKey("revenue.product", "FY2024")],
      parentLineItemId: "revenue.total",
      category: "产品披露",
      reviewDecisionId: "review-product-category",
    }],
    mappingException: {
      reason: "low_confidence",
      sourceLineItemIds: ["source.income_statement.revenue"],
      periodIds: ["FY2025"],
    },
    valuation: null,
    engineVersion: "1.0.0",
  };
}

function expectInvalid(action: () => unknown): FinancialModelError {
  try {
    action();
    assert.fail("expected invalid_snapshot");
  } catch (error: unknown) {
    assert.ok(error instanceof FinancialModelError);
    assert.equal(error.code, "invalid_snapshot");
    return error;
  }
}

test("snapshot round-trip preserves authoritative period order and every audit field", () => {
  const original = snapshot();
  const decoded = financialModelSnapshotCodec.decode(
    financialModelSnapshotCodec.encode(original),
  );
  assert.deepEqual(decoded, original);
  assert.deepEqual(decoded.periods.map((period) => period.id), [
    "FY2024",
    "FY2025",
    "FY2026",
  ]);
  assert.deepEqual(decoded.facts, original.facts);
  assert.deepEqual(decoded.factReviewDecisions, original.factReviewDecisions);
  assert.deepEqual(decoded.statementMappingPlans, original.statementMappingPlans);
});

test("maps encode as deterministically ordered JSON arrays and decode back to maps", () => {
  const encoded = financialModelSnapshotCodec.encode(snapshot());
  const wire = JSON.parse(encoded) as { cells: Array<{ key: string }> };
  assert.ok(Array.isArray(wire.cells));
  assert.deepEqual(wire.cells.map((entry) => entry.key), [
    cellKey("revenue.total", "FY2024"),
    cellKey("revenue.total", "FY2025"),
    cellKey("wacc", "FY2026"),
  ]);
  assert.ok(financialModelSnapshotCodec.decode(encoded).cells instanceof Map);
});

test("encoding the same snapshot twice produces byte-identical JSON", () => {
  const value = snapshot();
  assert.equal(
    financialModelSnapshotCodec.encode(value),
    financialModelSnapshotCodec.encode(value),
  );
});

test("codec rejects NaN and Infinity, normalizes negative zero, and rejects unknown fields, missing fields, and invalid union tags", () => {
  for (const badValue of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const bad = snapshot();
    const cells = new Map(bad.cells);
    cells.set(cellKey("wacc", "FY2026"), cell(badValue, PCT));
    expectInvalid(() => financialModelSnapshotCodec.encode({ ...bad, cells }));
  }

  const negativeZero = snapshot();
  const negativeZeroCells = new Map(negativeZero.cells);
  negativeZeroCells.set(cellKey("wacc", "FY2026"), cell(-0, PCT));
  const normalized = financialModelSnapshotCodec.decode(
    financialModelSnapshotCodec.encode({ ...negativeZero, cells: negativeZeroCells }),
  );
  assert.equal(Object.is(normalized.cells.get(cellKey("wacc", "FY2026"))?.value, -0), false);
  assert.equal(normalized.cells.get(cellKey("wacc", "FY2026"))?.value, 0);

  const wire = JSON.parse(financialModelSnapshotCodec.encode(snapshot())) as Record<string, unknown>;
  expectInvalid(() => financialModelSnapshotCodec.decode(JSON.stringify({ ...wire, extra: true })));

  const missing = { ...wire };
  delete missing.engineVersion;
  expectInvalid(() => financialModelSnapshotCodec.decode(JSON.stringify(missing)));

  expectInvalid(() => financialModelSnapshotCodec.decode(JSON.stringify({
    ...wire,
    lifecycleStage: "unknown_stage",
  })));
});

test("codec rejects duplicate cell keys and structural references to unknown rows or periods", () => {
  const wire = JSON.parse(financialModelSnapshotCodec.encode(snapshot())) as {
    cells: Array<{ key: string; cell: unknown }>;
    formulas: Array<Record<string, unknown>>;
  };
  wire.cells.push(structuredClone(wire.cells[0]!));
  expectInvalid(() => financialModelSnapshotCodec.decode(JSON.stringify(wire)));

  const unknownCell = JSON.parse(financialModelSnapshotCodec.encode(snapshot())) as {
    cells: Array<{ key: string; cell: unknown }>;
  };
  unknownCell.cells[0] = {
    ...unknownCell.cells[0]!,
    key: cellKey("unknown.row", "FY2024"),
  };
  expectInvalid(() => financialModelSnapshotCodec.decode(JSON.stringify(unknownCell)));

  const unknownFormula = JSON.parse(financialModelSnapshotCodec.encode(snapshot())) as {
    formulas: Array<Record<string, unknown>>;
  };
  unknownFormula.formulas[0] = {
    ...unknownFormula.formulas[0]!,
    periodIds: ["FY2099"],
  };
  expectInvalid(() => financialModelSnapshotCodec.decode(JSON.stringify(unknownFormula)));
});

test("malformed stored JSON throws invalid_snapshot rather than a model-not-found error", () => {
  const error = expectInvalid(() => financialModelSnapshotCodec.decode("{not-json"));
  assert.notEqual(error.code, "financial_model_not_found");
});
