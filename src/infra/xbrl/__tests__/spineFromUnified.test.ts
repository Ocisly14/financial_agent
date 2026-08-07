import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptInventory } from "../conceptInventory.ts";
import { buildSpineFromUnified, checkSpineCompleteness, type SpineDecision } from "../spineFromUnified.ts";
import { buildUnifiedStatements, type UnificationDecision, type UnifiedStatementsArtifact } from "../unifiedStatements.ts";
import { fact, filing, node, period, statement } from "./spineFixture.ts";

const periods = [period("FY2024", 2024), period("FY2025", 2025)];

/** Built through the real ① → ②/③ pipeline: cost_of_revenues is FY2025-only, so its FY2024 cell is null. */
function makeUnified(): UnifiedStatementsArtifact {
  const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:AutomotiveRevenues", "Automotive revenues", [fact("FY2024", 80e9), fact("FY2025", 90e9)]),
    node(1, null, "us-gaap:OtherSalesRevenueNet", "Services revenues", [fact("FY2024", 10e9), fact("FY2025", 12e9)]),
    node(2, null, "us-gaap:CostOfRevenue", "Cost of revenues", [fact("FY2025", 65e9)]),
  ])])];
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    { rowId: "auto_revenues", statement: "income_statement", label: "Automotive revenues", rationale: "",
      components: [{ conceptQName: "us-gaap:AutomotiveRevenues", weight: 1 }] },
    { rowId: "services_revenues", statement: "income_statement", label: "Services revenues", rationale: "",
      components: [{ conceptQName: "us-gaap:OtherSalesRevenueNet", weight: 1 }] },
    { rowId: "cost_of_revenues", statement: "income_statement", label: "Cost of revenues", rationale: "",
      components: [{ conceptQName: "us-gaap:CostOfRevenue", weight: 1 }] },
  ] };
  return buildUnifiedStatements({ decision, filings, requestedPeriods: periods, inventory });
}

test("completeness passes when every row is placed and every spine id is mapped or gap-declared", () => {
  const unified = makeUnified();
  const decision: SpineDecision = {
    mappings: [
      { targetId: "revenue.total", rowIds: ["auto_revenues", "services_revenues"], rationale: "top line" },
      { targetId: "cost_of_revenue", rowIds: ["cost_of_revenues"], rationale: "direct" },
    ],
    detailRows: [{ parentTargetId: "revenue.total", rowId: "services_revenues", rationale: "segment worth modeling" }],
    excluded: [],
    spineGaps: [],
  };
  assert.deepEqual(checkSpineCompleteness({ unified, decision, spineIds: new Set(["revenue.total", "cost_of_revenue"]) }), []);
});

test("completeness flags every failure class", () => {
  const unified = makeUnified();
  const decision: SpineDecision = {
    mappings: [
      // ghost_row is unknown; auto_revenues will double-place via excluded.
      { targetId: "revenue.total", rowIds: ["auto_revenues", "ghost_row"], rationale: "r" },
      // Unknown spine id + empty rowIds.
      { targetId: "bogus.target", rowIds: [], rationale: "r" },
    ],
    detailRows: [{ parentTargetId: "nope", rowId: "ghost_detail", rationale: "r" }],
    excluded: [{ rowId: "auto_revenues", reason: "dup" }],
    // revenue.total is both mapped and gap-declared; unknown.gap is not a spine id;
    // services_revenues/cost_of_revenues stay dangling; debt is neither mapped nor a gap.
    spineGaps: [{ targetId: "revenue.total", reason: "r" }, { targetId: "unknown.gap", reason: "r" }],
  };
  const findings = checkSpineCompleteness({ unified, decision, spineIds: new Set(["revenue.total", "cost_of_revenue", "debt"]) });
  const expect = (needle: string) => assert.ok(findings.some((f) => f.includes(needle)), `missing "${needle}" in:\n${findings.join("\n")}`);
  expect(`unknown rowId "ghost_row"`);
  expect(`unknown rowId "ghost_detail"`);
  expect(`unknown spine id "bogus.target"`);
  expect(`mapping for "bogus.target" has no rowIds`);
  expect(`unknown parentTargetId "nope"`);
  expect(`double-placement: unified row "auto_revenues"`);
  expect(`dangling: unified row "services_revenues"`);
  expect(`dangling: unified row "cost_of_revenues"`);
  expect(`spine id "revenue.total" is both mapped and declared a gap`);
  expect(`spine id "debt" is neither mapped nor declared a gap`);
  expect(`spineGaps declares unknown spine id "unknown.gap"`);
});

