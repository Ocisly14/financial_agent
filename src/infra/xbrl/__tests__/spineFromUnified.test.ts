import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptInventory } from "../conceptInventory.ts";
import { buildSpineFromUnified, checkSpineCompleteness, resolveDetailLineItemIds, type SpineDecision } from "../spineFromUnified.ts";
import { buildUnifiedStatements, type BreakdownRow, type UnificationDecision, type UnifiedStatementsArtifact } from "../unifiedStatements.ts";
import { fact, filing, node, period, statement } from "./spineFixture.ts";

const periods = [period("FY2024", 2024), period("FY2025", 2025)];

/** A breakdown row with every field defaulted except the ones the test cares about. */
function breakdownRow(over: Partial<BreakdownRow> & Pick<BreakdownRow, "rowId" | "parentRowId" | "axisQName" | "memberQName" | "label" | "values">): BreakdownRow {
  return { unit: null, rationale: "r", asOfDate: "2026-01-30", ...over };
}

/** A single-row unified artifact, just enough to hang breakdownRows off of "net_sales". */
function makeUnifiedWithNetSales(): UnifiedStatementsArtifact {
  const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:SalesRevenueNet", "Net sales", [fact("FY2024", 80e9), fact("FY2025", 90e9)]),
  ])])];
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    { rowId: "net_sales", statement: "income_statement", label: "Net sales", rationale: "",
      components: [{ conceptQName: "us-gaap:SalesRevenueNet", weight: 1 }] },
  ] };
  return buildUnifiedStatements({ decision, filings, requestedPeriods: periods, inventory });
}

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

test("an undeclared empty period on a required target is a coverage gap; a declared spine gap is not", () => {
  const unified = makeUnified();
  const decision: SpineDecision = {
    mappings: [
      { targetId: "revenue.total", rowIds: ["auto_revenues", "services_revenues"], rationale: "r" },
      { targetId: "cost_of_revenue", rowIds: ["cost_of_revenues"], rationale: "r" }, // FY2024 is null
    ],
    detailRows: [], excluded: [], spineGaps: [{ targetId: "debt", reason: "no debt disclosed" }],
  };
  const spineIds = new Set(["revenue.total", "cost_of_revenue", "debt"]);
  const result = buildSpineFromUnified({ decision, unified, spineIds,
    requiredIds: new Set(["revenue.total", "cost_of_revenue"]) });
  assert.deepEqual(result.coverageGaps, [{ targetId: "cost_of_revenue", periodId: "FY2024" }]);
  assert.deepEqual(result.findings, ["coverage_gap: required cost_of_revenue has no value in FY2024 and is not declared a spine gap"]);
  assert.ok(!result.facts.some((f) => f.lineItemId === "cost_of_revenue" && f.periodId === "FY2024"));

  // The same gap on an OPTIONAL target the decision DID claim is informational, not blocking.
  const optional = buildSpineFromUnified({ decision, unified, spineIds, requiredIds: new Set(["revenue.total"]) });
  assert.deepEqual(optional.coverageGaps, []);
  assert.deepEqual(optional.optionalCoverageGaps, [{ targetId: "cost_of_revenue", periodId: "FY2024" }]);
  assert.deepEqual(optional.findings, []);
});

test("an optional target nobody mapped is not a coverage gap", () => {
  const unified = makeUnified();
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["auto_revenues", "services_revenues"], rationale: "r" }],
    detailRows: [], excluded: [{ rowId: "cost_of_revenues", reason: "r" }], spineGaps: [],
  };
  // "debt" is optional and unclaimed: unused, not missing. "cost_of_revenue" likewise.
  const result = buildSpineFromUnified({ decision, unified,
    spineIds: new Set(["revenue.total", "cost_of_revenue", "debt"]), requiredIds: new Set(["revenue.total"]) });
  assert.deepEqual(result.coverageGaps, []);
  assert.deepEqual(result.findings, []);
});

test("detail rows materialize as installable line items under their parent, without coverage tracking", () => {
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
  // A revenue detail collapses onto the single `revenue` parent, because that is where the workbook
  // hangs revenue streams — there is no `revenue.total` node to parent it to.
  const services = result.facts.filter((f) => f.lineItemId === "revenue.services_revenues");
  assert.deepEqual(services.map((f) => f.factId).sort(),
    ["spine.revenue.services_revenues.FY2024", "spine.revenue.services_revenues.FY2025"]);
  assert.equal(services.find((f) => f.periodId === "FY2025")!.value, 12e9);
  // The null FY2024 detail cell produces no fact, no coverage gap, no finding.
  assert.deepEqual(result.facts.filter((f) => f.lineItemId === "revenue.cost_of_revenues").map((f) => f.periodId), ["FY2025"]);
  assert.deepEqual(result.coverageGaps, []);
  assert.deepEqual(result.findings, []);
});

