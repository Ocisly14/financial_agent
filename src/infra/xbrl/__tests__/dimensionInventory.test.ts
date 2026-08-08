import assert from "node:assert/strict";
import test from "node:test";
import { buildAxisCatalog, buildAxisBreakdown } from "../dimensionInventory.ts";
import type { FilingTable } from "../tableTypes.ts";
import type { FilingTableFactOccurrence, XbrlDimension } from "../types.ts";
import { period } from "./spineFixture.ts";

const SEG = "us-gaap:StatementBusinessSegmentsAxis";
const REV = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
const USD = { kind: "currency", code: "USD" } as const;

function dim(member: string, memberLabel: string, axis = SEG): XbrlDimension {
  return { axisQName: axis, axisLabel: "Segments", memberQName: member, memberLabel };
}
function dimFact(concept: string, periodId: string, value: number, dims: XbrlDimension[], htmlOrder = 1): FilingTableFactOccurrence {
  return { occurrenceId: `${concept}|${periodId}|${dims.map((d) => d.memberQName).join(",")}|${htmlOrder}`,
    conceptQName: concept, conceptLabel: concept, htmlOrder, contextId: "c", periodId, value,
    unit: USD, decimals: -6, dimensions: dims, sourceAnchor: "#f" };
}
function table(over: Partial<FilingTable> & { accession: string; filedAt: string; facts: FilingTableFactOccurrence[] }): FilingTable {
  const { facts, ...rest } = over;
  return { sourceTableId: `${over.accession}-t1`, form: "10-K", reportDate: over.filedAt,
    heading: "Segment information", htmlOrder: 5, sourceAnchor: "#t1",
    prescreen: { tier: "weak", presentationOverlap: 0, dimensionlessRatio: 0, periodSpan: 2, factCount: facts.length },
    suggestedStatements: [], columns: [],
    rows: [{ order: 1, labelText: "Revenue", indentLevel: 0, cells: facts.map((fact, index) => ({ columnIndex: index + 1, text: String(fact.value), fact })) }],
    ...rest };
}

const periods = [period("FY2024", 2024), period("FY2025", 2025)];

test("buildAxisCatalog aggregates axes with member samples and top concepts", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:BMember", "Segment B")]),
    dimFact("us-gaap:OperatingIncomeLoss", "FY2025", 10e9, [dim("x:AMember", "Segment A")]),
  ] });
  const catalog = buildAxisCatalog({ tables: [t], requestedPeriods: periods });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.axisQName, SEG);
  assert.equal(catalog[0]!.memberCount, 2);
  assert.deepEqual(catalog[0]!.concepts.map((c) => c.conceptQName), [REV, "us-gaap:OperatingIncomeLoss"]);
  assert.deepEqual(catalog[0]!.periodCoverage, ["FY2025"]);
});

test("buildAxisBreakdown resolves latest-filing-wins per member per period", () => {
  const older = table({ accession: "acc-2024", filedAt: "2025-01-30", facts: [
    dimFact(REV, "FY2024", 55e9, [dim("x:AMember", "Segment A")]),
  ] });
  const latest = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2024", 56e9, [dim("x:AMember", "Segment A")]), // 重述，应赢
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
  ] });
  const breakdown = buildAxisBreakdown({ tables: [older, latest], requestedPeriods: periods, axisQName: SEG, conceptQName: REV });
  assert.equal(breakdown.members.length, 1);
  assert.deepEqual(breakdown.members[0]!.values, { FY2024: 56e9, FY2025: 60e9 });
  assert.deepEqual(breakdown.unit, USD);
});

test("buildAxisBreakdown prefers the fact with fewest dimensions", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 61e9, [dim("x:AMember", "Segment A"),
      dim("us-gaap:OperatingSegmentsMember", "Operating", "us-gaap:ConsolidationItemsAxis")]),
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
  ] });
  const breakdown = buildAxisBreakdown({ tables: [t], requestedPeriods: periods, axisQName: SEG, conceptQName: REV });
  assert.equal(breakdown.members[0]!.values["FY2025"], 60e9);
});

test("buildAxisBreakdown truncates at maxMembers and flags it", () => {
  const facts = Array.from({ length: 30 }, (_, i) =>
    dimFact(REV, "FY2025", 1e9 + i, [dim(`x:M${i}Member`, `M${i}`)], i + 1));
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts });
  const breakdown = buildAxisBreakdown({ tables: [t], requestedPeriods: periods, axisQName: SEG, conceptQName: REV, maxMembers: 25 });
  assert.equal(breakdown.members.length, 25);
  assert.equal(breakdown.truncated, true);
});

