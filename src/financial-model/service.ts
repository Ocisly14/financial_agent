import { cellKey, splitCellKey, type CellKey } from "./dsl/graph.ts";
import { parseFormula } from "./dsl/parser.ts";
import { ENGINE_VERSION, evaluate } from "./engine.ts";
import { FinancialModelError } from "./errors.ts";
import { applyFactReview, resolveActiveFacts, stageFacts as stageFactCandidates } from "./factLifecycle.ts";
import { installDefaultMetrics } from "./metrics.ts";
import {
  applyModelOperations,
  type FinancialModelSnapshot,
  type MappingException,
  type ModelOperation,
  type ModelQuery,
} from "./operations.ts";
import { buildGrid } from "./periodGrid.ts";
import { reconcileDcf } from "./reconciliation.ts";
import {
  addSourceStatementRows,
  addDcfDetailLineItem,
  addRevenueStream,
  applyDcfCategoryGroups,
  applyStatementMappingPlans,
  createSkeleton,
  validateRoleCardinality,
  type Skeleton,
} from "./skeleton.ts";
import type {
  ModelFilter,
  ModelStore,
  ModelView,
  NewModelMeta,
  Revision,
  RevisionHeader,
} from "./store.ts";
import type {
  Diagnostic,
  DcfCategoryGroup,
  Fact,
  FactReviewDecision,
  LifecycleStage,
  NewDcfCategoryLineItem,
  Period,
  PreparedStatementRow,
  StatementMappingPlan,
  ValuationConfig,
} from "./types.ts";
import { calculateValuation, validateValuationConfig } from "./valuation.ts";
import type { JsonObject } from "../framework/types.ts";
import {
  buildModelContextView,
  buildWorkbookSlice,
  buildWorkbookView,
  type CurrentWorkbookView,
  type HistoricalDcfCompletenessView,
  type ModelContextView,
  type ModelReadSection,
  type RevisionChange,
  type RevisionChangeSummary,
  type RevisionSummary,
  type WorkbookSliceView,
} from "./views.ts";

export type {
  CurrentWorkbookView,
  ModelContextView,
  ModelReadSection,
  RevisionChange,
  RevisionChangeSummary,
  RevisionSummary,
  WorkbookSliceView,
  HistoricalDcfCompletenessView,
} from "./views.ts";

export type CreateModelInput = NewModelMeta & {
  reportingCurrency: string;
  periods: Period[];
  preparedStatementRows: PreparedStatementRow[];
  valuationConfig?: ValuationConfig;
};

export type StageSpineFactsInput = {
  /** Canonical spine and detail facts from `buildSpineFromUnified`, all still `staged`. */
  facts: readonly Fact[];
  historicalPeriodIds: readonly string[];
  /** Display labels for detail line items this call has to install, keyed by line item id. */
  labels?: Readonly<Record<string, string>>;
};

export type ReviewFactsInput = {
  decisions: FactReviewDecision[];
  selectedHistoricalPeriodIds: string[];
  categoryLineItems: NewDcfCategoryLineItem[];
  statementMappingPlans: StatementMappingPlan[];
  categoryGroups: DcfCategoryGroup[];
};

export type CommitResult = {
  modelId: string;
  revision: number;
  status: LifecycleStage;
  revisionSummary: RevisionSummary;
  currentWorkbook: CurrentWorkbookView;
  warnings: Diagnostic[];
};

export type ViewOptions = {
  revision?: number;
  section?: ModelReadSection;
  selector?: ModelQuery["selector"];
  includeLineage?: boolean;
  reopenSources?: boolean;
};

const SECTION_ORDER: readonly ModelReadSection[] = [
  "history",
  "metrics",
  "revenue",
  "operations",
  "dcf",
  "source_income_statement",
  "source_balance_sheet",
  "source_cash_flow",
];

const STAGE_ORDER: readonly LifecycleStage[] = [
  "draft",
  "history_committed",
  "revenue_forecast",
  "operations_fcff",
  "valued",
  "archived",
];

export class FinancialModelService {
  private readonly store: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>;
  private readonly creatingSessionId: string;

  constructor(
    store: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>,
    creatingSessionId = "financial-model-service",
  ) {
    this.store = store;
    this.creatingSessionId = creatingSessionId;
  }

  createModel(input: CreateModelInput): CommitResult {
    const grid = buildGrid(input.periods);
    if (input.reportingCurrency.trim().length === 0) {
      throw new FinancialModelError("invalid_snapshot", "reporting currency must not be empty");
    }
    let skeleton = createSkeleton({ currency: input.reportingCurrency, periods: grid.all });
    skeleton = addSourceStatementRows(skeleton, input.preparedStatementRows);
    skeleton = installDefaultMetrics(skeleton, input.periods);
    const snapshot: FinancialModelSnapshot = {
      filingInsightSetId: null,
      lifecycleStage: "draft",
      periods: structuredClone(input.periods),
      lineItems: skeleton.lineItems,
      facts: [],
      factReviewDecisions: [],
      assumptions: [],
      formulas: skeleton.formulas,
      compiledFormulas: [],
      selectedHistoricalPeriodIds: [],
      statementMappingPlans: [],
      categoryGroups: [],
      proposedStatementMappings: [],
      valuationConfig: input.valuationConfig === undefined
        ? defaultValuationConfig(input.periods)
        : validateValuationConfig(input.valuationConfig),
      cells: new Map(),
      diagnostics: [],
      mappingDiagnostics: [],
      reconciliationResults: [],
      mappingException: null,
      valuation: null,
      engineVersion: ENGINE_VERSION,
    };
    const calculated = recalculate(snapshot);
    const summary = makeSummary(calculated, [{ kind: "model_created" }]);
    const meta: NewModelMeta = {
      modelId: input.modelId,
      ownerAgentId: input.ownerAgentId,
      originSessionId: input.originSessionId,
      symbol: input.symbol,
      metadata: {
        ...structuredClone(input.metadata),
        reportingCurrency: input.reportingCurrency,
      },
    };
    const revision = this.store.create(meta, {
      lifecycleStage: calculated.lifecycleStage,
      snapshot: calculated,
      changeSummary: summary,
      engineVersion: ENGINE_VERSION,
      creatingSessionId: input.originSessionId,
    });
    return commitResult(revision);
  }

