import assert from "node:assert/strict";
import test from "node:test";
import { chunkFilingDocument } from "../chunker.ts";
import type { FilingDocument } from "../types.ts";

const FILING: FilingDocument["filing"] = { accession: "0000000000-26-000001", form: "10-K",
  filedAt: "2026-01-30", reportDate: "2025-12-31", primaryDocumentUrl: "https://example.test/doc.htm" };

function doc(text: string): FilingDocument { return { filing: FILING, text }; }

function section(title: string, bodyChars: number): string {
  return `${title}\n${"x".repeat(bodyChars)}\n`;
}

test("adjacent small sections pack into one chunk instead of one chunk per heading", () => {
  const text = [
    section("ITEM 1. BUSINESS", 3_000),
    section("ITEM 1A. RISK FACTORS", 4_000),
    section("NOTE 2. REVENUE RECOGNITION", 2_500),
    section("SUMMARY OF SIGNIFICANT ACCOUNTING POLICIES", 3_500),
  ].join("");
  const chunks = chunkFilingDocument(doc(text), 80_000);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.section, /^ITEM 1\. BUSINESS \(\+3 sections\)$/);
  assert.deepEqual(chunks[0]!.sourceAnchor.paragraphOrTableIds, ["section-0", "section-1", "section-2", "section-3"]);
  assert.ok(chunks[0]!.content.includes("NOTE 2. REVENUE RECOGNITION"));
});

test("packing flushes at the budget: sections never split, chunks stay under maxChars", () => {
  const text = [
    section("ITEM 1. BUSINESS", 9_000),
    section("ITEM 2. PROPERTIES", 9_000),
    section("ITEM 3. LEGAL PROCEEDINGS", 9_000),
    section("ITEM 4. MINE SAFETY", 9_000),
  ].join("");
  const chunks = chunkFilingDocument(doc(text), 20_000);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) assert.ok(chunk.content.length <= 20_000);
  assert.match(chunks[0]!.section, /^ITEM 1\. BUSINESS \(\+1 sections\)$/);
  assert.match(chunks[1]!.section, /^ITEM 3\. LEGAL PROCEEDINGS \(\+1 sections\)$/);
  // Packed chunks are contiguous: no text is lost between them.
  assert.equal(chunks[0]!.sourceAnchor.endOffset, chunks[1]!.sourceAnchor.startOffset);
});

test("a single oversized section still splits with overlap windows", () => {
  const text = section("ITEM 7. MANAGEMENT DISCUSSION", 50_000);
  const chunks = chunkFilingDocument(doc(text), 20_000);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) assert.equal(chunk.section, "ITEM 7. MANAGEMENT DISCUSSION");
  for (let index = 1; index < chunks.length; index += 1) {
    assert.ok(chunks[index]!.sourceAnchor.startOffset! < chunks[index - 1]!.sourceAnchor.endOffset!, "windows overlap");
  }
  const last = chunks[chunks.length - 1]!;
  assert.equal(last.sourceAnchor.endOffset, text.replaceAll("\r\n", "\n").length);
});

test("oversized section flushes the pending pack first and later sections start a new pack", () => {
  const text = [
    section("ITEM 1. BUSINESS", 2_000),
    section("ITEM 7. MANAGEMENT DISCUSSION", 45_000),
    section("ITEM 8. FINANCIAL STATEMENTS", 2_000),
    section("ITEM 9. CONTROLS", 2_000),
  ].join("");
  const chunks = chunkFilingDocument(doc(text), 20_000);
  assert.equal(chunks[0]!.section, "ITEM 1. BUSINESS");
  const tail = chunks[chunks.length - 1]!;
  assert.match(tail.section, /^ITEM 8\. FINANCIAL STATEMENTS \(\+1 sections\)$/);
  const middle = chunks.slice(1, -1);
  assert.ok(middle.length >= 2 && middle.every((chunk) => chunk.section === "ITEM 7. MANAGEMENT DISCUSSION"));
});

test("chunking is deterministic: same input, same ids, hashes, and offsets", () => {
  const text = [section("ITEM 1. BUSINESS", 5_000), section("NOTE 3. DEBT", 30_000)].join("");
  const first = chunkFilingDocument(doc(text), 20_000);
  const second = chunkFilingDocument(doc(text), 20_000);
  assert.deepEqual(first, second);
});

test("empty and whitespace-only documents produce zero chunks", () => {
  assert.deepEqual(chunkFilingDocument(doc("")), []);
  assert.deepEqual(chunkFilingDocument(doc("   \n\n  ")), []);
});