test("buildAxisBreakdown filters members by label or QName substring, case-insensitively", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:ProductsMember", "Products")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:ServicesMember", "Services")]),
    dimFact(REV, "FY2025", 5e9, [dim("x:OtherMember", "Other revenue")]),
  ] });
  const byLabel = buildAxisBreakdown({ tables: [t], requestedPeriods: periods, axisQName: SEG, conceptQName: REV, memberFilter: "serv" });
  assert.deepEqual(byLabel.members.map((m) => m.memberQName), ["x:ServicesMember"]);
  const byQName = buildAxisBreakdown({ tables: [t], requestedPeriods: periods, axisQName: SEG, conceptQName: REV, memberFilter: "OTHERMEMBER" });
  assert.deepEqual(byQName.members.map((m) => m.memberLabel), ["Other revenue"]);
});

test("buildAxisBreakdown pages with cursor and reports nextCursor only while truncated", () => {
  const facts = Array.from({ length: 30 }, (_, i) =>
    dimFact(REV, "FY2025", 1e9 + i, [dim(`x:M${i}Member`, `M${i}`)], i + 1));
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts });
  const first = buildAxisBreakdown({ tables: [t], requestedPeriods: periods, axisQName: SEG, conceptQName: REV, maxMembers: 25 });
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, 25);
  const second = buildAxisBreakdown({ tables: [t], requestedPeriods: periods, axisQName: SEG, conceptQName: REV, maxMembers: 25, cursor: first.nextCursor! });
  assert.equal(second.members.length, 5);
  assert.equal(second.members[0]!.memberQName, "x:M25Member");
  assert.equal(second.truncated, false);
  assert.equal(second.nextCursor, undefined);
});

import { materializeBreakdowns, MAX_BREAKDOWN_ROWS } from "../dimensionInventory.ts";
import type { UnificationDecision } from "../unifiedStatements.ts";

function decisionWith(breakdowns: NonNullable<UnificationDecision["rows"][number]["breakdowns"]>): UnificationDecision {
  return { rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales",
    components: [{ conceptQName: REV, weight: 1 }], rationale: "face line", breakdowns }] };
}

test("materializeBreakdowns builds member rows under the parent rowId", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:ProductsMember", "Products")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:ServicesMember", "Services")]),
  ] });
  const { breakdownRows, findings } = materializeBreakdowns({
    decision: decisionWith([{ axisQName: SEG, conceptQName: REV, rationale: "segment split" }]),
    tables: [t], requestedPeriods: periods });
  assert.deepEqual(findings, []);
  assert.deepEqual(breakdownRows.map((r) => r.rowId),
    ["net_sales.statementbusinesssegments.products", "net_sales.statementbusinesssegments.services"]);
  assert.equal(breakdownRows[0]!.parentRowId, "net_sales");
  assert.equal(breakdownRows[0]!.values["FY2025"], 60e9);
});

test("materializeBreakdowns caps axes per row at 3 with a finding", () => {
  const axes = ["a:A1Axis", "a:A2Axis", "a:A3Axis", "a:A4Axis"].map((axisQName) =>
    ({ axisQName, conceptQName: REV, rationale: "r" }));
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts:
    axes.map((a, i) => dimFact(REV, "FY2025", 1e9, [dim(`x:M${i}Member`, `M${i}`, a.axisQName)])) });
  const { breakdownRows, findings } = materializeBreakdowns({
    decision: decisionWith(axes), tables: [t], requestedPeriods: periods });
  assert.equal(new Set(breakdownRows.map((r) => r.axisQName)).size, 3);
  assert.equal(findings.filter((f) => f.includes("more than 3 axes")).length, 1);
});

test("materializeBreakdowns de-duplicates a rowId collision from declaring the same axis twice", () => {
  // The ≤3-axes cap counts declared entries, not distinct axes: a row can legally declare
  // {SEG, Revenues} and {SEG, OperatingIncomeLoss} — same axis, different concept — which would
  // otherwise mint the identical `net_sales.statementbusinesssegments.products` rowId twice with two
  // different values, leaving the spine agent unable to address either one unambiguously.
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:ProductsMember", "Products")]),
    dimFact("us-gaap:OperatingIncomeLoss", "FY2025", 5e9, [dim("x:ProductsMember", "Products")]),
  ] });
  const { breakdownRows, findings } = materializeBreakdowns({
    decision: decisionWith([
      { axisQName: SEG, conceptQName: REV, rationale: "segment revenue split" },
      { axisQName: SEG, conceptQName: "us-gaap:OperatingIncomeLoss", rationale: "segment operating income split" },
    ]),
    tables: [t], requestedPeriods: periods });
  assert.deepEqual(breakdownRows.map((r) => r.rowId), ["net_sales.statementbusinesssegments.products"]);
  // First occurrence wins: the Revenues-sourced row, not the OperatingIncomeLoss one.
  assert.equal(breakdownRows[0]!.values["FY2025"], 60e9);
  assert.ok(findings.some((f) => f.includes("duplicate breakdown rowId")), findings.join("\n"));
});

