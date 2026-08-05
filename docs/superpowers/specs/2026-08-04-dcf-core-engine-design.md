# DCF Core Engine (Phase 1)

Date: 2026-08-04
Status: Approved design; not yet implemented

Parent spec: [Versioned Financial Modeling and DCF Platform](2026-08-04-financial-modeling-dcf-platform-design.md). This document specifies phase 1 of that plan (§19). Where the two differ, the deviations are listed in §12 and the parent spec is amended to match.

## 1. Purpose

Build the calculation and persistence core of the modeling platform: a versioned store of financial models, a typed model-operations protocol, a restricted formula language, a deterministic calculation engine, a historical metrics library, and a DCF valuation engine.

Phase 1 has no network access and no MCP tools. Historical facts enter as plain data supplied by the caller. This keeps every correctness-critical part of the platform — the parts where a subtle error produces a plausible but wrong valuation — testable as pure functions.

Phase 1 is complete when a hand-computed golden valuation and a determinism test pass. That end-to-end check, not tool integration, is the milestone.

## 2. Scope

### 2.1 Included

- Model, period, line-item, fact, assumption, formula, and revision types.
- SQLite persistence with immutable revisions and optimistic concurrency.
- The full fact lifecycle: staged, committed, rejected, and superseded facts, plus retained review decisions.
- The typed Model Operations DSL used to query and mutate a working model without exposing a generic patch mechanism.
- The restricted formula DSL: parser, unit checker, dependency graph, evaluator.
- The default and parameterized metric registry (parent spec §9), installed as Formula DSL rows and recalculated automatically.
- One versioned forecast assumption set. Phase 1 does not model named operating scenarios; valuation uncertainty is expressed by the two sensitivity matrices.
- Engine-native DCF valuation: explicit period, both terminal methods, equity bridge, sensitivity matrices.
- A service façade that phase 2 wraps directly.

### 2.2 Excluded

- All network access, including the SEC Company Facts client.
- Mapping raw taxonomy concepts into stable prepared-statement source rows — phase 2. Phase 1 does include reviewed source-row-to-DCF mapping plans over already-prepared statements.
- Construction of TTM periods from quarterly facts — phase 2 (see §4.2).
- MCP tools, `agentId` propagation, and Orchestra integration — phase 2.
- Filing-level XBRL extraction — phase 4.

Facts arrive through `stageFacts` as already-extracted data with provenance and a prepared source-row identity. Phase 1 neither knows nor cares whether the caller obtained them from the SEC API, from Arelle, or by hand.

## 3. Module Structure

Dependencies run one way, top to bottom. No module imports one below it.

```text
types.ts        model, period, line item, unit, role, fact, assumption, revision types
periodGrid.ts   ordered period grid: sorting, offset resolution, TTM skipping
dsl/            parser -> AST -> unit checker -> dependency graph
engine.ts       topological evaluation, quantization, cell diagnostics
metrics.ts      default and parameterized §9 registry, expressed as generated formulas
valuation.ts    engine-native DCF, binding rows by role
operations.ts   typed model queries and mutations over an in-memory snapshot
store.ts        ModelStore interface, SqliteModelStore, InMemoryModelStore
service.ts      façade: operation batches, fact lifecycle, commit pipeline, orchestration
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

`number`, `percent`, and `ratio` are all dimensionless for arithmetic, but remain distinct semantic units for validation and presentation. The checker preserves those semantics rather than collapsing every dimensionless value into `number`:

- Literal `0` is a polymorphic additive zero. It may be added to or subtracted from a value of any numeric unit and may be assigned as an explicit zero formula to any numeric target. It adopts the other operand's or target's unit without making arbitrary numbers compatible with currency.
- Literal `1` is the dimensionless identity. In `1 + percent`, `1 - percent`, `1 + ratio`, and `1 - ratio`, the result is `ratio`. This makes growth and tax formulas legal while a literal such as `10 + tax_rate` remains `incompatible_units`.
- Scaling a `percent` or `ratio` by a `number` preserves the non-`number` semantic unit. Multiplying or dividing two percentages or ratios returns `ratio`. Adding or subtracting equal semantic units preserves that unit; mixing `percent` and `ratio` returns `ratio`.
- `YOY` and `CAGR` return `percent`; division of like currencies returns `ratio`; `ABS` preserves its input unit.
- `POW` accepts only a dimensionless base and a `number` exponent. Its result is `ratio`; unit-bearing bases are rejected.
- `DISCOUNT_FACTOR(wacc)` requires a `percent` or `ratio` line-item reference, follows that reference's path from the first forecast period strictly after `ValuationConfig.anchorPeriodId` through the current period, and returns `ratio`.
- A compiled formula's result must be compatible with the target line item's declared unit. Compatibility for `number`, `percent`, and `ratio` means the same physical dimension plus the function and literal rules above; presentation always follows the target line item's declared unit.

These rules intentionally make the skeleton formulas `1 + growth`, `1 - tax_rate`, and `YOY(ref)` legal without allowing general addition between unit-bearing values and arbitrary numeric literals.

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

The caller supplies periods in authoritative chronological order when the model is created. The engine preserves that array exactly and never sorts it. It validates unique IDs, valid ISO start/end dates, nondecreasing end dates, strictly increasing end dates among non-TTM periods, and the class sequence `actual* -> ttm? -> forecast*`; an invalid sequence is `incompatible_periods`. The period list and its order are immutable after creation.

Periods therefore form one explicit ordered grid. Every formula offset is a position on that grid, never calendar arithmetic, so a fiscal-calendar change or a 53-week year cannot silently shift a reference. “Same periods in a different array order” is a different and invalid timeline, not an input permutation the engine should normalize.

`ttm` periods are skipped by every offset-based function. A trailing-twelve-month window overlaps the fiscal year preceding it, so treating the two as consecutive grid positions produces a growth rate that describes nothing. The engine refuses the comparison rather than warning about it.

Phase 1 implements the `ttm` period class and the skipping rule, with tests, but constructs no TTM periods — that requires quarterly facts, which arrive in phase 2. The rule lives here because it is a property of the period grid, and because splitting it across phases would leave the grid semantics defined in two places.

### 4.3 Line items and roles

```ts
type CellSource = "actual" | "assumption" | "formula" | "calculated" | "none";

