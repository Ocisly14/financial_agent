import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FinancialModelError } from "./errors.ts";
import type { LifecycleStage } from "./types.ts";
import type { JsonObject, JsonValue } from "../framework/types.ts";

export type NewModelMeta = {
  modelId: string;
  ownerTenantId: string;
  originSessionId: string;
  symbol: string;
  metadata: JsonObject;
};

export type ModelFilter = {
  ownerTenantId?: string;
  originSessionId?: string;
  symbol?: string;
  lifecycleStage?: LifecycleStage;
  includeArchived?: boolean;
};

export type RevisionInput<TSnapshot, TChangeSummary extends JsonObject = JsonObject> = {
  lifecycleStage: LifecycleStage;
  snapshot: TSnapshot;
  changeSummary: TChangeSummary;
  engineVersion: string;
  creatingSessionId: string;
};

export type Revision<TSnapshot, TChangeSummary extends JsonObject = JsonObject> =
  RevisionInput<TSnapshot, TChangeSummary> & {
    modelId: string;
    revision: number;
    parentRevision: number | null;
    createdAt: string;
  };

export type RevisionHeader<TChangeSummary extends JsonObject = JsonObject> = {
  modelId: string;
  revision: number;
  parentRevision: number | null;
  lifecycleStage: LifecycleStage;
  changeSummary: TChangeSummary;
  engineVersion: string;
  creatingSessionId: string;
  createdAt: string;
};

export type ModelView = NewModelMeta & {
  currentRevision: number;
  lifecycleStage: LifecycleStage;
  updatedAt: string;
  createdAt: string;
};

export type SnapshotCodec<TSnapshot> = {
  encode(snapshot: TSnapshot): string;
  decode(json: string): TSnapshot;
};

