import { createHash, randomUUID } from "node:crypto";
import type { ModelRouter } from "../llm/provider.ts";
import { chunkFilingDocument } from "./chunker.ts";
import type { FilingInsightStore } from "./store.ts";
import type { FilingDocument, FilingInsight, FilingInsightCandidate, FilingInsightContextView, FilingInsightFailure } from "./types.ts";

export const FILING_INSIGHT_PROMPT_VERSION = "filing-insight-v2";
export const FILING_INSIGHT_EXTRACTOR_VERSION = `small:${FILING_INSIGHT_PROMPT_VERSION}`;

export type ChunkInsightGenerator = (content: string, section: string) => Promise<unknown>;

export function createSmallModelInsightGenerator(router: ModelRouter): ChunkInsightGenerator {
  return async (content, section) => (await router.generate([
    { role: "system", content: "Extract only source-grounded filing disclosures. Quality over quantity: report only disclosures that are material to understanding the business or its financials, or unusual for a company of this kind — one-off items, changed accounting treatments, atypical risks, surprising segment shifts. Skip boilerplate, generic risk-factor language, and routine disclosures every issuer repeats; an empty insights array is better than padding. Never propose DCF categories, mappings, formulas, assumptions, WACC, terminal inputs, valuation conclusions, or source line-item IDs. Return JSON {insights:[{topic,summary,importanceReason,periodRefs,conceptRefs,shortEvidence,confidence}]}. Use only concept names or labels actually present in the chunk." },
    { role: "user", content: `SECTION: ${section}\n\n${content}` },
  ], { modelClass: "SMALL", temperature: 0, timeoutMs: 45_000, metadata: { mode: "filing_insight" } })).text;
}

export async function extractFilingInsights(input: {
  modelId: string;
  documents: FilingDocument[];
  store: FilingInsightStore;
  generate: ChunkInsightGenerator;
  extractorVersion?: string;
  concurrency?: number;
  sourceRows?: Array<{ sourceLineItemId: string; conceptQName: string; label: string }>;
}): Promise<FilingInsightContextView> {
  const extractorVersion = input.extractorVersion ?? FILING_INSIGHT_EXTRACTOR_VERSION;
  const startedAt = new Date().toISOString();
  const chunks = input.documents.flatMap((document) => chunkFilingDocument(document));
  const results = await mapLimit(chunks, input.concurrency ?? 3, async (chunk) => {
    const reusable = input.store.reusable(chunk.sourceAnchor.contentHash, extractorVersion);
    if (reusable !== undefined) return { chunk, insights: reusable.map((insight) => ({ ...insight, insightId: randomUUID(), modelId: input.modelId,
      accession: chunk.accession, filingForm: chunk.filingForm, filedAt: chunk.filedAt, sourceDocumentUrl: chunk.sourceDocumentUrl,
      section: chunk.section, sourceAnchor: structuredClone(chunk.sourceAnchor) })) };
    try {
      const raw = await input.generate(chunk.content, chunk.section);
      const candidates = parseCandidates(raw);
      const insights = candidates.map((candidate): FilingInsight => ({
        insightId: randomUUID(), modelId: input.modelId, accession: chunk.accession, filingForm: chunk.filingForm,
        filedAt: chunk.filedAt, sourceDocumentUrl: chunk.sourceDocumentUrl, section: chunk.section,
        sourceAnchor: structuredClone(chunk.sourceAnchor), ...candidate,
        relatedSourceLineItemIds: linkSourceRows(candidate.conceptRefs, input.sourceRows ?? []),
        extractor: { modelClass: "small", modelVersion: extractorVersion, promptVersion: FILING_INSIGHT_PROMPT_VERSION }, status: "candidate",
      }));
      return { chunk, insights };
    } catch (error) {
      return { chunk, insights: [] as FilingInsight[], failure: error instanceof Error ? error.message : String(error) };
    }
  });
  const failed = results.filter((result) => result.failure !== undefined);
  const failures: FilingInsightFailure[] = failed.map((result) => ({ chunkId: result.chunk.chunkId,
    contentHash: result.chunk.sourceAnchor.contentHash, accession: result.chunk.accession, section: result.chunk.section,
    attemptCount: input.store.failureAttempts(result.chunk.sourceAnchor.contentHash, extractorVersion) + 1,
    code: "small_model_extraction_failed", message: result.failure! }));
  const deduped = new Map<string, FilingInsight>();
  for (const insight of results.flatMap((result) => result.insights)) {
    const key = createHash("sha256").update(`${insight.accession}|${insight.topic}|${insight.summary}`).digest("hex");
    if (!deduped.has(key)) deduped.set(key, insight);
  }
  const insights = [...deduped.values()];
  const insightSetId = randomUUID();
  const context: FilingInsightContextView = {
    insightSetId, extractorVersion,
    coverage: { status: chunks.length === 0 || failed.length === chunks.length ? "unavailable" : failed.length === 0 ? "complete" : "partial",
      totalChunks: chunks.length, completedChunks: chunks.length - failed.length, failedChunks: failed.length,
      failureCodes: chunks.length === 0 ? ["no_filing_chunks"] : [...new Set(failed.map(() => "small_model_extraction_failed"))] },
    filings: input.documents.map((document) => ({ accession: document.filing.accession, form: document.filing.form, filedAt: document.filing.filedAt })),
    insights: insights.map(({ insightId, topic, summary, importanceReason, periodRefs, relatedSourceLineItemIds, confidence, accession, section, sourceAnchor }) =>
      ({ insightId, topic, summary, importanceReason, periodRefs, relatedSourceLineItemIds, confidence, accession, section, sourceAnchor })),
  };
  input.store.save({ context, insights, chunks, failures, run: { runId: randomUUID(), insightSetId, extractorVersion,
    status: context.coverage.status, startedAt, completedAt: new Date().toISOString() } });
  return context;
}