type LineItemSection =
  | "source_income_statement" | "source_balance_sheet" | "source_cash_flow"
  | "history" | "metrics" | "revenue" | "operations" | "dcf";

type LineItem = {
  id: string;
  label: string;
  parentId?: string;
  role: LineItemRole;
  unit: Unit;
  section: LineItemSection;
  order: number;
  historical: CellSource;
  forecast: CellSource;
};
```

`historical` and `forecast` are given separately because one row normally has different sources in the two ranges: `revenue.iphone` is `actual` in historical periods and `formula` in forecast periods. That is the common case, not an exception.

Within one `(line item, period)` the source is single-valued, and the four sources are mutually exclusive:

| Source | Where the value comes from |
| --- | --- |
| `actual` | a committed reviewed fact |
| `assumption` | exactly one assumption record |
| `formula` | the row's formula for that period class |
| `calculated` | engine-native output; not caller-writable |
| `none` | the cell does not exist in that range |

A cell carrying both an assumption and a formula is a definition error, not a precedence question, and is rejected with `invalid_formula`.

Formula coverage can be narrowed to explicit periods so reviewed classifications may change over time:

```ts
type Formula = {
  lineItemId: string;
  appliesTo: "historical" | "forecast";
  periodIds?: string[]; // omitted means every period in appliesTo
  source: string;
  ast: FormulaAst;
};
```

Every explicit period must belong to `appliesTo`. Two formulas may not cover the same `(line item, period)` cell. Revenue and working-capital plan compilers emit explicit coverage and replace a default formula only for the reviewed periods, which makes segment or account-definition changes executable rather than merely descriptive.

`LineItemRole` is a closed union. `valuation.ts` binds rows by role, never by string ID:

```ts
type LineItemRole =
  | "revenue_root" | "revenue_stream" | "revenue_total"
  | "operating_income" | "tax_rate" | "nopat"
  | "depreciation_amortization" | "ebitda" | "capex"
  | "operating_working_capital" | "change_nwc" | "fcff"
  | "wacc" | "terminal_growth" | "exit_multiple"
  | "cash_available_for_bridge" | "non_operating_investments" | "debt" | "lease_liabilities"
  | "preferred_equity" | "non_controlling_interests" | "bridge_other"
  | "diluted_shares"
  | "none";
```

Revenue disclosure hierarchies are not inferred from `parentId` during evaluation. A company may disclose product, geography, and operating-segment breakdowns that each independently sum to consolidated revenue; adding every revenue child would double- or triple-count the company. The reviewed aggregation decision is therefore stored explicitly:

```ts
type RevenueAggregationTreatment = "add" | "subtract" | "exclude";

