/**
 * Filing extraction: resolve the issuer's 10-Ks, pull every table out of them with Arelle, persist the
 * tables and the selected face statements, and record the run. No model call decides anything here —
 * the one LLM touch is the small-model pass that summarizes filing prose into insights, and a failure
 * there degrades to an "unavailable" insight set rather than failing the run.
 *
 * The output is an immutable ingestion run the DCF Agent hands to `create_financial_model`.
 */
import { randomUUID } from "node:crypto";
import { extractFilingInsights, persistUnavailableInsightSet, type ChunkInsightGenerator } from "../filing-insights/extractor.ts";
import type { FilingInsightContextView } from "../filing-insights/types.ts";
import type { FilingInsightStore } from "../filing-insights/store.ts";
import { ArelleAdapterError } from "./arelleAdapter.ts";
import { IncompleteFinancialStatementsError, mergeCuratedTables } from "./mergeCuratedTables.ts";
import type { FilingTableStore } from "./filingTableStore.ts";
import { selectFaceStatements, type FaceStatementSelection } from "./selectFaceStatements.ts";
import type {
  FinancialModelSourceRequest,
  PreparedStatementProvider,
  ResolvedFinancialModelSource,
} from "./preparedStatementProvider.ts";
import type { FilingIngestionArtifact, FilingIngestionStore } from "./sourceReviewStore.ts";
import type { FilingExtraction, PreparedFilingStatements, PresentationExtract, StatementCoverageView } from "./types.ts";
import type { VerificationReport } from "./verification.ts";

export type StatementCurationSummary = {
  outcome: FaceStatementSelection["outcome"];
  steps: number;
  curatedTables: number;
  derivedTables: number;
  annotatedTables: number;
  verification: VerificationReport;
};

export type StatementExtractionResult = {
  ingestionRunId: string;
  modelId: string;
  status: "ready" | "failed";
  accessions: string[];
  diagnostics: string[];
  statementCoverage?: StatementCoverageView;
  filingInsights?: FilingInsightContextView;
  curation?: StatementCurationSummary;
  error?: { code: string; message: string; retryable: true };
};

export type StatementExtractionDeps = {
  provider: PreparedStatementProvider;
  ingestionStore: FilingIngestionStore;
  insightStore: FilingInsightStore;
  generateInsights: ChunkInsightGenerator;
  tableStore: FilingTableStore;
};

