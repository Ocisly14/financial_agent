import assert from "node:assert/strict";
import test from "node:test";
import type { Period, StatementKind } from "../../../financial-model/types.ts";
import { IncompleteFinancialStatementsError, mergeCuratedTables } from "../mergeCuratedTables.ts";
import type { FilingTable, FilingTableGridRow, TableCuration } from "../tableTypes.ts";
import type { FilingIdentity, XbrlDimension } from "../types.ts";

const PERIODS: Period[] = [
  { id: "FY2023", label: "FY2023", start: "2023-01-01", end: "2023-12-31", cls: "actual" },
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
];

const STATEMENTS: StatementKind[] = ["income_statement", "balance_sheet", "cash_flow_statement"];

type RowSpec = {
  label: string;
  values: Record<string, number>;
  indentLevel?: number;
  concept?: string;
  dimensions?: XbrlDimension[];
  /** Overrides the column period assignment so a cell can contradict its column. */
  columnPeriods?: Record<string, string>;
};

function identity(accession: string, filedAt: string, form: FilingIdentity["form"] = "10-K"): FilingIdentity {
  return { accession, form, filedAt, reportDate: filedAt, primaryDocumentUrl: `https://sec.test/${accession}.htm` };
}

function table(options: {
  id: string;
  accession?: string;
  filedAt?: string;
  periodIds: string[];
  rows: RowSpec[];
  htmlOrder?: number;
}): FilingTable {
  const accession = options.accession ?? "new";
  const filedAt = options.filedAt ?? "2026-02-01";
  const rows: FilingTableGridRow[] = options.rows.map((spec, index) => ({
    order: index + 1,
    labelText: spec.label,
    indentLevel: spec.indentLevel ?? 0,
    cells: [
      { columnIndex: 0, text: spec.label },
      ...options.periodIds.flatMap((periodId, column) => {
        const value = spec.values[periodId];
        if (value === undefined) return [];
        return [{
          columnIndex: column + 1,
          text: String(value),
          fact: {
            occurrenceId: `${options.id}-${index}-${column}`,
            conceptQName: spec.concept ?? `us-gaap:${spec.label.replace(/[^a-zA-Z]/g, "")}`,
            conceptLabel: spec.label,
            contextId: `${periodId}-c`,
            periodId,
            value,
            unit: { kind: "currency" as const, code: "USD" },
            decimals: -6,
            dimensions: spec.dimensions ?? [],
            sourceAnchor: `${options.id}#${index}-${column}`,
            htmlOrder: column,
          },
        }];
      }),
    ],
  }));
  return {
    sourceTableId: options.id, accession, form: "10-K", filedAt, reportDate: filedAt,
    heading: "CONSOLIDATED STATEMENTS", htmlOrder: options.htmlOrder ?? 1, sourceAnchor: `${options.id}#t`,
    prescreen: { tier: "strong", presentationOverlap: 1, dimensionlessRatio: 1, periodSpan: options.periodIds.length, factCount: rows.length },
    suggestedStatements: [],
    columns: [
      { index: 0, headerText: "", isLabelColumn: true },
      ...options.periodIds.map((periodId, column) => ({
        index: column + 1,
        headerText: periodId,
        periodId: options.rows[0]?.columnPeriods?.[periodId] ?? periodId,
        isLabelColumn: false,
      })),
    ],
    rows,
  };
}

function curation(sourceTableId: string, statement: StatementKind, kind: TableCuration["kind"], relatedTableId?: string): TableCuration {
  return { sourceTableId, statement, reportDate: "2025-12-31", kind, rationale: "r",
    ...(relatedTableId === undefined ? {} : { relatedTableId }) };
}