  stageFacts(modelId: string, expectedRevision: number, candidates: Fact[]): CommitResult {
    const parent = this.loadForMutation(modelId, expectedRevision);
    if (candidates.length === 0) {
      throw new FinancialModelError("invalid_model_operation", "fact staging batch must not be empty");
    }
    const working = structuredClone(parent.snapshot);
    working.facts = stageFactCandidates(working.facts, candidates);
    const calculated = recalculate(working);
    return this.commit(
      modelId,
      expectedRevision,
      calculated,
      makeSummary(calculated, [factsStagedChange(calculated, candidates)]),
    );
  }

  /**
   * Atomically installs filing-derived source rows and their staged facts.
   * Phase 2 creation uses this after a value-free revision 0 so the initial
   * filing import remains an explicit, replayable revision 1 boundary.
   */
  stagePreparedStatements(
    modelId: string,
    expectedRevision: number,
    rows: PreparedStatementRow[],
    candidates: Fact[],
    filingInsightSetId?: string,
  ): CommitResult {
    const parent = this.loadForMutation(modelId, expectedRevision);
    if (expectedRevision !== 0
      || parent.snapshot.facts.length > 0
      || parent.snapshot.lineItems.some((item) => item.section.startsWith("source_"))) {
      throw new FinancialModelError(
        "invalid_model_operation",
        "prepared statements may only be staged once against the value-free revision zero",
      );
    }
    if (rows.length === 0 || candidates.length === 0) {
      throw new FinancialModelError(
        "invalid_model_operation",
        "prepared statement staging requires source rows and fact candidates",
      );
    }
    const rowIds = new Set(rows.map((row) => row.sourceLineItemId));
    if (rowIds.size !== rows.length) {
      throw new FinancialModelError("invalid_model_operation", "prepared statement rows repeat a source line-item id");
    }
    const periodIds = new Set(parent.snapshot.periods.map((period) => period.id));
    for (const candidate of candidates) {
      if (candidate.lineItemId === undefined || !rowIds.has(candidate.lineItemId)) {
        throw new FinancialModelError(
          "invalid_model_operation",
          `prepared fact must reference a source row from the same import: ${candidate.factId}`,
        );
      }
      if (!periodIds.has(candidate.periodId)) {
        throw new FinancialModelError(
          "invalid_model_operation",
          `prepared fact references an unknown model period: ${candidate.periodId}`,
        );
      }
    }
    const working = structuredClone(parent.snapshot);
    working.filingInsightSetId = filingInsightSetId ?? null;
    const stagedSkeleton = addSourceStatementRows(skeletonOf(working), rows);
    acceptSkeleton(working, stagedSkeleton);
    working.facts = stageFactCandidates(working.facts, candidates);
    const calculated = recalculate(working);
    const factChange = factsStagedChange(calculated, candidates);
    return this.commit(modelId, expectedRevision, calculated, makeSummary(calculated, [{
      kind: "statements_staged",
      rowCount: rows.length,
      candidateCount: factChange.candidateCount,
      mappedLineItemIds: factChange.mappedLineItemIds,
      periodIds: factChange.periodIds,
    }]));
  }

