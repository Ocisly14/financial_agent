import type { StatementKind } from "../../financial-model/types.ts";
import type { AnnualFilingForm, FilingTableFactOccurrence } from "./types.ts";

/**
 * Protocol v2 table shapes. A curated table is the statement: row order, row
 * labels, and cells come from the filing's own HTML, and the presentation
 * linkbase is demoted to auxiliary evidence.
 */

export type FilingTableColumn = {
  /** 0-based position after colspan/rowspan expansion; comparable across rows. */
  index: number;
  headerText: string;
  /** Majority vote over the contexts of this column's facts; absent on ties. */
  periodId?: string;
  isLabelColumn: boolean;
};

export type FilingTableCell = {
  columnIndex: number;
  /** Rendered text. Always present, including for untagged numeric cells. */
  text: string;
  fact?: FilingTableFactOccurrence;
};

export type FilingTableGridRow = {
  /** 1-based order within the table. */
  order: number;
  labelText: string;
  /** Presentation evidence from indentation only; never accounting meaning. */
  indentLevel: number;
  cells: FilingTableCell[];
};

export type TablePrescreen = {
  tier: "strong" | "weak";
  /** |table concepts ∩ face-statement presentation concepts| / |table concepts| */
  presentationOverlap: number;
  /** Facts with zero dimensions / total facts. */
  dimensionlessRatio: number;
  /** Distinct requested periodIds covered. */
  periodSpan: number;
  factCount: number;
};

export type FilingTable = {
  sourceTableId: string;
  accession: string;
  form: AnnualFilingForm;
  filedAt: string;
  reportDate: string;
  heading: string;
  htmlOrder: number;
  sourceAnchor: string;
  prescreen: TablePrescreen;
  /** Ratio-weighted presentation hint, ordered by overlap descending. */
  suggestedStatements: StatementKind[];
  columns: FilingTableColumn[];
  rows: FilingTableGridRow[];
};

/** Light catalog projection. Never carries cells. */
export type FilingTableCatalogEntry = {
  sourceTableId: string;
  accession: string;
  form: AnnualFilingForm;
  filedAt: string;
  reportDate: string;
  heading: string;
  htmlOrder: number;
  rowCount: number;
  factCount: number;
  columnHeaders: string[];
  rowLabels: string[];
  rowLabelsTruncated: boolean;
  prescreen: TablePrescreen;
  suggestedStatements: StatementKind[];
  curation?: TableCuration;
  annotation?: TableAnnotation;
};

export type CurationKind = "face" | "parenthetical" | "continuation" | "superseded";

export type TableCuration = {
  sourceTableId: string;
  statement: StatementKind;
  reportDate: string;
  kind: CurationKind;
  /** Head table for `continuation`; replacement for `superseded`. */
  relatedTableId?: string;
  rationale: string;
};

/** Agent-reviewed waiver of one deterministic column/fact period conflict. */
export type ColumnConflictWaiver = {
  sourceTableId: string;
  rowOrder: number;
  columnIndex: number;
  rationale: string;
};

export const TABLE_TOPICS = [
  "segment_revenue",
  "capex",
  "depreciation_amortization",
  "leases",
  "debt_maturity",
  "tax_rate",
  "stock_compensation",
  "share_count",
  "working_capital",
  "acquisitions",
  "impairment",
] as const;

export type ControlledTableTopic = (typeof TABLE_TOPICS)[number];
/** A controlled topic, or `other:<free text>` for industry-specific disclosures. */
export type TableTopic = ControlledTableTopic | `other:${string}`;

export type TableAnnotation = {
  tableId: string;
  title?: string;
  summary?: string;
  topics: TableTopic[];
};

/** A derived-table cell is a coordinate, never a value. */
export type DerivedCellReference = {
  sourceTableId: string;
  rowOrder: number;
  columnIndex: number;
};

export type DerivedTableDefinition = {
  derivedTableId: string;
  title: string;
  summary: string;
  topics: TableTopic[];
  columns: Array<{ periodId: string }>;
  rows: Array<{
    label: string;
    /** null marks a deliberately empty cell rather than a missing reference. */
    cells: Array<DerivedCellReference | null>;
  }>;
  rationale: string;
};

/** What `create_derived_table` returns: the definition with values resolved. */
export type MaterializedDerivedTable = {
  definition: DerivedTableDefinition;
  rows: Array<{
    label: string;
    cells: Array<{
      reference: DerivedCellReference;
      value: number;
      unit: FilingTableFactOccurrence["unit"];
      sourceAnchor: string;
    } | null>;
  }>;
};