const TREE_FACTS = [
  dimFact(REV, "FY2025", 100e9, [dim("x:ProductMember", "Product")], 1),
  dimFact(REV, "FY2025", 60e9, [dim("x:PhoneMember", "Phone")], 2),
  dimFact(REV, "FY2025", 40e9, [dim("x:TabletMember", "Tablet")], 3),
  dimFact(REV, "FY2025", 50e9, [dim("x:ServiceMember", "Service")], 4),
];

test("materializeBreakdowns validates a declared member tree bottom-up within ±10%", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: TREE_FACTS });
  const decision = decisionWith([{ axisQName: SEG, conceptQName: REV, rationale: "mix", members: [
    { memberQName: "x:ProductMember" }, { memberQName: "x:ServiceMember" },
    { memberQName: "x:PhoneMember", parentMemberQName: "x:ProductMember" },
    { memberQName: "x:TabletMember", parentMemberQName: "x:ProductMember" },
  ] }]);
  const { breakdownRows, findings } = materializeBreakdowns({ decision, tables: [t], requestedPeriods: periods,
    parentValues: { net_sales: { FY2025: 150e9 } } });
  assert.deepEqual(findings, []);
  assert.equal(breakdownRows.length, 4);
  assert.equal(breakdownRows.find((r) => r.memberQName === "x:PhoneMember")!.parentMemberQName, "x:ProductMember");
});

test("a declared tree whose children do not sum to their parent raises a finding", () => {
  const facts = [...TREE_FACTS.slice(0, 2), dimFact(REV, "FY2025", 20e9, [dim("x:TabletMember", "Tablet")], 3), TREE_FACTS[3]!];
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts });
  const decision = decisionWith([{ axisQName: SEG, conceptQName: REV, rationale: "mix", members: [
    { memberQName: "x:ProductMember" }, { memberQName: "x:ServiceMember" },
    { memberQName: "x:PhoneMember", parentMemberQName: "x:ProductMember" },
    { memberQName: "x:TabletMember", parentMemberQName: "x:ProductMember" },
  ] }]);
  const { findings } = materializeBreakdowns({ decision, tables: [t], requestedPeriods: periods,
    parentValues: { net_sales: { FY2025: 130e9 } } });
  assert.equal(findings.filter((f) => f.includes("x:ProductMember") && f.includes("80%")).length, 1);
});

test("flat breakdowns that overshoot the parent row ask for a declared structure", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: TREE_FACTS });
  const decision = decisionWith([{ axisQName: SEG, conceptQName: REV, rationale: "mix" }]);
  const { findings } = materializeBreakdowns({ decision, tables: [t], requestedPeriods: periods,
    parentValues: { net_sales: { FY2025: 150e9 } } });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /167%/);
  assert.match(findings[0]!, /parentMemberQName/);
});

test("a member declared with an unknown parent raises a finding and stays a root", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: TREE_FACTS });
  const decision = decisionWith([{ axisQName: SEG, conceptQName: REV, rationale: "mix", members: [
    { memberQName: "x:ProductMember" }, { memberQName: "x:PhoneMember", parentMemberQName: "x:NopeMember" },
  ] }]);
  const { breakdownRows, findings } = materializeBreakdowns({ decision, tables: [t], requestedPeriods: periods });
  assert.equal(breakdownRows.length, 2);
  assert.ok(findings.some((f) => f.includes("x:NopeMember")));
});

test("declared members restrict materialization to the list", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: TREE_FACTS });
  const decision = decisionWith([{ axisQName: SEG, conceptQName: REV, rationale: "mix", members: [
    { memberQName: "x:ProductMember" }, { memberQName: "x:ServiceMember" },
  ] }]);
  const { breakdownRows, findings } = materializeBreakdowns({ decision, tables: [t], requestedPeriods: periods,
    parentValues: { net_sales: { FY2025: 150e9 } } });
  assert.deepEqual(findings, []);
  assert.deepEqual(breakdownRows.map((r) => r.memberQName), ["x:ProductMember", "x:ServiceMember"]);
});

test("materializeBreakdowns reports an axis/concept with no facts", () => {
  const { breakdownRows, findings } = materializeBreakdowns({
    decision: decisionWith([{ axisQName: SEG, conceptQName: "us-gaap:Nothing", rationale: "r" }]),
    tables: [], requestedPeriods: periods });
  assert.deepEqual(breakdownRows, []);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /no facts/);
});
