# DCF Core Engine (Phase 1)

Date: 2026-08-04
Status: Approved design; not yet implemented

Parent spec: [Versioned Financial Modeling and DCF Platform](2026-08-04-financial-modeling-dcf-platform-design.md). This document specifies phase 1 of that plan (§19). Where the two differ, the deviations are listed in §12 and the parent spec is amended to match.

## 1. Purpose

Build the calculation and persistence core of the modeling platform: a versioned store of financial models, a restricted formula language, a deterministic calculation engine, a historical metrics library, and a DCF valuation engine.

Phase 1 has no network access and no MCP tools. Historical facts enter as plain data supplied by the caller. This keeps every correctness-critical part of the platform — the parts where a subtle error produces a plausible but wrong valuation — testable as pure functions.

Phase 1 is complete when a hand-computed golden valuation and a determinism test pass. That end-to-end check, not tool integration, is the milestone.

## 2. Scope

### 2.1 Included

- Model, period, line-item, fact, assumption, formula, and revision types.
- SQLite persistence with immutable revisions and optimistic concurrency.
- The full fact lifecycle: staged, committed, and superseded facts, plus Agent review decisions.
- The restricted formula DSL: parser, unit checker, dependency graph, evaluator.
- The historical metrics library (parent spec §9).
- Scenarios: shared actuals and formula structure with `base`, `upside`, and `downside` assumption overrides (parent spec §7.3). Scenario is a coordinate of every cell from the start, because retrofitting a dimension through the store, the engine, and the valuation module later would touch every one of them.
- Engine-native DCF valuation: explicit period, both terminal methods, equity bridge, sensitivity matrices.
- A service façade that phase 2 wraps directly.

### 2.2 Excluded

- All network access, including the SEC Company Facts client.
- Concept mapping from taxonomy concepts to canonical line items — phase 2.
- Construction of TTM periods from quarterly facts — phase 2 (see §4.2).
- MCP tools, `agentId` propagation, and Orchestra integration — phase 2.
- Filing-level XBRL extraction — phase 4.

Facts arrive through `stageFacts` as already-extracted data with provenance. Phase 1 neither knows nor cares whether the caller obtained them from the SEC API, from Arelle, or by hand.

## 3. Module Structure

Dependencies run one way, top to bottom. No module imports one below it.

```text
types.ts        model, period, line item, unit, role, fact, assumption, revision types
periodGrid.ts   ordered period grid: sorting, offset resolution, TTM skipping
dsl/            parser -> AST -> unit checker -> dependency graph
engine.ts       topological evaluation, quantization, cell diagnostics
metrics.ts      the §9 metric library, expressed as generated formulas
valuation.ts    engine-native DCF, binding rows by role
store.ts        ModelStore interface, SqliteModelStore, InMemoryModelStore
service.ts      façade: fact lifecycle, commit pipeline, orchestration
```

Two structural rules carry most of the design's weight:

**`metrics.ts` performs no arithmetic of its own.** It translates a metric definition such as gross margin into the formula `gross_profit / revenue.total` and hands it to the engine. Unit checking, missing-input propagation, and division-by-zero behavior are therefore identical between library metrics and Agent-authored formulas. A second arithmetic path would eventually disagree with the first, and the disagreement would surface as a wrong number rather than as an error.

**`valuation.ts` is the only module permitted to compute outside the DSL.** Parent spec §8.4 gives the reason: terminal value needs to anchor on a specific period rather than an offset, sensitivity analysis needs to expand one calculation across a parameter matrix, and constraints such as `WACC > terminal_growth` must be checked before evaluation. All three are outside what a row-by-row DSL can express safely.

The store follows the existing repository pattern in `src/data/stock/barStore.ts`: an interface, a SQLite implementation opened by a static `open(path)` that accepts `:memory:`, and an in-memory double for tests.

## 4. Data Model

### 4.1 Units

```ts
type Unit =
  | { kind: "currency"; code: string }
  | { kind: "percent" }
  | { kind: "ratio" }
  | { kind: "shares" }
  | { kind: "per_share"; code: string }
  | { kind: "number" };
```

Percentages are stored as decimal fractions: `0.12` means 12%. Presentation converts; arithmetic never does. The unit algebra is parent spec §8.6.

### 4.2 Periods

```ts
type PeriodClass = "actual" | "ttm" | "forecast";

type Period = {
  id: string;
  label: string;      // "FY2025"
  start: string;      // ISO date, inclusive
  end: string;        // ISO date, inclusive
  cls: PeriodClass;
};
```

Periods form one ordered grid. Every formula offset is a position on that grid, never calendar arithmetic, so a fiscal-calendar change or a 53-week year cannot silently shift a reference.

