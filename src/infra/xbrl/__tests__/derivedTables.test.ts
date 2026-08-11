import assert from "node:assert/strict";
import test from "node:test";
import { DerivedTableError, materializeDerivedTable } from "../derivedTables.ts";
import type { DerivedTableDefinition, FilingTable, TableTopic } from "../tableTypes.ts";

/** One row, one period column, one tagged cell — the smallest referencable table. */
function filingTable(options: {
  id: string;
  periodId: string;
  value: number;
  unit?: { kind: "currency"; code: string } | { kind: "shares" };
  tagged?: boolean;
}): FilingTable {
  const unit = options.unit ?? { kind: "currency" as const, code: "USD" };
  return {
    sourceTableId: options.id, accession: "acc", form: "10-K", filedAt: "2026-01-29",
    reportDate: "2025-12-31", heading: "Note 13 — Segment Information", htmlOrder: 1,
    sourceAnchor: `https://example.test/a.htm#${options.id}`,
    prescreen: { tier: "weak", presentationOverlap: 0.2, dimensionlessRatio: 0.1, periodSpan: 1, factCount: 1 },
    suggestedStatements: [],
    columns: [
      { index: 0, headerText: "", isLabelColumn: true },
      { index: 1, headerText: options.periodId, periodId: options.periodId, isLabelColumn: false },
    ],
    rows: [{
      order: 1, labelText: "Automotive sales", indentLevel: 0,
      cells: [
        { columnIndex: 0, text: "Automotive sales" },
        {
          columnIndex: 1, text: String(options.value),
          ...(options.tagged === false ? {} : {
            fact: {
              occurrenceId: `occ-${options.id}`, conceptQName: "tsla:AutomotiveSales", conceptLabel: "Automotive sales",
              contextId: "c", periodId: options.periodId, value: options.value, unit,
              dimensions: [], sourceAnchor: `https://example.test/a.htm#f-${options.id}`, htmlOrder: 1,
            },
          }),
        },
      ],
    }],
  };
}

/** `assert.throws` returns undefined, so capture the error to assert on its fields. */
function derivedError(run: () => unknown): DerivedTableError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof DerivedTableError, `expected DerivedTableError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected materializeDerivedTable to throw");
}

function definition(overrides: Partial<DerivedTableDefinition> = {}): DerivedTableDefinition {
  return {
    derivedTableId: "derived:automotive-revenue",
    title: "Automotive revenue by fiscal year",
    summary: "Automotive sales stitched across annual filings.",
    topics: ["segment_revenue"] as TableTopic[],
    columns: [{ periodId: "FY2024" }, { periodId: "FY2025" }],
    rows: [{
      label: "Automotive sales",
      cells: [
        { sourceTableId: "t-2024", rowOrder: 1, columnIndex: 1 },
        { sourceTableId: "t-2025", rowOrder: 1, columnIndex: 1 },
      ],
    }],
    rationale: "Each 10-K discloses only two fiscal years.",
    ...overrides,
  };
}

const TABLES = [
  filingTable({ id: "t-2024", periodId: "FY2024", value: 82_419 }),
  filingTable({ id: "t-2025", periodId: "FY2025", value: 77_070 }),
];

test("a stitch across filings resolves to the referenced values", () => {
  const materialized = materializeDerivedTable(definition(), TABLES);

  assert.equal(materialized.rows.length, 1);
  assert.deepEqual(materialized.rows[0]!.cells.map((cell) => cell?.value), [82_419, 77_070]);
});

test("each resolved cell carries its own source anchor so provenance survives", () => {
  const materialized = materializeDerivedTable(definition(), TABLES);

  assert.deepEqual(materialized.rows[0]!.cells.map((cell) => cell?.sourceAnchor),
    ["https://example.test/a.htm#f-t-2024", "https://example.test/a.htm#f-t-2025"]);
});

test("a null cell is a deliberate blank, not a resolution failure", () => {
  const materialized = materializeDerivedTable(
    definition({ rows: [{ label: "Automotive sales", cells: [null, { sourceTableId: "t-2025", rowOrder: 1, columnIndex: 1 }] }] }),
    TABLES,
  );

  assert.equal(materialized.rows[0]!.cells[0], null);
  assert.equal(materialized.rows[0]!.cells[1]!.value, 77_070);
});

test("a reference to an unknown table names the offending coordinate", () => {
  const error = derivedError(() => materializeDerivedTable(
    definition({ rows: [{ label: "x", cells: [{ sourceTableId: "t-missing", rowOrder: 1, columnIndex: 1 }, null] }] }),
    TABLES,
  ));

  assert.equal(error.code, "unresolved_reference");
  assert.deepEqual(error.coordinate, { sourceTableId: "t-missing", rowOrder: 1, columnIndex: 1 });
});

test("a reference to a row that does not exist is unresolved", () => {
  const error = derivedError(() => materializeDerivedTable(
    definition({ rows: [{ label: "x", cells: [{ sourceTableId: "t-2024", rowOrder: 99, columnIndex: 1 }, null] }] }),
    TABLES,
  ));

  assert.equal(error.code, "unresolved_reference");
});

test("a reference to an untagged cell is rejected, because a derived cell must carry a fact", () => {
  const error = derivedError(() => materializeDerivedTable(
    definition({ rows: [{ label: "x", cells: [{ sourceTableId: "t-untagged", rowOrder: 1, columnIndex: 1 }, null] }] }),
    [...TABLES, filingTable({ id: "t-untagged", periodId: "FY2024", value: 1, tagged: false })],
  ));

  assert.equal(error.code, "untagged_cell");
});

test("a cell whose fact period contradicts its declared column names both periods", () => {
  const error = derivedError(() => materializeDerivedTable(
    definition({ columns: [{ periodId: "FY2023" }, { periodId: "FY2025" }] }),
    TABLES,
  ));

  assert.equal(error.code, "period_mismatch");
  assert.match(error.message, /FY2023/);
  assert.match(error.message, /FY2024/);
});

test("mixed units within a row are rejected, since stitching is where a scale change hides", () => {
  const error = derivedError(() => materializeDerivedTable(
    definition(),
    [TABLES[0]!, filingTable({ id: "t-2025", periodId: "FY2025", value: 1, unit: { kind: "shares" } })],
  ));

  assert.equal(error.code, "mixed_units");
});

test("a row with more cells than declared columns is rejected", () => {
  const error = derivedError(() => materializeDerivedTable(
    definition({ columns: [{ periodId: "FY2024" }] }),
    TABLES,
  ));

  assert.equal(error.code, "column_count_mismatch");
});

test("a duplicate column period is rejected", () => {
  const error = derivedError(() => materializeDerivedTable(
    definition({ columns: [{ periodId: "FY2024" }, { periodId: "FY2024" }] }),
    TABLES,
  ));

  assert.equal(error.code, "duplicate_column_period");
});

test("an unknown topic is rejected unless it is prefixed other:", () => {
  const bad = derivedError(() => materializeDerivedTable(
    definition({ topics: ["vehicle_deliveries" as TableTopic] }), TABLES,
  ));
  assert.equal(bad.code, "unknown_topic");

  const escaped = materializeDerivedTable(definition({ topics: ["other:vehicle_deliveries"] }), TABLES);
  assert.deepEqual(escaped.definition.topics, ["other:vehicle_deliveries"]);
});