  /**
   * Stages the canonical spine facts the `spine_mapping` subagent produced from the unified
   * statements. Staging, not committing: the subagent has no authority over a revision, so the facts
   * land as candidates and the owning agent accepts them through `review_financial_model_history`.
   *
   * Supplementary detail rows arrive as ids the skeleton does not carry yet. A revenue detail becomes
   * a revenue stream; any other detail becomes a DCF detail line item under its parent. A detail whose
   * parent refuses children is dropped rather than failing the whole batch — it is supplementary by
   * definition, and losing one must not cost the issuer its spine.
   */
  stageSpineFacts(modelId: string, expectedRevision: number, input: StageSpineFactsInput): CommitResult {
    const parent = this.loadForMutation(modelId, expectedRevision);
    const working = structuredClone(parent.snapshot);
    if (working.selectedHistoricalPeriodIds.length === 0) {
      working.selectedHistoricalPeriodIds = normalizeSelectedPeriods(
        working.periods,
        [...input.historicalPeriodIds],
      );
    }
    const knownPeriods = new Set(working.periods.map((period) => period.id));
    let skeleton = skeletonOf(working);
    const present = () => new Set(skeleton.lineItems.map((item) => item.id));
    for (const lineItemId of new Set(input.facts.map((fact) => fact.lineItemId))) {
      if (lineItemId === undefined || present().has(lineItemId)) continue;
      const separator = lineItemId.lastIndexOf(".");
      const parentId = separator < 0 ? "" : lineItemId.slice(0, separator);
      const slug = lineItemId.slice(separator + 1);
      try {
        skeleton = parentId === "revenue"
          ? addRevenueStream(skeleton, { id: slug, label: input.labels?.[lineItemId] ?? slug })
          : addDcfDetailLineItem(skeleton, { id: slug, label: input.labels?.[lineItemId] ?? slug, parentLineItemId: parentId });
      } catch { /* supplementary by definition: a parent that refuses children costs one detail row, not the spine */ }
    }
    acceptSkeleton(working, skeleton);

    const installed = new Set(working.lineItems.map((item) => item.id));
    const existingFactIds = new Set(working.facts.map((fact) => fact.factId));
    const candidates = input.facts.filter((fact) => fact.lineItemId !== undefined
      && installed.has(fact.lineItemId)
      && knownPeriods.has(fact.periodId)
      && !existingFactIds.has(fact.factId));
    working.facts = stageFactCandidates(working.facts, candidates);
    const calculated = recalculate(working);
    const factChange = factsStagedChange(calculated, candidates);
    return this.commit(modelId, expectedRevision, calculated, makeSummary(calculated, [{
      kind: "statements_staged",
      rowCount: candidates.length,
      candidateCount: factChange.candidateCount,
      mappedLineItemIds: factChange.mappedLineItemIds,
      periodIds: factChange.periodIds,
    }]));
  }

  reviewFacts(modelId: string, expectedRevision: number, input: ReviewFactsInput): CommitResult {
    const parent = this.loadForMutation(modelId, expectedRevision);
    if (input.decisions.length === 0
      && input.selectedHistoricalPeriodIds.length === 0
      && input.categoryLineItems.length === 0
      && input.statementMappingPlans.length === 0
      && input.categoryGroups.length === 0) {
      throw new FinancialModelError("invalid_model_operation", "fact review mutation must not be empty");
    }
    const working = structuredClone(parent.snapshot);
    // When the review time is left to the agent it invents one. The ledger's clock is the host's.
    const reviewedAt = new Date().toISOString();
    const decisions = input.decisions.map((decision) => ({ ...structuredClone(decision), reviewedAt }));
    ensureUniqueDecisionIds(working.factReviewDecisions, decisions);
    working.facts = applyFactReview(working.facts, decisions);
    working.factReviewDecisions.push(...decisions);
    working.selectedHistoricalPeriodIds = normalizeSelectedPeriods(
      working.periods,
      input.selectedHistoricalPeriodIds,
    );
    const presentIds = new Set(working.lineItems.map((item) => item.id));
    let importSkeleton = skeletonOf(working);
    for (const item of input.categoryLineItems) {
      if (item.parentLineItemId === "revenue") {
        const slug = item.id.startsWith("revenue.")
          ? item.id.slice("revenue.".length)
          : item.id;
        // Confirming a stream `stageSpineFacts` already installed is a no-op, not a redefinition.
        if (presentIds.has(`revenue.${slug}`)) continue;
        importSkeleton = addRevenueStream(importSkeleton, { id: slug, label: item.label });
      } else if (!presentIds.has(item.id)) {
        importSkeleton = addDcfDetailLineItem(importSkeleton, item);
      }
    }
    acceptSkeleton(working, importSkeleton);
    validateMappingPeriods(working, input.statementMappingPlans);
    const normalizedPlans = input.statementMappingPlans.map((plan) => ({
      ...structuredClone(plan),
      periodIds: orderedPeriods(working, plan.periodIds),
    }));
    // The initial mapping is one shot: once plans exist, further changes go through
    // `set_statement_mapping_plan` so each one is its own auditable operation.
    if (working.statementMappingPlans.length > 0 && normalizedPlans.length > 0) {
      throw new FinancialModelError(
        "invalid_model_operation",
        "initial statement mappings are already committed; use set_statement_mapping_plan",
      );
    }
    let compiled = applyStatementMappingPlans(skeletonOf(working), normalizedPlans);
    const normalizedGroups = input.categoryGroups.map((group) => ({
      ...structuredClone(group),
      periodIds: orderedPeriods(working, group.periodIds),
    }));
    if (working.categoryGroups.length > 0 && normalizedGroups.length > 0) {
      throw new FinancialModelError(
        "invalid_model_operation",
        "initial category groups are already committed; use set_category_group",
      );
    }
    compiled = applyDcfCategoryGroups(compiled, normalizedGroups);
    acceptSkeleton(working, compiled);
    working.statementMappingPlans = sortStatementPlans(working, normalizedPlans);
    working.categoryGroups = sortCategoryGroups(working, normalizedGroups);
    working.mappingException = null;
    const calculated = recalculate(working);
    const changes: RevisionChange[] = [factsReviewedChange(parent.snapshot, input.decisions)];
    changes.push(...normalizedPlans.map((plan) => ({
      kind: "statement_mapping_plan_set" as const,
      targetLineItemId: plan.targetLineItemId,
      periodIds: orderedPeriods(calculated, plan.periodIds),
    })));
    changes.push(...input.categoryLineItems.map((item) => ({
      kind: "line_item_added" as const,
      lineItemId: item.parentLineItemId === "revenue"
        ? `revenue.${item.id.replace(/^revenue\./, "")}`
        : item.id.startsWith(`${item.parentLineItemId}.`)
          ? item.id
          : `${item.parentLineItemId}.${item.id}`,
      parentId: item.parentLineItemId,
    })));
    changes.push(...normalizedGroups.map((group) => ({
      kind: "category_group_set" as const,
      parentLineItemId: group.parentLineItemId,
      category: group.category,
      periodIds: orderedPeriods(calculated, group.periodIds),
    })));
    return this.commit(
      modelId,
      expectedRevision,
      calculated,
      makeSummary(calculated, changes),
    );
  }