type RevenueAggregationPlan = {
  periodIds: string[];
  reportedTotalId: string;
  aggregationSet: string; // for example "product", "segment", "geography", or "custom"
  members: Array<{
    lineItemId: string;
    treatment: RevenueAggregationTreatment;
  }>;
  reviewDecisionId: string;
};
```

Plans for the same model must cover disjoint period sets. This permits a company to change its segment definition without silently applying the new grouping to old periods.

Prepared source-statement categories do not become DCF rows merely because their labels look familiar. Store their reviewed mapping explicitly:

```ts
type StatementMappingPlan = {
  targetLineItemId: string;
  periodIds: string[];
  members: Array<{
    sourceLineItemId: string;
    treatment: "add" | "subtract" | "exclude";
  }>;
  reviewDecisionId: string;
};
```

`PreparedStatementRow` carries `sourceLineItemId`, statement kind, original label, unit, and source order. Source statement rows use the reserved `source.<statement>.*` namespace and the three `source_*` sections. A committed source fact maps one-to-one to one source row and period. A reviewed statement plan selects the usable periods and vertical categories, covers a disjoint target-period set, and compiles to an explicit signed historical formula on the canonical DCF target. Its identity is the target plus period coverage; it has no caller-supplied plan ID. This permits several source rows to feed COGS or operating expenses without weakening the one-active-fact-per-source-cell invariant. Source rows remain in the snapshot for audit but are hidden from the normal post-mapping DCF workbook.

Balance-sheet hierarchy is equally unsafe as an operating-working-capital rule. Cash, debt, lease liabilities, and non-operating investments can all appear within current assets or current liabilities but must not enter operating NWC. Store that reviewed classification separately:

```ts
type WorkingCapitalAggregationPlan = {
  periodIds: string[];
  members: Array<{
    lineItemId: string;
    treatment: "operating_asset" | "operating_liability" | "exclude";
  }>;
  reviewDecisionId: string;
};
```

No aggregation plan has a caller-supplied identifier. Revenue plans are located by `reportedTotalId + aggregationSet + periodIds`; working-capital plans are located by `periodIds` because their target is the unique operating-NWC row. Plans for one model cover disjoint period sets. The generated normalized working-capital formula is `sum(operating_asset) - sum(operating_liability)`. The initial proposal classifies accounts receivable, inventory, and other operating current assets as operating assets, and accounts payable, deferred revenue, accrued operating liabilities, and other operating current liabilities as operating liabilities. Cash and cash equivalents, restricted cash, marketable securities, short-term borrowings, current debt, and lease liabilities default to `exclude`. These are proposal defaults only; the reviewed plan is authoritative. The cash-flow-statement line for reported changes in operating assets and liabilities is reconciliation evidence only; it is never added to a balance-derived `change_nwc`, which would double count the same cash use or source.

### 4.4 The skeleton

`createModel` generates the standard rows with their roles already bound. Skeleton rows cannot be renamed, re-parented, deleted, or re-roled. Their period-range source and formula may be changed through a reviewed revision except for registry-owned metric definitions, which are immutable. A model can therefore never be missing FCFF, and a caller's typo can never silently become "no FCFF row found."

The skeleton is a DCF chart of accounts, not an attempt to reproduce every issuer caption. Its fixed spine is:

| ID | Role | Historical | Forecast | Default or rule |
| --- | --- | --- | --- | --- |
| `revenue` | `revenue_root` | `none` | `none` | Extensible disclosure parent. |
| `revenue.total` | `revenue_total` | `actual` or mapping `formula` | `formula` | Independent reported total historically; `LAG(revenue.total, 1) * (1 + growth.revenue.total)` for a consolidated-only forecast, or a generated revenue plan. |
| `growth.revenue.total` | `none` | `formula` | `assumption` | Historical `YOY(revenue.total)`; sourced consolidated-growth forecast driver. |
| `margin.operating` | `none` | `formula` | `assumption` | `operating_income / revenue.total`; forecast driver. |
| `operating_income` | `operating_income` | `actual` or mapping `formula` | `formula` | `revenue.total * margin.operating`. EBIT is represented by operating income, not net income or operating cash flow. |
| `tax_rate` | `tax_rate` | `formula` | `assumption` | Historical effective-rate evidence is `income_tax_expense / pretax_income`; the reviewed forecast input is the normalized operating tax rate used for NOPAT. |
| `nopat` | `nopat` | `formula` | `formula` | `operating_income * (1 - tax_rate)`. |
| `depreciation_amortization` | `depreciation_amortization` | `actual` or mapping `formula` | `formula` | `revenue.total * ratio.da_to_revenue`; non-cash add-back. |
| `ratio.da_to_revenue` | `none` | `formula` | `assumption` | `depreciation_amortization / revenue.total`; forecast driver. |
| `ebitda` | `ebitda` | `formula` | `formula` | `operating_income + depreciation_amortization`; the only exit-multiple EBITDA role. |
| `capital_expenditures` | `capex` | `actual` or mapping `formula` | `formula` | Stored as a positive cash outflow; `revenue.total * ratio.capex_to_revenue`. |
| `ratio.capex_to_revenue` | `none` | `formula` | `assumption` | `capital_expenditures / revenue.total`; forecast driver. |
| `operating_working_capital` | `operating_working_capital` | `formula` | `formula` | Generated from the reviewed working-capital plan historically; `revenue.total * ratio.operating_nwc_to_revenue` in forecast. |
| `ratio.operating_nwc_to_revenue` | `none` | `formula` | `assumption` | `operating_working_capital / revenue.total`; forecast driver. |
| `change_nwc` | `change_nwc` | `formula` | `formula` | `operating_working_capital - LAG(operating_working_capital, 1)`; positive means a use of cash. |
| `fcff` | `fcff` | `formula` | `formula` | `nopat + depreciation_amortization - capital_expenditures - change_nwc`. |
| `wacc` | `wacc` | `none` | `assumption` | One value per forecast year; the final value is terminal WACC. |
| `terminal_growth` | `terminal_growth` | `none` | `assumption` | Required at the final forecast period for Gordon growth. |
| `exit_multiple` | `exit_multiple` | `none` | `assumption` | Required at the final forecast period for the exit method. |

Driver formulas are defaults, not accounting assertions. Review may replace a forecast formula or switch a row to a direct assumption, but the role identity and sign convention stay fixed. A historical ratio with zero or missing denominator remains null with a diagnostic; it is never silently filled with zero. If historical effective tax expense is not representative of an operating tax rate, review must supply a normalized, sourced forecast assumption rather than carrying the historical formula forward.

The following canonical US-GAAP rows are prebuilt in the DCF workbook with role `none`. They are targets for reviewed source-statement plans, not raw source rows. They use historical formulas when a plan covers them, default to `none` in forecast periods, and may remain empty when an issuer does not present the caption separately:

| Statement | Standard optional rows |
| --- | --- |
| Income statement | `cost_of_revenue`, `gross_profit`, `research_and_development`, `selling_and_marketing`, `general_and_administrative`, `other_operating_expenses`, `operating_expenses`, `interest_income`, `interest_expense`, `non_operating_income_expense`, `pretax_income`, `income_tax_expense`, `net_income`, `net_income_attributable_nci`, `diluted_eps` |
| Balance sheet | `cash_and_equivalents`, `restricted_cash`, `short_term_investments`, `accounts_receivable`, `inventory`, `other_operating_current_assets`, `accounts_payable`, `deferred_revenue`, `accrued_operating_liabilities`, `other_operating_current_liabilities`, `property_plant_equipment`, `total_current_assets`, `total_assets`, `total_current_liabilities`, `shareholders_equity` |
| Cash flow statement | `operating_cash_flow`, `reported_change_operating_assets_liabilities`, `asset_sale_proceeds`, `acquisitions`, `net_investing_cash_flow`, `debt_issuance`, `debt_repayment`, `dividends`, `share_repurchases` |

Acquisitions, asset-sale proceeds, debt issuance and repayment, dividends, and repurchases do not enter the FCFF formula. They remain available for audit, reconciliation, and later analytics.

The skeleton also installs the parent spec §9 default metric registry as historical formula rows. This includes growth, margins, cash conversion, current ratio, leverage, net debt, ROA, ROE, ROIC, and diluted per-share metrics, plus stored helper formulas for free cash flow and invested capital. Driver rows already present in the DCF spine, including `growth.revenue.total`, `margin.operating`, `tax_rate`, and the D&A/capex/operating-NWC revenue ratios, serve both the model and the metrics view rather than being duplicated. Adding a revenue stream changes its companion `growth.revenue.<stream>` row to historical `formula` / forecast `assumption`, with `YOY(revenue.<stream>)` installed for actual periods.

Metric outputs are never Agent-writable. They recalculate during every normal engine pass and remain null with cell diagnostics until their inputs exist. Default total-revenue CAGR rows use three- and five-period lookbacks. `add_metric` may install another registry-defined CAGR row for an allowlisted target and bounded integer lookback; the registry derives its stable ID, unit, actual-period coverage, and normalized formula. A custom metric uses the designated custom-metrics namespace plus `set_formula` and cannot use or replace a registry ID.

The equity-bridge spine is separate from both raw balance-sheet captions and FCFF:

| ID | Role | Cardinality | Sign in equity bridge |
| --- | --- | --- | --- |
| `cash_available_for_bridge` | `cash_available_for_bridge` | exactly one | add |
| `non_operating_investments` | `non_operating_investments` | exactly one | add |
| `debt` | `debt` | exactly one | subtract |
| `lease_liabilities` | `lease_liabilities` | exactly one | subtract |
| `preferred_equity` | `preferred_equity` | exactly one | subtract |
| `non_controlling_interests` | `non_controlling_interests` | exactly one | subtract |
| `bridge_other.<name>` | `bridge_other` | zero or more | explicit add or subtract in its reviewed definition |
| `diluted_shares` | `diluted_shares` | exactly one | denominator |

Raw `cash_and_equivalents` is not automatically cash available for the bridge. Review classifies restricted cash and required operating cash and records how `cash_available_for_bridge` was derived. A bridge row may resolve from a reviewed fact, a formula over reviewed facts, or a sourced assumption after its source classification is changed in the same revision. Optional bridge adjustments require either a numeric resolution or explicit `not_applicable`; diluted shares is always numeric.

Role cardinality is validated before valuation. There is exactly one of every fixed DCF and fixed bridge role, zero or more `revenue_stream` and `bridge_other` roles, and no `terminal_metric` role: `ValuationConfig.exitTerminalMetric` selects the unique `ebitda` or `fcff` row directly.

The caller extends the model only at designated extensible parents. In phase 1 these are `revenue`, whose children carry role `revenue_stream`, and the custom-metrics namespace, whose rows carry role `none` and cannot impersonate a registry ID.

Adding a revenue stream creates a **pair** of rows:

```text
revenue.<stream>          historical: actual   forecast: formula
growth.revenue.<stream>   historical: formula  forecast: assumption
```

with `YOY(revenue.<stream>)` over explicit actual periods and the default forecast formula `LAG(revenue.<stream>, 1) * (1 + growth.revenue.<stream>)`. The pair is created as a unit because a forecast revenue stream with no growth driver is always a modeling error. The caller may replace the forecast formula, or switch the stream to a direct `assumption` source when a stream is forecast in absolute amounts rather than growth rates; it may not replace the registry-owned historical growth formula.

`revenue.total` is an independently reviewed consolidated value in historical periods, resolved either from one direct committed fact or from a one-member source-statement mapping plan. A consolidated-only model uses the preinstalled `growth.revenue.total` assumption path and default formula `LAG(revenue.total, 1) * (1 + growth.revenue.total)`, so it needs neither a hard-coded growth literal nor an artificial segment row. When reviewed disaggregated revenue is available, `RevenueAggregationPlan` replaces that default formula only for its explicit forecast periods. `add` members are added, `subtract` members are subtracted, and `exclude` members remain visible disclosures but do not enter the formula. The normalized generated formula and the plan are both stored in the revision.

The caller in phase 1, and the Agent in phase 2, may propose classifications and an aggregation set. The calculation engine never asks a language model how to add values and never infers membership from labels or hierarchy: it validates the committed plan and executes its generated formula deterministically through the same DSL evaluator used by every other formula.

For every historical period covered by a plan, the engine separately reconciles the signed member sum to the independently resolved `reportedTotalId` cell. Only one aggregation set may be active for a period. Product, geography, segment, subtotal, and disclosure-only rows therefore cannot be combined accidentally. Any residual must be an explicit `add` or `subtract` member such as `revenue.other` or `revenue.eliminations`, or the period remains blocked by `unresolved_reconciliation`. Formula DSL contains no hierarchy-summing function; all category aggregation is an explicit normalized formula produced from the reviewed plan.

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

type ActiveFact = Fact & {
  status: "committed";
  lineItemId: string;
};

type FactReviewDecision = {
  decisionId: string;
  factId: string;
  action: "commit" | "reject" | "supersede";
  mappedLineItemId?: string; // required for commit; omitted for supersede
  replacementFactId?: string; // required only for supersede
  rationale: string;
  reviewedBy: string;
  reviewedAt: string;
};
```

