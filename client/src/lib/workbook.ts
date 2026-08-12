import type {
  CurrentWorkbookView, ModelRevisionFrame, SourceStatementKey, Unit, WorkbookCellView, WorkbookRowView,
} from "../types/financialModel.ts";

/** What a cell shows when it holds no number. Each status gets its own glyph
 *  rather than a shared blank: "the model does not compute this here"
 *  (not_applicable) and "an input never arrived" (missing_input) look identical
 *  when both render empty, and only one of them is a problem. */
const STATUS_GLYPH: Record<Exclude<WorkbookCellView["status"], "ok">, string> = {
  missing_input: "—",
  divide_by_zero: "#DIV/0!",
  not_applicable: "",
  not_modeled: "·",
};

const decimalsFor = (unit: Unit): number => {
  switch (unit.kind) {
    case "percent": return 1;
    case "ratio":
    case "per_share": return 2;
    default: return 0;
  }
};

/** Negative currency renders in accounting parentheses — a leading minus is
 *  easy to miss in a dense grid, and this is the convention the readers of a
 *  DCF already have in their eyes. */
export function formatCellValue(cell: WorkbookCellView, unit: Unit): string {
  if (cell.status !== "ok") return STATUS_GLYPH[cell.status];
  if (cell.value === null) return STATUS_GLYPH.missing_input;

  const scaled = unit.kind === "percent" ? cell.value * 100 : cell.value;
  const decimals = decimalsFor(unit);
  const text = Math.abs(scaled).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  if (unit.kind === "percent") {
    const withUnit = `${text}%`;
    return scaled < 0 ? `(${withUnit})` : withUnit;
  }

  const signed = scaled < 0 ? `(${text})` : text;
  return signed;
}

/** The unit belongs in the column header, not repeated in every cell. */
export function columnScaleLabel(unit: Unit): string {
  switch (unit.kind) {
    case "currency":
    case "per_share": return unit.code;
    case "percent": return "%";
    case "ratio": return "×";
    case "shares": return "shares";
    case "number": return "";
  }
}

export type RowNode = { row: WorkbookRowView; depth: number };

/** Flattens the parent/child rows into render order with a depth for indent.
 *  A row whose `parentId` is not present in this section becomes a root rather
 *  than disappearing — sections are fetched independently, and silently
 *  dropping data is worse than showing it at the wrong indent. */
