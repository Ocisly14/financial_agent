import { test } from "node:test";
import assert from "node:assert/strict";
import { FinancialModelError } from "../../errors.ts";
import { buildGrid } from "../../periodGrid.ts";
import type { Period } from "../../types.ts";
import { cellKey, dependenciesOf, topoOrder, type GraphContext } from "../graph.ts";
import { parseFormula } from "../parser.ts";

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

const RANK: Record<string, number> = {
  "revenue.a": 1,
  "revenue.b": 2,
  revenue: 3,
  "revenue.total": 4,
  growth: 0,
};

const ctx: GraphContext = {
  grid: buildGrid(PERIODS),
  valuationAnchorPeriodId: "FY2025",
  rankOf: (id) => RANK[id] ?? 99,
};

test("a bare reference depends on the same row in the current period", () => {
  assert.deepEqual(dependenciesOf(parseFormula("revenue.a"), "x", "FY2026", ctx), [
    cellKey("revenue.a", "FY2026"),
  ]);
});

test("LAG depends on the earlier period, crossing the actual/forecast boundary", () => {
  assert.deepEqual(
    dependenciesOf(parseFormula("LAG(revenue.a, 1)"), "x", "FY2026", ctx),
    [cellKey("revenue.a", "FY2025")],
  );
});

test("a dependency off the front of the grid produces no edge", () => {
  assert.deepEqual(
    dependenciesOf(parseFormula("LAG(revenue.a, 1)"), "x", "FY2024", ctx),
    [],
  );
});

test("YOY depends on the current and prior period", () => {
  assert.deepEqual(
    dependenciesOf(parseFormula("YOY(revenue.a)"), "x", "FY2026", ctx),
    [cellKey("revenue.a", "FY2026"), cellKey("revenue.a", "FY2025")],
  );
});

test("SUM over an offset range depends on every period in the window", () => {
  assert.deepEqual(
    dependenciesOf(parseFormula("SUM(revenue.a, -2, 0)"), "x", "FY2026", ctx),
    [
      cellKey("revenue.a", "FY2024"),
      cellKey("revenue.a", "FY2025"),
      cellKey("revenue.a", "FY2026"),
    ],
  );
});

test("DISCOUNT_FACTOR depends on the post-anchor WACC path through the current forecast period", () => {
  assert.deepEqual(
    dependenciesOf(parseFormula("DISCOUNT_FACTOR(wacc)"), "pv", "FY2026", ctx),
    [cellKey("wacc", "FY2026")],
  );
});

test("DISCOUNT_FACTOR excludes forecast periods at or before the valuation anchor", () => {
  const anchoredInForecast = { ...ctx, valuationAnchorPeriodId: "FY2026" };
  assert.deepEqual(
    dependenciesOf(
      parseFormula("DISCOUNT_FACTOR(wacc)"),
      "pv",
      "FY2026",
      anchoredInForecast,
    ),
    [],
  );
});

test("a computed reference is rejected", () => {
  assert.throws(
    () =>
      dependenciesOf(
        parseFormula("LAG(revenue.a + revenue.b, 1)"),
        "x",
        "FY2026",
        ctx,
      ),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "invalid_formula",
  );
});

test("a lagged self-reference is a legal chain, not a cycle", () => {
  const deps = new Map([
    [cellKey("revenue.a", "FY2026"), [cellKey("revenue.a", "FY2025")]],
    [cellKey("revenue.a", "FY2025"), []],
  ]);
  const order = topoOrder([...deps.keys()], deps, ctx);
  assert.deepEqual(order, [
    cellKey("revenue.a", "FY2025"),
    cellKey("revenue.a", "FY2026"),
  ]);
});

test("a true cycle among cells is rejected", () => {
  const deps = new Map([
    [cellKey("a", "FY2026"), [cellKey("b", "FY2026")]],
    [cellKey("b", "FY2026"), [cellKey("a", "FY2026")]],
  ]);
  assert.throws(
    () => topoOrder([...deps.keys()], deps, ctx),
    (error: unknown) =>
      error instanceof FinancialModelError && error.code === "circular_dependency",
  );
});

test("independent cells use period position, numeric line-item rank, id, and a true total comparator", () => {
  const nodes = [
    cellKey("revenue.b", "FY2026"),
    cellKey("revenue.a", "FY2026"),
    cellKey("revenue.total", "FY2026"),
    cellKey("revenue.total", "FY2025"),
  ];
  const deps = new Map(nodes.map((node) => [node, [] as string[]]));
  assert.deepEqual(topoOrder(nodes, deps, ctx), [
    cellKey("revenue.total", "FY2025"),
    cellKey("revenue.a", "FY2026"),
    cellKey("revenue.b", "FY2026"),
    cellKey("revenue.total", "FY2026"),
  ]);
  // Same nodes, different input order, same result.
  assert.deepEqual(topoOrder([...nodes].reverse(), deps, ctx), topoOrder(nodes, deps, ctx));
});

test("cycle diagnostics use the same deterministic cell ordering", () => {
  const a = cellKey("revenue.a", "FY2026");
  const b = cellKey("revenue.b", "FY2026");
  const first = new Map([
    [b, [a]],
    [a, [b]],
  ]);
  const second = new Map([
    [a, [b]],
    [b, [a]],
  ]);

  const getCells = (
    nodes: readonly string[],
    deps: ReadonlyMap<string, readonly string[]>,
  ): unknown => {
    try {
      topoOrder(nodes, deps, ctx);
      assert.fail("expected circular_dependency");
    } catch (error: unknown) {
      assert.ok(error instanceof FinancialModelError);
      assert.equal(error.code, "circular_dependency");
      return error.details?.cells;
    }
  };

  assert.deepEqual(getCells([b, a], first), [a, b]);
  assert.deepEqual(getCells([a, b], second), [a, b]);
});