/** The two statements the tests do not exercise, so the completeness gate never fires spuriously. */
function filler(accession: string, filedAt: string): { tables: FilingTable[]; curations: TableCuration[] } {
  const tables = [
    table({ id: `${accession}:bs`, accession, filedAt, periodIds: ["FY2025"], rows: [{ label: "Total assets", values: { FY2025: 500 } }] }),
    table({ id: `${accession}:cf`, accession, filedAt, periodIds: ["FY2025"], rows: [{ label: "Net cash provided", values: { FY2025: 80 } }] }),
  ];
  return { tables, curations: [curation(tables[0]!.sourceTableId, "balance_sheet", "face"), curation(tables[1]!.sourceTableId, "cash_flow_statement", "face")] };
}

function merge(parts: Array<{ tables: FilingTable[]; curations: TableCuration[] }>, filings: FilingIdentity[], negatedConcepts?: string[]) {
  return mergeCuratedTables({
    requestedPeriods: PERIODS,
    filings,
    tables: parts.flatMap((part) => part.tables),
    curations: parts.flatMap((part) => part.curations),
    ...(negatedConcepts === undefined ? {} : { negatedConcepts }),
  });
}

test("rows follow the curated table's own order, not concept or presentation order", () => {
  const face = table({ id: "t1", periodIds: ["FY2025"], rows: [
    { label: "Net sales", values: { FY2025: 100 } },
    { label: "Cost of sales", values: { FY2025: 60 } },
    { label: "Gross margin", values: { FY2025: 40 } },
  ] });
  const merged = merge([{ tables: [face], curations: [curation("t1", "income_statement", "face")] }, filler("new", "2026-02-01")],
    [identity("new", "2026-02-01")]);

  assert.deepEqual(merged.rows.filter((row) => row.statement === "income_statement").map((row) => row.label),
    ["Net sales", "Cost of sales", "Gross margin"]);
});

test("a continuation table appends its rows after its head table's rows", () => {
  const head = table({ id: "t1", periodIds: ["FY2025"], htmlOrder: 1, rows: [
    { label: "Net sales", values: { FY2025: 100 } },
  ] });
  const tail = table({ id: "t2", periodIds: ["FY2025"], htmlOrder: 2, rows: [
    { label: "Net income", values: { FY2025: 25 } },
  ] });
  const merged = merge([
    { tables: [head, tail], curations: [curation("t1", "income_statement", "face"), curation("t2", "income_statement", "continuation", "t1")] },
    filler("new", "2026-02-01"),
  ], [identity("new", "2026-02-01")]);

  assert.deepEqual(merged.rows.filter((row) => row.statement === "income_statement").map((row) => row.label), ["Net sales", "Net income"]);
});

test("parenthetical and superseded tables contribute no rows", () => {
  const face = table({ id: "t1", periodIds: ["FY2025"], rows: [{ label: "Net sales", values: { FY2025: 100 } }] });
  const parenthetical = table({ id: "t2", periodIds: ["FY2025"], rows: [{ label: "Par value per share", values: { FY2025: 1 } }] });
  const superseded = table({ id: "t3", periodIds: ["FY2025"], rows: [{ label: "Restated net sales", values: { FY2025: 90 } }] });
  const merged = merge([
    { tables: [face, parenthetical, superseded], curations: [
      curation("t1", "income_statement", "face"),
      curation("t2", "income_statement", "parenthetical"),
      curation("t3", "income_statement", "superseded", "t1"),
    ] },
    filler("new", "2026-02-01"),
  ], [identity("new", "2026-02-01")]);

  assert.deepEqual(merged.rows.filter((row) => row.statement === "income_statement").map((row) => row.label), ["Net sales"]);
  assert.equal(merged.facts.some((fact) => fact.value === 1 || fact.value === 90), false);
});

