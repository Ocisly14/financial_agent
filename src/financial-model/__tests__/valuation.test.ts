import { test } from "node:test";
import assert from "node:assert/strict";
import { cellKey, type CellKey } from "../dsl/graph.ts";
import { FinancialModelError } from "../errors.ts";
import { createSkeleton } from "../skeleton.ts";
import type { Cell, Period, ResolvedValuationConfig, Unit } from "../types.ts";
import {
  MAX_SENSITIVITY_AXIS_LENGTH,
  calculateValuation,
  validateValuationConfig,
  type ValuationInput,
} from "../valuation.ts";

const USD: Unit = { kind: "currency", code: "USD" };
const PCT: Unit = { kind: "percent" };
const RATIO: Unit = { kind: "ratio" };
const SHARES: Unit = { kind: "shares" };

const PERIODS: Period[] = [
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
  {
    id: "FY2028",
    label: "FY2028",
    start: "2028-01-01",
    end: "2028-12-31",
    cls: "forecast",
  },
];

const CONFIG: ResolvedValuationConfig = {
  anchorPeriodId: "FY2025",
  discountConvention: "year_end",
  exitTerminalMetric: "ebitda",
  sensitivity: {
    waccDeltas: [-0.01, 0, 0.01],
    terminalGrowthDeltas: [-0.01, 0, 0.01],
    exitMultipleDeltas: [-1, 0, 1],
  },
  sourceType: "analyst_inference",
  sourceRefs: ["https://example.com/methodology"],
  asOfDate: "2026-01-01",
  rationale: "Test methodology.",
};

function numeric(value: number, unit: Unit): Cell {
  return { value, unit, diagnostics: [] };
}

function notApplicable(unit: Unit, ref: CellKey): Cell {
  return {
    value: null,
    unit,
    diagnostics: [{ code: "not_applicable", refs: [ref] }],
  };
}

function baseInput(overrides: Partial<ValuationInput> = {}): ValuationInput {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  const cells = new Map<CellKey, Cell>();
  const seed = (lineItemId: string, periodId: string, value: number, unit: Unit): void => {
    cells.set(cellKey(lineItemId, periodId), numeric(value, unit));
  };

  seed("fcff", "FY2026", 100, USD);
  seed("fcff", "FY2027", 110, USD);
  seed("fcff", "FY2028", 120, USD);
  seed("wacc", "FY2026", 0.10, PCT);
  seed("wacc", "FY2027", 0.11, PCT);
  seed("wacc", "FY2028", 0.12, PCT);
  seed("terminal_growth", "FY2028", 0.03, PCT);
  seed("exit_multiple", "FY2028", 8, RATIO);
  seed("ebitda", "FY2028", 150, USD);

  seed("cash_available_for_bridge", "FY2025", 50, USD);
  seed("non_operating_investments", "FY2025", 20, USD);
  seed("debt", "FY2025", 100, USD);
  seed("lease_liabilities", "FY2025", 10, USD);
  const preferredKey = cellKey("preferred_equity", "FY2025");
  cells.set(preferredKey, notApplicable(USD, preferredKey));
  seed("non_controlling_interests", "FY2025", 5, USD);
  seed("diluted_shares", "FY2025", 10, SHARES);

  return {
    periods: PERIODS,
    lineItems: skeleton.lineItems,
    cells,
    valuationConfig: CONFIG,
    ...overrides,
  };
}

function close(actual: number | null | undefined, expected: number, tolerance = 1e-10): void {
  assert.notEqual(actual, null);
  assert.notEqual(actual, undefined);
  assert.ok(Math.abs(actual! - expected) <= tolerance, `${actual} != ${expected}`);
}

test("year-end discounting follows a constant WACC path", () => {
  const original = baseInput();
  const cells = new Map(original.cells);
  for (const periodId of ["FY2026", "FY2027", "FY2028"]) {
    cells.set(cellKey("wacc", periodId), numeric(0.10, PCT));
  }
  const output = calculateValuation({ ...original, cells });
  assert.deepEqual(
    output.explicitPeriods.map((period) => period.discountFactor),
    [1.1, 1.21, 1.331],
  );
});

