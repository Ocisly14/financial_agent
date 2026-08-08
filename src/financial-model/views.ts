import { cellKey, type CellKey } from "./dsl/graph.ts";
import { FinancialModelError } from "./errors.ts";
import type { FinancialModelSnapshot, ModelSelector } from "./operations.ts";
import type { ModelView, Revision, RevisionHeader } from "./store.ts";
import type { ValuationOutput } from "./valuation.ts";
import type {
  Assumption, CellSource, DcfCategoryGroup, Diagnostic, LifecycleStage, LineItemRole, Period,
  ReconciliationResult, StatementMappingPlan, Unit, ValuationConfig,
} from "./types.ts";
import type { JsonObject } from "../framework/types.ts";

export type DcfWorkbookSection = "history" | "metrics" | "revenue" | "operations" | "dcf";
export type ModelReadSection = DcfWorkbookSection |
  "source_income_statement" | "source_balance_sheet" | "source_cash_flow";

export type RevisionChange =
  | { kind: "model_created" }
  | { kind: "statements_staged"; rowCount: number; candidateCount: number; mappedLineItemIds: string[]; periodIds: string[] }
  | { kind: "facts_staged"; candidateCount: number; mappedLineItemIds: string[]; periodIds: string[] }
  | { kind: "facts_reviewed"; committed: number; rejected: number; superseded: number; lineItemIds: string[]; periodIds: string[] }
  | { kind: "fact_replaced"; lineItemId: string; periodId: string }
  | { kind: "assumption_set"; lineItemId: string; periodIds: string[] }
  | { kind: "line_item_source_set"; lineItemId: string; range: "historical" | "forecast"; source: "actual" | "assumption" | "formula" | "none" }
  | { kind: "line_item_added"; lineItemId: string; parentId?: string }
  | { kind: "metric_added"; registryId: "cagr"; lineItemId: string }
  | { kind: "formula_set"; lineItemId: string; appliesTo: "historical" | "forecast"; periodIds: string[] }
  | { kind: "statement_mapping_plan_set"; targetLineItemId: string; periodIds: string[] }
  | { kind: "category_group_set"; parentLineItemId: string; category: string; periodIds: string[] }
  | { kind: "valuation_config_set" }
  | { kind: "stage_advanced"; from: LifecycleStage; to: LifecycleStage }
  | { kind: "archived" };

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
export type WorkbookCellView = { value: number | null; status: WorkbookCellStatus; source: WorkbookCellSource; diagnostics: Diagnostic[] };

export type WorkbookRowView = {
  lineItemId: string; label: string; parentId?: string; section: DcfWorkbookSection;
  role: LineItemRole; unit: Unit; order: number;
  sources: { historical: CellSource; forecast: CellSource };
  mappingRefs: Array<{ periodIds: string[]; sourceLineItemIds: string[] }>;
  formulas: Array<{ appliesTo: "historical" | "forecast"; periodIds: string[]; source: string }>;
  assumptions: Assumption[];
  cells: Record<string, WorkbookCellView>;
  description?: string;
};

export type SourceStatementRowView = { sourceLineItemId: string; label: string; unit: Unit; cells: Record<string, WorkbookCellView> };
export type SourceStatementReviewView = {
  selectedPeriodIds: string[];
  sheets: Record<"income_statement" | "balance_sheet" | "cash_flow_statement", SourceStatementRowView[]>;
  activeMappings: StatementMappingPlan[];
  proposedMappings: Array<Omit<StatementMappingPlan, "reviewDecisionId">>;
  diagnostics: Diagnostic[];
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
    statementMappingPlans: StatementMappingPlan[];
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

export type WorkbookViewOptions = { includeSourceStatements?: boolean };

const DCF_SECTIONS: readonly DcfWorkbookSection[] = ["history", "metrics", "revenue", "operations", "dcf"];

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
  };
  const mappingMode = options.includeSourceStatements === true
    || snapshot.statementMappingPlans.length === 0
    || snapshot.selectedHistoricalPeriodIds.length === 0
    || snapshot.mappingException !== null;
  if (!mappingMode) return { ...base, mode: "dcf" };
  const limitToException = options.includeSourceStatements !== true
    && snapshot.statementMappingPlans.length > 0
    && snapshot.selectedHistoricalPeriodIds.length > 0
    && snapshot.mappingException !== null;
  return {
    ...base,
    mode: "statement_mapping",
    sourceStatementReview: buildSourceReview(snapshot, limitToException),
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
    statementMappingPlans: structuredClone(snapshot.statementMappingPlans.filter((plan) =>
      selectedLineItems.has(plan.targetLineItemId)
      || plan.members.some((member) => selectedLineItems.has(member.sourceLineItemId)))),
  } };
}

