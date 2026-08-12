/** Percentages are stored as decimal fractions: 0.12 means 12%. Presentation
 * converts; arithmetic never does. */
export type Unit =
  | { kind: "currency"; code: string }
  | { kind: "percent" }
  | { kind: "ratio" }
  | { kind: "shares" }
  | { kind: "per_share"; code: string }
  | { kind: "number" };

export type PeriodClass = "actual" | "ttm" | "forecast";

export type LifecycleStage =
  | "draft"
  | "history_committed"
  | "revenue_forecast"
  | "operations_fcff"
  | "valued"
  | "archived";

export type Period = {
  id: string;
  label: string;
  /** ISO date, inclusive. */
  start: string;
  /** ISO date, inclusive. */
  end: string;
  cls: PeriodClass;
};

export type CellSource = "actual" | "assumption" | "formula" | "calculated" | "none";

export type LineItemSection =
  | "source_income_statement"
  | "source_balance_sheet"
  | "source_cash_flow"
  | "history"
  | "metrics"
  | "revenue"
  | "operations"
  | "dcf";

export type LineItemRole =
  | "revenue_root"
  | "revenue_stream"
  | "revenue_total"
  | "operating_income"
  | "tax_rate"
  | "nopat"
  | "depreciation_amortization"
  | "ebitda"
  | "capex"
  | "operating_working_capital"
  | "change_nwc"
  | "fcff"
  | "wacc"
  | "terminal_growth"
  | "exit_multiple"
  | "cash_available_for_bridge"
  | "non_operating_investments"
  | "debt"
  | "lease_liabilities"
  | "preferred_equity"
  | "non_controlling_interests"
  | "bridge_other"
  | "diluted_shares"
  | "none";

export type LineItem = {
  id: string;
  label: string;
  parentId?: string;
  /** Immutable once created. Valuation binds rows by role, never by string id. */
  role: LineItemRole;
  unit: Unit;
  section: LineItemSection;
  order: number;
  /** Source in historical periods. */
  historical: CellSource;
  /** Source in forecast periods. */
  forecast: CellSource;
  /** Free-text explanation of what the row means; primarily used for Agent-authored custom rows. */
  description?: string;
};

export type StatementKind =
  | "income_statement"
  | "balance_sheet"
  | "cash_flow_statement";

export type PreparedStatementRow = {
  sourceLineItemId: string;
  statement: StatementKind;
  label: string;
  unit: Unit;
  order: number;
};

export type NewDcfCategoryLineItem = {
  id: string;
  label: string;
  parentLineItemId: string;
};

export type Provenance = {
  sourceType: string;
  sourceRefs: string[];
  asOfDate: string;
  /** XBRL `decimals` when known; drives the reconciliation tolerance. */
  decimals?: number;
  accession?: string;
  concept?: string;
  filingUrl?: string;
  /** True when deterministic sign orientation negated at least one source value. */
  signFlipped?: boolean;
};

export type FactStatus = "staged" | "committed" | "rejected" | "superseded";

export type Fact = {
  factId: string;
  status: FactStatus;
  lineItemId?: string;
  periodId: string;
  value: number;
  unit: Unit;
  provenance: Provenance;
  supersedesFactId?: string;
};

export type ActiveFact = Fact & {
  status: "committed";
  lineItemId: string;
};

export type FactReviewDecision = {
  decisionId: string;
  factId: string;
  action: "commit" | "reject" | "supersede";
  /** Required for commit; records the accepted candidate mapping. */
  mappedLineItemId?: string;
  /** Required only when action is supersede. */
  replacementFactId?: string;
  rationale: string;
  reviewedBy: string;
  reviewedAt: string;
};

export type AssumptionSourceType =
  | "user"
  | "management_guidance"
  | "company_disclosure"
  | "consensus"
  | "macro_research"
  | "industry_research"
  | "analyst_inference";

export type AssumptionPayload =
  | { kind: "values"; values: number[]; unit: Unit }
  | { kind: "not_applicable" };

export type Assumption = {
  assumptionId: string;
  lineItemId: string;
  periods: string[];
  payload: AssumptionPayload;
  sourceType: AssumptionSourceType;
  sourceRefs: string[];
  asOfDate: string;
  rationale: string;
};

