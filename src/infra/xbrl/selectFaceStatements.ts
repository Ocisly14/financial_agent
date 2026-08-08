import type { Period, StatementKind } from "../../financial-model/types.ts";
import type { CalculationRelation } from "./types.ts";
import type { FilingTableStore } from "./filingTableStore.ts";
import type { FilingTable, TableCuration } from "./tableTypes.ts";
import { verifyCuration, type VerificationReport } from "./verification.ts";

const STATEMENTS: readonly StatementKind[] = ["income_statement", "balance_sheet", "cash_flow_statement"];

export type FaceStatementSelection = {
  outcome: "success" | "partial";
  curatedTables: FilingTable[];
  curations: TableCuration[];
  verification: VerificationReport;
  diagnostics: string[];
};

/**
 * Select standard face statements without an LLM. Arelle's presentation hint is
 * primary evidence; filing headings and structural quality break ties. The
 * selected source tables stay reviewable in the workbook's source sections.
 */
export function selectFaceStatements(input: {
  runId: string;
  store: FilingTableStore;
  tables: readonly FilingTable[];
  requestedPeriods: readonly Period[];
  reportDates: readonly string[];
  calculationRelations: Readonly<Record<string, readonly CalculationRelation[]>>;
}): FaceStatementSelection {
  const curations: TableCuration[] = [];
  for (const reportDate of input.reportDates) {
    const filingTables = input.tables.filter((table) => table.reportDate === reportDate && table.prescreen.factCount > 0);
    const assignment = bestAssignment(filingTables);
    for (const statement of STATEMENTS) {
      const table = assignment.get(statement);
      if (!table) continue;
      const curation: TableCuration = { sourceTableId: table.sourceTableId, statement, reportDate, kind: "face",
        rationale: "Deterministic face-statement selection from Arelle presentation evidence, heading, period coverage, and fact density." };
      input.store.saveCuration(input.runId, curation);
      curations.push(curation);
    }
  }

  const selected = new Set(curations.map((entry) => entry.sourceTableId));
  const curatedTables = input.tables.filter((table) => selected.has(table.sourceTableId));
  const verification = verifyCuration({ requestedPeriods: input.requestedPeriods, reportDates: input.reportDates,
    tables: input.tables, curations, calculationRelations: input.calculationRelations, annotations: [] });
  const structurallyComplete = verification.completeness.every((entry) =>
    STATEMENTS.every((statement) => entry[statement])) && verification.periodGaps.length === 0;
  const diagnostics = [
    ...verification.completeness.flatMap((entry) => STATEMENTS.filter((statement) => !entry[statement])
      .map((statement) => `statement_selection:missing_face_statement:${statement}:${entry.reportDate}`)),
    ...verification.periodGaps.map((periodId) => `statement_selection:period_gap:${periodId}`),
    ...verification.calculationBreaks.map((entry) =>
      `statement_selection:calculation_review_required:${entry.sourceTableId}:${entry.parentConcept}:${entry.difference}`),
    ...verification.columnConflicts.map((entry) =>
      `statement_selection:column_conflict_review_required:${entry.sourceTableId}:row ${entry.rowOrder}:column ${entry.columnIndex}`),
  ];
  return { outcome: structurallyComplete ? "success" : "partial", curatedTables, curations, verification, diagnostics };
}

function bestAssignment(tables: readonly FilingTable[]): Map<StatementKind, FilingTable> {
  const candidates = new Map(STATEMENTS.map((statement) => [statement,
    tables.map((table) => ({ table, score: score(table, statement) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.table.htmlOrder - right.table.htmlOrder)
      .slice(0, 8)]));
  let best = new Map<StatementKind, FilingTable>();
  let bestScore = Number.NEGATIVE_INFINITY;
  const visit = (index: number, used: Set<string>, selected: Map<StatementKind, FilingTable>, total: number): void => {
    if (index === STATEMENTS.length) {
      if (total > bestScore) { bestScore = total; best = new Map(selected); }
      return;
    }
    const statement = STATEMENTS[index]!;
    visit(index + 1, used, selected, total - 10_000);
    for (const candidate of candidates.get(statement) ?? []) {
      if (used.has(candidate.table.sourceTableId)) continue;
      used.add(candidate.table.sourceTableId); selected.set(statement, candidate.table);
      visit(index + 1, used, selected, total + candidate.score);
      selected.delete(statement); used.delete(candidate.table.sourceTableId);
    }
  };
  visit(0, new Set(), new Map(), 0);
  return best;
}

function score(table: FilingTable, statement: StatementKind): number {
  const hintIndex = table.suggestedStatements.indexOf(statement);
  const heading = normalize(table.heading);
  const headingScore = headingMatches(heading, statement) ? 700 : 0;
  if (hintIndex < 0 && headingScore === 0) return Number.NEGATIVE_INFINITY;
  const parentheticalPenalty = /parenthetical|supplemental|details? of|schedule of/.test(heading) ? 1_500 : 0;
  const otherStatementPenalty = STATEMENTS.some((other) => other !== statement && headingMatches(heading, other)) ? 500 : 0;
  return (hintIndex < 0 ? 0 : 1_000 - hintIndex * 50) + headingScore
    + (table.prescreen.tier === "strong" ? 120 : 0)
    + table.prescreen.presentationOverlap * 100
    + table.prescreen.dimensionlessRatio * 60
    + table.prescreen.periodSpan * 25
    + Math.min(table.prescreen.factCount, 150)
    - parentheticalPenalty - otherStatementPenalty;
}

function headingMatches(heading: string, statement: StatementKind): boolean {
  if (statement === "balance_sheet") return /balance sheets?|financial position/.test(heading);
  if (statement === "cash_flow_statement") return /cash flows?/.test(heading);
  return /statements? of (operations|income|earnings)|income statements?/.test(heading)
    && !/comprehensive income/.test(heading);
}

function normalize(value: string): string { return value.toLowerCase().replace(/\s+/g, " ").trim(); }
