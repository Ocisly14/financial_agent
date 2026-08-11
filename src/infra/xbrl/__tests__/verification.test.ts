import assert from "node:assert/strict";
import test from "node:test";
import { verifyCalculationRollups } from "../verification.ts";
import type { CalculationRelation } from "../types.ts";
import type { FilingTable } from "../tableTypes.ts";

function table(facts: Array<{ concept: string; value: number; periodId: string }>): FilingTable {
  return {
    sourceTableId: "acc:html-table:1", accession: "acc", form: "10-K", filedAt: "2026-01-29",
    reportDate: "2025-12-31", heading: "CONSOLIDATED BALANCE SHEETS", htmlOrder: 1,
    sourceAnchor: "https://example.test/a.htm#table=1",
    prescreen: { tier: "strong", presentationOverlap: 1, dimensionlessRatio: 1, periodSpan: 1, factCount: facts.length },
    suggestedStatements: ["balance_sheet"],
    columns: [{ index: 0, headerText: "", isLabelColumn: true }, { index: 1, headerText: "2025", periodId: "FY2025", isLabelColumn: false }],
    rows: facts.map((entry, index) => ({
      order: index + 1, labelText: entry.concept, indentLevel: 0,
      cells: [{ columnIndex: 0, text: entry.concept }, {
        columnIndex: 1, text: String(entry.value),
        fact: {
          occurrenceId: `occ-${index}`, conceptQName: entry.concept, conceptLabel: entry.concept,
          contextId: "c1", periodId: entry.periodId, value: entry.value, unit: { kind: "currency", code: "USD" },
          dimensions: [], sourceAnchor: "https://example.test/a.htm#f1", htmlOrder: index + 1,
        },
      }],
    })),
  };
}

const rollup: CalculationRelation = {
  roleUri: "http://example.test/role/BalanceSheet",
  parentConcept: "us-gaap:Assets",
  children: [
    { concept: "us-gaap:AssetsCurrent", weight: 1, order: 1 },
    { concept: "us-gaap:AssetsNoncurrent", weight: 1, order: 2 },
  ],
};

test("a face table whose children sum to the parent reports no calculation break", () => {
  const breaks = verifyCalculationRollups([table([
    { concept: "us-gaap:Assets", value: 300, periodId: "FY2025" },
    { concept: "us-gaap:AssetsCurrent", value: 120, periodId: "FY2025" },
    { concept: "us-gaap:AssetsNoncurrent", value: 180, periodId: "FY2025" },
  ])], [rollup]);

  assert.deepEqual(breaks, []);
});

test("a face table whose children miss the parent reports the concept and the difference", () => {
  const breaks = verifyCalculationRollups([table([
    { concept: "us-gaap:Assets", value: 300, periodId: "FY2025" },
    { concept: "us-gaap:AssetsCurrent", value: 120, periodId: "FY2025" },
    { concept: "us-gaap:AssetsNoncurrent", value: 175, periodId: "FY2025" },
  ])], [rollup]);

  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]!.parentConcept, "us-gaap:Assets");
  assert.equal(breaks[0]!.periodId, "FY2025");
  assert.equal(breaks[0]!.reported, 300);
  assert.equal(breaks[0]!.computed, 295);
  assert.equal(breaks[0]!.difference, 5);
});

test("negative weights subtract rather than add", () => {
  const netRollup: CalculationRelation = {
    roleUri: "http://example.test/role/Income", parentConcept: "us-gaap:GrossProfit",
    children: [
      { concept: "us-gaap:Revenues", weight: 1, order: 1 },
      { concept: "us-gaap:CostOfRevenue", weight: -1, order: 2 },
    ],
  };
  const breaks = verifyCalculationRollups([table([
    { concept: "us-gaap:GrossProfit", value: 40, periodId: "FY2025" },
    { concept: "us-gaap:Revenues", value: 100, periodId: "FY2025" },
    { concept: "us-gaap:CostOfRevenue", value: 60, periodId: "FY2025" },
  ])], [netRollup]);

  assert.deepEqual(breaks, []);
});

