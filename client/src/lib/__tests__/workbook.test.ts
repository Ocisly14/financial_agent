import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRowTree, buildSummaryRows, columnScaleLabel, deriveSheets,
  formatCellValue, isCellChanged, sheetsTouchedBy,
} from "../workbook.ts";
import type {
  CurrentWorkbookView, ModelRevisionFrame, Unit, WorkbookCellView, WorkbookRowView,
} from "../../types/financialModel.ts";

const USD: Unit = { kind: "currency", code: "USD" };

const cell = (over: Partial<WorkbookCellView> = {}): WorkbookCellView => ({
  value: 1234567,
  status: "ok",
  source: { kind: "none" },
  diagnostics: [],
  ...over,
});

const row = (lineItemId: string, over: Partial<WorkbookRowView> = {}): WorkbookRowView => ({
  lineItemId,
  label: lineItemId,
  section: "operations",
  role: "none",
  unit: USD,
  order: 0,
  sources: { historical: "actual", forecast: "none" },
  formulas: [],
  assumptions: [],
  cells: {},
  ...over,
});

test("currency cells render with thousands separators and no unit suffix", () => {
  assert.equal(formatCellValue(cell({ value: 1234567 }), USD), "1,234,567");
  assert.equal(formatCellValue(cell({ value: -4200 }), USD), "(4,200)");
});

test("percent and ratio cells use their own precision", () => {
  assert.equal(formatCellValue(cell({ value: 0.38234 }), { kind: "percent" }), "38.2%");
  assert.equal(formatCellValue(cell({ value: 1.2345 }), { kind: "ratio" }), "1.23");
  assert.equal(formatCellValue(cell({ value: 6.1234 }), { kind: "per_share", code: "USD" }), "6.12");
  assert.equal(formatCellValue(cell({ value: 15334000 }), { kind: "shares" }), "15,334,000");
});

test("zero is rendered as zero, not missing", () => {
  assert.equal(formatCellValue(cell({ value: 0 }), USD), "0");
  assert.equal(formatCellValue(cell({ value: 0 }), { kind: "percent" }), "0.0%");
});

test("negative percent parenthesizes the complete value including the percent sign", () => {
  assert.equal(formatCellValue(cell({ value: -0.042 }), { kind: "percent" }), "(4.2%)");
});

test("each non-ok status has its own glyph, and none of them show a number", () => {
  assert.equal(formatCellValue(cell({ status: "missing_input" }), USD), "—");
  assert.equal(formatCellValue(cell({ status: "divide_by_zero" }), USD), "#DIV/0!");
  assert.equal(formatCellValue(cell({ status: "not_applicable" }), USD), "");
  assert.equal(formatCellValue(cell({ status: "not_modeled" }), USD), "·");
});

test("a null value renders as missing even when the status claims ok", () => {
  assert.equal(formatCellValue(cell({ value: null }), USD), "—");
});

test("the column header carries the currency, so cells do not repeat it", () => {
  assert.equal(columnScaleLabel(USD), "USD");
  assert.equal(columnScaleLabel({ kind: "percent" }), "%");
  assert.equal(columnScaleLabel({ kind: "ratio" }), "×");
});

test("row tree nests children under parents and keeps section order", () => {
  const tree = buildRowTree([
    row("revenue.total", { order: 1, parentId: "revenue" }),
    row("revenue", { order: 0 }),
    row("growth.revenue.total", { order: 2, parentId: "revenue.total" }),
  ]);

  assert.deepEqual(tree.map((node) => [node.row.lineItemId, node.depth]), [
    ["revenue", 0],
    ["revenue.total", 1],
    ["growth.revenue.total", 2],
  ]);
});

test("a row whose parent is absent from the section is treated as a root", () => {
  // Sections are read independently, so a child can arrive without its parent.
  // Dropping it would silently hide data; it becomes a root instead.
  const tree = buildRowTree([row("ebitda", { order: 0, parentId: "not.in.this.section" })]);
  assert.deepEqual(tree.map((node) => [node.row.lineItemId, node.depth]), [["ebitda", 0]]);
});

