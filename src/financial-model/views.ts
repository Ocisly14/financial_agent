import { cellKey, dependenciesOf, splitCellKey, type CellKey, type GraphContext } from "./dsl/graph.ts";
import { FinancialModelError } from "./errors.ts";
import type { FinancialModelSnapshot, ModelSelector } from "./operations.ts";
import type { ModelView, Revision, RevisionHeader } from "./store.ts";
import type { ValuationOutput } from "./valuation.ts";
import { buildGrid } from "./periodGrid.ts";
import { WACC_SHEET_ROW_IDS, type WaccSheet, type WaccSheetAnyRowId, type WaccSheetRowId } from "./waccSheet.ts";
import type {
  Assumption, CellSource, DcfCategoryGroup, Diagnostic, LifecycleStage, LineItemRole, Period,
  ReconciliationResult, Unit, ValuationConfig,
} from "./types.ts";
import type { JsonObject } from "../framework/types.ts";
import type { UnifiedStatementsArtifact } from "../infra/xbrl/unifiedStatements.ts";

export const DCF_WORKBOOK_SECTIONS = ["history", "metrics", "revenue", "operations", "dcf"] as const;
/**
 * Readable in the order a workbook is read. One runtime list rather than a type alone, because the
 * names have to reach the agent: a section is chosen by a tool argument, and a schema that says only
 * `string` leaves the caller guessing at names it can see everywhere else in its own output —
 * `income_statement` and `balance_sheet` are the natural guesses, and both are wrong here.
 */
export const MODEL_READ_SECTIONS = [...DCF_WORKBOOK_SECTIONS,
  "source_income_statement", "source_balance_sheet", "source_cash_flow"] as const;

export type DcfWorkbookSection = typeof DCF_WORKBOOK_SECTIONS[number];
export type ModelReadSection = typeof MODEL_READ_SECTIONS[number];

export type RevisionChange =
  | { kind: "model_created" }
  | { kind: "statements_staged"; rowCount: number; candidateCount: number; mappedLineItemIds: string[]; periodIds: string[] }
  | { kind: "fact_replaced"; lineItemId: string; periodId: string }
  | { kind: "assumption_set"; lineItemId: string; periodIds: string[] }
  | { kind: "line_item_source_set"; lineItemId: string; range: "historical" | "forecast"; source: "actual" | "assumption" | "formula" | "none" }
  | { kind: "line_item_added"; lineItemId: string; parentId?: string }
  | { kind: "metric_added"; registryId: "cagr"; lineItemId: string }
  | { kind: "formula_set"; lineItemId: string; appliesTo: "historical" | "forecast"; periodIds: string[] }
  | { kind: "category_group_set"; parentLineItemId: string; category: string; periodIds: string[] }
  | { kind: "valuation_config_set" }
  | { kind: "stage_advanced"; from: LifecycleStage; to: LifecycleStage }
  | { kind: "archived" }
  | { kind: "wacc_sheet_refreshed"; rowIds: WaccSheetAnyRowId[] }
  | { kind: "wacc_input_set"; rowId: WaccSheetRowId };

export type RevisionChangeSummary = JsonObject & {
  changes: RevisionChange[];
  changedSections: ModelReadSection[];
  warningCount: number;
  blockerCount: 0;
};

export type RevisionSummary = RevisionChangeSummary & {
  revision: number;
  parentRevision: number | null;
  lifecycleStage: LifecycleStage;
  engineVersion: string;
  creatingSessionId: string;
  createdAt: string;
};

export type WorkbookCellStatus = "ok" | "missing_input" | "divide_by_zero" | "not_applicable" | "not_modeled";
export type WorkbookCellSource =
  | { kind: "fact"; factId: string }
  | { kind: "assumption"; assumptionId: string }
  | { kind: "formula"; definitionIndex: number }
  | { kind: "calculated"; output: string }
  | { kind: "none" };
/** Exact workbook coordinates a formula reads for this period.  Keeping these
 * as coordinates — rather than only IDs parsed again by the UI — preserves
 * LAG/YOY/window semantics for cell-inspector highlighting. */
export type WorkbookCellDependency = { lineItemId: string; periodId: string };
export type WorkbookCellView = {
  value: number | null; status: WorkbookCellStatus; source: WorkbookCellSource;
  diagnostics: Diagnostic[]; dependencies: WorkbookCellDependency[];
};

export type WorkbookRowView = {
  lineItemId: string; label: string; parentId?: string; section: DcfWorkbookSection;
  role: LineItemRole; unit: Unit; order: number;
  sources: { historical: CellSource; forecast: CellSource };
  formulas: Array<{ appliesTo: "historical" | "forecast"; periodIds: string[]; source: string }>;
  assumptions: Assumption[];
  cells: Record<string, WorkbookCellView>;
  description?: string;
};

