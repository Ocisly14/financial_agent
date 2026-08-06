import { createHash } from "node:crypto";
import type { FilingChunk, FilingDocument } from "./types.ts";

const DEFAULT_MAX_CHARS = 12_000;
const OVERLAP_CHARS = 400;

/** Deterministic heading-aware chunks with stable offsets and content hashes. */
export function chunkFilingDocument(document: FilingDocument, maxChars = DEFAULT_MAX_CHARS): FilingChunk[] {
  const text = normalizeFilingDocument(document.text).replaceAll("\r\n", "\n");
  if (!text.trim()) return [];
  const heading = /^(?:ITEM\s+\d+[A-Z]?\.?|NOTE\s+\d+\.?|[A-Z][A-Z0-9 ,&()'/-]{8,})\s*$/gm;
  const starts = [0];
  for (const match of text.matchAll(heading)) if (match.index !== undefined && match.index > 0) starts.push(match.index);
  starts.push(text.length);
  const chunks: FilingChunk[] = [];
  for (let sectionIndex = 0; sectionIndex < starts.length - 1; sectionIndex += 1) {
    const sectionStart = starts[sectionIndex]!;
    const sectionEnd = starts[sectionIndex + 1]!;
    const headingLine = text.slice(sectionStart, Math.min(sectionEnd, text.indexOf("\n", sectionStart) === -1 ? sectionEnd : text.indexOf("\n", sectionStart))).trim();
    const section = headingLine || "Filing body";
    let start = sectionStart;
    while (start < sectionEnd) {
      const end = Math.min(start + maxChars, sectionEnd);
      const content = text.slice(start, end);
      const contentHash = createHash("sha256").update(content).digest("hex");
      const chunkId = `${document.filing.accession}:${sectionIndex}:${start}`;
      chunks.push({ chunkId, accession: document.filing.accession, filingForm: document.filing.form,
        filedAt: document.filing.filedAt, sourceDocumentUrl: document.filing.primaryDocumentUrl, section,
        sourceAnchor: { chunkId, contentHash, paragraphOrTableIds: [`section-${sectionIndex}`], startOffset: start, endOffset: end }, content });
      if (end === sectionEnd) break;
      start = end - OVERLAP_CHARS;
    }
  }
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
