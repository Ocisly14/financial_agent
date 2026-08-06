import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StatementKind } from "../../financial-model/types.ts";
import type {
  ColumnConflictWaiver,
  DerivedTableDefinition,
  FilingTable,
  FilingTableCatalogEntry,
  TableAnnotation,
  TableCuration,
} from "./tableTypes.ts";

const PAGE_SIZE = 20;
const CATALOG_ROW_LABELS = 15;

export type ListTablesQuery = {
  accession?: string;
  tier?: "strong" | "weak" | "all";
  statementHint?: StatementKind;
  topic?: string;
  uncuratedOnly?: boolean;
  cursor?: string;
};

export type ListTablesPage = { entries: FilingTableCatalogEntry[]; nextCursor?: string };

export type RowHit = { sourceTableId: string; heading: string; rows: Array<{ rowOrder: number; labelText: string }> };

export interface FilingTableStore {
  saveTables(runId: string, tables: readonly FilingTable[]): void;
  listTables(runId: string, query: ListTablesQuery): ListTablesPage;
  getTables(runId: string, sourceTableIds: readonly string[]): FilingTable[];
  findRows(runId: string, query: { query: string; scope?: readonly string[]; limit?: number }): RowHit[];
  saveCuration(runId: string, curation: TableCuration): void;
  listCurations(runId: string): TableCuration[];
  saveColumnConflictWaiver(runId: string, waiver: ColumnConflictWaiver): void;
  listColumnConflictWaivers(runId: string): ColumnConflictWaiver[];
  saveAnnotation(runId: string, annotation: Partial<TableAnnotation> & { tableId: string }): void;
  listAnnotations(runId: string): TableAnnotation[];
  saveDerivedTable(runId: string, definition: DerivedTableDefinition): void;
  listDerivedTables(runId: string): DerivedTableDefinition[];
}

/** Collapse case and runs of whitespace so a search matches what a reader sees. */
export function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function catalogEntry(table: FilingTable): FilingTableCatalogEntry {
  const labels = table.rows.map((row) => row.labelText);
  return {
    sourceTableId: table.sourceTableId, accession: table.accession, form: table.form, filedAt: table.filedAt,
    reportDate: table.reportDate, heading: table.heading, htmlOrder: table.htmlOrder,
    rowCount: table.rows.length,
    factCount: table.rows.reduce((sum, row) => sum + row.cells.filter((cell) => cell.fact).length, 0),
    columnHeaders: table.columns.map((column) => column.headerText),
    rowLabels: labels.slice(0, CATALOG_ROW_LABELS),
    rowLabelsTruncated: labels.length > CATALOG_ROW_LABELS,
    prescreen: table.prescreen,
    suggestedStatements: table.suggestedStatements,
  };
}

function matchRows(table: FilingTable, needle: string): RowHit | undefined {
  const rows = table.rows
    .filter((row) => normalizeSearchText(row.labelText).includes(needle))
    .map((row) => ({ rowOrder: row.order, labelText: row.labelText }));
  const headingMatches = normalizeSearchText(table.heading).includes(needle)
    || table.columns.some((column) => normalizeSearchText(column.headerText).includes(needle));
  if (rows.length === 0 && !headingMatches) return undefined;
  return { sourceTableId: table.sourceTableId, heading: table.heading, rows };
}

