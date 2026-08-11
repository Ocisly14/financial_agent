import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryFilingTableStore, SqliteFilingTableStore, type FilingTableStore } from "../filingTableStore.ts";
import type { DerivedTableDefinition, FilingTable } from "../tableTypes.ts";

const RUN = "ing_1";

function filingTable(id: string, options: { heading?: string; labels?: string[]; tier?: "strong" | "weak" } = {}): FilingTable {
  const labels = options.labels ?? ["Total revenues", "Cost of revenues"];
  return {
    sourceTableId: id, accession: "acc", form: "10-K", filedAt: "2026-01-29", reportDate: "2025-12-31",
    heading: options.heading ?? "CONSOLIDATED STATEMENTS OF OPERATIONS", htmlOrder: 1,
    sourceAnchor: "https://example.test/a.htm#t",
    prescreen: { tier: options.tier ?? "strong", presentationOverlap: 0.9, dimensionlessRatio: 0.95, periodSpan: 1, factCount: labels.length },
    suggestedStatements: ["income_statement"],
    columns: [{ index: 0, headerText: "", isLabelColumn: true }, { index: 1, headerText: "2025", periodId: "FY2025", isLabelColumn: false }],
    rows: labels.map((label, index) => ({
      order: index + 1, labelText: label, indentLevel: 0,
      cells: [{ columnIndex: 0, text: label }, {
        columnIndex: 1, text: "1",
        fact: { occurrenceId: `occ-${id}-${index}`, conceptQName: "us-gaap:Revenues", conceptLabel: label,
          contextId: "c", periodId: "FY2025", value: 1, unit: { kind: "currency", code: "USD" }, dimensions: [],
          sourceAnchor: "https://example.test/a.htm#f", htmlOrder: index + 1 },
      }],
    })),
  };
}

