import assert from "node:assert/strict";
import test from "node:test";
import { materializeDecomposition } from "../materializeDecomposition.ts";
import type { SourceReviewArtifact } from "../sourceReviewStore.ts";
import type { CandidateScheme } from "../decompositionTypes.ts";

function artifact(): SourceReviewArtifact {
  const period = { id: "FY2025", label: "FY2025", start: "2024-09-29", end: "2025-09-27", cls: "actual" as const };
  return {
    ingestionRunId: "run1", filings: [], facts: [
      { factId: "xbrl-face", status: "staged", lineItemId: "row-rev", periodId: "FY2025", value: 100,
        unit: { kind: "currency", code: "USD" }, provenance: { sourceType: "filing_xbrl", sourceRefs: ["#rev"], asOfDate: "2025-10-01" } },
    ],
    statementViews: { income_statement: { candidate: { periods: [period], rows: [
      { sourceLineItemId: "row-rev", statement: "income_statement", label: "Net sales", unit: { kind: "currency", code: "USD" },
        order: 1, conceptQName: "us-gaap:Revenues", dimensionSignature: "", dimensions: [], depth: 0, presentationAccessions: [] },
    ] }, filingPresentations: [] },
      balance_sheet: { candidate: { periods: [period], rows: [] }, filingPresentations: [] },
      cash_flow_statement: { candidate: { periods: [period], rows: [] }, filingPresentations: [] } },
    coverage: { requestedPeriodIds: ["FY2025"], statements: [], issues: [] },
    dimensionalDisclosures: [], curatedTables: [], curations: [],
  } as unknown as SourceReviewArtifact;
}
const scheme: CandidateScheme = { candidateSchemeId: "cs-1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
  targetSourceLineItemId: "row-rev", periodIds: ["FY2025"], flags: [], openQuestions: [],
  children: [
    { childId: "ch-a", label: "iPhone", cells: { FY2025: { factId: "xbrl-i", value: 60, accession: "acc", filedAt: "2025-10-01", sourceAnchor: "#i" } } },
    { childId: "ch-b", label: "Mac", cells: { FY2025: { factId: "xbrl-m", value: 30, accession: "acc", filedAt: "2025-10-01", sourceAnchor: "#m" } } },
  ],
  coverage: { "ch-a": ["FY2025"], "ch-b": ["FY2025"] }, residualRatioByPeriod: { FY2025: 0.1 } };

test("accepted schemes materialize child rows, staged facts, a residual child, and the summary", () => {
  const result = materializeDecomposition({ artifact: artifact(), candidates: [scheme],
    decision: { acceptedSchemeIds: ["cs-1"], driverSchemeId: "cs-1", decidedBy: "parent", rationale: "ok" } });
  const rows = result.statementViews.income_statement.candidate.rows;
  const childRows = rows.filter((row) => row.parentSourceLineItemId === "row-rev");
  assert.equal(childRows.length, 3, "iPhone + Mac + residual (10% > 0.5%)");
  assert.ok(childRows.every((row) => row.sourceLineItemId.startsWith("source.income_statement.revenue.cs_1.")));
  const residualRow = childRows.find((row) => row.label === "Other / unallocated")!;
  const residualFact = result.facts.find((fact) => fact.lineItemId === residualRow.sourceLineItemId)!;
  assert.equal(residualFact.value, 10, "100 - 90");
  assert.equal(residualFact.provenance.sourceType, "derived_residual");
  const iphoneFact = result.facts.find((fact) => fact.factId === "xbrl-i")!;
  assert.equal(iphoneFact.status, "staged");
  assert.equal(result.decomposition?.schemes[0]?.driver, true);
  assert.equal(result.decomposition?.schemes[0]?.children.length, 3);
  // Input untouched:
  assert.equal(artifact().facts.length, 1);
});

test("re-applying replaces the previous materialization instead of accumulating rows and facts", () => {
  const decision = { acceptedSchemeIds: ["cs-1"], driverSchemeId: "cs-1", decidedBy: "parent" as const, rationale: "ok" };
  const once = materializeDecomposition({ artifact: artifact(), candidates: [scheme], decision });
  const twice = materializeDecomposition({ artifact: once, candidates: [scheme], decision });
  assert.equal(twice.statementViews.income_statement.candidate.rows.length,
    once.statementViews.income_statement.candidate.rows.length);
  assert.equal(twice.facts.length, once.facts.length);
  assert.equal(twice.statementViews.income_statement.candidate.rows.filter((row) => row.parentSourceLineItemId === "row-rev").length, 3);
  assert.equal(twice.decomposition?.schemes[0]?.children.length, 3);
  assert.equal(twice.facts.filter((fact) => fact.provenance.sourceType === "derived_residual").length, 1);
  assert.equal(twice.facts.filter((fact) => fact.factId === "xbrl-face").length, 1, "face facts survive");
});

test("a tiny residual generates no residual child and unknown scheme ids throw", () => {
  const nearExact = structuredClone(scheme);
  nearExact.children[1]!.cells["FY2025"]!.value = 39.9; // residual 0.1 of 100 = 0.1% < 0.5%
  const result = materializeDecomposition({ artifact: artifact(), candidates: [nearExact],
    decision: { acceptedSchemeIds: ["cs-1"], driverSchemeId: null, decidedBy: "parent", rationale: "ok" } });
  const childRows = result.statementViews.income_statement.candidate.rows.filter((row) => row.parentSourceLineItemId === "row-rev");
  assert.equal(childRows.length, 2);
  assert.throws(() => materializeDecomposition({ artifact: artifact(), candidates: [scheme],
    decision: { acceptedSchemeIds: ["cs-missing"], driverSchemeId: null, decidedBy: "parent", rationale: "" } }), /unknown candidateSchemeId/);
});