export interface ModelStore<TSnapshot, TChangeSummary extends JsonObject = JsonObject> {
  create(meta: NewModelMeta, initial: RevisionInput<TSnapshot, TChangeSummary>): Revision<TSnapshot, TChangeSummary>;
  getMeta(modelId: string): ModelView | undefined;
  list(filter?: ModelFilter): ModelView[];
  getRevision(modelId: string, revision?: number): Revision<TSnapshot, TChangeSummary> | undefined;
  listRevisionHeaders(modelId: string): RevisionHeader<TChangeSummary>[];
  commit(modelId: string, expectedRevision: number,
    input: RevisionInput<TSnapshot, TChangeSummary>): Revision<TSnapshot, TChangeSummary>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateJson(
  value: unknown,
  path = "$",
  ancestors: Set<object> = new Set(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FinancialModelError("invalid_snapshot", `non-finite JSON number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new FinancialModelError("invalid_snapshot", `cyclic JSON value at ${path}`);
    ancestors.add(value);
    value.forEach((entry, index) => validateJson(entry, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (ancestors.has(value)) throw new FinancialModelError("invalid_snapshot", `cyclic JSON value at ${path}`);
    ancestors.add(value);
    for (const [key, entry] of Object.entries(value)) validateJson(entry, `${path}.${key}`, ancestors);
    ancestors.delete(value);
    return;
  }
  throw new FinancialModelError("invalid_snapshot", `value at ${path} is not JSON-compatible`);
}

function encodeSummary(summary: JsonObject): string {
  validateJson(summary);
  return JSON.stringify(summary);
}

function decodeSummary<T extends JsonObject>(json: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch (cause) { throw new FinancialModelError("invalid_snapshot", "stored change summary is malformed JSON", { cause: String(cause) }); }
  validateJson(parsed);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new FinancialModelError("invalid_snapshot", "stored change summary is not an object");
  }
  return parsed as T;
}

function validateInput<TSnapshot, TSummary extends JsonObject>(
  codec: SnapshotCodec<TSnapshot>, input: RevisionInput<TSnapshot, TSummary>,
): { snapshotJson: string; summaryJson: string } {
  let snapshotJson: string;
  try {
    // The generic domain snapshot may contain Maps even though its encoded
    // representation must be JSON. The caller-supplied codec owns schema and
    // non-finite validation of TSnapshot itself.
    snapshotJson = codec.encode(input.snapshot);
    if (typeof snapshotJson !== "string") throw new Error("snapshot codec did not return a string");
    const encoded: unknown = JSON.parse(snapshotJson);
    validateJson(encoded);
    codec.decode(snapshotJson);
  } catch (error) {
    if (error instanceof FinancialModelError) throw error;
    throw new FinancialModelError("invalid_snapshot", "snapshot codec rejected the revision", { cause: String(error) });
  }
  return { snapshotJson, summaryJson: encodeSummary(input.changeSummary) };
}

function matchesFilter(view: ModelView, filter: ModelFilter): boolean {
  const includesArchived = filter.includeArchived || filter.lifecycleStage === "archived";
  if (!includesArchived && view.lifecycleStage === "archived") return false;
  if (filter.ownerTenantId !== undefined && view.ownerTenantId !== filter.ownerTenantId) return false;
  if (filter.originSessionId !== undefined && view.originSessionId !== filter.originSessionId) return false;
  if (filter.symbol !== undefined && view.symbol !== filter.symbol) return false;
  if (filter.lifecycleStage !== undefined && view.lifecycleStage !== filter.lifecycleStage) return false;
  return true;
}

export class InMemoryModelStore<TSnapshot, TChangeSummary extends JsonObject = JsonObject>
implements ModelStore<TSnapshot, TChangeSummary> {
  private readonly models = new Map<string, { meta: NewModelMeta; revisions: Array<Revision<TSnapshot, TChangeSummary>> }>();
  private readonly codec: SnapshotCodec<TSnapshot>;

  constructor(codec: SnapshotCodec<TSnapshot>) { this.codec = codec; }

  create(meta: NewModelMeta, initial: RevisionInput<TSnapshot, TChangeSummary>): Revision<TSnapshot, TChangeSummary> {
    if (this.models.has(meta.modelId)) throw new FinancialModelError("invalid_model_operation", `model already exists: ${meta.modelId}`);
    validateJson(meta.metadata);
    validateInput(this.codec, initial);
    const createdAt = new Date().toISOString();
    const revision: Revision<TSnapshot, TChangeSummary> = {
      ...clone(initial), modelId: meta.modelId, revision: 0, parentRevision: null, createdAt,
    };
    this.models.set(meta.modelId, { meta: clone(meta), revisions: [revision] });
    return clone(revision);
  }

  getMeta(modelId: string): ModelView | undefined {
    const record = this.models.get(modelId);
    if (!record) return undefined;
    const latest = record.revisions.at(-1)!;
    return clone({ ...record.meta, currentRevision: latest.revision, lifecycleStage: latest.lifecycleStage,
      updatedAt: latest.createdAt, createdAt: record.revisions[0]!.createdAt });
  }

  list(filter: ModelFilter = {}): ModelView[] {
    return [...this.models.keys()].sort().map((id) => this.getMeta(id)!)
      .filter((view) => matchesFilter(view, filter));
  }

  getRevision(modelId: string, revision?: number): Revision<TSnapshot, TChangeSummary> | undefined {
    const revisions = this.models.get(modelId)?.revisions;
    if (!revisions) return undefined;
    const result = revision === undefined ? revisions.at(-1) : revisions.find((entry) => entry.revision === revision);
    return result === undefined ? undefined : clone(result);
  }

  listRevisionHeaders(modelId: string): RevisionHeader<TChangeSummary>[] {
    const revisions = this.models.get(modelId)?.revisions ?? [];
    return revisions.map(({ snapshot: _snapshot, ...header }) => clone(header));
  }

  commit(modelId: string, expectedRevision: number,
    input: RevisionInput<TSnapshot, TChangeSummary>): Revision<TSnapshot, TChangeSummary> {
    const record = this.models.get(modelId);
    if (!record) throw new FinancialModelError("financial_model_not_found", `model not found: ${modelId}`);
    const currentRevision = record.revisions.length - 1;
    if (currentRevision !== expectedRevision) {
      throw new FinancialModelError("revision_conflict", `expected revision ${expectedRevision}, current is ${currentRevision}`, { currentRevision });
    }
    validateInput(this.codec, input);
    const revision: Revision<TSnapshot, TChangeSummary> = {
      ...clone(input), modelId, revision: expectedRevision + 1, parentRevision: expectedRevision,
      createdAt: new Date().toISOString(),
    };
    record.revisions.push(revision);
    return clone(revision);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS financial_models (
  model_id TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, origin_session_id TEXT NOT NULL,
  symbol TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS financial_model_revisions (
  model_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0), parent_revision INTEGER,
  lifecycle_stage TEXT NOT NULL, snapshot_json TEXT NOT NULL, change_summary_json TEXT NOT NULL,
  engine_version TEXT NOT NULL, creating_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (model_id, revision),
  FOREIGN KEY (model_id) REFERENCES financial_models(model_id)
);
CREATE INDEX IF NOT EXISTS financial_model_revisions_latest
  ON financial_model_revisions(model_id, revision DESC);
`;

type ModelRow = { model_id: string; owner_agent_id: string; origin_session_id: string; symbol: string; metadata_json: string; created_at: string };
type RevisionRow = { model_id: string; revision: number; parent_revision: number | null; lifecycle_stage: LifecycleStage;
  snapshot_json: string; change_summary_json: string; engine_version: string; creating_session_id: string; created_at: string };
type RevisionHeaderRow = Omit<RevisionRow, "snapshot_json">;

export class SqliteModelStore<TSnapshot, TChangeSummary extends JsonObject = JsonObject>
implements ModelStore<TSnapshot, TChangeSummary> {
  private readonly db: DatabaseSync;
  private readonly codec: SnapshotCodec<TSnapshot>;

  private constructor(db: DatabaseSync, codec: SnapshotCodec<TSnapshot>) {
    this.db = db;
    this.codec = codec;
  }

  static open<TSnapshot, TChangeSummary extends JsonObject = JsonObject>(
    path: string, codec: SnapshotCodec<TSnapshot>,
  ): SqliteModelStore<TSnapshot, TChangeSummary> {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    return new SqliteModelStore<TSnapshot, TChangeSummary>(db, codec);
  }

  close(): void { this.db.close(); }

  create(meta: NewModelMeta, initial: RevisionInput<TSnapshot, TChangeSummary>): Revision<TSnapshot, TChangeSummary> {
    validateJson(meta.metadata);
    const encoded = validateInput(this.codec, initial);
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO financial_models VALUES (?, ?, ?, ?, ?, ?)")
        .run(meta.modelId, meta.ownerTenantId, meta.originSessionId, meta.symbol, JSON.stringify(meta.metadata), createdAt);
      this.db.prepare("INSERT INTO financial_model_revisions VALUES (?, 0, NULL, ?, ?, ?, ?, ?, ?)")
        .run(meta.modelId, initial.lifecycleStage, encoded.snapshotJson, encoded.summaryJson,
          initial.engineVersion, initial.creatingSessionId, createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRevision(meta.modelId, 0)!;
  }

  getMeta(modelId: string): ModelView | undefined {
    const row = this.db.prepare(`SELECT m.*, r.revision, r.lifecycle_stage, r.created_at AS updated_at
      FROM financial_models m JOIN financial_model_revisions r ON r.model_id=m.model_id
      WHERE m.model_id=? ORDER BY r.revision DESC LIMIT 1`).get(modelId) as (ModelRow & {
        revision: number; lifecycle_stage: LifecycleStage; updated_at: string;
      }) | undefined;
    if (!row) return undefined;
    return { modelId: row.model_id, ownerTenantId: row.owner_agent_id, originSessionId: row.origin_session_id,
      symbol: row.symbol, metadata: decodeSummary<JsonObject>(row.metadata_json), currentRevision: row.revision,
      lifecycleStage: row.lifecycle_stage, updatedAt: row.updated_at, createdAt: row.created_at };
  }

  list(filter: ModelFilter = {}): ModelView[] {
    const rows = this.db.prepare("SELECT model_id FROM financial_models ORDER BY model_id").all() as Array<{ model_id: string }>;
    return rows.map((row) => this.getMeta(row.model_id)!).filter((view) => matchesFilter(view, filter));
  }

  getRevision(modelId: string, revision?: number): Revision<TSnapshot, TChangeSummary> | undefined {
    const sql = revision === undefined
      ? "SELECT * FROM financial_model_revisions WHERE model_id=? ORDER BY revision DESC LIMIT 1"
      : "SELECT * FROM financial_model_revisions WHERE model_id=? AND revision=?";
    const row = (revision === undefined ? this.db.prepare(sql).get(modelId) : this.db.prepare(sql).get(modelId, revision)) as RevisionRow | undefined;
    return row ? this.decodeRevision(row) : undefined;
  }

  listRevisionHeaders(modelId: string): RevisionHeader<TChangeSummary>[] {
    const rows = this.db.prepare(`SELECT model_id, revision, parent_revision, lifecycle_stage,
      change_summary_json, engine_version, creating_session_id, created_at
      FROM financial_model_revisions WHERE model_id=? ORDER BY revision`).all(modelId) as RevisionHeaderRow[];
    return rows.map((row) => ({ modelId: row.model_id, revision: row.revision, parentRevision: row.parent_revision,
      lifecycleStage: row.lifecycle_stage, changeSummary: decodeSummary<TChangeSummary>(row.change_summary_json),
      engineVersion: row.engine_version, creatingSessionId: row.creating_session_id, createdAt: row.created_at }));
  }

  commit(modelId: string, expectedRevision: number,
    input: RevisionInput<TSnapshot, TChangeSummary>): Revision<TSnapshot, TChangeSummary> {
    if (!this.db.prepare("SELECT 1 FROM financial_models WHERE model_id=?").get(modelId)) {
      throw new FinancialModelError("financial_model_not_found", `model not found: ${modelId}`);
    }
    const encoded = validateInput(this.codec, input);
    const latest = this.latestRevision(modelId);
    if (latest !== expectedRevision) {
      throw new FinancialModelError("revision_conflict", `expected revision ${expectedRevision}, current is ${latest}`, { currentRevision: latest });
    }
    const next = expectedRevision + 1;
    const createdAt = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO financial_model_revisions
        (model_id, revision, parent_revision, lifecycle_stage, snapshot_json, change_summary_json,
         engine_version, creating_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(modelId, next, expectedRevision, input.lifecycleStage, encoded.snapshotJson, encoded.summaryJson,
          input.engineVersion, input.creatingSessionId, createdAt);
    } catch (error) {
      const currentRevision = this.latestRevision(modelId);
      if (currentRevision !== expectedRevision) {
        throw new FinancialModelError("revision_conflict", `expected revision ${expectedRevision}, current is ${currentRevision}`, { currentRevision });
      }
      throw error;
    }
    return this.getRevision(modelId, next)!;
  }

  private latestRevision(modelId: string): number {
    const row = this.db.prepare("SELECT MAX(revision) AS revision FROM financial_model_revisions WHERE model_id=?").get(modelId) as { revision: number | null };
    return row.revision ?? -1;
  }

  private decodeRevision(row: RevisionRow): Revision<TSnapshot, TChangeSummary> {
    let snapshot: TSnapshot;
    try {
      snapshot = this.codec.decode(row.snapshot_json);
    }
    catch (error) {
      if (error instanceof FinancialModelError) throw error;
      throw new FinancialModelError("invalid_snapshot", "stored snapshot could not be decoded", { cause: String(error) });
    }
    return { modelId: row.model_id, revision: row.revision, parentRevision: row.parent_revision,
      lifecycleStage: row.lifecycle_stage, snapshot, changeSummary: decodeSummary<TChangeSummary>(row.change_summary_json),
      engineVersion: row.engine_version, creatingSessionId: row.creating_session_id, createdAt: row.created_at };
  }
}
