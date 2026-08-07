import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDecompositionStore, SqliteDecompositionStore, type DecompositionStore } from "../decompositionStore.ts";
import type { CandidateScheme, FilingDecompositionProposal, MintedTableFact } from "../decompositionTypes.ts";

const proposal: FilingDecompositionProposal = { accession: "acc-1", rationale: "r", sourceRefs: [], schemes: [
  { schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis", targetSourceLineItemId: "row-rev",
    children: [{ label: "iPhone", factRefs: [{ factId: "xbrl-a", periodId: "FY2025" }] }] }] };
const minted: MintedTableFact = { factId: "xbrl-a", accession: "acc-1", filedAt: "2025-10-01", sourceTableId: "t1", rowOrder: 1,
  periodId: "FY2025", contextId: "c1", value: 5, unit: { kind: "currency", code: "USD" }, dimensions: [],
  conceptQName: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", sourceAnchor: "#a" };
const candidate: CandidateScheme = { candidateSchemeId: "cs1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
  targetSourceLineItemId: "row-rev", children: [], periodIds: ["FY2025"], coverage: {}, residualRatioByPeriod: {}, flags: [], openQuestions: [] };

function exercise(store: DecompositionStore): void {
  store.saveMapProposal("run1", proposal);
  store.saveMintedFacts("run1", [minted]);
  store.saveCandidates("run1", [candidate]);
  store.saveChildMerge("run1", { candidateSchemeId: "cs1", keepChildId: "a", mergeChildIds: ["b"] });
  store.saveReduceDecision("run1", { ranked: ["cs1"], driverSchemeId: "cs1", rationale: "best coverage" });
  store.saveFinalDecision("run1", { acceptedSchemeIds: ["cs1"], driverSchemeId: "cs1", decidedBy: "parent", rationale: "ok" });
  store.saveDiagnostics("run1", ["decomposition_scheme_rejected acc-1/s1: no children"]);
  assert.deepEqual(store.listMapProposals("run1"), [proposal]);
  assert.deepEqual(store.listMintedFacts("run1"), [minted]);
  assert.deepEqual(store.listCandidates("run1"), [candidate]);
  assert.equal(store.listChildMerges("run1").length, 1);
  assert.equal(store.getReduceDecision("run1")?.driverSchemeId, "cs1");
  assert.equal(store.getFinalDecision("run1")?.decidedBy, "parent");
  assert.deepEqual(store.listDiagnostics("run1"), ["decomposition_scheme_rejected acc-1/s1: no children"]);
  assert.deepEqual(store.listMapProposals("other"), []);
  assert.equal(store.getReduceDecision("other"), undefined);
  assert.deepEqual(store.listDiagnostics("other"), []);
  // Upsert: same key overwrites, does not duplicate.
  store.saveMintedFacts("run1", [minted]);
  assert.equal(store.listMintedFacts("run1").length, 1);
  store.saveDiagnostics("run1", ["only_this"]);
  assert.deepEqual(store.listDiagnostics("run1"), ["only_this"]);
}

test("in-memory decomposition store round-trips all artifact kinds", () => exercise(new InMemoryDecompositionStore()));

test("sqlite decomposition store round-trips all artifact kinds", () => {
  const store = SqliteDecompositionStore.open(join(mkdtempSync(join(tmpdir(), "decomp-")), "d.sqlite"));
  try { exercise(store); } finally { store.close(); }
});
