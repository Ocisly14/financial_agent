import { cellKey, splitCellKey, type CellKey } from "./dsl/graph.ts";
import { parseFormula } from "./dsl/parser.ts";
import { ENGINE_VERSION, evaluate } from "./engine.ts";
import { FinancialModelError } from "./errors.ts";
import { resolveActiveFacts, stageFacts as stageFactCandidates } from "./factLifecycle.ts";
import {
  applyModelOperations,
  type FinancialModelSnapshot,
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
  Assumption,
  Diagnostic,
  Fact,
  LifecycleStage,
  Period,
  PreparedStatementRow,
  ValuationConfig,
} from "./types.ts";
import { calculateValuation, validateValuationConfig } from "./valuation.ts";
import { applyComputedWaccInputs, createWaccSheet, recalculateWaccSheet, type WaccSheetComputedInput } from "./waccSheet.ts";
import type { JsonObject } from "../framework/types.ts";
import type { UnifiedStatementsArtifact } from "../infra/xbrl/unifiedStatements.ts";
import {
  buildModelContextView,
  buildWorkbookSlice,
  buildWorkbookView,
  hasCommittedSpine,
  MODEL_READ_SECTIONS,
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
  /** Attach the three as-filed statements to the context view regardless of
   *  lifecycle stage. Unlike the options above this does NOT narrow the read to
   *  a slice — it widens the full context view, so it is deliberately excluded
   *  from the `targeted` test below. */
  includeSourceStatements?: boolean;
  /** Used by the human HTTP read to render statement_unification's complete
   * face statements; ordinary agent reads remain snapshot-only. */
  unifiedStatements?: UnifiedStatementsArtifact;
};