export type SourceStatementRowView = { sourceLineItemId: string; label: string; unit: Unit; cells: Record<string, WorkbookCellView> };
export type SourceStatementReviewView = {
  selectedPeriodIds: string[];
  sheets: Record<"income_statement" | "balance_sheet" | "cash_flow_statement", SourceStatementRowView[]>;
  reconciliations: ReconciliationResult[];
};

type CurrentWorkbookBase = {
  modelId: string; revision: number; lifecycleStage: LifecycleStage; engineVersion: string;
  filingInsightSetId: string | null;
  periods: Period[];
  sections: Record<DcfWorkbookSection, WorkbookRowView[]>;
  categoryGroups: DcfCategoryGroup[];
  reconciliationResults: ReconciliationResult[];
  valuationConfig: ValuationConfig;
  diagnostics: Diagnostic[];
  valuation: ValuationOutput | null;
  waccSheet: WaccSheet | null;
};
export type CurrentWorkbookView = CurrentWorkbookBase & (
  | { mode: "statement_mapping"; sourceStatementReview: SourceStatementReviewView }
  | { mode: "dcf"; sourceStatementReview?: never }
);

export type WorkbookSliceView = {
  modelId: string; revision: number; periods: Period[];
  rows: Array<WorkbookRowView | SourceStatementRowView>;
  includeLineage: boolean;
  lineage?: {
    facts: FinancialModelSnapshot["facts"];
    factReviewDecisions: FinancialModelSnapshot["factReviewDecisions"];
  };
};
export type ModelContextView = { model: ModelView; revisionHistory: RevisionSummary[]; currentWorkbook: CurrentWorkbookView };

export type HistoricalDcfCompletenessView = {
  selectedHistoricalPeriodIds: string[];
  categories: Array<{
    lineItemId: string;
    role: LineItemRole;
    periods: Array<{ periodId: string; status: "complete" | "missing" | "not_applicable"; refs: string[] }>;
  }>;
};

export type WorkbookViewOptions = {
  includeSourceStatements?: boolean;
  /** The human-facing HTTP read supplies this external artifact so the three
   * source tabs show statement_unification's reconciled, multi-year rows.
   * Agent reads intentionally omit it to keep their workbook context small. */
  unifiedStatements?: UnifiedStatementsArtifact;
};

const DCF_SECTIONS: readonly DcfWorkbookSection[] = ["history", "metrics", "revenue", "operations", "dcf"];
const PUBLIC_WACC_ROW_IDS: ReadonlySet<string> = new Set(WACC_SHEET_ROW_IDS);
/** Public rows plus the hidden `cash_and_equivalents_value` row — the full namespace a
 * `wacc_sheet_refreshed` change's `rowIds` may draw from. */
const ALL_WACC_ROW_IDS: ReadonlySet<string> = new Set([...WACC_SHEET_ROW_IDS, "cash_and_equivalents_value"]);

/** The sheet's hidden 13th row (`cash_and_equivalents_value`) exists only so the locked `net_debt`
 * formula has an operand; it is not part of the agent-facing 12-row contract and must not leak into
 * the workbook view. */
function publicWaccSheet(waccSheet: WaccSheet | null): WaccSheet | null {
  if (waccSheet === null) return null;
  const clone = structuredClone(waccSheet);
  return { asOfDate: clone.asOfDate, rows: clone.rows.filter((row) => PUBLIC_WACC_ROW_IDS.has(row.rowId)) };
}

/**
 * Facts committed straight from the unified-statements spine are what prove a mapped history: they
 * are the only thing that puts values on canonical rows, so until some exist the workbook is still
 * a source-statement review rather than a DCF.
 */
export function hasCommittedSpine(snapshot: FinancialModelSnapshot): boolean {
  return snapshot.facts.some((fact) =>
    fact.status === "committed" && fact.provenance.sourceType === "unified_statements");
}

