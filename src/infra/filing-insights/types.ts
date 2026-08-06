import type { AnnualFilingForm, FilingIdentity } from "../xbrl/types.ts";

export type FilingSourceAnchor = {
  chunkId: string;
  contentHash: string;
  paragraphOrTableIds: string[];
  startOffset?: number;
  endOffset?: number;
};

export type FilingChunk = {
  chunkId: string;
  accession: string;
  filingForm: AnnualFilingForm;
  filedAt: string;
  sourceDocumentUrl: string;
  section: string;
  sourceAnchor: FilingSourceAnchor;
  content: string;
};

export type FilingInsight = {
  insightId: string;
  modelId: string;
  accession: string;
  filingForm: AnnualFilingForm;
  filedAt: string;
  sourceDocumentUrl: string;
  section: string;
  sourceAnchor: FilingSourceAnchor;
  topic: string;
  summary: string;
  importanceReason: string;
  periodRefs: string[];
  conceptRefs: string[];
  relatedSourceLineItemIds: string[];
  shortEvidence: string;
  confidence: "high" | "medium" | "low";
  extractor: { modelClass: "small"; modelVersion: string; promptVersion: string };
  status: "candidate" | "reviewed" | "rejected";
};

export type FilingInsightSetStatus = {
  status: "complete" | "partial" | "unavailable";
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  failureCodes: string[];
};

export type FilingInsightContextView = {
  insightSetId: string;
  extractorVersion: string;
  coverage: FilingInsightSetStatus;
  filings: Array<Pick<FilingIdentity, "accession" | "form" | "filedAt">>;
  insights: Array<Pick<FilingInsight,
    "insightId" | "topic" | "summary" | "importanceReason" | "periodRefs" |
    "relatedSourceLineItemIds" | "confidence" | "accession" | "section" | "sourceAnchor">>;
};

export type FilingInsightDetailView = FilingInsight & { sourceChunk: FilingChunk };

export type FilingDocument = { filing: FilingIdentity; text: string };

export type FilingInsightCandidate = Pick<FilingInsight,
  "topic" | "summary" | "importanceReason" | "periodRefs" | "conceptRefs" |
  "relatedSourceLineItemIds" | "shortEvidence" | "confidence">;

export type FilingInsightFailure = {
  chunkId: string;
  contentHash: string;
  accession: string;
  section: string;
  attemptCount: number;
  code: string;
  message: string;
};

export type FilingInsightExtractionRun = {
  runId: string;
  insightSetId: string;
  extractorVersion: string;
  status: "complete" | "partial" | "unavailable";
  startedAt: string;
  completedAt: string;
};