export function buildRowTree(rows: readonly WorkbookRowView[]): RowNode[] {
  const present = new Set(rows.map((row) => row.lineItemId));
  const childrenOf = new Map<string, WorkbookRowView[]>();
  const roots: WorkbookRowView[] = [];

  for (const row of [...rows].sort((a, b) => a.order - b.order)) {
    const parentId = row.parentId;
    if (parentId !== undefined && present.has(parentId)) {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(row);
      childrenOf.set(parentId, siblings);
    } else {
      roots.push(row);
    }
  }

  const nodes: RowNode[] = [];
  const walk = (row: WorkbookRowView, depth: number): void => {
    nodes.push({ row, depth });
    for (const child of childrenOf.get(row.lineItemId) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return nodes;
}

export type SheetGroup = "model" | "source" | "derived";
export type SheetKind = "summary" | "source" | "revenue" | "wacc" | "dcf";
export type SheetId = string;

export type SheetDescriptor = {
  id: SheetId;
  label: string;
  group: SheetGroup;
  kind: SheetKind;
  /** Present on `kind: "source"` — which of the three statements. */
  statement?: SourceStatementKey;
  /** Present on a segment sheet — which category group it renders. */
  categoryName?: string;
};

const SOURCE_LABELS: Record<SourceStatementKey, string> = {
  income_statement: "Income Statement",
  balance_sheet: "Balance Sheet",
  cash_flow_statement: "Cash Flow Statement",
};

/** The Key Financials block, in the order the reference workbook uses.
 *  These ids span four different sections — they are NOT co-located, so the
 *  pick has to be by line item id. `src/financial-model/__tests__/viewContract.test.ts`
 *  asserts every id here still exists in the skeleton. */
export const SUMMARY_ROWS: ReadonlyArray<{ lineItemId: string; indent: boolean }> = [
  { lineItemId: "revenue.total", indent: false },
  { lineItemId: "growth.revenue.total", indent: true },
  { lineItemId: "gross_profit", indent: false },
  { lineItemId: "metric.gross_margin", indent: true },
  { lineItemId: "ebitda", indent: false },
  { lineItemId: "metric.ebitda_margin", indent: true },
  { lineItemId: "operating_income", indent: false },
  { lineItemId: "margin.operating", indent: true },
  { lineItemId: "net_income", indent: false },
  { lineItemId: "metric.net_margin", indent: true },
];

/**
 * The DCF sheet is a reading view over the whole model, not a sixth storage
 * section.  A complete valuation crosses revenue, historical statements,
 * operating drivers, the FCFF build, and the equity-bridge inputs.  Keep that
 * presentation contract in one whitelist so a partially-built workbook shows
 * only the rows it genuinely contains instead of fabricated blanks.
 */
const DCF_ROW_SPECS: ReadonlyArray<{ lineItemId: string; label?: string; group?: string; parentId?: string }> = [
  { lineItemId: "revenue.product", label: "Product Revenue", group: "Revenue & Profitability" },
  { lineItemId: "growth.revenue.product", label: "Growth", group: "Revenue & Profitability", parentId: "revenue.product" },
  { lineItemId: "metric.custom.product_gross_margin", label: "Product Gross Margin", group: "Revenue & Profitability", parentId: "revenue.product" },
  { lineItemId: "revenue.product.gross_profit", label: "Product Gross Profit", group: "Revenue & Profitability", parentId: "revenue.product" },
  { lineItemId: "revenue.products", label: "Product Revenue", group: "Revenue & Profitability" },
  { lineItemId: "revenue.service", label: "Service Revenue", group: "Revenue & Profitability" },
  { lineItemId: "growth.revenue.service", label: "Growth", group: "Revenue & Profitability", parentId: "revenue.service" },
  { lineItemId: "metric.custom.service_gross_margin", label: "Service Gross Margin", group: "Revenue & Profitability", parentId: "revenue.service" },
  { lineItemId: "revenue.service.gross_profit", label: "Service Gross Profit", group: "Revenue & Profitability", parentId: "revenue.service" },
  { lineItemId: "revenue.services", label: "Service Revenue", group: "Revenue & Profitability" },
  { lineItemId: "revenue.total", label: "Total Revenue", group: "Revenue & Profitability" },
  { lineItemId: "gross_profit", label: "Gross Profit", group: "Revenue & Profitability" },
  { lineItemId: "operating_expenses", label: "Operating Expense", group: "Revenue & Profitability" },
  { lineItemId: "metric.custom.opex_to_revenue", label: "Operating Expense / Revenue", group: "Revenue & Profitability", parentId: "operating_expenses" },
  { lineItemId: "operating_income", label: "Operating Profit", group: "Revenue & Profitability" },
  { lineItemId: "margin.operating", label: "Operating Margin", group: "Revenue & Profitability", parentId: "operating_income" },
  { lineItemId: "depreciation_amortization", label: "Dep. & Amort. Expense", group: "Revenue & Profitability" },
  { lineItemId: "ratio.da_to_revenue", label: "D&A / Revenue", group: "Revenue & Profitability", parentId: "depreciation_amortization" },
  { lineItemId: "pretax_income", label: "Taxable Income", group: "Revenue & Profitability" },
  { lineItemId: "income_tax_expense", label: "Tax Expense", group: "Revenue & Profitability" },
  { lineItemId: "tax_rate", label: "Tax Rate", group: "Revenue & Profitability", parentId: "income_tax_expense" },
  { lineItemId: "nopat", label: "NOPAT", group: "Revenue & Profitability" },
  { lineItemId: "operating_working_capital", label: "NWC", group: "Working Capital" },
  { lineItemId: "ratio.operating_nwc_to_revenue", label: "NWC / Revenue", group: "Working Capital", parentId: "operating_working_capital" },
  { lineItemId: "capital_expenditures", label: "(-) Capex", group: "FCF Adjustments" },
  { lineItemId: "ratio.capex_to_revenue", label: "Capex / Revenue", group: "FCF Adjustments", parentId: "capital_expenditures" },
  { lineItemId: "change_nwc", label: "(-) Change in NWC", group: "FCF Adjustments" },
  { lineItemId: "fcff", label: "Free Cash Flow", group: "Discounted Cash Flow" },
  { lineItemId: "wacc", label: "WACC", group: "Terminal Assumptions" },
  { lineItemId: "terminal_growth", label: "Terminal Growth", group: "Terminal Assumptions" },
  { lineItemId: "exit_multiple", label: "Exit Multiple", group: "Terminal Assumptions" },
  { lineItemId: "cash_available_for_bridge", label: "Cash Available for Bridge", group: "Equity Bridge Inputs" },
  { lineItemId: "non_operating_investments", label: "Non-operating Investments", group: "Equity Bridge Inputs" },
  { lineItemId: "debt", label: "Debt", group: "Equity Bridge Inputs" },
  { lineItemId: "lease_liabilities", label: "Lease Liabilities", group: "Equity Bridge Inputs" },
  { lineItemId: "preferred_equity", label: "Preferred Equity", group: "Equity Bridge Inputs" },
  { lineItemId: "non_controlling_interests", label: "Non-controlling Interests", group: "Equity Bridge Inputs" },
  { lineItemId: "diluted_shares", label: "Shares Outstanding", group: "Equity Bridge Inputs" },
];

const allRows = (workbook: CurrentWorkbookView): WorkbookRowView[] => [
  ...workbook.sections.history, ...workbook.sections.metrics,
  ...workbook.sections.revenue, ...workbook.sections.operations, ...workbook.sections.dcf,
];

/** A whitelist row that the model has not built yet is skipped, not rendered
 *  as a blank — an empty row claims "this is zero", which is a different
 *  statement from "the model has not got here". */
export function buildSummaryRows(workbook: CurrentWorkbookView): WorkbookRowView[] {
  const byId = new Map(allRows(workbook).map((row) => [row.lineItemId, row]));
  return SUMMARY_ROWS
    .map((entry) => byId.get(entry.lineItemId))
    .filter((row): row is WorkbookRowView => row !== undefined);
}

export type DcfRows = {
  rows: WorkbookRowView[];
  /** Group labels keyed by the first row that begins each visible group. */
  groupLabels: Record<string, string>;
};

/**
 * Select the end-to-end valuation chain while retaining the original cells,
 * formulas and provenance.  Source-section hierarchy is intentionally not
 * carried over, but forecast-driver rows are attached directly below the
 * operating line they drive so inputs and results can be read together.
 */
export function buildDcfRows(workbook: CurrentWorkbookView): DcfRows {
  const byId = new Map(allRows(workbook).map((row) => [row.lineItemId, row]));
  const used = new Set<string>();
  const rows: WorkbookRowView[] = [];
  const groupLabels: Record<string, string> = {};

  for (const spec of DCF_ROW_SPECS) {
    const source = byId.get(spec.lineItemId);
    // Some models use the legacy plural product/service ids.  Do not show a
    // duplicated economic row if a workbook happens to carry both spellings.
    const economicRow = spec.lineItemId === "revenue.products" ? "revenue.product"
      : spec.lineItemId === "revenue.services" ? "revenue.service" : spec.lineItemId;
    if (!source || used.has(economicRow)) continue;
    used.add(economicRow);
    const presentationRow: WorkbookRowView = {
      ...source,
      label: spec.label ?? source.label,
      parentId: spec.parentId,
      order: rows.length,
    };
    rows.push(presentationRow);
    if (spec.group && !Object.values(groupLabels).includes(spec.group)) {
      groupLabels[presentationRow.lineItemId] = spec.group;
    }
  }

  return { rows, groupLabels };
}

/** Which line items belong to a segment sheet, by category name. */
function segmentMembers(workbook: CurrentWorkbookView): Map<string, Set<string>> {
  const byCategory = new Map<string, Set<string>>();
  for (const group of workbook.categoryGroups) {
    const members = byCategory.get(group.category) ?? new Set<string>();
    for (const member of group.members) members.add(member.lineItemId);
    byCategory.set(group.category, members);
  }
  return byCategory;
}

/** The strip is generated from what the model actually holds, so it doubles as
 *  a progress indicator: a draft model shows only its source statements. */
export function deriveSheets(workbook: CurrentWorkbookView): SheetDescriptor[] {
  const sheets: SheetDescriptor[] = [];

  // Gated on history/metrics specifically, NOT on `buildSummaryRows(workbook).length`:
  // that function scans every section for a whitelist hit (by design — the summary
  // sheet's own rows are pulled from operations too, e.g. `ebitda`). Reusing it here
  // would light up the summary tab off an operations- or revenue-only workbook that
  // has not actually had its historicals committed yet.
  if (workbook.sections.history.length > 0 || workbook.sections.metrics.length > 0) {
    sheets.push({ id: "summary", label: "Summary", group: "model", kind: "summary" });
  }

  const review = workbook.sourceStatementReview;
  if (review) {
    for (const statement of ["income_statement", "balance_sheet", "cash_flow_statement"] as const) {
      if (review.sheets[statement].length > 0) {
        sheets.push({
          id: `source:${statement}`, label: SOURCE_LABELS[statement],
          group: "source", kind: "source", statement,
        });
      }
    }
  }

  if (workbook.sections.revenue.length > 0) {
    sheets.push({ id: "revenue", label: "Revenue", group: "model", kind: "revenue" });
  }
  for (const category of segmentMembers(workbook).keys()) {
    sheets.push({
      id: `segment:${category}`, label: `Segment: ${category}`,
      group: "model", kind: "revenue", categoryName: category,
    });
  }

  if (workbook.waccSheet) {
    sheets.push({ id: "wacc", label: "WACC", group: "derived", kind: "wacc" });
  }
  if (workbook.sections.operations.length > 0 || workbook.sections.dcf.length > 0 || workbook.valuation) {
    sheets.push({ id: "dcf", label: "DCF", group: "derived", kind: "dcf" });
  }

  return sheets;
}

const WACC_KINDS = new Set(["wacc_sheet_refreshed", "wacc_input_set"]);
const DCF_KINDS = new Set(["valuation_config_set"]);

/** The server's `ModelReadSection` names, which are NOT a mechanical transform
 *  of the sheet keys: the third one is `source_cash_flow`, with no `_statement`
 *  suffix. Deriving these by string surgery silently kills that sheet's dot. */
const SOURCE_SECTION: Record<SourceStatementKey, string> = {
  income_statement: "source_income_statement",
  balance_sheet: "source_balance_sheet",
  cash_flow_statement: "source_cash_flow",
};

/**
 * Which sheets a revision touched.
 *
 * Three inputs, none of them optional:
 *   - `change_kinds` — the ONLY signal for WACC. `ModelReadSection` has no
 *     WACC member, so `changed_sections` can never report one.
 *   - `changed_line_item_ids` — resolves a `revenue` change to the specific
 *     segment sheet that owns the line item.
 *   - `changed_sections` — catches changes whose line items are not on any
 *     sheet's pick list, e.g. `line_item_added` outside the summary whitelist.
 *
 * A single change may legitimately touch two sheets (`ebitda` is both a summary
 * row and part of the DCF operations block). The result keeps both, in strip
 * order; the caller dot-marks all of them and auto-navigates to the first.
 */
export function sheetsTouchedBy(
  frame: ModelRevisionFrame,
  sheets: readonly SheetDescriptor[],
  workbook: CurrentWorkbookView,
): SheetId[] {
  const touched = new Set<SheetId>();
  const sections = new Set(frame.changed_sections);
  const kinds = new Set(frame.change_kinds);
  const changedIds = new Set(frame.changed_line_item_ids);
  const members = segmentMembers(workbook);
  const summaryIds = new Set(SUMMARY_ROWS.map((entry) => entry.lineItemId));

  for (const sheet of sheets) {
    switch (sheet.kind) {
      case "wacc":
        if ([...kinds].some((kind) => WACC_KINDS.has(kind))) touched.add(sheet.id);
        break;
      case "dcf":
        if (sections.has("operations") || sections.has("dcf")) touched.add(sheet.id);
        if ([...kinds].some((kind) => DCF_KINDS.has(kind))) touched.add(sheet.id);
        break;
      case "summary":
        if (sections.has("history") || sections.has("metrics")) touched.add(sheet.id);
        if ([...changedIds].some((id) => summaryIds.has(id))) touched.add(sheet.id);
        break;
      case "source":
        if (sheet.statement && sections.has(SOURCE_SECTION[sheet.statement])) touched.add(sheet.id);
        break;
      case "revenue": {
        if (!sections.has("revenue")) break;
        const owned = sheet.categoryName ? members.get(sheet.categoryName) ?? new Set<string>() : undefined;
        if (owned) {
          if ([...changedIds].some((id) => owned.has(id))) touched.add(sheet.id);
          break;
        }
        // The fallback revenue sheet takes anything no segment sheet claimed,
        // including a section-level change that named no line items at all.
        const claimed = new Set([...members.values()].flatMap((set) => [...set]));
        if (changedIds.size === 0 || [...changedIds].some((id) => !claimed.has(id))) touched.add(sheet.id);
        break;
      }
    }
  }

  return sheets.map((sheet) => sheet.id).filter((id) => touched.has(id));
}

/** A change that names line items but no periods changed the whole row
 *  (a formula or source swap), so every period in it lights up. */
export function isCellChanged(frame: ModelRevisionFrame, lineItemId: string, periodId: string): boolean {
  if (!frame.changed_line_item_ids.includes(lineItemId)) return false;
  return frame.changed_period_ids.length === 0 || frame.changed_period_ids.includes(periodId);
}