export function buildWorkbookView(
  modelId: string, revision: number, snapshot: FinancialModelSnapshot, options: WorkbookViewOptions = {},
): CurrentWorkbookView {
  const sections: Record<DcfWorkbookSection, WorkbookRowView[]> = {
    history: [], metrics: [], revenue: [], operations: [], dcf: [],
  };
  for (const item of orderedItems(snapshot).filter((row) => !row.section.startsWith("source_"))) {
    sections[item.section as DcfWorkbookSection].push(buildDcfRow(snapshot, item.id));
  }
  const base: CurrentWorkbookBase = {
    modelId, revision, lifecycleStage: snapshot.lifecycleStage, engineVersion: snapshot.engineVersion,
    filingInsightSetId: snapshot.filingInsightSetId ?? null,
    periods: structuredClone(snapshot.periods), sections,
    categoryGroups: structuredClone([...snapshot.categoryGroups].sort((left, right) =>
      itemOrder(snapshot, left.parentLineItemId) - itemOrder(snapshot, right.parentLineItemId)
      || compareText(left.parentLineItemId, right.parentLineItemId)
      || compareText(left.category, right.category)
      || firstPeriodPosition(snapshot, left.periodIds) - firstPeriodPosition(snapshot, right.periodIds))),
    reconciliationResults: structuredClone(snapshot.reconciliationResults),
    valuationConfig: structuredClone(snapshot.valuationConfig), diagnostics: structuredClone(snapshot.diagnostics),
    valuation: structuredClone(snapshot.valuation),
    waccSheet: publicWaccSheet(snapshot.waccSheet),
  };
  // A failed reconciliation no longer demotes the workbook: the failure reports itself on the
  // reconciliation result (with its unified trail), so the DCF view stays readable while it is fixed.
  const mappingMode = options.includeSourceStatements === true
    || !hasCommittedSpine(snapshot)
    || snapshot.selectedHistoricalPeriodIds.length === 0;
  if (!mappingMode) return { ...base, mode: "dcf" };
  return {
    ...base,
    mode: "statement_mapping",
    sourceStatementReview: buildSourceReview(snapshot, options.unifiedStatements),
  };
}

export function buildWorkbookSlice(
  modelId: string, revision: number, snapshot: FinancialModelSnapshot,
  selector: ModelSelector, includeLineage = false,
): WorkbookSliceView {
  validateSelector(snapshot, selector);
  const explicitCells = new Set((selector.cellRefs ?? []).map((ref) => cellKey(ref.lineItemId, ref.periodId)));
  const hasExplicitCells = explicitCells.size > 0;
  const explicitCellPeriods = new Set((selector.cellRefs ?? []).map((ref) => ref.periodId));
  const itemIds = new Set(selector.lineItemIds ?? []);
  const periodIds = new Set(selector.periodIds ?? []);
  const selectedPeriods = snapshot.periods.filter((period) =>
    (periodIds.size === 0 || periodIds.has(period.id))
    && (selector.periodClass === undefined || period.cls === selector.periodClass)
    && (!hasExplicitCells || explicitCellPeriods.has(period.id)));
  const rows: Array<WorkbookRowView | SourceStatementRowView> = [];
  for (const item of orderedItems(snapshot)) {
    if (itemIds.size > 0 && !itemIds.has(item.id)) continue;
    if (selector.parentId !== undefined && item.parentId !== selector.parentId) continue;
    if (selector.section !== undefined && item.section !== selector.section) continue;
    if (selector.role !== undefined && item.role !== selector.role) continue;
    const rowPeriods = hasExplicitCells
      ? selectedPeriods.filter((period) => explicitCells.has(cellKey(item.id, period.id))) : selectedPeriods;
    if (hasExplicitCells && rowPeriods.length === 0) continue;
    if (item.section.startsWith("source_")) rows.push(buildSourceRow(snapshot, item.id, rowPeriods));
    else rows.push(buildDcfRow(snapshot, item.id, rowPeriods));
  }
  const base: WorkbookSliceView = {
    modelId, revision, periods: structuredClone(selectedPeriods), rows, includeLineage,
  };
  if (!includeLineage) return base;
  const selectedCells = new Set<string>();
  for (const row of rows) {
    const id = "lineItemId" in row ? row.lineItemId : row.sourceLineItemId;
    for (const periodId of Object.keys(row.cells)) selectedCells.add(cellKey(id, periodId));
  }
  const facts = snapshot.facts.filter((fact) => fact.lineItemId !== undefined
    && selectedCells.has(cellKey(fact.lineItemId, fact.periodId)));
  const factIds = new Set(facts.map((fact) => fact.factId));
  const selectedLineItems = new Set(rows.map((row) => "lineItemId" in row ? row.lineItemId : row.sourceLineItemId));
  return { ...base, lineage: {
    facts: structuredClone(facts),
    factReviewDecisions: structuredClone(snapshot.factReviewDecisions.filter((decision) => factIds.has(decision.factId))),
  } };
}