  applyOperations(
    modelId: string,
    expectedRevision: number,
    operations: ModelOperation[],
  ): CommitResult {
    const parent = this.loadForMutation(modelId, expectedRevision);
    const working = applyModelOperations(parent.snapshot, operations);
    const calculated = recalculate(working);
    const advancement = operations.some((operation) => operation.kind === "advance_stage");
    if (advancement) enforceStageGates(calculated);
    return this.commit(
      modelId,
      expectedRevision,
      calculated,
      makeSummary(calculated, operationChanges(parent.snapshot, calculated, operations)),
    );
  }

  readCells(modelId: string, query: ModelQuery): WorkbookSliceView {
    if (query.kind !== "read_cells") {
      throw new FinancialModelError("invalid_model_query", "unsupported model query");
    }
    const revision = this.requireRevision(modelId, query.revision);
    return buildWorkbookSlice(
      modelId,
      revision.revision,
      revision.snapshot,
      query.selector,
      query.includeLineage ?? false,
    );
  }

  getModel(
    modelId: string,
    options: ViewOptions = {},
  ): ModelContextView | WorkbookSliceView {
    const targeted = options.revision !== undefined
      || options.section !== undefined
      || options.selector !== undefined
      || options.includeLineage === true
      || options.reopenSources === true;
    if (targeted) {
      const revision = this.requireRevision(modelId, options.revision);
      const selector = structuredClone(options.selector ?? {});
      if (options.section !== undefined) selector.section = options.section;
      return buildWorkbookSlice(
        modelId,
        revision.revision,
        revision.snapshot,
        selector,
        options.includeLineage ?? false,
      );
    }
    const current = this.requireRevision(modelId);
    const meta = this.store.getMeta(modelId)!;
    return buildModelContextView(
      meta,
      this.store.listRevisionHeaders(modelId),
      current,
    );
  }

  listModels(filter: ModelFilter = {}): ModelView[] {
    return this.store.list(filter);
  }

  archive(modelId: string, expectedRevision: number): CommitResult {
    const parent = this.loadForMutation(modelId, expectedRevision);
    const calculated = recalculate(structuredClone(parent.snapshot));
    calculated.lifecycleStage = "archived";
    return this.commit(
      modelId,
      expectedRevision,
      calculated,
      makeSummary(calculated, [{ kind: "archived" }]),
    );
  }

  historicalCompleteness(modelId: string, revision?: number): HistoricalDcfCompletenessView {
    return historicalCompleteness(this.requireRevision(modelId, revision).snapshot);
  }

  private loadForMutation(
    modelId: string,
    expectedRevision: number,
  ): Revision<FinancialModelSnapshot, RevisionChangeSummary> {
    const current = this.store.getRevision(modelId);
    if (!current) {
      throw new FinancialModelError("financial_model_not_found", `model not found: ${modelId}`);
    }
    if (current.revision !== expectedRevision) {
      throw new FinancialModelError(
        "revision_conflict",
        `expected revision ${expectedRevision}, current is ${current.revision}`,
        { currentRevision: current.revision },
      );
    }
    if (current.lifecycleStage === "archived") {
      throw new FinancialModelError("invalid_model_operation", "archived models are immutable");
    }
    return current;
  }

  private requireRevision(
    modelId: string,
    revision?: number,
  ): Revision<FinancialModelSnapshot, RevisionChangeSummary> {
    const result = this.store.getRevision(modelId, revision);
    if (!result) {
      if (!this.store.getMeta(modelId)) {
        throw new FinancialModelError("financial_model_not_found", `model not found: ${modelId}`);
      }
      throw new FinancialModelError(
        "invalid_model_query",
        `revision does not exist: ${String(revision)}`,
      );
    }
    return result;
  }

  private commit(
    modelId: string,
    expectedRevision: number,
    snapshot: FinancialModelSnapshot,
    summary: RevisionChangeSummary,
  ): CommitResult {
    const revision = this.store.commit(modelId, expectedRevision, {
      lifecycleStage: snapshot.lifecycleStage,
      snapshot,
      changeSummary: summary,
      engineVersion: ENGINE_VERSION,
      creatingSessionId: this.creatingSessionId,
    });
    return commitResult(revision);
  }
}

