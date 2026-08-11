import { createHash } from "node:crypto";
import type { FilingChunk, FilingDocument } from "./types.ts";

// ~20k tokens per chunk: large enough that whole ITEM/NOTE sections survive
// unsplit, small enough that per-chunk recall of specific disclosures holds.
const DEFAULT_MAX_CHARS = 80_000;
const OVERLAP_CHARS = 1_600;

/** Deterministic heading-aware chunks with stable offsets and content hashes.
 * Headings only mark candidate boundaries; adjacent sections are PACKED into one chunk until
 * maxChars, so chunk size is set by the budget, not by how often the filing repeats ALL-CAPS lines. */
export function chunkFilingDocument(document: FilingDocument, maxChars = DEFAULT_MAX_CHARS): FilingChunk[] {
  const text = normalizeFilingDocument(document.text).replaceAll("\r\n", "\n");
  if (!text.trim()) return [];
  const heading = /^(?:(?:ITEM|NOTE)\s+\d+[A-Z]?\.?(?:\s+[A-Z][A-Z0-9 ,&()'./-]{0,80})?|[A-Z][A-Z0-9 ,&()'/-]{8,})\s*$/gm;
  const starts = [0];
  for (const match of text.matchAll(heading)) if (match.index !== undefined && match.index > 0) starts.push(match.index);
  starts.push(text.length);
  const sections = Array.from({ length: starts.length - 1 }, (_ignored, index) => {
    const start = starts[index]!;
    const end = starts[index + 1]!;
    const newline = text.indexOf("\n", start);
    const headingLine = text.slice(start, Math.min(end, newline === -1 ? end : newline)).trim();
    return { index, start, end, heading: headingLine || "Filing body" };
  });
  const chunks: FilingChunk[] = [];
  const push = (start: number, end: number, section: string, sectionIndices: number[]): void => {
    const content = text.slice(start, end);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const chunkId = `${document.filing.accession}:${sectionIndices[0]}:${start}`;
    chunks.push({ chunkId, accession: document.filing.accession, filingForm: document.filing.form,
      filedAt: document.filing.filedAt, sourceDocumentUrl: document.filing.primaryDocumentUrl, section,
      sourceAnchor: { chunkId, contentHash, paragraphOrTableIds: sectionIndices.map((index) => `section-${index}`),
        startOffset: start, endOffset: end }, content });
  };
  let pack: { start: number; end: number; heading: string; indices: number[] } | undefined;
  const flush = (): void => {
    if (!pack) return;
    const label = pack.indices.length > 1 ? `${pack.heading} (+${pack.indices.length - 1} sections)` : pack.heading;
    push(pack.start, pack.end, label, pack.indices);
    pack = undefined;
  };
  for (const section of sections) {
    const length = section.end - section.start;
    if (length > maxChars) {
      // A single oversized section keeps the sliding-window split with overlap.
      flush();
      let start = section.start;
      while (start < section.end) {
        const end = Math.min(start + maxChars, section.end);
        push(start, end, section.heading, [section.index]);
        if (end === section.end) break;
        start = end - OVERLAP_CHARS;
      }
      continue;
    }
    if (pack && pack.end - pack.start + length > maxChars) flush();
    if (!pack) pack = { start: section.start, end: section.end, heading: section.heading, indices: [section.index] };
    else { pack.end = section.end; pack.indices.push(section.index); }
  }
  flush();
  return chunks;
}

/** Minimal deterministic HTML projection that preserves headings and table cells. */
export function normalizeFilingDocument(input: string): string {
  if (!/<[a-z][\s\S]*>/i.test(input)) return input;
  let table = 0;
  return decodeEntities(input
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<table\b[^>]*>/gi, () => `\nTABLE ${++table}\n`)
    .replace(/<\/(?:table|tr)>/gi, "\n")
    .replace(/<t[dh]\b[^>]*>/gi, " | ")
    .replace(/<\/(?:td|th)>/gi, " ")
    .replace(/<(?:h[1-6]|p|div|section|article|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x"; const raw = entity.slice(hex ? 2 : 1);
      const code = Number.parseInt(raw, hex ? 16 : 10); return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}