export function buildModelContextView(
  meta: ModelView,
  headers: RevisionHeader<RevisionChangeSummary>[],
  current: Revision<FinancialModelSnapshot, RevisionChangeSummary>,
  /** Forwarded to the workbook builder. The only caller that passes anything is
   *  the HTTP read path, which asks for the source statements unconditionally:
   *  a reader wants the three as-filed statements available at any lifecycle
   *  stage, not only while the spine is still unmapped. The agent's own reads
   *  leave this empty and keep the narrower, cheaper view. */
  options: WorkbookViewOptions = {},
): ModelContextView {
  if (headers.length === 0 || current.modelId !== meta.modelId || current.revision !== meta.currentRevision) {
    queryError("model context current revision is inconsistent");
  }
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    if (header.modelId !== meta.modelId || header.revision !== index
      || header.parentRevision !== (index === 0 ? null : index - 1)) queryError("revision headers must be contiguous and ordered");
    validateHeader(header);
    validateSummary(header.changeSummary, current.snapshot);
  }
  const last = headers.at(-1)!;
  if (last.revision !== current.revision || headers.filter((header) => header.revision === current.revision).length !== 1) {
    queryError("revision headers must end at the current revision exactly once");
  }
  if (current.parentRevision !== last.parentRevision
    || current.lifecycleStage !== last.lifecycleStage
    || current.engineVersion !== last.engineVersion
    || current.creatingSessionId !== last.creatingSessionId
    || current.createdAt !== last.createdAt
    || JSON.stringify(current.changeSummary) !== JSON.stringify(last.changeSummary)
    || current.snapshot.lifecycleStage !== current.lifecycleStage
    || current.snapshot.engineVersion !== current.engineVersion
    || meta.lifecycleStage !== current.lifecycleStage
    || meta.updatedAt !== current.createdAt) {
    queryError("current revision, snapshot, header, and model metadata are inconsistent");
  }
  return {
    model: structuredClone(meta),
    revisionHistory: headers.slice(0, -1).map(toRevisionSummary),
    currentWorkbook: buildWorkbookView(current.modelId, current.revision, current.snapshot, options),
  };
}

function orderedItems(snapshot: FinancialModelSnapshot): FinancialModelSnapshot["lineItems"] {
  return [...snapshot.lineItems].sort((a, b) => a.order - b.order || compareText(a.id, b.id));
}

function buildDcfRow(snapshot: FinancialModelSnapshot, id: string, periods = snapshot.periods): WorkbookRowView {
  const item = snapshot.lineItems.find((row) => row.id === id)!;
  const selectedPeriodIds = new Set(periods.map((period) => period.id));
  const periodPosition = new Map(snapshot.periods.map((period, index) => [period.id, index]));
  const formulas = snapshot.formulas.map((formula, definitionIndex) => ({ formula, definitionIndex }))
    .filter(({ formula }) => formula.lineItemId === id
      && coverage(snapshot, formula.appliesTo, formula.periodIds).some((periodId) => selectedPeriodIds.has(periodId)))
    .sort((left, right) => {
      const leftCoverage = coverage(snapshot, left.formula.appliesTo, left.formula.periodIds);
      const rightCoverage = coverage(snapshot, right.formula.appliesTo, right.formula.periodIds);
      return (periodPosition.get(leftCoverage[0] ?? "") ?? Number.MAX_SAFE_INTEGER)
        - (periodPosition.get(rightCoverage[0] ?? "") ?? Number.MAX_SAFE_INTEGER)
        || compareText(left.formula.source, right.formula.source);
    });
  const assumptions = snapshot.assumptions
    .filter((assumption) => assumption.lineItemId === id
      && assumption.periods.some((periodId) => selectedPeriodIds.has(periodId)))
    .sort((left, right) => (periodPosition.get(left.periods[0] ?? "") ?? Number.MAX_SAFE_INTEGER)
      - (periodPosition.get(right.periods[0] ?? "") ?? Number.MAX_SAFE_INTEGER)
      || compareText(left.assumptionId, right.assumptionId));
  const result: WorkbookRowView = {
    lineItemId: item.id, label: item.label, section: item.section as DcfWorkbookSection,
    role: item.role, unit: structuredClone(item.unit), order: item.order,
    sources: { historical: item.historical, forecast: item.forecast },
    formulas: formulas.map(({ formula }) => ({ appliesTo: formula.appliesTo,
      periodIds: formula.periodIds === undefined
        ? periodsForClass(snapshot, formula.appliesTo)
        : orderedPeriodIds(snapshot, formula.periodIds), source: formula.source })),
    assumptions: structuredClone(assumptions.map((assumption) => ({
      ...assumption,
      periods: orderedPeriodIds(snapshot, assumption.periods),
    }))),
    cells: buildCells(snapshot, id, periods),
  };
  if (item.parentId !== undefined) result.parentId = item.parentId;
  if (item.description !== undefined) result.description = item.description;
  return result;
}

function buildSourceRow(snapshot: FinancialModelSnapshot, id: string, periods = snapshot.periods): SourceStatementRowView {
  const item = snapshot.lineItems.find((row) => row.id === id)!;
  return { sourceLineItemId: id, label: item.label, unit: structuredClone(item.unit), cells: buildCells(snapshot, id, periods) };
}

