import type { Unit } from "../../financial-model/types.ts";
import {
  TABLE_TOPICS,
  type DerivedCellReference,
  type DerivedTableDefinition,
  type FilingTable,
  type MaterializedDerivedTable,
  type TableTopic,
} from "./tableTypes.ts";

export type DerivedTableErrorCode =
  | "unresolved_reference"
  | "untagged_cell"
  | "period_mismatch"
  | "mixed_units"
  | "column_count_mismatch"
  | "duplicate_column_period"
  | "unknown_topic";

export class DerivedTableError extends Error {
  readonly code: DerivedTableErrorCode;
  readonly coordinate?: DerivedCellReference;

  constructor(code: DerivedTableErrorCode, message: string, coordinate?: DerivedCellReference) {
    super(message);
    this.name = "DerivedTableError";
    this.code = code;
    if (coordinate) this.coordinate = coordinate;
  }
}

/**
 * Resolve a derived table's coordinate references against the extracted tables
 * and return it with values filled in. A derived table never stores values, so
 * this is the only place a number enters it — and the number always comes from
 * a filing fact, never from the subagent.
 */
export function materializeDerivedTable(
  definition: DerivedTableDefinition,
  tables: readonly FilingTable[],
): MaterializedDerivedTable {
  assertTopics(definition.topics);
  assertColumns(definition);
  const byId = new Map(tables.map((table) => [table.sourceTableId, table]));

  const rows = definition.rows.map((row) => {
    if (row.cells.length !== definition.columns.length) {
      throw new DerivedTableError("column_count_mismatch",
        `row "${row.label}" has ${row.cells.length} cells but the table declares ${definition.columns.length} columns`);
    }
    let rowUnit: Unit | undefined;
    const cells = row.cells.map((reference, index) => {
      if (reference === null) return null;
      const resolved = resolve(reference, byId);
      const declared = definition.columns[index]!.periodId;
      if (resolved.fact.periodId !== declared) {
        throw new DerivedTableError("period_mismatch",
          `column ${index} declares ${declared} but ${cellPath(reference)} carries ${resolved.fact.periodId}`, reference);
      }
      if (rowUnit === undefined) rowUnit = resolved.fact.unit;
      else if (JSON.stringify(rowUnit) !== JSON.stringify(resolved.fact.unit)) {
        throw new DerivedTableError("mixed_units",
          `row "${row.label}" mixes ${JSON.stringify(rowUnit)} and ${JSON.stringify(resolved.fact.unit)} at ${cellPath(reference)}`,
          reference);
      }
      return { reference, value: resolved.fact.value, unit: resolved.fact.unit, sourceAnchor: resolved.fact.sourceAnchor };
    });
    return { label: row.label, cells };
  });

  return { definition, rows };
}

function assertTopics(topics: readonly TableTopic[]): void {
  const controlled = new Set<string>(TABLE_TOPICS);
  for (const topic of topics) {
    if (controlled.has(topic) || topic.startsWith("other:")) continue;
    throw new DerivedTableError("unknown_topic",
      `unknown topic "${topic}"; use one of ${[...controlled].join(", ")} or prefix it with "other:"`);
  }
}

function assertColumns(definition: DerivedTableDefinition): void {
  const seen = new Set<string>();
  for (const column of definition.columns) {
    if (seen.has(column.periodId)) {
      throw new DerivedTableError("duplicate_column_period", `column period ${column.periodId} appears more than once`);
    }
    seen.add(column.periodId);
  }
}

function resolve(reference: DerivedCellReference, byId: Map<string, FilingTable>) {
  const table = byId.get(reference.sourceTableId);
  const row = table?.rows.find((candidate) => candidate.order === reference.rowOrder);
  const cell = row?.cells.find((candidate) => candidate.columnIndex === reference.columnIndex);
  if (!cell) throw new DerivedTableError("unresolved_reference", `${cellPath(reference)} does not exist`, reference);
  if (!cell.fact) {
    throw new DerivedTableError("untagged_cell",
      `${cellPath(reference)} has no XBRL fact; a derived cell must reference a tagged value`, reference);
  }
  return { fact: cell.fact };
}

function cellPath(reference: DerivedCellReference): string {
  return `${reference.sourceTableId} row ${reference.rowOrder} column ${reference.columnIndex}`;
}
