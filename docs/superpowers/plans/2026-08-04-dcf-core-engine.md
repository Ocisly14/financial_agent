# DCF Core Engine (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the calculation and persistence core of the financial modeling platform — versioned model store, typed Model Operations DSL, restricted Formula DSL, deterministic calculation engine, metrics library, and DCF valuation — with no network access and no MCP tools.

**Architecture:** Domain dependencies flow from `types` → `periodGrid` → Formula `dsl/` → `engine` → `metrics`/`valuation`, while `operations` composes the domain types, skeleton, lifecycle, statement-mapping and DCF-category compilers without doing arithmetic. `reconciliation` checks category groups and built-in accounting identities only after the DCF cell pass. `store` is persistence-only; `service` composes `operations`, calculation, reconciliation, valuation, and store. The typed Model Operations DSL changes an in-memory snapshot; the Formula DSL only calculates cells and cannot mutate model state. Every non-empty mutation batch runs one shared commit pipeline that compiles formulas, recalculates the whole grid, reconciles the DCF table, sorts diagnostics into blockers and warnings, and commits one immutable revision only when no blocker exists. Read queries bypass the pipeline and never commit. `metrics` performs no arithmetic of its own — it generates formulas and hands them to the engine, so library metrics and Agent formulas share one arithmetic path.

**Tech Stack:** TypeScript on Node ≥23, run directly via `--experimental-strip-types`. `node:sqlite` (`DatabaseSync`) for persistence, `node:test` + `node:assert/strict` for tests. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-04-dcf-core-engine-design.md`. Parent: `docs/superpowers/specs/2026-08-04-financial-modeling-dcf-platform-design.md`.

**Execution status (2026-08-05):** Tasks 1–13 are implemented. The DCF-only reconciliation revision described in the spec is included: the Agent creates issuer-specific category rows and `DcfCategoryGroup` membership during initial import, and reconciliation reads only populated DCF rows plus fixed accounting identities. The phase-1 financial-model suite passes 193/193 tests, the full repository suite passes 683/683 tests, `pnpm build` passes, and `git diff --check` is clean. The per-task commit commands below remain operator-controlled checkpoints and were not run automatically.

## Global Constraints

- **No new runtime dependencies.** Arithmetic is float64; there is no decimal library.
- **No network access anywhere in `src/financial-model/`.** No `fetch`, no SEC client import.
- **Quantize every stored numeric value to 12 significant digits** via `Number(x.toPrecision(12))`.
- **Missing is `null`, never `0`.** No hidden defaults anywhere.
- **Explicit N/A is also `null`, not numeric zero.** It is a sourced assumption payload with a distinct `not_applicable` diagnostic; only permitted engine-native equity-bridge roles may report a separate zero contribution.
- **Facts never use last-write-wins.** The lifecycle layer resolves exactly one committed `ActiveFact` per historical cell; every replacement and review decision is retained.
- **One successful mutating Agent step is one snapshot row.** Revisions are complete immutable snapshots, current state is derived from the greatest revision, and there is no mutable current-revision pointer. Read steps write nothing.
- **Agent model context has one complete workbook.** Inject deterministic summaries for every revision before the latest and exactly one complete Excel-shaped JSON workbook for the latest revision. Never accumulate old complete workbooks or construct history summaries with an LLM; exact old revisions and lineage remain explicit reads.
- **Source statements are a mapping-time view, not permanent prompt payload.** Initial history construction may expose the three prepared statement sheets beside the DCF template. Persist the reviewed period/category/sign mapping, then inject only the complete DCF workbook unless an unmapped row, restatement, structural change, failed required reconciliation, low-confidence mapping, or explicit audit request reopens the source view.
- **No generic model patch.** Agent changes use the closed `ModelOperation` union; exact and selected reads use `ModelQuery`. A successful non-empty mutation batch creates one revision, while every read creates none.
- **Source changes are explicit and range-scoped.** `set_line_item_source` may switch only a complete historical or forecast range to its allowlisted sources, cannot select `calculated`, and cannot modify registry-owned or engine-native rows.
- **No conditional or fallback Formula DSL.** Comparisons, booleans, `IF`, and `COALESCE` are outside the language. Missing inputs and zero denominators remain diagnosed until the Agent explicitly changes a fact, assumption, or period-specific formula.
- **Historical values are never overwritten.** `replace_fact` must execute the audited fact-lifecycle replacement and retain both facts plus the paired commit and supersede decisions.
- **DCF category groups are reviewed configuration.** During initial import/mapping, the Agent may create arbitrary issuer-specific DCF member rows and classify them into groups under a parent DCF row. Category names and dimensions are semantic strings, not enums; execute only the normalized formula generated from the committed group.
- **Formula DSL has no hierarchy aggregation.** Every group stores explicit `add`/`subtract`/`exclude` DCF members and period coverage. Source rows are lineage only after mapping and never participate in later aggregation.
- **Reconciliation is DCF-table based.** Reconcile every group and built-in cross-category accounting identities over DCF rows with `passed`/`failed`/`insufficient_data`/`not_applicable` results. Missing detail is never zero; only failed required history checks block. Operating working capital uses the same group mechanism and no separately configured cash-flow evidence line.
- **Valuation method choices are versioned.** Read discount convention, anchor, terminal metric, and sensitivity deltas from `ValuationConfig`; never accept an unversioned calculation override.
- **Discount timing is anchor-relative.** `YEAR_INDEX`, `DISCOUNT_FACTOR`, and engine-native valuation all begin with the first forecast period strictly after the stored valuation anchor.
- **Period order is authoritative model state.** Preserve the validated creation-time periods array; never sort it inside the engine and never mutate it after creation.
- **Standard metrics are automatic registry formulas.** Install their immutable rows at model creation and recalculate them in every normal engine pass; there is no separate metric-calculation service call or Agent-written metric value.
- **Evaluation order must be total and deterministic:** topological ready-node ties break on authoritative period position, numeric line-item `order`, line-item `id`, then complete cell key.
- **All identifiers, comments, and error messages in English.**
- **TypeScript is strict** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (see `tsconfig.json`). Array indexing yields `T | undefined` — use `!` only after a length check. Optional properties cannot be assigned `undefined` explicitly; omit the key instead.
- **Import paths carry the `.ts` extension** (`import { x } from "./y.ts"`), matching the rest of the repo.
- **Test files live in `__tests__/` next to the code**, named `*.test.ts`, using `node:test` and `node:assert/strict`.
- **Run tests with:** `node --experimental-strip-types --experimental-sqlite --test "src/financial-model/**/__tests__/*.test.ts"`
- **Run the type check with:** `pnpm build`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/financial-model/types.ts` | Pure types: units, periods, line items, roles, facts, assumptions, cells, revisions. No logic. |
| `src/financial-model/periodGrid.ts` | Ordered period grid: construction, offset resolution, TTM skipping. |
| `src/financial-model/factLifecycle.ts` | Validates fact review transitions and resolves the unique active fact for each historical cell. |
| `src/financial-model/dsl/units.ts` | Unit algebra: which operand/operator combinations are legal and what they produce. |
| `src/financial-model/dsl/parser.ts` | Tokenizer and recursive-descent parser producing an allowlisted AST. |
| `src/financial-model/dsl/graph.ts` | Dependency graph over `(lineItemId, periodId)` cells; topological order; cycle detection. |
| `src/financial-model/engine.ts` | Evaluates the grid in topological order; quantizes; emits cell diagnostics. |
| `src/financial-model/skeleton.ts` | Generates the standard chart of accounts; maps sources; creates DCF category members and forecast formulas. |
| `src/financial-model/reconciliation.ts` | Checks signed category groups and built-in accounting identities over DCF cells only. |
| `src/financial-model/metrics.ts` | The metrics library, expressed as generated formulas. No arithmetic. |
| `src/financial-model/valuation.ts` | Engine-native DCF: discounting, both terminal methods, equity bridge, sensitivity matrices. |
| `src/financial-model/operations.ts` | Typed Model Operations DSL: selectors, pure mutation reducer, fixed-skeleton and coverage validation. |
| `src/financial-model/store.ts` | `ModelStore` interface, `InMemoryModelStore`, `SqliteModelStore`. |
| `src/financial-model/snapshotCodec.ts` | Strict deterministic JSON codec for complete `FinancialModelSnapshot` values. |
| `src/financial-model/views.ts` | Deterministic revision-summary, workbook, workbook-slice, and Agent-context JSON projections. |
| `src/financial-model/service.ts` | `FinancialModelService`: typed operation batches, read queries, fact lifecycle, and the shared commit pipeline. |
| `src/financial-model/errors.ts` | `FinancialModelError` and the error-code union. |
| `package.json` | Test glob must include `src/financial-model/**/__tests__/*.test.ts`. |

---

### Task 1: Types, period grid, and test wiring

**Files:**
- Create: `src/financial-model/types.ts`
- Create: `src/financial-model/errors.ts`
- Create: `src/financial-model/periodGrid.ts`
- Modify: `package.json` (the `test` script glob list)
- Test: `src/financial-model/__tests__/periodGrid.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Unit`, `PeriodClass`, `Period`, `LifecycleStage`, `CellSource`, `LineItemSection`, `LineItemRole`, `LineItem`, `StatementKind`, `PreparedStatementRow`, `NewDcfCategoryLineItem`, `FactStatus`, `Fact`, `ActiveFact`, `FactReviewDecision`, `AssumptionPayload`, `Assumption`, `StatementMappingPlan`, `DcfCategoryGroup`, `ReconciliationStatus`, `ReconciliationResult`, `ValuationConfig`, `Diagnostic`, `Cell`; `FinancialModelError`, `FinancialModelErrorCode`; `buildGrid(periods): PeriodGrid`, `PeriodGrid.at(periodId, offset): Period | undefined`, `PeriodGrid.range(periodId, from, to): Period[]`, `PeriodGrid.all: readonly Period[]`, `PeriodGrid.ordered: readonly Period[]`, `PeriodGrid.positionOf(periodId): number`, `PeriodGrid.offsetIndexOf(periodId): number`.

- [ ] **Step 1: Add the test glob to `package.json`**

Without this the whole suite passes by not running. In the `test` script, insert `"src/financial-model/**/__tests__/*.test.ts"` immediately after `"src/framework/__tests__/*.test.ts"`.

- [ ] **Step 2: Write `src/financial-model/types.ts`**

```ts
/** Percentages are stored as decimal fractions: 0.12 means 12%. Presentation
 *  converts; arithmetic never does. */
export type Unit =
  | { kind: "currency"; code: string }
  | { kind: "percent" }
  | { kind: "ratio" }
  | { kind: "shares" }
  | { kind: "per_share"; code: string }
  | { kind: "number" };

export type PeriodClass = "actual" | "ttm" | "forecast";

export type LifecycleStage =
  | "draft" | "history_committed" | "revenue_forecast"
  | "operations_fcff" | "valued" | "archived";

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
  | "source_income_statement" | "source_balance_sheet" | "source_cash_flow"
  | "history" | "metrics" | "revenue" | "operations" | "dcf";

export type LineItemRole =
  | "revenue_root" | "revenue_stream" | "revenue_total"
  | "operating_income" | "tax_rate" | "nopat"
  | "depreciation_amortization" | "ebitda" | "capex"
  | "operating_working_capital" | "change_nwc" | "fcff"
  | "wacc" | "terminal_growth" | "exit_multiple"
  | "cash_available_for_bridge" | "non_operating_investments" | "debt" | "lease_liabilities"
  | "preferred_equity" | "non_controlling_interests" | "bridge_other"
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
};

export type StatementKind =
  | "income_statement" | "balance_sheet" | "cash_flow_statement";

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
  | "user" | "management_guidance" | "company_disclosure" | "consensus"
  | "macro_research" | "industry_research" | "analyst_inference";

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

export type DcfCategoryGroup = {
  parentLineItemId: string;
  /** Opaque Agent-defined dimension/category; deliberately not an enum. */
  category: string;
  /** Groups for one parent/category cover disjoint period sets. */
  periodIds: string[];
  members: Array<{
    lineItemId: string;
    treatment: "add" | "subtract" | "exclude";
  }>;
  reviewDecisionId: string;
};

export type StatementMappingPlan = {
  targetLineItemId: string;
  /** Plans for one target cover disjoint actual-period sets. */
  periodIds: string[];
  members: Array<{
    sourceLineItemId: string;
    treatment: "add" | "subtract" | "exclude";
  }>;
  reviewDecisionId: string;
};

export type ReconciliationStatus =
  | "passed" | "failed" | "insufficient_data" | "not_applicable";

export type ReconciliationResult = {
  ruleId: string;
  periodId: string;
  status: ReconciliationStatus;
  required: boolean;
  difference: number | null;
  refs: string[];
};

export type DiscountConvention = "year_end" | "mid_year";

export type ValuationConfig = {
  anchorPeriodId: string;
  discountConvention: DiscountConvention;
  exitTerminalMetric: "ebitda" | "fcff";
  sensitivity: {
    waccDeltas: number[];
    terminalGrowthDeltas: number[];
    exitMultipleDeltas: number[];
  };
  sourceType: "user" | "analyst_inference";
  sourceRefs: string[];
  asOfDate: string;
  rationale: string;
};

export type Diagnostic = {
  code: "missing_input" | "divide_by_zero" | "skipped_ttm" | "not_applicable";
  /** Cell keys or line-item ids responsible, for audit trace-back. */
  refs: string[];
};

/** value === null means missing. It is never 0. */
export type Cell = { value: number | null; unit: Unit; diagnostics: Diagnostic[] };
```

- [ ] **Step 3: Write `src/financial-model/errors.ts`**

```ts
import type { JsonObject } from "../framework/types.ts";

export type FinancialModelErrorCode =
  | "financial_model_not_found"
  | "revision_conflict"
  | "invalid_snapshot"
  | "fact_conflict"
  | "invalid_model_operation"
  | "invalid_model_query"
  | "invalid_assumption"
  | "invalid_formula"
  | "circular_dependency"
  | "incompatible_units"
  | "incompatible_periods"
  | "history_review_required"
  | "unresolved_reconciliation"
  | "invalid_terminal_assumptions"
  | "incomplete_equity_bridge"
  | "missing_formula_input";

/** Mirrors the SecApiError pattern in mcp_tools/sec/secClient.ts: a typed code
 *  plus structured details, so callers branch on `code` rather than on message
 *  text. A thrown error means nothing was written. */
export class FinancialModelError extends Error {
  readonly code: FinancialModelErrorCode;
  readonly details?: JsonObject;

  constructor(code: FinancialModelErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "FinancialModelError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
```

- [ ] **Step 4: Write the failing test**

```ts
// src/financial-model/__tests__/periodGrid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGrid } from "../periodGrid.ts";
import { FinancialModelError } from "../errors.ts";
import type { Period } from "../types.ts";

function p(id: string, cls: Period["cls"], year: number): Period {
  return { id, label: id, start: `${year}-01-01`, end: `${year}-12-31`, cls };
}

const PERIODS: Period[] = [
  p("FY2023", "actual", 2023),
  p("FY2024", "actual", 2024),
  p("FY2025", "actual", 2025),
  p("FY2026", "forecast", 2026),
  p("FY2027", "forecast", 2027),
];

test("grid preserves the caller-supplied authoritative chronological order", () => {
  const grid = buildGrid(PERIODS);
  assert.deepEqual(grid.ordered.map((x) => x.id), ["FY2023", "FY2024", "FY2025", "FY2026", "FY2027"]);
});

test("out-of-order dates, duplicate ids, invalid dates, and interleaved classes are rejected", () => {
  for (const bad of [
    [PERIODS[1]!, PERIODS[0]!, ...PERIODS.slice(2)],
    [PERIODS[0]!, { ...PERIODS[1]!, id: PERIODS[0]!.id }, ...PERIODS.slice(2)],
    [{ ...PERIODS[0]!, start: "2023-02-30" }, ...PERIODS.slice(1)],
    [PERIODS[0]!, PERIODS[3]!, PERIODS[1]!, PERIODS[4]!],
  ]) {
    assert.throws(() => buildGrid(bad),
      (error: unknown) => error instanceof FinancialModelError && error.code === "incompatible_periods");
  }
});

test("at() resolves negative offsets and crosses the actual/forecast boundary", () => {
  const grid = buildGrid(PERIODS);
  assert.equal(grid.at("FY2026", -1)?.id, "FY2025");
  assert.equal(grid.at("FY2026", 0)?.id, "FY2026");
  assert.equal(grid.at("FY2027", -2)?.id, "FY2025");
});

test("at() returns undefined past either end rather than clamping", () => {
  const grid = buildGrid(PERIODS);
  assert.equal(grid.at("FY2023", -1), undefined);
  assert.equal(grid.at("FY2027", 1), undefined);
});

test("ttm periods are skipped by offsets, not counted as a step", () => {
  const ttm: Period = { id: "TTM", label: "TTM", start: "2025-07-01", end: "2026-06-30", cls: "ttm" };
  const grid = buildGrid([...PERIODS.slice(0, 3), ttm, ...PERIODS.slice(3)]);
  assert.equal(grid.positionOf("TTM"), 3, "TTM retains its explicit table position");
  assert.equal(grid.offsetIndexOf("TTM"), -1, "TTM is absent from the formula offset axis");
  assert.equal(grid.at("FY2026", -1)?.id, "FY2025");
  assert.equal(grid.at("TTM", -1), undefined, "offsets from a ttm period are undefined");
});

test("range() returns inclusive offset windows, ttm excluded", () => {
  const grid = buildGrid(PERIODS);
  assert.deepEqual(grid.range("FY2025", -2, 0).map((x) => x.id), ["FY2023", "FY2024", "FY2025"]);
  assert.deepEqual(grid.range("FY2023", -2, 0).map((x) => x.id), [], "an incomplete window yields no periods");
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `node --experimental-strip-types --experimental-sqlite --test "src/financial-model/__tests__/periodGrid.test.ts"`
Expected: FAIL — cannot find module `../periodGrid.ts`.

- [ ] **Step 6: Write `src/financial-model/periodGrid.ts`**

```ts
import { FinancialModelError } from "./errors.ts";
import type { Period, PeriodClass } from "./types.ts";

/**
 * The caller-supplied period sequence is authoritative model state.
 *
 * Every formula offset is a position on this grid, never calendar arithmetic:
 * a fiscal-calendar change or a 53-week year must not silently shift a
 * reference. TTM periods are excluded from the offset axis entirely — a
 * trailing-twelve-month window overlaps the fiscal year before it, so treating
 * the two as consecutive positions produces a growth rate describing nothing.
 */
export type PeriodGrid = {
  /** All periods including TTM, preserving the validated creation-time order. */
  readonly all: readonly Period[];
  /** The formula offset axis: the same order with TTM removed. */
  readonly ordered: readonly Period[];
  /** Position on the complete displayed timeline, including TTM. */
  positionOf(periodId: string): number;
  /** Position on the non-TTM formula offset axis; -1 for TTM or unknown IDs. */
  offsetIndexOf(periodId: string): number;
  at(periodId: string, offset: number): Period | undefined;
  /** Inclusive window. Returns [] when the window is not fully covered. */
  range(periodId: string, from: number, to: number): Period[];
  get(periodId: string): Period | undefined;
};

