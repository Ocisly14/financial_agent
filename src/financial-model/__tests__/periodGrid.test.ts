import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGrid } from "../periodGrid.ts";
import { FinancialModelError } from "../errors.ts";
import type { Period } from "../types.ts";

function p(id: string, cls: Period["cls"], year: number): Period {
  return { id, label: id, start: `${year}-01-01`, end: `${year}-12-31`, cls };
}

const PERIODS: Period[] = [
  p("FY2023", "actual", 2023),
  p("FY2024", "actual", 2024),
  p("FY2025", "actual", 2025),
  p("FY2026", "forecast", 2026),
  p("FY2027", "forecast", 2027),
];

test("grid preserves the caller-supplied authoritative chronological order", () => {
  const grid = buildGrid(PERIODS);
  assert.deepEqual(grid.ordered.map((x) => x.id), ["FY2023", "FY2024", "FY2025", "FY2026", "FY2027"]);
});

test("out-of-order dates, duplicate ids, invalid dates, and interleaved classes are rejected", () => {
  for (const bad of [
    [PERIODS[1]!, PERIODS[0]!, ...PERIODS.slice(2)],
    [PERIODS[0]!, { ...PERIODS[1]!, id: PERIODS[0]!.id }, ...PERIODS.slice(2)],
    [{ ...PERIODS[0]!, start: "2023-02-30" }, ...PERIODS.slice(1)],
    [PERIODS[0]!, PERIODS[3]!, PERIODS[1]!, PERIODS[4]!],
  ]) {
    assert.throws(
      () => buildGrid(bad),
      (error: unknown) => error instanceof FinancialModelError && error.code === "incompatible_periods",
    );
  }
});

test("at() resolves negative offsets and crosses the actual/forecast boundary", () => {
  const grid = buildGrid(PERIODS);
  assert.equal(grid.at("FY2026", -1)?.id, "FY2025");
  assert.equal(grid.at("FY2026", 0)?.id, "FY2026");
  assert.equal(grid.at("FY2027", -2)?.id, "FY2025");
});

test("at() returns undefined past either end rather than clamping", () => {
  const grid = buildGrid(PERIODS);
  assert.equal(grid.at("FY2023", -1), undefined);
  assert.equal(grid.at("FY2027", 1), undefined);
});

test("ttm periods are skipped by offsets, not counted as a step", () => {
  const ttm: Period = {
    id: "TTM",
    label: "TTM",
    start: "2025-07-01",
    end: "2026-06-30",
    cls: "ttm",
  };
  const grid = buildGrid([...PERIODS.slice(0, 3), ttm, ...PERIODS.slice(3)]);
  assert.equal(grid.positionOf("TTM"), 3, "TTM retains its explicit table position");
  assert.equal(grid.offsetIndexOf("TTM"), -1, "TTM is absent from the formula offset axis");
  assert.equal(grid.at("FY2026", -1)?.id, "FY2025");
  assert.equal(grid.at("TTM", -1), undefined, "offsets from a ttm period are undefined");
});

test("range() returns inclusive offset windows, ttm excluded", () => {
  const grid = buildGrid(PERIODS);
  assert.deepEqual(grid.range("FY2025", -2, 0).map((x) => x.id), ["FY2023", "FY2024", "FY2025"]);
  assert.deepEqual(grid.range("FY2023", -2, 0).map((x) => x.id), [], "an incomplete window yields no periods");
});