test("a mapping mixing null and non-null rows sums the non-null ones without raising a finding", () => {
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
  // A null contributing row is a line the issuer stopped reporting; step 2 already reported anything
  // it genuinely failed to resolve, so there is nothing to say here.
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.coverageGaps, []);
  assert.equal(result.facts.find((f) => f.periodId === "FY2025")!.value, 155e9);
});

test("breakdown rows are rejected inside mappings", () => {
  const unified = makeUnifiedWithNetSales();
  unified.breakdownRows = [breakdownRow({ rowId: "net_sales.seg.a", parentRowId: "net_sales", axisQName: "seg",
    memberQName: "x:AMember", label: "A", values: { FY2025: 1 } })];
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales", "net_sales.seg.a"], rationale: "r" }],
    detailRows: [], excluded: [], spineGaps: [],
  };
  const findings = checkSpineCompleteness({ unified, decision, spineIds: new Set(["revenue.total"]) });
  assert.ok(findings.some((f) => f.includes("only be used as a detailRow")));
});

test("revenue detail rows from two axes raise a finding", () => {
  const unified = makeUnifiedWithNetSales();
  unified.breakdownRows = [
    breakdownRow({ rowId: "net_sales.seg.a", parentRowId: "net_sales", axisQName: "us-gaap:SegmentAxis",
      memberQName: "x:AMember", label: "A", values: { FY2025: 1 } }),
    breakdownRow({ rowId: "net_sales.channel.b", parentRowId: "net_sales", axisQName: "us-gaap:ChannelAxis",
      memberQName: "x:BMember", label: "B", values: { FY2025: 2 } }),
  ];
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "r" }],
    detailRows: [
      { parentTargetId: "revenue.total", rowId: "net_sales.seg.a", rationale: "r" },
      { parentTargetId: "revenue.total", rowId: "net_sales.channel.b", rationale: "r" },
    ],
    excluded: [], spineGaps: [],
  };
  const findings = checkSpineCompleteness({ unified, decision, spineIds: new Set(["revenue.total"]) });
  assert.ok(findings.some((f) => f.includes("single axis")));
});

test("revenue detail rows from two axes raise a finding even split across 'revenue' and 'revenue.total' parents", () => {
  // detailLineItemId collapses every revenue-ish parentTargetId onto the single `revenue` node, so the
  // single-axis guard has to group them the same way, or two spellings of "under revenue" dodge it.
  const unified = makeUnifiedWithNetSales();
  unified.breakdownRows = [
    breakdownRow({ rowId: "net_sales.seg.a", parentRowId: "net_sales", axisQName: "us-gaap:SegmentAxis",
      memberQName: "x:AMember", label: "A", values: { FY2025: 1 } }),
    breakdownRow({ rowId: "net_sales.channel.b", parentRowId: "net_sales", axisQName: "us-gaap:ChannelAxis",
      memberQName: "x:BMember", label: "B", values: { FY2025: 2 } }),
  ];
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "r" }],
    detailRows: [
      { parentTargetId: "revenue", rowId: "net_sales.seg.a", rationale: "r" },
      { parentTargetId: "revenue.total", rowId: "net_sales.channel.b", rationale: "r" },
    ],
    excluded: [], spineGaps: [],
  };
  const findings = checkSpineCompleteness({ unified, decision, spineIds: new Set(["revenue.total"]) });
  assert.ok(findings.some((f) => f.includes("single axis")), findings.join("\n"));
});

test("revenue streams mirror the member tree: a piece nests under its chosen parent's stream", () => {
  const unified = makeUnifiedWithNetSales();
  unified.breakdownRows = [
    breakdownRow({ rowId: "net_sales.seg.product", parentRowId: "net_sales", axisQName: "us-gaap:SegmentAxis",
      memberQName: "x:ProductMember", label: "Product", values: { FY2024: 3, FY2025: 3 } }),
    breakdownRow({ rowId: "net_sales.seg.phone", parentRowId: "net_sales", axisQName: "us-gaap:SegmentAxis",
      memberQName: "x:PhoneMember", label: "Phone", values: { FY2024: 2, FY2025: 2 }, parentMemberQName: "x:ProductMember" }),
    breakdownRow({ rowId: "net_sales.seg.service", parentRowId: "net_sales", axisQName: "us-gaap:SegmentAxis",
      memberQName: "x:ServiceMember", label: "Service", values: { FY2024: 1, FY2025: 1 } }),
  ];
  const nested: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "r" }],
    detailRows: [
      { parentTargetId: "revenue", rowId: "net_sales.seg.product", rationale: "r" },
      { parentTargetId: "revenue", rowId: "net_sales.seg.phone", rationale: "r" },
      { parentTargetId: "revenue", rowId: "net_sales.seg.service", rationale: "r" },
    ],
    excluded: [], spineGaps: [],
  };
  assert.deepEqual(resolveDetailLineItemIds(nested, unified), {
    "net_sales.seg.product": "revenue.product",
    "net_sales.seg.phone": "revenue.product.phone",
    "net_sales.seg.service": "revenue.service",
  });
  const findings = checkSpineCompleteness({ unified, decision: nested, spineIds: new Set(["revenue.total"]) });
  assert.ok(!findings.some((f) => f.includes("nest")), findings.join("\n"));
  const result = buildSpineFromUnified({ decision: nested, unified, spineIds: new Set(["revenue.total"]) });
  assert.deepEqual(result.facts.filter((f) => f.lineItemId?.startsWith("revenue.pro")).map((f) => f.lineItemId).sort(),
    ["revenue.product", "revenue.product", "revenue.product.phone", "revenue.product.phone"]);
});