export function buildModelContextView(
  meta: ModelView,
  headers: RevisionHeader<RevisionChangeSummary>[],
  current: Revision<FinancialModelSnapshot, RevisionChangeSummary>,
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
    currentWorkbook: buildWorkbookView(current.modelId, current.revision, current.snapshot),
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
  const mappingPlans = snapshot.statementMappingPlans
    .filter((plan) => plan.targetLineItemId === id
      && plan.periodIds.some((periodId) => selectedPeriodIds.has(periodId)))
    .sort((left, right) => (periodPosition.get(left.periodIds[0] ?? "") ?? Number.MAX_SAFE_INTEGER)
      - (periodPosition.get(right.periodIds[0] ?? "") ?? Number.MAX_SAFE_INTEGER));
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
    mappingRefs: mappingPlans.map((plan) => ({
      periodIds: orderedPeriodIds(snapshot, plan.periodIds),
      sourceLineItemIds: plan.members.filter((member) => member.treatment !== "exclude")
        .map((member) => member.sourceLineItemId)
        .sort((left, right) => itemOrder(snapshot, left) - itemOrder(snapshot, right) || compareText(left, right)),
    })),
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

function buildSourceReview(snapshot: FinancialModelSnapshot, limitToException: boolean): SourceStatementReviewView {
  const exceptionIds = new Set(limitToException ? snapshot.mappingException?.sourceLineItemIds ?? [] : []);
  const exceptionPeriods = new Set(limitToException ? snapshot.mappingException?.periodIds ?? [] : []);
  const displayedPeriods = limitToException
    ? snapshot.periods.filter((period) => exceptionPeriods.has(period.id))
    : snapshot.periods;
  const sheet = (section: string) => orderedItems(snapshot).filter((row) =>
    row.section === section && (!limitToException || exceptionIds.has(row.id)))
    .map((row) => buildSourceRow(snapshot, row.id, displayedPeriods));
  return {
    selectedPeriodIds: limitToException
      ? orderedPeriodIds(snapshot, snapshot.mappingException?.periodIds ?? [])
      : orderedPeriodIds(snapshot, snapshot.selectedHistoricalPeriodIds),
    sheets: {
      income_statement: sheet("source_income_statement"), balance_sheet: sheet("source_balance_sheet"),
      cash_flow_statement: sheet("source_cash_flow"),
    },
    activeMappings: structuredClone(snapshot.statementMappingPlans
      .filter((plan) => !limitToException
        || plan.members.some((member) => exceptionIds.has(member.sourceLineItemId)))
      .sort((left, right) => firstPeriodPosition(snapshot, left.periodIds) - firstPeriodPosition(snapshot, right.periodIds)
        || compareText(left.targetLineItemId, right.targetLineItemId))),
    proposedMappings: structuredClone(snapshot.proposedStatementMappings
      .filter((plan) => !limitToException
        || plan.members.some((member) => exceptionIds.has(member.sourceLineItemId)))
      .sort((left, right) => firstPeriodPosition(snapshot, left.periodIds) - firstPeriodPosition(snapshot, right.periodIds)
        || compareText(left.targetLineItemId, right.targetLineItemId))),
    diagnostics: structuredClone(snapshot.mappingDiagnostics),
    reconciliations: structuredClone(snapshot.reconciliationResults),
  };
}

function buildCells(snapshot: FinancialModelSnapshot, lineItemId: string, periods: readonly Period[]): Record<string, WorkbookCellView> {
  const item = snapshot.lineItems.find((row) => row.id === lineItemId)!;
  const cells: Record<string, WorkbookCellView> = {};
  for (const period of periods) {
    const source = period.cls === "forecast" ? item.forecast : item.historical;
    const key = cellKey(lineItemId, period.id);
    const cell = snapshot.cells.get(key);
    if (source === "none") {
      cells[period.id] = { value: null, status: "not_modeled", source: { kind: "none" }, diagnostics: [] };
      continue;
    }
    const diagnostics = structuredClone(cell?.diagnostics ?? [{ code: "missing_input" as const, refs: [key] }]);
    cells[period.id] = {
      value: cell?.value ?? null, status: cellStatus(cell?.value ?? null, diagnostics),
      source: cellSource(snapshot, lineItemId, period.id, source), diagnostics,
    };
  }
  return cells;
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
  const sections = new Set<ModelReadSection>([
    "history", "metrics", "revenue", "operations", "dcf",
    "source_income_statement", "source_balance_sheet", "source_cash_flow",
  ]);
  if (selector.section !== undefined && !sections.has(selector.section)) queryError(`unknown section: ${String(selector.section)}`);
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
    "model_created", "statements_staged", "facts_staged", "facts_reviewed",
    "fact_replaced", "assumption_set",
    "line_item_source_set", "line_item_added", "metric_added", "formula_set",
    "statement_mapping_plan_set", "category_group_set", "valuation_config_set",
    "stage_advanced", "archived",
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
    case "facts_staged":
      if (!nonNegativeInteger(change.candidateCount)
        || !validLineArray(change.mappedLineItemIds)
        || !validPeriodArray(change.periodIds)) queryError("malformed facts_staged change");
      return;
    case "facts_reviewed":
      if (![change.committed, change.rejected, change.superseded].every(nonNegativeInteger)
        || !validLineArray(change.lineItemIds)
        || !validPeriodArray(change.periodIds)) queryError("malformed facts_reviewed change");
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
    case "statement_mapping_plan_set":
      if (!validLine(change.targetLineItemId) || !validPeriodArray(change.periodIds)) {
        queryError("malformed statement_mapping_plan_set change");
      }
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
  }
}
