import assert from "node:assert/strict";
import test from "node:test";
import { applyChildMerges, buildCandidateSchemes, isRevenueFamilyConcept, validateFilingSchemes } from "../decompositionAnalysis.ts";
import type { FilingDecompositionProposal, MintedTableFact } from "../decompositionTypes.ts";

function minted(overrides: Partial<MintedTableFact>): MintedTableFact {
  return { factId: "xbrl-a", accession: "acc-1", filedAt: "2025-10-01", sourceTableId: "t1", rowOrder: 1, periodId: "FY2025",
    contextId: "c1", value: 100, unit: { kind: "currency", code: "USD" },
    dimensions: [{ axisQName: "srt:ProductOrServiceAxis", axisLabel: "Product", memberQName: "aapl:IPhoneMember", memberLabel: "iPhone" }],
    conceptQName: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", sourceAnchor: "#a", ...overrides };
}
function proposal(overrides: Partial<FilingDecompositionProposal["schemes"][number]>): FilingDecompositionProposal {
  return { accession: "acc-1", rationale: "r", sourceRefs: [], schemes: [{ schemeId: "s1", label: "by product",
    axisHint: "srt:ProductOrServiceAxis", targetSourceLineItemId: "row-rev",
    children: [{ label: "iPhone", memberHint: "aapl:IPhoneMember", factRefs: [{ factId: "xbrl-a", periodId: "FY2025" }] }], ...overrides }] };
}
const faceRows = new Map([["row-rev", { conceptQName: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" }]]);

test("revenue family accepts us-gaap revenue concepts and calc-connected concepts", () => {
  assert.ok(isRevenueFamilyConcept("us-gaap:Revenues", "us-gaap:Revenues", []));
  assert.ok(isRevenueFamilyConcept("us-gaap:SalesRevenueNet", "us-gaap:Revenues", []));
  assert.ok(isRevenueFamilyConcept("aapl:CustomConcept", "us-gaap:Revenues",
    [{ roleUri: "r", parentConcept: "us-gaap:Revenues", children: [{ concept: "aapl:CustomConcept", weight: 1, order: 1 }] }]));
  assert.equal(isRevenueFamilyConcept("us-gaap:CostOfRevenue", "us-gaap:Revenues", []), false);
});

test("a fully resolvable scheme validates unchanged", () => {
  const result = validateFilingSchemes({ proposal: proposal({}), minted: new Map([["xbrl-a", minted({})]]), faceRows, calculationRelations: [] });
  assert.equal(result.schemes.length, 1);
  assert.deepEqual(result.diagnostics, []);
});

test("an unknown factId rejects the whole scheme with a diagnostic", () => {
  const result = validateFilingSchemes({ proposal: proposal({ children: [{ label: "iPhone", factRefs: [{ factId: "xbrl-missing", periodId: "FY2025" }] }] }),
    minted: new Map([["xbrl-a", minted({})]]), faceRows, calculationRelations: [] });
  assert.equal(result.schemes.length, 0);
  assert.match(result.diagnostics[0]!, /unknown factId/);
});

test("a non-revenue concept and a missing axis dimension each reject the scheme", () => {
  const wrongConcept = validateFilingSchemes({ proposal: proposal({}),
    minted: new Map([["xbrl-a", minted({ conceptQName: "us-gaap:CostOfRevenue" })]]), faceRows, calculationRelations: [] });
  assert.equal(wrongConcept.schemes.length, 0);
  const wrongAxis = validateFilingSchemes({ proposal: proposal({}),
    minted: new Map([["xbrl-a", minted({ dimensions: [] })]]), faceRows, calculationRelations: [] });
  assert.equal(wrongAxis.schemes.length, 0);
});

test("presentation-only schemes need no dimensions and unknown target rows reject", () => {
  const ok = validateFilingSchemes({ proposal: proposal({ axisHint: "presentation-only" }),
    minted: new Map([["xbrl-a", minted({ dimensions: [] })]]), faceRows, calculationRelations: [] });
  assert.equal(ok.schemes.length, 1);
  const badTarget = validateFilingSchemes({ proposal: proposal({ targetSourceLineItemId: "row-nope" }),
    minted: new Map([["xbrl-a", minted({})]]), faceRows, calculationRelations: [] });
  assert.equal(badTarget.schemes.length, 0);
});

function validatedFiling(accession: string, filedAt: string, factId: string, childLabel: string, periodId: string) {
  return { accession, filedAt, schemes: [{ schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
    targetSourceLineItemId: "row-rev", children: [{ label: childLabel, memberHint: "aapl:IPhoneMember",
      factRefs: [{ factId, periodId }] }] }] };
}

test("children align across filings and the newest filedAt supplies each period", () => {
  const mintedMap = new Map([
    ["xbrl-old", minted({ factId: "xbrl-old", accession: "acc-1", filedAt: "2024-10-01", value: 90, periodId: "FY2024" })],
    ["xbrl-dup", minted({ factId: "xbrl-dup", accession: "acc-2", filedAt: "2025-10-01", value: 91, periodId: "FY2024" })],
    ["xbrl-new", minted({ factId: "xbrl-new", accession: "acc-2", filedAt: "2025-10-01", value: 120, periodId: "FY2025" })],
  ]);
  const candidates = buildCandidateSchemes({
    validated: [
      validatedFiling("acc-1", "2024-10-01", "xbrl-old", "iPhone", "FY2024"),
      { accession: "acc-2", filedAt: "2025-10-01", schemes: [{ schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
        targetSourceLineItemId: "row-rev", children: [{ label: "iPhone ", memberHint: "aapl:IPhoneMember",
          factRefs: [{ factId: "xbrl-dup", periodId: "FY2024" }, { factId: "xbrl-new", periodId: "FY2025" }] }] }] },
    ],
    minted: mintedMap, requestedPeriodIds: ["FY2024", "FY2025"],
    faceValues: new Map([["row-rev", new Map([["FY2024", 91], ["FY2025", 150]])]]),
  });
  assert.equal(candidates.length, 1);
  const scheme = candidates[0]!;
  assert.equal(scheme.children.length, 1, "same member across filings is one child");
  const child = scheme.children[0]!;
  assert.equal(child.cells["FY2024"]!.value, 91, "newer filedAt wins FY2024");
  assert.equal(child.cells["FY2025"]!.value, 120);
  assert.deepEqual(scheme.coverage[child.childId], ["FY2024", "FY2025"]);
  assert.equal(scheme.residualRatioByPeriod["FY2024"], 0, "91 of 91");
  assert.equal(scheme.residualRatioByPeriod["FY2025"], 0.2, "|150-120|/150");
});

test("high residual flags the scheme and missing face value yields null ratio", () => {
  const mintedMap = new Map([["xbrl-a", minted({ value: 10 })]]);
  const candidates = buildCandidateSchemes({ validated: [validatedFiling("acc-1", "2025-10-01", "xbrl-a", "iPhone", "FY2025")],
    minted: mintedMap, requestedPeriodIds: ["FY2024", "FY2025"],
    faceValues: new Map([["row-rev", new Map([["FY2025", 100]])]]) });
  const scheme = candidates[0]!;
  assert.ok(scheme.flags.includes("residual_ratio_above_30pct"));
  assert.equal(scheme.residualRatioByPeriod["FY2024"], null);
});

test("applyChildMerges folds cells in, lets the newest filing win, and re-derives the scheme", () => {
  const mintedMap = new Map([
    ["xbrl-a", minted({ factId: "xbrl-a", accession: "acc-1", filedAt: "2024-10-01", value: 10, periodId: "FY2024" })],
    ["xbrl-b", minted({ factId: "xbrl-b", accession: "acc-2", filedAt: "2025-10-01", value: 12, periodId: "FY2025", contextId: "c2" })],
    ["xbrl-c", minted({ factId: "xbrl-c", accession: "acc-2", filedAt: "2025-10-01", value: 11, periodId: "FY2024", contextId: "c3" })],
  ]);
  const faceValues = new Map([["row-rev", new Map([["FY2024", 11], ["FY2025", 12]])]]);
  const candidates = buildCandidateSchemes({ validated: [
    { accession: "acc-1", filedAt: "2024-10-01", schemes: [{ schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
      targetSourceLineItemId: "row-rev", children: [{ label: "Wearables", factRefs: [{ factId: "xbrl-a", periodId: "FY2024" }] }] }] },
    { accession: "acc-2", filedAt: "2025-10-01", schemes: [{ schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
      targetSourceLineItemId: "row-rev", children: [{ label: "Wearables, Home and Accessories",
        factRefs: [{ factId: "xbrl-c", periodId: "FY2024" }, { factId: "xbrl-b", periodId: "FY2025" }] }] }] },
  ], minted: mintedMap, requestedPeriodIds: ["FY2024", "FY2025"], faceValues });
  const scheme = candidates[0]!;
  assert.equal(scheme.children.length, 2, "different labels stay separate before merge");
  assert.equal(scheme.openQuestions.length, 1, "the two labels look like the same line");
  assert.ok(scheme.flags.includes("residual_ratio_above_30pct"), "double counting FY2024 before the merge");
  const [keep, merge] = scheme.children.map((child) => child.childId);
  const record = { candidateSchemeId: scheme.candidateSchemeId, keepChildId: keep!, mergeChildIds: [merge!] };
  const merged = applyChildMerges(candidates, [record], faceValues)[0]!;
  const child = merged.children.find((candidateChild) => candidateChild.childId === keep)!;
  assert.equal(merged.children.length, 1);
  assert.equal(child.cells["FY2024"]!.value, 11, "newest filedAt wins the merge conflict");
  assert.equal(child.cells["FY2025"]!.value, 12);
  assert.deepEqual(merged.coverage[keep!], ["FY2024", "FY2025"]);
  assert.equal(merged.residualRatioByPeriod["FY2024"], 0, "residual recomputed after the merge");
  assert.deepEqual(merged.flags, [], "the stale high-residual flag is dropped");
  assert.deepEqual(merged.openQuestions, [], "the resolved ambiguity disappears");
  // Without faceValues the ratios are left alone, but coverage/flags/openQuestions still refresh.
  const noFace = applyChildMerges(candidates, [record])[0]!;
  assert.deepEqual(noFace.residualRatioByPeriod, scheme.residualRatioByPeriod);
  assert.deepEqual(noFace.openQuestions, []);
});

test("presentation-only schemes group by label while dimension-backed schemes group by axis", () => {
  const mintedMap = new Map([
    ["xbrl-p", minted({ factId: "xbrl-p", dimensions: [], value: 10 })],
    ["xbrl-g", minted({ factId: "xbrl-g", dimensions: [], value: 20 })],
  ]);
  const presentationScheme = (label: string, childLabel: string, factId: string) => ({ schemeId: "s1", label,
    axisHint: "presentation-only", targetSourceLineItemId: "row-rev",
    children: [{ label: childLabel, factRefs: [{ factId, periodId: "FY2025" }] }] });
  const split = buildCandidateSchemes({ validated: [{ accession: "acc-1", filedAt: "2025-10-01", schemes: [
    presentationScheme("Net sales by product", "iPhone", "xbrl-p"),
    presentationScheme("Net sales by geography", "Americas", "xbrl-g")] }],
    minted: mintedMap, requestedPeriodIds: ["FY2025"], faceValues: new Map() });
  assert.equal(split.length, 2, "different presentation-only labels are different candidates");

  const acrossFilings = buildCandidateSchemes({ validated: [
    { accession: "acc-1", filedAt: "2024-10-01", schemes: [presentationScheme("Net sales by product", "iPhone", "xbrl-p")] },
    { accession: "acc-2", filedAt: "2025-10-01", schemes: [presentationScheme("Net Sales By Product", "Americas", "xbrl-g")] },
  ], minted: mintedMap, requestedPeriodIds: ["FY2025"], faceValues: new Map() });
  assert.equal(acrossFilings.length, 1, "the same presentation-only label still groups across filings");
  assert.equal(acrossFilings[0]!.children.length, 2);
});