function recalculate(snapshot: FinancialModelSnapshot): FinancialModelSnapshot {
  const next = structuredClone(snapshot);
  buildGrid(next.periods);
  validateRoleCardinality(next.lineItems);
  next.valuationConfig = validateValuationConfig(next.valuationConfig);
  const activeFacts = resolveActiveFacts(next.facts, next.lineItems, next.periods);
  next.compiledFormulas = next.formulas.map((formula) => ({
    ...structuredClone(formula),
    ast: parseFormula(formula.source),
  }));
  const output = evaluate({
    periods: next.periods,
    lineItems: next.lineItems,
    facts: activeFacts,
    assumptions: next.assumptions,
    formulas: next.formulas,
    valuationConfig: next.valuationConfig,
  });
  next.cells = output.cells;
  next.diagnostics = sortDiagnostics(
    output.order.flatMap((key) => next.cells.get(key)?.diagnostics ?? []),
  );
  next.mappingDiagnostics = sortDiagnostics(next.mappingDiagnostics);
  next.reconciliationResults = reconcileDcf({
    periods: next.periods,
    lineItems: next.lineItems,
    cells: next.cells,
    categoryGroups: next.categoryGroups,
  });
  next.mappingException = reconciliationMappingException(next);
  next.engineVersion = ENGINE_VERSION;
  next.valuation = next.lifecycleStage === "valued"
    ? calculateValuation({
        periods: next.periods,
        lineItems: next.lineItems,
        cells: next.cells,
        valuationConfig: next.valuationConfig,
      })
    : null;
  return next;
}

function defaultValuationConfig(periods: readonly Period[]): ValuationConfig {
  const anchor = [...periods].reverse().find((period) => period.cls !== "forecast");
  if (!anchor) {
    throw new FinancialModelError(
      "incompatible_periods",
      "a valuation model requires an actual or TTM anchor period",
    );
  }
  return validateValuationConfig({
    anchorPeriodId: anchor.id,
    discountConvention: "year_end",
    exitTerminalMetric: "ebitda",
    sensitivity: {
      waccDeltas: [-0.01, 0, 0.01],
      terminalGrowthDeltas: [-0.005, 0, 0.005],
      exitMultipleDeltas: [-1, 0, 1],
    },
    sourceType: "user",
    sourceRefs: ["model_creation_default"],
    asOfDate: anchor.end,
    rationale: "Default phase-1 valuation configuration",
  });
}

function enforceStageGates(snapshot: FinancialModelSnapshot): void {
  const target = STAGE_ORDER.indexOf(snapshot.lifecycleStage);
  if (target >= STAGE_ORDER.indexOf("history_committed")) historyGate(snapshot);
  if (target >= STAGE_ORDER.indexOf("revenue_forecast")) {
    requireRoleCells(snapshot, "revenue_total", "forecast");
  }
  if (target >= STAGE_ORDER.indexOf("operations_fcff")) {
    requireRoleCells(snapshot, "fcff", "forecast");
  }
  if (target >= STAGE_ORDER.indexOf("valued") && snapshot.valuation === null) {
    throw new FinancialModelError("missing_formula_input", "valued stage requires valuation output");
  }
}

function historyGate(snapshot: FinancialModelSnapshot): void {
  if (snapshot.selectedHistoricalPeriodIds.length === 0
    || snapshot.statementMappingPlans.length === 0) {
    throw new FinancialModelError(
      "history_review_required",
      "history requires selected periods and reviewed statement mappings",
    );
  }
  const selected = new Set(snapshot.selectedHistoricalPeriodIds);
  if (snapshot.facts.some((fact) => fact.status === "staged" && selected.has(fact.periodId))) {
    throw new FinancialModelError(
      "history_review_required",
      "selected history still contains staged facts",
    );
  }
  if (snapshot.mappingDiagnostics.length > 0) {
    throw new FinancialModelError(
      "unresolved_reconciliation",
      "statement mapping diagnostics remain unresolved",
    );
  }
  const failedReconciliations = snapshot.reconciliationResults.filter(
    (result) => result.required && result.status === "failed",
  );
  if (failedReconciliations.length > 0) {
    throw new FinancialModelError(
      "unresolved_reconciliation",
      "required DCF reconciliation checks failed",
      { ruleIds: failedReconciliations.map((result) => result.ruleId) },
    );
  }
  const completeness = historicalCompleteness(snapshot);
  const missing = completeness.categories.flatMap((category) => category.periods
    .filter((period) => period.status === "missing")
    .map((period) => `${category.lineItemId}@${period.periodId}`));
  if (missing.length > 0) {
    throw new FinancialModelError(
      "history_review_required",
      "required high-level DCF history is incomplete",
      { missing, historicalDcfCompleteness: completeness as unknown as JsonObject },
    );
  }
  for (const plan of snapshot.statementMappingPlans) {
    for (const periodId of plan.periodIds) {
      const value = snapshot.cells.get(cellKey(plan.targetLineItemId, periodId))?.value;
      if (value === null || value === undefined) {
        throw new FinancialModelError(
          "history_review_required",
          `mapped history is unresolved for ${plan.targetLineItemId}@${periodId}`,
        );
      }
    }
  }
}

const REQUIRED_HISTORY_LINE_ITEMS = [
  "revenue.total", "cost_of_revenue", "gross_profit", "operating_expenses", "operating_income",
  "depreciation_amortization", "ebitda", "pretax_income", "income_tax_expense", "net_income",
  "nopat", "capital_expenditures", "operating_working_capital", "change_nwc", "fcff",
] as const;