test("a piece whose parent member was not chosen becomes a top-level stream", () => {
  const unified = makeUnifiedWithNetSales();
  unified.breakdownRows = [
    breakdownRow({ rowId: "net_sales.seg.phone", parentRowId: "net_sales", axisQName: "us-gaap:SegmentAxis",
      memberQName: "x:PhoneMember", label: "Phone", values: { FY2025: 2 }, parentMemberQName: "x:ProductMember" }),
  ];
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "r" }],
    detailRows: [{ parentTargetId: "revenue", rowId: "net_sales.seg.phone", rationale: "r" }],
    excluded: [], spineGaps: [],
  };
  assert.deepEqual(resolveDetailLineItemIds(decision, unified), { "net_sales.seg.phone": "revenue.phone" });
});

test("a breakdown detailRow materializes staged facts from its stored values, with a non-empty asOfDate", () => {
  const unified = makeUnifiedWithNetSales();
  unified.breakdownRows = [breakdownRow({ rowId: "net_sales.seg.a", parentRowId: "net_sales", axisQName: "seg",
    memberQName: "x:AMember", label: "A", values: { FY2025: 1 }, asOfDate: "2026-03-15" })];
  const result = buildSpineFromUnified({ decision: {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "r" }],
    detailRows: [{ parentTargetId: "revenue", rowId: "net_sales.seg.a", rationale: "r" }],
    excluded: [], spineGaps: [] }, unified, spineIds: new Set(["revenue.total"]) });
  const detail = result.facts.find((f) => f.lineItemId === "revenue.a");
  assert.ok(detail);
  assert.equal(detail!.value, 1);
  assert.deepEqual(detail!.provenance.sourceRefs, []);
  // A breakdown row has no unified fact to draw provenance from — it must fall back to the row's own
  // asOfDate, never the empty string (an empty asOfDate fails snapshotCodec.normalizeProvenance).
  assert.equal(detail!.provenance.asOfDate, "2026-03-15");
});

test("a breakdown rowId inside a mapping is excluded from the mapping's sum, not merely flagged", () => {
  // checkSpineCompleteness raises a finding for this, and the delivery tools ship a dirty decision
  // after maxRuns anyway — the exclusion from the sum has to be mechanical here, independent of the
  // finding being resolved.
  const unified = makeUnifiedWithNetSales();
  unified.breakdownRows = [breakdownRow({ rowId: "net_sales.seg.a", parentRowId: "net_sales", axisQName: "seg",
    memberQName: "x:AMember", label: "A", values: { FY2025: 1 } })];
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales", "net_sales.seg.a"], rationale: "r" }],
    detailRows: [], excluded: [], spineGaps: [],
  };
  const result = buildSpineFromUnified({ decision, unified, spineIds: new Set(["revenue.total"]) });
  const fy2025 = result.facts.find((f) => f.lineItemId === "revenue.total" && f.periodId === "FY2025");
  assert.ok(fy2025);
  // net_sales alone is 90e9; had the breakdown slice also summed in, this would be 90e9 + 1.
  assert.equal(fy2025!.value, 90e9);
});

test("unplaced breakdown rows are not findings", () => {
  const unified = makeUnifiedWithNetSales();
  unified.breakdownRows = [breakdownRow({ rowId: "net_sales.seg.a", parentRowId: "net_sales", axisQName: "seg",
    memberQName: "x:AMember", label: "A", values: { FY2025: 1 } })];
  const decision: SpineDecision = {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "r" }],
    detailRows: [], excluded: [], spineGaps: [],
  };
  const findings = checkSpineCompleteness({ unified, decision, spineIds: new Set(["revenue.total"]) });
  assert.deepEqual(findings, []);
});