function suite(name: string, open: () => { store: FilingTableStore; close: () => void }): void {
  test(`${name}: saved tables come back as a catalog without cells`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1")]);
      const page = store.listTables(RUN, {});

      assert.equal(page.entries.length, 1);
      assert.equal(page.entries[0]!.sourceTableId, "t1");
      assert.equal(page.entries[0]!.rowCount, 2);
      assert.equal(page.entries[0]!.factCount, 2);
      assert.deepEqual(page.entries[0]!.rowLabels, ["Total revenues", "Cost of revenues"]);
      assert.equal("rows" in page.entries[0]!, false);
    } finally { close(); }
  });

  test(`${name}: the catalog truncates row labels past fifteen and says so`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1", { labels: Array.from({ length: 20 }, (_, i) => `Row ${i}`) })]);
      const entry = store.listTables(RUN, {}).entries[0]!;

      assert.equal(entry.rowLabels.length, 15);
      assert.equal(entry.rowLabelsTruncated, true);
    } finally { close(); }
  });

  test(`${name}: listing defaults to strong tier and filters on request`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1", { tier: "strong" }), filingTable("t2", { tier: "weak" })]);

      assert.deepEqual(store.listTables(RUN, {}).entries.map((e) => e.sourceTableId), ["t1"]);
      assert.deepEqual(store.listTables(RUN, { tier: "weak" }).entries.map((e) => e.sourceTableId), ["t2"]);
      assert.deepEqual(store.listTables(RUN, { tier: "all" }).entries.map((e) => e.sourceTableId), ["t1", "t2"]);
    } finally { close(); }
  });

  test(`${name}: listing pages with a cursor`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, Array.from({ length: 25 }, (_, i) => filingTable(`t${String(i).padStart(2, "0")}`)));
      const first = store.listTables(RUN, {});
      assert.equal(first.entries.length, 20);
      assert.ok(first.nextCursor);

      const second = store.listTables(RUN, { cursor: first.nextCursor! });
      assert.equal(second.entries.length, 5);
      assert.equal(second.nextCursor, undefined);
    } finally { close(); }
  });

  test(`${name}: full grids come back only when asked for by id`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1"), filingTable("t2")]);
      const grids = store.getTables(RUN, ["t2"]);

      assert.equal(grids.length, 1);
      assert.equal(grids[0]!.rows[0]!.cells[1]!.fact!.value, 1);
    } finally { close(); }
  });

  test(`${name}: another run's tables are invisible`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1")]);
      store.saveTables("ing_2", [filingTable("t9")]);

      assert.deepEqual(store.listTables(RUN, {}).entries.map((e) => e.sourceTableId), ["t1"]);
      assert.deepEqual(store.getTables(RUN, ["t9"]), []);
    } finally { close(); }
  });

  test(`${name}: row search matches labels case- and whitespace-insensitively`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1", { labels: ["Total   revenues", "Other"] })]);
      const hits = store.findRows(RUN, { query: "total revenues" });

      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sourceTableId, "t1");
      assert.deepEqual(hits[0]!.rows, [{ rowOrder: 1, labelText: "Total   revenues" }]);
    } finally { close(); }
  });

  test(`${name}: row search also matches headings`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1", { heading: "CONSOLIDATED BALANCE SHEETS", labels: ["Cash"] })]);

      assert.equal(store.findRows(RUN, { query: "balance sheets" }).length, 1);
    } finally { close(); }
  });

  test(`${name}: re-labelling a table overwrites rather than duplicates`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1")]);
      store.saveCuration(RUN, { sourceTableId: "t1", statement: "income_statement", reportDate: "2025-12-31", kind: "face", rationale: "first" });
      store.saveCuration(RUN, { sourceTableId: "t1", statement: "balance_sheet", reportDate: "2025-12-31", kind: "face", rationale: "corrected" });

      const curations = store.listCurations(RUN);
      assert.equal(curations.length, 1);
      assert.equal(curations[0]!.statement, "balance_sheet");
      assert.equal(curations[0]!.rationale, "corrected");
    } finally { close(); }
  });

  test(`${name}: a column-conflict waiver round-trips by exact coordinate`, () => {
    const { store, close } = open();
    try {
      store.saveColumnConflictWaiver(RUN, { sourceTableId: "t1", rowOrder: 4, columnIndex: 10, rationale: "reviewed" });
      store.saveColumnConflictWaiver(RUN, { sourceTableId: "t1", rowOrder: 4, columnIndex: 10, rationale: "updated" });
      assert.deepEqual(store.listColumnConflictWaivers(RUN), [
        { sourceTableId: "t1", rowOrder: 4, columnIndex: 10, rationale: "updated" },
      ]);
    } finally { close(); }
  });

  test(`${name}: annotations merge instead of clobbering unset fields`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1")]);
      store.saveAnnotation(RUN, { tableId: "t1", summary: "Segment revenue by region", topics: ["segment_revenue"] });
      store.saveAnnotation(RUN, { tableId: "t1", title: "Segment revenue" });

      const annotation = store.listAnnotations(RUN)[0]!;
      assert.equal(annotation.title, "Segment revenue");
      assert.equal(annotation.summary, "Segment revenue by region");
      assert.deepEqual(annotation.topics, ["segment_revenue"]);
    } finally { close(); }
  });

  test(`${name}: the catalog reflects curation and annotation state`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1")]);
      store.saveCuration(RUN, { sourceTableId: "t1", statement: "income_statement", reportDate: "2025-12-31", kind: "face", rationale: "r" });
      store.saveAnnotation(RUN, { tableId: "t1", topics: ["segment_revenue"] });

      const entry = store.listTables(RUN, {}).entries[0]!;
      assert.equal(entry.curation?.kind, "face");
      assert.deepEqual(entry.annotation?.topics, ["segment_revenue"]);
    } finally { close(); }
  });

  test(`${name}: uncurated_only hides already-labelled tables`, () => {
    const { store, close } = open();
    try {
      store.saveTables(RUN, [filingTable("t1"), filingTable("t2")]);
      store.saveCuration(RUN, { sourceTableId: "t1", statement: "income_statement", reportDate: "2025-12-31", kind: "face", rationale: "r" });

      assert.deepEqual(store.listTables(RUN, { uncuratedOnly: true }).entries.map((e) => e.sourceTableId), ["t2"]);
    } finally { close(); }
  });

  test(`${name}: a derived table round-trips as a definition of references`, () => {
    const { store, close } = open();
    try {
      const definition: DerivedTableDefinition = {
        derivedTableId: "derived:segment", title: "Segment revenue", summary: "s", topics: ["segment_revenue"],
        columns: [{ periodId: "FY2025" }], rows: [{ label: "Automotive", cells: [{ sourceTableId: "t1", rowOrder: 1, columnIndex: 1 }] }],
        rationale: "r",
      };
      store.saveTables(RUN, [filingTable("t1")]);
      store.saveDerivedTable(RUN, definition);

      assert.deepEqual(store.listDerivedTables(RUN), [definition]);
    } finally { close(); }
  });
}

suite("in-memory", () => {
  const store = new InMemoryFilingTableStore();
  return { store, close: () => {} };
});

suite("sqlite", () => {
  const directory = mkdtempSync(join(tmpdir(), "filing-table-store-"));
  const store = SqliteFilingTableStore.open(join(directory, "tables.sqlite"));
  return { store, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
});
