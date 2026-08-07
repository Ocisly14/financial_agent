import assert from "node:assert/strict";
import test from "node:test";
import type { PresentedNode, PresentedStatement } from "../presentedStatement.ts";
import type { CalculationRelation } from "../types.ts";
import { verifyPresentedStatement } from "../verifyPresentedStatement.ts";

let nextId = 0;
function node(conceptQName: string, values: Record<string, number>, abstract = false): PresentedNode {
  return {
    nodeId: nextId++, parentNodeId: null, conceptQName, label: conceptQName, abstract,
    valueByPeriod: new Map(Object.entries(values).map(([periodId, value]) => [periodId, {
      periodId, value, unit: { kind: "currency" as const, code: "USD" }, decimals: -6,
      contextId: `c-${periodId}`, sourceAnchor: "https://example.test#f", dimensions: [],
    }])),
    ambiguousPeriodIds: [],
  };
}

function statement(nodes: PresentedNode[], periodIds = ["FY2025"]): PresentedStatement {
  return { accession: "acc-1", statement: "balance_sheet", roleUri: "role:bs",
    roleLabel: "Consolidated Balance Sheets", nodes, periodIds };
}

const rollup = (parentConcept: string, children: string[]): CalculationRelation => ({
  roleUri: "role:bs", parentConcept,
  children: children.map((concept, index) => ({ concept, weight: 1, order: index })),
});

test("a roll-up whose children sum to the parent produces no break", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:AssetsCurrent", { FY2025: 30 }), node("us-gaap:Cash", { FY2025: 10 }), node("us-gaap:Inventory", { FY2025: 20 })]),
    [rollup("us-gaap:AssetsCurrent", ["us-gaap:Cash", "us-gaap:Inventory"])],
  );

  assert.deepEqual(result.rollupBreaks, []);
});

test("a missing child is reported with the difference and the absent concept", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:AssetsCurrent", { FY2025: 30 }), node("us-gaap:Cash", { FY2025: 10 })]),
    [rollup("us-gaap:AssetsCurrent", ["us-gaap:Cash", "us-gaap:Inventory"])],
  );

  assert.equal(result.rollupBreaks.length, 1);
  assert.deepEqual([result.rollupBreaks[0]!.reported, result.rollupBreaks[0]!.computed, result.rollupBreaks[0]!.difference], [30, 10, 20]);
  assert.deepEqual(result.rollupBreaks[0]!.missingChildren, ["us-gaap:Inventory"]);
});

test("a negative weight subtracts", () => {
  const relation: CalculationRelation = { roleUri: "role:bs", parentConcept: "ex:Net",
    children: [{ concept: "ex:Gross", weight: 1, order: 0 }, { concept: "ex:Allowance", weight: -1, order: 1 }] };
  const result = verifyPresentedStatement(
    statement([node("ex:Net", { FY2025: 90 }), node("ex:Gross", { FY2025: 100 }), node("ex:Allowance", { FY2025: 10 })]),
    [relation],
  );

  assert.deepEqual(result.rollupBreaks, []);
});

test("relations belonging to another role are ignored", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:InventoryNet", { FY2025: 20 })]),
    [{ roleUri: "role:inventory-note", parentConcept: "us-gaap:InventoryNet",
       children: [{ concept: "us-gaap:InventoryRawMaterialsNetOfReserves", weight: 1, order: 0 }] }],
  );

  assert.deepEqual(result.rollupBreaks, []);
});

test("assets equal to liabilities and equity passes; unequal is reported", () => {
  const ok = verifyPresentedStatement(
    statement([node("us-gaap:Assets", { FY2025: 100 }), node("us-gaap:LiabilitiesAndStockholdersEquity", { FY2025: 100 })]), []);
  assert.deepEqual(ok.balanceBreaks, []);

  const bad = verifyPresentedStatement(
    statement([node("us-gaap:Assets", { FY2025: 100 }), node("us-gaap:LiabilitiesAndStockholdersEquity", { FY2025: 97 })]), []);
  assert.equal(bad.balanceBreaks.length, 1);
  assert.equal(bad.balanceBreaks[0]!.difference, 3);
});

test("an untagged LiabilitiesAndStockholdersEquity is skipped without a break", () => {
  const result = verifyPresentedStatement(statement([node("us-gaap:Assets", { FY2025: 100 })]), []);
  assert.deepEqual(result.balanceBreaks, []);
});

test("a period in which only a non-total node carries a fact is not reported as covered", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:AssetsCurrent", { FY2025: 30 }), node("us-gaap:Cash", { FY2024: 5, FY2025: 30 })], ["FY2024", "FY2025"]),
    [rollup("us-gaap:AssetsCurrent", ["us-gaap:Cash"])],
  );

  assert.deepEqual(result.reportedPeriodIds, ["FY2025"]);
  assert.equal(result.totalsUnavailable, false);
});

test("without calculation relations there are no totals, so coverage falls back and says so", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:Cash", { FY2024: 5 }), node("ex:Abstract", {}, true)], ["FY2024", "FY2025"]), []);

  assert.equal(result.totalsUnavailable, true);
  assert.deepEqual(result.reportedPeriodIds, ["FY2024"]);
  assert.deepEqual(result.rollupBreaks, []);
});
