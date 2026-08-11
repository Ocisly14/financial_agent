import assert from "node:assert/strict";
import test from "node:test";
import { extractFilingInsights } from "../extractor.ts";
import { InMemoryFilingInsightStore } from "../store.ts";
import { chunkFilingDocument, normalizeFilingDocument } from "../chunker.ts";
import type { FilingDocument } from "../types.ts";

const DOCUMENTS: FilingDocument[] = [{ filing: { accession: "a1", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31",
  primaryDocumentUrl: "https://sec.test/a1.htm" }, text: "ITEM 1. BUSINESS\nCloud revenue increased to $60 million.\n\nNOTE 2. REVENUE\nRevenue is recognized over time." }];

test("insights are source anchored, stored outside model facts, and projected compactly", async () => {
  const store = new InMemoryFilingInsightStore();
  const context = await extractFilingInsights({ modelId: "m1", documents: DOCUMENTS, store, generate: async () => ({ insights: [{
    topic: "Revenue recognition", summary: "Cloud revenue is recognized over time.", importanceReason: "Relevant to forecast timing",
    periodRefs: ["FY2025"], conceptRefs: ["us-gaap:Revenue"], relatedSourceLineItemIds: [], shortEvidence: "$60 million; recognized over time",
    confidence: "high",
  }] }) });
  assert.equal(context.coverage.status, "complete");
  assert.ok(context.insights.every((insight) => insight.sourceAnchor.contentHash.length === 64));
  assert.equal("shortEvidence" in context.insights[0]!, false, "normal context stays compact");
  const detail = store.getDetail(context.insightSetId, context.insights[0]!.insightId)!;
  assert.match(detail.shortEvidence, /60 million/);
  assert.match(detail.sourceChunk.content, /Cloud revenue/);
  assert.equal(JSON.stringify(context).includes('"value":60'), false, "narrative numbers are not calculation facts");
});

test("chunk failures are non-blocking and coverage is partial or unavailable", async () => {
  const store = new InMemoryFilingInsightStore();
  const context = await extractFilingInsights({ modelId: "m1", documents: DOCUMENTS, store,
    generate: async () => { throw new Error("small model down"); } });
  assert.equal(context.coverage.status, "unavailable");
  assert.ok(context.coverage.failedChunks > 0);
  assert.deepEqual(context.insights, []);
  assert.equal(store.getFailures(context.insightSetId)[0]?.attemptCount, 1);
  assert.ok(store.getRun(context.insightSetId));
});

test("a later immutable run retries failed hashes while reusing successful hashes", async () => {
  const documents = [
    { ...DOCUMENTS[0]!, text: "ITEM 1. BUSINESS\nAlpha." },
    { filing: { ...DOCUMENTS[0]!.filing, accession: "a2" }, text: "NOTE 2. REVENUE\nBeta." },
  ];
  const store = new InMemoryFilingInsightStore();
  let calls = 0;
  const generate = async (content: string) => {
    calls += 1;
    if (content.includes("Beta") && calls < 3) throw new Error("temporary");
    return { insights: [] };
  };
  const first = await extractFilingInsights({ modelId: "m1", documents, store, generate });
  const firstCalls = calls;
  assert.equal(first.coverage.status, "partial");
  const second = await extractFilingInsights({ modelId: "m1", documents, store, generate });
  assert.equal(calls, firstCalls + 1, "only the failed content hash is rerun");
  assert.notEqual(store.getRun(first.insightSetId)?.runId, store.getRun(second.insightSetId)?.runId);
  assert.equal(second.coverage.status, "complete");
});

test("HTML is projected deterministically with Item/Note/table structure and real anchors", () => {
  const html = "<html><body><h1>ITEM 1. BUSINESS</h1><p>Cloud &amp; services</p><h2>NOTE 2. REVENUE</h2><table><tr><th>Year</th><th>Revenue</th></tr><tr><td>2025</td><td>100</td></tr></table></body></html>";
  const normalized = normalizeFilingDocument(html);
  assert.match(normalized, /ITEM 1\. BUSINESS/);
  assert.match(normalized, /TABLE 1/);
  assert.match(normalized, /Year \| Revenue/);
  const chunks = chunkFilingDocument({ filing: DOCUMENTS[0]!.filing, text: html });
  assert.ok(chunks.every((chunk) => chunk.sourceAnchor.startOffset !== undefined && chunk.sourceAnchor.contentHash.length === 64));
});

test("zero chunks are unavailable and related source IDs are mechanically linked, never trusted from model output", async () => {
  const empty = await extractFilingInsights({ modelId: "m1", documents: [{ ...DOCUMENTS[0]!, text: "" }],
    store: new InMemoryFilingInsightStore(), generate: async () => ({ insights: [] }) });
  assert.equal(empty.coverage.status, "unavailable");
  assert.deepEqual(empty.coverage.failureCodes, ["no_filing_chunks"]);

  const store = new InMemoryFilingInsightStore();
  const linked = await extractFilingInsights({ modelId: "m1", documents: DOCUMENTS, store,
    sourceRows: [{ sourceLineItemId: "source.income.revenue", conceptQName: "us-gaap:Revenue", label: "Revenue" }],
    generate: async () => ({ insights: [{ topic: "Revenue", summary: "Revenue policy changed.", importanceReason: "Forecast timing",
      periodRefs: [], conceptRefs: ["us-gaap:Revenue", "invented:Concept"], relatedSourceLineItemIds: ["attacker.supplied.id"],
      shortEvidence: "policy changed", confidence: "high" }] }) });
  const detail = store.getDetail(linked.insightSetId, linked.insights[0]!.insightId)!;
  assert.deepEqual(detail.relatedSourceLineItemIds, ["source.income.revenue"]);
});