`ttm` periods are skipped by every offset-based function. A trailing-twelve-month window overlaps the fiscal year preceding it, so treating the two as consecutive grid positions produces a growth rate that describes nothing. The engine refuses the comparison rather than warning about it.

Phase 1 implements the `ttm` period class and the skipping rule, with tests, but constructs no TTM periods — that requires quarterly facts, which arrive in phase 2. The rule lives here because it is a property of the period grid, and because splitting it across phases would leave the grid semantics defined in two places.

### 4.3 Line items and roles

```ts
type CellSource = "actual" | "assumption" | "formula" | "calculated" | "none";

type LineItem = {
  id: string;
  label: string;
  parentId?: string;
  role: LineItemRole;
  unit: Unit;
  section: string;
  order: number;
  historical: CellSource;
  forecast: CellSource;
};
```

`historical` and `forecast` are given separately because one row normally has different sources in the two ranges: `revenue.iphone` is `actual` in historical periods and `formula` in forecast periods. That is the common case, not an exception.

Within one `(line item, scenario, period)` the source is single-valued, and the four sources are mutually exclusive:

| Source | Where the value comes from |
| --- | --- |
| `actual` | a committed reviewed fact |
| `assumption` | exactly one assumption record |
| `formula` | the row's formula for that period class |
| `calculated` | engine-native output; not caller-writable |
| `none` | the cell does not exist in that range |

A cell carrying both an assumption and a formula is a definition error, not a precedence question, and is rejected with `invalid_formula`.

`LineItemRole` is a closed union. `valuation.ts` binds rows by role, never by string ID:

```ts
type LineItemRole =
  | "revenue_root" | "revenue_stream" | "revenue_total"
  | "operating_income" | "tax_rate" | "nopat"
  | "depreciation_amortization" | "capex" | "change_nwc" | "fcff"
  | "wacc" | "terminal_growth" | "exit_multiple" | "terminal_metric"
  | "cash" | "non_operating_investments" | "debt" | "lease_liabilities"
  | "preferred_equity" | "non_controlling_interests" | "bridge_other"
  | "diluted_shares"
  | "none";
```

### 4.4 The skeleton

`createModel` generates the standard rows with their roles already bound. Skeleton rows cannot be renamed, re-parented, deleted, or re-roled. A model can therefore never be missing FCFF, and a caller's typo can never silently become "no FCFF row found."

The caller extends the model only at designated extensible parents. In phase 1 that is `revenue`, whose children carry role `revenue_stream`.

Adding a revenue stream creates a **pair** of rows:

```text
revenue.<stream>          historical: actual   forecast: formula
growth.revenue.<stream>   historical: none     forecast: assumption
```

with the default forecast formula `LAG(revenue.<stream>, 1) * (1 + growth.revenue.<stream>)`. The pair is created as a unit because a forecast revenue stream with no growth driver is always a modeling error. The caller may replace the formula, or switch the stream to a direct `assumption` source when a stream is forecast in absolute amounts rather than growth rates.

`revenue.total` is permanently `SUM_CHILDREN(revenue)`. Segment-to-total reconciliation is therefore structurally impossible to violate: a residual can only be expressed as an explicit `revenue.other` or eliminations child, which is exactly the visible row that parent spec §6.4 requires.

### 4.5 Facts

```ts
type FactStatus = "staged" | "committed" | "rejected" | "superseded";

type Fact = {
  factId: string;
  status: FactStatus;
  lineItemId?: string;      // set once mapped
  periodId: string;
  value: number;
  unit: Unit;
  provenance: Provenance;   // source, accession, concept, dimensions, filing URL, as-of date
  supersedesFactId?: string;
};
```

Superseded facts stay in the revision that replaced them. Restatement history is part of the audit trail, not something to be overwritten.

### 4.6 Assumptions

Per parent spec §11, with `values` either length 1 (one constant across all listed periods) or exactly the length of `periods` (a per-period path).

Phase boundaries are expressed as **several assumption records over disjoint period sets**, not as one record with a complex value. This is deliberate: the near years are usually management guidance and the later years are usually analyst inference, so separate records let each phase carry its own `source_type`, `source_refs`, and `rationale`. An auditor can then see directly which years the company stated and which years the analyst extrapolated.

The engine validates only that no two assumptions cover the same `(line item, scenario, period)`.

## 5. Partial Models

Completeness is checked at stage boundaries, never at write time.

A half-built model commits normally. The engine computes what it can; cells it cannot compute hold `value: null` with a `missing_input` diagnostic naming the references responsible. Missing propagates down the dependency graph, so the diagnostic on a downstream cell points back to the original hole.