function buildSourceReview(
  snapshot: FinancialModelSnapshot,
  unifiedStatements?: UnifiedStatementsArtifact,
): SourceStatementReviewView {
  if (unifiedStatements) return buildUnifiedSourceReview(snapshot, unifiedStatements);
  const sheet = (section: string) => orderedItems(snapshot)
    .filter((row) => row.section === section)
    .map((row) => buildSourceRow(snapshot, row.id, snapshot.periods));
  return {
    selectedPeriodIds: orderedPeriodIds(snapshot, snapshot.selectedHistoricalPeriodIds),
    sheets: {
      income_statement: sheet("source_income_statement"), balance_sheet: sheet("source_balance_sheet"),
      cash_flow_statement: sheet("source_cash_flow"),
    },
    reconciliations: structuredClone(snapshot.reconciliationResults),
  };
}

/**
 * statement_unification preserves the issuer's full face-statement structure
 * outside the DCF snapshot.  The browser should read those unified rows — not
 * the smaller, pre-unification staging list — once they exist.  Each value is
 * still tied to its materialized unified fact, so the regular cell-inspector
 * provenance continues to work without giving the UI a second data model.
 */
function buildUnifiedSourceReview(
  snapshot: FinancialModelSnapshot,
  unified: UnifiedStatementsArtifact,
): SourceStatementReviewView {
  const availablePeriods = new Set(unified.periods);
  const selectedPeriodIds = snapshot.periods
    .filter((period) => period.cls !== "forecast" && availablePeriods.has(period.id))
    .map((period) => period.id);
  const factByCell = new Map<string, FinancialModelSnapshot["facts"][number]>();
  for (const fact of unified.facts) {
    if (fact.lineItemId !== undefined) factByCell.set(cellKey(fact.lineItemId, fact.periodId), fact);
  }
  const sheets: SourceStatementReviewView["sheets"] = {
    income_statement: [], balance_sheet: [], cash_flow_statement: [],
  };

  for (const row of unified.rows) {
    const sourceLineItemId = `unified.${row.statement}.${row.rowId}`;
    const unit = unified.facts.find((fact) => fact.lineItemId === sourceLineItemId)?.unit ?? { kind: "number" as const };
    sheets[row.statement].push({
      sourceLineItemId,
      label: row.label,
      unit: structuredClone(unit),
      cells: Object.fromEntries(selectedPeriodIds.map((periodId) => {
        const value = row.values[periodId] ?? null;
        const fact = factByCell.get(cellKey(sourceLineItemId, periodId));
        return [periodId, {
          value,
          status: value === null ? "not_applicable" as const : "ok" as const,
          source: fact ? { kind: "fact" as const, factId: fact.factId } : { kind: "none" as const },
          diagnostics: [],
          dependencies: [],
        }];
      })),
    });
  }
  return { selectedPeriodIds, sheets, reconciliations: structuredClone(snapshot.reconciliationResults) };
}

function buildCells(snapshot: FinancialModelSnapshot, lineItemId: string, periods: readonly Period[]): Record<string, WorkbookCellView> {
  const item = snapshot.lineItems.find((row) => row.id === lineItemId)!;
  const items = new Map(snapshot.lineItems.map((candidate) => [candidate.id, candidate]));
  const graph: GraphContext = {
    grid: buildGrid(snapshot.periods), valuationAnchorPeriodId: snapshot.valuationConfig.anchorPeriodId,
    rankOf: (id) => items.get(id)?.order ?? Number.MAX_SAFE_INTEGER,
  };
  const cells: Record<string, WorkbookCellView> = {};
  for (const period of periods) {
    const source = period.cls === "forecast" ? item.forecast : item.historical;
    const key = cellKey(lineItemId, period.id);
    const cell = snapshot.cells.get(key);
    if (source === "none") {
      cells[period.id] = { value: null, status: "not_modeled", source: { kind: "none" }, diagnostics: [], dependencies: [] };
      continue;
    }
    const diagnostics = structuredClone(cell?.diagnostics ?? [{ code: "missing_input" as const, refs: [key] }]);
    cells[period.id] = {
      value: cell?.value ?? null, status: cellStatus(cell?.value ?? null, diagnostics),
      source: cellSource(snapshot, lineItemId, period.id, source), diagnostics,
      dependencies: formulaDependencies(snapshot, lineItemId, period.id, source, graph),
    };
  }
  return cells;
}