/**
 * A reviewed disclosure/category identity inside the canonical DCF workbook.
 *
 * `category` is deliberately not an enum: an Agent may preserve the company's
 * own segment, geography, product, or other disclosure vocabulary. Groups are
 * independent even when they reconcile to the same parent row.
 */
export type DcfCategoryGroup = {
  parentLineItemId: string;
  category: string;
  periodIds: string[];
  members: Array<{
    lineItemId: string;
    treatment: "add" | "subtract" | "exclude";
  }>;
  reviewDecisionId: string;
};

export type ReconciliationStatus =
  | "passed"
  | "failed"
  | "insufficient_data"
  | "not_applicable";

export type AccountingIdentity =
  | "gross_profit"
  | "operating_expenses_detail"
  | "operating_income"
  | "ebitda"
  | "pretax_income"
  | "net_income"
  | "nopat"
  | "operating_working_capital"
  | "change_nwc"
  | "fcff";

type ReconciliationValues = {
  /** Stable registry or DCF-category business key; never a caller plan ID. */
  ruleId: string;
  periodId: string;
  status: ReconciliationStatus;
  /** Only `required && status === "failed"` is a history-gate blocker. */
  required: boolean;
  /** Stored parent-row value. Null when that required value is unavailable. */
  actual: number | null;
  /** Independently calculated identity or signed-member value. */
  calculated: number | null;
  /** `actual - calculated`; null unless both sides are available. */
  residual: number | null;
  /** Alias required by the persisted reconciliation contract. */
  difference: number | null;
  /** Deterministic comparison tolerance, including for incomplete results. */
  tolerance: number;
  /** Parent and included DCF cell coordinates in calculation order. */
  refs: string[];
  /**
   * Only on a failed check: for each canonical cell in `refs`, the unified statement rows its
   * committed spine fact was summed from, read off that fact's provenance. This is the repair
   * trail — feed the rowIds to get_unified_rows to see the inputs behind a broken identity.
   */
  unifiedTrail?: Array<{ lineItemId: string; rowIds: string[] }>;
};

export type ReconciliationResult =
  | (ReconciliationValues & {
      kind: "category";
      parentLineItemId: string;
      category: string;
      reviewDecisionId: string;
    })
  | (ReconciliationValues & {
      kind: "accounting_identity";
      identity: AccountingIdentity;
      parentLineItemId: string;
    });


type DiscountConvention = "year_end" | "mid_year";

export type ValuationSensitivity = {
  waccDeltas: number[];
  terminalGrowthDeltas: number[];
  exitMultipleDeltas: number[];
};

/**
 * The three judgment fields start null and stay null until the agent sets them: which metric the
 * exit multiple applies to, when cash is assumed to arrive, and what to stress are decisions the
 * engine has no basis to make. A default would read back as a decision nobody took — so the
 * valuation simply does not compute until all three are filled, the same way the WACC sheet's
 * `wacc` row does not resolve until its own inputs are. `anchorPeriodId` is not a judgment: the
 * bridge anchors at the last actual period, which the engine derives unambiguously.
 */
export type ValuationConfig = {
  anchorPeriodId: string;
  discountConvention: DiscountConvention | null;
  exitTerminalMetric: "ebitda" | "fcff" | null;
  sensitivity: ValuationSensitivity | null;
  /** Provenance exists only once an agent has actually set the configuration. */
  sourceType?: "user" | "analyst_inference";
  sourceRefs?: string[];
  asOfDate?: string;
  rationale?: string;
};

/** A configuration with every judgment made — what `calculateValuation` requires. */
export type ResolvedValuationConfig = ValuationConfig & {
  discountConvention: DiscountConvention;
  exitTerminalMetric: "ebitda" | "fcff";
  sensitivity: ValuationSensitivity;
};

export type Diagnostic = {
  code: "missing_input" | "divide_by_zero" | "skipped_ttm" | "not_applicable"
    | "history_review_required" | "unresolved_reconciliation" | "missing_formula_input"
    | "invalid_terminal_assumptions" | "incomplete_equity_bridge";
  /** Cell keys or line-item ids responsible, for audit trace-back. */
  refs: string[];
  /** Present for a lifecycle blocker that did not originate in one engine cell. */
  message?: string;
  /** Present when a lifecycle gate, rather than an individual engine cell, raised the diagnostic. */
  stage?: LifecycleStage;
};

/** value === null means missing. It is never 0. */
export type Cell = { value: number | null; unit: Unit; diagnostics: Diagnostic[] };
