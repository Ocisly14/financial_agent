import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CandidateScheme, ChildMergeRecord, FilingDecompositionProposal, FinalDecompositionDecision,
  MintedTableFact, ReduceDecision,
} from "./decompositionTypes.ts";

export interface DecompositionStore {
  saveMapProposal(runId: string, proposal: FilingDecompositionProposal): void;
  listMapProposals(runId: string): FilingDecompositionProposal[];
  saveMintedFacts(runId: string, facts: readonly MintedTableFact[]): void;
  listMintedFacts(runId: string): MintedTableFact[];
  saveCandidates(runId: string, candidates: readonly CandidateScheme[]): void;
  listCandidates(runId: string): CandidateScheme[];
  saveChildMerge(runId: string, merge: ChildMergeRecord): void;
  listChildMerges(runId: string): ChildMergeRecord[];
  saveReduceDecision(runId: string, decision: ReduceDecision): void;
  getReduceDecision(runId: string): ReduceDecision | undefined;
  saveFinalDecision(runId: string, decision: FinalDecompositionDecision): void;
  getFinalDecision(runId: string): FinalDecompositionDecision | undefined;
  /** Host validation diagnostics for the run (spec §8); upserted as one list. */
  saveDiagnostics(runId: string, diagnostics: readonly string[]): void;
  listDiagnostics(runId: string): string[];
}

type Kind = "map_proposal" | "minted_fact" | "candidates" | "child_merge" | "reduce_decision" | "final_decision" | "diagnostics";

export class InMemoryDecompositionStore implements DecompositionStore {
  private readonly rows = new Map<string, unknown>();
  private key(runId: string, kind: Kind, key: string): string { return `${runId}|${kind}|${key}`; }
  private put(runId: string, kind: Kind, key: string, value: unknown): void { this.rows.set(this.key(runId, kind, key), structuredClone(value)); }
  private list<T>(runId: string, kind: Kind): T[] {
    const prefix = `${runId}|${kind}|`;
    return [...this.rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v) as T);
  }
  saveMapProposal(runId: string, proposal: FilingDecompositionProposal): void { this.put(runId, "map_proposal", proposal.accession, proposal); }
  listMapProposals(runId: string): FilingDecompositionProposal[] { return this.list(runId, "map_proposal"); }
  saveMintedFacts(runId: string, facts: readonly MintedTableFact[]): void { for (const fact of facts) this.put(runId, "minted_fact", fact.factId, fact); }
  listMintedFacts(runId: string): MintedTableFact[] { return this.list(runId, "minted_fact"); }
  saveCandidates(runId: string, candidates: readonly CandidateScheme[]): void { this.put(runId, "candidates", "all", candidates); }
  listCandidates(runId: string): CandidateScheme[] { return this.list<CandidateScheme[]>(runId, "candidates")[0] ?? []; }
  saveChildMerge(runId: string, merge: ChildMergeRecord): void { this.put(runId, "child_merge", `${merge.candidateSchemeId}|${merge.keepChildId}`, merge); }
  listChildMerges(runId: string): ChildMergeRecord[] { return this.list(runId, "child_merge"); }
  saveReduceDecision(runId: string, decision: ReduceDecision): void { this.put(runId, "reduce_decision", "one", decision); }
  getReduceDecision(runId: string): ReduceDecision | undefined { return this.list<ReduceDecision>(runId, "reduce_decision")[0]; }
  saveFinalDecision(runId: string, decision: FinalDecompositionDecision): void { this.put(runId, "final_decision", "one", decision); }
  getFinalDecision(runId: string): FinalDecompositionDecision | undefined { return this.list<FinalDecompositionDecision>(runId, "final_decision")[0]; }
  saveDiagnostics(runId: string, diagnostics: readonly string[]): void { this.put(runId, "diagnostics", "all", diagnostics); }
  listDiagnostics(runId: string): string[] { return this.list<string[]>(runId, "diagnostics")[0] ?? []; }
}

export class SqliteDecompositionStore implements DecompositionStore {
  private readonly db: DatabaseSync;
  private constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS decomposition_artifacts (
      ingestion_run_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      artifact_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
      PRIMARY KEY (ingestion_run_id, kind, key));`);
  }
  static open(path: string): SqliteDecompositionStore { mkdirSync(dirname(path), { recursive: true }); return new SqliteDecompositionStore(new DatabaseSync(path)); }
  private put(runId: string, kind: Kind, key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO decomposition_artifacts VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(ingestion_run_id, kind, key) DO UPDATE SET artifact_json=excluded.artifact_json, recorded_at=excluded.recorded_at`)
      .run(runId, kind, key, JSON.stringify(value), new Date().toISOString());
  }
  private list<T>(runId: string, kind: Kind): T[] {
    return (this.db.prepare("SELECT artifact_json FROM decomposition_artifacts WHERE ingestion_run_id=? AND kind=?")
      .all(runId, kind) as Array<{ artifact_json: string }>).map((row) => JSON.parse(row.artifact_json) as T);
  }
  saveMapProposal(runId: string, proposal: FilingDecompositionProposal): void { this.put(runId, "map_proposal", proposal.accession, proposal); }
  listMapProposals(runId: string): FilingDecompositionProposal[] { return this.list(runId, "map_proposal"); }
  saveMintedFacts(runId: string, facts: readonly MintedTableFact[]): void { for (const fact of facts) this.put(runId, "minted_fact", fact.factId, fact); }
  listMintedFacts(runId: string): MintedTableFact[] { return this.list(runId, "minted_fact"); }
  saveCandidates(runId: string, candidates: readonly CandidateScheme[]): void { this.put(runId, "candidates", "all", [...candidates]); }
  listCandidates(runId: string): CandidateScheme[] { return this.list<CandidateScheme[]>(runId, "candidates")[0] ?? []; }
  saveChildMerge(runId: string, merge: ChildMergeRecord): void { this.put(runId, "child_merge", `${merge.candidateSchemeId}|${merge.keepChildId}`, merge); }
  listChildMerges(runId: string): ChildMergeRecord[] { return this.list(runId, "child_merge"); }
  saveReduceDecision(runId: string, decision: ReduceDecision): void { this.put(runId, "reduce_decision", "one", decision); }
  getReduceDecision(runId: string): ReduceDecision | undefined { return this.list<ReduceDecision>(runId, "reduce_decision")[0]; }
  saveFinalDecision(runId: string, decision: FinalDecompositionDecision): void { this.put(runId, "final_decision", "one", decision); }
  getFinalDecision(runId: string): FinalDecompositionDecision | undefined { return this.list<FinalDecompositionDecision>(runId, "final_decision")[0]; }
  saveDiagnostics(runId: string, diagnostics: readonly string[]): void { this.put(runId, "diagnostics", "all", [...diagnostics]); }
  listDiagnostics(runId: string): string[] { return this.list<string[]>(runId, "diagnostics")[0] ?? []; }
  close(): void { this.db.close(); }
}