/** Shared query semantics over an already-materialized run, so both stores agree. */
function queryRun(
  tables: FilingTable[],
  curations: Map<string, TableCuration>,
  annotations: Map<string, TableAnnotation>,
  query: ListTablesQuery,
): ListTablesPage {
  const tier = query.tier ?? "strong";
  const filtered = tables.filter((table) => {
    if (query.accession && table.accession !== query.accession) return false;
    if (tier !== "all" && table.prescreen.tier !== tier) return false;
    if (query.statementHint && !table.suggestedStatements.includes(query.statementHint)) return false;
    if (query.topic && !(annotations.get(table.sourceTableId)?.topics ?? []).includes(query.topic as never)) return false;
    if (query.uncuratedOnly && curations.has(table.sourceTableId)) return false;
    return true;
  }).sort((left, right) => left.filedAt.localeCompare(right.filedAt)
    || left.htmlOrder - right.htmlOrder
    || left.sourceTableId.localeCompare(right.sourceTableId));

  const start = query.cursor ? Number(query.cursor) : 0;
  const page = filtered.slice(start, start + PAGE_SIZE);
  const nextStart = start + page.length;
  return {
    entries: page.map((table) => {
      const entry = catalogEntry(table);
      const curation = curations.get(table.sourceTableId);
      const annotation = annotations.get(table.sourceTableId);
      return { ...entry, ...(curation ? { curation } : {}), ...(annotation ? { annotation } : {}) };
    }),
    ...(nextStart < filtered.length ? { nextCursor: String(nextStart) } : {}),
  };
}

function mergeAnnotation(existing: TableAnnotation | undefined, patch: Partial<TableAnnotation> & { tableId: string }): TableAnnotation {
  return {
    tableId: patch.tableId,
    ...(patch.title ?? existing?.title ? { title: patch.title ?? existing!.title } : {}),
    ...(patch.summary ?? existing?.summary ? { summary: patch.summary ?? existing!.summary } : {}),
    topics: patch.topics ?? existing?.topics ?? [],
  };
}

type Run = {
  tables: Map<string, FilingTable>;
  curations: Map<string, TableCuration>;
  conflictWaivers: Map<string, ColumnConflictWaiver>;
  annotations: Map<string, TableAnnotation>;
  derived: Map<string, DerivedTableDefinition>;
};

export class InMemoryFilingTableStore implements FilingTableStore {
  private readonly runs = new Map<string, Run>();

  private run(runId: string): Run {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    const created: Run = { tables: new Map(), curations: new Map(), conflictWaivers: new Map(), annotations: new Map(), derived: new Map() };
    this.runs.set(runId, created);
    return created;
  }

  saveTables(runId: string, tables: readonly FilingTable[]): void {
    const run = this.run(runId);
    for (const table of tables) run.tables.set(table.sourceTableId, structuredClone(table) as FilingTable);
  }

  listTables(runId: string, query: ListTablesQuery): ListTablesPage {
    const run = this.run(runId);
    return queryRun([...run.tables.values()], run.curations, run.annotations, query);
  }

  getTables(runId: string, sourceTableIds: readonly string[]): FilingTable[] {
    const run = this.run(runId);
    return sourceTableIds.flatMap((id) => { const table = run.tables.get(id); return table ? [structuredClone(table) as FilingTable] : []; });
  }

  findRows(runId: string, query: { query: string; scope?: readonly string[]; limit?: number }): RowHit[] {
    const run = this.run(runId);
    const needle = normalizeSearchText(query.query);
    const scope = query.scope ? new Set(query.scope) : undefined;
    return [...run.tables.values()]
      .filter((table) => !scope || scope.has(table.sourceTableId))
      .flatMap((table) => { const hit = matchRows(table, needle); return hit ? [hit] : []; })
      .slice(0, query.limit ?? 50);
  }

  saveCuration(runId: string, curation: TableCuration): void {
    this.run(runId).curations.set(curation.sourceTableId, structuredClone(curation) as TableCuration);
  }

  listCurations(runId: string): TableCuration[] { return [...this.run(runId).curations.values()]; }

  saveColumnConflictWaiver(runId: string, waiver: ColumnConflictWaiver): void {
    this.run(runId).conflictWaivers.set(conflictKey(waiver), structuredClone(waiver) as ColumnConflictWaiver);
  }

  listColumnConflictWaivers(runId: string): ColumnConflictWaiver[] {
    return [...this.run(runId).conflictWaivers.values()].map((waiver) => structuredClone(waiver) as ColumnConflictWaiver);
  }