Only advancing to the `valuation` stage and requesting a per-share value requires the role-bound rows to be populated. A gap there raises `missing_formula_input` or `incomplete_equity_bridge` and the valuation is refused rather than completed with zeros.

The same hole is progress in the middle of modeling and an error at the moment of drawing a conclusion. Deferring the completeness check to the stage boundary is what lets both be true without a second representation for "not yet filled in."

## 6. Numeric Policy

Values are computed in float64 and quantized to 12 significant digits before storage.

The parent spec originally required decimal arithmetic. Phase 1 revises this. Determinism does not require decimal — IEEE 754 is bit-reproducible under a fixed operation order, and §7 fixes that order by evaluating in a deterministic topological sequence. Nor does this system have an exact-cents requirement: inputs are already-rounded reported figures and outputs are valuations. Relative error near 1e-16 corresponds to roughly 1e-5 absolute on the 1e11-magnitude aggregates involved, orders of magnitude inside the XBRL rounding tolerance of parent spec §6.4. Quantization at storage removes the `0.1 + 0.2` display artifacts that motivate decimal in the first place, at zero dependency cost.

The evaluation order is part of the reproducibility contract. Topological order is made total by breaking ties on line-item `order`, then `id`, so the same model always evaluates in the same sequence.

The calculation-engine version accompanies every revision. Any change to arithmetic, quantization, or ordering increments it, so stored results become identifiably stale rather than silently inconsistent with what the current engine would produce.

## 7. The Commit Pipeline

Every mutating operation runs the same pipeline and differs only in step 2.

```text
1. Load the current revision snapshot.
2. Apply this operation's change to an in-memory working copy.   <- the only variation
3. Compile all formulas: parse, unit-check, build the dependency graph.
      fails with invalid_formula / incompatible_units / circular_dependency
4. Evaluate the whole grid, producing values and per-cell diagnostics.
5. If the stage is `valuation`, run valuation.ts, binding rows by role.
6. Sort diagnostics into blockers and warnings.
7. Blockers -> throw, writing nothing.
   Otherwise -> store.commit(expectedRevision, snapshot).
```

Three requirements from the parent spec are properties of this shape rather than conventions each operation must remember: blocking errors leave the current revision untouched (§13.4), every affected downstream cell is recalculated after a change (§8.7), and each accepted change produces exactly one immutable revision (§5.3).

Full recalculation is unconditional. A model is roughly ten periods by fifty rows; five hundred cells sort and evaluate in microseconds. Incremental recalculation would buy nothing and introduce a class of bug — a cell that should have been recomputed but was not — that is invisible until a number is wrong.

The dependency graph is over `(line item, period)` nodes rather than rows. A lagged self-reference such as `LAG(revenue.iphone, 1) * (1 + growth.revenue.iphone)` on the `revenue.iphone` row is a legal chain between adjacent periods; a cycle is a cycle among cells.

## 8. Interfaces

### 8.1 Store

```ts
interface ModelStore {
  create(meta: NewModelMeta): ModelMeta;
  getMeta(modelId: string): ModelMeta | undefined;
  list(filter: ModelFilter): ModelMeta[];
  getRevision(modelId: string, revision?: number): Revision | undefined;  // omitted = current
  commit(modelId: string, expectedRevision: number, snapshot: Snapshot): Revision;
}
```

`Snapshot` holds the complete content of one revision: periods, line items, facts, assumptions, formulas with their normalized ASTs, computed cells, diagnostics, engine version, and canonical input hash.

Revisions are stored as full snapshots, not deltas. A model is tens of kilobytes, so an audit query is a single primary-key read with no replay, and immutability needs no reconstruction logic to be trustworthy.

`commit` throws `RevisionConflictError` when `expectedRevision` does not match; the error carries the current revision so the caller can re-read without an extra round trip.

The canonical input hash covers periods, line items, facts, assumptions, formula ASTs, and the engine version, serialized in a canonical key order. Two models with the same hash must produce the same values.

### 8.2 Service façade

```ts
class FinancialModelService {
  createModel(input: CreateModelInput): CommitResult;
  stageFacts(id: string, rev: number, candidates: StagedFact[]): CommitResult;
  reviewFacts(id: string, rev: number, decisions: ReviewDecision[]): CommitResult;
  updateStage(id: string, rev: number, stage: Stage, changes: StageChanges): CommitResult;
  calculateMetrics(id: string, rev: number, opts: MetricOptions): CommitResult;
  getModel(id: string, opts: ViewOptions): ModelView;   // read-only, bypasses the pipeline
  listModels(filter: ModelFilter): ModelMeta[];
  archive(id: string, rev: number): CommitResult;
}
```