test("year-end discounting multiplies each value in a changing WACC path", () => {
  const output = calculateValuation(baseInput());
  assert.deepEqual(
    output.explicitPeriods.map((period) => period.discountFactor),
    [1.1, 1.221, 1.36752],
  );
  assert.deepEqual(output.explicitPeriods.map((period) => period.wacc), [0.10, 0.11, 0.12]);
});

test("mid-year discounting applies full prior years and half the current year", () => {
  const input = baseInput({
    valuationConfig: { ...CONFIG, discountConvention: "mid_year" },
  });
  const output = calculateValuation(input);
  close(output.explicitPeriods[0]?.discountFactor, 1.04880884817);
  close(output.explicitPeriods[1]?.discountFactor, 1.15892191281);
  close(output.explicitPeriods[2]?.discountFactor, 1.29218494032);
});

test("Perpetuity growth uses final FCFF, growth, final WACC, and final discount factor", () => {
  const output = calculateValuation(baseInput());
  close(output.perpetuityGrowth.terminalValue, 1373.33333333);
  close(output.perpetuityGrowth.terminalPresentValue, 1004.25100425);
  close(output.perpetuityGrowth.enterpriseValue, 1273.000273);
  close(output.perpetuityGrowth.impliedValuePerShare, 122.8000273);
});

test("exit multiple selects the configured unique EBITDA or FCFF role", () => {
  const ebitda = calculateValuation(baseInput());
  close(ebitda.exitMultiple.terminalValue, 1200);

  const fcff = calculateValuation(baseInput({
    valuationConfig: { ...CONFIG, exitTerminalMetric: "fcff" },
  }));
  close(fcff.exitMultiple.terminalValue, 960);
});

test("both terminal methods return separately and are never averaged", () => {
  const output = calculateValuation(baseInput());
  assert.equal(output.perpetuityGrowth.method, "perpetuity_growth");
  assert.equal(output.exitMultiple.method, "exit_multiple");
  assert.notEqual(
    output.perpetuityGrowth.impliedValuePerShare,
    output.exitMultiple.impliedValuePerShare,
  );
  assert.equal("blended" in output, false);
  assert.equal("average" in output, false);
});

test("equity bridge applies every signed component and preserves explicit N/A lineage", () => {
  const output = calculateValuation(baseInput());
  const bridge = output.perpetuityGrowth.bridge;
  assert.equal(
    bridge.reduce((total, adjustment) => total + adjustment.appliedAdjustment, 0),
    -45,
  );
  const preferred = bridge.find((adjustment) => adjustment.role === "preferred_equity");
  assert.deepEqual(preferred, {
    lineItemId: "preferred_equity",
    role: "preferred_equity",
    sign: -1,
    status: "not_applicable",
    value: null,
    appliedAdjustment: 0,
    refs: [cellKey("preferred_equity", "FY2025")],
  });
  close(output.perpetuityGrowth.equityValue, output.perpetuityGrowth.enterpriseValue - 45);
});

test("missing required bridge input is not converted to zero", () => {
  const original = baseInput();
  const cells = new Map(original.cells);
  cells.delete(cellKey("debt", "FY2025"));
  assert.throws(
    () => calculateValuation({ ...original, cells }),
    (error: unknown) =>
      error instanceof FinancialModelError
      && error.code === "incomplete_equity_bridge",
  );
});

test("diluted shares must be numeric and positive before per-share value is emitted", () => {
  for (const cell of [
    numeric(0, SHARES),
    notApplicable(SHARES, cellKey("diluted_shares", "FY2025")),
  ]) {
    const original = baseInput();
    const cells = new Map(original.cells);
    cells.set(cellKey("diluted_shares", "FY2025"), cell);
    assert.throws(
      () => calculateValuation({ ...original, cells }),
      (error: unknown) =>
        error instanceof FinancialModelError
        && error.code === "incomplete_equity_bridge",
    );
  }
});