`factId` is unique within a model. A fact's value, unit, period, and provenance are immutable after creation; a correction or restatement creates a new fact rather than editing the old payload. Review may set or change a staged candidate's proposed `lineItemId`, but the accepted mapping becomes immutable when the fact leaves `staged`. Status changes occur only through reviewed revisions:

```text
staged -> committed
staged -> rejected
committed -> superseded   // only atomically with a replacement commit
```

`rejected` and `superseded` are terminal. A replacement fact names the previous active fact in `supersedesFactId`; the predecessor must be committed in the parent revision and have the same mapped line item, period, and unit. The replacement commit creates both a `commit` decision for the new fact and a `supersede` decision naming it for the old fact. Manual corrections follow the same path as filing restatements.

At most one committed fact may exist for each `(lineItemId, periodId)`. Multiple staged or rejected candidates may coexist with that active fact, but they never affect calculation. Reviewing a replacement, superseding the predecessor, and recalculating happen in an in-memory working copy and are persisted together by inserting one complete revision snapshot. A rejection leaves the existing committed fact active. Any validation, calculation, or insert failure leaves the prior revision current and every stored fact and decision unchanged.

Each decision is retained with reviewer, time, and rationale. Superseded facts and all prior decisions remain in the replacement revision and in every earlier immutable revision, so restatement history is never overwritten.

The service validates the lifecycle and resolves `ActiveFact[]`. `engine.ts` accepts only that narrowed type; it neither filters mixed statuses nor chooses among duplicates. More than one active fact for a cell raises `fact_conflict` before evaluation.

### 4.6 Assumptions

An assumption resolves its cells either with numeric values or with an explicit not-applicable decision:

```ts
type AssumptionPayload =
  | { kind: "values"; values: number[]; unit: Unit }
  | { kind: "not_applicable" };

type Assumption = {
  assumptionId: string;
  lineItemId: string;
  periods: string[];
  payload: AssumptionPayload;
  sourceType: AssumptionSourceType;
  sourceRefs: string[];
  asOfDate: string;
  rationale: string;
};
```

For `kind: "values"`, the line item must be classified `assumption`, and `values` has either length 1 (one constant across all listed periods) or exactly the length of `periods` (a per-period path). `kind: "not_applicable"` has no numeric value but carries the same provenance and rationale requirements as a numeric assumption. It may resolve an otherwise-empty optional equity-bridge role even when that role normally expects an actual fact; this is the only classification exception, and it cannot coexist with a fact, formula, or numeric assumption on the same cell.

Phase boundaries are expressed as **several assumption records over disjoint period sets**, not as one record with a complex value. This is deliberate: the near years are usually management guidance and the later years are usually analyst inference, so separate records let each phase carry its own `source_type`, `source_refs`, and `rationale`. An auditor can then see directly which years the company stated and which years the analyst extrapolated.

The engine validates only that no two assumptions cover the same `(line item, period)`, regardless of payload kind. A cell cannot be both numeric and not applicable.