// `Partial<CurrentWorkbookView>` flattens the discriminated union (a mapped
// type does not distribute over a union the way a conditional type does), so
// `over.mode` types as the bare union `"dcf" | "statement_mapping"` instead of
// a literal tied to `sourceStatementReview`. TS can no longer verify the
// mode/sourceStatementReview correlation through the spread, so the return
// needs an explicit assertion — the correlation is enforced by the caller
// (test 2 passes both together), not by the type checker here.
const workbook = (over: Partial<CurrentWorkbookView> = {}): CurrentWorkbookView => ({
  modelId: "m1",
  revision: 1,
  lifecycleStage: "operations_fcff",
  periods: [{ id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" }],
  sections: { history: [], metrics: [], revenue: [], operations: [], dcf: [] },
  categoryGroups: [],
  reconciliationResults: [],
  diagnostics: [],
  valuation: null,
  waccSheet: null,
  mode: "dcf",
  ...over,
} as CurrentWorkbookView);

const frame = (over: Partial<ModelRevisionFrame> = {}): ModelRevisionFrame => ({
  model_id: "m1",
  revision: 2,
  lifecycle_stage: "operations_fcff",
  changed_sections: [],
  changed_line_item_ids: [],
  changed_period_ids: [],
  change_kinds: [],
  ...over,
});

test("sheets appear only when the model actually has their content", () => {
  const bare = deriveSheets(workbook());
  assert.deepEqual(bare.map((sheet) => sheet.id), []);

  const withOperations = deriveSheets(workbook({
    sections: { history: [], metrics: [], revenue: [], operations: [row("ebitda")], dcf: [] },
  }));
  assert.deepEqual(withOperations.map((sheet) => sheet.id), ["dcf"]);
});

test("the sheet strip orders model, source, then derived groups", () => {
  const sheets = deriveSheets(workbook({
    mode: "statement_mapping",
    sections: {
      history: [row("net_income", { section: "history" })],
      metrics: [],
      revenue: [row("revenue.total", { section: "revenue" })],
      operations: [row("ebitda")],
      dcf: [],
    },
    waccSheet: { asOfDate: "2026-01-01", rows: [] },
    sourceStatementReview: {
      selectedPeriodIds: ["FY2024"],
      sheets: {
        income_statement: [{ sourceLineItemId: "s1", label: "Revenue", unit: USD, cells: {} }],
        balance_sheet: [],
        cash_flow_statement: [],
      },
      reconciliations: [],
    },
  }));

  assert.deepEqual(sheets.map((sheet) => sheet.id), [
    "summary", "source:income_statement", "revenue", "wacc", "dcf",
  ]);
  assert.deepEqual(sheets.map((sheet) => sheet.group), [
    "model", "source", "model", "derived", "derived",
  ]);
});

test("each category group becomes its own segment sheet alongside the revenue fallback", () => {
  const sheets = deriveSheets(workbook({
    sections: {
      history: [], metrics: [], operations: [], dcf: [],
      revenue: [row("revenue.products", { section: "revenue" }), row("revenue.total", { section: "revenue" })],
    },
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "Product line",
      periodIds: ["FY2024"],
      members: [{ lineItemId: "revenue.products", treatment: "add" }],
      reviewDecisionId: "d1",
    }],
  }));

  assert.deepEqual(sheets.map((sheet) => sheet.id), ["revenue", "segment:Product line"]);
  assert.equal(sheets[1]?.label, "分部:Product line");
});

test("the summary sheet picks whitelisted rows across four sections in Excel order", () => {
  const rows = buildSummaryRows(workbook({
    sections: {
      history: [row("net_income", { section: "history" }), row("gross_profit", { section: "history" })],
      metrics: [row("metric.net_margin", { section: "metrics" }), row("metric.gross_margin", { section: "metrics" })],
      revenue: [row("revenue.total", { section: "revenue" })],
      operations: [row("ebitda"), row("operating_income")],
      dcf: [],
    },
  }));

  // growth.revenue.total, metric.ebitda_margin and margin.operating are absent
  // from this fixture — a whitelist row that does not exist is skipped, not
  // rendered as an empty row.
  assert.deepEqual(rows.map((r) => r.lineItemId), [
    "revenue.total", "gross_profit", "metric.gross_margin",
    "ebitda", "operating_income", "net_income", "metric.net_margin",
  ]);
});