`CommitResult` is the envelope from parent spec §5.3: `{ modelId, revision, status, warnings, ...payload }`.

The seven methods correspond one-to-one with the seven MCP tools of phase 2, which reduces that phase to argument validation and response shaping.

## 9. Error Handling

Failures divide into two kinds with two different representations. The split is what makes §5 possible: if every uncomputable cell threw, no partial model could ever be committed.

**Cell diagnostics are data.**

```ts
type Cell = { value: number | null; unit: Unit; diagnostics: Diagnostic[] };

type Diagnostic = {
  code: "missing_input" | "divide_by_zero" | "skipped_ttm" | "not_applicable";
  refs: string[];
};
```

`value: null` means missing and is never `0`. This is design principle 4 — no hidden defaults — enforced by the type rather than by discipline.

**Operation errors throw, and a throw writes nothing.**

Following the `SecApiError` pattern in `mcp_tools/sec/secClient.ts`:

```ts
class FinancialModelError extends Error {
  readonly code: FinancialModelErrorCode;
  readonly details?: JsonObject;
}
```

Phase 1 raises `financial_model_not_found`, `revision_conflict`, `invalid_formula`, `circular_dependency`, `incompatible_units`, `incompatible_periods`, `history_review_required`, `unresolved_reconciliation`, `invalid_terminal_assumptions`, and `incomplete_equity_bridge`. The `xbrl_*` codes belong to phase 4; `unsupported_model_type` requires filer resolution and belongs to phase 2.

`missing_formula_input` spans both kinds. It is a cell diagnostic during modeling and becomes a thrown blocker at the valuation gate, which is how §5 draws the line between an unfinished model and an unsound conclusion.

## 10. Testing

Every module gets pure-function tests. Four checks carry the phase:

1. **Golden end-to-end valuation.** A synthetic company with hand-computed reference values, verified cell by cell from reviewed revenue through FCFF, terminal value, enterprise value, the equity bridge, and implied value per share. Synthetic rather than real: hand-computed figures must be inspectable, or a failure cannot be attributed between the engine and the reference. Hand-computed rather than snapshot-recorded: a snapshot only proves the engine still does what it did.
2. **Determinism.** The same inputs calculated twice produce identical stored values and an identical canonical input hash.
3. **Recalculation idempotence.** Committing again without changing any input leaves every cell unchanged. This guards the unconditional full recalculation in step 4 of the pipeline against order dependence.
4. **Store behavior.** Against `:memory:`: revision conflicts, immutable history, superseded facts retained, archived models still readable by revision.

Beyond those: DSL parsing and precedence, offset resolution across the actual/forecast boundary, TTM skipping, circular dependencies, missing-reference propagation, division by zero, every row of the unit algebra table, expression complexity limits, scenario isolation, metric golden cases with negative and zero denominators, both discount conventions, both terminal methods, invalid WACC/growth combinations, and both sensitivity matrices.

The `test` script in `package.json` enumerates test directories explicitly and does not currently include `src/financial-model/**`. That glob must be added before the first test file, otherwise the entire suite passes by not running.

## 11. Acceptance Criteria

Phase 1 is accepted when:

1. A model can be created with a standard skeleton, a configurable period grid, and role-bound rows.
2. Facts can be staged, reviewed, committed, and superseded, with superseded facts retained in revision lineage.
3. Revenue streams can be added as pairs, forecast by formula or by direct assumption, with `revenue.total` structurally equal to the sum of its children.
4. Assumptions support per-period paths and disjoint phase records, each carrying its own provenance.
5. A partial model commits successfully, with uncomputable cells null and diagnosed.
6. A valuation is refused, not defaulted, when role-bound inputs are missing.
7. The golden hand-computed DCF matches cell by cell.
8. The same inputs produce identical values and hash across runs, and recalculation is idempotent.
9. A stale `expected_revision` raises `revision_conflict` and leaves the model unchanged.
10. The whole phase runs with no network access.

## 12. Deviations from the Parent Spec

1. **Numeric policy (§8.5).** Float64 with quantization at storage replaces decimal arithmetic, for the reasons in §6. The parent spec is amended.
2. **TTM (§7.1).** The period class and skipping rule ship in phase 1; TTM construction is phase 2. No conflict, a clarification of ownership.
3. **Line-item classification (§7.2).** Classification is per period range, not per row. The parent spec is amended to say so.
4. **The skeleton and roles (§7.2).** The parent spec left row identity as string IDs. Phase 1 adds a generated skeleton with an immutable `role` field, and valuation binds by role. The parent spec is amended.