test("the most recently filed curated face table wins a contested period", () => {
  const old = table({ id: "old:is", accession: "old", filedAt: "2024-02-01", periodIds: ["FY2023", "FY2024"],
    rows: [{ label: "Net sales", values: { FY2023: 90, FY2024: 100 } }] });
  const latest = table({ id: "new:is", accession: "new", filedAt: "2026-03-01", periodIds: ["FY2024", "FY2025"],
    rows: [{ label: "Net sales", values: { FY2024: 111, FY2025: 120 } }] });
  const merged = merge([
    { tables: [old], curations: [curation("old:is", "income_statement", "face")] },
    { tables: [latest], curations: [curation("new:is", "income_statement", "face")] },
    filler("new", "2026-03-01"),
  ], [identity("old", "2024-02-01"), identity("new", "2026-03-01")]);

  const salesId = merged.rows.find((row) => row.label === "Net sales")!.sourceLineItemId;
  assert.deepEqual(merged.facts.filter((fact) => fact.lineItemId === salesId)
    .map((fact) => [fact.periodId, fact.value, fact.provenance.accession]), [
    ["FY2024", 111, "new"], ["FY2025", 120, "new"], ["FY2023", 90, "old"],
  ]);
});

test("an older filing still supplies a period no newer filing covers", () => {
  const old = table({ id: "old:is", accession: "old", filedAt: "2024-02-01", periodIds: ["FY2023"],
    rows: [{ label: "Net sales", values: { FY2023: 90 } }] });
  const latest = table({ id: "new:is", accession: "new", filedAt: "2026-03-01", periodIds: ["FY2025"],
    rows: [{ label: "Net sales", values: { FY2025: 120 } }] });
  const merged = merge([
    { tables: [old], curations: [curation("old:is", "income_statement", "face")] },
    { tables: [latest], curations: [curation("new:is", "income_statement", "face")] },
    filler("new", "2026-03-01"),
  ], [identity("old", "2024-02-01"), identity("new", "2026-03-01")]);

  const salesId = merged.rows.find((row) => row.label === "Net sales")!.sourceLineItemId;
  assert.deepEqual(merged.facts.filter((fact) => fact.lineItemId === salesId).map((fact) => fact.periodId), ["FY2025", "FY2023"]);
  assert.equal(merged.rows.filter((row) => row.label === "Net sales").length, 1);
});

test("a cosmetic label edit between filings does not fork the source line item id", () => {
  const old = table({ id: "old:is", accession: "old", filedAt: "2024-02-01", periodIds: ["FY2023"],
    rows: [{ label: "Total  Revenues,", values: { FY2023: 90 } }] });
  const latest = table({ id: "new:is", accession: "new", filedAt: "2026-03-01", periodIds: ["FY2025"],
    rows: [{ label: "Total revenues", values: { FY2025: 120 }, concept: "us-gaap:RevenueFromContractWithCustomer" }] });
  const merged = merge([
    { tables: [old], curations: [curation("old:is", "income_statement", "face")] },
    { tables: [latest], curations: [curation("new:is", "income_statement", "face")] },
    filler("new", "2026-03-01"),
  ], [identity("old", "2024-02-01"), identity("new", "2026-03-01")]);

  const revenue = merged.rows.filter((row) => row.statement === "income_statement");
  assert.equal(revenue.length, 1, "a re-tagged, re-punctuated row stays one row");
  assert.deepEqual(merged.facts.filter((fact) => fact.lineItemId === revenue[0]!.sourceLineItemId).map((fact) => fact.value), [120, 90]);
  assert.match(revenue[0]!.sourceLineItemId, /^source\.income_statement\.total_revenues\.[0-9a-f]{12}$/);
});

test("the same label under a different dimension signature is a different source line item", () => {
  const cloud: XbrlDimension[] = [{ axisQName: "srt:ProductAxis", axisLabel: "Product", memberQName: "ex:Cloud", memberLabel: "Cloud" }];
  const face = table({ id: "t1", periodIds: ["FY2025"], rows: [
    { label: "Net sales", values: { FY2025: 100 } },
    { label: "Net sales", values: { FY2025: 60 }, dimensions: cloud },
  ] });
  const merged = merge([{ tables: [face], curations: [curation("t1", "income_statement", "face")] }, filler("new", "2026-02-01")],
    [identity("new", "2026-02-01")]);

  const sales = merged.rows.filter((row) => row.label === "Net sales");
  assert.equal(new Set(sales.map((row) => row.sourceLineItemId)).size, 2);
  assert.equal(merged.dimensionalDisclosures.length, 1);
  assert.equal(merged.dimensionalDisclosures[0]!.periods[0]!.value, 60);
});

