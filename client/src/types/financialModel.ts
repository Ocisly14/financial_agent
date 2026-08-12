// Hand-written mirror of the server's financial-model view types.
//
// The client bundle deliberately imports nothing from `src/` (see the note at
// the top of core.ts), so these shapes are duplicated rather than shared. The
// tripwire against drift is server-side:
// `src/financial-model/__tests__/viewContract.test.ts` asserts every key below
// exists on a real model's JSON.
//
// Only the fields the UI reads are mirrored. Extra server fields are harmless.

export type Unit =
  | { kind: "currency"; code: string }
  | { kind: "percent" }
  | { kind: "ratio" }
  | { kind: "shares" }
  | { kind: "per_share"; code: string }
  | { kind: "number" };

export type PeriodClass = "actual" | "ttm" | "forecast";

export type Period = {
  id: string;
  label: string;
  start: string;
  end: string;
  cls: PeriodClass;
};

export type Diagnostic = {
  code: "missing_input" | "divide_by_zero" | "skipped_ttm" | "not_applicable";
  refs: string[];
};

export type CellSource = "actual" | "assumption" | "formula" | "calculated" | "none";

export type WorkbookCellStatus = "ok" | "missing_input" | "divide_by_zero" | "not_applicable" | "not_modeled";

export type WorkbookCellSource =
  | { kind: "fact"; factId: string }
  | { kind: "assumption"; assumptionId: string }
  | { kind: "formula"; definitionIndex: number }
  | { kind: "calculated"; output: string }
  | { kind: "none" };

export type WorkbookCellView = {
  value: number | null;
  status: WorkbookCellStatus;
  source: WorkbookCellSource;
  diagnostics: Diagnostic[];
  /** Exact cells read by this formula at this period; empty for facts and assumptions. */
  dependencies: Array<{ lineItemId: string; periodId: string }>;
};

export type AssumptionPayload =
  | { kind: "values"; values: number[]; unit: Unit }
  | { kind: "not_applicable" };

// NOTE the shape: `periods` (plural) + a `payload` union carrying a values
// ARRAY parallel to it — not one period with one value. Provenance is flat and
// required, not a nested optional object.
export type Assumption = {
  assumptionId: string;
  lineItemId: string;
  periods: string[];
  payload: AssumptionPayload;
  sourceType: string;
  sourceRefs: string[];
  asOfDate: string;
  rationale: string;
};

export type DcfWorkbookSection = "history" | "metrics" | "revenue" | "operations" | "dcf";

export type WorkbookRowView = {
  lineItemId: string;
  label: string;
  parentId?: string;
  section: DcfWorkbookSection;
  role: string;
  unit: Unit;
  order: number;
  sources: { historical: CellSource; forecast: CellSource };
  formulas: Array<{ appliesTo: "historical" | "forecast"; periodIds: string[]; source: string }>;
  assumptions: Assumption[];
  cells: Record<string, WorkbookCellView>;
  description?: string;
};

export type SourceStatementKey = "income_statement" | "balance_sheet" | "cash_flow_statement";

export type SourceStatementRowView = {
  sourceLineItemId: string;
  label: string;
  unit: Unit;
  cells: Record<string, WorkbookCellView>;
};

// A discriminated union on the server. `identity` exists ONLY on the
// accounting_identity arm — category reconciliations (the ones a
// DcfCategoryGroup produces) have no identity at all, so any UI label must
// narrow on `kind` first.
type ReconciliationValues = {
  ruleId: string;
  periodId: string;
  status: "passed" | "failed" | "insufficient_data" | "not_applicable";
  required: boolean;
  actual: number | null;
  calculated: number | null;
  residual: number | null;
  difference: number | null;
  tolerance: number;
  refs: string[];
};

export type ReconciliationResult =
  | (ReconciliationValues & { kind: "category"; parentLineItemId: string; category: string })
  | (ReconciliationValues & { kind: "accounting_identity"; identity: string; parentLineItemId: string });

// NOTE: statement mapping was deleted from the engine in commit 02682e2
// ("remove the statement-mapping legacy"). There is no activeMappings /
// proposedMappings / diagnostics here any more — do not add them back.
export type SourceStatementReviewView = {
  selectedPeriodIds: string[];
  sheets: Record<SourceStatementKey, SourceStatementRowView[]>;
  reconciliations: ReconciliationResult[];
};

export type DcfCategoryGroup = {
  parentLineItemId: string;
  category: string;
  periodIds: string[];
  members: Array<{ lineItemId: string; treatment: "add" | "subtract" | "exclude" }>;
  reviewDecisionId: string;
};

