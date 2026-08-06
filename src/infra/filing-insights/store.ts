import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FilingChunk, FilingInsight, FilingInsightContextView, FilingInsightDetailView, FilingInsightExtractionRun, FilingInsightFailure } from "./types.ts";

export type StoredInsightSet = { context: FilingInsightContextView; insights: FilingInsight[]; chunks: FilingChunk[];
  run?: FilingInsightExtractionRun; failures?: FilingInsightFailure[] };

export interface FilingInsightStore {
  save(set: StoredInsightSet): void;
  getContext(insightSetId: string): FilingInsightContextView | undefined;
  getDetail(insightSetId: string, insightId: string): FilingInsightDetailView | undefined;
  reusable(contentHash: string, extractorVersion: string): FilingInsight[] | undefined;
  failureAttempts(contentHash: string, extractorVersion: string): number;
  getRun(insightSetId: string): FilingInsightExtractionRun | undefined;
  getFailures(insightSetId: string): FilingInsightFailure[];
}

export class InMemoryFilingInsightStore implements FilingInsightStore {
  private readonly sets = new Map<string, StoredInsightSet>();
  save(set: StoredInsightSet): void { this.sets.set(set.context.insightSetId, structuredClone(set)); }
  getContext(id: string): FilingInsightContextView | undefined { const value = this.sets.get(id)?.context; return value && structuredClone(value); }
  getDetail(id: string, insightId: string): FilingInsightDetailView | undefined {
    const set = this.sets.get(id); const insight = set?.insights.find((entry) => entry.insightId === insightId);
    const chunk = set?.chunks.find((entry) => entry.chunkId === insight?.sourceAnchor.chunkId);
    return insight && chunk ? structuredClone({ ...insight, sourceChunk: chunk }) : undefined;
  }
  reusable(hash: string, version: string): FilingInsight[] | undefined {
    for (const set of this.sets.values()) {
      if (set.context.extractorVersion !== version) continue;
      if (set.failures?.some((failure) => failure.contentHash === hash)) continue;
      const hits = set.insights.filter((entry) => entry.sourceAnchor.contentHash === hash);
      if (hits.length > 0 || set.chunks.some((chunk) => chunk.sourceAnchor.contentHash === hash)) return structuredClone(hits);
    }
    return undefined;
  }
  failureAttempts(hash: string, version: string): number { return Math.max(0, ...[...this.sets.values()].filter((set) => set.context.extractorVersion === version)
    .flatMap((set) => set.failures ?? []).filter((failure) => failure.contentHash === hash).map((failure) => failure.attemptCount)); }
  getRun(id: string): FilingInsightExtractionRun | undefined { const value = this.sets.get(id)?.run; return value && structuredClone(value); }
  getFailures(id: string): FilingInsightFailure[] { return structuredClone(this.sets.get(id)?.failures ?? []); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS filing_insight_sets (
  insight_set_id TEXT PRIMARY KEY, extractor_version TEXT NOT NULL, context_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS filing_insight_chunks (
  insight_set_id TEXT NOT NULL, chunk_id TEXT NOT NULL, content_hash TEXT NOT NULL, chunk_json TEXT NOT NULL,
  PRIMARY KEY (insight_set_id, chunk_id)
);
CREATE TABLE IF NOT EXISTS filing_insights (
  insight_set_id TEXT NOT NULL, insight_id TEXT NOT NULL, content_hash TEXT NOT NULL, insight_json TEXT NOT NULL,
  PRIMARY KEY (insight_set_id, insight_id)
);
CREATE INDEX IF NOT EXISTS filing_insight_reuse ON filing_insights(content_hash);
CREATE INDEX IF NOT EXISTS filing_chunk_reuse ON filing_insight_chunks(content_hash);
CREATE TABLE IF NOT EXISTS filing_insight_runs (
  insight_set_id TEXT PRIMARY KEY, run_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS filing_insight_failures (
  insight_set_id TEXT NOT NULL, chunk_id TEXT NOT NULL, content_hash TEXT NOT NULL, failure_json TEXT NOT NULL,
  PRIMARY KEY (insight_set_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS filing_failure_retry ON filing_insight_failures(content_hash);
`;

export class SqliteFilingInsightStore implements FilingInsightStore {
  private readonly db: DatabaseSync;
  private constructor(db: DatabaseSync) { this.db = db; this.db.exec(SCHEMA); }
  static open(path: string): SqliteFilingInsightStore { mkdirSync(dirname(path), { recursive: true }); return new SqliteFilingInsightStore(new DatabaseSync(path)); }
  close(): void { this.db.close(); }
  save(set: StoredInsightSet): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO filing_insight_sets VALUES (?, ?, ?, ?)").run(set.context.insightSetId, set.context.extractorVersion, JSON.stringify(set.context), new Date().toISOString());
      const chunkInsert = this.db.prepare("INSERT INTO filing_insight_chunks VALUES (?, ?, ?, ?)");
      for (const chunk of set.chunks) chunkInsert.run(set.context.insightSetId, chunk.chunkId, chunk.sourceAnchor.contentHash, JSON.stringify(chunk));
      const insightInsert = this.db.prepare("INSERT INTO filing_insights VALUES (?, ?, ?, ?)");
      for (const insight of set.insights) insightInsert.run(set.context.insightSetId, insight.insightId, insight.sourceAnchor.contentHash, JSON.stringify(insight));
      if (set.run) this.db.prepare("INSERT INTO filing_insight_runs VALUES (?, ?)").run(set.context.insightSetId, JSON.stringify(set.run));
      const failureInsert = this.db.prepare("INSERT INTO filing_insight_failures VALUES (?, ?, ?, ?)");
      for (const failure of set.failures ?? []) failureInsert.run(set.context.insightSetId, failure.chunkId, failure.contentHash, JSON.stringify(failure));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getContext(id: string): FilingInsightContextView | undefined {
    const row = this.db.prepare("SELECT context_json FROM filing_insight_sets WHERE insight_set_id = ?").get(id) as { context_json: string } | undefined;
    return row ? JSON.parse(row.context_json) as FilingInsightContextView : undefined;
  }
  getDetail(id: string, insightId: string): FilingInsightDetailView | undefined {
    const row = this.db.prepare(`SELECT i.insight_json, c.chunk_json FROM filing_insights i
      JOIN filing_insight_chunks c ON c.insight_set_id=i.insight_set_id AND c.content_hash=i.content_hash
      WHERE i.insight_set_id=? AND i.insight_id=? LIMIT 1`).get(id, insightId) as { insight_json: string; chunk_json: string } | undefined;
    return row ? { ...(JSON.parse(row.insight_json) as FilingInsight), sourceChunk: JSON.parse(row.chunk_json) as FilingChunk } : undefined;
  }
  reusable(hash: string, version: string): FilingInsight[] | undefined {
    const chunk = this.db.prepare(`SELECT 1 FROM filing_insight_chunks c JOIN filing_insight_sets s ON s.insight_set_id=c.insight_set_id
      WHERE c.content_hash=? AND s.extractor_version=? AND NOT EXISTS (
        SELECT 1 FROM filing_insight_failures f WHERE f.insight_set_id=c.insight_set_id AND f.content_hash=c.content_hash
      ) LIMIT 1`).get(hash, version);
    if (!chunk) return undefined;
    return (this.db.prepare(`SELECT i.insight_json FROM filing_insights i JOIN filing_insight_sets s ON s.insight_set_id=i.insight_set_id
      WHERE i.content_hash=? AND s.extractor_version=? AND NOT EXISTS (
        SELECT 1 FROM filing_insight_failures f WHERE f.insight_set_id=i.insight_set_id AND f.content_hash=i.content_hash
      )`).all(hash, version) as Array<{ insight_json: string }>).map((row) => JSON.parse(row.insight_json) as FilingInsight);
  }
  failureAttempts(hash: string, version: string): number {
    const rows = this.db.prepare(`SELECT f.failure_json FROM filing_insight_failures f JOIN filing_insight_sets s ON s.insight_set_id=f.insight_set_id
      WHERE f.content_hash=? AND s.extractor_version=?`).all(hash, version) as Array<{ failure_json: string }>;
    return Math.max(0, ...rows.map((row) => (JSON.parse(row.failure_json) as FilingInsightFailure).attemptCount));
  }
  getRun(id: string): FilingInsightExtractionRun | undefined {
    const row = this.db.prepare("SELECT run_json FROM filing_insight_runs WHERE insight_set_id=?").get(id) as { run_json: string } | undefined;
    return row ? JSON.parse(row.run_json) as FilingInsightExtractionRun : undefined;
  }
  getFailures(id: string): FilingInsightFailure[] {
    return (this.db.prepare("SELECT failure_json FROM filing_insight_failures WHERE insight_set_id=? ORDER BY chunk_id").all(id) as Array<{ failure_json: string }>)
      .map((row) => JSON.parse(row.failure_json) as FilingInsightFailure);
  }
}