test("a cell whose fact period contradicts its column period is a coverage issue, and the fact's own context wins", () => {
  const face = table({ id: "t1", periodIds: ["FY2025"], rows: [
    { label: "Net sales", values: { FY2025: 100 }, columnPeriods: { FY2025: "FY2024" } },
  ] });
  const merged = merge([{ tables: [face], curations: [curation("t1", "income_statement", "face")] }, filler("new", "2026-02-01")],
    [identity("new", "2026-02-01")]);

  const issue = merged.coverage.issues.find((entry) => entry.code === "incompatible_context");
  assert.deepEqual(issue, { code: "incompatible_context", severity: "review_required", statement: "income_statement",
    periodIds: ["FY2024", "FY2025"], sourceRefs: ["t1"] });
  const salesId = merged.rows.find((row) => row.label === "Net sales")!.sourceLineItemId;
  assert.deepEqual(merged.facts.filter((fact) => fact.lineItemId === salesId).map((fact) => fact.periodId), ["FY2025"]);
});

test("preferred-label negation is carried onto the row", () => {
  const face = table({ id: "t1", periodIds: ["FY2025"], rows: [
    { label: "Cost of sales", values: { FY2025: 60 }, concept: "us-gaap:CostOfRevenue" },
    { label: "Net sales", values: { FY2025: 100 }, concept: "us-gaap:Revenues" },
  ] });
  const merged = merge([{ tables: [face], curations: [curation("t1", "income_statement", "face")] }, filler("new", "2026-02-01")],
    [identity("new", "2026-02-01")], ["us-gaap:CostOfRevenue"]);

  const rows = merged.statementViews.income_statement.candidate.rows;
  assert.deepEqual(rows.map((row) => [row.label, (row as { negated?: boolean }).negated]),
    [["Cost of sales", true], ["Net sales", false]]);
});

test("a statement with no usable curated face table is a blocking gate", () => {
  const face = table({ id: "t1", periodIds: ["FY2025"], rows: [{ label: "Net sales", values: { FY2025: 100 } }] });
  const partial = filler("new", "2026-02-01");
  assert.throws(() => merge([
    { tables: [face], curations: [curation("t1", "income_statement", "face")] },
    { tables: partial.tables, curations: partial.curations.filter((entry) => entry.statement !== "cash_flow_statement") },
  ], [identity("new", "2026-02-01")]), (error) =>
    error instanceof IncompleteFinancialStatementsError
      && error.missingStatements.includes("cash_flow_statement")
      && error.attemptedAccessions.includes("new"));
});

test("periods no curated table covers stay review issues rather than failures", () => {
  const face = table({ id: "t1", periodIds: ["FY2025"], rows: [{ label: "Net sales", values: { FY2025: 100 } }] });
  const merged = merge([{ tables: [face], curations: [curation("t1", "income_statement", "face")] }, filler("new", "2026-02-01")],
    [identity("new", "2026-02-01")]);

  const missing = merged.coverage.issues.find((entry) => entry.code === "missing_period" && entry.statement === "income_statement");
  assert.deepEqual(missing?.periodIds, ["FY2023", "FY2024"]);
  assert.deepEqual(merged.coverage.statements.find((entry) => entry.statement === "income_statement")?.availablePeriodIds, ["FY2025"]);
  assert.deepEqual(merged.coverage.requestedPeriodIds, ["FY2023", "FY2024", "FY2025"]);
  assert.deepEqual(STATEMENTS.map((statement) => merged.statementViews[statement].filingPresentations.length), [1, 1, 1]);
});
