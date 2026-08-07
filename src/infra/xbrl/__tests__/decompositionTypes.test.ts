import assert from "node:assert/strict";
import test from "node:test";
import { mintTableFactId, mintTableFacts } from "../decompositionTypes.ts";
import { filingTable } from "../../../agent/financial-modeling/__tests__/curationFixtures.ts";

test("mintTableFactId is stable and shaped like staged fact ids", () => {
  const id = mintTableFactId("acc-1", "t1", 3, "FY2025", "c-9");
  assert.equal(id, mintTableFactId("acc-1", "t1", 3, "FY2025", "c-9"));
  assert.match(id, /^xbrl-[0-9a-f]{24}$/);
  assert.notEqual(id, mintTableFactId("acc-2", "t1", 3, "FY2025", "c-9"));
});

test("mintTableFacts mints one fact per fact-bearing cell with provenance coordinates", () => {
  const table = filingTable({ sourceTableId: "seg-1", heading: "Net sales by product", rowLabels: ["iPhone", "Mac"] });
  const minted = mintTableFacts(table);
  assert.equal(minted.length, 2);
  const first = minted[0]!;
  assert.equal(first.sourceTableId, "seg-1");
  assert.equal(first.rowOrder, 1);
  assert.equal(first.accession, table.accession);
  assert.equal(first.filedAt, table.filedAt);
  assert.equal(first.value, 100);
  assert.equal(first.factId, mintTableFactId(table.accession, "seg-1", 1, first.periodId, first.contextId));
});