test("reference WACC not greater than growth throws invalid_terminal_assumptions", () => {
  const original = baseInput();
  const cells = new Map(original.cells);
  cells.set(cellKey("terminal_growth", "FY2028"), numeric(0.12, PCT));
  assert.throws(
    () => calculateValuation({ ...original, cells }),
    (error: unknown) =>
      error instanceof FinancialModelError
      && error.code === "invalid_terminal_assumptions",
  );
});

test("Perpetuity-growth sensitivity invalid cells are null rather than negative or infinite", () => {
  const output = calculateValuation(baseInput({
    valuationConfig: {
      ...CONFIG,
      sensitivity: {
        waccDeltas: [0],
        terminalGrowthDeltas: [0, 0.09],
        exitMultipleDeltas: [0],
      },
    },
  }));
  const invalid = output.waccByGrowth.cells[0]?.[1];
  assert.equal(invalid?.impliedValuePerShare, null);
  assert.equal(invalid?.diagnostics[0]?.code, "invalid_terminal_assumptions");
});

test("a WACC sensitivity delta shifts every annual WACC in parallel", () => {
  const output = calculateValuation(baseInput({
    valuationConfig: {
      ...CONFIG,
      sensitivity: {
        waccDeltas: [0.01],
        terminalGrowthDeltas: [0],
        exitMultipleDeltas: [0],
      },
    },
  }));
  close(output.waccByGrowth.cells[0]?.[0]?.impliedValuePerShare, 109.882239382);
});

test("exit sensitivity uses the configured exit metric and multiple deltas", () => {
  const output = calculateValuation(baseInput({
    valuationConfig: {
      ...CONFIG,
      sensitivity: {
        waccDeltas: [0],
        terminalGrowthDeltas: [0],
        exitMultipleDeltas: [-1, 1],
      },
    },
  }));
  close(output.waccByMultiple.cells[0]?.[0]?.impliedValuePerShare, 99.1562536563);
  close(output.waccByMultiple.cells[0]?.[1]?.impliedValuePerShare, 121.093775594);
});

test("sensitivity axes are normalized, bounded, and deterministic", () => {
  const normalized = validateValuationConfig({
    ...CONFIG,
    sensitivity: {
      waccDeltas: [0.01, -0.01, 0, 0.01, -0],
      terminalGrowthDeltas: [0.01, 0, -0.01, 0],
      exitMultipleDeltas: [1, -1, 0, 1],
    },
  });
  assert.deepEqual(normalized.sensitivity?.waccDeltas, [-0.01, 0, 0.01]);
  assert.deepEqual(normalized.sensitivity?.terminalGrowthDeltas, [-0.01, 0, 0.01]);
  assert.deepEqual(normalized.sensitivity?.exitMultipleDeltas, [-1, 0, 1]);

  assert.throws(
    () => validateValuationConfig({
      ...CONFIG,
      sensitivity: {
        ...CONFIG.sensitivity,
        waccDeltas: [Number.NaN],
      },
    }),
    (error: unknown) =>
      error instanceof FinancialModelError
      && error.code === "invalid_terminal_assumptions",
  );
  assert.throws(
    () => validateValuationConfig({
      ...CONFIG,
      sensitivity: {
        ...CONFIG.sensitivity,
        waccDeltas: Array.from(
          { length: MAX_SENSITIVITY_AXIS_LENGTH + 1 },
          (_, index) => index / 1000,
        ),
      },
    }),
    (error: unknown) =>
      error instanceof FinancialModelError
      && error.code === "invalid_terminal_assumptions",
  );
});

test("TTM does not consume a forecast index", () => {
  const ttm: Period = {
    id: "TTM",
    label: "TTM",
    start: "2025-07-01",
    end: "2026-06-30",
    cls: "ttm",
  };
  const periods = [PERIODS[0]!, ttm, ...PERIODS.slice(1)];
  const skeleton = createSkeleton({ currency: "USD", periods });
  const input = baseInput({ periods, lineItems: skeleton.lineItems });
  const output = calculateValuation(input);
  assert.deepEqual(output.explicitPeriods.map((period) => period.periodId), [
    "FY2026",
    "FY2027",
    "FY2028",
  ]);
  assert.deepEqual(
    output.explicitPeriods.map((period) => period.discountFactor),
    [1.1, 1.221, 1.36752],
  );
});
