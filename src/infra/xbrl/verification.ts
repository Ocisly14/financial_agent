import type { Period, StatementKind } from "../../financial-model/types.ts";
import type { CalculationRelation } from "./types.ts";
import { TABLE_TOPICS, type ColumnConflictWaiver, type FilingTable, type TableAnnotation, type TableCuration, type TableTopic } from "./tableTypes.ts";

export type CalculationBreak = {
  sourceTableId: string;
  roleUri: string;
  parentConcept: string;
  periodId: string;
  reported: number;
  computed: number;
  difference: number;
  missingChildren: string[];
};

/**
 * XBRL figures are already-rounded reported values, so a roll-up may differ
 * from its parent by the issuer's own rounding. Tolerate the larger of an
 * absolute floor and a relative share of the reported magnitude.
 */
const ABSOLUTE_TOLERANCE = 1;
const RELATIVE_TOLERANCE = 1e-6;

type ConsolidatedValue = { value: number };

/**
 * Check every calculation roll-up whose parent and at least one child are
 * present in a curated table. Dimensional facts are excluded: a segment or
 * geography breakdown is not part of the consolidated roll-up.
 */
export function verifyCalculationRollups(
  tables: readonly FilingTable[],
  relations: readonly CalculationRelation[],
): CalculationBreak[] {
  const breaks: CalculationBreak[] = [];
  for (const table of tables) {
    const consolidated = consolidatedFacts(table);
    for (const relation of relations) {
      const parents = consolidated.get(relation.parentConcept);
      if (!parents) continue;
      for (const [periodId, parent] of parents) {
        const present = relation.children.filter((child) => consolidated.get(child.concept)?.has(periodId));
        if (present.length === 0) continue;
        const computed = present.reduce((sum, child) =>
          sum + child.weight * consolidated.get(child.concept)!.get(periodId)!.value, 0);
        const difference = parent.value - computed;
        if (Math.abs(difference) <= tolerance(parent.value)) continue;
        breaks.push({
          sourceTableId: table.sourceTableId,
          roleUri: relation.roleUri,
          parentConcept: relation.parentConcept,
          periodId,
          reported: parent.value,
          computed,
          difference,
          missingChildren: relation.children
            .filter((child) => !consolidated.get(child.concept)?.has(periodId))
            .map((child) => child.concept),
        });
      }
    }
  }
  return breaks;
}

const STATEMENTS: readonly StatementKind[] = ["income_statement", "balance_sheet", "cash_flow_statement"];

export type StatementCompleteness = { reportDate: string } & Record<StatementKind, boolean>;

export type ColumnConflict = {
  sourceTableId: string;
  rowOrder: number;
  columnIndex: number;
  columnPeriodId: string;
  factPeriodId: string;
};

export type DriverCoverage = { topic: TableTopic; tableIds: string[]; periodIds: string[] };

export type VerificationReport = {
  green: boolean;
  completeness: StatementCompleteness[];
  calculationBreaks: CalculationBreak[];
  /** Accessions of curated filings whose XBRL ships no calculation linkbase. */
  calculationNotAvailable: string[];
  periodGaps: string[];
  columnConflicts: ColumnConflict[];
  waivedColumnConflicts: Array<ColumnConflict & { rationale: string }>;
  /** Advisory only. Driver coverage never gates termination. */
  driverCoverage: DriverCoverage[];
};

export type VerifyCurationInput = {
  requestedPeriods: readonly Period[];
  reportDates: readonly string[];
  tables: readonly FilingTable[];
  curations: readonly TableCuration[];
  calculationRelations: Readonly<Record<string, readonly CalculationRelation[]>>;
  annotations: readonly TableAnnotation[];
  columnConflictWaivers?: readonly ColumnConflictWaiver[];
};

/**
 * Deterministic gate for the curation loop. Only completeness, calculation
 * balance, period coverage, and column consistency decide `green`; driver
 * coverage is reported for the subagent's benefit but never blocks.
 */