function historicalCompleteness(snapshot: FinancialModelSnapshot): HistoricalDcfCompletenessView {
  const selected = snapshot.periods.filter((period) => snapshot.selectedHistoricalPeriodIds.includes(period.id));
  return {
    selectedHistoricalPeriodIds: selected.map((period) => period.id),
    categories: REQUIRED_HISTORY_LINE_ITEMS.map((lineItemId) => {
      const item = snapshot.lineItems.find((candidate) => candidate.id === lineItemId)!;
      return { lineItemId, role: item.role, periods: selected.map((period, index) => {
        const key = cellKey(lineItemId, period.id);
        if ((lineItemId === "change_nwc" || lineItemId === "fcff") && index === 0) {
          return { periodId: period.id, status: "not_applicable" as const, refs: [key] };
        }
        const cell = snapshot.cells.get(key);
        return { periodId: period.id, status: cell?.value === null || cell?.value === undefined ? "missing" as const : "complete" as const,
          refs: [key, ...new Set(cell?.diagnostics.flatMap((diagnostic) => diagnostic.refs) ?? [])] };
      }) };
    }),
  };
}

function requireRoleCells(
  snapshot: FinancialModelSnapshot,
  role: "revenue_total" | "fcff",
  periodClass: "forecast",
): void {
  const item = snapshot.lineItems.find((candidate) => candidate.role === role)!;
  const refs = snapshot.periods
    .filter((period) => period.cls === periodClass)
    .map((period) => cellKey(item.id, period.id))
    .filter((key) => snapshot.cells.get(key)?.value === null
      || snapshot.cells.get(key)?.value === undefined);
  if (refs.length > 0) {
    throw new FinancialModelError(
      "missing_formula_input",
      `${role} is incomplete at the requested stage`,
      { refs },
    );
  }
}

function normalizeSelectedPeriods(periods: readonly Period[], selected: readonly string[]): string[] {
  const selectedSet = new Set(selected);
  if (selectedSet.size !== selected.length) {
    throw new FinancialModelError("invalid_model_operation", "selected history repeats a period");
  }
  for (const id of selected) {
    const period = periods.find((candidate) => candidate.id === id);
    if (!period || period.cls !== "actual") {
      throw new FinancialModelError("invalid_model_operation", `selected period is not actual: ${id}`);
    }
  }
  return periods.filter((period) => selectedSet.has(period.id)).map((period) => period.id);
}

function validateMappingPeriods(
  snapshot: FinancialModelSnapshot,
  plans: readonly StatementMappingPlan[],
): void {
  const selected = new Set(snapshot.selectedHistoricalPeriodIds);
  for (const plan of plans) {
    if (new Set(plan.periodIds).size !== plan.periodIds.length) {
      throw new FinancialModelError(
        "invalid_model_operation",
        `statement mapping repeats a period: ${plan.targetLineItemId}`,
      );
    }
    for (const periodId of plan.periodIds) {
      if (!selected.has(periodId)) {
        throw new FinancialModelError(
          "invalid_model_operation",
          `statement mapping period was not selected: ${periodId}`,
        );
      }
    }
  }
}

function ensureUniqueDecisionIds(
  existing: readonly FactReviewDecision[],
  incoming: readonly FactReviewDecision[],
): void {
  const ids = new Set(existing.map((decision) => decision.decisionId));
  for (const decision of incoming) {
    if (ids.has(decision.decisionId)) {
      throw new FinancialModelError(
        "fact_conflict",
        `fact review decision id already exists: ${decision.decisionId}`,
      );
    }
    ids.add(decision.decisionId);
  }
}

function isRevenueStreamId(lineItemId: string): boolean {
  return lineItemId.startsWith("revenue.") && lineItemId !== "revenue.total";
}

function planKey(plan: StatementMappingPlan): string {
  return `${plan.targetLineItemId} ${[...plan.periodIds].sort().join(",")}`;
}

