import type { Fact, Period, PreparedStatementRow, StatementKind, Unit } from "../../financial-model/types.ts";
import type { FilingTable } from "./tableTypes.ts";

export type AnnualFilingForm = "10-K" | "10-K/A";

export type FilingIdentity = {
  accession: string;
  form: AnnualFilingForm;
  filedAt: string;
  reportDate: string;
  primaryDocumentUrl: string;
};

export type XbrlDimension = {
  axisQName: string;
  axisLabel: string;
  memberQName: string;
  memberLabel: string;
  typedMemberValue?: string;
};

export type FilingFactOccurrenceBase = {
  contextId: string;
  periodId: string;
  value: number;
  unit: Unit;
  decimals?: number;
  dimensions: XbrlDimension[];
  sourceAnchor: string;
};

export type FilingTableFactOccurrence = FilingFactOccurrenceBase & {
  occurrenceId: string;
  conceptQName: string;
  conceptLabel: string;
  htmlOrder: number;
  sourceTableId?: string;
  nearestHeading?: string;
};

/**
 * Calculation linkbase roll-up. Arelle exports the relationships only; the
 * arithmetic runs in TypeScript so verification is unit-testable and
 * reproducible without Arelle.
 */
export type CalculationRelation = {
  roleUri: string;
  parentConcept: string;
  children: Array<{ concept: string; weight: number; order: number }>;
};

export type PresentationFactPayload = {
  periodId: string;
  value: number;
  unit: Unit;
  decimals?: number;
  contextId: string;
  sourceAnchor: string;
  dimensions: XbrlDimension[];
};

export type PresentationNodePayload = {
  nodeId: number;
  parentNodeId: number | null;
  conceptQName: string;
  label: string;
  abstract: boolean;
  /** True on a rollforward's opening-balance row (periodStartLabel). The closing row carries the
   *  same concept, so this is the only thing separating two genuinely different numbers. */
  openingBalance?: boolean;
  facts: PresentationFactPayload[];
  ambiguousPeriodIds: string[];
};

export type PresentationStatementPayload = {
  statement: StatementKind;
  roleUri: string;
  roleLabel: string;
  declaredAxisQNames: string[];
  nodes: PresentationNodePayload[];
};

export type FilingExtraction = {
  filing: FilingIdentity;
  tables: FilingTable[];
  calculationRelations: CalculationRelation[];
  /** Presentation-linkbase concepts whose relationship uses a negated label. */
  negatedConcepts: string[];
  diagnostics: string[];
  statements: PresentationStatementPayload[];
};

/** Trimmed extraction persisted for later pipeline stages; `tables`/`diagnostics` are stored elsewhere. */
export type PresentationExtract =
  Pick<FilingExtraction, "filing" | "calculationRelations" | "negatedConcepts" | "statements">;

export type ArelleExtractionRequest = {
  protocolVersion: 3;
  filings: FilingIdentity[];
  periods: Period[];
};

export type ArelleExtractionResponse = {
  protocolVersion: 3;
  filings: FilingExtraction[];
  diagnostics: string[];
};

export type PreparedStatementRowView = PreparedStatementRow & {
  conceptQName: string;
  dimensionSignature: string;
  dimensions: XbrlDimension[];
  depth: number;
  parentSourceLineItemId?: string;
  presentationAccessions: string[];
  sourceTableId?: string;
  /** `preferredLabel` says the filing displays this row negated. Display only. */
  negated?: boolean;
};

export type FilingPresentationView = {
  accession: string;
  form: AnnualFilingForm;
  filedAt: string;
  isLatest: boolean;
  roleUri: string;
  periodColumns: Period[];
  rows: Array<{
    conceptQName: string;
    label: string;
    order: number;
    depth: number;
    facts: FilingTableFactOccurrence[];
    sourceLineItemId: string;
    dimensionSignature: string;
  }>;
};

export type PreparedStatementMappingView = {
  /** Rows produced from the ingestion run's curated face tables; facts remain unreviewed. */
  candidate: { periods: Period[]; rows: PreparedStatementRowView[] };
  filingPresentations: FilingPresentationView[];
};

export type StatementCoverageView = {
  requestedPeriodIds: string[];
  statements: Array<{
    statement: StatementKind;
    availablePeriodIds: string[];
    missingPeriodIds: string[];
  }>;
  issues: Array<{
    code: "missing_period" | "missing_cell" | "incompatible_context" | "presentation_change";
    severity: "review_required";
    statement: StatementKind;
    periodIds: string[];
    sourceRefs: string[];
  }>;
};

export type DimensionalDisclosureView = {
  statementOrNoteRole: string;
  concept: { qname: string; label: string; unit: Unit };
  dimensions: XbrlDimension[];
  dimensionSignature: string;
  periods: Array<{
    periodId: string;
    value: number | null;
    accession: string;
    contextId: string;
    sourceAnchor: string;
  }>;
};

export type PreparedFilingStatements = {
  filings: FilingIdentity[];
  periods: Period[];
  rows: PreparedStatementRow[];
  facts: Fact[];
  statementViews: Record<StatementKind, PreparedStatementMappingView>;
  dimensionalDisclosures: DimensionalDisclosureView[];
  coverage: StatementCoverageView;
  diagnostics: string[];
};