test("a wacc change is found through change_kinds alone", () => {
  const sheets = deriveSheets(workbook({ waccSheet: { asOfDate: "2026-01-01", rows: [] } }));
  // changed_sections is empty: ModelReadSection has no WACC member at all.
  const touched = sheetsTouchedBy(frame({ change_kinds: ["wacc_sheet_refreshed"] }), sheets, workbook());
  assert.deepEqual(touched, ["wacc"]);
});

test("a revenue change lands on the segment sheet that owns the line item", () => {
  const book = workbook({
    sections: {
      history: [], metrics: [], operations: [], dcf: [],
      revenue: [row("revenue.products", { section: "revenue" })],
    },
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "Product line",
      periodIds: ["FY2024"],
      members: [{ lineItemId: "revenue.products", treatment: "add" }],
      reviewDecisionId: "d1",
    }],
  });
  const sheets = deriveSheets(book);

  const touched = sheetsTouchedBy(
    frame({ changed_sections: ["revenue"], changed_line_item_ids: ["revenue.products"] }),
    sheets,
    book,
  );
  assert.deepEqual(touched, ["segment:Product line"]);
});

test("a section-level change with no matching line item still marks the sheet", () => {
  // `line_item_added` outside the summary whitelist would otherwise be silent.
  const book = workbook({
    sections: { history: [], metrics: [], revenue: [], operations: [row("ebitda")], dcf: [] },
  });
  const touched = sheetsTouchedBy(
    frame({ changed_sections: ["operations"], change_kinds: ["line_item_added"] }),
    deriveSheets(book),
    book,
  );
  assert.deepEqual(touched, ["dcf"]);
});

test("one change may mark two sheets and they are not collapsed into one", () => {
  // `ebitda` is both a summary whitelist row and part of the DCF operations block.
  const book = workbook({
    sections: {
      history: [row("gross_profit", { section: "history" })],
      metrics: [], revenue: [], dcf: [],
      operations: [row("ebitda")],
    },
  });
  const touched = sheetsTouchedBy(
    frame({ changed_sections: ["operations"], changed_line_item_ids: ["ebitda"] }),
    deriveSheets(book),
    book,
  );
  assert.deepEqual(touched, ["summary", "dcf"]);
});

test("changed cells are the cross product of the changed ids", () => {
  const f = frame({ changed_line_item_ids: ["tax_rate"], changed_period_ids: ["FY2026", "FY2027"] });
  assert.equal(isCellChanged(f, "tax_rate", "FY2026"), true);
  assert.equal(isCellChanged(f, "tax_rate", "FY2025"), false);
  assert.equal(isCellChanged(f, "nopat", "FY2026"), false);
});

test("a row-wide change with no period ids marks the whole row", () => {
  const f = frame({ changed_line_item_ids: ["tax_rate"], changed_period_ids: [] });
  assert.equal(isCellChanged(f, "tax_rate", "FY2026"), true);
  assert.equal(isCellChanged(f, "nopat", "FY2026"), false);
});

test("source sheet ids map onto the server's own section names", () => {
  // The server calls the third one `source_cash_flow`, not
  // `source_cash_flow_statement`. Getting this wrong silently kills the dot.
  const book = workbook({
    mode: "statement_mapping",
    sourceStatementReview: {
      selectedPeriodIds: ["FY2024"],
      sheets: {
        income_statement: [{ sourceLineItemId: "s1", label: "Revenue", unit: USD, cells: {} }],
        balance_sheet: [{ sourceLineItemId: "s2", label: "Cash", unit: USD, cells: {} }],
        cash_flow_statement: [{ sourceLineItemId: "s3", label: "OCF", unit: USD, cells: {} }],
      },
      reconciliations: [],
    },
  });
  const sheets = deriveSheets(book);

  assert.deepEqual(sheetsTouchedBy(frame({ changed_sections: ["source_cash_flow"] }), sheets, book),
    ["source:cash_flow_statement"]);
  assert.deepEqual(sheetsTouchedBy(frame({ changed_sections: ["source_balance_sheet"] }), sheets, book),
    ["source:balance_sheet"]);
});
