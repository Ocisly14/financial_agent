import assert from "node:assert/strict";
import test from "node:test";
import { runRevenueDecomposition } from "../revenueDecomposition.ts";
import { InMemoryDecompositionStore } from "../../../infra/xbrl/decompositionStore.ts";
import { InMemoryFilingTableStore } from "../../../infra/xbrl/filingTableStore.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { mintTableFactId } from "../../../infra/xbrl/decompositionTypes.ts";
import { shortHash } from "../../../infra/xbrl/decompositionAnalysis.ts";
import { filingTable } from "./curationFixtures.ts";
import type { SourceReviewArtifact } from "../../../infra/xbrl/sourceReviewStore.ts";
import type { FilingTable } from "../../../infra/xbrl/tableTypes.ts";

// Build one filing whose segment table is discoverable, plus a source review with
// a face revenue row. Reuse the artifact shape from materializeDecomposition.test.ts,
// with filings: [{ accession: table.accession, form: "10-K", filedAt: table.filedAt,
// reportDate: table.reportDate, primaryDocumentUrl: "https://example.test/doc" }].
// (Face fact valued 205 so children 100+101 leave residual 4 ≈ 2%.)
function artifact(table: FilingTable): SourceReviewArtifact {
  const period = { id: "FY2025", label: "FY2025", start: "2024-09-29", end: "2025-09-27", cls: "actual" as const };
  return {
    ingestionRunId: "run1",
    filings: [{ accession: table.accession, form: "10-K", filedAt: table.filedAt, reportDate: table.reportDate, primaryDocumentUrl: "https://example.test/doc" }],
    facts: [
      { factId: "xbrl-face", status: "staged", lineItemId: "row-rev", periodId: "FY2025", value: 205,
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

test("orchestrator runs map agents per filing, validates, builds candidates, and reduces", async () => {
  const tableStore = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1", heading: "Net sales by product", rowLabels: ["iPhone", "Mac"] });
  // Fixture concepts are us-gaap:Row1/Row2 — override to revenue concepts so validation passes:
  for (const row of table.rows) for (const cell of row.cells) if (cell.fact) cell.fact.conceptQName = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
  tableStore.saveTables("run1", [table]);
  const store = new InMemoryDecompositionStore();
  const factId = (order: number) => mintTableFactId(table.accession, "seg-1", order, "FY2025", "c-FY2025");
  const candidateSchemeId = `cs-${shortHash("row-rev|presentation-only|by product")}`;
  let call = 0;
  const responses = [
    JSON.stringify({ action: "call_tool", calls: [{ tool: "get_table_facts", input: { sourceTableId: "seg-1", rowOrders: [1, 2] } }] }),
    JSON.stringify({ rationale: "product split", sourceRefs: [], payload: { schemes: [{ schemeId: "s1", label: "by product",
      axisHint: "presentation-only", targetSourceLineItemId: "row-rev", children: [
        { label: "iPhone", factRefs: [{ factId: factId(1), periodId: "FY2025" }] },
        { label: "Mac", factRefs: [{ factId: factId(2), periodId: "FY2025" }] }] }] } }),
    JSON.stringify({ rationale: "only one scheme", sourceRefs: [], payload: { ranked: [candidateSchemeId], driverSchemeId: candidateSchemeId } }),
  ];
  const provider: LlmProvider = { name: "scripted", generate: async () => ({ text: responses[Math.min(call++, responses.length - 1)]!,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  const result = await runRevenueDecomposition({ modelRouter: new ModelRouter(provider), sourceReview: artifact(table),
    tableStore, store, mapPrompt: "map", reducePrompt: "reduce", task: "decompose" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.decision?.driverSchemeId, result.candidates[0]!.candidateSchemeId);
  assert.equal(store.listMapProposals("run1").length, 1);
  assert.ok(store.listMintedFacts("run1").length >= 2);
  assert.deepEqual(store.listDiagnostics("run1"), result.diagnostics, "diagnostics are persisted for the run");
});

test("a failed map agent degrades to a diagnostic and zero candidates skip reduce", async () => {
  const tableStore = new InMemoryFilingTableStore();
  const store = new InMemoryDecompositionStore();
  const provider: LlmProvider = { name: "explode", generate: async () => { throw new Error("provider down"); } };
  const result = await runRevenueDecomposition({ modelRouter: new ModelRouter(provider),
    sourceReview: artifact(filingTable({ sourceTableId: "seg-1" })), tableStore, store,
    mapPrompt: "map", reducePrompt: "reduce", task: "decompose" });
  assert.equal(result.decision, null);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.diagnostics.some((line) => line.startsWith("filing_decomposition_failed")));
  assert.ok(result.diagnostics.includes("no_decomposition_candidates"));
  assert.deepEqual(store.listDiagnostics("run1"), result.diagnostics, "the zero-candidate path persists diagnostics too");
});
