import assert from "node:assert/strict";
import test from "node:test";
import type { Period, StatementKind } from "../../../financial-model/types.ts";
import { verifyCuration } from "../verification.ts";
import type { FilingTable, TableAnnotation, TableCuration } from "../tableTypes.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
];

function table(options: {
  id: string;
  accession?: string;
  reportDate?: string;
  periodIds?: string[];
  columnPeriodId?: string;
  cellPeriodId?: string;
}): FilingTable {
  const periodIds = options.periodIds ?? ["FY2025"];
  return {
    sourceTableId: options.id, accession: options.accession ?? "acc-2025", form: "10-K",
    filedAt: "2026-01-29", reportDate: options.reportDate ?? "2025-12-31", heading: "H", htmlOrder: 1,
    sourceAnchor: "https://example.test/a.htm#t",
    prescreen: { tier: "strong", presentationOverlap: 1, dimensionlessRatio: 1, periodSpan: periodIds.length, factCount: periodIds.length },
    suggestedStatements: [],
    columns: [
      { index: 0, headerText: "", isLabelColumn: true },
      ...periodIds.map((periodId, index) => ({
        index: index + 1, headerText: periodId,
        periodId: options.columnPeriodId ?? periodId, isLabelColumn: false,
      })),
    ],
    rows: [{
      order: 1, labelText: "Revenue", indentLevel: 0,
      cells: [
        { columnIndex: 0, text: "Revenue" },
        ...periodIds.map((periodId, index) => ({
          columnIndex: index + 1, text: "1",
          fact: {
            occurrenceId: `occ-${options.id}-${index}`, conceptQName: "us-gaap:Revenues", conceptLabel: "Revenues",
            contextId: "c", periodId: options.cellPeriodId ?? periodId, value: 1,
            unit: { kind: "currency" as const, code: "USD" }, dimensions: [],
            sourceAnchor: "https://example.test/a.htm#f", htmlOrder: index + 1,
          },
        })),
      ],
    }],
  };
}

function faceCurations(sourceTableId: string, reportDate: string): TableCuration[] {
  const statements: StatementKind[] = ["income_statement", "balance_sheet", "cash_flow_statement"];
  return statements.map((statement) => ({ sourceTableId, statement, reportDate, kind: "face" as const, rationale: "r" }));
}

test("a report date with all three face statements is complete", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"], tables: [table({ id: "t1" })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
  });

  assert.deepEqual(report.completeness, [{
    reportDate: "2025-12-31", income_statement: true, balance_sheet: true, cash_flow_statement: true,
  }]);
});

test("a report date missing the cash flow statement is reported incomplete", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"], tables: [table({ id: "t1" })],
    curations: faceCurations("t1", "2025-12-31").filter((entry) => entry.statement !== "cash_flow_statement"),
    calculationRelations: {}, annotations: [],
  });

  assert.equal(report.completeness[0]!.cash_flow_statement, false);
  assert.equal(report.completeness[0]!.income_statement, true);
});

test("a parenthetical label does not satisfy a face statement", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"], tables: [table({ id: "t1" })],
    curations: [{ sourceTableId: "t1", statement: "balance_sheet", reportDate: "2025-12-31", kind: "parenthetical", rationale: "r" }],
    calculationRelations: {}, annotations: [],
  });

  assert.equal(report.completeness[0]!.balance_sheet, false);
});

test("an actual period with no fact in any curated face table is a period gap", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"], tables: [table({ id: "t1", periodIds: ["FY2025"] })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
  });

  assert.deepEqual(report.periodGaps, ["FY2024"]);
});

test("forecast periods are never period gaps", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"],
    tables: [table({ id: "t1", periodIds: ["FY2024", "FY2025"] })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
  });

  assert.deepEqual(report.periodGaps, []);
});

test("a cell whose fact period contradicts its column period is a column conflict", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"],
    tables: [table({ id: "t1", periodIds: ["FY2025"], columnPeriodId: "FY2025", cellPeriodId: "FY2024" })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
  });

  assert.equal(report.columnConflicts.length, 1);
  assert.deepEqual(report.columnConflicts[0], {
    sourceTableId: "t1", rowOrder: 1, columnIndex: 1, columnPeriodId: "FY2025", factPeriodId: "FY2024",
  });
});

test("an exact Agent waiver removes only that conflict from the gate and preserves its rationale", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"],
    tables: [table({ id: "t1", periodIds: ["FY2025"], columnPeriodId: "FY2025", cellPeriodId: "FY2024" })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
    columnConflictWaivers: [{ sourceTableId: "t1", rowOrder: 1, columnIndex: 1, rationale: "Reviewed filing presentation." }],
  });

  assert.deepEqual(report.columnConflicts, []);
  assert.deepEqual(report.waivedColumnConflicts, [{ sourceTableId: "t1", rowOrder: 1, columnIndex: 1,
    columnPeriodId: "FY2025", factPeriodId: "FY2024", rationale: "Reviewed filing presentation." }]);
});

test("an uncurated table is not checked for column conflicts", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"],
    tables: [table({ id: "t1" }), table({ id: "t2", columnPeriodId: "FY2025", cellPeriodId: "FY2024" })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
  });

  assert.deepEqual(report.columnConflicts, []);
});

test("a filing that ships no calculation relations is reported as not available", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"], tables: [table({ id: "t1", accession: "acc-2025" })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
  });

  assert.deepEqual(report.calculationNotAvailable, ["acc-2025"]);
  assert.deepEqual(report.calculationBreaks, []);
});

test("driver coverage reports the periods an annotated table spans", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"],
    tables: [table({ id: "t1" }), table({ id: "t2", periodIds: ["FY2024", "FY2025"] })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {},
    annotations: [{ tableId: "t2", topics: ["segment_revenue"] }] satisfies TableAnnotation[],
  });

  const segment = report.driverCoverage.find((entry) => entry.topic === "segment_revenue");
  assert.deepEqual(segment, { topic: "segment_revenue", tableIds: ["t2"], periodIds: ["FY2024", "FY2025"] });
});

test("a driver with no annotated table is reported with an empty coverage rather than omitted", () => {
  const report = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"], tables: [table({ id: "t1" })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
  });

  const capex = report.driverCoverage.find((entry) => entry.topic === "capex");
  assert.deepEqual(capex, { topic: "capex", tableIds: [], periodIds: [] });
});

test("verification is green only when complete, gap-free, conflict-free, and balanced", () => {
  const green = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"],
    tables: [table({ id: "t1", periodIds: ["FY2024", "FY2025"] })],
    curations: faceCurations("t1", "2025-12-31"), calculationRelations: {}, annotations: [],
  });
  assert.equal(green.green, true);

  const incomplete = verifyCuration({
    requestedPeriods: PERIODS, reportDates: ["2025-12-31"],
    tables: [table({ id: "t1", periodIds: ["FY2024", "FY2025"] })],
    curations: faceCurations("t1", "2025-12-31").slice(0, 2), calculationRelations: {}, annotations: [],
  });
  assert.equal(incomplete.green, false);
});