/** Writes only the dedicated ingestion/insight/table stores; never touches a model revision. */
export async function runStatementExtraction(
  deps: StatementExtractionDeps,
  ownerAgentId: string,
  request: FinancialModelSourceRequest,
): Promise<StatementExtractionResult> {
  const ingestionRunId = `ing_${randomUUID()}`;
  const modelId = `fm_${randomUUID()}`;
  let resolvedSource: FilingIngestionArtifact["source"];
  try {
    const source = await deps.provider.resolve(request);
    resolvedSource = source;
    const extractions = await deps.provider.extract(source);
    const presentationExtracts: PresentationExtract[] = extractions.map(
      ({ filing, calculationRelations, negatedConcepts, statements }) => ({ filing, calculationRelations, negatedConcepts, statements }));
    const curation = selectFilingTables(deps, ingestionRunId, source, extractions);
    const prepared = prepareCuratedStatements(source, extractions, curation);
    let insights: FilingInsightContextView;
    try {
      const documents = await deps.provider.filingDocuments(source);
      insights = await extractFilingInsights({ modelId, documents, store: deps.insightStore, generate: deps.generateInsights,
        sourceRows: Object.values(prepared?.statementViews ?? {}).flatMap((view) => view.candidate.rows.map((row) => ({
          sourceLineItemId: row.sourceLineItemId, conceptQName: row.conceptQName, label: row.label,
        }))) });
    } catch (failure) {
      insights = persistUnavailableInsightSet({ modelId, filings: source.filings, store: deps.insightStore,
        failureCode: failure instanceof Error ? "filing_document_unavailable" : "small_model_extraction_failed" });
    }
    // Curation that never went green is still a `ready` ingestion: the parent DCF
    // Agent decides whether to proceed, so the verification detail rides along in
    // diagnostics rather than blocking here.
    const diagnostics = [...extractions.flatMap((filing) => filing.diagnostics), ...curation.diagnostics];
    deps.ingestionStore.saveIngestion({ ingestionRunId, modelId, ownerAgentId, symbol: request.symbol.toUpperCase(), status: "ready",
      source, ...(prepared ? { prepared } : {}), filingInsightSetId: insights.insightSetId, diagnostics,
      curatedTables: curation.curatedTables, curations: curation.curations, verification: curation.verification, presentationExtracts });
    return { ingestionRunId, modelId, status: "ready", accessions: source.filings.map((filing) => filing.accession),
      diagnostics, ...(prepared ? { statementCoverage: prepared.coverage } : {}), filingInsights: insights,
      curation: { outcome: curation.outcome, steps: 0, curatedTables: curation.curations.length,
        derivedTables: 0, annotatedTables: 0, verification: curation.verification } };
  } catch (error) {
    const code = error instanceof IncompleteFinancialStatementsError ? error.code
      : error instanceof ArelleAdapterError ? error.code : "statement_extraction_failed";
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = error instanceof IncompleteFinancialStatementsError ? error.diagnostics : [];
    deps.ingestionStore.saveIngestion({ ingestionRunId, modelId, ownerAgentId, symbol: request.symbol.toUpperCase(), status: "failed",
      ...(resolvedSource ? { source: resolvedSource } : {}), diagnostics, error: { code, message } });
    return { ingestionRunId, modelId, status: "failed", accessions: resolvedSource?.filings.map((filing) => filing.accession) ?? [],
      diagnostics, error: { code, message, retryable: true } };
  }
}

/**
 * Persist every extracted table, then select standard face statements from
 * Arelle evidence without spending an Agent call.
 */
function selectFilingTables(
  deps: StatementExtractionDeps,
  ingestionRunId: string,
  source: ResolvedFinancialModelSource,
  extractions: readonly FilingExtraction[],
): FaceStatementSelection {
  const tables = extractions.flatMap((filing) => filing.tables);
  if (tables.length > 0) deps.tableStore.saveTables(ingestionRunId, tables);
  if (!tables.some((table) => table.prescreen.factCount > 0)) {
    throw new IncompleteFinancialStatementsError(["income_statement", "balance_sheet", "cash_flow_statement"], source.filings,
      extractions.flatMap((filing) => filing.diagnostics));
  }
  return selectFaceStatements({
    runId: ingestionRunId, store: deps.tableStore, tables,
    requestedPeriods: source.periods, reportDates: [...new Set(tables.map((table) => table.reportDate))].sort(),
    calculationRelations: Object.fromEntries(extractions.map((filing) => [filing.filing.accession, filing.calculationRelations])),
  });
}

function prepareCuratedStatements(
  source: ResolvedFinancialModelSource,
  extractions: readonly FilingExtraction[],
  curation: FaceStatementSelection,
): PreparedFilingStatements | undefined {
  try {
    return mergeCuratedTables({
      requestedPeriods: source.periods,
      filings: source.filings,
      tables: curation.curatedTables,
      curations: curation.curations,
      negatedConcepts: [...new Set(extractions.flatMap((filing) => filing.negatedConcepts))],
      diagnostics: extractions.flatMap((filing) => filing.diagnostics),
    });
  } catch (error) {
    // A partial selection remains a ready ingestion by design. It deliberately
    // carries no prepared payload, so model creation cannot silently stage an
    // incomplete statement set.
    if (curation.outcome === "partial" && error instanceof IncompleteFinancialStatementsError) return undefined;
    throw error;
  }
}