function formulaDependencies(
  snapshot: FinancialModelSnapshot,
  lineItemId: string,
  periodId: string,
  source: CellSource,
  graph: GraphContext,
): WorkbookCellDependency[] {
  if (source !== "formula") return [];
  const formula = snapshot.compiledFormulas.find((candidate) =>
    candidate.lineItemId === lineItemId
    && coverage(snapshot, candidate.appliesTo, candidate.periodIds).includes(periodId));
  if (!formula) return [];
  return [...new Set(dependenciesOf(formula.ast, lineItemId, periodId, graph))]
    .map(splitCellKey)
    .map(({ lineItemId: dependencyId, periodId: dependencyPeriodId }) => ({
      lineItemId: dependencyId, periodId: dependencyPeriodId,
    }));
}

function cellSource(snapshot: FinancialModelSnapshot, lineItemId: string, periodId: string, source: CellSource): WorkbookCellSource {
  const assumption = snapshot.assumptions.find((candidate) =>
    candidate.lineItemId === lineItemId && candidate.periods.includes(periodId));
  if (assumption?.payload.kind === "not_applicable") {
    return { kind: "assumption", assumptionId: assumption.assumptionId };
  }
  if (source === "actual") {
    const fact = snapshot.facts.find((candidate) => candidate.status === "committed"
      && candidate.lineItemId === lineItemId && candidate.periodId === periodId);
    return fact ? { kind: "fact", factId: fact.factId } : { kind: "none" };
  }
  if (source === "assumption") {
    return assumption ? { kind: "assumption", assumptionId: assumption.assumptionId } : { kind: "none" };
  }
  if (source === "formula") {
    const index = snapshot.formulas.findIndex((formula) => formula.lineItemId === lineItemId
      && coverage(snapshot, formula.appliesTo, formula.periodIds).includes(periodId));
    return index >= 0 ? { kind: "formula", definitionIndex: index } : { kind: "none" };
  }
  if (source === "calculated") return { kind: "calculated", output: lineItemId };
  return { kind: "none" };
}

function cellStatus(value: number | null, diagnostics: Diagnostic[]): WorkbookCellStatus {
  if (value !== null) return "ok";
  if (diagnostics.some((diagnostic) => diagnostic.code === "not_applicable")) return "not_applicable";
  if (diagnostics.some((diagnostic) => diagnostic.code === "divide_by_zero")) return "divide_by_zero";
  return "missing_input";
}

function periodsForClass(snapshot: FinancialModelSnapshot, appliesTo: "historical" | "forecast"): string[] {
  return snapshot.periods.filter((period) => (appliesTo === "forecast") === (period.cls === "forecast")).map((period) => period.id);
}

function coverage(snapshot: FinancialModelSnapshot, appliesTo: "historical" | "forecast", periodIds: readonly string[] | undefined): string[] {
  return periodIds === undefined ? periodsForClass(snapshot, appliesTo) : [...periodIds];
}