A not-applicable cell stores `value: null` plus the `not_applicable` diagnostic. It never becomes a general-purpose numeric zero: a DSL reference to it remains null and propagates normally. Only an engine-native calculation whose schema explicitly permits N/A may convert that status into a zero contribution. In phase 1 this is limited to optional equity-bridge components, and the valuation output must retain both `status: "not_applicable"` and `appliedAdjustment: 0`. Required inputs including FCFF, WACC, terminal growth, the selected EBITDA or FCFF exit metric, and diluted shares reject a not-applicable payload at the valuation gate.

WACC is a path-capable assumption. The model must resolve exactly one WACC value for every forecast period at the valuation gate; a length-one `values` array expresses a constant curve, while a per-period array expresses a changing curve. The last forecast period's WACC is also the terminal WACC. Terminal growth and exit multiple each resolve to one value at the last forecast period.

### 4.7 Valuation configuration

Method choices are versioned configuration, not numeric cell assumptions:

```ts
type ValuationConfig = {
  anchorPeriodId: string;
  discountConvention: "year_end" | "mid_year";
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
```

Changing `ValuationConfig` creates a revision. Delta arrays are finite, sorted, deduplicated, and bounded in length before storage. `valuation.ts` reads only the normalized configuration stored in the working snapshot; it accepts no unversioned calculation override.

Let forecast periods after `anchorPeriodId` be `1..n`, excluding TTM periods from the index, and let `wacc[j]` be the model's WACC for period `j`. The cumulative discount factors are:

```text
year_end_factor(k) = product j=1..k of (1 + wacc[j])

mid_year_factor(k)
  = product j=1..k-1 of (1 + wacc[j])
  * (1 + wacc[k]) ^ 0.5

PV(FCFF[k]) = FCFF[k] / selected_factor(k)
```

For a constant WACC these reduce to `(1 + WACC)^k` and `(1 + WACC)^(k - 0.5)`. Both Gordon-growth and exit-multiple terminal values use the factor for period `n`; therefore mid-year convention applies the `n - 0.5` timing consistently to the terminal value. Gordon growth uses `wacc[n]`:

```text
FCFF[n + 1] = FCFF[n] * (1 + terminal_growth)
terminal_value = FCFF[n + 1] / (wacc[n] - terminal_growth)
```

The sensitivity matrix applies each WACC delta as a parallel shift to the entire path, `stressed_wacc[j] = reference_wacc[j] + delta`, then recalculates every explicit-period factor and terminal value. Each Gordon cell independently validates `stressed_wacc[n] > stressed_terminal_growth`; invalid cells are unavailable rather than negative or infinite.

The DSL functions `YEAR_INDEX()` and `DISCOUNT_FACTOR(wacc)` use the same anchor as valuation. Forecast periods at or before `ValuationConfig.anchorPeriodId` are not part of the explicit valuation schedule and return `not_applicable`; subsequent forecast periods are indexed from 1 or 0.5. `DISCOUNT_FACTOR` therefore has static dependencies only on WACC cells strictly after the anchor through the current period. The reported valuation remains engine-native in `valuation.ts`.

### 4.8 Model Operations DSL

The word DSL covers two separate layers. The Formula DSL is the pure expression language evaluated by `dsl/` and `engine.ts`; it may reference model cells but cannot query arbitrary model state, add rows, assign values, or commit revisions. It deliberately has no comparison operators, booleans, `IF`, or `COALESCE`: missing inputs and zero denominators remain diagnosed, and the Agent must inspect the table before explicitly changing a fact, assumption, or period-specific formula. The Model Operations DSL is the typed data protocol used by the caller in phase 1 and wrapped as JSON MCP input in phase 2.

```ts
type ModelQuery = {
  kind: "read_cells";
  revision?: number;
  selector: {
    cellRefs?: Array<{ lineItemId: string; periodId: string }>;
    lineItemIds?: string[];
    periodIds?: string[];
    parentId?: string;
    section?: LineItem["section"];
    role?: LineItemRole;
    periodClass?: PeriodClass;
  };
  includeLineage?: boolean;
};

type ModelOperation =
  | {
      kind: "replace_fact";
      replacement: StagedFact;
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
  | { kind: "set_aggregation_plan"; plan: RevenueAggregationPlan | WorkingCapitalAggregationPlan }
  | { kind: "set_valuation_config"; config: ValuationConfig }
  | {
      kind: "advance_stage";
      stage: "history_committed" | "revenue_forecast" | "operations_fcff" | "valued";
    };
```

A query selects exact cells or intersects any combination of line-item IDs, period IDs, parent category, section, role, and period class. Duplicate matches are removed. Results use period-grid order followed by line-item order and ID, may read any immutable revision, bypass the commit pipeline, and never create a revision.

The service accepts a non-empty ordered array of mutations plus `expectedRevision`. It applies all operations to one cloned in-memory working snapshot, validates the final structure, and runs the commit pipeline once. Success produces exactly one full-snapshot revision; any invalid operation, compile failure, stage blocker, or storage conflict produces none. This permits one Agent step to set several related assumptions and formulas atomically without turning each field into a separate revision.

`replace_fact` is an auditable convenience operation, not an overwrite: it creates the sourced replacement fact, performs the valid paired commit/supersede transition from §4.5, and retains both review decisions. `set_line_item_source` changes the source for the complete historical or forecast range and may be batched atomically with the assumptions or formulas that populate the new source. Historical ranges permit `actual`, `assumption`, `formula`, or `none`; historical assumptions are required for sourced overrides and explicit `not_applicable` bridge decisions at the valuation anchor. Forecast ranges permit `assumption`, `formula`, or `none`; `calculated` is engine-owned and cannot be selected. Switching a range removes current formula and assumption coverage for that range before later operations in the same batch are applied; facts and previous immutable revisions remain audit history. Registry-owned metric rows and engine-native rows reject source changes. `set_assumption` and `set_formula` then replace only their explicitly covered cells and reject overlapping coverage. `set_statement_mapping_plan` persists selected source rows, periods, signs, and exclusions and installs the compiler-owned historical formula for the target. `set_aggregation_plan` invokes the revenue or working-capital plan compiler; no language model participates during evaluation. `set_valuation_config` stores the sourced method decision from §4.7.