test("a mapping sums its unified rows and chains provenance to the unified facts", () => {
  const unified = makeUnified();
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["auto_revenues", "services_revenues"], rationale: "r" }],
    detailRows: [], excluded: [{ rowId: "cost_of_revenues", reason: "not modeled" }], spineGaps: [],
  };
  const result = buildSpineFromUnified({ decision, unified, spineIds: new Set(["revenue.total"]) });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.coverageGaps, []);
  assert.equal(result.facts.length, 2);
  const fy2025 = result.facts.find((f) => f.periodId === "FY2025")!;
  assert.equal(fy2025.factId, "spine.revenue.total.FY2025");
  assert.equal(fy2025.lineItemId, "revenue.total");
  assert.equal(fy2025.status, "staged");
  assert.equal(fy2025.value, 102e9);
  assert.deepEqual(fy2025.unit, { kind: "currency", code: "USD" });
  assert.equal(fy2025.provenance.sourceType, "unified_statements");
  assert.deepEqual(fy2025.provenance.sourceRefs,
    ["unified.income_statement.auto_revenues.FY2025", "unified.income_statement.services_revenues.FY2025"]);
  assert.equal(fy2025.provenance.asOfDate, "2026-01-30");
  assert.equal(fy2025.provenance.concept, "auto_revenues+services_revenues");
  assert.equal(result.facts.find((f) => f.periodId === "FY2024")!.value, 90e9);
});

test("an undeclared empty period is a coverage gap; a declared spine gap is not", () => {
  const unified = makeUnified();
  const decision: SpineDecision = {
    mappings: [
      { targetId: "revenue.total", rowIds: ["auto_revenues", "services_revenues"], rationale: "r" },
      { targetId: "cost_of_revenue", rowIds: ["cost_of_revenues"], rationale: "r" }, // FY2024 is null
    ],
    detailRows: [], excluded: [], spineGaps: [{ targetId: "debt", reason: "no debt disclosed" }],
  };
  const result = buildSpineFromUnified({ decision, unified, spineIds: new Set(["revenue.total", "cost_of_revenue", "debt"]) });
  assert.deepEqual(result.coverageGaps, [{ targetId: "cost_of_revenue", periodId: "FY2024" }]);
  assert.deepEqual(result.findings, ["coverage_gap: cost_of_revenue has no value in FY2024 and is not declared a spine gap"]);
  assert.ok(!result.facts.some((f) => f.lineItemId === "cost_of_revenue" && f.periodId === "FY2024"));
});

test("detail rows materialize under detail ids without coverage tracking", () => {
  const unified = makeUnified();
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["auto_revenues", "services_revenues"], rationale: "r" }],
    detailRows: [
      { parentTargetId: "revenue.total", rowId: "services_revenues", rationale: "segment" },
      { parentTargetId: "revenue.total", rowId: "cost_of_revenues", rationale: "contrived null-year detail" },
    ],
    excluded: [{ rowId: "cost_of_revenues", reason: "kept only as detail" }], spineGaps: [],
  };
  const result = buildSpineFromUnified({ decision, unified, spineIds: new Set(["revenue.total"]) });
  const services = result.facts.filter((f) => f.lineItemId === "detail.revenue.total.services_revenues");
  assert.deepEqual(services.map((f) => f.factId).sort(),
    ["spine.detail.revenue.total.services_revenues.FY2024", "spine.detail.revenue.total.services_revenues.FY2025"]);
  assert.equal(services.find((f) => f.periodId === "FY2025")!.value, 12e9);
  // The null FY2024 detail cell produces no fact, no coverage gap, no finding.
  assert.deepEqual(result.facts.filter((f) => f.lineItemId === "detail.revenue.total.cost_of_revenues").map((f) => f.periodId), ["FY2025"]);
  assert.deepEqual(result.coverageGaps, []);
  assert.deepEqual(result.findings, []);
});

test("a mapping mixing null and non-null rows sums the non-null ones and flags a partial sum", () => {
  const unified = makeUnified();
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["auto_revenues", "cost_of_revenues"], rationale: "contrived" }],
    detailRows: [], excluded: [{ rowId: "services_revenues", reason: "r" }], spineGaps: [],
  };
  const result = buildSpineFromUnified({ decision, unified, spineIds: new Set(["revenue.total"]) });
  const fy2024 = result.facts.find((f) => f.periodId === "FY2024")!;
  assert.equal(fy2024.value, 80e9); // cost_of_revenues is null in FY2024
  assert.deepEqual(fy2024.provenance.sourceRefs, ["unified.income_statement.auto_revenues.FY2024"]);
  assert.equal(fy2024.provenance.concept, "auto_revenues+cost_of_revenues");
  assert.ok(result.findings.some((f) => f.startsWith("partial_sum:") && f.includes("FY2024") && f.includes("cost_of_revenues")),
    result.findings.join("\n"));
  assert.deepEqual(result.coverageGaps, []);
  assert.equal(result.facts.find((f) => f.periodId === "FY2025")!.value, 155e9);
});