function validateSelector(snapshot: FinancialModelSnapshot, selector: ModelSelector): void {
  const itemIds = new Set(snapshot.lineItems.map((item) => item.id));
  const periodIds = new Set(snapshot.periods.map((period) => period.id));
  for (const id of selector.lineItemIds ?? []) if (!itemIds.has(id)) queryError(`unknown line item: ${id}`);
  for (const id of selector.periodIds ?? []) if (!periodIds.has(id)) queryError(`unknown period: ${id}`);
  for (const ref of selector.cellRefs ?? []) {
    if (!itemIds.has(ref.lineItemId)) queryError(`unknown line item: ${ref.lineItemId}`);
    if (!periodIds.has(ref.periodId)) queryError(`unknown period: ${ref.periodId}`);
  }
  if (selector.parentId !== undefined && !itemIds.has(selector.parentId)) {
    queryError(`unknown parent line item: ${selector.parentId}`);
  }
  const sections = new Set<string>(MODEL_READ_SECTIONS);
  if (selector.section !== undefined && !sections.has(selector.section)) {
    queryError(`unknown section: ${String(selector.section)} (one of: ${MODEL_READ_SECTIONS.join(", ")})`);
  }
  // Exact row/cell names are promises, not exploratory filters.  A contradictory structural
  // filter used to return an apparently successful empty slice, which leaves an agent unable to
  // distinguish a typo from a row it should read from another scope.
  // `cellRefs` deliberately compose as coordinates: callers can provide a handful of candidate
  // cells and then narrow them with periods or a role.  Only named *rows* promise a row match.
  const requestedIds = [...new Set(selector.lineItemIds ?? [])];
  const requestedItems = requestedIds.map((id) => snapshot.lineItems.find((item) => item.id === id)!);
  if (selector.section !== undefined) {
    const mismatches = requestedItems.filter((item) => item.section !== selector.section)
      .map((item) => `${item.id} (section ${item.section})`);
    if (mismatches.length > 0) queryError(`requested row(s) are outside section ${selector.section}: ${mismatches.join(", ")}. `
      + "Read their named section(s), or omit section when reading rows across sections.");
  }
  if (selector.parentId !== undefined) {
    const mismatches = requestedItems.filter((item) => item.parentId !== selector.parentId)
      .map((item) => `${item.id} (parent ${item.parentId ?? "none"})`);
    if (mismatches.length > 0) queryError(`requested row(s) are not children of ${selector.parentId}: ${mismatches.join(", ")}. `
      + "Read those rows without parentId, or use their actual parent.");
  }
  if (selector.role !== undefined) {
    const mismatches = requestedItems.filter((item) => item.role !== selector.role)
      .map((item) => `${item.id} (role ${item.role})`);
    if (mismatches.length > 0) queryError(`requested row(s) do not have role ${selector.role}: ${mismatches.join(", ")}. `
      + "Read those rows without role, or use their actual role.");
  }
  if (selector.periodClass !== undefined) {
    const requestedPeriodIds = [...new Set(selector.periodIds ?? [])];
    const mismatches = requestedPeriodIds.flatMap((id) => {
      const period = snapshot.periods.find((candidate) => candidate.id === id)!;
      return period.cls !== selector.periodClass ? [`${id} (${period.cls})`] : [];
    });
    if (mismatches.length > 0) queryError(`requested period(s) are outside periodClass ${selector.periodClass}: ${mismatches.join(", ")}. `
      + "Use their actual period class, or omit periodClass.");
  }
  const roles = new Set(snapshot.lineItems.map((item) => item.role));
  if (selector.role !== undefined && !roles.has(selector.role)) queryError(`unknown role: ${String(selector.role)}`);
  if (selector.periodClass !== undefined && !new Set(["actual", "ttm", "forecast"]).has(selector.periodClass)) {
    queryError(`unknown period class: ${String(selector.periodClass)}`);
  }
}

function validateSummary(summary: RevisionChangeSummary, snapshot: FinancialModelSnapshot): void {
  if (!Array.isArray(summary.changes) || !Array.isArray(summary.changedSections)
    || !Number.isInteger(summary.warningCount) || summary.warningCount < 0 || summary.blockerCount !== 0) {
    queryError("malformed revision change summary");
  }
  const validKinds = new Set([
    "model_created", "statements_staged",
    "fact_replaced", "assumption_set",
    "line_item_source_set", "line_item_added", "metric_added", "formula_set",
    "category_group_set", "valuation_config_set",
    "stage_advanced", "archived", "wacc_sheet_refreshed", "wacc_input_set",
  ]);
  const sections = [
    "history", "metrics", "revenue", "operations", "dcf",
    "source_income_statement", "source_balance_sheet", "source_cash_flow",
  ];
  assertOrderedUnique(summary.changedSections, sections, "changed sections");
  const lineOrder = [...orderedItems(snapshot).map((item) => item.id)];
  const periodOrder = snapshot.periods.map((period) => period.id);
  for (const change of summary.changes) {
    if (!validKinds.has(change.kind)) queryError(`unknown revision change kind: ${String(change.kind)}`);
    const record = change as unknown as Record<string, unknown>;
    if (Array.isArray(record.periodIds)) assertOrderedUnique(record.periodIds, periodOrder, `${change.kind} periodIds`);
    for (const key of ["mappedLineItemIds", "lineItemIds"] as const) {
      if (Array.isArray(record[key])) assertOrderedUnique(record[key], lineOrder, `${change.kind} ${key}`);
    }
    validateChange(change, snapshot);
  }
}

function validateHeader(header: RevisionHeader<RevisionChangeSummary>): void {
  const lifecycleStages = new Set<LifecycleStage>([
    "draft", "history_committed", "revenue_forecast", "operations_fcff", "valued", "archived",
  ]);
  if (header.engineVersion.trim().length === 0
    || header.creatingSessionId.trim().length === 0
    || !Number.isFinite(Date.parse(header.createdAt))
    || !lifecycleStages.has(header.lifecycleStage)) {
    queryError("malformed revision header metadata");
  }
}

