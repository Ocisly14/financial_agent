import assert from "node:assert/strict";
import test from "node:test";
import { runFilingDecompositionLoop } from "../filingDecompositionLoop.ts";
import { InMemoryFilingTableStore } from "../../../infra/xbrl/filingTableStore.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { mintTableFactId, type MintedTableFact } from "../../../infra/xbrl/decompositionTypes.ts";
import { filingTable } from "./curationFixtures.ts";

function scripted(responses: string[]): ModelRouter {
  let call = 0;
  const provider: LlmProvider = { name: "scripted", generate: async () => ({ text: responses[Math.min(call++, responses.length - 1)]!,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  return new ModelRouter(provider);
}

test("map loop reads a table, mints fact ids, and returns a validated proposal", async () => {
  const store = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1", heading: "Net sales by product", rowLabels: ["iPhone", "Mac"] });
  store.saveTables("run1", [table]);
  const minted: MintedTableFact[] = [];
  const expectedFactId = mintTableFactId(table.accession, "seg-1", 1, "FY2025", "c-FY2025");
  const proposal = await runFilingDecompositionLoop({
    modelRouter: scripted([
      JSON.stringify({ action: "call_tool", calls: [{ tool: "list_table_rows", input: { sourceTableId: "seg-1" } }] }),
      JSON.stringify({ action: "call_tool", calls: [{ tool: "get_table_facts", input: { sourceTableId: "seg-1", rowOrders: [1, 2] } }] }),
      JSON.stringify({ rationale: "found product split", sourceRefs: [], payload: { schemes: [{ schemeId: "s1", label: "by product",
        axisHint: "presentation-only", targetSourceLineItemId: "row-rev",
        children: [{ label: "iPhone", factRefs: [{ factId: expectedFactId, periodId: "FY2025" }] }] }] } }),
    ]),
    runId: "run1", accession: table.accession, tableStore: store,
    faceRows: [{ sourceLineItemId: "row-rev", title: "Net sales", conceptQName: "us-gaap:Revenues" }],
    requestedPeriodIds: ["FY2025"], onMintedFacts: (facts) => minted.push(...facts),
    task: "decompose revenue", systemPrompt: "map agent" });
  assert.equal(proposal.accession, table.accession);
  assert.equal(proposal.schemes.length, 1);
  assert.equal(minted.length, 2, "get_table_facts minted both requested rows");
  assert.ok(minted.some((fact) => fact.factId === expectedFactId));
});

test("empty schemes is a legal result and malformed payloads throw", async () => {
  const store = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1" });
  store.saveTables("run1", [table]);
  const base = { runId: "run1", accession: table.accession, tableStore: store,
    faceRows: [{ sourceLineItemId: "row-rev", title: "Net sales", conceptQName: "us-gaap:Revenues" }],
    requestedPeriodIds: ["FY2025"], onMintedFacts: () => {}, task: "t", systemPrompt: "p" } as const;
  const empty = await runFilingDecompositionLoop({ ...base,
    modelRouter: scripted([JSON.stringify({ rationale: "nothing splittable", sourceRefs: [], payload: { schemes: [] } })]) });
  assert.deepEqual(empty.schemes, []);
  await assert.rejects(runFilingDecompositionLoop({ ...base,
    modelRouter: scripted([JSON.stringify({ rationale: "bad", sourceRefs: [], payload: { schemes: [{ nope: true }] } })]) }),
  /schemes/);
});