test("a roll-up whose parent is absent from the table is not checked", () => {
  const breaks = verifyCalculationRollups([table([
    { concept: "us-gaap:AssetsCurrent", value: 120, periodId: "FY2025" },
    { concept: "us-gaap:AssetsNoncurrent", value: 175, periodId: "FY2025" },
  ])], [rollup]);

  assert.deepEqual(breaks, []);
});

test("a roll-up with no child present in the table is not checked", () => {
  const breaks = verifyCalculationRollups([table([
    { concept: "us-gaap:Assets", value: 300, periodId: "FY2025" },
  ])], [rollup]);

  assert.deepEqual(breaks, []);
});

test("a partially tagged roll-up is checked, so a missing child surfaces as a break", () => {
  const breaks = verifyCalculationRollups([table([
    { concept: "us-gaap:Assets", value: 300, periodId: "FY2025" },
    { concept: "us-gaap:AssetsCurrent", value: 120, periodId: "FY2025" },
  ])], [rollup]);

  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]!.difference, 180);
  assert.deepEqual(breaks[0]!.missingChildren, ["us-gaap:AssetsNoncurrent"]);
});

test("rounding inside XBRL tolerance is not a break", () => {
  const breaks = verifyCalculationRollups([table([
    { concept: "us-gaap:Assets", value: 300_000_000_000, periodId: "FY2025" },
    { concept: "us-gaap:AssetsCurrent", value: 120_000_000_000, periodId: "FY2025" },
    { concept: "us-gaap:AssetsNoncurrent", value: 180_000_000_001, periodId: "FY2025" },
  ])], [rollup]);

  assert.deepEqual(breaks, []);
});

test("each period is checked independently", () => {
  const multi = table([
    { concept: "us-gaap:Assets", value: 300, periodId: "FY2025" },
    { concept: "us-gaap:AssetsCurrent", value: 120, periodId: "FY2025" },
    { concept: "us-gaap:AssetsNoncurrent", value: 180, periodId: "FY2025" },
    { concept: "us-gaap:Assets", value: 250, periodId: "FY2024" },
    { concept: "us-gaap:AssetsCurrent", value: 100, periodId: "FY2024" },
    { concept: "us-gaap:AssetsNoncurrent", value: 140, periodId: "FY2024" },
  ]);
  const breaks = verifyCalculationRollups([multi], [rollup]);

  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]!.periodId, "FY2024");
  assert.equal(breaks[0]!.difference, 10);
});

test("dimensional facts do not participate in the consolidated roll-up", () => {
  const withSegment = table([
    { concept: "us-gaap:Assets", value: 300, periodId: "FY2025" },
    { concept: "us-gaap:AssetsCurrent", value: 120, periodId: "FY2025" },
    { concept: "us-gaap:AssetsNoncurrent", value: 180, periodId: "FY2025" },
  ]);
  withSegment.rows.push({
    order: 4, labelText: "us-gaap:AssetsCurrent", indentLevel: 1,
    cells: [{ columnIndex: 0, text: "Americas" }, {
      columnIndex: 1, text: "50",
      fact: {
        occurrenceId: "occ-seg", conceptQName: "us-gaap:AssetsCurrent", conceptLabel: "Assets, Current",
        contextId: "c-seg", periodId: "FY2025", value: 50, unit: { kind: "currency", code: "USD" },
        dimensions: [{ axisQName: "us-gaap:StatementBusinessSegmentsAxis", axisLabel: "Segment",
          memberQName: "aapl:AmericasMember", memberLabel: "Americas" }],
        sourceAnchor: "https://example.test/a.htm#f-seg", htmlOrder: 4,
      },
    }],
  });

  assert.deepEqual(verifyCalculationRollups([withSegment], [rollup]), []);
});