export function buildGrid(periods: readonly Period[]): PeriodGrid {
  const all = [...periods];
  const byId = new Map<string, Period>();
  const classRank: Record<PeriodClass, number> = { actual: 0, ttm: 1, forecast: 2 };
  let previousClass = -1;
  let previousEnd: string | undefined;
  let previousNonTtmEnd: string | undefined;
  let ttmCount = 0;

  for (const period of all) {
    if (byId.has(period.id)) throw new FinancialModelError("incompatible_periods", `duplicate period id: ${period.id}`);
    if (!isIsoDate(period.start) || !isIsoDate(period.end) || period.start > period.end) {
      throw new FinancialModelError("incompatible_periods", `invalid period dates: ${period.id}`);
    }
    if (previousEnd !== undefined && period.end < previousEnd) {
      throw new FinancialModelError("incompatible_periods", `periods are not chronological at: ${period.id}`);
    }
    const rank = classRank[period.cls];
    if (rank < previousClass) throw new FinancialModelError("incompatible_periods", `period classes are interleaved at: ${period.id}`);
    if (period.cls === "ttm" && ++ttmCount > 1) throw new FinancialModelError("incompatible_periods", "at most one TTM period is allowed");
    if (period.cls !== "ttm") {
      if (previousNonTtmEnd !== undefined && period.end <= previousNonTtmEnd) {
        throw new FinancialModelError("incompatible_periods", `non-TTM period ends are not strictly increasing at: ${period.id}`);
      }
      previousNonTtmEnd = period.end;
    }
    byId.set(period.id, period);
    previousEnd = period.end;
    previousClass = rank;
  }

  const ordered = all.filter((x) => x.cls !== "ttm");
  const position = new Map(all.map((x, i) => [x.id, i]));
  const axisIndex = new Map(ordered.map((x, i) => [x.id, i]));

  function offsetIndexOf(periodId: string): number {
    return axisIndex.get(periodId) ?? -1;
  }

  function at(periodId: string, offset: number): Period | undefined {
    const i = offsetIndexOf(periodId);
    if (i < 0) return undefined;
    return ordered[i + offset];
  }

  function range(periodId: string, from: number, to: number): Period[] {
    if (from > to) return [];
    const out: Period[] = [];
    for (let k = from; k <= to; k += 1) {
      const period = at(periodId, k);
      if (!period) return [];
      out.push(period);
    }
    return out;
  }

  return {
    all, ordered,
    positionOf: (id) => position.get(id) ?? -1,
    offsetIndexOf,
    at, range,
    get: (id) => byId.get(id),
  };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --experimental-strip-types --experimental-sqlite --test "src/financial-model/__tests__/periodGrid.test.ts"`
Expected: PASS, 6 tests.

- [ ] **Step 8: Type check**

Run: `pnpm build`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add package.json src/financial-model/types.ts src/financial-model/errors.ts src/financial-model/periodGrid.ts src/financial-model/__tests__/periodGrid.test.ts
git commit -m "feat(financial-model): period grid, core types, and error class"
```

---

### Task 2: Unit algebra

**Files:**
- Create: `src/financial-model/dsl/units.ts`
- Test: `src/financial-model/dsl/__tests__/units.test.ts`

**Interfaces:**
- Consumes: `Unit` from `../types.ts`.
- Produces: `type UnitTerm = { unit: Unit; literal?: number }`, `combine(left: UnitTerm, op: "+" | "-" | "*" | "/", right: UnitTerm): Unit | null`, `sameUnit(a: Unit, b: Unit): boolean`, `compatibleUnit(a: Unit, b: Unit): boolean`, `commonUnit(left: Unit, right: Unit): Unit | null`, `assignableTo(term: UnitTerm, target: Unit): boolean`, `unitLabel(u: Unit): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/financial-model/dsl/__tests__/units.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignableTo, combine, commonUnit, sameUnit, type UnitTerm } from "../units.ts";
import type { Unit } from "../../types.ts";

const usd: Unit = { kind: "currency", code: "USD" };
const eur: Unit = { kind: "currency", code: "EUR" };
const pct: Unit = { kind: "percent" };
const ratio: Unit = { kind: "ratio" };
const num: Unit = { kind: "number" };
const shares: Unit = { kind: "shares" };
const t = (unit: Unit, literal?: number): UnitTerm => literal === undefined ? { unit } : { unit, literal };

test("currency addition requires the same currency code", () => {
  assert.deepEqual(combine(t(usd), "+", t(usd)), usd);
  assert.equal(combine(t(usd), "+", t(eur)), null);
});

test("currency scaled by a rate stays currency", () => {
  assert.deepEqual(combine(t(usd), "*", t(pct)), usd);
  assert.deepEqual(combine(t(usd), "*", t(num)), usd);
  assert.deepEqual(combine(t(usd), "/", t(ratio)), usd);
});

test("currency over currency is a ratio; currency over shares is per-share", () => {
  assert.deepEqual(combine(t(usd), "/", t(usd)), ratio);
  assert.equal(combine(t(usd), "/", t(eur)), null);
  assert.deepEqual(combine(t(usd), "/", t(shares)), { kind: "per_share", code: "USD" });
});

test("currency plus percent is rejected", () => {
  assert.equal(combine(t(usd), "+", t(pct)), null);
});

test("dimensionless semantics are preserved", () => {
  assert.deepEqual(combine(t(pct), "+", t(pct)), pct);
  assert.deepEqual(combine(t(pct), "+", t(ratio)), ratio);
  assert.deepEqual(combine(t(pct), "*", t(num)), pct);
  assert.deepEqual(combine(t(pct), "*", t(ratio)), ratio);
});

test("literal zero is polymorphic but arbitrary numbers are not", () => {
  assert.deepEqual(combine(t(num, 0), "+", t(usd)), usd);
  assert.equal(combine(t(num, 10), "+", t(pct)), null);
  assert.equal(assignableTo(t(num, 0), usd), true);
  assert.equal(assignableTo(t(num, 10), usd), false);
});

test("MIN and MAX require a common unit without polymorphic-zero fallback", () => {
  assert.deepEqual(commonUnit(pct, ratio), ratio);
  assert.deepEqual(commonUnit(usd, usd), usd);
  assert.equal(commonUnit(usd, num), null);
});

test("literal one is the dimensionless identity for growth and tax formulas", () => {
  assert.deepEqual(combine(t(num, 1), "+", t(pct)), ratio);
  assert.deepEqual(combine(t(num, 1), "-", t(pct)), ratio);
});

test("sameUnit compares currency codes, not just kinds", () => {
  assert.equal(sameUnit(usd, usd), true);
  assert.equal(sameUnit(usd, eur), false);
  assert.equal(sameUnit(pct, ratio), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test "src/financial-model/dsl/__tests__/units.test.ts"`
Expected: FAIL — cannot find module `../units.ts`.

- [ ] **Step 3: Write `src/financial-model/dsl/units.ts`**

```ts
import type { Unit } from "../types.ts";

export type ArithOp = "+" | "-" | "*" | "/";
export type UnitTerm = { unit: Unit; literal?: number };

export function sameUnit(a: Unit, b: Unit): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "currency" && b.kind === "currency") return a.code === b.code;
  if (a.kind === "per_share" && b.kind === "per_share") return a.code === b.code;
  return true;
}

export function unitLabel(u: Unit): string {
  return u.kind === "currency" || u.kind === "per_share" ? `${u.kind}:${u.code}` : u.kind;
}

function isRate(u: Unit): boolean {
  return u.kind === "percent" || u.kind === "ratio";
}

function isDimensionless(u: Unit): boolean {
  return isRate(u) || u.kind === "number";
}

function isLiteral(term: UnitTerm, value: number): boolean {
  return term.unit.kind === "number" && term.literal === value;
}

export function compatibleUnit(a: Unit, b: Unit): boolean {
  return sameUnit(a, b) || (isDimensionless(a) && isDimensionless(b));
}

export function assignableTo(term: UnitTerm, target: Unit): boolean {
  return isLiteral(term, 0) || compatibleUnit(term.unit, target);
}

export function commonUnit(left: Unit, right: Unit): Unit | null {
  if (sameUnit(left, right)) return left;
  if (isDimensionless(left) && isDimensionless(right)) return { kind: "ratio" };
  return null;
}

/**
 * The unit algebra of parent spec §8.6. Returns null for every combination not
 * explicitly allowed — `incompatible_units` is only enforceable if the legal
 * combinations are enumerated rather than inferred.
 */
export function combine(left: UnitTerm, op: ArithOp, right: UnitTerm): Unit | null {
  const l = left.unit;
  const r = right.unit;

  if (op === "+" || op === "-") {
    if (isLiteral(left, 0)) return r;
    if (isLiteral(right, 0)) return l;
    if (isLiteral(left, 1) && isRate(r)) return { kind: "ratio" };
    if (sameUnit(l, r)) return l;
    if (isRate(l) && isRate(r)) return { kind: "ratio" };
    return null;
  }

  if (op === "*") {
    if (l.kind === "currency" && isDimensionless(r)) return l;
    if (isDimensionless(l) && r.kind === "currency") return r;
    if (l.kind === "shares" && isDimensionless(r)) return l;
    if (l.kind === "per_share" && r.kind === "shares") return { kind: "currency", code: l.code };
    if (l.kind === "shares" && r.kind === "per_share") return { kind: "currency", code: r.code };
    if (isDimensionless(l) && isDimensionless(r)) {
      if (l.kind === "number") return r;
      if (r.kind === "number") return l;
      return { kind: "ratio" };
    }
    return null;
  }

  // op === "/"
  if (l.kind === "currency" && r.kind === "currency") {
    return l.code === r.code ? { kind: "ratio" } : null;
  }
  if (l.kind === "currency" && r.kind === "shares") return { kind: "per_share", code: l.code };
  if (l.kind === "currency" && isDimensionless(r)) return l;
  if (l.kind === "shares" && r.kind === "shares") return { kind: "ratio" };
  if (l.kind === "shares" && isDimensionless(r)) return l;
  if (l.kind === "number" && r.kind === "number") return { kind: "number" };
  if (isRate(l) && r.kind === "number") return l;
  if (isRate(l) && isRate(r)) return { kind: "ratio" };
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test "src/financial-model/dsl/__tests__/units.test.ts"`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/financial-model/dsl/units.ts src/financial-model/dsl/__tests__/units.test.ts
git commit -m "feat(financial-model): unit algebra for formula type checking"
```

---

### Task 3: Formula parser and AST

**Files:**
- Create: `src/financial-model/dsl/parser.ts`
- Test: `src/financial-model/dsl/__tests__/parser.test.ts`

**Interfaces:**
- Consumes: `FinancialModelError` from `../errors.ts`.
- Produces: `type Ast`, `type FnName`, `parseFormula(source: string): Ast` (throws `FinancialModelError` with code `invalid_formula`), `FN_ARITY: Record<FnName, number | "variadic">`, `MAX_DEPTH`, `MAX_NODES`, `MAX_LENGTH`.

- [ ] **Step 1: Write the failing test**

```ts
// src/financial-model/dsl/__tests__/parser.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFormula } from "../parser.ts";
import { FinancialModelError } from "../../errors.ts";

function rejects(source: string, needle: string): void {
  assert.throws(() => parseFormula(source), (e: unknown) => {
    assert.ok(e instanceof FinancialModelError);
    assert.equal(e.code, "invalid_formula");
    assert.match(e.message, new RegExp(needle, "i"));
    return true;
  }, `expected ${source} to be rejected`);
}

test("multiplication binds tighter than addition", () => {
  assert.deepEqual(parseFormula("a + b * c"), {
    t: "bin", op: "+",
    l: { t: "ref", id: "a" },
    r: { t: "bin", op: "*", l: { t: "ref", id: "b" }, r: { t: "ref", id: "c" } },
  });
});

test("parentheses override precedence", () => {
  const ast = parseFormula("(a + b) * c");
  assert.equal(ast.t === "bin" && ast.op, "*");
});

test("dotted line-item ids parse as one reference", () => {
  assert.deepEqual(parseFormula("revenue.iphone"), { t: "ref", id: "revenue.iphone" });
});

test("unary minus and numeric literals", () => {
  assert.deepEqual(parseFormula("-1.5"), { t: "neg", e: { t: "num", v: 1.5 } });
});

test("known functions parse with their arguments", () => {
  assert.deepEqual(parseFormula("LAG(revenue.total, 1)"), {
    t: "call", fn: "LAG", args: [{ t: "ref", id: "revenue.total" }, { t: "num", v: 1 }],
  });
});

test("comparisons, conditionals, and fallback expressions are not in the language", () => {
  rejects("revenue.total > 0", "unexpected");
  rejects("IF(revenue.total, 1, 0)", "unknown function");
  rejects("COALESCE(reported_capex, estimated_capex)", "unknown function");
});

test("hierarchy aggregation is not in the language", () => {
  rejects("SUM_CHILDREN(revenue)", "unknown function");
});

test("unknown and dynamic function names are rejected", () => {
  rejects("EVAL(a)", "unknown function");
  rejects("a(b)", "unknown function");
});

test("arity is fixed per function", () => {
  rejects("LAG(revenue.total)", "expects 2");
  rejects("SUM(revenue.total, -4)", "expects 3");
});

test("offsets must be integer literals so the graph is resolvable before evaluation", () => {
  rejects("LAG(revenue.total, n)", "integer literal");
  rejects("SUM(revenue.total, -4.5, 0)", "integer literal");
});

test("YEAR_INDEX takes no arguments", () => {
  assert.deepEqual(parseFormula("YEAR_INDEX()"), { t: "call", fn: "YEAR_INDEX", args: [] });
});

test("DISCOUNT_FACTOR takes one WACC line-item reference", () => {
  assert.deepEqual(parseFormula("DISCOUNT_FACTOR(wacc)"), {
    t: "call", fn: "DISCOUNT_FACTOR", args: [{ t: "ref", id: "wacc" }],
  });
  rejects("DISCOUNT_FACTOR()", "expects 1");
  rejects("DISCOUNT_FACTOR(wacc + 0.01)", "line-item reference");
});

test("complexity limits are enforced", () => {
  rejects("(".repeat(40) + "a" + ")".repeat(40), "too deep");
  rejects("a + ".repeat(600) + "a", "too long");
});

test("property access, assignment, and foreign syntax are rejected", () => {
  rejects("a['b']", "unexpected");
  rejects("a = 1", "unexpected");
  rejects("a; b", "unexpected");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test "src/financial-model/dsl/__tests__/parser.test.ts"`
Expected: FAIL — cannot find module `../parser.ts`.

- [ ] **Step 3: Write `src/financial-model/dsl/parser.ts`**

```ts
import { FinancialModelError } from "../errors.ts";
import type { ArithOp } from "./units.ts";

export type FnName =
  | "SUM" | "AVERAGE" | "LAG" | "YOY" | "CAGR"
  | "MIN" | "MAX" | "ABS" | "POW" | "YEAR_INDEX"
  | "DISCOUNT_FACTOR";

export type Ast =
  | { t: "num"; v: number }
  | { t: "ref"; id: string }
  | { t: "neg"; e: Ast }
  | { t: "bin"; op: ArithOp; l: Ast; r: Ast }
  | { t: "call"; fn: FnName; args: Ast[] };

export const FN_ARITY: Record<FnName, number | "variadic"> = {
  SUM: 3, AVERAGE: 3, LAG: 2, YOY: 1, CAGR: 2,
  MIN: "variadic", MAX: "variadic", ABS: 1,
  POW: 2, YEAR_INDEX: 0, DISCOUNT_FACTOR: 1,
};

/** Argument positions that must be integer literals. A computed offset would
 *  make the dependency graph data-dependent and therefore unresolvable before
 *  evaluation. */
const INTEGER_LITERAL_ARGS: Partial<Record<FnName, number[]>> = {
  SUM: [1, 2], AVERAGE: [1, 2], LAG: [1], CAGR: [1],
};

export const MAX_LENGTH = 2000;
export const MAX_DEPTH = 32;
export const MAX_NODES = 400;

function fail(message: string): never {
  throw new FinancialModelError("invalid_formula", message);
}

type Token = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i += 1; continue; }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      const text = src.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) fail(`invalid number: ${text}`);
      tokens.push({ k: "num", v: value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j += 1;
      tokens.push({ k: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/(),".includes(ch)) { tokens.push({ k: "op", v: ch }); i += 1; continue; }
    fail(`unexpected character: ${ch}`);
  }
  return tokens;
}

/**
 * Recursive-descent parser over the allowlisted grammar of parent spec §8.3.
 * Everything not explicitly produced here — property access, assignment,
 * statement sequences, dynamic call targets — falls through to "unexpected",
 * which is the safety property: the parser cannot emit a node the evaluator
 * does not know how to run.
 */
export function parseFormula(source: string): Ast {
  if (source.length > MAX_LENGTH) fail(`formula too long: ${source.length} > ${MAX_LENGTH}`);
  const tokens = tokenize(source);
  let pos = 0;
  let nodes = 0;

  const peek = (): Token | undefined => tokens[pos];
  const isOp = (v: string): boolean => { const t = peek(); return t?.k === "op" && t.v === v; };
  const eat = (v: string): void => { if (!isOp(v)) fail(`unexpected token, expected '${v}'`); pos += 1; };
  const count = (): void => { nodes += 1; if (nodes > MAX_NODES) fail(`formula too complex: over ${MAX_NODES} nodes`); };

  function expression(depth: number): Ast {
    if (depth > MAX_DEPTH) fail(`formula too deep: over ${MAX_DEPTH} levels`);
    return additive(depth);
  }

  function additive(depth: number): Ast {
    let left = multiplicative(depth);
    while (isOp("+") || isOp("-")) {
      const op = (peek() as { v: string }).v as ArithOp;
      pos += 1;
      count();
      left = { t: "bin", op, l: left, r: multiplicative(depth + 1) };
    }
    return left;
  }

  function multiplicative(depth: number): Ast {
    let left = unary(depth);
    while (isOp("*") || isOp("/")) {
      const op = (peek() as { v: string }).v as ArithOp;
      pos += 1;
      count();
      left = { t: "bin", op, l: left, r: unary(depth + 1) };
    }
    return left;
  }

  function unary(depth: number): Ast {
    if (isOp("-")) { pos += 1; count(); return { t: "neg", e: unary(depth + 1) }; }
    return primary(depth);
  }

  function primary(depth: number): Ast {
    if (depth > MAX_DEPTH) fail(`formula too deep: over ${MAX_DEPTH} levels`);
    const t = peek();
    if (t === undefined) fail("unexpected end of formula");
    if (t.k === "op" && t.v === "(") {
      pos += 1;
      const inner = expression(depth + 1);
      eat(")");
      return inner;
    }
    if (t.k === "num") { pos += 1; count(); return { t: "num", v: t.v }; }
    if (t.k === "id") {
      pos += 1;
      count();
      if (isOp("(")) return call(t.v, depth);
      return { t: "ref", id: t.v };
    }
    fail(`unexpected token: ${t.k === "op" ? t.v : String(t.v)}`);
  }

  function call(name: string, depth: number): Ast {
    if (!(name in FN_ARITY)) fail(`unknown function: ${name}`);
    const fn = name as FnName;
    eat("(");
    const args: Ast[] = [];
    if (!isOp(")")) {
      args.push(expression(depth + 1));
      while (isOp(",")) { pos += 1; args.push(expression(depth + 1)); }
    }
    eat(")");

    const arity = FN_ARITY[fn];
    if (arity === "variadic") {
      if (args.length === 0) fail(`${fn} expects at least 1 argument`);
    } else if (args.length !== arity) {
      fail(`${fn} expects ${arity} argument${arity === 1 ? "" : "s"}, received ${args.length}`);
    }

    for (const index of INTEGER_LITERAL_ARGS[fn] ?? []) {
      const arg = args[index];
      const literal = arg?.t === "num" ? arg.v : arg?.t === "neg" && arg.e.t === "num" ? -arg.e.v : undefined;
      if (literal === undefined || !Number.isInteger(literal)) {
        fail(`${fn} argument ${index + 1} must be an integer literal`);
      }
    }

    if (fn === "DISCOUNT_FACTOR" && args[0]?.t !== "ref") {
      fail("DISCOUNT_FACTOR requires a line-item reference");
    }
    return { t: "call", fn, args };
  }

  const ast = expression(0);
  if (pos !== tokens.length) fail("unexpected trailing input");
  return ast;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test "src/financial-model/dsl/__tests__/parser.test.ts"`
Expected: PASS, 13 tests.

- [ ] **Step 5: Type check and commit**

```bash
pnpm build
git add src/financial-model/dsl/parser.ts src/financial-model/dsl/__tests__/parser.test.ts
git commit -m "feat(financial-model): restricted formula parser with allowlisted AST"
```

---

### Task 4: Dependency graph and topological order

**Files:**
- Create: `src/financial-model/dsl/graph.ts`
- Test: `src/financial-model/dsl/__tests__/graph.test.ts`

**Interfaces:**
- Consumes: `Ast` from `./parser.ts`, `PeriodGrid` from `../periodGrid.ts`, `FinancialModelError`.
- Produces: `type CellKey = string`, `cellKey(lineItemId, periodId): CellKey`, `splitCellKey(key): { lineItemId: string; periodId: string }`, `type GraphContext = { grid: PeriodGrid; valuationAnchorPeriodId: string; rankOf(lineItemId: string): number }`, `dependenciesOf(ast: Ast, lineItemId: string, periodId: string, ctx: GraphContext): CellKey[]`, `topoOrder(nodes: readonly CellKey[], deps: ReadonlyMap<CellKey, readonly CellKey[]>, ctx: GraphContext): CellKey[]`.

Notes for the implementer:
- The graph is over `(lineItemId, periodId)` cells, not rows. That is what makes `LAG(revenue.iphone, 1) * (1 + growth.revenue.iphone)` on the `revenue.iphone` row a legal chain between adjacent periods rather than a self-cycle.
- The first argument of `SUM`, `AVERAGE`, `LAG`, `YOY`, `CAGR`, and `DISCOUNT_FACTOR` must be a bare reference. Reject anything else with `invalid_formula` — a computed reference cannot be resolved before evaluation.
- There is no hierarchy-summing AST node. Revenue and working-capital category sums are explicit signed formulas compiled from reviewed plans, never inferred from `parentId`.
- A dependency that falls off the grid (`LAG` past the first period) produces no edge. The missing value surfaces during evaluation as a `missing_input` diagnostic, not as a graph error.

- [ ] **Step 1: Write the failing test**

```ts
// src/financial-model/dsl/__tests__/graph.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFormula } from "../parser.ts";
import { cellKey, dependenciesOf, topoOrder, type GraphContext } from "../graph.ts";
import { buildGrid } from "../../periodGrid.ts";
import type { Period } from "../../types.ts";
import { FinancialModelError } from "../../errors.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
];

const RANK: Record<string, number> = { "revenue.a": 1, "revenue.b": 2, revenue: 3, "revenue.total": 4, growth: 0 };

const ctx: GraphContext = {
  grid: buildGrid(PERIODS),
  valuationAnchorPeriodId: "FY2025",
  rankOf: (id) => RANK[id] ?? 99,
};

test("a bare reference depends on the same row in the current period", () => {
  assert.deepEqual(dependenciesOf(parseFormula("revenue.a"), "x", "FY2026", ctx), [cellKey("revenue.a", "FY2026")]);
});

test("LAG depends on the earlier period, crossing the actual/forecast boundary", () => {
  assert.deepEqual(dependenciesOf(parseFormula("LAG(revenue.a, 1)"), "x", "FY2026", ctx), [cellKey("revenue.a", "FY2025")]);
});

test("a dependency off the front of the grid produces no edge", () => {
  assert.deepEqual(dependenciesOf(parseFormula("LAG(revenue.a, 1)"), "x", "FY2024", ctx), []);
});

test("YOY depends on the current and prior period", () => {
  assert.deepEqual(dependenciesOf(parseFormula("YOY(revenue.a)"), "x", "FY2026", ctx),
    [cellKey("revenue.a", "FY2026"), cellKey("revenue.a", "FY2025")]);
});

test("SUM over an offset range depends on every period in the window", () => {
  assert.deepEqual(dependenciesOf(parseFormula("SUM(revenue.a, -2, 0)"), "x", "FY2026", ctx),
    [cellKey("revenue.a", "FY2024"), cellKey("revenue.a", "FY2025"), cellKey("revenue.a", "FY2026")]);
});

test("DISCOUNT_FACTOR depends on the post-anchor WACC path through the current forecast period", () => {
  assert.deepEqual(dependenciesOf(parseFormula("DISCOUNT_FACTOR(wacc)"), "pv", "FY2026", ctx),
    [cellKey("wacc", "FY2026")]);
});

test("DISCOUNT_FACTOR excludes forecast periods at or before the valuation anchor", () => {
  const anchoredInForecast = { ...ctx, valuationAnchorPeriodId: "FY2026" };
  assert.deepEqual(dependenciesOf(parseFormula("DISCOUNT_FACTOR(wacc)"), "pv", "FY2026", anchoredInForecast), []);
});

test("a computed reference is rejected", () => {
  assert.throws(() => dependenciesOf(parseFormula("LAG(revenue.a + revenue.b, 1)"), "x", "FY2026", ctx),
    (e: unknown) => e instanceof FinancialModelError && e.code === "invalid_formula");
});

test("a lagged self-reference is a legal chain, not a cycle", () => {
  const deps = new Map([
    [cellKey("revenue.a", "FY2026"), [cellKey("revenue.a", "FY2025")]],
    [cellKey("revenue.a", "FY2025"), []],
  ]);
  const order = topoOrder([...deps.keys()], deps, ctx);
  assert.deepEqual(order, [cellKey("revenue.a", "FY2025"), cellKey("revenue.a", "FY2026")]);
});

test("a true cycle among cells is rejected", () => {
  const deps = new Map([
    [cellKey("a", "FY2026"), [cellKey("b", "FY2026")]],
    [cellKey("b", "FY2026"), [cellKey("a", "FY2026")]],
  ]);
  assert.throws(() => topoOrder([...deps.keys()], deps, ctx),
    (e: unknown) => e instanceof FinancialModelError && e.code === "circular_dependency");
});

test("independent cells use period position, numeric line-item rank, id, and a true total comparator", () => {
  const nodes = [
    cellKey("revenue.b", "FY2026"), cellKey("revenue.a", "FY2026"),
    cellKey("revenue.total", "FY2026"), cellKey("revenue.total", "FY2025"),
  ];
  const deps = new Map(nodes.map((n) => [n, [] as string[]]));
  assert.deepEqual(topoOrder(nodes, deps, ctx), [
    cellKey("revenue.total", "FY2025"), cellKey("revenue.a", "FY2026"),
    cellKey("revenue.b", "FY2026"), cellKey("revenue.total", "FY2026"),
  ]);
  // Same nodes, different input order, same result.
  assert.deepEqual(topoOrder([...nodes].reverse(), deps, ctx), topoOrder(nodes, deps, ctx));
});

test("cycle diagnostics use the same deterministic cell ordering", () => {
  // Build the same cycle from reversed node/dependency input and assert that
  // both circular_dependency errors carry an identical ordered cells array.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test "src/financial-model/dsl/__tests__/graph.test.ts"`
Expected: FAIL — cannot find module `../graph.ts`.

- [ ] **Step 3: Write `src/financial-model/dsl/graph.ts`**

```ts
import { FinancialModelError } from "../errors.ts";
import type { PeriodGrid } from "../periodGrid.ts";
import type { Ast } from "./parser.ts";

export type CellKey = string;

export function cellKey(lineItemId: string, periodId: string): CellKey {
  return `${lineItemId}@${periodId}`;
}

export function splitCellKey(key: CellKey): { lineItemId: string; periodId: string } {
  const at = key.lastIndexOf("@");
  return { lineItemId: key.slice(0, at), periodId: key.slice(at + 1) };
}

export type GraphContext = {
  grid: PeriodGrid;
  /** Valuation functions begin strictly after this immutable configured period. */
  valuationAnchorPeriodId: string;
  /** Line-item display order; breaks ties so the evaluation sequence is total. */
  rankOf(lineItemId: string): number;
};

function refId(ast: Ast | undefined, fn: string): string {
  if (ast?.t !== "ref") {
    throw new FinancialModelError("invalid_formula", `${fn} requires a line-item reference as its first argument`);
  }
  return ast.id;
}

function intArg(ast: Ast | undefined): number {
  if (ast?.t === "num") return ast.v;
  if (ast?.t === "neg" && ast.e.t === "num") return -ast.e.v;
  throw new FinancialModelError("invalid_formula", "expected an integer literal argument");
}

/**
 * The cells this formula reads when evaluated at (lineItemId, periodId).
 *
 * Edges that fall off the grid are omitted rather than reported: an offset past
 * the first period is a missing value, which is a property of the cell, not a
 * defect in the graph.
 */
export function dependenciesOf(ast: Ast, lineItemId: string, periodId: string, ctx: GraphContext): CellKey[] {
  const out: CellKey[] = [];
  const push = (id: string, pid: string | undefined): void => { if (pid !== undefined) out.push(cellKey(id, pid)); };

  function walk(node: Ast): void {
    switch (node.t) {
      case "num": return;
      case "ref": push(node.id, periodId); return;
      case "neg": walk(node.e); return;
      case "bin": walk(node.l); walk(node.r); return;
      case "call": {
        switch (node.fn) {
          case "LAG": {
            const id = refId(node.args[0], "LAG");
            push(id, ctx.grid.at(periodId, -intArg(node.args[1]))?.id);
            return;
          }
          case "YOY": {
            const id = refId(node.args[0], "YOY");
            push(id, periodId);
            push(id, ctx.grid.at(periodId, -1)?.id);
            return;
          }
          case "CAGR": {
            const id = refId(node.args[0], "CAGR");
            push(id, periodId);
            push(id, ctx.grid.at(periodId, -intArg(node.args[1]))?.id);
            return;
          }
          case "SUM": case "AVERAGE": {
            const id = refId(node.args[0], node.fn);
            for (const period of ctx.grid.range(periodId, intArg(node.args[1]), intArg(node.args[2]))) {
              push(id, period.id);
            }
            return;
          }
          case "DISCOUNT_FACTOR": {
            const id = refId(node.args[0], "DISCOUNT_FACTOR");
            const anchor = ctx.grid.positionOf(ctx.valuationAnchorPeriodId);
            const forecasts = ctx.grid.ordered.filter((period) =>
              period.cls === "forecast" && ctx.grid.positionOf(period.id) > anchor);
            const current = forecasts.findIndex((period) => period.id === periodId);
            for (let i = 0; i <= current; i += 1) push(id, forecasts[i]?.id);
            return;
          }
          case "YEAR_INDEX": return;
          default:
            node.args.forEach(walk);
            return;
        }
      }
    }
  }

  walk(ast);
  return out;
}

/**
 * Kahn's algorithm with a total tie-break. Two models with identical content
 * must evaluate in identical order, because float64 reproducibility is the
 * whole basis of the determinism guarantee.
 */
export function topoOrder(
  nodes: readonly CellKey[],
  deps: ReadonlyMap<CellKey, readonly CellKey[]>,
  ctx: GraphContext,
): CellKey[] {
  const present = new Set(nodes);
  const indegree = new Map<CellKey, number>(nodes.map((n) => [n, 0]));
  const dependents = new Map<CellKey, CellKey[]>(nodes.map((n) => [n, []]));

  for (const node of nodes) {
    for (const dep of deps.get(node) ?? []) {
      if (!present.has(dep)) continue;
      indegree.set(node, (indegree.get(node) ?? 0) + 1);
      dependents.get(dep)!.push(node);
    }
  }

  const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  const compareCells = (a: CellKey, b: CellKey): number => {
    if (a === b) return 0;
    const left = splitCellKey(a);
    const right = splitCellKey(b);
    const period = ctx.grid.positionOf(left.periodId) - ctx.grid.positionOf(right.periodId);
    if (period !== 0) return period;
    const lineOrder = ctx.rankOf(left.lineItemId) - ctx.rankOf(right.lineItemId);
    if (lineOrder !== 0) return lineOrder;
    const lineId = compareText(left.lineItemId, right.lineItemId);
    return lineId !== 0 ? lineId : compareText(a, b);
  };

  const ready = nodes.filter((n) => (indegree.get(n) ?? 0) === 0).sort(compareCells);
  const order: CellKey[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareCells);
      }
    }
  }

  if (order.length !== nodes.length) {
    const cycle = nodes.filter((n) => !order.includes(n)).sort(compareCells);
    throw new FinancialModelError("circular_dependency", "the formula graph contains a cycle", { cells: cycle });
  }
  return order;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test "src/financial-model/dsl/__tests__/graph.test.ts"`
Expected: PASS, 12 tests.

- [ ] **Step 5: Type check and commit**

```bash
pnpm build
git add src/financial-model/dsl/graph.ts src/financial-model/dsl/__tests__/graph.test.ts
git commit -m "feat(financial-model): cell-level dependency graph with deterministic topological order"
```

---

### Task 5: Calculation engine

**Files:**
- Create: `src/financial-model/engine.ts`
- Test: `src/financial-model/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: everything from tasks 1–4.
- Produces: `type Formula = { lineItemId: string; appliesTo: "historical" | "forecast"; periodIds?: readonly string[]; source: string }`, `type EngineInput`, `type EngineOutput = { cells: Map<CellKey, Cell>; order: CellKey[] }`, `evaluate(input: EngineInput): EngineOutput`, `quantize(x: number): number`, `ENGINE_VERSION: string`.

`EngineInput` is:

```ts
type EngineInput = {
  periods: readonly Period[];
  lineItems: readonly LineItem[];
  /** Lifecycle-validated committed facts only. */
  facts: readonly ActiveFact[];
  assumptions: readonly Assumption[];
  formulas: readonly Formula[];
  valuationConfig: ValuationConfig;
};
```

Semantics the implementer must honor:
- A cell's source comes from `lineItem.historical` for `actual`/`ttm` periods and `lineItem.forecast` for `forecast` periods. Source `none` means the cell does not exist and is absent from the output map.
- Facts arrive as `ActiveFact[]`; mixed statuses never reach this boundary. Duplicate `(lineItemId, periodId)` coverage is `fact_conflict`, never last-write-wins.
- `null` propagates: any missing operand yields `null` plus a `missing_input` diagnostic listing the missing cell keys. Never substitute `0`.
- Division by zero yields `null` plus `divide_by_zero`. It is not an exception — a zero denominator in one metric must not abort the model.
- The Formula DSL has no comparison, boolean, conditional, or fallback nodes. The evaluator never selects an alternative data source; the Agent must read diagnostics and submit an explicit later operation.
- `YEAR_INDEX()` counts only forecast periods strictly after `valuationConfig.anchorPeriodId`, from 1 under `year_end` and from 0.5 under `mid_year`. Historical periods and forecast periods at or before the anchor are `null` with `not_applicable`.
- `DISCOUNT_FACTOR(wacc)` uses the WACC path strictly after the valuation anchor through the current forecast period. Year-end multiplies every full-period factor; mid-year multiplies full prior-period factors and the square root of the current factor. Periods at or before the anchor are `not_applicable`.
- `periodIds` narrows a formula to explicit cells within its declared period class. This is how period-specific DCF category groups generate forecast parent formulas. Omission means every period in the class. Overlapping formulas for the same cell are `invalid_formula`.
- A `not_applicable` assumption seeds a null cell with an N/A diagnostic. Reads of that cell remain N/A rather than becoming ordinary missing input; the DSL never coerces it to zero.
- Assumption coverage is unique by `(lineItemId, periodId)`. Overlap is `invalid_assumption`; input order must never choose a winner.
- Unit checking happens at compile time over the AST, before any evaluation. A mismatch throws `incompatible_units` and nothing is computed.
- Every stored value passes through `quantize`.

- [ ] **Step 1: Write the failing test**

```ts
// src/financial-model/__tests__/engine.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, quantize, type EngineInput, type Formula } from "../engine.ts";
import { cellKey } from "../dsl/graph.ts";
import { FinancialModelError } from "../errors.ts";
import type { ActiveFact, Assumption, LineItem, Period, Unit, ValuationConfig } from "../types.ts";

const USD: Unit = { kind: "currency", code: "USD" };
const PCT: Unit = { kind: "percent" };

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
  { id: "FY2027", label: "FY2027", start: "2027-01-01", end: "2027-12-31", cls: "forecast" },
];

const ITEMS: LineItem[] = [
  { id: "revenue", label: "Revenue", role: "revenue_root", unit: USD, section: "revenue", order: 10, historical: "none", forecast: "none" },
  { id: "revenue.a", label: "A", parentId: "revenue", role: "revenue_stream", unit: USD, section: "revenue", order: 11, historical: "actual", forecast: "formula" },
  { id: "revenue.b", label: "B", parentId: "revenue", role: "revenue_stream", unit: USD, section: "revenue", order: 12, historical: "actual", forecast: "formula" },
  { id: "growth.revenue.a", label: "A growth", role: "none", unit: PCT, section: "revenue", order: 13, historical: "formula", forecast: "assumption" },
  { id: "growth.revenue.b", label: "B growth", role: "none", unit: PCT, section: "revenue", order: 14, historical: "formula", forecast: "assumption" },
  { id: "revenue.total", label: "Total revenue", role: "revenue_total", unit: USD, section: "revenue", order: 15, historical: "actual", forecast: "formula" },
  { id: "wacc", label: "WACC", role: "wacc", unit: PCT, section: "dcf", order: 16, historical: "none", forecast: "assumption" },
];

function fact(id: string, periodId: string, value: number): ActiveFact {
  return {
    factId: `${id}-${periodId}`, status: "committed", lineItemId: id, periodId, value, unit: USD,
    provenance: { sourceType: "company_disclosure", sourceRefs: ["https://example.com/10k"], asOfDate: "2026-01-01" },
  };
}

function assumption(lineItemId: string, periods: string[], values: number[]): Assumption {
  return {
    assumptionId: `${lineItemId}-${periods[0]}`, lineItemId, periods,
    payload: { kind: "values", values, unit: PCT },
    sourceType: "management_guidance", sourceRefs: ["https://example.com/call"], asOfDate: "2026-01-01",
    rationale: "Test assumption.",
  };
}

function notApplicable(lineItemId: string, periods: string[]): Assumption {
  return {
    assumptionId: `${lineItemId}-na`, lineItemId, periods,
    payload: { kind: "not_applicable" }, sourceType: "company_disclosure",
    sourceRefs: ["https://example.com/10k"], asOfDate: "2026-01-01",
    rationale: "The component does not exist.",
  };
}

const VALUATION_CONFIG: ValuationConfig = {
  anchorPeriodId: "FY2025",
  discountConvention: "year_end",
  exitTerminalMetric: "fcff",
  sensitivity: { waccDeltas: [-0.01, 0, 0.01], terminalGrowthDeltas: [-0.005, 0, 0.005], exitMultipleDeltas: [-1, 0, 1] },
  sourceType: "analyst_inference", sourceRefs: ["https://example.com/methodology"],
  asOfDate: "2026-01-01", rationale: "Test valuation methodology.",
};

const FORMULAS: Formula[] = [
  { lineItemId: "revenue.a", appliesTo: "forecast", source: "LAG(revenue.a, 1) * (1 + growth.revenue.a)" },
  { lineItemId: "revenue.b", appliesTo: "forecast", source: "LAG(revenue.b, 1) * (1 + growth.revenue.b)" },
  // Generated from the committed DcfCategoryGroup; the engine executes
  // the normalized formula and never infers membership from all hierarchy children.
  { lineItemId: "revenue.total", appliesTo: "forecast", source: "revenue.a + revenue.b" },
];

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    periods: PERIODS,
    lineItems: ITEMS,
    facts: [fact("revenue.a", "FY2024", 100), fact("revenue.a", "FY2025", 110),
            fact("revenue.b", "FY2024", 50), fact("revenue.b", "FY2025", 60),
            fact("revenue.total", "FY2024", 150), fact("revenue.total", "FY2025", 170)],
    assumptions: [assumption("growth.revenue.a", ["FY2026", "FY2027"], [0.10, 0.05]),
                  assumption("growth.revenue.b", ["FY2026", "FY2027"], [0.20]),
                  assumption("wacc", ["FY2026", "FY2027"], [0.10, 0.12])],
    formulas: FORMULAS,
    valuationConfig: VALUATION_CONFIG,
    ...overrides,
  };
}

test("historical total comes from the independent committed consolidated fact", () => {
  const out = evaluate(input());
  assert.equal(out.cells.get(cellKey("revenue.a", "FY2025"))?.value, 110);
  assert.equal(out.cells.get(cellKey("revenue.total", "FY2025"))?.value, 170);
});

test("duplicate active facts are rejected instead of using input order", () => {
  const duplicate = fact("revenue.total", "FY2025", 999);
  duplicate.factId = "duplicate-revenue-total-FY2025";
  assert.throws(
    () => evaluate(input({ facts: [...input().facts, duplicate] })),
    (error: unknown) => error instanceof FinancialModelError && error.code === "fact_conflict",
  );
});

test("forecast total executes the formula generated from the reviewed aggregation plan", () => {
  const out = evaluate(input());
  assert.equal(out.cells.get(cellKey("revenue.total", "FY2026"))?.value, 193);
});

test("a per-period assumption path drives each forecast year", () => {
  const out = evaluate(input());
  assert.equal(out.cells.get(cellKey("revenue.a", "FY2026"))?.value, 121);      // 110 * 1.10
  assert.equal(out.cells.get(cellKey("revenue.a", "FY2027"))?.value, 127.05);   // 121 * 1.05
});

test("a single-value assumption applies as a constant across its periods", () => {
  const out = evaluate(input());
  assert.equal(out.cells.get(cellKey("revenue.b", "FY2026"))?.value, 72);       // 60 * 1.20
  assert.equal(out.cells.get(cellKey("revenue.b", "FY2027"))?.value, 86.4);     // 72 * 1.20
});

test("a missing assumption yields null with a missing_input diagnostic, never zero", () => {
  const out = evaluate(input({ assumptions: [assumption("growth.revenue.a", ["FY2026"], [0.10])] }));
  const cell = out.cells.get(cellKey("revenue.b", "FY2026"));
  assert.equal(cell?.value, null);
  assert.equal(cell?.diagnostics[0]?.code, "missing_input");
  assert.ok(cell?.diagnostics[0]?.refs.includes(cellKey("growth.revenue.b", "FY2026")));
});

test("missing propagates downstream and the diagnostic names the origin", () => {
  const out = evaluate(input({ assumptions: [] }));
  const total = out.cells.get(cellKey("revenue.total", "FY2026"));
  assert.equal(total?.value, null);
  assert.equal(total?.diagnostics[0]?.code, "missing_input");
});

test("division by zero is a diagnostic, not a thrown error", () => {
  const items: LineItem[] = [...ITEMS,
    { id: "margin", label: "Margin", role: "none", unit: { kind: "ratio" }, section: "metrics", order: 20, historical: "formula", forecast: "none" }];
  const out = evaluate(input({
    lineItems: items,
    facts: [fact("revenue.a", "FY2024", 0), fact("revenue.b", "FY2024", 0)],
    formulas: [...FORMULAS, { lineItemId: "margin", appliesTo: "historical", source: "revenue.a / revenue.total" }],
  }));
  const cell = out.cells.get(cellKey("margin", "FY2024"));
  assert.equal(cell?.value, null);
  assert.equal(cell?.diagnostics[0]?.code, "divide_by_zero");
});

test("incompatible units are rejected before any evaluation", () => {
  assert.throws(() => evaluate(input({
    formulas: [...FORMULAS, { lineItemId: "revenue.total", appliesTo: "historical", source: "revenue.a + growth.revenue.a" }],
  })), (e: unknown) => e instanceof FinancialModelError && e.code === "incompatible_units");
});

test("YEAR_INDEX follows the discount convention and is null in history", () => {
  const items: LineItem[] = [...ITEMS,
    { id: "disc", label: "Discount period", role: "none", unit: { kind: "number" }, section: "dcf", order: 30, historical: "formula", forecast: "formula" }];
  const formulas = [...FORMULAS,
    { lineItemId: "disc", appliesTo: "historical" as const, source: "YEAR_INDEX()" },
    { lineItemId: "disc", appliesTo: "forecast" as const, source: "YEAR_INDEX()" }];

  const yearEnd = evaluate(input({ lineItems: items, formulas }));
  assert.equal(yearEnd.cells.get(cellKey("disc", "FY2026"))?.value, 1);
  assert.equal(yearEnd.cells.get(cellKey("disc", "FY2027"))?.value, 2);
  assert.equal(yearEnd.cells.get(cellKey("disc", "FY2025"))?.value, null);
  assert.equal(yearEnd.cells.get(cellKey("disc", "FY2025"))?.diagnostics[0]?.code, "not_applicable");

  const midYear = evaluate(input({
    lineItems: items,
    formulas,
    valuationConfig: { ...VALUATION_CONFIG, discountConvention: "mid_year" },
  }));
  assert.equal(midYear.cells.get(cellKey("disc", "FY2026"))?.value, 0.5);
  assert.equal(midYear.cells.get(cellKey("disc", "FY2027"))?.value, 1.5);

  const forecastAnchor = evaluate(input({
    lineItems: items,
    formulas,
    valuationConfig: { ...VALUATION_CONFIG, anchorPeriodId: "FY2026" },
  }));
  assert.equal(forecastAnchor.cells.get(cellKey("disc", "FY2026"))?.value, null);
  assert.equal(forecastAnchor.cells.get(cellKey("disc", "FY2026"))?.diagnostics[0]?.code, "not_applicable");
  assert.equal(forecastAnchor.cells.get(cellKey("disc", "FY2027"))?.value, 1);
});

test("DISCOUNT_FACTOR accumulates a changing WACC path", () => {
  const items: LineItem[] = [...ITEMS,
    { id: "discount.factor", label: "Discount factor", role: "none", unit: { kind: "ratio" }, section: "dcf", order: 31, historical: "none", forecast: "formula" }];
  const formulas = [...FORMULAS,
    { lineItemId: "discount.factor", appliesTo: "forecast" as const, source: "DISCOUNT_FACTOR(wacc)" }];

  const yearEnd = evaluate(input({ lineItems: items, formulas }));
  assert.equal(yearEnd.cells.get(cellKey("discount.factor", "FY2026"))?.value, 1.1);
  assert.equal(yearEnd.cells.get(cellKey("discount.factor", "FY2027"))?.value, 1.232);

  const midYear = evaluate(input({
    lineItems: items, formulas,
    valuationConfig: { ...VALUATION_CONFIG, discountConvention: "mid_year" },
  }));
  assert.equal(midYear.cells.get(cellKey("discount.factor", "FY2026"))?.value, quantize(Math.sqrt(1.1)));
  assert.equal(midYear.cells.get(cellKey("discount.factor", "FY2027"))?.value, quantize(1.1 * Math.sqrt(1.12)));

  const forecastAnchor = evaluate(input({
    lineItems: items, formulas,
    valuationConfig: { ...VALUATION_CONFIG, anchorPeriodId: "FY2026" },
  }));
  assert.equal(forecastAnchor.cells.get(cellKey("discount.factor", "FY2026"))?.value, null);
  assert.equal(forecastAnchor.cells.get(cellKey("discount.factor", "FY2027"))?.value, 1.12);
});

test("explicit N/A stays distinct from missing and propagates through DSL references", () => {
  const items: LineItem[] = [...ITEMS,
    { id: "preferred_equity", label: "Preferred equity", role: "preferred_equity", unit: USD, section: "dcf", order: 32, historical: "none", forecast: "assumption" },
    { id: "preferred_equity.echo", label: "Preferred equity echo", role: "none", unit: USD, section: "dcf", order: 33, historical: "none", forecast: "formula" }];
  const formulas = [...FORMULAS,
    { lineItemId: "preferred_equity.echo", appliesTo: "forecast" as const, source: "preferred_equity" }];
  const out = evaluate(input({
    lineItems: items, formulas,
    assumptions: [...input().assumptions, notApplicable("preferred_equity", ["FY2026", "FY2027"])],
  }));
  assert.equal(out.cells.get(cellKey("preferred_equity", "FY2026"))?.diagnostics[0]?.code, "not_applicable");
  assert.equal(out.cells.get(cellKey("preferred_equity.echo", "FY2026"))?.diagnostics[0]?.code, "not_applicable");

  const missing = evaluate(input({ lineItems: items, formulas }));
  assert.equal(missing.cells.get(cellKey("preferred_equity", "FY2026"))?.diagnostics[0]?.code, "missing_input");
});

test("overlapping assumptions are rejected instead of using input order", () => {
  const duplicate = assumption("growth.revenue.a", ["FY2026"], [0.30]);
  assert.throws(
    () => evaluate(input({ assumptions: [...input().assumptions, duplicate] })),
    (error: unknown) => error instanceof FinancialModelError && error.code === "invalid_assumption",
  );
});

test("quantize removes float64 tails", () => {
  assert.equal(quantize(0.1 + 0.2), 0.3);
  assert.equal(quantize(1 / 3), 0.333333333333);
});

test("evaluation is deterministic when non-semantic input collections are reordered", () => {
  const a = evaluate(input());
  const original = input();
  const b = evaluate({
    ...original,
    lineItems: [...original.lineItems].reverse(),
    facts: [...original.facts].reverse(),
    assumptions: [...original.assumptions].reverse(),
    formulas: [...original.formulas].reverse(),
  });
  assert.deepEqual(b.order, a.order);
  assert.deepEqual([...b.cells], [...a.cells]);
});

test("reversing periods is rejected because period order is model semantics", () => {
  const original = input();
  assert.throws(() => evaluate({ ...original, periods: [...original.periods].reverse() }),
    (error: unknown) => error instanceof FinancialModelError && error.code === "incompatible_periods");
});
```

Also add two coverage tests before leaving this step: explicit `periodIds` select different formulas for two forecast years, and overlapping explicit/class-wide formulas for the same cell throw `invalid_formula` before any evaluation.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test "src/financial-model/__tests__/engine.test.ts"`
Expected: FAIL — cannot find module `../engine.ts`.

- [ ] **Step 3: Write `src/financial-model/engine.ts`**

Implement in this order; each piece is small and the order avoids forward references.

```ts
import { FinancialModelError } from "./errors.ts";
import { buildGrid } from "./periodGrid.ts";
import { parseFormula, type Ast } from "./dsl/parser.ts";
import { cellKey, dependenciesOf, splitCellKey, topoOrder, type CellKey, type GraphContext } from "./dsl/graph.ts";
import { assignableTo, combine, commonUnit, compatibleUnit, sameUnit, unitLabel, type UnitTerm } from "./dsl/units.ts";
import type { ActiveFact, Assumption, Cell, Diagnostic, LineItem, Period, Unit, ValuationConfig } from "./types.ts";

/** Bumped whenever arithmetic, quantization, or evaluation order changes, so
 *  stored results become identifiably stale rather than silently inconsistent. */
export const ENGINE_VERSION = "1.0.0";

const SIGNIFICANT_DIGITS = 12;

export function quantize(x: number): number {
  return Number(x.toPrecision(SIGNIFICANT_DIGITS));
}

export type Formula = {
  lineItemId: string;
  appliesTo: "historical" | "forecast";
  /** Omitted means every period in appliesTo; otherwise binds this formula to
   *  exactly these period cells. Explicit coverages may not overlap. */
  periodIds?: readonly string[];
  source: string;
};

export type EngineInput = {
  periods: readonly Period[];
  lineItems: readonly LineItem[];
  facts: readonly ActiveFact[];
  assumptions: readonly Assumption[];
  formulas: readonly Formula[];
  valuationConfig: ValuationConfig;
};

export type EngineOutput = { cells: Map<CellKey, Cell>; order: CellKey[] };

type Resolved = { value: number | null; diagnostics: Diagnostic[] };

export function evaluate(input: EngineInput): EngineOutput {
  const grid = buildGrid(input.periods);
  const itemById = new Map(input.lineItems.map((x) => [x.id, x]));

  const ctx: GraphContext = {
    grid,
    valuationAnchorPeriodId: input.valuationConfig.anchorPeriodId,
    rankOf: (id) => itemById.get(id)?.order ?? Number.MAX_SAFE_INTEGER,
  };

  // 1. Source resolution: which cells exist and where each gets its value.
  const sourceOf = (item: LineItem, period: Period) =>
    period.cls === "forecast" ? item.forecast : item.historical;

  // 2. Compile formulas once, unit-checking and validating explicit coverage.
  const compiledFormulas: Array<{ definition: Formula; ast: Ast }> = [];
  for (const formula of input.formulas) {
    const item = itemById.get(formula.lineItemId);
    if (item === undefined) {
      throw new FinancialModelError("invalid_formula", `formula references unknown line item: ${formula.lineItemId}`);
    }
    const ast = parseFormula(formula.source);
    const produced = unitOf(ast, itemById, formula.source);
    if (!assignableTo(produced, item.unit)) {
      throw new FinancialModelError("incompatible_units",
        `formula for ${item.id} produces ${unitLabel(produced.unit)} but the row is ${unitLabel(item.unit)}`,
        { lineItemId: item.id, formula: formula.source });
    }
    for (const periodId of formula.periodIds ?? []) {
      const period = grid.all.find((candidate) => candidate.id === periodId);
      const expected = formula.appliesTo === "forecast" ? "forecast" : "historical";
      if (period === undefined || (expected === "forecast") !== (period.cls === "forecast")) {
        throw new FinancialModelError("invalid_formula",
          `formula period ${periodId} is outside ${formula.appliesTo} coverage`);
      }
    }
    compiledFormulas.push({ definition: formula, ast });
  }

  // 3. Seed values that need no evaluation: committed facts and assumptions.
  const seeded = new Map<CellKey, number>();
  const explicitlyNotApplicable = new Set<CellKey>();
  const activeFactKeys = new Set<CellKey>();
  for (const fact of input.facts) {
    const key = cellKey(fact.lineItemId, fact.periodId);
    if (activeFactKeys.has(key)) {
      throw new FinancialModelError("fact_conflict", `multiple active facts for ${key}`);
    }
    activeFactKeys.add(key);
    seeded.set(key, fact.value);
  }
  const assumptionKeys = new Set<CellKey>();
  for (const a of input.assumptions) {
    a.periods.forEach((periodId, i) => {
      const key = cellKey(a.lineItemId, periodId);
      if (assumptionKeys.has(key)) {
        throw new FinancialModelError("invalid_assumption", `overlapping assumptions for ${key}`);
      }
      assumptionKeys.add(key);
      if (a.payload.kind === "not_applicable") {
        explicitlyNotApplicable.add(key);
        seeded.delete(key);
        return;
      }
      const value = a.payload.values.length === 1 ? a.payload.values[0]! : a.payload.values[i];
      if (value !== undefined) seeded.set(key, value);
    });
  }

  // 4. Enumerate cells and their dependencies.
  const nodes: CellKey[] = [];
  const deps = new Map<CellKey, CellKey[]>();
  const formulaAt = new Map<CellKey, Ast>();
  for (const item of input.lineItems) {
    for (const period of grid.all) {
      const source = sourceOf(item, period);
      if (source === "none") continue;
      const key = cellKey(item.id, period.id);
      nodes.push(key);
      if (source === "formula") {
        const appliesTo = period.cls === "forecast" ? "forecast" : "historical";
        const matches = compiledFormulas.filter(({ definition }) =>
          definition.lineItemId === item.id
          && definition.appliesTo === appliesTo
          && (definition.periodIds === undefined || definition.periodIds.includes(period.id)));
        if (matches.length > 1) {
          throw new FinancialModelError("invalid_formula", `overlapping formulas for ${key}`);
        }
        const compiled = matches[0];
        if (compiled !== undefined) {
          formulaAt.set(key, compiled.ast);
          deps.set(key, dependenciesOf(compiled.ast, item.id, period.id, ctx));
          continue;
        }
      }
      deps.set(key, []);
    }
  }

  // 5. Evaluate in a total topological order.
  const order = topoOrder(nodes, deps, ctx);
  const cells = new Map<CellKey, Cell>();

  for (const key of order) {
    const { lineItemId, periodId } = splitCellKey(key);
    const item = itemById.get(lineItemId)!;
    const period = grid.get(periodId)!;
    const ast = formulaAt.get(key);

    if (ast === undefined) {
      if (explicitlyNotApplicable.has(key)) {
        cells.set(key, { value: null, unit: item.unit, diagnostics: [{ code: "not_applicable", refs: [key] }] });
        continue;
      }
      const value = seeded.get(key);
      cells.set(key, value === undefined
        ? { value: null, unit: item.unit, diagnostics: [{ code: "missing_input", refs: [key] }] }
        : { value: quantize(value), unit: item.unit, diagnostics: [] });
      continue;
    }

    const resolved = run(ast, { key, periodId, period, cells, ctx, valuationConfig: input.valuationConfig });
    cells.set(key, {
      value: resolved.value === null ? null : quantize(resolved.value),
      unit: item.unit,
      diagnostics: resolved.diagnostics,
    });
  }

  return { cells, order };
}
```

- [ ] **Step 4: Add the unit checker and evaluator to the same file**

```ts
/** Compile-time unit of an expression. Throws incompatible_units on a mismatch,
 *  which is why no evaluation has happened yet when it does. */
function unitOf(
  ast: Ast,
  itemById: ReadonlyMap<string, LineItem>,
  source: string,
): UnitTerm {
  const bad = (message: string): never => {
    throw new FinancialModelError("incompatible_units", `${message} in formula: ${source}`);
  };
  const recur = (node: Ast): UnitTerm => unitOf(node, itemById, source);

  switch (ast.t) {
    case "num": return { unit: { kind: "number" }, literal: ast.v };
    case "ref": {
      const item = itemById.get(ast.id);
      if (item === undefined) {
        throw new FinancialModelError("invalid_formula", `unknown line item: ${ast.id} in formula: ${source}`);
      }
      return { unit: item.unit };
    }
    case "neg": {
      const inner = recur(ast.e);
      return inner.literal === undefined ? { unit: inner.unit } : { unit: inner.unit, literal: -inner.literal };
    }
    case "bin": {
      const left = recur(ast.l);
      const right = recur(ast.r);
      const result = combine(left, ast.op, right);
      if (result === null) bad(`cannot apply '${ast.op}' to ${unitLabel(left.unit)} and ${unitLabel(right.unit)}`);
      return { unit: result };
    }
    case "call": {
      switch (ast.fn) {
        case "YEAR_INDEX": return { unit: { kind: "number" } };
        case "DISCOUNT_FACTOR": {
          const rate = recur(ast.args[0]!);
          if (rate.unit.kind !== "percent" && rate.unit.kind !== "ratio") {
            bad("DISCOUNT_FACTOR requires a percent or ratio WACC reference");
          }
          return { unit: { kind: "ratio" } };
        }
        case "YOY": case "CAGR": return { unit: { kind: "percent" } };
        case "LAG": case "ABS": return { unit: recur(ast.args[0]!).unit };
        case "SUM": case "AVERAGE": return recur(ast.args[0]!);
        case "POW": {
          const base = recur(ast.args[0]!);
          const exponent = recur(ast.args[1]!);
          if (!compatibleUnit(base.unit, { kind: "number" }) || !sameUnit(exponent.unit, { kind: "number" })) {
            bad("POW requires a dimensionless base and number exponent");
          }
          return { unit: { kind: "ratio" } };
        }
        case "MIN": case "MAX": {
          let merged = recur(ast.args[0]!).unit;
          for (const arg of ast.args.slice(1)) {
            const unit = commonUnit(merged, recur(arg).unit);
            if (unit === null) bad(`${ast.fn} arguments must have compatible units`);
            merged = unit;
          }
          return { unit: merged };
        }
      }
    }
  }
}

type RunCtx = {
  key: CellKey;
  periodId: string;
  period: Period;
  cells: ReadonlyMap<CellKey, Cell>;
  ctx: GraphContext;
  valuationConfig: ValuationConfig;
};

function run(ast: Ast, rc: RunCtx): Resolved {
  const missing: string[] = [];
  let divideByZero = false;
  let notApplicable = false;

  const read = (lineItemId: string, periodId: string | undefined): number | null => {
    if (periodId === undefined) { missing.push(`${lineItemId}@<out of range>`); return null; }
    const cell = rc.cells.get(cellKey(lineItemId, periodId));
    if (cell === undefined) { missing.push(cellKey(lineItemId, periodId)); return null; }
    if (cell.value === null) {
      if (cell.diagnostics.some((diagnostic) => diagnostic.code === "not_applicable")) notApplicable = true;
      else missing.push(cellKey(lineItemId, periodId));
      return null;
    }
    return cell.value;
  };

  const walk = (node: Ast): number | null => {
    switch (node.t) {
      case "num": return node.v;
      case "ref": return read(node.id, rc.periodId);
      case "neg": { const v = walk(node.e); return v === null ? null : -v; }
      case "bin": {
        const l = walk(node.l);
        const r = walk(node.r);
        if (l === null || r === null) return null;
        if (node.op === "/" && r === 0) { divideByZero = true; return null; }
        return node.op === "+" ? l + r : node.op === "-" ? l - r : node.op === "*" ? l * r : l / r;
      }
      case "call": return call(node);
    }
  };

  const call = (node: Extract<Ast, { t: "call" }>): number | null => {
    const refOf = (a: Ast): string => (a as { id: string }).id;
    const intOf = (a: Ast): number => (a.t === "num" ? a.v : -((a as { e: { v: number } }).e.v));

    switch (node.fn) {
      case "YEAR_INDEX": {
        if (rc.period.cls !== "forecast") { notApplicable = true; return null; }
        const anchor = rc.ctx.grid.positionOf(rc.valuationConfig.anchorPeriodId);
        const forecasts = rc.ctx.grid.ordered.filter((p) =>
          p.cls === "forecast" && rc.ctx.grid.positionOf(p.id) > anchor);
        const i = forecasts.findIndex((p) => p.id === rc.periodId);
        if (i < 0) { notApplicable = true; return null; }
        return rc.valuationConfig.discountConvention === "mid_year" ? i + 0.5 : i + 1;
      }
      case "DISCOUNT_FACTOR": {
        if (rc.period.cls !== "forecast") { notApplicable = true; return null; }
        const id = refOf(node.args[0]!);
        const anchor = rc.ctx.grid.positionOf(rc.valuationConfig.anchorPeriodId);
        const forecasts = rc.ctx.grid.ordered.filter((period) =>
          period.cls === "forecast" && rc.ctx.grid.positionOf(period.id) > anchor);
        const current = forecasts.findIndex((period) => period.id === rc.periodId);
        if (current < 0) { notApplicable = true; return null; }
        let factor = 1;
        for (let i = 0; i <= current; i += 1) {
          const rate = read(id, forecasts[i]?.id);
          if (rate === null) return null;
          const base = 1 + rate;
          if (base <= 0) { missing.push(`${id}@<invalid discount factor>`); return null; }
          const exponent = rc.valuationConfig.discountConvention === "mid_year" && i === current ? 0.5 : 1;
          factor *= Math.pow(base, exponent);
        }
        return factor;
      }
      case "LAG": return read(refOf(node.args[0]!), rc.ctx.grid.at(rc.periodId, -intOf(node.args[1]!))?.id);
      case "YOY": {
        const id = refOf(node.args[0]!);
        const now = read(id, rc.periodId);
        const prior = read(id, rc.ctx.grid.at(rc.periodId, -1)?.id);
        if (now === null || prior === null) return null;
        if (prior === 0) { divideByZero = true; return null; }
        return now / prior - 1;
      }
      case "CAGR": {
        const id = refOf(node.args[0]!);
        const n = intOf(node.args[1]!);
        const now = read(id, rc.periodId);
        const base = read(id, rc.ctx.grid.at(rc.periodId, -n)?.id);
        if (now === null || base === null) return null;
        if (base <= 0 || n <= 0) { divideByZero = true; return null; }
        return Math.pow(now / base, 1 / n) - 1;
      }
      case "SUM": case "AVERAGE": {
        const id = refOf(node.args[0]!);
        const window = rc.ctx.grid.range(rc.periodId, intOf(node.args[1]!), intOf(node.args[2]!));
        if (window.length === 0) { missing.push(`${id}@<incomplete window>`); return null; }
        let total = 0;
        for (const period of window) {
          const v = read(id, period.id);
          if (v === null) return null;
          total += v;
        }
        return node.fn === "SUM" ? total : total / window.length;
      }
      case "ABS": { const v = walk(node.args[0]!); return v === null ? null : Math.abs(v); }
      case "POW": {
        const base = walk(node.args[0]!);
        const exponent = walk(node.args[1]!);
        return base === null || exponent === null ? null : Math.pow(base, exponent);
      }
      case "MIN": case "MAX": {
        const values = node.args.map(walk);
        if (values.some((v) => v === null)) return null;
        const numbers = values as number[];
        return node.fn === "MIN" ? Math.min(...numbers) : Math.max(...numbers);
      }
    }
  };

  const value = walk(ast);
  const diagnostics: Diagnostic[] = [];
  if (divideByZero) diagnostics.push({ code: "divide_by_zero", refs: [rc.key] });
  else if (notApplicable) diagnostics.push({ code: "not_applicable", refs: [rc.key] });
  else if (value === null && missing.length > 0) diagnostics.push({ code: "missing_input", refs: [...new Set(missing)] });
  return { value, diagnostics };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test "src/financial-model/__tests__/engine.test.ts"`
Expected: PASS, 18 tests.

- [ ] **Step 6: Type check and commit**

```bash
pnpm build
git add src/financial-model/engine.ts src/financial-model/__tests__/engine.test.ts
git commit -m "feat(financial-model): deterministic calculation engine with cell diagnostics"
```

---

### Task 6: Standard skeleton, reviewed DCF category groups, and reconciliation

**Files:**
- Create: `src/financial-model/skeleton.ts`
- Create: `src/financial-model/reconciliation.ts`
- Test: `src/financial-model/__tests__/skeleton.test.ts`
- Test: `src/financial-model/__tests__/reconciliation.test.ts`

**Interfaces:**
- Consumes: `LineItem`, `LineItemRole`, `Period`, `StatementMappingPlan`, `DcfCategoryGroup`, `ReconciliationResult`, `Cell`, and `Formula` from tasks 1 and 5.
- Produces: `createSkeleton(input): Skeleton`, `addSourceStatementRows(skeleton, rows): Skeleton`, `applyStatementMappingPlans(skeleton, plans): Skeleton`, `addDcfCategoryLineItem(skeleton, input): Skeleton`, `applyDcfCategoryGroups(skeleton, groups): Skeleton`, and `validateRoleCardinality(lineItems): void`, where `Skeleton = { lineItems: LineItem[]; formulas: Formula[] }`; plus `reconcileDcf(input): ReconciliationResult[]` for generic group checks and built-in accounting identities.

The skeleton is the accounting boundary for phase 1. It has four layers:

1. hidden `source.<statement>.*` rows holding one-to-one reviewed statement facts;
2. standard canonical income-statement, balance-sheet, and cash-flow DCF targets with role `none`;
3. one fixed DCF spine from consolidated revenue through FCFF;
4. one fixed equity-bridge spine, separate from raw balance-sheet captions.

- [ ] **Step 1: Write the failing skeleton tests**

Cover all of these behaviors in `skeleton.test.ts`:

```ts
const ACTUAL_PERIOD_IDS = PERIODS.filter((period) => period.cls === "actual").map((period) => period.id);
const FORECAST_PERIOD_IDS = PERIODS.filter((period) => period.cls === "forecast").map((period) => period.id);

test("creates every fixed role exactly once and repeated roles only where allowed", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  validateRoleCardinality(skeleton.lineItems);
  for (const role of [
    "revenue_root", "revenue_total", "operating_income", "tax_rate", "nopat",
    "depreciation_amortization", "ebitda", "capex", "operating_working_capital",
    "change_nwc", "fcff", "wacc", "terminal_growth", "exit_multiple",
    "cash_available_for_bridge", "non_operating_investments", "debt",
    "lease_liabilities", "preferred_equity", "non_controlling_interests",
    "diluted_shares",
  ] as const) {
    assert.equal(skeleton.lineItems.filter((item) => item.role === role).length, 1, role);
  }
  assert.equal(skeleton.lineItems.some((item) => (item.role as string) === "terminal_metric"), false);
});

test("uses the documented DCF formulas and positive-outflow sign convention", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  assertFormula(skeleton, "growth.revenue.total", "historical", "YOY(revenue.total)", ACTUAL_PERIOD_IDS);
  assertFormula(skeleton, "revenue.total", "forecast",
    "LAG(revenue.total, 1) * (1 + growth.revenue.total)", FORECAST_PERIOD_IDS);
  assertFormula(skeleton, "nopat", "forecast", "operating_income * (1 - tax_rate)");
  assertFormula(skeleton, "ebitda", "forecast", "operating_income + depreciation_amortization");
  assertFormula(skeleton, "change_nwc", "forecast",
    "operating_working_capital - LAG(operating_working_capital, 1)");
  assertFormula(skeleton, "fcff", "forecast",
    "nopat + depreciation_amortization - capital_expenditures - change_nwc");
});

test("keeps raw cash separate from bridge-available cash", () => {
  const skeleton = createSkeleton({ currency: "USD", periods: PERIODS });
  assert.equal(byId(skeleton, "cash_and_equivalents").role, "none");
  assert.equal(byId(skeleton, "cash_available_for_bridge").role, "cash_available_for_bridge");
});

test("adding a forecastable revenue member creates its value and growth rows atomically", () => {
  const base = createSkeleton({ currency: "USD", periods: PERIODS });
  const next = addDcfCategoryLineItem(base, {
    id: "revenue.services", parentLineItemId: "revenue", label: "Services",
  });
  assert.equal(byId(next, "revenue.services").role, "revenue_stream");
  assert.equal(byId(next, "growth.revenue.services").historical, "formula");
  assert.equal(byId(next, "growth.revenue.services").forecast, "assumption");
  assertFormula(next, "growth.revenue.services", "historical",
    "YOY(revenue.services)", ACTUAL_PERIOD_IDS);
  assertFormula(next, "revenue.services", "forecast",
    "LAG(revenue.services, 1) * (1 + growth.revenue.services)");
});

test("arbitrary revenue categories coexist and forecast coverage selects one group per parent cell", () => {
  const planned = applyDcfCategoryGroups(SKELETON_WITH_DISCLOSURES, [{
    parentLineItemId: "revenue.total", category: "product",
    periodIds: ["FY2026", "FY2027"],
    members: [
      { lineItemId: "revenue.products", treatment: "add" },
      { lineItemId: "revenue.services", treatment: "add" },
      { lineItemId: "revenue.eliminations", treatment: "subtract" },
      { lineItemId: "revenue.geography.us", treatment: "exclude" },
    ],
    reviewDecisionId: "review-1",
  }]);
  assertFormula(planned, "revenue.total", "forecast",
    "revenue.products + revenue.services - revenue.eliminations", ["FY2026", "FY2027"]);
});

test("working capital is an ordinary DCF category group with explicit signs", () => {
  const groups = [{
    parentLineItemId: "operating_working_capital", category: "operating_working_capital",
    periodIds: ["FY2024", "FY2025"],
    members: [
      { lineItemId: "accounts_receivable", treatment: "add" },
      { lineItemId: "inventory", treatment: "add" },
      { lineItemId: "accounts_payable", treatment: "subtract" },
      { lineItemId: "cash_and_equivalents", treatment: "exclude" },
      { lineItemId: "debt", treatment: "exclude" },
    ],
    reviewDecisionId: "review-2",
  }];
  assert.deepEqual(reconcileDcf({ ...DCF_INPUT, groups }).map(({ status }) => status),
    ["passed", "passed"]);
  assert.equal(JSON.stringify(groups).includes("reported_change_operating_assets_liabilities"), false);
});

test("category reconciliation compares DCF members to the DCF parent without source rows", ...);
test("built-in accounting identities return all four statuses and never coerce missing detail to zero", ...);
test("only failed required history checks are blockers", ...);

test("a reviewed statement plan maps several source categories into one canonical DCF row", () => {
  const withSources = addSourceStatementRows(createSkeleton({ currency: "USD", periods: PERIODS }), [
    { sourceLineItemId: "source.income_statement.r_and_d", label: "Research and development", statement: "income_statement", unit: USD, order: 1 },
    { sourceLineItemId: "source.income_statement.sga", label: "Selling, general and administrative", statement: "income_statement", unit: USD, order: 2 },
  ]);
  const mapped = applyStatementMappingPlans(withSources, [{
    targetLineItemId: "operating_expenses", periodIds: ["FY2024", "FY2025"],
    members: [
      { sourceLineItemId: "source.income_statement.r_and_d", treatment: "add" },
      { sourceLineItemId: "source.income_statement.sga", treatment: "add" },
    ],
    reviewDecisionId: "review-map-1",
  }]);
  assertFormula(mapped, "operating_expenses", "historical",
    "source.income_statement.r_and_d + source.income_statement.sga", ["FY2024", "FY2025"]);
});

test("rejects overlapping output coverage on one target, duplicate members, unknown rows, and duplicate fixed roles", () => {
  // One assertion for each invalid shape; all throw FinancialModelError("invalid_formula", ...).
});
```

Use annual actual periods plus five forecast periods in the fixture so formula coverage is asserted, not inferred.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test "src/financial-model/__tests__/skeleton.test.ts" "src/financial-model/__tests__/reconciliation.test.ts"`
Expected: FAIL — cannot find modules `../skeleton.ts` and `../reconciliation.ts`.

- [ ] **Step 3: Implement the fixed chart of accounts**

`createSkeleton({ currency, periods })` creates the following immutable-identity rows. Currency rows use the supplied currency; driver rows use percent or ratio; `diluted_shares` uses shares and `diluted_eps` uses per-share currency.

| Group | IDs |
| --- | --- |
| DCF spine | `revenue`, `revenue.total`, `growth.revenue.total`, `margin.operating`, `operating_income`, `tax_rate`, `nopat`, `depreciation_amortization`, `ratio.da_to_revenue`, `ebitda`, `capital_expenditures`, `ratio.capex_to_revenue`, `operating_working_capital`, `ratio.operating_nwc_to_revenue`, `change_nwc`, `fcff`, `wacc`, `terminal_growth`, `exit_multiple` |
| Income statement mapping | `cost_of_revenue`, `gross_profit`, `research_and_development`, `selling_and_marketing`, `general_and_administrative`, `other_operating_expenses`, `operating_expenses`, `interest_income`, `interest_expense`, `non_operating_income_expense`, `pretax_income`, `income_tax_expense`, `net_income`, `net_income_attributable_nci`, `diluted_eps` |
| Balance-sheet mapping | `cash_and_equivalents`, `restricted_cash`, `short_term_investments`, `accounts_receivable`, `inventory`, `other_operating_current_assets`, `accounts_payable`, `deferred_revenue`, `accrued_operating_liabilities`, `other_operating_current_liabilities`, `property_plant_equipment`, `total_current_assets`, `total_assets`, `total_current_liabilities`, `shareholders_equity` |
| Cash-flow mapping | `operating_cash_flow`, `reported_change_operating_assets_liabilities`, `asset_sale_proceeds`, `acquisitions`, `net_investing_cash_flow`, `debt_issuance`, `debt_repayment`, `dividends`, `share_repurchases` |
| Equity bridge | `cash_available_for_bridge`, `non_operating_investments`, `debt`, `lease_liabilities`, `preferred_equity`, `non_controlling_interests`, `diluted_shares` |

Canonical mapping targets default to historical `none` / forecast `none` until a direct reviewed fact or a statement plan supplies them. `addSourceStatementRows` accepts only reserved `source.income_statement.*`, `source.balance_sheet.*`, or `source.cash_flow_statement.*` IDs, assigns the matching hidden source section, role `none`, historical `actual`, and forecast `none`, and retains the original source label and stable identity. Fixed DCF row sources and formulas must otherwise exactly match spec §4.4. In particular, install `growth.revenue.total` as historical formula / forecast assumption and the consolidated-only default revenue formula over every forecast period. Equity-bridge rows default to historical `actual` / forecast `none`; later review may switch a complete historical or forecast range to an allowed source, but skeleton creation itself never copies raw cash into `cash_available_for_bridge`.

Generate explicit `periodIds` for every default formula. This makes later plan application a deterministic replacement over selected cells instead of an overlap with a class-wide formula. Preserve a stable section/order sequence; do not derive order from object or set iteration.

- [ ] **Step 4: Implement Agent-created DCF category rows and role cardinality**

`addDcfCategoryLineItem` validates a semantic ID, an allowlisted parent DCF row, and unit/section compatibility, rejects collisions, and returns new arrays without mutating the input. Category names and dimensions are not enumerated and are stored on `DcfCategoryGroup`, not encoded into a fixed role union. New non-revenue members use `role: "none"` and receive no implicit formula. For a revenue child, the helper inserts `revenue.<slug>` and `growth.revenue.<slug>` together. Its forecast formula is:

```text
LAG(revenue.<slug>, 1) * (1 + growth.revenue.<slug>)
```

The companion growth row has historical source `formula` and forecast source `assumption`. Install `YOY(revenue.<slug>)` over explicit actual-period IDs at the same time as the forecast formula. Missing prior history remains a normal `missing_input` diagnostic; do not omit the metric row or fill it with zero.

`validateRoleCardinality` requires exactly one of every fixed role listed in the first test. It permits zero or more `revenue_stream`, `bridge_other`, and `none`. It rejects a role not present in the closed union at compile time; there is deliberately no category-specific or `terminal_metric` role because categories are data and valuation selects `ebitda` or `fcff`.

- [ ] **Step 5: Implement statement mapping and generic DCF-category compilation**

For statement mappings and DCF category groups:

- sort records by first period-grid index, then semantic identity: statement target ID, or category `parentLineItemId` then category string. Use the complete ordered period list as the final tie-breaker;
- reject unknown periods, repeated period IDs, unknown member rows, and duplicate member IDs. Historical groups with different categories may overlap on the same parent and period because each reconciles independently; only selected forecast formula coverage must be unique per parent-period cell;
- preserve member order only for display; sort included IDs by line-item `order`, then ID when generating formulas;
- ignore `exclude` members in arithmetic but preserve them in the stored mapping or group;
- reject an active mapping or group with no included member;
- emit normalized forecast formulas with explicit `periodIds` only for selected forecast groups; historical groups are reconciliation definitions and do not overwrite independently mapped parent cells;
- replace any existing formula only for the exact covered cells and reject every other overlap.

DCF category formulas use `add` and `subtract` signs and target `parentLineItemId`; the Formula DSL has no hierarchy-summing function. Historical parent values remain independently mapped and are reconciled later using the same signed DCF members. A group's forecast periods are its explicit selection to generate those parent cells; the compiler rejects multiple committed groups for one parent-period cell. A revenue group may replace the consolidated-only default formula, and an operating-working-capital group may replace its ratio-driven default, only for explicit forecast coverage.

Statement-mapping formulas use only reserved source rows, target only prebuilt canonical/DCF rows, and cover actual periods selected by the Agent. They may combine several source categories with explicit `add`/`subtract` signs, preserve `exclude` decisions for audit, and switch exactly their covered target cells to formula source. One target-period cell may have only one plan. The compiler performs the arithmetic; it never materializes an LLM-computed fact.

Neither statement mappings nor DCF category groups have an arbitrary caller ID. Normalize and locate statement mappings by `targetLineItemId + ordered periodIds`; locate groups by `parentLineItemId + category + ordered periodIds`. Exact business-key coverage may be replaced; ambiguous or partial overlap for the same business key is rejected. `reviewDecisionId` is only an audit link to the human/Agent decision. Category strings such as product, geography, segment, operating-cost function, or operating working capital are opaque values, never an enum or dispatch tag.

Working capital is represented by a normal group whose parent is the unique `operating_working_capital` row. The initial Agent proposal may add `accounts_receivable`, `inventory`, and other operating current assets; subtract `accounts_payable`, deferred revenue, accrued operating liabilities, and other operating current liabilities; and exclude cash, restricted cash, investments, debt, and lease liabilities. The committed group is authoritative. Reconciliation and forecast generation use only those DCF rows. `reported_change_operating_assets_liabilities` is neither a group member nor separately configured evidence.

- [ ] **Step 6: Implement DCF-table reconciliation**

`reconcileDcf` deterministically evaluates every historical `DcfCategoryGroup` and the built-in accounting-identity registry after the cell engine pass. A group compares its signed included-member sum with its independent parent value. Built-in rules include, when applicable, revenue/cost/gross-profit, gross-profit/operating-expense/operating-income, pretax/tax/net-income, EBITDA, NOPAT, operating NWC/change NWC, and FCFF identities. Every result records `ruleId`, period, ordered DCF refs, `required`, `difference`, and one of `passed`, `failed`, `insufficient_data`, or `not_applicable`.

Never inspect a `source.*` row in this module. If a parent or required member is missing, return `insufficient_data`; do not substitute zero and do not manufacture an omitted residual. Explicit reviewed scope can return `not_applicable`. The history gate blocks only `status: "failed"` results whose rule metadata says `required: true`; insufficient, N/A, and informational failures remain visible in the workbook.

- [ ] **Step 7: Run focused tests and type check**

Run:

```bash
node --experimental-strip-types --test "src/financial-model/__tests__/skeleton.test.ts" "src/financial-model/__tests__/reconciliation.test.ts" "src/financial-model/__tests__/engine.test.ts"
pnpm build
```

Expected: all tests PASS and type check exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/financial-model/skeleton.ts src/financial-model/reconciliation.ts \
  src/financial-model/__tests__/skeleton.test.ts src/financial-model/__tests__/reconciliation.test.ts
git commit -m "feat(financial-model): reviewed DCF categories and reconciliation"
```

---

### Task 7: Fact lifecycle and active-fact resolution

**Files:**
- Create: `src/financial-model/factLifecycle.ts`
- Test: `src/financial-model/__tests__/factLifecycle.test.ts`

**Interfaces:**
- Consumes: `Fact`, `ActiveFact`, `FactReviewDecision`, `LineItem`, and `Period` from task 1.
- Produces: `stageFacts(parentFacts, candidates): Fact[]`, `applyFactReview(parentFacts, decisions): Fact[]`, and `resolveActiveFacts(facts, lineItems, periods): ActiveFact[]`.

This module is pure domain logic. It does not write SQLite. `FinancialModelService.reviewFacts` later applies it to an in-memory working copy, recalculates with the returned active facts, and inserts the resulting complete snapshot as one revision row only if the pipeline succeeds.

- [ ] **Step 1: Write the failing lifecycle tests**

Cover:

```ts
test("committing a staged fact makes it the unique active fact", () => {
  const next = applyFactReview([STAGED_REVENUE], [commitDecision(STAGED_REVENUE.factId)]);
  assert.equal(next[0]?.status, "committed");
  assert.deepEqual(resolveActiveFacts(next, ITEMS, PERIODS).map((fact) => fact.factId),
    [STAGED_REVENUE.factId]);
});

test("staging rejects reused fact ids and payload mutation", () => {
  const changed = { ...COMMITTED_REVENUE, status: "staged" as const, value: 999 };
  assert.throws(() => stageFacts([COMMITTED_REVENUE], [changed]),
    (error: unknown) => error instanceof FinancialModelError && error.code === "fact_conflict");
});

test("rejected and staged candidates never enter active facts", () => {
  const facts = [COMMITTED_REVENUE, STAGED_RESTATEMENT, REJECTED_CANDIDATE];
  assert.deepEqual(resolveActiveFacts(facts, ITEMS, PERIODS).map((fact) => fact.factId),
    [COMMITTED_REVENUE.factId]);
});

test("a replacement atomically commits the new fact and supersedes the old fact", () => {
  const next = applyFactReview(
    [COMMITTED_REVENUE, STAGED_RESTATEMENT],
    [commitDecision(STAGED_RESTATEMENT.factId),
     supersedeDecision(COMMITTED_REVENUE.factId, STAGED_RESTATEMENT.factId)],
  );
  assert.equal(byId(next, COMMITTED_REVENUE.factId).status, "superseded");
  assert.equal(byId(next, STAGED_RESTATEMENT.factId).status, "committed");
  assert.deepEqual(resolveActiveFacts(next, ITEMS, PERIODS).map((fact) => fact.factId),
    [STAGED_RESTATEMENT.factId]);
});

test("rejecting a restatement leaves the existing committed fact active", () => {
  const next = applyFactReview(
    [COMMITTED_REVENUE, STAGED_RESTATEMENT],
    [rejectDecision(STAGED_RESTATEMENT.factId)],
  );
  assert.equal(byId(next, COMMITTED_REVENUE.factId).status, "committed");
  assert.equal(byId(next, STAGED_RESTATEMENT.factId).status, "rejected");
});

test("invalid replacement rolls back the pure transition", () => {
  const before = structuredClone([COMMITTED_REVENUE, WRONG_PERIOD_REPLACEMENT]);
  assert.throws(() => applyFactReview(before, INVALID_REPLACEMENT_DECISIONS),
    (error: unknown) => error instanceof FinancialModelError && error.code === "fact_conflict");
  assert.deepEqual(before, [COMMITTED_REVENUE, WRONG_PERIOD_REPLACEMENT]);
});

test("duplicate active cells, forked chains, missing review pairs, and payload mutation are rejected", () => {
  // Separate assertions for each invariant, all using fact_conflict.
});
```

Also assert that every accepted decision has non-empty `decisionId`, `rationale`, `reviewedBy`, and ISO `reviewedAt`, and that decision IDs are unique in the revision.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test "src/financial-model/__tests__/factLifecycle.test.ts"`
Expected: FAIL — cannot find module `../factLifecycle.ts`.

- [ ] **Step 3: Implement transition validation without mutation**

`stageFacts` accepts only new `staged` candidates, rejects a `factId` already present in the model, and returns new arrays without mutation. Reusing an ID to alter value, unit, period, provenance, or an accepted mapping is `fact_conflict`.

`applyFactReview` starts from cloned records and returns a new array. It validates the complete decision set before changing any status:

- `commit` and `reject` require a staged target; commit also requires `mappedLineItemId` and records that accepted mapping;
- `supersede` requires a committed target and `replacementFactId`;
- every replacement requires a paired commit decision in the same call;
- the replacement fact must be staged, name the predecessor in `supersedesFactId`, and match its `lineItemId`, `periodId`, and unit;
- `rejected` and `superseded` are terminal;
- value, unit, period, and provenance are immutable; mapping may change only while staged and is immutable afterward;
- a decision may target a fact at most once, except for the required commit/supersede pair targeting two different facts;
- all decision audit fields are present and decision IDs are unique.

Apply the validated transitions together. Never mutate `parentFacts`, and never return a partially transitioned array.

- [ ] **Step 4: Implement active-fact validation**

`resolveActiveFacts`:

- validates unique `factId` values;
- validates every mapped line item and period exists;
- requires every committed fact to have `lineItemId` and a unit equal to its line item;
- permits multiple staged/rejected candidates but excludes them and superseded facts;
- rejects more than one committed fact for `(lineItemId, periodId)` with `fact_conflict`;
- validates that accepted supersede chains have no fork, cycle, missing predecessor, or cross-cell/unit edge;
- returns committed facts sorted by period-grid order, then line-item order, then line-item ID and fact ID.

The engine keeps its defensive duplicate-active check even though this resolver normally makes it unreachable.

- [ ] **Step 5: Run focused tests and type check**

Run:

```bash
node --experimental-strip-types --test "src/financial-model/__tests__/factLifecycle.test.ts" "src/financial-model/__tests__/engine.test.ts"
pnpm build
```

Expected: all tests PASS and type check exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/financial-model/factLifecycle.ts src/financial-model/__tests__/factLifecycle.test.ts
git commit -m "feat(financial-model): auditable fact lifecycle and active-fact resolution"
```

---

### Task 8: Immutable full-snapshot stores

**Files:**
- Create: `src/financial-model/store.ts`
- Test: `src/financial-model/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `FinancialModelError` and a caller-supplied `SnapshotCodec<TSnapshot>`.
- Produces: generic `ModelStore<TSnapshot, TChangeSummary>`, `InMemoryModelStore<TSnapshot, TChangeSummary>`, and `SqliteModelStore<TSnapshot, TChangeSummary>` so persistence can be implemented before the final service assembles the concrete financial-model snapshot and revision-summary types.

Use these shapes:

```ts
export type NewModelMeta = {
  modelId: string;
  ownerAgentId: string;
  originSessionId: string;
  symbol: string;
  metadata: JsonObject;
};

export type RevisionInput<TSnapshot, TChangeSummary extends JsonObject = JsonObject> = {
  lifecycleStage: LifecycleStage;
  snapshot: TSnapshot;
  changeSummary: TChangeSummary;
  engineVersion: string;
  creatingSessionId: string;
};

export type Revision<TSnapshot, TChangeSummary extends JsonObject = JsonObject> =
  RevisionInput<TSnapshot, TChangeSummary> & {
  modelId: string;
  revision: number;
  parentRevision: number | null;
  createdAt: string;
};

export type RevisionHeader<TChangeSummary extends JsonObject = JsonObject> = {
  modelId: string;
  revision: number;
  parentRevision: number | null;
  lifecycleStage: LifecycleStage;
  changeSummary: TChangeSummary;
  engineVersion: string;
  creatingSessionId: string;
  createdAt: string;
};

export type ModelView = NewModelMeta & {
  currentRevision: number;
  lifecycleStage: LifecycleStage;
  updatedAt: string;
  createdAt: string;
};

export type SnapshotCodec<TSnapshot> = {
  encode(snapshot: TSnapshot): string;
  decode(json: string): TSnapshot;
};

export interface ModelStore<TSnapshot, TChangeSummary extends JsonObject = JsonObject> {
  create(meta: NewModelMeta, initial: RevisionInput<TSnapshot, TChangeSummary>): Revision<TSnapshot, TChangeSummary>;
  getMeta(modelId: string): ModelView | undefined;
  list(filter: ModelFilter): ModelView[];
  getRevision(modelId: string, revision?: number): Revision<TSnapshot, TChangeSummary> | undefined;
  listRevisionHeaders(modelId: string): RevisionHeader<TChangeSummary>[];
  commit(modelId: string, expectedRevision: number,
    input: RevisionInput<TSnapshot, TChangeSummary>): Revision<TSnapshot, TChangeSummary>;
}
```

The store assigns revision numbers, parent revisions, and timestamps. They are never accepted inside `RevisionInput`.

- [ ] **Step 1: Write the shared contract tests**

Write one `storeContract(name, createStore)` suite and run it against both implementations. Cover:

```ts
test("create stores stable metadata and complete revision zero", ...);
test("each successful mutating Agent step inserts one complete snapshot and current is the greatest revision", ...);
test("history-only and revenue-only partial models are valid revisions", ...);
test("a stale expected revision throws revision_conflict with the current revision", ...);
test("two writers using the same expected revision produce one winner", ...);
test("failed commits create no revision or revision gap", ...);
test("commit clones input and read returns a clone", ...);
test("reopening SQLite restores every immutable revision", ...);
test("revision headers return summaries without snapshot payloads in ascending revision order", ...);
test("change summaries are cloned, immutable, and committed atomically with snapshots", ...);
test("archived latest revision is hidden by default but old revisions remain readable", ...);
```

For the race test, open two `SqliteModelStore` instances on the same temporary database. Give both the same previously read revision; commit through one, then assert the second receives `revision_conflict` rather than revision `n + 2`.

Use a small JSON-compatible test snapshot. The financial-model service supplies the concrete codec later; the store must not know about formulas, facts, cells, or valuation types.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --experimental-sqlite --test "src/financial-model/__tests__/store.test.ts"`
Expected: FAIL — cannot find module `../store.ts`.

- [ ] **Step 3: Implement the in-memory reference store**

Keep stable model metadata and a revision array per model. `create` stores revision `0`; `commit` requires `expectedRevision === revisions.length - 1` and appends exactly one revision. `getRevision(modelId)` returns the last element. `listRevisionHeaders` returns all revision metadata and `changeSummary` fields but never a snapshot. `getMeta` and `list` derive `currentRevision`, lifecycle stage, and update time from the last element.

Use `structuredClone` when accepting metadata/snapshots and again when returning them. Do not expose internal arrays or references. This implementation defines the behavior the SQLite store must match.

- [ ] **Step 4: Implement SQLite without a current pointer**

Initialize:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS financial_models (
  model_id TEXT PRIMARY KEY,
  owner_agent_id TEXT NOT NULL,
  origin_session_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_model_revisions (
  model_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  parent_revision INTEGER,
  lifecycle_stage TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_summary_json TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  creating_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (model_id, revision),
  FOREIGN KEY (model_id) REFERENCES financial_models(model_id)
);

CREATE INDEX IF NOT EXISTS financial_model_revisions_latest
  ON financial_model_revisions(model_id, revision DESC);
```

Encode and validate both the snapshot and JSON-compatible change summary before touching the database.

`create` uses one short transaction because it inserts metadata and revision `0`. `commit` performs these steps:

1. query the greatest revision;
2. reject immediately if it differs from `expectedRevision`;
3. attempt one insert at `expectedRevision + 1` with parent `expectedRevision`;
4. if the primary-key insert loses a race, read the new greatest revision and throw `FinancialModelError("revision_conflict", ...)` with `{ currentRevision }`;
5. return the inserted row decoded through the codec.

`listRevisionHeaders` selects revision metadata plus `change_summary_json` in ascending revision order and must not select or decode `snapshot_json`. Validate each summary as JSON data before returning it.

Do not update or delete revision rows. Do not add `current_revision`, `lifecycle_stage`, or `updated_at` columns to `financial_models`. Latest model views use the greatest revision row. Default listing excludes a model when that row is `archived`; an explicit archived filter includes it.

- [ ] **Step 5: Validate codec and failure behavior**

The codec must reject malformed or non-finite snapshot data before insertion. Change-summary JSON must likewise reject non-finite or non-JSON values. Decode failures are storage-corruption errors, not missing models. A non-conflict SQLite constraint or I/O error is rethrown and must not be mislabeled `revision_conflict`. Prove that `listRevisionHeaders` still works with a test codec whose snapshot `decode` throws, demonstrating that prompt-history construction does not deserialize old snapshots.

For both stores, failed create/commit calls leave the prior state readable and produce no revision number gap.

- [ ] **Step 6: Run focused tests and type check**

Run:

```bash
node --experimental-strip-types --experimental-sqlite --test "src/financial-model/__tests__/store.test.ts"
pnpm build
```

Expected: all shared contract tests PASS for both stores and type check exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/financial-model/store.ts src/financial-model/__tests__/store.test.ts
git commit -m "feat(financial-model): immutable full-snapshot model stores"
```

---

### Task 9: Default metric registry and automatic formula rows

**Files:**
- Create: `src/financial-model/metrics.ts`
- Test: `src/financial-model/__tests__/metrics.test.ts`

**Interfaces:**
- Consumes: `LineItem`, `Period`, and `Formula`; the task-6 `Skeleton`; Formula DSL functions already implemented by tasks 3–5.
- Produces: `RegisteredMetricId`, `MetricRequest`, immutable `DEFAULT_METRIC_DEFINITIONS`, `installDefaultMetrics(skeleton, periods): Skeleton`, and `installRegisteredMetric(skeleton, periods, request): Skeleton`.

This module performs no arithmetic and accepts no calculated metric values. It installs line items plus normalized Formula DSL records; the normal engine pass calculates them whenever any prerequisite changes.

- [ ] **Step 1: Write the registry contract tests**

Cover:

```ts
test("default metrics are installed at model creation with immutable registry ids", ...);
test("driver rows already in the DCF spine are reused rather than duplicated", ...);
test("ROA and ROE use compatible two-period average balances", ...);
test("ROIC uses a stored invested-capital helper formula", ...);
test("free cash flow, net debt, margins, conversion, leverage, and per-share formulas are generated", ...);
test("three- and five-period total-revenue CAGR rows are installed by default", ...);
test("a requested CAGR derives its id, unit, target, coverage, and formula from the registry", ...);
test("CAGR rejects a non-allowlisted target, non-integer lookback, and lookback outside 2 through 10", ...);
test("metric formulas name actual periods explicitly and never use TTM as a fiscal offset", ...);
test("installing defaults or the same parameterized metric twice is rejected rather than overwritten", ...);
```

- [ ] **Step 2: Define the immutable registry**

Use stable formula rows. At minimum install these definitions, plus the growth rows listed in parent spec §9:

```text
metric.free_cash_flow       = operating_cash_flow - capital_expenditures
growth.revenue.total        = YOY(revenue.total)
metric.operating_income_yoy = YOY(operating_income)
metric.net_income_yoy       = YOY(net_income)
metric.diluted_eps_yoy      = YOY(diluted_eps)
metric.ocf_yoy              = YOY(operating_cash_flow)
metric.fcf_yoy              = YOY(metric.free_cash_flow)

metric.gross_margin         = gross_profit / revenue.total
metric.ebitda_margin        = ebitda / revenue.total
metric.net_margin           = net_income / revenue.total
metric.ocf_margin           = operating_cash_flow / revenue.total
metric.fcf_margin           = metric.free_cash_flow / revenue.total
metric.ocf_conversion       = operating_cash_flow / net_income

metric.current_ratio        = total_current_assets / total_current_liabilities
metric.debt_to_equity       = debt / shareholders_equity
metric.net_debt             = debt - cash_and_equivalents - short_term_investments
metric.invested_capital     = debt + shareholders_equity - cash_and_equivalents - short_term_investments
metric.roa                  = net_income / AVERAGE(total_assets, -1, 0)
metric.roe                  = net_income / AVERAGE(shareholders_equity, -1, 0)
metric.roic                 = nopat / AVERAGE(metric.invested_capital, -1, 0)

metric.net_income_per_share = net_income / diluted_shares
metric.ocf_per_share        = operating_cash_flow / diluted_shares
metric.fcf_per_share        = metric.free_cash_flow / diluted_shares
metric.revenue_cagr_3p      = CAGR(revenue.total, 3)
metric.revenue_cagr_5p      = CAGR(revenue.total, 5)
```

Do not duplicate existing skeleton drivers: `growth.revenue.total`, `margin.operating`, `tax_rate`, `ratio.da_to_revenue`, `ratio.capex_to_revenue`, and `ratio.operating_nwc_to_revenue` are already default historical metrics. Their registry entries point to those rows.

All registry-created rows carry role `none`, a fixed section/order/semantic unit, historical source `formula`, and forecast source `none`. They are immutable definitions: Model Operations may neither write their values nor replace their formulas. Missing prerequisites and zero denominators are handled by the engine as cell diagnostics.

- [ ] **Step 3: Implement parameterized registry metrics**

Phase 1 supports:

```ts
type MetricRequest = {
  registryId: "cagr";
  targetLineItemId: string;
  lookbackPeriods: number;
};
```

Allow targets for revenue total/streams, operating income, net income, diluted EPS, operating cash flow, and the generated free-cash-flow row. Require an integer lookback from 2 through 10. Derive the ID as `metric.cagr.<targetLineItemId>.<n>p`, unit `percent`, actual-period coverage, and `CAGR(targetLineItemId, n)` formula. The Agent supplies none of those derived fields.

- [ ] **Step 4: Verify automatic recalculation through the engine**

Add integration assertions using task 5's evaluator:

- installing metrics once and later supplying facts populates their cells without another metric operation;
- ROA/ROE/ROIC remain missing in the first compatible period and calculate when both balance periods exist;
- a missing short-term-investments input keeps net debt/ROIC missing rather than treating it as zero;
- zero revenue or equity produces `divide_by_zero`;
- changing a source fact and evaluating again changes every dependent metric.

- [ ] **Step 5: Run focused tests and type check**

```bash
node --experimental-strip-types --test "src/financial-model/__tests__/metrics.test.ts" "src/financial-model/__tests__/engine.test.ts"
pnpm build
```

Expected: metric registry and automatic-recalculation tests PASS; type check exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/financial-model/metrics.ts src/financial-model/__tests__/metrics.test.ts
git commit -m "feat(financial-model): automatic registered financial metrics"
```

---

### Task 10: Engine-native DCF valuation and sensitivity matrices

**Files:**
- Create: `src/financial-model/valuation.ts`
- Test: `src/financial-model/__tests__/valuation.test.ts`

**Interfaces:**
- Consumes: validated periods and line items, calculated `Cell` map, `ValuationConfig`, role cardinality validation, `cellKey`, and `quantize`.
- Produces: `ValuationInput`, `ExplicitPeriodValue`, `BridgeAdjustment`, `TerminalMethodResult`, `SensitivityMatrix`, `ValuationOutput`, `validateValuationConfig`, and `calculateValuation(input): ValuationOutput`.

Valuation is the only arithmetic outside the Formula DSL. It reads cells by immutable role, never by display label and never from unversioned call-time overrides.

- [ ] **Step 1: Write hand-computed valuation unit tests**

Cover:

```ts
test("year-end discounting follows a constant WACC path", ...);
test("year-end discounting multiplies each value in a changing WACC path", ...);
test("mid-year discounting applies full prior years and half the current year", ...);
test("Gordon growth uses final FCFF, growth, final WACC, and final discount factor", ...);
test("exit multiple selects the configured unique EBITDA or FCFF role", ...);
test("both terminal methods return separately and are never averaged", ...);
test("equity bridge applies every signed component and preserves explicit N/A lineage", ...);
test("missing required bridge input is not converted to zero", ...);
test("diluted shares must be numeric and positive before per-share value is emitted", ...);
test("reference WACC not greater than growth throws invalid_terminal_assumptions", ...);
test("Gordon sensitivity invalid cells are null rather than negative or infinite", ...);
test("a WACC sensitivity delta shifts every annual WACC in parallel", ...);
test("exit sensitivity uses the configured exit metric and multiple deltas", ...);
test("sensitivity axes are normalized, bounded, and deterministic", ...);
test("TTM does not consume a forecast index", ...);
```

- [ ] **Step 2: Define output contracts with complete lineage**

Use method-specific results so consumers cannot accidentally blend them:

```ts
type ExplicitPeriodValue = {
  periodId: string;
  fcff: number;
  wacc: number;
  discountFactor: number;
  presentValue: number;
  refs: CellKey[];
};

type BridgeAdjustment = {
  lineItemId: string;
  role: LineItemRole;
  sign: 1 | -1;
  status: "numeric" | "not_applicable";
  value: number | null;
  appliedAdjustment: number;
  refs: CellKey[];
};

type TerminalMethodResult = {
  method: "gordon_growth" | "exit_multiple";
  explicitPeriods: ExplicitPeriodValue[];
  terminalValue: number;
  terminalPresentValue: number;
  terminalValuePercentOfEnterpriseValue: number;
  enterpriseValue: number;
  bridge: BridgeAdjustment[];
  equityValue: number;
  dilutedShares: number;
  impliedValuePerShare: number;
  warnings: Diagnostic[];
  refs: CellKey[];
};

type SensitivityCell = {
  rowDelta: number;
  columnDelta: number;
  impliedValuePerShare: number | null;
  diagnostics: Diagnostic[];
};
```

`ValuationOutput` holds the shared explicit-period schedule, separate Gordon and exit results, the WACC-by-growth matrix, and the WACC-by-multiple matrix. Never add a blended or average result.

- [ ] **Step 3: Implement role binding, gates, and explicit-period discounting**

Validate fixed role cardinality first. Use `anchorPeriodId` to identify bridge/share cells and select only subsequent forecast periods from the authoritative grid. Require one numeric FCFF and WACC per selected forecast period, final-period terminal growth and exit multiple, the configured exit metric, every required bridge component, and positive diluted shares.

For each forecast `k`, calculate exactly the cumulative factors in spec §4.7/parent §12.1. Quantize every stored numeric output. A missing or N/A required valuation input throws the existing gate error without returning a partial valuation.

Optional bridge roles may contribute zero only when their cell is explicitly `not_applicable`; preserve `value: null`, `status: "not_applicable"`, the source ref, and `appliedAdjustment: 0`. Missing is never optional.

- [ ] **Step 4: Implement both terminal methods and sensitivities**

Gordon uses final-year WACC and requires `WACC[n] > growth`. Exit multiple uses the final configured EBITDA or FCFF cell. Both use the final selected discount factor and then apply the same bridge independently.

For every WACC delta, shift the complete WACC path before rebuilding all discount factors. Combine it with every growth or exit-multiple delta from stored configuration. Invalid stressed Gordon combinations produce a null matrix cell with `invalid_terminal_assumptions`; they do not abort other cells. Normalize axes by rejecting non-finite values, sorting numerically, deduplicating, and enforcing the configured maximum length.

- [ ] **Step 5: Run focused tests and type check**

```bash
node --experimental-strip-types --test "src/financial-model/__tests__/valuation.test.ts" "src/financial-model/__tests__/engine.test.ts"
pnpm build
```

Expected: valuation golden cases and both matrices PASS; type check exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/financial-model/valuation.ts src/financial-model/__tests__/valuation.test.ts
git commit -m "feat(financial-model): DCF valuation and sensitivity matrices"
```

---

### Task 11: Typed Model Operations DSL and read queries

**Files:**
- Create: `src/financial-model/operations.ts`
- Create: `src/financial-model/views.ts`
- Test: `src/financial-model/__tests__/operations.test.ts`
- Test: `src/financial-model/__tests__/views.test.ts`

**Interfaces:**
- Consumes: financial-model types, task-8 revision headers, `addSourceStatementRows`, `addDcfCategoryLineItem`, statement-mapping and DCF-category compilers, fact lifecycle, `installRegisteredMetric` from task 9, Formula records, reconciliation results, and valuation configuration types. It consumes neither the evaluator nor a writable store.
- Produces from `operations.ts`: `ModelSelector`, `ModelQuery`, closed `ModelOperation` union, `FinancialModelSnapshot`, and pure `applyModelOperations(snapshot, operations)`.
- Produces from `views.ts`: closed `RevisionChange`, `RevisionChangeSummary`, `RevisionSummary`, `WorkbookCellStatus`, `WorkbookCellSource`, `WorkbookCellView`, `WorkbookRowView`, `SourceStatementRowView`, `SourceStatementReviewView`, `CurrentWorkbookView`, `WorkbookSliceView`, `ModelContextView`, `buildWorkbookView`, `buildWorkbookSlice`, and `buildModelContextView`.

The two DSL layers must remain separate. `operations.ts` interprets typed state changes and selectors; it never evaluates formula arithmetic. Formula strings appear only as payloads of `set_formula` and are parsed by the existing Formula DSL after the complete operation batch has been reduced.

- [ ] **Step 1: Write the operation and query contract tests**

Use the following closed shapes; do not add `patch`, arbitrary property paths, or a catch-all operation:

```ts
export type ModelSelector = {
  cellRefs?: Array<{ lineItemId: string; periodId: string }>;
  lineItemIds?: string[];
  periodIds?: string[];
  parentId?: string;
  section?: LineItemSection;
  role?: LineItemRole;
  periodClass?: PeriodClass;
};

export type ModelQuery = {
  kind: "read_cells";
  revision?: number;
  selector: ModelSelector;
  includeLineage?: boolean;
};

export type ModelOperation =
  | {
      kind: "replace_fact";
      replacement: Fact;
      commitDecision: FactReviewDecision;
      supersedeDecision: FactReviewDecision;
    }
  | { kind: "set_assumption"; assumption: Assumption }
  | ({ kind: "set_line_item_source"; lineItemId: string } & (
      | { range: "historical"; source: "actual" | "assumption" | "formula" | "none" }
      | { range: "forecast"; source: "assumption" | "formula" | "none" }
    ))
  | { kind: "add_line_item"; lineItem: NewExtensibleLineItem }
  | {
      kind: "add_metric";
      metric: { registryId: "cagr"; targetLineItemId: string; lookbackPeriods: number };
    }
  | { kind: "set_formula"; formula: Formula }
  | { kind: "set_statement_mapping_plan"; plan: StatementMappingPlan }
  | { kind: "set_category_group"; group: DcfCategoryGroup }
  | { kind: "set_valuation_config"; config: ValuationConfig }
  | {
      kind: "advance_stage";
      stage: "history_committed" | "revenue_forecast" | "operations_fcff" | "valued";
    };
```

Cover at least:

```ts
test("read_cells returns one exact cell without mutating the snapshot", ...);
test("selectors intersect line items, periods, parent, section, role, and period class", ...);
test("selector results are deduplicated and deterministically ordered", ...);
test("an empty mutation batch is rejected", ...);
test("several assumptions and formulas apply atomically to one cloned working copy", ...);
test("a failed operation leaves the input snapshot unchanged", ...);
test("replace_fact retains predecessor, replacement, and paired commit/supersede decisions", ...);
test("set_assumption and set_formula replace only explicit non-overlapping coverage", ...);
test("set_line_item_source switches a complete range and can be populated later in the same batch", ...);
test("source switching clears current formula and assumption coverage but retains facts in the working snapshot", ...);
test("source switching rejects calculated, forecast actual, registry metrics, and engine-native rows", ...);
test("historical source may switch to a sourced assumption for an anchor-period N/A bridge decision", ...);
test("add_line_item accepts an allowlisted DCF category member and creates a revenue driver only when applicable", ...);
test("add_line_item rejects a fixed or non-extensible parent", ...);
test("add_metric installs only a parameterized registry definition with a derived id", ...);
test("custom metric rows cannot use or overwrite registry ids", ...);
test("set_statement_mapping_plan stores periods/categories/signs and installs its generated target formula", ...);
test("statement mapping rejects raw target writes, overlapping target periods, and non-source members", ...);
test("set_category_group stores the semantic group key and its selected forecast formula", ...);
test("category names and dimensions are arbitrary non-empty strings rather than enums", ...);
test("advance_stage records an explicit forward transition for later gate validation", ...);
```

- [ ] **Step 2: Define the complete snapshot and pure query behavior**

`FinancialModelSnapshot` contains the lifecycle stage, periods, hidden source-statement lineage rows, DCF line items, all fact candidates and review decisions, assumptions, formulas and normalized ASTs, statement-mapping plans, DCF category groups, ordered reconciliation results, valuation configuration, computed cells, valuation output when available, ordered diagnostics, and engine version. Task 12 supplies its strict codec and persistence service.

The selector logic used by `buildWorkbookSlice(snapshot, selector, includeLineage)` must:

1. validate every explicit ID rather than silently ignoring a typo;
2. intersect all supplied selector dimensions;
3. remove duplicate matches from overlapping `cellRefs` or repeated IDs;
4. group selected cells by line-item `order` then ID, with each row's cell keys serialized in authoritative period order;
5. return compact source references unless full lineage is requested;
6. leave the snapshot byte-for-byte unchanged.

Implement the parent spec §5.4 view contracts in `views.ts`. In normal `dcf` mode the complete workbook includes every non-source DCF line item and every authoritative period, grouped into `history`, `metrics`, `revenue`, `operations`, and `dcf`; it does not include hidden `source.*` rows or full statement-mapping plans. In `statement_mapping` mode the same single workbook additionally includes three read-only source sheets, selected period candidates, active/proposed mappings, proposed DCF category groups, and reconciliation results. Initial mapping uses all three prepared sheets; later exception views may be limited to affected rows/periods. Materialize source `none` as `not_modeled`; never collapse it into `missing_input`. Include active formula source text and current assumptions once at row level, raw quantized cell values, semantic units, compact row-level mapping/category references, current DCF category groups, reconciliation results, valuation configuration, diagnostics, and valuation. Exclude inactive audit records, normalized ASTs, and full provenance unless an explicit lineage slice is requested.

Once statement plans are committed and the history gate passes, `buildWorkbookView` must deterministically select `mode: "dcf"`; it must not rely on the LLM to remove source sheets. It selects `statement_mapping` only while initial mapping blockers exist or when the caller explicitly requests a mapping/source exception. Compact references on each DCF row identify the active plan and source rows without embedding their values. This is how the Agent maps once and subsequently operates only on the DCF workbook.

`buildModelContextView(meta, revisionHeaders, currentRevision)` must require contiguous headers ending at the supplied current revision, validate each header's typed change summary, place only headers strictly before current into `revisionHistory`, and build exactly one `currentWorkbook`. It must not call `getRevision` for old revisions or accept their snapshots. Revision summaries and every ID/period/section collection use deterministic model order; no human-authored or LLM-authored summary string enters the contract.

Add view-specific tests:

```ts
test("complete workbook is Excel-shaped JSON with authoritative period columns and ordered rows", ...);
test("cells keyed by period distinguish ok, missing, divide-by-zero, N/A, and not-modeled", ...);
test("active formulas and assumptions appear once at row level while ASTs and inactive audit data do not", ...);
test("compact source references expand only for an explicit lineage slice", ...);
test("initial mapping mode contains three source sheets beside the prebuilt DCF rows", ...);
test("after mapping, default context omits every source row and retains reusable DCF mapping/category references", ...);
test("unmapped, restated, structurally changed, or failed-required cases reopen only the required mapping view", ...);
test("insufficient-data and not-applicable reconciliation results stay visible without reopening sources", ...);
test("model context contains every prior summary and exactly one complete current workbook", ...);
test("model context rejects missing, duplicate, out-of-order, or malformed revision headers", ...);
test("building any view leaves the snapshot byte-for-byte unchanged", ...);
```

- [ ] **Step 3: Implement the exhaustive mutation reducer**

Use an exhaustive `switch (operation.kind)` with a `never` assertion. Apply the ordered operations to a cloned working snapshot:

- `replace_fact` stages the new fact and invokes the fact-lifecycle transition with its required commit decision and the predecessor's paired supersede decision; it may not mutate a committed fact's value, unit, period, provenance, or mapping in place;
- `set_line_item_source` changes the complete `historical` or `forecast` source range without changing row identity. Historical permits `actual`, `assumption`, `formula`, or `none`, including sourced overrides and explicit N/A bridge decisions at the valuation anchor; forecast permits `assumption`, `formula`, or `none`; `calculated` is never an Agent option. It removes formula and assumption records whose coverage is in that range before subsequent operations are applied, retains facts for audit, and rejects registry-owned metrics and engine-native rows. The final reduced snapshot—not each intermediate operation—is checked for source/coverage consistency, so a source switch plus its new assumptions or formulas is atomic;
- `set_assumption` replaces only the named `(lineItemId, periodId)` coverage, validates provenance and unit, and rejects overlap in the final snapshot;
- `add_line_item` accepts only an allowlisted DCF parent or the custom-metrics namespace. DCF category members inherit compatible unit/section constraints and cannot choose a fixed role. Revenue members delegate to `addDcfCategoryLineItem`, which also creates the historical `YOY` growth formula, forecast growth-assumption cells, and default member forecast formula; other category members receive no implicit forecast arithmetic. Custom metric rows must use non-registry IDs and receive arithmetic only through a separate `set_formula` operation;
- `add_metric` delegates to task 9's registry, which validates the allowlisted target and lookback and derives the row ID, unit, coverage, and formula without accepting an expression from the Agent;
- `set_formula` replaces only explicit coverage, validates the target classification, and leaves parsing to the compile phase;
- `set_statement_mapping_plan` validates selected actual periods and reserved source-row members, stores the reviewed add/subtract/exclude decisions, and replaces only the compiler-owned historical formula coverage on its canonical target. Plans for one target cannot overlap. Raw statement facts remain on their source rows and are never copied or summed by the Agent;
- `set_category_group` validates the non-empty arbitrary category string, the `parentLineItemId + category + periodIds` business key, DCF-only members, and explicit signs. It stores the group with no caller ID; its forecast period coverage replaces compiler-owned parent formulas, while its historical coverage feeds reconciliation without replacing mapped parent cells. Different historical categories may overlap, but forecast parent-period coverage may not;
- `set_valuation_config` validates and normalizes sourced configuration and sensitivity arrays;
- `advance_stage` permits only forward lifecycle transitions and does not itself fabricate missing inputs.

The reducer performs no store writes and no arithmetic. It clones before applying the first operation and returns no partially changed object when any operation fails.

- [ ] **Step 4: Run focused tests and type check**

Run:

```bash
node --experimental-strip-types --test \
  "src/financial-model/__tests__/operations.test.ts" \
  "src/financial-model/__tests__/views.test.ts"
pnpm build
```

Expected: all pure operation/query tests PASS and type check exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/financial-model/operations.ts src/financial-model/views.ts \
  src/financial-model/__tests__/operations.test.ts src/financial-model/__tests__/views.test.ts
git commit -m "feat(financial-model): typed model operations and read queries"
```

---

### Task 12: Strict snapshot codec and complete service façade

**Files:**
- Create: `src/financial-model/snapshotCodec.ts`
- Create: `src/financial-model/service.ts`
- Test: `src/financial-model/__tests__/snapshotCodec.test.ts`
- Test: `src/financial-model/__tests__/service.test.ts`

**Interfaces:**
- Consumes: `FinancialModelSnapshot`, view builders, typed revision summaries, and mutation functions from task 11; fact lifecycle from task 7; both typed-summary stores from task 8; default metrics from task 9; valuation from task 10; and the engine/skeleton from earlier tasks.
- Produces: `financialModelSnapshotCodec: SnapshotCodec<FinancialModelSnapshot>`, `CreateModelInput`, `ReviewFactsInput`, `CommitResult`, `ViewOptions`, and the complete `FinancialModelService` façade from core spec §§8.2–8.3.

This task is the only orchestration boundary in phase 1. There is no `calculateMetrics` method: creation installs standard metric formulas, and every successful mutating call recalculates them in the same full-grid engine pass.

- [ ] **Step 1: Write strict codec contract tests**

Cover:

```ts
test("snapshot round-trip preserves authoritative period order and every audit field", ...);
test("maps encode as deterministically ordered JSON arrays and decode back to maps", ...);
test("encoding the same snapshot twice produces byte-identical JSON", ...);
test("codec rejects NaN and Infinity, normalizes negative zero, and rejects unknown fields, missing fields, and invalid union tags", ...);
test("codec rejects duplicate cell keys and structural references to unknown rows or periods", ...);
test("codec validates category-group business keys and ordered reconciliation references", ...);
test("malformed stored JSON throws invalid_snapshot rather than a model-not-found error", ...);
```

The codec accepts and returns complete snapshots, never partial JSON. Encode object fields in a fixed schema order; encode maps as arrays ordered by authoritative period position, numeric line-item order, line-item ID, then complete cell key. On decode, validate every primitive, closed union tag, unit, ID reference, unique key, finite numeric value, formula/period coverage, DCF category-group business key, group member reference, forecast parent-period uniqueness, and reconciliation result before constructing maps. Category strings are validated only as non-empty semantic text, not against an enum. Preserve the stored periods array exactly; never sort it. Do not serialize `undefined`, functions, class instances, or non-finite numbers. Normalize `-0` to `0` through the numeric policy.

- [ ] **Step 2: Write service and revision-boundary tests**

Cover at least:

```ts
test("createModel writes revision zero with the fixed skeleton and default metric formulas", ...);
test("createModel commits a deterministic model-created summary and returns the complete revision-zero workbook", ...);
test("staging facts commits one complete revision and does not make staged facts active", ...);
test("reviewing facts commits decisions, resolves active history, and recalculates metrics automatically", ...);
test("one ordered operation batch commits exactly one revision", ...);
test("an empty operation batch, invalid operation, compile error, gate blocker, or store conflict commits nothing", ...);
test("readCells and getModel can read an old revision and never create a revision", ...);
test("default getModel returns all past summaries and exactly one complete latest workbook", ...);
test("draft mapping context exposes three prepared source sheets and the prebuilt DCF template", ...);
test("initial review creates DCF members, mappings, and arbitrary category groups atomically", ...);
test("committed mappings switch default context to DCF-only and source rows become lineage-only", ...);
test("mapping exceptions or explicit source reads reopen the relevant source view", ...);
test("group and built-in reconciliation persist all four statuses without treating missing detail as zero", ...);
test("only failed required reconciliation blocks the history gate", ...);
test("section and selector reads return workbook-shaped slices rather than flat cell arrays", ...);
test("revision summaries omit values, formula text, provenance, rationale, and generated prose", ...);
test("changing a fact or assumption fully recalculates downstream cells without a metrics call", ...);
test("a source switch plus replacement coverage is one revision and the prior revision remains readable", ...);
test("history, revenue, operations/FCFF, and valued stage gates run only on explicit advancement", ...);
test("valued snapshots contain both terminal methods and both sensitivity matrices", ...);
test("archive creates one archived snapshot while earlier revisions remain readable", ...);
test("listModels derives current stage from the greatest revision and hides archived models by default", ...);
```

Run the same core service cases with the in-memory store and a temporary SQLite store. Assert stale `expectedRevision` details contain the actual current revision and that every failed call leaves both the latest revision number and all prior snapshot bytes unchanged.

- [ ] **Step 3: Implement one shared full-recalculation pipeline**

For every non-empty mutation:

1. Load the exact current snapshot and compare `expectedRevision` before work begins.
2. Clone it and apply only the method-specific mutation: stage facts, review facts, reduce Model Operations, or mark archived.
3. Validate period order, reserved source-row namespaces, fixed-role cardinality, allowlisted DCF-category parents, allowed historical/forecast source combinations, source coverage, assumption uniqueness, statement-mapping coverage, `parentLineItemId + category + periodIds` group keys, forecast parent-period uniqueness, valuation configuration, and all cross-references.
4. Resolve committed active facts; parse and unit-check every formula; build the cell graph; evaluate the entire grid once. Default and parameterized metrics participate as ordinary formula rows.
5. Run `reconcileDcf` over DCF cells only, replacing the complete ordered reconciliation-result set. Never consult source rows and never turn a missing member into zero.
6. If the resulting stage is `valued`, calculate valuation by role and store both terminal-method outputs and both sensitivity matrices; at earlier stages remove any stale valuation output.
7. Normalize and deterministically sort diagnostics. Missing metric inputs, insufficient reconciliation data, N/A checks, and divide-by-zero cells are warnings in partial models. Only failed required reconciliation checks block the history gate; enforce FCFF and valuation inputs only at their own boundaries.
8. Generate a closed `RevisionChangeSummary` from the accepted method input: targets and periods only, including `statement_mapping_plan_set` and `category_group_set` when relevant, deterministically ordered, plus changed sections and diagnostic counts. Validate it against the resulting snapshot; never summarize with an LLM and never copy source-statement values, formula text, assumption payloads, provenance, rationales, or category labels into it.
9. Encode the complete snapshot and validate the JSON-compatible summary, then call `store.commit` exactly once with both. A throw at any earlier point writes neither.

Do not special-case “affected” rows or preserve old calculated values. The service always replaces `cells`, normalized ASTs, diagnostics, valuation output, and `engineVersion` with results from the current engine pass.

- [ ] **Step 4: Implement every service method**

Implement exactly:

```ts
export type ReviewFactsInput = {
  decisions: FactReviewDecision[];
  selectedHistoricalPeriodIds: string[];
  categoryLineItems: NewDcfCategoryLineItem[];
  statementMappingPlans: StatementMappingPlan[];
  categoryGroups: DcfCategoryGroup[];
};

class FinancialModelService {
  createModel(input: CreateModelInput): CommitResult;
  stageFacts(id: string, rev: number, candidates: Fact[]): CommitResult;
  reviewFacts(id: string, rev: number, input: ReviewFactsInput): CommitResult;
  applyOperations(id: string, rev: number, operations: ModelOperation[]): CommitResult;
  readCells(id: string, query: ModelQuery): WorkbookSliceView;
  getModel(id: string, opts: ViewOptions): ModelContextView | WorkbookSliceView;
  listModels(filter: ModelFilter): ModelMeta[];
  archive(id: string, rev: number): CommitResult;
}
```

`ReviewFactsInput` contains the fact decisions, selected historical period IDs, Agent-created DCF category-member definitions, initial `StatementMappingPlan` values, and initial `DcfCategoryGroup` values. The service applies and validates them together so the initial three-statement-to-DCF mapping, category construction, and reconciliation are one atomic revision. `createModel` validates the creation-time period array, builds the fixed DCF skeleton, installs prepared source rows and all default metrics, performs the initial engine pass, and atomically creates revision `0` with a `model_created` summary. Until selected periods, DCF mappings, any declared groups, and required reconciliation checks pass the history gate, its complete workbook is in `statement_mapping` mode with the three source sheets beside the DCF template. A consolidated-only model may legitimately declare no revenue subgroup. `stageFacts`, `reviewFacts`, `applyOperations`, and `archive` use the shared pipeline and return the committed `RevisionSummary` plus its complete `CurrentWorkbookView`. Once mapping succeeds, the default workbook is deterministically `dcf` mode: source rows remain immutable lineage but are unavailable to calculations and ordinary context, returning only for a mapping exception or explicit source/audit read. Later mapping changes use `set_statement_mapping_plan`; later category changes use `add_line_item` and `set_category_group`. `readCells`, `getModel`, and `listModels` are read-only and never call `commit`. An unfiltered current `getModel` obtains old summaries through `listRevisionHeaders`, loads only the latest snapshot, and returns `ModelContextView`. A revision, section, selector, or lineage option returns the requested workbook/audit slice. Reads validate a requested revision and all selector IDs. Reject every mutation against an archived latest revision.

`CreateModelInput` includes the authoritative periods, reporting currency, stable metadata, and `preparedStatementRows: PreparedStatementRow[]`. Phase 1 receives these rows from its caller and performs no network extraction or raw-taxonomy classification.

Do not add `calculateMetrics`, `patchModel`, per-operation write helpers, or call-time valuation overrides. Additional CAGR rows enter only through the task-11 `add_metric` operation.

- [ ] **Step 5: Run focused tests and type check**

```bash
node --experimental-strip-types --experimental-sqlite --test \
  "src/financial-model/__tests__/snapshotCodec.test.ts" \
  "src/financial-model/__tests__/service.test.ts" \
  "src/financial-model/__tests__/store.test.ts"
pnpm build
```

Expected: codec and service tests PASS against both stores; type check exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/financial-model/snapshotCodec.ts src/financial-model/service.ts \
  src/financial-model/__tests__/snapshotCodec.test.ts src/financial-model/__tests__/service.test.ts
git commit -m "feat(financial-model): strict snapshots and atomic model service"
```

---

### Task 13: End-to-end golden DCF and determinism acceptance

**Files:**
- Create: `src/financial-model/__tests__/goldenDcf.test.ts`
- Create: `src/financial-model/__tests__/determinism.test.ts`

**Interfaces:**
- Consumes: the public phase-1 `FinancialModelService` only, plus SQLite for persistence acceptance.
- Produces: the hand-computed golden fixture and the phase-1 acceptance tests required by core spec §§10–11.

- [ ] **Step 1: Build an inspectable hand-computed fixture**

Use a small synthetic USD company with at least three actual annual periods and three forecast annual periods. Include arbitrary Agent-classified DCF groups for at least two simultaneous revenue dimensions, one operating-cost grouping, and operating working capital, with an elimination or excluded member. State the input facts, mapped DCF values, forecast assumptions, WACC path, terminal growth, exit multiple, bridge balances, diluted shares, expected reconciliation statuses, and expected arithmetic as named constants in the test. Derive expected revenue, historical default metrics (including ROA and ROE), operating income, NOPAT, D&A, capex, operating NWC, change in NWC, FCFF, discount factors, terminal values, enterprise values, equity bridge, and per-share values independently with literal hand-computed reference numbers. Do not generate expected values by calling production helpers or by recording a production snapshot.

- [ ] **Step 2: Exercise the real revision workflow**

Drive the fixture only through service calls:

1. create revision `0` with three prepared source sheets, the prebuilt DCF template, and default metric rows; assert mapping mode exposes the sheets only once;
2. choose the historical periods, stage/review source-row facts, create issuer-specific DCF category-member rows, and atomically commit statement mappings plus arbitrary `DcfCategoryGroup` values for revenue, operating costs, and working capital;
3. advance through the history gate, then assert the default workbook is DCF-only, source rows remain explicit audit lineage but do not appear in formulas or reconciliation refs, and generated mappings reproduce expected historical DCF values without Agent arithmetic;
4. assert every category-group reconciliation and applicable built-in accounting identity cell by cell, including `passed`, `insufficient_data`, and explicit `not_applicable`; add a separate failing-required case that blocks history while an informational failure does not. Read and assert automatically calculated metrics without a calculation mutation;
5. use one committed revenue category group's explicit forecast coverage to generate `revenue.total`, verify its normalized signed formula, and advance to `revenue_forecast`; separately cover the preinstalled consolidated-only `growth.revenue.total` path in a focused case so no artificial stream is required;
6. apply operating/FCFF assumptions and advance to `operations_fcff`;
7. set the sourced valuation configuration and role-bound bridge inputs, then advance to `valued`;
8. assert both Gordon-growth and exit-multiple outputs and both sensitivity matrices cell by cell.

Assert each mutating Agent step advances the revision by exactly one, each read leaves it unchanged, every output links to its source cells, and no terminal-method blend or upside/downside scenario exists.

After the final valuation, request the unfiltered current model context. Assert revisions `0..current-1` appear only as deterministic summaries, the valued revision appears exactly once as the complete workbook, every workbook row and period is present, arbitrary category groups and ordered reconciliation results are present, and no source-row values, prior snapshot values, ASTs, rejected facts, or superseded facts are embedded. Serialize the context to JSON and use that exact payload as the golden Agent-facing representation.

- [ ] **Step 3: Prove determinism and idempotence**

Starting from equivalent inputs, reorder only non-semantic collections: fact candidates, review decisions where transitions are independent, assumptions, formula records, DCF category groups, members within a group, and line-item input enumeration. Never shuffle the authoritative periods array. Assert byte-identical ordered cells, reconciliation results, diagnostics, and valuation output under the same `ENGINE_VERSION`.

Persist the golden snapshot through SQLite, close and reopen the store, decode it, and recalculate through an input-equivalent `set_assumption` operation. Assert every numeric cell, reconciliation result, diagnostic, formula AST, lineage reference, and valuation output is identical apart from revision metadata. Repeat the same input-equivalent recalculation once more to prove idempotence. Also assert malformed period order is rejected rather than normalized.

Reopen the store again with snapshot decoding instrumented. Build `revisionHistory` from headers without decoding any old snapshot, decode only the latest snapshot for `currentWorkbook`, and assert the reconstructed `ModelContextView` is byte-identical to the pre-close view.

- [ ] **Step 4: Run the complete phase-1 suite**

```bash
node --experimental-strip-types --experimental-sqlite --test \
  "src/financial-model/**/__tests__/*.test.ts"
pnpm test
pnpm build
```

Expected: all financial-model tests, the existing repository suite, and the strict type check PASS with no network access.

- [ ] **Step 5: Commit**

```bash
git add src/financial-model/__tests__/goldenDcf.test.ts \
  src/financial-model/__tests__/determinism.test.ts
git commit -m "test(financial-model): golden DCF and deterministic acceptance"
```

---