`add_line_item` may write only under a designated extensible parent. In phase 1 those are `revenue` and the custom-metrics namespace. Adding a stream atomically creates the value row, growth row, historical YoY formula, and default forecast formula described in §4.4. It cannot rename, delete, re-parent, or re-role a fixed skeleton or registry row. `add_metric` selects a parameterized formula from the registry and never accepts an Agent-authored expression. `advance_stage` is a separate operation so incremental model edits do not imply completion; it may be included with the final mutations needed to satisfy the destination stage gate.

## 5. Partial Models

Completeness is checked at stage boundaries, never at write time.

A half-built model commits normally. The engine computes what it can; cells it cannot compute hold `value: null` with a `missing_input` diagnostic naming the references responsible. Missing propagates down the dependency graph, so the diagnostic on a downstream cell points back to the original hole.

Only advancing to the `valued` stage and requesting a per-share value requires the role-bound rows to be populated. A gap there raises `missing_formula_input` or `incomplete_equity_bridge` and the valuation is refused rather than completed with zeros.

The same hole is progress in the middle of modeling and an error at the moment of drawing a conclusion. Deferring the completeness check to the stage boundary is what lets both be true without a second representation for "not yet filled in."

## 6. Numeric Policy

Values are computed in float64 and quantized to 12 significant digits before storage.

The parent spec originally required decimal arithmetic. Phase 1 revises this. Determinism does not require decimal — IEEE 754 is bit-reproducible under a fixed operation order, and §7 fixes that order by evaluating in a deterministic topological sequence. Nor does this system have an exact-cents requirement: inputs are already-rounded reported figures and outputs are valuations. Relative error near 1e-16 corresponds to roughly 1e-5 absolute on the 1e11-magnitude aggregates involved, orders of magnitude inside the XBRL rounding tolerance of parent spec §6.4. Quantization at storage removes the `0.1 + 0.2` display artifacts that motivate decimal in the first place, at zero dependency cost.

The evaluation order is part of the reproducibility contract. Topological order is made total by breaking ready-node ties on authoritative period position, line-item numeric `order`, line-item ID, and finally the complete cell key. Numeric fields are compared numerically and strings by fixed code-point order; an equal key compares as `0`. Cycle-cell lists and diagnostics use the same order.

The calculation-engine version accompanies every revision. Any change to arithmetic, quantization, or ordering increments it, so stored results become identifiably stale rather than silently inconsistent with what the current engine would produce.

## 7. The Commit Pipeline

Every non-empty Model Operations DSL mutation batch runs the same pipeline and differs only in step 2. Read queries bypass this pipeline.

```text
1. Load the current revision snapshot.
2. Apply the ordered operation batch to an in-memory working copy. <- the only variation
3. Compile all formulas: parse, unit-check, build the dependency graph.
      fails with invalid_formula / incompatible_units / circular_dependency
4. Evaluate the whole grid, producing values and per-cell diagnostics.
5. If the stage is `valued`, run valuation.ts, binding rows by role.
6. Sort diagnostics into blockers and warnings.
7. Blockers -> throw, writing nothing.
   Otherwise -> store.commit(expectedRevision, snapshot).
```

Three requirements from the parent spec are properties of this shape rather than conventions each operation must remember: blocking errors leave the current revision untouched (§13.4), every affected downstream cell is recalculated after a change (§8.7), and each accepted operation batch produces exactly one immutable revision (§5.3).

Full recalculation is unconditional. A model is roughly ten periods by fifty rows; five hundred cells sort and evaluate in microseconds. Incremental recalculation would buy nothing and introduce a class of bug — a cell that should have been recomputed but was not — that is invisible until a number is wrong.

The dependency graph is over `(line item, period)` nodes rather than rows. A lagged self-reference such as `LAG(revenue.iphone, 1) * (1 + growth.revenue.iphone)` on the `revenue.iphone` row is a legal chain between adjacent periods; a cycle is a cycle among cells.

## 8. Interfaces

### 8.1 Store

```ts
interface ModelStore {
  create(meta: NewModelMeta, initialSnapshot: Snapshot, changeSummary: RevisionChangeSummary): Revision;
  getMeta(modelId: string): ModelMeta | undefined;
  list(filter: ModelFilter): ModelMeta[];
  getRevision(modelId: string, revision?: number): Revision | undefined;  // omitted = current
  listRevisionHeaders(modelId: string): RevisionHeader<RevisionChangeSummary>[];
  commit(modelId: string, expectedRevision: number, snapshot: Snapshot, changeSummary: RevisionChangeSummary): Revision;
}
```

`Snapshot` holds the lifecycle stage plus the complete content of one revision: periods, hidden source-statement rows, DCF line items, facts, fact review decisions, assumptions, statement/revenue/working-capital mapping plans, valuation configuration, formulas with their normalized ASTs, computed cells, diagnostics, and engine version.

Revisions are stored as full snapshots, not deltas. A model is tens of kilobytes, so an audit query is a single primary-key read with no replay, and immutability needs no reconstruction logic to be trustworthy.

SQLite uses two tables:

```text
models(model_id primary key, stable metadata..., created_at)
revisions(
  model_id,
  revision,
  parent_revision,
  lifecycle_stage,
  snapshot_json,
  change_summary_json,
  engine_version,
  created_at,
  primary key(model_id, revision),
  foreign key(model_id) references models(model_id)
)
```

`models` contains only stable identity and ownership metadata. It has no mutable `current_revision`, lifecycle, or updated-at pointer. The current revision is the greatest stored revision for the model; current lifecycle status and update time come from that row. Because revisions are contiguous, immutable, and never deleted, this projection is unambiguous. Listing models joins each model to its latest revision, and excludes those whose latest lifecycle stage is `archived` unless requested.

Every successful Agent step inserts exactly one complete revision row. The same row stores a deterministic structured `change_summary_json` generated from the accepted mutation; it contains targets, period coverage, changed sections, and diagnostic counts, but no old values, formulas, assumptions, or free-form LLM summary. The store assigns `revision = expectedRevision + 1` and `parentRevision = expectedRevision`; callers cannot supply either. It first compares `expectedRevision` with the latest stored revision, then inserts the row. A concurrent writer may win after the read, but the `(model_id, revision)` primary key permits only one insert; the loser reads the new maximum and throws `RevisionConflictError` carrying that revision. There is no mutable pointer to leave out of sync and no revision gap because revision rows cannot be updated or deleted.