function toRevisionSummary(header: RevisionHeader<RevisionChangeSummary>): RevisionSummary {
  return { ...structuredClone(header.changeSummary), revision: header.revision, parentRevision: header.parentRevision,
    lifecycleStage: header.lifecycleStage, engineVersion: header.engineVersion,
    creatingSessionId: header.creatingSessionId, createdAt: header.createdAt };
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function queryError(message: string): never { throw new FinancialModelError("invalid_model_query", message); }

function itemOrder(snapshot: FinancialModelSnapshot, id: string): number {
  return snapshot.lineItems.find((item) => item.id === id)?.order ?? Number.MAX_SAFE_INTEGER;
}

function firstPeriodPosition(snapshot: FinancialModelSnapshot, ids: readonly string[]): number {
  const position = new Map(snapshot.periods.map((period, index) => [period.id, index]));
  return ids.reduce((first, id) => Math.min(first, position.get(id) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
}

function orderedPeriodIds(snapshot: FinancialModelSnapshot, ids: readonly string[]): string[] {
  const position = new Map(snapshot.periods.map((period, index) => [period.id, index]));
  return [...new Set(ids)].sort((left, right) =>
    (position.get(left) ?? Number.MAX_SAFE_INTEGER) - (position.get(right) ?? Number.MAX_SAFE_INTEGER));
}

function assertOrderedUnique(values: unknown[], authoritative: readonly string[], label: string): void {
  const position = new Map(authoritative.map((value, index) => [value, index]));
  let previous = -1;
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !position.has(value) || seen.has(value)) queryError(`invalid ${label}`);
    const current = position.get(value)!;
    if (current < previous) queryError(`unordered ${label}`);
    previous = current;
    seen.add(value);
  }
}

function validateChange(change: RevisionChange, snapshot: FinancialModelSnapshot): void {
  const lineIds = new Set(snapshot.lineItems.map((item) => item.id));
  const periodIds = new Set(snapshot.periods.map((period) => period.id));
  const nonNegativeInteger = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;
  const validLine = (value: unknown): boolean => typeof value === "string" && lineIds.has(value);
  const validPeriod = (value: unknown): boolean => typeof value === "string" && periodIds.has(value);
  const validPeriodArray = (value: unknown): boolean => Array.isArray(value)
    && value.every((entry) => validPeriod(entry));
  const validLineArray = (value: unknown): boolean => Array.isArray(value)
    && value.every((entry) => validLine(entry));
  switch (change.kind) {
    case "model_created":
    case "valuation_config_set":
    case "archived":
      return;
    case "statements_staged":
      if (!nonNegativeInteger(change.rowCount)
        || !nonNegativeInteger(change.candidateCount)
        || !validLineArray(change.mappedLineItemIds)
        || !validPeriodArray(change.periodIds)) queryError("malformed statements_staged change");
      return;
    case "fact_replaced":
      if (!validLine(change.lineItemId) || !validPeriod(change.periodId)) queryError("malformed fact_replaced change");
      return;
    case "assumption_set":
      if (!validLine(change.lineItemId) || !validPeriodArray(change.periodIds)) queryError("malformed assumption_set change");
      return;
    case "line_item_source_set":
      if (!validLine(change.lineItemId)
        || !new Set(["historical", "forecast"]).has(change.range)
        || !new Set(["actual", "assumption", "formula", "none"]).has(change.source)) {
        queryError("malformed line_item_source_set change");
      }
      return;
    case "line_item_added":
      if (!validLine(change.lineItemId)
        || (change.parentId !== undefined && !lineIds.has(change.parentId))) {
        queryError("malformed line_item_added change");
      }
      return;
    case "metric_added":
      if (change.registryId !== "cagr" || !validLine(change.lineItemId)) queryError("malformed metric_added change");
      return;
    case "formula_set":
      if (!validLine(change.lineItemId)
        || !new Set(["historical", "forecast"]).has(change.appliesTo)
        || !validPeriodArray(change.periodIds)) queryError("malformed formula_set change");
      return;
    case "category_group_set":
      if (!validLine(change.parentLineItemId)
        || change.category.trim().length === 0
        || !validPeriodArray(change.periodIds)) {
        queryError("malformed category_group_set change");
      }
      return;
    case "stage_advanced":
      if (!new Set(["draft", "history_committed", "revenue_forecast", "operations_fcff", "valued", "archived"]).has(change.from)
        || !new Set(["draft", "history_committed", "revenue_forecast", "operations_fcff", "valued", "archived"]).has(change.to)) {
        queryError("malformed stage_advanced change");
      }
      return;
    case "wacc_sheet_refreshed":
      if (!Array.isArray(change.rowIds) || change.rowIds.length === 0
        || !change.rowIds.every((id) => typeof id === "string" && ALL_WACC_ROW_IDS.has(id))
        || new Set(change.rowIds).size !== change.rowIds.length) {
        queryError("malformed wacc_sheet_refreshed change");
      }
      return;
    case "wacc_input_set":
      if (typeof change.rowId !== "string" || !WACC_SHEET_ROW_IDS.includes(change.rowId as WaccSheetRowId)) {
        queryError("malformed wacc_input_set change");
      }
      return;
  }
}
