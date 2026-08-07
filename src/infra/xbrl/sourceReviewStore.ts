import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DimensionalDisclosureView, PreparedFilingStatements, PresentationExtract, StatementCoverageView } from "./types.ts";
import type { FilingTable, TableCuration } from "./tableTypes.ts";
import type { ResolvedFinancialModelSource } from "./preparedStatementProvider.ts";
import type { VerificationReport } from "./verification.ts";
import type { DecompositionSummary } from "./decompositionTypes.ts";
import type { UnifiedStatementsArtifact } from "./unifiedStatements.ts";
import type { PremapSummary } from "../../financial-model/autoPremap.ts";

export type SourceReviewArtifact = Pick<PreparedFilingStatements, "statementViews" | "filings" | "facts"> & {
  ingestionRunId: string;
  coverage: StatementCoverageView;
  dimensionalDisclosures: DimensionalDisclosureView[];
  /** The tables the curation loop selected, with the decisions that selected them. */
  curatedTables: FilingTable[];
  curations: TableCuration[];
  verification?: VerificationReport;
  /** Present after the parent accepts a revenue decomposition (spec §6). */
  decomposition?: DecompositionSummary;
  /** Deterministic engine pre-mapping (auto-premapping design spec §5). */
  premap?: PremapSummary;
  /** Absent on artifacts saved before two-stage spine mapping (spec §6); re-run statement_extraction. */
  presentationExtracts?: PresentationExtract[];
  /** Present after statement_unification ran (spec §6); consumed by spine_mapping. */
  unifiedStatements?: UnifiedStatementsArtifact;
};

export interface SourceReviewStore { save(modelId: string, artifact: SourceReviewArtifact): void; get(modelId: string): SourceReviewArtifact | undefined; }

export type FilingIngestionArtifact = {
  ingestionRunId: string;
  modelId: string;
  ownerAgentId: string;
  symbol: string;
  status: "ready" | "failed";
  source?: ResolvedFinancialModelSource;
  prepared?: PreparedFilingStatements;
  filingInsightSetId?: string;
  /** Absent when the curation loop did not run for this ingestion. */
  curatedTables?: FilingTable[];
  curations?: TableCuration[];
  verification?: VerificationReport;
  /** Absent on ingestions saved before two-stage spine mapping (spec §6). */
  presentationExtracts?: PresentationExtract[];
  diagnostics: string[];
  error?: { code: string; message: string };
  consumedAt?: string;
};

export interface FilingIngestionStore {
  saveIngestion(artifact: FilingIngestionArtifact): void;
  getIngestion(ingestionRunId: string): FilingIngestionArtifact | undefined;
  consumeIngestion(ingestionRunId: string, ownerAgentId: string, symbol: string): FilingIngestionArtifact | undefined;
}

export class InMemorySourceReviewStore implements SourceReviewStore, FilingIngestionStore {
  private readonly values = new Map<string, SourceReviewArtifact>();
  private readonly ingestions = new Map<string, FilingIngestionArtifact>();
  save(id: string, artifact: SourceReviewArtifact): void { this.values.set(id, structuredClone(artifact)); }
  get(id: string): SourceReviewArtifact | undefined { const value = this.values.get(id); return value && structuredClone(value); }
  saveIngestion(artifact: FilingIngestionArtifact): void { this.ingestions.set(artifact.ingestionRunId, structuredClone(artifact)); }
  getIngestion(id: string): FilingIngestionArtifact | undefined { const value = this.ingestions.get(id); return value && structuredClone(value); }
  consumeIngestion(id: string, owner: string, symbol: string): FilingIngestionArtifact | undefined {
    const value = this.ingestions.get(id);
    if (!value || value.ownerAgentId !== owner || value.symbol !== symbol || value.consumedAt) return undefined;
    value.consumedAt = new Date().toISOString(); return structuredClone(value);
  }
}

export class SqliteSourceReviewStore implements SourceReviewStore, FilingIngestionStore {
  private readonly db: DatabaseSync;
  private constructor(db: DatabaseSync) { this.db = db; this.db.exec(`CREATE TABLE IF NOT EXISTS financial_model_source_reviews (
    model_id TEXT PRIMARY KEY, artifact_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS financial_model_filing_ingestions (
      ingestion_run_id TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, symbol TEXT NOT NULL, artifact_json TEXT NOT NULL, created_at TEXT NOT NULL
    );`); }
  static open(path: string): SqliteSourceReviewStore { mkdirSync(dirname(path), { recursive: true }); return new SqliteSourceReviewStore(new DatabaseSync(path)); }
  save(id: string, artifact: SourceReviewArtifact): void {
    this.db.prepare("INSERT INTO financial_model_source_reviews VALUES (?, ?, ?)").run(id, JSON.stringify(artifact), new Date().toISOString());
  }
  get(id: string): SourceReviewArtifact | undefined {
    const row = this.db.prepare("SELECT artifact_json FROM financial_model_source_reviews WHERE model_id=?").get(id) as { artifact_json: string } | undefined;
    return row ? JSON.parse(row.artifact_json) as SourceReviewArtifact : undefined;
  }
  saveIngestion(artifact: FilingIngestionArtifact): void {
    this.db.prepare("INSERT INTO financial_model_filing_ingestions VALUES (?, ?, ?, ?, ?)")
      .run(artifact.ingestionRunId, artifact.ownerAgentId, artifact.symbol, JSON.stringify(artifact), new Date().toISOString());
  }
  getIngestion(id: string): FilingIngestionArtifact | undefined {
    const row = this.db.prepare("SELECT artifact_json FROM financial_model_filing_ingestions WHERE ingestion_run_id=?").get(id) as { artifact_json: string } | undefined;
    return row ? JSON.parse(row.artifact_json) as FilingIngestionArtifact : undefined;
  }
  consumeIngestion(id: string, owner: string, symbol: string): FilingIngestionArtifact | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = this.getIngestion(id);
      if (!value || value.ownerAgentId !== owner || value.symbol !== symbol || value.consumedAt) { this.db.exec("ROLLBACK"); return undefined; }
      value.consumedAt = new Date().toISOString();
      this.db.prepare("UPDATE financial_model_filing_ingestions SET artifact_json=? WHERE ingestion_run_id=?").run(JSON.stringify(value), id);
      this.db.exec("COMMIT"); return value;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