export function persistUnavailableInsightSet(input: {
  modelId: string;
  filings: FilingDocument["filing"][];
  store: FilingInsightStore;
  failureCode: string;
  extractorVersion?: string;
}): FilingInsightContextView {
  const extractorVersion = input.extractorVersion ?? FILING_INSIGHT_EXTRACTOR_VERSION;
  const context: FilingInsightContextView = {
    insightSetId: randomUUID(), extractorVersion,
    coverage: { status: "unavailable", totalChunks: 0, completedChunks: 0, failedChunks: 0, failureCodes: [input.failureCode] },
    filings: input.filings.map(({ accession, form, filedAt }) => ({ accession, form, filedAt })), insights: [],
  };
  const now = new Date().toISOString();
  input.store.save({ context, insights: [], chunks: [], failures: [], run: { runId: randomUUID(), insightSetId: context.insightSetId,
    extractorVersion, status: "unavailable", startedAt: now, completedAt: now } });
  return context;
}

function parseCandidates(raw: unknown): FilingInsightCandidate[] {
  let value = raw;
  if (typeof value === "string") value = JSON.parse(value);
  if (!value || typeof value !== "object" || !Array.isArray((value as { insights?: unknown }).insights)) throw new Error("invalid filing insight output");
  return (value as { insights: unknown[] }).insights.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid filing insight candidate");
    const item = entry as Record<string, unknown>;
    const string = (key: string) => { if (typeof item[key] !== "string" || !(item[key] as string).trim()) throw new Error(`invalid filing insight ${key}`); return (item[key] as string).trim(); };
    const strings = (key: string) => { if (!Array.isArray(item[key]) || !(item[key] as unknown[]).every((part) => typeof part === "string")) throw new Error(`invalid filing insight ${key}`); return item[key] as string[]; };
    const confidence = string("confidence");
    if (!(["high", "medium", "low"] as string[]).includes(confidence)) throw new Error("invalid filing insight confidence");
    return { topic: string("topic"), summary: string("summary"), importanceReason: string("importanceReason"),
      periodRefs: strings("periodRefs"), conceptRefs: strings("conceptRefs"), relatedSourceLineItemIds: [],
      shortEvidence: string("shortEvidence"), confidence: confidence as FilingInsightCandidate["confidence"] };
  });
}

function linkSourceRows(conceptRefs: string[], rows: Array<{ sourceLineItemId: string; conceptQName: string; label: string }>): string[] {
  const concepts = new Set(conceptRefs.map((value) => value.trim().toLowerCase()));
  return rows.filter((row) => concepts.has(row.conceptQName.toLowerCase()) || concepts.has(row.label.toLowerCase()))
    .map((row) => row.sourceLineItemId).sort();
}

async function mapLimit<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, async () => {
    while (cursor < values.length) { const index = cursor++; output[index] = await fn(values[index]!); }
  }));
  return output;
}