  saveAnnotation(runId: string, annotation: Partial<TableAnnotation> & { tableId: string }): void {
    const run = this.run(runId);
    run.annotations.set(annotation.tableId, mergeAnnotation(run.annotations.get(annotation.tableId), annotation));
  }

  listAnnotations(runId: string): TableAnnotation[] { return [...this.run(runId).annotations.values()]; }

  saveDerivedTable(runId: string, definition: DerivedTableDefinition): void {
    this.run(runId).derived.set(definition.derivedTableId, structuredClone(definition) as DerivedTableDefinition);
  }

  listDerivedTables(runId: string): DerivedTableDefinition[] { return [...this.run(runId).derived.values()]; }
}

export class SqliteFilingTableStore implements FilingTableStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS filing_tables (
        ingestion_run_id TEXT NOT NULL, source_table_id TEXT NOT NULL, accession TEXT NOT NULL,
        table_json TEXT NOT NULL, PRIMARY KEY (ingestion_run_id, source_table_id));
      CREATE TABLE IF NOT EXISTS filing_table_curations (
        ingestion_run_id TEXT NOT NULL, source_table_id TEXT NOT NULL, curation_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL, PRIMARY KEY (ingestion_run_id, source_table_id));
      CREATE TABLE IF NOT EXISTS filing_table_column_conflict_waivers (
        ingestion_run_id TEXT NOT NULL, source_table_id TEXT NOT NULL, row_order INTEGER NOT NULL,
        column_index INTEGER NOT NULL, waiver_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY (ingestion_run_id, source_table_id, row_order, column_index));
      CREATE TABLE IF NOT EXISTS table_annotations (
        ingestion_run_id TEXT NOT NULL, table_id TEXT NOT NULL, annotation_json TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY (ingestion_run_id, table_id));
      CREATE TABLE IF NOT EXISTS derived_tables (
        ingestion_run_id TEXT NOT NULL, derived_table_id TEXT NOT NULL, definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (ingestion_run_id, derived_table_id));
    `);
  }

  static open(path: string): SqliteFilingTableStore {
    mkdirSync(dirname(path), { recursive: true });
    return new SqliteFilingTableStore(new DatabaseSync(path));
  }

  private tables(runId: string): FilingTable[] {
    return (this.db.prepare("SELECT table_json FROM filing_tables WHERE ingestion_run_id=?").all(runId) as Array<{ table_json: string }>)
      .map((row) => JSON.parse(row.table_json) as FilingTable);
  }

  private curationMap(runId: string): Map<string, TableCuration> {
    return new Map(this.listCurations(runId).map((curation) => [curation.sourceTableId, curation]));
  }

  private annotationMap(runId: string): Map<string, TableAnnotation> {
    return new Map(this.listAnnotations(runId).map((annotation) => [annotation.tableId, annotation]));
  }

  saveTables(runId: string, tables: readonly FilingTable[]): void {
    const statement = this.db.prepare(
      "INSERT INTO filing_tables VALUES (?, ?, ?, ?) ON CONFLICT(ingestion_run_id, source_table_id) DO UPDATE SET table_json=excluded.table_json");
    for (const table of tables) statement.run(runId, table.sourceTableId, table.accession, JSON.stringify(table));
  }

  listTables(runId: string, query: ListTablesQuery): ListTablesPage {
    return queryRun(this.tables(runId), this.curationMap(runId), this.annotationMap(runId), query);
  }

  getTables(runId: string, sourceTableIds: readonly string[]): FilingTable[] {
    const statement = this.db.prepare("SELECT table_json FROM filing_tables WHERE ingestion_run_id=? AND source_table_id=?");
    return sourceTableIds.flatMap((id) => {
      const row = statement.get(runId, id) as { table_json: string } | undefined;
      return row ? [JSON.parse(row.table_json) as FilingTable] : [];
    });
  }

  findRows(runId: string, query: { query: string; scope?: readonly string[]; limit?: number }): RowHit[] {
    const needle = normalizeSearchText(query.query);
    const scope = query.scope ? new Set(query.scope) : undefined;
    return this.tables(runId)
      .filter((table) => !scope || scope.has(table.sourceTableId))
      .flatMap((table) => { const hit = matchRows(table, needle); return hit ? [hit] : []; })
      .slice(0, query.limit ?? 50);
  }

  saveCuration(runId: string, curation: TableCuration): void {
    this.db.prepare("INSERT INTO filing_table_curations VALUES (?, ?, ?, ?) ON CONFLICT(ingestion_run_id, source_table_id) DO UPDATE SET curation_json=excluded.curation_json, recorded_at=excluded.recorded_at")
      .run(runId, curation.sourceTableId, JSON.stringify(curation), new Date().toISOString());
  }

  listCurations(runId: string): TableCuration[] {
    return (this.db.prepare("SELECT curation_json FROM filing_table_curations WHERE ingestion_run_id=?").all(runId) as Array<{ curation_json: string }>)
      .map((row) => JSON.parse(row.curation_json) as TableCuration);
  }

  saveColumnConflictWaiver(runId: string, waiver: ColumnConflictWaiver): void {
    this.db.prepare(`INSERT INTO filing_table_column_conflict_waivers VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ingestion_run_id, source_table_id, row_order, column_index)
      DO UPDATE SET waiver_json=excluded.waiver_json, recorded_at=excluded.recorded_at`)
      .run(runId, waiver.sourceTableId, waiver.rowOrder, waiver.columnIndex, JSON.stringify(waiver), new Date().toISOString());
  }

  listColumnConflictWaivers(runId: string): ColumnConflictWaiver[] {
    return (this.db.prepare("SELECT waiver_json FROM filing_table_column_conflict_waivers WHERE ingestion_run_id=?")
      .all(runId) as Array<{ waiver_json: string }>).map((row) => JSON.parse(row.waiver_json) as ColumnConflictWaiver);
  }

  saveAnnotation(runId: string, annotation: Partial<TableAnnotation> & { tableId: string }): void {
    const merged = mergeAnnotation(this.annotationMap(runId).get(annotation.tableId), annotation);
    this.db.prepare("INSERT INTO table_annotations VALUES (?, ?, ?, ?) ON CONFLICT(ingestion_run_id, table_id) DO UPDATE SET annotation_json=excluded.annotation_json, updated_at=excluded.updated_at")
      .run(runId, merged.tableId, JSON.stringify(merged), new Date().toISOString());
  }

  listAnnotations(runId: string): TableAnnotation[] {
    return (this.db.prepare("SELECT annotation_json FROM table_annotations WHERE ingestion_run_id=?").all(runId) as Array<{ annotation_json: string }>)
      .map((row) => JSON.parse(row.annotation_json) as TableAnnotation);
  }

  saveDerivedTable(runId: string, definition: DerivedTableDefinition): void {
    this.db.prepare("INSERT INTO derived_tables VALUES (?, ?, ?, ?) ON CONFLICT(ingestion_run_id, derived_table_id) DO UPDATE SET definition_json=excluded.definition_json")
      .run(runId, definition.derivedTableId, JSON.stringify(definition), new Date().toISOString());
  }

  listDerivedTables(runId: string): DerivedTableDefinition[] {
    return (this.db.prepare("SELECT definition_json FROM derived_tables WHERE ingestion_run_id=?").all(runId) as Array<{ definition_json: string }>)
      .map((row) => JSON.parse(row.definition_json) as DerivedTableDefinition);
  }

  close(): void { this.db.close(); }
}

function conflictKey(value: Pick<ColumnConflictWaiver, "sourceTableId" | "rowOrder" | "columnIndex">): string {
  return `${value.sourceTableId}|${value.rowOrder}|${value.columnIndex}`;
}