function referencesLineItem(source: string, lineItemId: string): boolean {
  const escaped = lineItemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_.])`).test(source);
}

/** A stream the engine no longer produces is only retired when nothing else in the model needs it. */
function streamIsReferenced(
  snapshot: FinancialModelSnapshot,
  skeleton: Skeleton,
  streamId: string,
): boolean {
  const growthId = `growth.${streamId}`;
  if (snapshot.categoryGroups.some((group) => group.members.some((member) =>
    member.lineItemId === streamId || member.lineItemId === growthId))) return true;
  return skeleton.formulas.some((formula) => formula.lineItemId !== streamId
    && formula.lineItemId !== growthId
    && (referencesLineItem(formula.source, streamId)
      || referencesLineItem(formula.source, growthId)));
}

function removeRevenueStreams(skeleton: Skeleton, streamIds: ReadonlySet<string>): Skeleton {
  if (streamIds.size === 0) return skeleton;
  const removed = new Set<string>();
  for (const id of streamIds) {
    removed.add(id);
    removed.add(`growth.${id}`);
  }
  return {
    periods: skeleton.periods,
    lineItems: skeleton.lineItems.filter((item) => !removed.has(item.id)),
    formulas: skeleton.formulas.filter((formula) => !removed.has(formula.lineItemId)),
  };
}

/**
 * Strips the historical coverage a superseded engine plan compiled, so the next plan set is written
 * onto a clean target instead of colliding with the previous run's partially overlapping coverage.
 */
function dropHistoricalPlanFormulas(
  skeleton: Skeleton,
  plans: readonly StatementMappingPlan[],
): Skeleton {
  if (plans.length === 0) return skeleton;
  const dropped = new Map<string, Set<string>>();
  for (const plan of plans) {
    const periods = dropped.get(plan.targetLineItemId) ?? new Set<string>();
    for (const periodId of plan.periodIds) periods.add(periodId);
    dropped.set(plan.targetLineItemId, periods);
  }
  return {
    ...skeleton,
    formulas: skeleton.formulas.filter((formula) => {
      const periods = dropped.get(formula.lineItemId);
      if (periods === undefined || formula.appliesTo !== "historical") return true;
      const coverage = formula.periodIds;
      if (coverage === undefined || coverage.length === 0) return true;
      return !coverage.every((periodId) => periods.has(periodId));
    }),
  };
}

function skeletonOf(snapshot: FinancialModelSnapshot): Skeleton {
  return {
    periods: snapshot.periods,
    lineItems: snapshot.lineItems,
    formulas: snapshot.formulas,
  };
}

function acceptSkeleton(snapshot: FinancialModelSnapshot, skeleton: Skeleton): void {
  snapshot.periods = skeleton.periods;
  snapshot.lineItems = skeleton.lineItems;
  snapshot.formulas = skeleton.formulas;
}

function sortStatementPlans(
  snapshot: FinancialModelSnapshot,
  plans: readonly StatementMappingPlan[],
): StatementMappingPlan[] {
  const periodPosition = new Map(snapshot.periods.map((period, index) => [period.id, index]));
  return [...structuredClone(plans)].sort((left, right) =>
    (periodPosition.get(left.periodIds[0]!) ?? Number.MAX_SAFE_INTEGER)
      - (periodPosition.get(right.periodIds[0]!) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.targetLineItemId, right.targetLineItemId)
    || compareText(left.periodIds.join("\u0000"), right.periodIds.join("\u0000")));
}

function sortCategoryGroups(
  snapshot: FinancialModelSnapshot,
  groups: readonly DcfCategoryGroup[],
): DcfCategoryGroup[] {
  const periodPosition = new Map(snapshot.periods.map((period, index) => [period.id, index]));
  const itemPosition = new Map(snapshot.lineItems.map((item) => [item.id, item.order]));
  return [...structuredClone(groups)].sort((left, right) =>
    (itemPosition.get(left.parentLineItemId) ?? Number.MAX_SAFE_INTEGER)
      - (itemPosition.get(right.parentLineItemId) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.parentLineItemId, right.parentLineItemId)
    || compareText(left.category, right.category)
    || (periodPosition.get(left.periodIds[0]!) ?? Number.MAX_SAFE_INTEGER)
      - (periodPosition.get(right.periodIds[0]!) ?? Number.MAX_SAFE_INTEGER));
}

function factsStagedChange(
  snapshot: FinancialModelSnapshot,
  candidates: readonly Fact[],
): Extract<RevisionChange, { kind: "facts_staged" }> {
  return {
    kind: "facts_staged",
    candidateCount: candidates.length,
    mappedLineItemIds: orderedLineItems(
      snapshot,
      candidates.flatMap((fact) => fact.lineItemId === undefined ? [] : [fact.lineItemId]),
    ),
    periodIds: orderedPeriods(snapshot, candidates.map((fact) => fact.periodId)),
  };
}

function factsReviewedChange(
  parent: FinancialModelSnapshot,
  decisions: readonly FactReviewDecision[],
): Extract<RevisionChange, { kind: "facts_reviewed" }> {
  const byId = new Map(parent.facts.map((fact) => [fact.factId, fact]));
  return {
    kind: "facts_reviewed",
    committed: decisions.filter((decision) => decision.action === "commit").length,
    rejected: decisions.filter((decision) => decision.action === "reject").length,
    superseded: decisions.filter((decision) => decision.action === "supersede").length,
    lineItemIds: orderedLineItems(parent, decisions.flatMap((decision) => {
      const id = decision.mappedLineItemId ?? byId.get(decision.factId)?.lineItemId;
      return id === undefined ? [] : [id];
    })),
    periodIds: orderedPeriods(parent, decisions.flatMap((decision) => {
      const id = byId.get(decision.factId)?.periodId;
      return id === undefined ? [] : [id];
    })),
  };
}

function operationChanges(
  parent: FinancialModelSnapshot,
  next: FinancialModelSnapshot,
  operations: readonly ModelOperation[],
): RevisionChange[] {
  let summarizedStage = parent.lifecycleStage;
  return operations.map((operation): RevisionChange => {
    switch (operation.kind) {
      case "replace_fact":
        return {
          kind: "fact_replaced",
          lineItemId: operation.commitDecision.mappedLineItemId!,
          periodId: operation.replacement.periodId,
        };
      case "set_assumption":
        return {
          kind: "assumption_set",
          lineItemId: operation.assumption.lineItemId,
          periodIds: orderedPeriods(next, operation.assumption.periods),
        };
      case "set_line_item_source":
        return {
          kind: "line_item_source_set",
          lineItemId: operation.lineItemId,
          range: operation.range,
          source: operation.source,
        };
      case "add_line_item":
        return {
          kind: "line_item_added",
          lineItemId: operation.lineItem.parentId === "revenue"
            ? `revenue.${operation.lineItem.id.replace(/^revenue\./, "")}`
            : operation.lineItem.id,
          parentId: operation.lineItem.parentId,
        };
      case "add_metric":
        return {
          kind: "metric_added",
          registryId: operation.metric.registryId,
          lineItemId: `metric.cagr.${operation.metric.targetLineItemId}.${operation.metric.lookbackPeriods}p`,
        };
      case "set_formula":
        return {
          kind: "formula_set",
          lineItemId: operation.formula.lineItemId,
          appliesTo: operation.formula.appliesTo,
          periodIds: orderedPeriods(next, operation.formula.periodIds ?? []),
        };
      case "set_statement_mapping_plan":
        return {
          kind: "statement_mapping_plan_set",
          targetLineItemId: operation.plan.targetLineItemId,
          periodIds: orderedPeriods(next, operation.plan.periodIds),
        };
      case "set_category_group":
        return {
          kind: "category_group_set",
          parentLineItemId: operation.group.parentLineItemId,
          category: operation.group.category,
          periodIds: orderedPeriods(next, operation.group.periodIds),
        };
      case "set_valuation_config":
        return { kind: "valuation_config_set" };
      case "advance_stage": {
        const from = summarizedStage;
        summarizedStage = operation.stage;
        return { kind: "stage_advanced", from, to: operation.stage };
      }
    }
  });
}

function makeSummary(
  snapshot: FinancialModelSnapshot,
  changes: readonly RevisionChange[],
): RevisionChangeSummary {
  const normalized = [...structuredClone(changes)].sort((left, right) =>
    compareText(left.kind, right.kind)
    || compareText(JSON.stringify(left), JSON.stringify(right)));
  const changedSections = sectionChanges(snapshot, normalized);
  return {
    changes: normalized,
    changedSections,
    warningCount: snapshot.diagnostics.length + snapshot.mappingDiagnostics.length
      + snapshot.reconciliationResults.filter((result) => result.status !== "passed").length,
    blockerCount: 0,
  };
}

function sectionChanges(
  snapshot: FinancialModelSnapshot,
  changes: readonly RevisionChange[],
): ModelReadSection[] {
  const sections = new Set<ModelReadSection>();
  if (changes.some((change) => change.kind === "model_created")) {
    snapshot.lineItems.forEach((item) => sections.add(item.section));
  }
  for (const change of changes) {
    const ids: string[] = [];
    if ("lineItemId" in change) ids.push(change.lineItemId);
    if ("targetLineItemId" in change) ids.push(change.targetLineItemId);
    if ("parentLineItemId" in change) ids.push(change.parentLineItemId);
    if ("mappedLineItemIds" in change) ids.push(...change.mappedLineItemIds);
    if ("lineItemIds" in change) ids.push(...change.lineItemIds);
    for (const id of ids) {
      const item = snapshot.lineItems.find((candidate) => candidate.id === id);
      if (item) sections.add(item.section);
    }
  }
  return SECTION_ORDER.filter((section) => sections.has(section));
}

function orderedPeriods(snapshot: FinancialModelSnapshot, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return snapshot.periods.filter((period) => wanted.has(period.id)).map((period) => period.id);
}

function orderedLineItems(snapshot: FinancialModelSnapshot, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return snapshot.lineItems
    .filter((item) => wanted.has(item.id))
    .sort((left, right) => left.order - right.order || compareText(left.id, right.id))
    .map((item) => item.id);
}

function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...structuredClone(diagnostics)].sort((left, right) =>
    compareText(left.code, right.code)
    || compareText(left.refs.join("\u0000"), right.refs.join("\u0000")));
}

function reconciliationMappingException(
  snapshot: FinancialModelSnapshot,
): MappingException | null {
  const failed = snapshot.reconciliationResults.filter(
    (result) => result.required && result.status === "failed",
  );
  if (failed.length === 0) {
    return snapshot.mappingException?.reason === "reconciliation"
      ? null
      : snapshot.mappingException;
  }

  const affectedLineItems = new Set(
    failed.flatMap((result) => result.refs.map((ref) => splitCellKey(ref as CellKey).lineItemId)),
  );
  const affectedPeriods = new Set(failed.map((result) => result.periodId));
  const sourceLineItems = new Set<string>();
  for (const plan of snapshot.statementMappingPlans) {
    if (!affectedLineItems.has(plan.targetLineItemId)
      || !plan.periodIds.some((periodId) => affectedPeriods.has(periodId))) continue;
    for (const member of plan.members) sourceLineItems.add(member.sourceLineItemId);
  }
  const itemOrder = new Map(snapshot.lineItems.map((item) => [item.id, item.order]));
  return {
    reason: "reconciliation",
    sourceLineItemIds: [...sourceLineItems].sort((left, right) =>
      (itemOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (itemOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      || compareText(left, right)),
    periodIds: snapshot.periods
      .filter((period) => affectedPeriods.has(period.id))
      .map((period) => period.id),
  };
}

function commitResult(
  revision: Revision<FinancialModelSnapshot, RevisionChangeSummary>,
): CommitResult {
  return {
    modelId: revision.modelId,
    revision: revision.revision,
    status: revision.lifecycleStage,
    revisionSummary: summaryFromHeader(revision),
    currentWorkbook: buildWorkbookView(
      revision.modelId,
      revision.revision,
      revision.snapshot,
    ),
    warnings: sortDiagnostics([
      ...revision.snapshot.diagnostics,
      ...revision.snapshot.mappingDiagnostics,
    ]),
  };
}

function summaryFromHeader(
  header: RevisionHeader<RevisionChangeSummary>,
): RevisionSummary {
  return {
    ...structuredClone(header.changeSummary),
    revision: header.revision,
    parentRevision: header.parentRevision,
    lifecycleStage: header.lifecycleStage,
    engineVersion: header.engineVersion,
    creatingSessionId: header.creatingSessionId,
    createdAt: header.createdAt,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