The working copy may be economically incomplete: a history-only or revenue-only model is a valid snapshot with null diagnosed downstream cells. “Complete revision” means the single persisted snapshot contains the whole state of that Agent step, not that the DCF lifecycle has reached valuation.

One SQLite `INSERT` is already statement-atomic. An explicit transaction is needed only when `create` inserts both stable model metadata and revision `0`. Snapshot encoding and all model validation/calculation happen before the insert. A failed encode, blocker, constraint violation, or conflict writes no revision. `archive` is an ordinary new snapshot whose lifecycle stage is `archived`; no historical row is modified.

`InMemoryModelStore` must match the same contract and use `structuredClone` on both write and read so caller mutation cannot alter an immutable revision.

Phase 1 stores no content or calculation-input hash. The immutable `(modelId, revision)` identifies the complete auditable snapshot, and `engineVersion` identifies the calculation semantics that produced its stored outputs. A hash may be added later if caching, content-addressable deduplication, cross-system comparison, or externally verifiable exports require one; none of those are phase-1 requirements.

### 8.2 Service façade

```ts
type ReviewFactsInput = {
  decisions: FactReviewDecision[];
  selectedHistoricalPeriodIds: string[];
  statementMappingPlans: StatementMappingPlan[];
};

class FinancialModelService {
  createModel(input: CreateModelInput): CommitResult;
  stageFacts(id: string, rev: number, candidates: StagedFact[]): CommitResult;
  reviewFacts(id: string, rev: number, input: ReviewFactsInput): CommitResult;
  applyOperations(id: string, rev: number, operations: ModelOperation[]): CommitResult;
  readCells(id: string, query: ModelQuery): WorkbookSliceView;  // read-only, no revision
  getModel(id: string, opts: ViewOptions): ModelContextView | WorkbookSliceView;
  listModels(filter: ModelFilter): ModelMeta[];
  archive(id: string, rev: number): CommitResult;
}
```

`ReviewFactsInput` contains fact decisions, the selected historical period IDs, and the initial reviewed statement-mapping plans so history review and construction of the canonical DCF table commit atomically as one revision. Later mapping corrections may use `set_statement_mapping_plan` in an ordinary operation batch.

`CreateModelInput` contains the authoritative model periods, currency and stable metadata plus the already-prepared `PreparedStatementRow[]`. Phase 1 does not extract or classify raw taxonomy concepts; its caller supplies those rows and stages their facts.

`CommitResult` is the envelope from parent spec §5.3: `{ modelId, revision, status, revisionSummary, currentWorkbook, warnings, ...payload }`. The workbook is the newly committed current revision, not the persistence snapshot.

The service is the phase-1 domain boundary. In phase 2, `applyOperations` becomes `apply_financial_model_operations`, while `readCells` is exposed through the selectors on `get_financial_model`; MCP handlers perform argument validation and response shaping only. A default unfiltered `getModel` returns the model metadata, every prior revision summary, and exactly one complete latest workbook. `stageFacts` remains an ingestion primitive and is used by model creation, while public history review wraps `reviewFacts` and the `replace_fact` lifecycle rules.

### 8.3 Agent context and workbook projection

The concrete JSON contracts are parent spec §5.4. `views.ts` builds them from immutable store records:

```text
ModelContextView
  model                  stable metadata plus current revision/stage
  revisionHistory[]      revisions 0..current-1, summary only
  currentWorkbook        complete effective workbook for current revision
```

`CurrentWorkbookView` is row-oriented like an Excel sheet: one authoritative `periods` array, DCF rows grouped into `history`, `metrics`, `revenue`, `operations`, and `dcf`, and each row's `cells` object keyed by period ID. Rows carry identity, label, semantic unit, role, source classification, current active formula text, and current active sourced assumptions. Cells carry raw quantized value, status, compact source reference, and diagnostics. Every DCF row-period coordinate is materialized; source `none` becomes `value: null`, source `{ kind: "none" }`, and status `not_modeled` rather than disappearing.

Before history is mapped, the same single workbook uses `mode: "statement_mapping"` and additionally exposes the three prepared source-statement sheets, selected periods, proposed mappings, and reconciliation results. A successful reviewed mapping stores `StatementMappingPlan` values and switches the normal projection to `mode: "dcf"`; source rows stay in the immutable snapshot but disappear from default context. They are projected again only for an unmapped row, restatement, statement/segment structure change, reconciliation failure, low-confidence mapping, or explicit source/lineage read. The model therefore pays the full source-table context cost once, then works from the DCF table.

The projection excludes rejected/staged/superseded facts, review-decision history, inactive assumptions/formulas, normalized ASTs, and full provenance. Those remain in the immutable snapshot and are available only through an explicit old-revision or `includeLineage` audit read. A view builder must never mutate, recalculate, or reinterpret the snapshot.

Revision summaries are built from immutable `RevisionHeader<RevisionChangeSummary>` records without decoding any old `snapshot_json`. A header contains revision identity, parent, lifecycle stage, engine/session/time metadata, and `changeSummary`, but no snapshot. Summary change records are produced by the service from the accepted fact/review/operation batch, validated against the resulting snapshot, sorted deterministically, and committed atomically beside it. Human-readable descriptions may be rendered from this union, but are never stored as the authoritative summary.

For a default current-model read, `revisionHistory` excludes the current revision because its complete state is already represented by `currentWorkbook`; explicit old-revision reads return only the requested workbook/audit slice. JSON is the sole Agent-facing representation. Any Markdown or spreadsheet rendering is a UI projection of the same JSON and is never injected alongside it.

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

`not_applicable` differs from `missing_input`: it records an explicit, sourced assumption decision. The cell itself remains null. A permitted engine-native consumer may report a separate zero contribution, but it must not rewrite the cell value or discard the N/A lineage.

**Operation errors throw, and a throw writes nothing.**

Following the `SecApiError` pattern in `mcp_tools/sec/secClient.ts`:

```ts
class FinancialModelError extends Error {
  readonly code: FinancialModelErrorCode;
  readonly details?: JsonObject;
}
```

