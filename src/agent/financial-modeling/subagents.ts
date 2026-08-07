import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "../../framework/types.ts";
import type { LifecycleStage } from "../../financial-model/types.ts";
import type { ModelClass } from "../../infra/llm/provider.ts";
import type { ModelContextView } from "../../financial-model/views.ts";
import { extractFilingInsights, persistUnavailableInsightSet, type ChunkInsightGenerator } from "../../infra/filing-insights/extractor.ts";
import type { FilingInsightContextView } from "../../infra/filing-insights/types.ts";
import type { FilingInsightStore } from "../../infra/filing-insights/store.ts";
import { ArelleAdapterError } from "../../infra/xbrl/arelleAdapter.ts";
import { IncompleteFinancialStatementsError, mergeCuratedTables } from "../../infra/xbrl/mergeCuratedTables.ts";
import type { FilingTableStore } from "../../infra/xbrl/filingTableStore.ts";
import { selectFaceStatements, type FaceStatementSelection } from "../../infra/xbrl/selectFaceStatements.ts";
import type {
  FinancialModelSourceRequest,
  PreparedStatementProvider,
  ResolvedFinancialModelSource,
} from "../../infra/xbrl/preparedStatementProvider.ts";
import type { FilingIngestionArtifact, FilingIngestionStore } from "../../infra/xbrl/sourceReviewStore.ts";
import type { FilingExtraction, PreparedFilingStatements, PresentationExtract, StatementCoverageView } from "../../infra/xbrl/types.ts";
import type { VerificationReport } from "../../infra/xbrl/verification.ts";
import { decompositionReducePrompt, filingDecompositionPrompt, mappingReviewPrompt, readOnlyProposalPrompt,
  spineMappingPrompt, statementExtractionPrompt, statementUnificationPrompt } from "../prompts/dcfSubagentPrompts.ts";

export type DcfSubagentKind = "statement_extraction" | "filing_decomposition" | "decomposition_reduce"
  | "statement_unification" | "spine_mapping" | "mapping_review" | "forecast_modeling" | "valuation_review";
export type ModelingProposalSubagent = Exclude<DcfSubagentKind, "statement_extraction" | "filing_decomposition" | "decomposition_reduce" | "statement_unification" | "spine_mapping">;

export type DcfSubagentProposal<T extends JsonValue = JsonValue> = {
  subagent: ModelingProposalSubagent;
  modelId: string;
  baseRevision: number;
  lifecycleStage: LifecycleStage;
  rationale: string;
  payload: T;
  sourceRefs: string[];
};

export type StatementCurationSummary = {
  outcome: FaceStatementSelection["outcome"];
  steps: number;
  curatedTables: number;
  derivedTables: number;
  annotatedTables: number;
  verification: VerificationReport;
};

export type StatementExtractionResult = {
  subagent: "statement_extraction";
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

/** Private statement-extraction subagent. It writes only dedicated ingestion/insight stores. */
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
    return { subagent: "statement_extraction", ingestionRunId, modelId, status: "ready", accessions: source.filings.map((filing) => filing.accession),
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
    return { subagent: "statement_extraction", ingestionRunId, modelId, status: "failed", accessions: resolvedSource?.filings.map((filing) => filing.accession) ?? [],
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

export type DcfSubagentProjection = {
  subagent: ModelingProposalSubagent;
  modelId: string;
  baseRevision: number;
  lifecycleStage: LifecycleStage;
  workbook: JsonObject;
  filingInsights: FilingInsightContextView | null;
};

/** Stage-specific read projection; never includes owner credentials or tool handles. */
export function projectForDcfSubagent(
  subagent: ModelingProposalSubagent,
  context: ModelContextView,
  filingInsights: FilingInsightContextView | null,
): DcfSubagentProjection {
  const workbook = context.currentWorkbook;
  const sections = subagent === "mapping_review"
    ? Object.fromEntries(Object.entries(workbook.sections).map(([section, rows]) => [section, rows.map((row) => ({
      lineItemId: row.lineItemId, label: row.label, section: row.section, role: row.role, unit: row.unit, order: row.order,
    }))]))
    : subagent === "forecast_modeling"
      ? { history: workbook.sections.history, metrics: workbook.sections.metrics, revenue: workbook.sections.revenue, operations: workbook.sections.operations }
      : { operations: workbook.sections.operations, dcf: workbook.sections.dcf };
  const projected: DcfSubagentProjection = { subagent, modelId: context.model.modelId, baseRevision: workbook.revision,
    lifecycleStage: workbook.lifecycleStage, workbook: { periods: workbook.periods, sections, diagnostics: workbook.diagnostics,
      reconciliationResults: subagent === "mapping_review" ? [] : workbook.reconciliationResults,
      valuationConfig: workbook.valuationConfig,
      ...(subagent === "valuation_review" ? { valuation: workbook.valuation } : {}) }, filingInsights };
  if (subagent === "mapping_review") {
    projected.workbook["diagnostics"] = Object.entries(workbook.diagnostics.reduce<Record<string, number>>((counts, diagnostic) => {
      counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1; return counts;
    }, {})).map(([code, count]) => ({ code, count }));
    projected.filingInsights = null;
  }
  return projected;
}

export function assertFreshDcfProposal<T extends JsonValue>(proposal: DcfSubagentProposal<T>, context: ModelContextView): void {
  if (proposal.modelId !== context.model.modelId || proposal.baseRevision !== context.currentWorkbook.revision
    || proposal.lifecycleStage !== context.currentWorkbook.lifecycleStage) {
    throw new Error(`stale_dcf_proposal: expected ${context.model.modelId}@${context.currentWorkbook.revision}/${context.currentWorkbook.lifecycleStage}`);
  }
}

/** Private registry is intentionally a different type from framework SubagentRegistry. */
export type DcfSubagentDefinition = {
  name: DcfSubagentKind;
  modelClass: ModelClass;
  authority: "ingestion_store_only" | "read_only_proposal";
  prompt: string;
};

export class DcfSubagentRegistry {
  private readonly subagents = new Map<DcfSubagentKind, DcfSubagentDefinition>();
  constructor() {
    this.register({ name: "statement_extraction", modelClass: "SMALL", authority: "ingestion_store_only", prompt: statementExtractionPrompt });
    this.register({ name: "filing_decomposition", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: filingDecompositionPrompt });
    this.register({ name: "decomposition_reduce", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: decompositionReducePrompt });
    this.register({ name: "statement_unification", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: statementUnificationPrompt });
    this.register({ name: "spine_mapping", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: spineMappingPrompt });
    this.register({ name: "mapping_review", modelClass: "MEDIUM", authority: "read_only_proposal", prompt: mappingReviewPrompt });
    for (const name of ["forecast_modeling", "valuation_review"] as const) {
      this.register({ name, modelClass: "MEDIUM", authority: "read_only_proposal", prompt: readOnlyProposalPrompt(name) });
    }
  }
  register(definition: DcfSubagentDefinition): void {
    if (this.subagents.has(definition.name)) throw new Error(`duplicate DCF subagent: ${definition.name}`);
    this.subagents.set(definition.name, definition);
  }
  get(subagent: DcfSubagentKind): DcfSubagentDefinition {
    const definition = this.subagents.get(subagent); if (!definition) throw new Error(`unknown DCF subagent: ${subagent}`); return definition;
  }
  has(subagent: DcfSubagentKind): boolean { return this.subagents.has(subagent); }
  list(): DcfSubagentKind[] { return [...this.subagents.keys()]; }
}