export function verifyCuration(input: VerifyCurationInput): VerificationReport {
  const byId = new Map(input.tables.map((table) => [table.sourceTableId, table]));
  const faceTables = input.curations
    .filter((curation) => curation.kind === "face")
    .flatMap((curation) => { const table = byId.get(curation.sourceTableId); return table ? [table] : []; });
  const uniqueFaceTables = [...new Map(faceTables.map((table) => [table.sourceTableId, table])).values()];

  const completeness = input.reportDates.map((reportDate) => ({
    reportDate,
    ...Object.fromEntries(STATEMENTS.map((statement) => [statement, input.curations.some((curation) =>
      curation.kind === "face" && curation.statement === statement && curation.reportDate === reportDate)])),
  })) as StatementCompleteness[];

  const relations = uniqueFaceTables.flatMap((table) => input.calculationRelations[table.accession] ?? []);
  const calculationBreaks = verifyCalculationRollups(uniqueFaceTables, relations);
  const calculationNotAvailable = [...new Set(uniqueFaceTables
    .filter((table) => (input.calculationRelations[table.accession] ?? []).length === 0)
    .map((table) => table.accession))].sort();

  const covered = new Set(uniqueFaceTables.flatMap((table) => factPeriodIds(table)));
  const periodGaps = input.requestedPeriods
    .filter((period) => period.cls === "actual" && !covered.has(period.id))
    .map((period) => period.id);

  const detectedColumnConflicts: ColumnConflict[] = [];
  for (const table of uniqueFaceTables) {
    const columnPeriods = new Map(table.columns.flatMap((column) =>
      column.periodId === undefined ? [] : [[column.index, column.periodId] as const]));
    for (const row of table.rows) {
      for (const cell of row.cells) {
        const columnPeriodId = columnPeriods.get(cell.columnIndex);
        if (!cell.fact || columnPeriodId === undefined || cell.fact.periodId === columnPeriodId) continue;
        detectedColumnConflicts.push({ sourceTableId: table.sourceTableId, rowOrder: row.order,
          columnIndex: cell.columnIndex, columnPeriodId, factPeriodId: cell.fact.periodId });
      }
    }
  }

  const waiverByCoordinate = new Map((input.columnConflictWaivers ?? []).map((waiver) => [columnConflictKey(waiver), waiver]));
  const waivedColumnConflicts = detectedColumnConflicts.flatMap((conflict) => {
    const waiver = waiverByCoordinate.get(columnConflictKey(conflict));
    return waiver ? [{ ...conflict, rationale: waiver.rationale }] : [];
  });
  const columnConflicts = detectedColumnConflicts.filter((conflict) => !waiverByCoordinate.has(columnConflictKey(conflict)));

  const topics = new Set<TableTopic>([...TABLE_TOPICS, ...input.annotations.flatMap((entry) => entry.topics)]);
  const driverCoverage = [...topics].map((topic) => {
    const tableIds = input.annotations.filter((entry) => entry.topics.includes(topic)).map((entry) => entry.tableId).sort();
    const periodIds = [...new Set(tableIds.flatMap((tableId) => {
      const table = byId.get(tableId);
      return table ? factPeriodIds(table) : [];
    }))].sort();
    return { topic, tableIds, periodIds };
  });

  const green = completeness.every((entry) => STATEMENTS.every((statement) => entry[statement]))
    && calculationBreaks.length === 0 && periodGaps.length === 0 && columnConflicts.length === 0;

  return { green, completeness, calculationBreaks, calculationNotAvailable, periodGaps,
    columnConflicts, waivedColumnConflicts, driverCoverage };
}

function columnConflictKey(value: Pick<ColumnConflict, "sourceTableId" | "rowOrder" | "columnIndex">): string {
  return `${value.sourceTableId}|${value.rowOrder}|${value.columnIndex}`;
}

function factPeriodIds(table: FilingTable): string[] {
  return table.rows.flatMap((row) => row.cells.flatMap((cell) => cell.fact ? [cell.fact.periodId] : []));
}

function tolerance(reported: number): number {
  return Math.max(ABSOLUTE_TOLERANCE, Math.abs(reported) * RELATIVE_TOLERANCE);
}

/** concept -> periodId -> value, for dimensionless facts only. */
function consolidatedFacts(table: FilingTable): Map<string, Map<string, ConsolidatedValue>> {
  const byConcept = new Map<string, Map<string, ConsolidatedValue>>();
  for (const row of table.rows) {
    for (const cell of row.cells) {
      const fact = cell.fact;
      if (!fact || fact.dimensions.length > 0) continue;
      const byPeriod = byConcept.get(fact.conceptQName) ?? new Map<string, ConsolidatedValue>();
      if (!byPeriod.has(fact.periodId)) byPeriod.set(fact.periodId, { value: fact.value });
      byConcept.set(fact.conceptQName, byPeriod);
    }
  }
  return byConcept;
}