Phase 1 raises `financial_model_not_found`, `revision_conflict`, `invalid_snapshot`, `fact_conflict`, `invalid_model_operation`, `invalid_model_query`, `invalid_assumption`, `invalid_formula`, `circular_dependency`, `incompatible_units`, `incompatible_periods`, `history_review_required`, `unresolved_reconciliation`, `invalid_terminal_assumptions`, and `incomplete_equity_bridge`. `invalid_snapshot` means persisted snapshot JSON failed the strict schema or structural-reference checks and is distinct from an absent model. The `xbrl_*` codes belong to phase 4; `unsupported_model_type` requires filer resolution and belongs to phase 2.

`missing_formula_input` spans both kinds. It is a cell diagnostic during modeling and becomes a thrown blocker at the valuation gate, which is how §5 draws the line between an unfinished model and an unsound conclusion.

## 10. Testing

Every module gets pure-function tests. Four checks carry the phase:

1. **Golden end-to-end valuation.** A synthetic company with hand-computed reference values, verified cell by cell from reviewed revenue through FCFF, terminal value, enterprise value, the equity bridge, and implied value per share. Synthetic rather than real: hand-computed figures must be inspectable, or a failure cannot be attributed between the engine and the reference. Hand-computed rather than snapshot-recorded: a snapshot only proves the engine still does what it did.
2. **Determinism.** Reordering non-semantic input collections such as facts, assumptions, formulas, and line items, loading the snapshot back from SQLite, and calculating it again produce identical ordered cells, valuation outputs, and diagnostics under the same engine version. The periods array is not shuffled because its persisted order is model semantics.
3. **Recalculation idempotence.** Committing again without changing any input leaves every cell unchanged. This guards the unconditional full recalculation in step 4 of the pipeline against order dependence.
4. **Store behavior.** Run one shared contract against memory and SQLite: one complete row per successful mutating Agent step, latest-state derivation without a current pointer, one winner for concurrent commits, no gap after failure, cloned immutable reads/writes, superseded facts retained, and archived models still readable by revision.

Beyond those: authoritative period-order preservation, rejection of malformed or out-of-order grids, Formula DSL parsing and precedence, rejection of comparison, boolean, conditional, fallback, and hierarchy-summing expressions, offset resolution across the actual/forecast boundary, TTM skipping, circular dependencies, missing-reference propagation, division by zero, every row of the unit algebra table, polymorphic `0` and identity `1` positive and negative cases, expression complexity limits, Model Operations DSL union validation, deterministic exact and multi-cell reads, read-without-revision behavior, atomic multi-operation commits, valid and invalid source-range switches, active-fact uniqueness, staged/rejected fact exclusion, atomic replacement and rejection, invalid supersede links, review-decision retention, extensible-row boundaries, numeric zero versus explicit N/A versus missing, N/A propagation through the Formula DSL, permitted equity-bridge N/A consumption, rejection of N/A for required valuation roles, revenue aggregation with simultaneous product/geography/segment disclosures, subtractive eliminations, period-specific plan changes, consolidated-only revenue through `growth.revenue.total`, working-capital classification and exclusion defaults, reconciliation against reported cash-flow working-capital changes without double counting, skeleton role cardinality and sign conventions, raw cash versus bridge-available cash, metric golden cases with negative and zero denominators, constant and changing WACC paths, anchor-relative cumulative year-end and mid-year discount factors, parallel WACC sensitivity shifts, both terminal methods, invalid WACC/growth combinations, and both sensitivity matrices.

The `test` script in `package.json` enumerates test directories explicitly and does not currently include `src/financial-model/**`. That glob must be added before the first test file, otherwise the entire suite passes by not running.

## 11. Acceptance Criteria

Phase 1 is accepted when:

1. A model can be created with prepared three-statement source rows, the documented canonical DCF mapping targets, fixed DCF spine, equity-bridge spine, configurable period grid, and validated role cardinality.
2. Facts can be staged, rejected, committed, and atomically superseded; every active cell is unique, review decisions carry rationale, and superseded facts remain in revision lineage.
3. Standard metric formula rows, including ROA and ROE, are installed at creation and recalculate automatically when their prerequisite cells change; the Agent neither supplies their values nor invokes a separate metric-calculation method.
4. The Agent can select historical periods and vertical categories from prepared income-statement, balance-sheet, and cash-flow sheets exactly once, commit reusable statement-mapping plans, and let generated formulas populate the prebuilt DCF rows. Normal post-mapping context contains only the complete DCF workbook; source sheets return only for a mapping exception or explicit audit read. A consolidated-only model forecasts from the preinstalled `growth.revenue.total` driver without an artificial segment. Revenue streams can be added as pairs and forecast by formula or direct assumption; a reviewed aggregation plan selects exactly one non-overlapping disclosure set per period, generates `revenue.total`, and reconciles historical members to reported consolidated revenue. A separate reviewed working-capital plan classifies operating assets, operating liabilities, and exclusions, and generates operating NWC without re-adding the cash-flow-statement change.
5. The typed Model Operations DSL can read exact or selected cells without committing, and can atomically replace facts, change an allowed historical or forecast source, set assumptions, add permitted line items or registered parameterized metrics, set formulas and statement/revenue/working-capital plans, change valuation configuration, and advance stages; one successful mutation batch produces one revision.
6. Assumptions support per-period paths and disjoint phase records, each carrying its own provenance.
7. A partial model commits successfully, with uncomputable cells null and diagnosed.
8. A valuation is refused, not defaulted, when required role-bound inputs are missing; optional equity-bridge components contribute zero only when a sourced assumption explicitly marks them `not_applicable`.
9. The golden hand-computed DCF matches cell by cell.
10. Reordered non-semantic inputs, a persisted-and-reloaded snapshot, and repeated calculation produce identical ordered cells, valuation outputs, and diagnostics under the same engine version; the authoritative period order is preserved and recalculation is idempotent.
11. A stale `expected_revision` raises `revision_conflict` and leaves the model unchanged.
12. The whole phase runs with no network access.

## 12. Deviations from the Parent Spec

1. **Numeric policy (§8.5).** Float64 with quantization at storage replaces decimal arithmetic, for the reasons in §6. The parent spec is amended.
2. **TTM (§7.1).** The period class and skipping rule ship in phase 1; TTM construction is phase 2. No conflict, a clarification of ownership.
3. **Line-item classification (§7.2).** Classification is per period range, not per row. The parent spec is amended to say so.
4. **The skeleton and roles (§7.2).** The parent spec left row identity as string IDs. Phase 1 adds a generated skeleton with an immutable `role` field, and valuation binds by role. The parent spec is amended.