const SECTION_ORDER: readonly ModelReadSection[] = MODEL_READ_SECTIONS;

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
      categoryGroups: [],
      valuationConfig: input.valuationConfig === undefined
        ? initialValuationConfig(input.periods)
        : validateValuationConfig(input.valuationConfig),
      cells: new Map(),
      diagnostics: [],
      reconciliationResults: [],
      valuation: null,
      waccSheet: recalculateWaccSheet(createWaccSheet(new Date().toISOString().slice(0, 10))),
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
   * Commits the canonical spine facts the `spine_mapping` subagent produced from the unified
   * statements — directly, no staged intermediate: the upstream pipeline already verified roll-ups
   * per filing and partition tolerances, the engine re-validates via reconciliation on this very
   * commit, and the revision chain itself is the audit record. A wrong mapping is corrected with
   * replace_fact / set_formula on a later revision, not prevented by a review ceremony.
   */
  commitSpineFacts(modelId: string, expectedRevision: number, input: StageSpineFactsInput): CommitResult {
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
    // Parents before children: a nested stream batch may list revenue.product.iphone ahead of
    // revenue.product, and the child can only install once its parent stream exists.
    const newLineItemIds = [...new Set(input.facts.map((fact) => fact.lineItemId))]
      .filter((id): id is string => id !== undefined)
      .sort((a, b) => a.split(".").length - b.split(".").length || a.localeCompare(b));
    for (const lineItemId of newLineItemIds) {
      if (present().has(lineItemId)) continue;
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
    working.facts = [...working.facts, ...candidates.map((fact) => ({ ...structuredClone(fact), status: "committed" as const }))];
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

  applyOperations(
    modelId: string,
    expectedRevision: number,
    operations: ModelOperation[],
  ): CommitResult {
    const parent = this.loadForMutation(modelId, expectedRevision);
    const working = applyModelOperations(parent.snapshot, operations);
    const calculated = recalculate(working);
    return this.commit(
      modelId,
      expectedRevision,
      calculated,
      makeSummary(calculated, operationChanges(parent.snapshot, calculated, operations)),
    );
  }

  /**
   * Folds the engine's freshly derived WACC terms into the sheet and commits the result as its own
   * revision, distinct from the fact-review commit that made those terms derivable. Agent-authored
   * rows are left untouched — `applyComputedWaccInputs` skips them — and the sheet's `asOfDate` is
   * never moved: it stays anchored at the model's creation date for the life of the model.
   */
  refreshWaccSheet(
    modelId: string,
    expectedRevision: number,
    inputs: WaccSheetComputedInput[],
  ): CommitResult {
    const parent = this.loadForMutation(modelId, expectedRevision);
    if (parent.snapshot.waccSheet === null) {
      throw new FinancialModelError("invalid_model_operation", "model has no WACC sheet to refresh");
    }
    const before = new Map(parent.snapshot.waccSheet.rows.map((row) => [row.rowId, row]));
    // Mirrors applyComputedWaccInputs' own skip rule so the reported rowIds match what actually
    // changed, and treats an input whose value already matches the sheet as nothing to apply — so
    // refreshing an already-current sheet, or one where every derivable row has been agent-overridden,
    // is a normal no-op (no new revision) rather than an error.
    const changed = inputs.filter((input) => {
      const row = before.get(input.rowId);
      return row?.source !== "agent" && row?.value !== input.value;
    });
    if (changed.length === 0) {
      return commitResult(parent);
    }
    const working = structuredClone(parent.snapshot);
    working.waccSheet = recalculateWaccSheet(applyComputedWaccInputs(working.waccSheet!, inputs));
    const order = new Map(working.waccSheet.rows.map((row, index) => [row.rowId, index]));
    const rowIds = [...new Set(changed.map((input) => input.rowId))]
      .sort((left, right) => order.get(left)! - order.get(right)!);
    // Recalculate the full workbook so the wacc line item's forecast cells (and any already-computed
    // valuation) track the sheet immediately, rather than only on the next unrelated commit.
    const calculated = recalculate(working);
    return this.commit(
      modelId,
      expectedRevision,
      calculated,
      makeSummary(calculated, [{ kind: "wacc_sheet_refreshed", rowIds }]),
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
      {
        includeSourceStatements: options.includeSourceStatements ?? false,
        ...(options.unifiedStatements ? { unifiedStatements: options.unifiedStatements } : {}),
      },
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
  const waccAssumptions = materializedWaccAssumptions(next);
  reconcileSourceDeclarations(next, activeFacts, waccAssumptions);
  next.compiledFormulas = next.formulas.map((formula) => ({
    ...structuredClone(formula),
    ast: parseFormula(formula.source),
  }));
  const output = evaluate({
    periods: next.periods,
    lineItems: next.lineItems,
    facts: activeFacts,
    // The wacc row is dynamically marked "calculated" when its sheet resolves, so its value never
    // comes from next.assumptions; it is materialized here, straight off the WACC sheet, into the
    // same seeding path the engine already uses for assumptions. Not persisted onto next.assumptions
    // itself — the sheet stays the one stored record of the discount rate.
    assumptions: [...next.assumptions, ...waccAssumptions],
    formulas: next.formulas,
    valuationConfig: next.valuationConfig,
  });
  next.cells = output.cells;
  next.diagnostics = sortDiagnostics(
    output.order.flatMap((key) => next.cells.get(key)?.diagnostics ?? []),
  );
  next.reconciliationResults = reconcileDcf({
    periods: next.periods,
    lineItems: next.lineItems,
    cells: next.cells,
    categoryGroups: next.categoryGroups,
  });
  attachUnifiedTrail(next);
  next.engineVersion = ENGINE_VERSION;
  deriveLifecycle(next);
  return next;
}

/**
 * The one authority for a row's source declaration.  Skeleton creation intentionally leaves both
 * ranges as `none`; after each fill/mutation this function derives them from the channel that
 * actually supplied values.  A committed fact wins over an earlier provisional formula or
 * assumption in the same range, because it is the issuer data the computation was standing in for.
 */
function reconcileSourceDeclarations(
  snapshot: FinancialModelSnapshot,
  activeFacts: readonly Fact[],
  calculatedAssumptions: readonly Assumption[],
): void {
  type Range = "historical" | "forecast";
  const rangeOfPeriodId = new Map(snapshot.periods.map((period) => [
    period.id,
    period.cls === "forecast" ? "forecast" as const : "historical" as const,
  ]));
  const actual = new Map<Range, Set<string>>([
    ["historical", new Set<string>()], ["forecast", new Set<string>()],
  ]);
  for (const fact of activeFacts) {
    if (fact.lineItemId === undefined) continue;
    const range = rangeOfPeriodId.get(fact.periodId);
    if (range) actual.get(range)!.add(fact.lineItemId);
  }

  // Facts replace provisional values for their whole source range.  The public operation API has
  // the same one-source-per-range rule; doing it here also covers facts committed by the mapping
  // pipeline, which bypasses operations.
  for (const range of ["historical", "forecast"] as const) {
    const factBacked = actual.get(range)!;
    if (factBacked.size === 0) continue;
    snapshot.formulas = snapshot.formulas.filter((formula) =>
      formula.appliesTo !== range || !factBacked.has(formula.lineItemId));
    const periodIds = new Set(snapshot.periods
      .filter((period) => (period.cls === "forecast" ? "forecast" : "historical") === range)
      .map((period) => period.id));
    snapshot.assumptions = snapshot.assumptions.filter((assumption) =>
      !factBacked.has(assumption.lineItemId)
      || !assumption.periods.some((periodId) => periodIds.has(periodId)));
  }

  const formulas = new Map<Range, Set<string>>([
    ["historical", new Set<string>()], ["forecast", new Set<string>()],
  ]);
  for (const formula of snapshot.formulas) formulas.get(formula.appliesTo)!.add(formula.lineItemId);
  const assumptions = new Map<Range, Set<string>>([
    ["historical", new Set<string>()], ["forecast", new Set<string>()],
  ]);
  for (const assumption of snapshot.assumptions) {
    if (assumption.payload.kind === "not_applicable") continue;
    for (const periodId of assumption.periods) {
      const range = rangeOfPeriodId.get(periodId);
      if (range) assumptions.get(range)!.add(assumption.lineItemId);
    }
  }

  const waccCalculated = calculatedAssumptions.some((assumption) => assumption.lineItemId === "wacc");
  snapshot.lineItems = snapshot.lineItems.map((item) => {
    const source = (range: Range) => {
      if (item.id === "wacc" && range === "forecast" && waccCalculated) return "calculated" as const;
      if (actual.get(range)!.has(item.id)) return "actual" as const;
      if (formulas.get(range)!.has(item.id)) return "formula" as const;
      if (assumptions.get(range)!.has(item.id)) return "assumption" as const;
      return "none" as const;
    };
    return { ...item, historical: source("historical"), forecast: source("forecast") };
  });
}

/**
 * Lifecycle 是事实的读数,不是门:引擎在每次重算后按模型的实际状态推导 stage,
 * 估值一旦可算立即计算,算不出就保持 null——缺什么,表格和 WACC 表自己会显示。
 */
function deriveLifecycle(next: FinancialModelSnapshot): void {
  if (next.lifecycleStage === "archived") return;
  const blockerCodes = new Set<Diagnostic["code"]>([
    "history_review_required",
    "unresolved_reconciliation",
    "missing_formula_input",
    "invalid_terminal_assumptions",
    "incomplete_equity_bridge",
  ]);
  const passes = (blockedStage: LifecycleStage, gate: () => void): boolean => {
    try {
      gate();
      return true;
    } catch (error) {
      if (error instanceof FinancialModelError && blockerCodes.has(error.code as Diagnostic["code"])) {
        const details = error.details;
        const refs = [details?.refs, details?.missing, details?.ruleIds]
          .flatMap((value) => Array.isArray(value) ? value : [])
          .filter((value): value is string => typeof value === "string");
        next.diagnostics = sortDiagnostics([...next.diagnostics, {
          code: error.code as Diagnostic["code"], refs, message: error.message, stage: blockedStage,
        }]);
      }
      return false;
    }
  };
  let stage: LifecycleStage = "draft";
  next.valuation = null;
  if (passes("history_committed", () => historyGate(next))) {
    stage = "history_committed";
    if (passes("revenue_forecast", () => requireRoleCells(next, "revenue_total", "forecast"))) {
      stage = "revenue_forecast";
      if (passes("operations_fcff", () => requireRoleCells(next, "fcff", "forecast"))) {
        stage = "operations_fcff";
        if (passes("valued", () => requireWaccResolved(next))
          && passes("valued", () => {
            next.valuation = calculateValuation({
              periods: next.periods,
              lineItems: next.lineItems,
              cells: next.cells,
              valuationConfig: next.valuationConfig,
            });
          })) {
          stage = "valued";
        }
      }
    }
  }
  next.lifecycleStage = stage;
}

/**
 * The valuation configuration a new model starts with: the anchor period, and nothing else. Which
 * metric the exit multiple applies to, when cash is assumed to arrive, and what to stress are
 * judgments with no engine-derivable answer, so they start null and the valuation refuses to
 * compute until set_valuation_config fills them. Seeding them would hand the agent a decision it
 * never made and record it as one.
 */
function initialValuationConfig(periods: readonly Period[]): ValuationConfig {
  const anchor = [...periods].reverse().find((period) => period.cls !== "forecast");
  if (!anchor) {
    throw new FinancialModelError(
      "incompatible_periods",
      "a valuation model requires an actual or TTM anchor period",
    );
  }
  return {
    anchorPeriodId: anchor.id,
    discountConvention: null,
    exitTerminalMetric: null,
    sensitivity: null,
  };
}

/**
 * Materializes the WACC sheet's `wacc` row as the forecast value for the `wacc` line item, so the
 * engine seeds it exactly the way an assumption would be seeded — without it ever being one. The
 * sheet, not this list, is the record; nothing here is written back onto `snapshot.assumptions`.
 */
function materializedWaccAssumptions(snapshot: FinancialModelSnapshot): Assumption[] {
  const waccRow = snapshot.waccSheet?.rows.find((row) => row.rowId === "wacc");
  if (!waccRow || waccRow.value === null) return [];
  const waccItem = snapshot.lineItems.find((item) => item.id === "wacc");
  if (!waccItem) return [];
  const forecastPeriods = snapshot.periods.filter((period) => period.cls === "forecast").map((period) => period.id);
  if (forecastPeriods.length === 0) return [];
  return [{
    assumptionId: "wacc-sheet",
    lineItemId: "wacc",
    periods: forecastPeriods,
    payload: { kind: "values", values: [waccRow.value], unit: waccItem.unit },
    sourceType: "analyst_inference",
    sourceRefs: ["wacc_sheet:wacc"],
    asOfDate: snapshot.waccSheet!.asOfDate,
    rationale: "Materialized from the model's WACC sheet; the sheet is the single source for the discount rate.",
  }];
}

/**
 * Fails fast, before recalculate() ever attempts the valuation, when the WACC sheet's wacc row has
 * not resolved — naming exactly the rows still blocking it instead of surfacing as a generic missing
 * cell once calculateValuation runs.
 */
function requireWaccResolved(snapshot: FinancialModelSnapshot): void {
  const row = snapshot.waccSheet?.rows.find((entry) => entry.rowId === "wacc");
  if (row?.value != null) return;
  const missing = row && row.missingInputs.length > 0
    ? row.missingInputs.join(", ")
    : "the WACC sheet has not derived or been given any of its inputs yet";
  throw new FinancialModelError(
    "missing_formula_input",
    `valued stage requires the WACC sheet's wacc row to resolve; still missing: ${missing}`,
  );
}

function historyGate(snapshot: FinancialModelSnapshot): void {
  if (snapshot.selectedHistoricalPeriodIds.length === 0 || !hasCommittedSpine(snapshot)) {
    throw new FinancialModelError(
      "history_review_required",
      "history requires selected periods and committed spine facts",
      { selectedHistoricalPeriodIds: [...snapshot.selectedHistoricalPeriodIds], hasCommittedSpine: hasCommittedSpine(snapshot) },
    );
  }
  const selected = new Set(snapshot.selectedHistoricalPeriodIds);
  // Source-statement facts are the filing evidence library: the import stages them and nothing ever
  // commits them, because the spine is mapped onto canonical rows rather than promoted out of these.
  // Only a staged fact on a canonical row is an unreviewed value in the history the workbook computes
  // from — counting the evidence rows here would pin every imported model at draft forever.
  const sourceRowIds = new Set(snapshot.lineItems
    .filter((item) => item.section.startsWith("source_"))
    .map((item) => item.id));
  const unreviewed = snapshot.facts.some((fact) => fact.status === "staged"
    && selected.has(fact.periodId)
    && !(fact.lineItemId !== undefined && sourceRowIds.has(fact.lineItemId)));
  if (unreviewed) {
    const stagedRefs = snapshot.facts
      .filter((fact) => fact.status === "staged" && selected.has(fact.periodId)
        && !(fact.lineItemId !== undefined && sourceRowIds.has(fact.lineItemId)))
      .map((fact) => fact.lineItemId === undefined ? fact.factId : `${fact.lineItemId}@${fact.periodId}`);
    throw new FinancialModelError(
      "history_review_required",
      "selected history still contains staged facts",
      { refs: stagedRefs },
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
}

/**
 * What `historyGate` demands before a model leaves `draft`. Exported so the spine's own required
 * mapping set can be checked against it. It deliberately names only reported, directly mapped
 * statements; derived DCF rows are authored later when the valuation approach needs them.
 */
export const REQUIRED_HISTORY_LINE_ITEMS = [
  "revenue.total", "cost_of_revenue", "gross_profit", "operating_expenses", "operating_income",
  "depreciation_amortization", "pretax_income", "income_tax_expense", "net_income",
  "capital_expenditures",
] as const;

function historicalCompleteness(snapshot: FinancialModelSnapshot): HistoricalDcfCompletenessView {
  const selected = snapshot.periods.filter((period) => snapshot.selectedHistoricalPeriodIds.includes(period.id));
  return {
    selectedHistoricalPeriodIds: selected.map((period) => period.id),
    categories: REQUIRED_HISTORY_LINE_ITEMS.map((lineItemId) => {
      const item = snapshot.lineItems.find((candidate) => candidate.id === lineItemId)!;
      return { lineItemId, role: item.role, periods: selected.map((period, index) => {
        const key = cellKey(lineItemId, period.id);
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

/** The candidate-count/coverage half of a `statements_staged` change; the caller supplies rowCount. */
function factsStagedChange(
  snapshot: FinancialModelSnapshot,
  candidates: readonly Fact[],
): Omit<Extract<RevisionChange, { kind: "statements_staged" }>, "kind" | "rowCount"> {
  return {
    candidateCount: candidates.length,
    mappedLineItemIds: orderedLineItems(
      snapshot,
      candidates.flatMap((fact) => fact.lineItemId === undefined ? [] : [fact.lineItemId]),
    ),
    periodIds: orderedPeriods(snapshot, candidates.map((fact) => fact.periodId)),
  };
}

function operationChanges(
  parent: FinancialModelSnapshot,
  next: FinancialModelSnapshot,
  operations: readonly ModelOperation[],
): RevisionChange[] {
  const changes = operations.map((operation): RevisionChange => {
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
          // "custom_metrics" is a virtual bucket, not a real line item — it has no backing parent row.
          ...(operation.lineItem.parentId !== "custom_metrics"
            ? { parentId: operation.lineItem.parentId }
            : {}),
        };
      case "import_source_row":
        // A deterministic copy from the operable library reads as an added line item downstream.
        return { kind: "line_item_added", lineItemId: `unified.${operation.row.rowId}` };
      case "set_formula":
        return {
          kind: "formula_set",
          lineItemId: operation.formula.lineItemId,
          appliesTo: operation.formula.appliesTo,
          periodIds: orderedPeriods(next, operation.formula.periodIds ?? []),
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
      case "set_wacc_input":
        return { kind: "wacc_input_set", rowId: operation.input.rowId };
    }
  });
  // Stage 由引擎推导:批次让模型跨过(或跌回)某个阶段时,变更记录如实反映。
  if (parent.lifecycleStage !== next.lifecycleStage) {
    changes.push({ kind: "stage_advanced", from: parent.lifecycleStage, to: next.lifecycleStage });
  }
  return changes;
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
    warningCount: snapshot.diagnostics.length
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
    if ("parentLineItemId" in change) ids.push(change.parentLineItemId);
    if ("mappedLineItemIds" in change) ids.push(...change.mappedLineItemIds);
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

/**
 * Records, on every failed check, which unified statement rows produced the canonical values it
 * compared. spine_mapping stamps each committed fact with the unified rows it summed
 * (`provenance.concept`), so a broken identity can name its own inputs — the agent follows the
 * rowIds into get_unified_rows instead of guessing which disclosure went wrong.
 */
function attachUnifiedTrail(snapshot: FinancialModelSnapshot): void {
  const spineByCell = new Map<string, Fact>();
  for (const fact of snapshot.facts) {
    if (fact.status !== "committed" || fact.lineItemId === undefined) continue;
    if (fact.provenance.sourceType !== "unified_statements") continue;
    spineByCell.set(cellKey(fact.lineItemId, fact.periodId), fact);
  }
  if (spineByCell.size === 0) return;
  snapshot.reconciliationResults = snapshot.reconciliationResults.map((result) => {
    if (result.status !== "failed") return result;
    const unifiedTrail = result.refs.flatMap((ref) => {
      const concept = spineByCell.get(ref)?.provenance.concept;
      return concept === undefined || concept === ""
        ? []
        : [{ lineItemId: splitCellKey(ref as CellKey).lineItemId, rowIds: concept.split("+") }];
    });
    return unifiedTrail.length > 0 ? { ...result, unifiedTrail } : result;
  });
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
    warnings: sortDiagnostics(revision.snapshot.diagnostics),
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