export type WaccSheetRow = {
  rowId: string;
  label: string;
  unit: Unit;
  source: "computed" | "agent" | "locked_formula" | "empty";
  value: number | null;
  formulaSource?: string;
  provenance?: { sourceType: string; sourceRefs: string[]; asOfDate: string; rationale: string };
  missingInputs: string[];
};

export type WaccSheet = { asOfDate: string; rows: WaccSheetRow[] };

export type ExplicitPeriodValue = {
  periodId: string;
  fcff: number;
  wacc: number;
  discountFactor: number;
  presentValue: number;
};

export type BridgeAdjustment = {
  lineItemId: string;
  role: string;
  sign: 1 | -1;
  status: "numeric" | "not_applicable";
  value: number | null;
  appliedAdjustment: number;
  refs: string[];
};

// Field names verified against src/financial-model/valuation.ts: the terminal
// present value is `terminalPresentValue` and the per-share number is
// `impliedValuePerShare`. Do not rename them to something that reads better.
export type TerminalMethodResult = {
  method: "perpetuity_growth" | "exit_multiple";
  explicitPeriods: ExplicitPeriodValue[];
  terminalValue: number;
  terminalPresentValue: number;
  terminalValuePercentOfEnterpriseValue: number;
  enterpriseValue: number;
  bridge: BridgeAdjustment[];
  equityValue: number;
  dilutedShares: number;
  impliedValuePerShare: number;
};

// The matrix holds CELL OBJECTS, not bare numbers: reading values[i][j] as a
// number is the mistake this comment exists to prevent.
export type SensitivityCell = {
  rowDelta: number;
  columnDelta: number;
  impliedValuePerShare: number | null;
};

export type SensitivityMatrix = {
  rowVariable: "wacc_delta";
  columnVariable: "terminal_growth_delta" | "exit_multiple_delta";
  rowDeltas: number[];
  columnDeltas: number[];
  cells: SensitivityCell[][];
};

export type ValuationOutput = {
  explicitPeriods: ExplicitPeriodValue[];
  perpetuityGrowth: TerminalMethodResult;
  exitMultiple: TerminalMethodResult;
  waccByGrowth: SensitivityMatrix;
  waccByMultiple: SensitivityMatrix;
};

export type LifecycleStage =
  | "draft" | "history_committed" | "revenue_forecast" | "operations_fcff" | "valued" | "archived";

export type RevisionSummary = {
  revision: number;
  parentRevision: number | null;
  lifecycleStage: LifecycleStage;
  createdAt: string;
  changes: Array<{ kind: string } & Record<string, unknown>>;
  changedSections: string[];
  warningCount: number;
  blockerCount: number;
};

export type ModelView = {
  modelId: string;
  ownerAgentId: string;
  originSessionId: string;
  symbol: string;
  metadata: Record<string, unknown>;
  currentRevision: number;
  lifecycleStage: LifecycleStage;
  updatedAt: string;
  createdAt: string;
};

type CurrentWorkbookBase = {
  modelId: string;
  revision: number;
  lifecycleStage: LifecycleStage;
  periods: Period[];
  sections: Record<DcfWorkbookSection, WorkbookRowView[]>;
  categoryGroups: DcfCategoryGroup[];
  reconciliationResults: ReconciliationResult[];
  diagnostics: Diagnostic[];
  valuation: ValuationOutput | null;
  waccSheet: WaccSheet | null;
};

// Keep the server's discriminated union rather than flattening it to an
// optional field: `mode: "dcf"` GUARANTEES there is no source review, and a
// flattened optional lets a component reach for `sourceStatementReview!`
// without narrowing and fail only at runtime.
export type CurrentWorkbookView = CurrentWorkbookBase & (
  | { mode: "statement_mapping"; sourceStatementReview: SourceStatementReviewView }
  | { mode: "dcf"; sourceStatementReview?: never }
);

export type ModelContextView = {
  model: ModelView;
  revisionHistory: RevisionSummary[];
  currentWorkbook: CurrentWorkbookView;
};

/** The SSE frame projected in `src/infra/events/sseProjector.ts`. */
export type ModelRevisionFrame = {
    /** The producing tool's say in whether this belongs on screen. Defaults to
     *  `focus` server-side; only ever acted on the first time a given model
     *  appears, so a long build cannot repeatedly yank the view. */
    display: "focus" | "silent";
  model_id: string;
  revision: number;
  lifecycle_stage: string;
  changed_sections: string[];
  changed_line_item_ids: string[];
  changed_period_ids: string[];
  change_kinds: string[];
};
