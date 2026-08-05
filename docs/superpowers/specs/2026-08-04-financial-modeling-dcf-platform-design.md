# Versioned Financial Modeling and DCF Platform

Date: 2026-08-04  
Status: Approved design, revised 2026-08-04; not yet implemented

## 1. Purpose

Build a backend financial modeling platform that behaves like an auditable, programmatic spreadsheet. Agents provide reviewed facts, sourced assumptions, and restricted formulas. The platform, rather than the language model, performs every numerical calculation.

The required lineage is:

```text
SEC filing
  -> extracted facts
  -> Agent review
  -> historical metrics
  -> forecast assumptions
  -> formulas
  -> free cash flow
  -> discounted cash flow valuation
```

Every reported historical metric, forecast, free-cash-flow value, enterprise value, and per-share valuation must be reproducible from a specific immutable model revision.

The first release is backend-only. It includes persistent models, deterministic calculations, MCP tools, and Orchestra integration. It does not include a spreadsheet UI or public REST API.

## 2. Design Principles

1. **Facts, assumptions, formulas, and results are different objects.** Never merge reported data with forecasts or analyst inference.
2. **The language model does not perform final arithmetic.** It may propose assumptions and formulas, but only platform results may be quoted as calculated values.
3. **Every hard-coded forecast assumption needs provenance.** Store its source type, source references, as-of date, and rationale.
4. **No hidden defaults.** Missing values remain missing unless an Agent explicitly supplies a sourced value or marks a component not applicable.
5. **Models are versioned and auditable.** Every accepted fact, assumption change, formula change, and calculation result belongs to an immutable revision.
6. **Formulas are safe and deterministic.** Do not evaluate JavaScript, Python, shell commands, or any other arbitrary Agent-generated code.
7. **Specialized industries require specialized models.** Do not force a generic operating-company DCF onto banks, insurers, REITs, funds, or non-operating vehicles.

## 3. Scope

### 3.1 Included

- SEC-listed operating companies filing 10-K and 10-Q under US GAAP.
- Standardized consolidated facts from the SEC Company Facts API.
- Filing-level Inline XBRL extraction for custom concepts and dimensional revenue disclosures.
- Agent-reviewed product, segment, service, and geography revenue histories.
- Historical growth, margin, cash-generation, balance-sheet, and return metrics.
- Annual revenue, operating, reinvestment, FCFF, and DCF projections.
- One versioned forecast assumption set plus DCF sensitivity matrices.
- Gordon-growth and exit-multiple terminal-value methods.
- Sensitivity analysis and full calculation lineage.

### 3.2 Excluded from the first release

- Banks, insurers, REITs, ETFs, mutual funds, SPACs, shells, and other non-operating vehicles.
- Foreign private issuers filing 20-F or 6-K, and any filer whose primary reporting taxonomy is `ifrs-full`. IFRS requires a second concept-mapping library, and its lease (IFRS 16), development-cost capitalization (IAS 38), and by-nature income-statement presentation rules break the D&A, capex, lease-bridge, and gross-margin definitions this release assumes. A detected IFRS filer is rejected with `unsupported_model_type` rather than modeled under GAAP definitions.
- Foreign-currency translation. A model carries exactly one reporting currency and never converts between currencies.
- Dividend-discount, residual-income, excess-return, NAV, FFO, or AFFO models.
- Quarterly forecast models.
- Automatically generated forecast assumptions.
- A spreadsheet frontend or direct cell editing UI.
- Public REST endpoints.
- Automatic blending or averaging of valuation methods.

## 4. Why Filing-Level XBRL Is Required

It is required for **segment-level fidelity**, not for the platform to function. A consolidated-revenue DCF built on Company Facts plus reviewed manual facts is a complete, auditable valuation; filing-level extraction raises the resolution of the revenue build. That is why it ships last (§19, phase 4) and stays optional at runtime (§6.1).

The SEC Company Facts API aggregates facts that use non-custom taxonomies and apply to the entire reporting entity. It is appropriate for comparable consolidated values, but it does not provide the complete filing-specific custom taxonomy and dimensional context required for reliable product or segment modeling.

Sources:

- [SEC EDGAR Application Programming Interfaces](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC Inline XBRL](https://www.sec.gov/data-research/structured-data/inline-xbrl)
- [SEC XBRL Glossary of Terms](https://www.sec.gov/data-research/structured-data/inline-xbrl/xbrl-glossary-terms)

The platform therefore uses two complementary sources:

1. The existing SEC Company Facts integration for standardized, entity-wide facts.
2. Filing-level Inline XBRL for company-specific concepts, axes, members, contexts, and presentation relationships.

## 5. System Architecture

### 5.1 Main components

```text
Orchestra
  -> market_research
       -> filings, news, macro evidence, guidance, and assumption sources
  -> financial_modeling
       -> model lifecycle and Agent review
       -> financial-model MCP tools
            -> SEC data adapter
            -> Arelle extraction adapter
            -> financial model store
            -> formula compiler
            -> calculation engine
```

`market_research` remains responsible for finding primary materials, management guidance, macro evidence, and attributable expectations. The new `financial_modeling` subagent is responsible for reviewing extracted history, defining formulas, supplying sourced assumptions, and invoking deterministic calculations.

### 5.2 Identity and ownership

Financial models must be reusable across Topics owned by the same Agent identity.

- Extend tool execution context with `agentId`.
- Propagate the `X-Agent-Id` value from the HTTP server through Orchestra, dispatch, subagent runtime, and tool calls.
- Store both `owner_agent_id` and `origin_session_id` on every model.
- Scope list, read, and update operations by `owner_agent_id`.
- Use `default` only as the existing local-development fallback when no header is available.

**`X-Agent-Id` is a namespacing mechanism, not an authorization mechanism.** The header is supplied by the caller and is not verified against any credential, so any client can present any identity. Owner scoping prevents accidental cross-Topic collisions and keeps model listings clean; it does not make one owner's models confidential from a determined caller. Do not build any confidentiality guarantee on top of it until real authentication exists. The acceptance criteria are worded accordingly.

### 5.3 Persistence and revisions

Use SQLite for model persistence. Store lightweight model metadata separately from immutable revision snapshots.

Each model contains:

- `model_id`
- `owner_agent_id`
- `origin_session_id`
- ticker, CIK, company name, reporting currency, and fiscal calendar
- historical and forecast range
- creation timestamp

Each revision contains:

- revision number and parent revision
- lifecycle stage, one of `draft`, `history_committed`, `revenue_forecast`, `operations_fcff`, `valued`, or `archived`
- facts, provenance, statuses, and retained fact-review decisions
- assumptions and source metadata
- reviewed revenue and working-capital aggregation plans
- valuation configuration and source metadata
- formula source text and normalized AST
- calculated values
- validation warnings and blockers
- calculation-engine version
- a deterministic structured change summary
- creating session and timestamp

Store each revision as one complete `snapshot_json` plus `change_summary_json`, keyed by `(model_id, revision)`. The summary is immutable revision metadata and is not a second model-state representation. The model table contains no mutable current-revision, lifecycle, or updated-at pointer. Current revision is `MAX(revision)` for the model; current lifecycle and update time come from that row. Models are small and revisions are never deleted, so this derived projection avoids a second mutable representation of current state.

Every successful Agent step inserts exactly one full snapshot. A snapshot may still be incomplete as a financial model — for example history may be reviewed while forecast cells remain null and diagnosed. “Full” means it contains the entire state produced by that step rather than a delta.

The store assigns `revision = expected_revision + 1` and `parent_revision = expected_revision`. It rejects a request unless `expected_revision` is the current maximum. If two callers race, both attempt the same primary key and only one insert succeeds; the loser returns `revision_conflict` with the new maximum. There is no revision gap and no current pointer to update. Snapshot encoding, validation, and calculation happen before the insert. SQLite makes the single revision insert atomic; only initial model creation requires a short transaction to insert stable model metadata and revision `0` together.

`archive_financial_model` inserts a new revision with lifecycle `archived`. Default listings inspect the latest revision and hide it, while every earlier revision remains directly readable.

Every mutation of an existing model requires `expected_revision`; model creation instead returns initial revision `0`. A stale revision returns `revision_conflict` and does not overwrite the current model.

Because `expected_revision` is mandatory, every tool response — successful or failed — carries a uniform envelope so the Agent always holds a usable revision number:

```json
{ "model_id": "...", "revision": 7, "status": "history_committed", "...": "tool-specific payload" }
```

A `revision_conflict` error returns the current revision in the same envelope so the Agent can re-read and retry without an extra tool call.

### 5.4 Agent-facing model context

The language model receives model state as JSON in two layers:

```text
all prior revisions -> compact deterministic RevisionSummary records
current revision    -> one complete CurrentWorkbookView
```

It never receives every immutable snapshot at once. “Complete current workbook” means the current effective Excel-like model—not the persistence snapshot with rejected candidates, superseded facts, review history, normalized ASTs, and inactive definitions. After the initial statement mapping is accepted, it means the complete DCF workbook; the three source statements are not repeated on every modeling turn.

Every committed revision stores a structured summary generated deterministically from the accepted mutation, never free-form text written by an LLM:

```ts
type RevisionChange =
  | { kind: "model_created" }
  | { kind: "facts_staged"; candidateCount: number; mappedLineItemIds: string[]; periodIds: string[] }
  | { kind: "facts_reviewed"; committed: number; rejected: number; superseded: number; lineItemIds: string[]; periodIds: string[] }
  | { kind: "fact_replaced"; lineItemId: string; periodId: string }
  | { kind: "assumption_set"; lineItemId: string; periodIds: string[] }
  | {
      kind: "line_item_source_set";
      lineItemId: string;
      range: "historical" | "forecast";
      source: "actual" | "assumption" | "formula" | "none";
    }
  | { kind: "line_item_added"; lineItemId: string; parentId: string }
  | { kind: "metric_added"; registryId: "cagr"; lineItemId: string }
  | { kind: "formula_set"; lineItemId: string; appliesTo: "historical" | "forecast"; periodIds: string[] }
  | { kind: "statement_mapping_plan_set"; targetLineItemId: string; periodIds: string[] }
  | { kind: "aggregation_plan_set"; planKind: "revenue" | "working_capital"; periodIds: string[] }
  | { kind: "valuation_config_set" }
  | { kind: "stage_advanced"; from: LifecycleStage; to: LifecycleStage }
  | { kind: "archived" };

type RevisionChangeSummary = {
  changes: RevisionChange[];
  changedSections: ModelReadSection[];
  warningCount: number;
  blockerCount: 0;
};

type RevisionSummary = RevisionChangeSummary & {
  revision: number;
  parentRevision: number | null;
  lifecycleStage: LifecycleStage;
  engineVersion: string;
  creatingSessionId: string;
  createdAt: string;
};
```

IDs and period arrays in summaries are validated, deduplicated, and stored in model order. Formula text, assumption values, fact values, and provenance are intentionally omitted: their current versions are present in the workbook, and an older revision remains available through an explicit audit read.

The current workbook uses periods as columns and line items as rows. `DcfWorkbookSection` is the closed normal-workbook tab union `"history" | "metrics" | "revenue" | "operations" | "dcf"`; raw source rows use their own mapping-only sheet type:

```ts
type DcfWorkbookSection = "history" | "metrics" | "revenue" | "operations" | "dcf";

type ModelReadSection = DcfWorkbookSection |
  "source_income_statement" | "source_balance_sheet" | "source_cash_flow";

type WorkbookCellStatus =
  | "ok" | "missing_input" | "divide_by_zero"
  | "not_applicable" | "not_modeled";

type WorkbookCellSource =
  | { kind: "fact"; factId: string }
  | { kind: "assumption"; assumptionId: string }
  | { kind: "formula"; definitionIndex: number }
  | { kind: "calculated"; output: string }
  | { kind: "none" };

type WorkbookCellView = {
  value: number | null;
  status: WorkbookCellStatus;
  source: WorkbookCellSource;
  diagnostics: Diagnostic[];
};

type WorkbookRowView = {
  lineItemId: string;
  label: string;
  parentId?: string;
  section: DcfWorkbookSection;
  role: LineItemRole;
  unit: Unit;
  order: number;
  sources: { historical: CellSource; forecast: CellSource };
  /** Compact references to active reviewed statement mappings feeding this row. */
  mappingRefs: Array<{ periodIds: string[]; sourceLineItemIds: string[] }>;
  formulas: Array<{
    appliesTo: "historical" | "forecast";
    periodIds: string[];
    source: string;
  }>;
  assumptions: Assumption[];
  /** Keys are period IDs; serialization follows the authoritative periods array. */
  cells: Record<string, WorkbookCellView>;
};

type SourceStatementRowView = {
  sourceLineItemId: string;
  label: string;
  unit: Unit;
  /** Keys follow the same authoritative periods array. */
  cells: Record<string, WorkbookCellView>;
};

type SourceStatementReviewView = {
  selectedPeriodIds: string[];
  sheets: Record<
    "income_statement" | "balance_sheet" | "cash_flow_statement",
    SourceStatementRowView[]
  >;
  activeMappings: StatementMappingPlan[];
  proposedMappings: Array<Omit<StatementMappingPlan, "reviewDecisionId">>;
  diagnostics: Diagnostic[];
};

type CurrentWorkbookBase = {
  modelId: string;
  revision: number;
  lifecycleStage: LifecycleStage;
  engineVersion: string;
  periods: Period[];
  sections: Record<DcfWorkbookSection, WorkbookRowView[]>;
  revenueAggregationPlans: RevenueAggregationPlan[];
  workingCapitalAggregationPlans: WorkingCapitalAggregationPlan[];
  valuationConfig: ValuationConfig;
  diagnostics: Diagnostic[];
  valuation: ValuationOutput | null;
};

type CurrentWorkbookView = CurrentWorkbookBase & (
  | { mode: "statement_mapping"; sourceStatementReview: SourceStatementReviewView }
  | { mode: "dcf"; sourceStatementReview?: never }
);

type ModelContextView = {
  model: ModelMeta;
  /** Every revision strictly before currentWorkbook.revision, oldest first. */
  revisionHistory: RevisionSummary[];
  currentWorkbook: CurrentWorkbookView;
};
```

The workbook materializes every row across every authoritative period. A source of `none` is represented by a `not_modeled` cell rather than by an omitted key; this preserves the difference between an absent cell and a modeled cell whose input is missing. Numeric values remain raw quantized values, percentages remain decimal fractions, and units remain explicit. Rows are serialized by numeric line-item order then ID; cell keys follow the periods array. Active formula source text and active sourced assumptions are included once at row level. Normalized ASTs and full fact/review lineage are excluded by default.

Context has two explicit modes. Initial construction uses `mode: "statement_mapping"`: the single current workbook contains the prepared income statement, balance sheet, and cash-flow statement as source sheets, the Agent-selected periods, the prebuilt DCF rows, proposed mappings, and reconciliation diagnostics. The Agent submits reviewed `StatementMappingPlan` records, and deterministic engine formulas—not LLM arithmetic—fill the canonical rows. Once the history gate passes, `mode: "dcf"` omits the source sheets and keeps only the complete DCF workbook plus compact source and mapping references.

Mapping is durable model configuration rather than a copy/paste result. Source sheets re-enter context only for initial mapping, an unmapped source row, a restatement, a changed statement or segment structure, a failed reconciliation, low-confidence classification, or an explicit source/lineage read. A new filing still follows fact review: a prior mapping may propose the target automatically, but it never silently commits a new numeric fact.

An explicit revision, section, selector, or `include_lineage` request may return a targeted workbook or audit view. That is an on-demand exception, not part of the default injected context. The UI may render the same JSON as an Excel-like table, but Markdown is never a second authoritative representation.

## 6. SEC and Inline XBRL Ingestion

### 6.1 Arelle adapter

Filing-level extraction is delivered last (§19, phase 4) and is **optional at runtime**. The platform must be fully usable without it: standardized Company Facts plus Agent-supplied manual facts are sufficient to build a consolidated-revenue DCF. When the adapter is missing or fails, `create_financial_model` still succeeds, returns the standardized candidates, and reports the extraction failure as a non-blocking warning. It must never turn model creation into an error.

Use an isolated Python adapter backed by `arelle-release==2.42.1`.

- Invoke Python directly without a shell.
- Exchange a bounded JSON request and response.
- Accept only SEC accession-derived filing locations, not arbitrary user URLs.
- Apply a hard timeout and maximum output size.
- Use `SEC_USER_AGENT` for compliant SEC requests.
- Keep the Arelle taxonomy and HTTP cache in a controlled runtime directory.
- Return `xbrl_runtime_unavailable`, `xbrl_parse_failed`, or `xbrl_timeout` as structured errors.

Package source: [Arelle on PyPI](https://pypi.org/project/arelle-release/)

### 6.2 Extracted fact contract

Each filing-level fact must preserve:

- stable candidate ID
- accession number and form
- filing and period dates
- filing URL and source-document location
- concept QName and human-readable label
- standard or custom taxonomy status
- numeric value, unit, scale, decimals, and sign
- instant or duration context
- every axis/member QName and label
- presentation and calculation roles when available
- extraction warnings

### 6.3 Candidate mapping

The platform may use deterministic evidence to rank candidate mappings:

- standard taxonomy identity
- concept labels and documentation
- statement and presentation role
- period and unit compatibility
- dimensional axes and members
- arithmetic relationship to consolidated values

Automatic mapping produces staging candidates only. It must not convert filing-specific segments into committed model rows without Agent review.

Statement ingestion and DCF modeling are separate layers. Extracted values first remain on stable source rows in three read-only sheets: `income_statement`, `balance_sheet`, and `cash_flow_statement`. The Agent chooses the usable historical periods and commits a versioned mapping from those vertical source categories into the prebuilt DCF rows:

```ts
type StatementMappingPlan = {
  targetLineItemId: string;
  periodIds: string[];
  members: Array<{
    statement: "income_statement" | "balance_sheet" | "cash_flow_statement";
    sourceLineItemId: string;
    treatment: "add" | "subtract" | "exclude";
  }>;
  reviewDecisionId: string;
};
```

Each source row retains its statement identity, original label, stable concept/dimension signature, unit, and provenance. `targetLineItemId + periodIds` is the mapping's business identity; the Agent supplies no arbitrary plan ID. Mappings for one target cover disjoint period sets, and exactly one mapping may produce a target-period cell. The compiler generates an explicit signed formula over the selected source rows. Source facts therefore remain one-to-one with source-row cells even when several categories feed COGS or operating expenses; the LLM classifies and configures, while the engine performs the addition.

### 6.4 Agent review

For each candidate, the Agent may:

- approve the proposed source-statement row;
- map it to another stable source-row ID without changing the source fact;
- reject it;
- relabel it without changing the source fact;
- replace it with a manual fact carrying equivalent provenance;
- add an explicit eliminations, reconciliation, or other row.

The Agent then maps reviewed source rows—not individual numeric values—into canonical DCF targets through `StatementMappingPlan`. This separation is what makes one reviewed category mapping reusable across all selected periods.

Segment totals must reconcile to consolidated revenue within the tolerance implied by XBRL rounding precision. Do not use an arbitrary percentage tolerance.

The tolerance is derived, not chosen. Each fact reported with a `decimals` value of `d` carries a maximum rounding error of half its last retained unit, `0.5 * 10^(-d)`. For a comparison summing `n` segment facts against one consolidated fact, the allowed absolute difference is the sum of the individual bounds:

```text
tolerance = 0.5 * 10^(-d_consolidated) + sum over segments of 0.5 * 10^(-d_i)
```

A fact tagged `decimals="INF"` contributes zero. A fact with no `decimals` attribute makes the comparison indeterminate and is reported as a review item rather than silently passed. Unresolved differences remain blocking review items.

Fact review follows an explicit lifecycle. A fact's value, unit, period, and provenance are immutable after creation. Review may correct a staged candidate's proposed mapping, but the accepted line item becomes immutable when the fact leaves `staged`. Review moves a staged fact to `committed` or `rejected`; replacing a committed fact creates a new fact and atomically moves the predecessor to `superseded`. Rejected and superseded facts are terminal.

At most one committed fact may exist for each `(line_item_id, period_id)`. Staged and rejected candidates may coexist but never enter calculation. A replacement must name the prior committed fact in `supersedes_fact_id`, and both facts must have the same line item, period, and unit. Each commit, rejection, and supersede action stores a decision ID, reviewer, time, and rationale. The replacement commit, predecessor supersede, and recalculation occur in the working copy and are persisted together in one complete revision row; any failure leaves the previous revision current.

The calculation engine receives only validated active facts with `status: "committed"` and a mapped line item. It never filters mixed statuses or resolves duplicate active facts by recency or input order. Duplicate active coverage is `fact_conflict`.

Changing segment definitions must also block cross-period growth calculations until the Agent either accepts a documented recast or defines an explicit mapping between the old and new structures.

### 6.5 Period normalization

- Prefer the latest filed restatement for the same concept, dimensions, unit, and period.
- Retain the superseded fact in revision lineage.
- Keep fiscal periods identified by exact start and end dates.
- Do not merge calendar and fiscal periods merely because their year labels match.
- Build TTM values only from four comparable standalone quarters.
- Derive a standalone quarter from year-to-date facts only when taxonomy, dimensions, unit, and fiscal context match exactly; record both source facts in the derivation.
- Fall back to the latest reviewed fiscal year when TTM cannot be constructed safely.

## 7. Financial Model Schema

### 7.1 Periods

The default grid contains five reviewed annual historical periods and five annual forecast periods. Both ranges are configurable from three to ten years.

Each period records:

- stable period ID
- fiscal label
- start and end date
- `actual`, `ttm`, or `forecast` classification
- reporting currency

The periods array returned by ingestion and stored at model creation is the authoritative chronological timeline. The engine preserves it exactly rather than sorting it. It validates unique period IDs, valid ISO date ranges, nondecreasing end dates, strictly increasing non-TTM end dates, and the class sequence `actual* -> ttm? -> forecast*`; invalid input is `incompatible_periods`. Period definitions and their order are immutable after model creation.

Periods form a single explicit ordered grid. Every formula offset in §8 is a position on this grid, never calendar arithmetic. Reordering the periods array changes the asserted timeline and is therefore not a harmless input permutation.

A `ttm` period is a valuation and metric anchor only. It never participates in a period-relative calculation against fiscal years: `LAG`, `YOY`, `CAGR`, and any range function skip TTM periods entirely. Comparing a trailing-twelve-month figure to a fiscal year as if they were consecutive grid periods produces a meaningless growth rate, so the engine refuses it rather than warning about it.

### 7.2 Line items

Line items use stable semantic IDs rather than spreadsheet coordinates, for example:

```text
revenue.iphone
revenue.services
revenue.total
growth.revenue.iphone
operating_income
tax_rate
nopat
depreciation_amortization
capital_expenditures
change_nwc
fcff
wacc
terminal_growth
```

Each line item stores:

- ID and label
- parent line-item ID when hierarchical
- an immutable `role` (see below)
- section and display order
- unit type and currency
- a classification **per period range**: one for historical periods and one for forecast periods
- aggregation behavior
- source provenance or formula definition

`LineItemRole` is closed and valuation binds by role, never by display label or string ID:

```ts
type LineItemRole =
  | "revenue_root" | "revenue_stream" | "revenue_total"
  | "operating_income" | "tax_rate" | "nopat"
  | "depreciation_amortization" | "ebitda" | "capex"
  | "operating_working_capital" | "change_nwc" | "fcff"
  | "wacc" | "terminal_growth" | "exit_multiple"
  | "cash_available_for_bridge" | "non_operating_investments" | "debt"
  | "lease_liabilities" | "preferred_equity" | "non_controlling_interests"
  | "bridge_other" | "diluted_shares" | "none";
```

Classification is given separately for the historical and forecast ranges because one row normally has different sources in each: `revenue.iphone` is `actual` in historical periods and `formula` in forecast periods. That is the common case, not an exception.

`createModel` generates the standard rows with their roles already bound, and skeleton rows cannot be renamed, re-parented, deleted, or re-roled. Their period-range source and formula may change through review except for registry-owned metric definitions, which are immutable. The engine binds valuation inputs by role, never by string ID, so a model can never be missing FCFF and a caller's typo can never silently become "no FCFF row found." Callers extend the model only at designated extensible parents; in the first release these are `revenue`, whose children carry the role `revenue_stream`, and the custom-metrics namespace, whose rows carry role `none`. Adding a revenue stream creates its value row and companion growth row as a pair, installs `YOY(revenue.<stream>)` over historical actual periods, and uses the companion as the forecast growth assumption, because a forecast stream with no growth driver is always a modeling error.

Revenue hierarchy alone does not determine aggregation. A filing may disclose product, geography, and operating-segment breakdowns that each independently sum to the same consolidated revenue, so summing every child would double-count the company. The Agent proposes a classification and one active aggregation set; review commits a versioned `RevenueAggregationPlan` that identifies the independently mapped reported consolidated total and marks each visible revenue row as `add`, `subtract`, or `exclude`. Plans cover disjoint period sets so segment-definition changes cannot silently rewrite earlier periods. The engine validates the committed plan, generates a normalized DSL formula for forecast `revenue.total`, and reconciles the same signed members to the independently resolved total cell in historical periods. It never asks a language model to perform arithmetic at evaluation time. Formula DSL has no hierarchy-summing function. A consolidated-only model uses the preinstalled `growth.revenue.total` assumption path and default forecast formula, so it needs neither an artificial segment row nor a hard-coded growth literal.

The fixed DCF spine and its default sources are:

| ID | Role | Historical | Forecast | Default or rule |
| --- | --- | --- | --- | --- |
| `revenue.total` | `revenue_total` | `actual` or mapping `formula` | `formula` | Independent reported total historically; `LAG(revenue.total, 1) * (1 + growth.revenue.total)` or generated revenue plan in forecast. |
| `growth.revenue.total` | `none` | `formula` | `assumption` | Historical `YOY(revenue.total)`; sourced consolidated-growth forecast driver. |
| `margin.operating` | `none` | `formula` | `assumption` | `operating_income / revenue.total`. |
| `operating_income` | `operating_income` | `actual` or mapping `formula` | `formula` | `revenue.total * margin.operating`. |
| `tax_rate` | `tax_rate` | `formula` | `assumption` | Historical `income_tax_expense / pretax_income` is evidence; forecast is a reviewed normalized operating rate. |
| `nopat` | `nopat` | `formula` | `formula` | `operating_income * (1 - tax_rate)`. |
| `depreciation_amortization` | `depreciation_amortization` | `actual` or mapping `formula` | `formula` | `revenue.total * ratio.da_to_revenue`. |
| `ebitda` | `ebitda` | `formula` | `formula` | `operating_income + depreciation_amortization`. |
| `capital_expenditures` | `capex` | `actual` or mapping `formula` | `formula` | Positive outflow; `revenue.total * ratio.capex_to_revenue`. |
| `operating_working_capital` | `operating_working_capital` | `formula` | `formula` | Reviewed balance-sheet plan historically; `revenue.total * ratio.operating_nwc_to_revenue` in forecast. |
| `change_nwc` | `change_nwc` | `formula` | `formula` | Current operating NWC less prior operating NWC; positive is a cash use. |
| `fcff` | `fcff` | `formula` | `formula` | NOPAT plus D&A less capex and change in NWC. |
| `wacc` | `wacc` | `none` | `assumption` | A path over all forecast years; final-year value is terminal WACC. |
| `terminal_growth` | `terminal_growth` | `none` | `assumption` | Final forecast period. |
| `exit_multiple` | `exit_multiple` | `none` | `assumption` | Final forecast period. |

The skeleton also includes `growth.revenue.total`, `ratio.da_to_revenue`, `ratio.capex_to_revenue`, and `ratio.operating_nwc_to_revenue` as historical formula / forecast assumption driver rows. Review can replace a forecast formula or switch a row to a direct assumption, but cannot change role identity or the sign conventions above. A missing or zero denominator stays null with a diagnostic.

The prebuilt DCF workbook also contains canonical input and reconciliation rows for the principal captions needed from the three statements. These are mapping targets, not the raw source sheets. They carry role `none`, use historical formulas when covered by a reviewed statement-mapping plan, default to forecast `none`, and may remain empty when an issuer does not disclose a category separately:

| Statement | Standard optional rows |
| --- | --- |
| Income statement | `cost_of_revenue`, `gross_profit`, `research_and_development`, `selling_and_marketing`, `general_and_administrative`, `other_operating_expenses`, `operating_expenses`, `interest_income`, `interest_expense`, `non_operating_income_expense`, `pretax_income`, `income_tax_expense`, `net_income`, `net_income_attributable_nci`, `diluted_eps` |
| Balance sheet | `cash_and_equivalents`, `restricted_cash`, `short_term_investments`, `accounts_receivable`, `inventory`, `other_operating_current_assets`, `accounts_payable`, `deferred_revenue`, `accrued_operating_liabilities`, `other_operating_current_liabilities`, `property_plant_equipment`, `total_current_assets`, `total_assets`, `total_current_liabilities`, `shareholders_equity` |
| Cash flow statement | `operating_cash_flow`, `reported_change_operating_assets_liabilities`, `asset_sale_proceeds`, `acquisitions`, `net_investing_cash_flow`, `debt_issuance`, `debt_repayment`, `dividends`, `share_repurchases` |

This mapping follows the statement categories in [SEC Regulation S-X Rules 5-02 and 5-03](https://www.ecfr.gov/current/title-17/chapter-II/part-210) and the operating/investing/financing separation in [FASB Topic 230](https://asc.fasb.org/topic&trid=2129374). Acquisitions, asset-sale proceeds, and financing cash flows remain reconciliation and audit rows; they do not enter FCFF.

Operating working capital is controlled by a separate reviewed plan:

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

Working-capital plans have no arbitrary ID; the unique operating-NWC target plus `periodIds` is their business identity. Plans cover disjoint period sets. The engine generates `sum(operating_asset) - sum(operating_liability)`. The initial proposal treats accounts receivable, inventory, and other operating current assets as operating assets, and accounts payable, deferred revenue, accrued operating liabilities, and other operating current liabilities as operating liabilities. Cash, restricted cash, marketable securities, short-term borrowings, current debt, and lease liabilities default to `exclude`. Review may change any proposal, and the committed classification is authoritative. `reported_change_operating_assets_liabilities` is used to reconcile the balance-derived change, never added to it.

The separate equity-bridge spine contains exactly one each of `cash_available_for_bridge`, `non_operating_investments`, `debt`, `lease_liabilities`, `preferred_equity`, `non_controlling_interests`, and `diluted_shares`, plus zero or more signed `bridge_other` rows. Raw `cash_and_equivalents` is not automatically bridge cash: review removes restricted and required operating cash and records the derivation. A bridge component may resolve from a reviewed fact, formula, or sourced assumption after its cell source is changed in the same revision. Optional adjustments require a numeric value or explicit `not_applicable`; diluted shares is always numeric.

Exactly one row must carry each fixed DCF and fixed bridge role; `revenue_stream`, `bridge_other`, and `none` are repeatable. There is no generic `terminal_metric` role. `ValuationConfig.exitTerminalMetric` selects the unique `ebitda` or `fcff` row.

Classification governs where a cell's value comes from, and the sources are mutually exclusive per `(line_item, period)`:

| Classification | Value source |
| --- | --- |
| `actual` | a reviewed fact committed in §6 |
| `assumption` | exactly one assumption record (§11) |
| `formula` | one formula evaluated per period (§8) |
| `calculated` | engine-native output (§12), not Agent-writable |

A cell that has both an assumption and a formula is a definition error, not a precedence question, and is rejected with `invalid_formula`.

A formula may include explicit `periodIds`; omission means every period in its declared historical or forecast class. Explicit periods must belong to that class, and formula coverage for one line-item cell may not overlap. Revenue and working-capital plan compilers use this coverage to preserve reviewed definition changes by period.

### 7.3 Single forecast and sensitivity

One model revision contains one reviewed forecast assumption set. Phase 1 does not implement named `base`, `upside`, or `downside` operating scenarios and does not copy or inherit assumptions between cases. A different coherent operating forecast is a new revision or a separate model. Valuation uncertainty within a revision is expressed by the WACC-by-terminal-growth and WACC-by-exit-multiple sensitivity matrices in §12.5; the platform does not probability-weight or blend their cells.

### 7.4 Model Operations DSL

The platform exposes two deliberately separate languages:

- the **Model Operations DSL** is a typed JSON protocol through which an Agent reads and changes model state;
- the **Formula DSL** in §8 is an expression language evaluated inside one line-item cell and cannot read arbitrary model metadata, mutate state, or commit revisions.

The operations layer is explicit rather than a generic patch object. Its phase-1 domain contract is:

```ts
type ModelQuery = {
  kind: "read_cells";
  revision?: number;
  selector: {
    cellRefs?: Array<{ lineItemId: string; periodId: string }>;
    lineItemIds?: string[];
    periodIds?: string[];
    parentId?: string;
    section?: ModelReadSection;
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

`read_cells` supports an exact cell list as well as selection by line item, period, parent category, section, role, or period class. Selectors are combined by intersection, omitted selectors mean no restriction, duplicate matches are removed, and results are returned in deterministic period-grid order followed by line-item order and ID. Reads may target any immutable revision, never enter the commit pipeline, and never create a revision.

Mutations are submitted as a non-empty ordered operation array with `model_id` and `expected_revision`. The service validates and applies the entire array to one in-memory working copy, then runs the shared compile/recalculate/valuation pipeline once and inserts exactly one full-snapshot revision. An invalid operation makes the entire batch fail without mutation. Operation order is observable only while constructing the working copy; the resulting snapshot must satisfy all uniqueness, source-classification, role, period, and provenance invariants independent of input-array order.

`replace_fact` never overwrites a historical value. It atomically stages and commits a sourced replacement, supersedes the prior committed fact through the fact-lifecycle rules in §6.4, and retains both facts plus the required commit and supersede decisions. `set_line_item_source` changes the source for an entire historical or forecast range and is intended to be batched with the assumptions or formulas that populate the new source. Historical ranges allow `actual`, `assumption`, `formula`, or `none`; this permits sourced historical overrides and explicit `not_applicable` bridge decisions at the valuation anchor. Forecast ranges allow `assumption`, `formula`, or `none`; `calculated` remains engine-owned. The operation clears formula and assumption coverage in the changed range before subsequent operations in the same batch, while facts and older immutable revisions remain available for audit. Registry-owned metrics and engine-native rows reject source changes. `set_assumption` replaces assumption coverage only for the explicitly named cells and rejects accidental overlap. `set_formula` likewise replaces only explicitly covered formula cells and is compiled before commit.

`add_line_item` means adding a row under a designated extensible parent, not changing the closed role vocabulary or the fixed DCF spine. In the first release the extensible parents are `revenue` and the custom-metrics namespace. Adding a `revenue_stream` atomically creates its companion row, the registry-owned historical YoY formula, its forecast growth-assumption cells, and the default revenue forecast formula. A custom metric must use a non-registry ID and cannot overwrite a standard metric definition.

`add_metric` is narrower than `add_line_item`: it selects a parameterized definition from the standard registry. In phase 1 that parameterized definition is CAGR, with an allowlisted target and bounded positive integer lookback. The registry derives the row ID, unit, coverage, and formula; the Agent cannot supply any of them.

`set_statement_mapping_plan` stores the selected source rows, periods, signs, and exclusions, then installs the compiler-owned historical formula for its canonical target. `set_aggregation_plan` stores a reviewed revenue or working-capital structural decision and invokes the appropriate deterministic compiler. In both cases the Agent proposes membership, but Formula DSL evaluation never asks a model how to add values. `advance_stage` is explicit and separate from data edits, so an Agent may commit a partial revenue or operations step without falsely declaring the stage complete. A batch may advance a stage together with the final inputs needed to pass that stage's gate.

## 8. Restricted Formula DSL (calculation layer)

### 8.1 Formula form

The Agent submits formula strings through `set_formula` against stable row IDs. The platform parses each formula into an allowlisted AST and stores both representations. Formula expressions are pure: they calculate a value for the current `(line item, period)` and cannot perform any Model Operations DSL action.

Examples:

```text
YOY(revenue.iphone)
LAG(revenue.iphone, 1) * (1 + growth.revenue.iphone)
revenue.iphone + revenue.services
operating_income * (1 - tax_rate)
nopat + depreciation_amortization - capital_expenditures - change_nwc
AVERAGE(margin.operating, -2, 0)
capital_expenditures / revenue.total
```

### 8.2 Evaluation context

One formula belongs to one line item and is evaluated once per period. The `(line item, period)` pair is the entire coordinate system, and the following rules define it completely.

- A bare identifier such as `revenue.iphone` means *the value of that line item in the current period*. There is no syntax for an absolute period.
- Every period argument is a **signed offset on the ordered period grid** (§7.1), where `0` is the current period and negative values move backward. Offsets are grid positions, never calendar arithmetic, so a fiscal-year change or a 52/53-week year cannot silently shift a reference.
- Offsets may cross the actual/forecast boundary; that is how the first forecast year references the last actual year. An offset that lands before the first period or after the last period yields a missing value and is reported through `missing_formula_input`, not treated as zero.
- `ttm` periods are skipped by every offset-based function (§7.1).
- `YEAR_INDEX()` returns the discount period of the current forecast period strictly after `ValuationConfig.anchorPeriodId`: `1, 2, 3, …` for `year_end` and `0.5, 1.5, 2.5, …` for `mid_year`. It returns `not_applicable` in historical periods and in forecast periods at or before the anchor.
- `DISCOUNT_FACTOR(wacc)` returns the cumulative factor from the first forecast period strictly after the valuation anchor through the current period using the stored discount convention and WACC path. It returns `not_applicable` before or at the anchor. Its dependencies are static because both the anchor and forecast range are fixed before formula compilation.

### 8.3 Supported language

Support:

- numeric literals;
- stable line-item identifiers;
- `+`, `-`, `*`, and `/`;
- parentheses;
- the allowlisted functions below, each with fixed arity.

| Function | Signature | Meaning |
| --- | --- | --- |
| `SUM` | `SUM(ref, from, to)` | sum of `ref` over the inclusive offset range |
| `AVERAGE` | `AVERAGE(ref, from, to)` | mean of `ref` over the inclusive offset range |
| `LAG` | `LAG(ref, n)` | `ref` at offset `-n`; `n` is a non-negative integer literal |
| `YOY` | `YOY(ref)` | `ref / LAG(ref, 1) - 1` |
| `CAGR` | `CAGR(ref, n)` | compound annual growth over the `n` grid periods ending at the current period |
| `MIN` / `MAX` | variadic numeric | extremum of the arguments |
| `ABS` | `ABS(x)` | absolute value |
| `POW` | `POW(base, exponent)` | exponentiation, see §8.5 |
| `YEAR_INDEX` | `YEAR_INDEX()` | discount period, see §8.2 |
| `DISCOUNT_FACTOR` | `DISCOUNT_FACTOR(ref)` | cumulative discount factor for a percent or ratio WACC path, see §12.1 |

Range bounds and `LAG` counts must be integer literals. A computed offset would make the dependency graph data-dependent and therefore unresolvable before evaluation.

Do not support:

- property access or reflection;
- dynamic function names;
- assignments inside formulas;
- file, network, environment, date, process, or random access;
- loops or recursion;
- JavaScript, Python, SQL, or shell expressions;
- comparison operators, booleans, conditional expressions, or fallback expressions such as `IF` and `COALESCE`.
- hierarchy-based aggregation; category sums must come from a reviewed `RevenueAggregationPlan` or `WorkingCapitalAggregationPlan`, which generates an explicit signed formula.

The Formula DSL never chooses an alternative source. A missing reference remains `missing_input`, and a zero denominator remains `divide_by_zero`. The Agent reads those cells through `read_cells` and explicitly changes the relevant fact, assumption, or period-specific formula in a later operation. This keeps source selection and exception handling visible in revision history rather than hiding them inside formulas.

### 8.4 Valuation is engine-native, not DSL

The DSL builds the model down to FCFF. Terminal value, discounting, the equity bridge, and sensitivity matrices are computed by the engine (§12) and are never expressed as Agent formulas.

The reason is that those steps need capabilities the row-by-row DSL deliberately lacks: anchoring to a specific period rather than an offset (`FCFF(n+1)` for Gordon growth), expanding one calculation across a parameter matrix, and enforcing constraints such as `WACC > terminal_growth` before evaluating. Adding those to the DSL would roughly double its surface for one caller. Agents therefore control valuation through numeric assumptions — WACC, terminal growth, exit multiple, and bridge components — plus a versioned `ValuationConfig` for method choices. A model that wants an explicit-period present-value row may use `fcff / DISCOUNT_FACTOR(wacc)`, but the reported valuation comes from the engine. The older `fcff / POW(1 + wacc, YEAR_INDEX())` expression is equivalent only for a constant WACC path and must not be used as the platform valuation.

### 8.5 Numeric policy

Values are computed in float64 and quantized to 12 significant digits before storage.

Decimal arithmetic is deliberately **not** used. Determinism does not require it: IEEE 754 is bit-reproducible under a fixed operation order, and §8.7 fixes that order by making the topological sequence total — ready-node ties break on authoritative period position, line-item numeric order, line-item ID, and complete cell key. Nor does this system have an exact-cents requirement, since inputs are already-rounded reported figures and outputs are valuations. Relative error near 1e-16 is roughly 1e-5 absolute on the 1e11-magnitude aggregates involved, orders of magnitude inside the XBRL rounding tolerance of §6.4. Quantization at storage removes the `0.1 + 0.2` display artifacts that motivate decimal in the first place, at no dependency cost.

The evaluation order is part of the reproducibility contract, not an implementation detail. So is quantization. Any change to arithmetic, quantization, or ordering increments the calculation-engine version (§5.3), so stored results become identifiably stale rather than silently inconsistent with what the current engine would produce.

Apply presentation rounding only in tool output.

### 8.6 Unit algebra

`incompatible_units` is only enforceable if the legal combinations are enumerated. Percentages are stored as decimal fractions (`0.12` means 12%); presentation converts, arithmetic never does.

| Left | Operator | Right | Result |
| --- | --- | --- | --- |
| currency | `+` `-` | currency, same code | currency |
| currency | `+` `-` | currency, different code | `incompatible_units` |
| currency | `*` `/` | number, percent, or ratio | currency |
| currency | `/` | currency, same code | ratio |
| currency | `/` | shares | per_share |
| percent | `+` `-` | percent | percent |
| ratio | `+` `-` | ratio | ratio |
| percent or ratio | `+` `-` | the other dimensionless semantic unit | ratio |
| percent or ratio | `*` `/` | number | preserve the left semantic unit |
| number | `*` | percent or ratio | preserve the right semantic unit |
| percent or ratio | `*` `/` | percent or ratio | ratio |
| shares | `+` `-` | shares | shares |
| number | any | number | number |

`number`, `percent`, and `ratio` are physically dimensionless but retain distinct semantic units. Literal `0` is a polymorphic additive zero: it adopts the other operand's unit in addition or subtraction and may be assigned as an explicit zero formula to any numeric target. Literal `1` is the dimensionless identity and may appear in `1 +/- percent` or `1 +/- ratio`, producing `ratio`. Other numeric literals do not gain this additive compatibility, so `10 + tax_rate` remains invalid.

`YOY` and `CAGR` return `percent`; division of like currencies returns `ratio`; and `ABS` preserves its input unit. `POW` accepts only a dimensionless base and a `number` exponent and returns `ratio`. `DISCOUNT_FACTOR` requires a `percent` or `ratio` line-item reference and returns `ratio`. A formula's result must be compatible with the target line item's declared unit; presentation uses that declared semantic unit.

Every combination not listed or covered by the literal rules is `incompatible_units`. `MIN`, `MAX`, `AVERAGE`, and `SUM` arguments require compatible units.

### 8.7 Evaluation rules

- Compile references into a dependency graph over `(line_item, period)` nodes, so a lagged self-reference such as `LAG(revenue.iphone, 1) * (1 + growth.revenue.iphone)` on the `revenue.iphone` row is a legal chain rather than a cycle.
- Evaluate in topological order, made total by breaking ready-node ties on authoritative period position, line-item numeric order, line-item ID, and complete cell key. Numeric comparisons are numeric, string comparisons use fixed code-point order, equal keys compare as `0`, and cycle diagnostics use the same ordering.
- Reject circular dependencies before calculation. A cycle is a cycle among cells, not among rows.
- Enforce expression length, AST depth, and node-count limits.
- Return structured missing-reference and divide-by-zero errors.
- Recalculate every affected downstream cell after a committed change.

## 9. Historical Metrics Library

Standard metrics are preinstalled formula rows, not values the Agent writes and not a separate calculation step. `create_financial_model` builds them into the skeleton; every successful mutation recalculates them with the rest of the grid. A metric remains `null` with `missing_input` until all required rows and compatible periods exist, and a zero denominator remains `divide_by_zero`.

The registry owns stable IDs, labels, units, required roles/rows, and Formula DSL templates. The Agent cannot redefine a standard numerator or denominator. Core defaults include:

| Metric row | Formula |
| --- | --- |
| `growth.revenue.<stream>` (historical cells) | `YOY(revenue.<stream>)` |
| `growth.revenue.total` (historical cells) | `YOY(revenue.total)` |
| `margin.operating` (historical cells) | `operating_income / revenue.total` |
| `tax_rate` (historical cells) | `income_tax_expense / pretax_income` |
| `ratio.da_to_revenue` | `depreciation_amortization / revenue.total` |
| `ratio.capex_to_revenue` | `capital_expenditures / revenue.total` |
| `ratio.operating_nwc_to_revenue` | `operating_working_capital / revenue.total` |
| `metric.roa` | `net_income / AVERAGE(total_assets, -1, 0)` |
| `metric.roe` | `net_income / AVERAGE(shareholders_equity, -1, 0)` |
| `metric.current_ratio` | `total_current_assets / total_current_liabilities` |

The remaining standard rows below follow the same registry pattern. Helper rows such as free cash flow, net debt, and invested capital are themselves stored generated formulas, so ROIC and per-share metrics still use the one Formula DSL arithmetic path. Formula coverage names actual periods explicitly; no metric treats TTM as a consecutive fiscal period.

Parameterized registered metrics use the Model Operations DSL operation `add_metric`, for example a CAGR target plus an integer lookback. The registry validates allowed targets and parameters, derives a stable row ID, and installs the normalized formula once; later revisions recalculate it automatically. The default skeleton includes three- and five-period total-revenue CAGR rows, which remain missing when history is too short. Arbitrary custom analysis uses an explicitly extensible custom-metric row plus `set_formula` and cannot impersonate a registry ID.

### 9.1 Growth

- revenue-stream YoY growth
- revenue-stream CAGR
- total revenue growth
- operating-income growth
- net-income growth
- EPS growth
- OCF and FCF growth

### 9.2 Profitability and cash generation

- gross margin
- operating margin
- EBITDA margin when D&A is available
- net margin
- OCF margin
- FCF margin
- OCF-to-net-income cash conversion
- capex as a percentage of revenue

### 9.3 Balance sheet and returns

- current ratio
- debt-to-equity
- net debt
- ROA using compatible average assets
- ROE using compatible average equity
- ROIC only when tax, invested-capital, debt, cash, and period requirements are satisfied
- diluted per-share metrics

Every unavailable metric returns `null` plus `missing_input`. Do not silently annualize data, fill absent values with zero, combine currencies, or mix GAAP and non-GAAP definitions.

## 10. Forecast Workflow

The `financial_modeling` subagent builds the model in explicit stages.

### Stage 1: Historical review

1. Create the model and run automatic SEC/Arelle extraction.
2. Review staged consolidated and dimensional facts.
3. Resolve blockers and commit reviewed history.
4. Inspect the automatically recalculated historical growth and operating metrics.

### Stage 2: Revenue forecast

1. Identify the relevant revenue streams.
2. Examine their historical growth and company-specific drivers.
3. Convert sourced management, industry, macro, or analyst evidence into explicit forecast assumptions.
4. Define revenue formulas and let the platform calculate each forecast period.
5. Reconcile forecast segment revenue to total revenue.

### Stage 3: Operations and FCFF

1. Define operating-cost or margin assumptions.
2. Define tax, D&A, capital-expenditure, and operating-working-capital assumptions.
3. Calculate NOPAT.
4. Calculate FCFF:

```text
FCFF = NOPAT + D&A - Capital expenditures - Change in operating working capital
```

### Stage 4: Valuation

1. Supply a sourced WACC or its sourced component assumptions and formula.
2. Supply Gordon-growth and exit-multiple assumptions.
3. Supply the complete equity bridge and diluted share count.
4. Calculate enterprise value, equity value, per-share value, and sensitivity matrices.

## 11. Assumption Contract

An assumption is **the resolution source for the `(line_item_id, period)` cells it names** (§7.2), not a parallel object type. It either supplies numeric values or explicitly records that an optional component is not applicable. A numeric payload requires an `assumption`-classified line item. A `not_applicable` payload may also resolve an otherwise-empty optional equity-bridge role that normally expects an actual fact; this is the only classification exception, and it cannot coexist with a fact, formula, or numeric assumption on the same cell. A cell may carry at most one assumption regardless of payload kind.

Every hard-coded forecast or valuation assumption contains:

```json
{
  "assumption_id": "a_7f3c1e",
  "line_item_id": "growth.revenue.services",
  "periods": ["FY2027", "FY2028", "FY2029"],
  "payload": {
    "kind": "values",
    "values": [0.12, 0.10, 0.08],
    "unit": "percent"
  },
  "source_type": "management_guidance",
  "source_refs": ["https://example.com/source"],
  "as_of_date": "2026-08-01",
  "rationale": "The assumption translates the cited demand and guidance evidence into a forecast path."
}
```

The payload is a discriminated union:

```ts
type AssumptionPayload =
  | { kind: "values"; values: number[]; unit: Unit }
  | { kind: "not_applicable" };
```

For a numeric payload, `values` has either length 1, meaning one constant applied to every listed period, or exactly the length of `periods`, meaning a per-period path. Any other length is a validation error. A single scalar cannot express a decaying growth path, which is the common case, so the array form is the primary one rather than an extension. A not-applicable payload contains no numeric value but has the same source, as-of-date, and rationale requirements.

`not_applicable` is not a hidden zero. Its cell stores null with explicit N/A status, and a normal DSL reference continues to propagate null. Only an engine-native calculation whose schema permits N/A may use it as a zero contribution. In the first release this is limited to optional equity-bridge components. The output must distinguish an explicit N/A with `applied_adjustment: 0` from a sourced numeric value of zero. FCFF, WACC, terminal growth, the selected EBITDA or FCFF exit metric, and diluted shares cannot be marked not applicable.

Allowed `source_type` values:

- `user`
- `management_guidance`
- `company_disclosure`
- `consensus`
- `macro_research`
- `industry_research`
- `analyst_inference`

`analyst_inference` still requires source references to the underlying evidence and a rationale explaining the transmission into the modeled line item.

WACC is path-capable: the model resolves one WACC value for every forecast period. A length-one assumption value produces a constant curve; a per-period value array produces a changing curve. The last forecast period's WACC is the terminal WACC. Terminal growth and exit multiple each resolve to one value at the last forecast period.

Discount convention, valuation anchor, exit-terminal-metric selection, and sensitivity deltas are method choices rather than numeric cells. Store them in a sourced `ValuationConfig`. Configuration changes create revisions, and `valuation.ts` reads only the normalized configuration stored in the revision; it accepts no unversioned calculation overrides.

## 12. DCF Calculation

### 12.1 Explicit forecast period

For each forecast year:

```text
Revenue stream = Prior-year revenue stream * (1 + Growth assumption)
Total revenue = Prior-year total revenue * (1 + consolidated growth), or signed sum of the reviewed active revenue aggregation set
NOPAT = EBIT * (1 - Tax rate)
Operating NWC = reviewed operating assets - reviewed operating liabilities
Change in NWC = current operating NWC - prior operating NWC
FCFF = NOPAT + D&A - Capital expenditures - Change in NWC
year_end_factor(k) = product j=1..k of (1 + WACC[j])
mid_year_factor(k) = product j=1..k-1 of (1 + WACC[j]) * (1 + WACC[k]) ^ 0.5
PV of FCFF(k) = FCFF(k) / selected_factor(k)
```

Forecast periods after the configured valuation anchor are indexed `1..n`; TTM periods do not consume an index. Support `year_end` and `mid_year` discount conventions and default to `year_end`. Store the convention in `ValuationConfig`. For a constant WACC the factors reduce to `(1 + WACC)^k` and `(1 + WACC)^(k - 0.5)` respectively.

### 12.2 Gordon-growth terminal value

```text
FCFF(n + 1) = FCFF(n) * (1 + Terminal growth)
Terminal value = FCFF(n + 1) / (WACC(n) - Terminal growth)
```

The last forecast period's WACC is the terminal WACC. Require `WACC(n) > terminal_growth`. Both terminal methods use the selected discount factor for period `n`, so mid-year convention applies the same `n - 0.5` timing to the terminal value. Invalid combinations appear as unavailable sensitivity cells rather than producing negative or infinite values.

### 12.3 Exit-multiple terminal value

```text
Terminal value = Terminal metric * Exit multiple
```

Support terminal EBITDA or terminal FCFF as the metric. The selected multiple must be sourced and must identify its definition and as-of date.

### 12.4 Equity bridge

```text
Equity value
  = Enterprise value
  + Cash available for the bridge
  + Non-operating investments
  - Debt
  - Lease liabilities
  - Preferred equity
  - Non-controlling interests
  +/- Other explicit adjustments
```

Every bridge component must have a sourced numeric fact or assumption, or a sourced assumption payload explicitly marked `not_applicable`. A permitted N/A component contributes zero to the bridge while retaining null cell value and N/A lineage. Do not silently treat a missing component as zero.

Per-share value is calculated only when a reviewed diluted share count or explicit share-count override is available.

### 12.5 Output

Return both terminal methods separately:

- explicit-period FCFF and present value
- terminal value and present value
- terminal value as a percentage of enterprise value
- enterprise value
- every equity-bridge adjustment
- equity value
- diluted shares
- implied value per share
- validation warnings
- assumption and formula lineage

Do not average the two methods automatically.

Generate:

- a WACC by terminal-growth sensitivity matrix for Gordon growth;
- a WACC by exit-multiple sensitivity matrix for the exit method.

Sensitivity deltas come from `ValuationConfig`. A WACC delta shifts the entire model WACC path in parallel, `stressed_WACC[j] = reference_WACC[j] + delta`, after which the engine recalculates every explicit-period factor and terminal value. Delta arrays are finite, sorted, deduplicated, and bounded in length before storage.

## 13. Public MCP Tools

All tool names, descriptions, schemas, summaries, and errors must be written in English.

### 13.1 `create_financial_model`

Inputs:

- `symbol`
- `history_years`, default 5, range 3-10
- `forecast_years`, default 5, range 3-10
- optional filing forms
- optional reporting currency

Behavior:

- resolve the SEC filer;
- reject unsupported entity types;
- create a persistent draft model with the standard metric registry installed as formula rows;
- retrieve standardized facts;
- run filing-level XBRL extraction;
- return `model_id`, revision, staged candidates, reconciliation results, review blockers, the revision-zero summary, and one complete `statement_mapping` workbook containing the three prepared source sheets beside the prebuilt DCF template.

### 13.2 `review_financial_model_history`

Inputs:

- `model_id`
- `expected_revision`
- candidate decisions
- selected historical period IDs
- reviewed statement-mapping plans
- optional manual facts and corrections

Behavior:

- validate provenance and period compatibility;
- require resolution of blocking candidates;
- apply commit, reject, and replacement decisions atomically;
- validate each plan's source categories, add/subtract/exclude decisions, selected periods, and unique target-period coverage, then compile its canonical DCF formula;
- enforce one committed fact per `(line_item_id, period_id)` and retain all decisions and superseded facts;
- recalculate and commit reviewed actuals as one new revision;
- after the history gate passes, return the deterministic revision summary and complete `dcf` workbook without the three source sheets; keep compact mapping references and remaining non-blocking warnings.

### 13.3 `apply_financial_model_operations`

Inputs:

- `model_id`
- `expected_revision`
- a non-empty ordered `operations` array using the typed union in §7.4

Behavior:

- apply fact replacements, allowed source changes, assumption changes, extensible line-item additions, registered metric additions, formula changes, statement/revenue/working-capital plans, valuation configuration, and explicit stage advancement;
- validate operation-specific provenance, coverage, role, period, and classification invariants;
- compile the dependency graph;
- recalculate the complete grid and, when requested by the lifecycle stage, valuation outputs;
- reject blocking validation errors without mutation;
- commit exactly one complete revision for the entire operation batch on success;
- return the new deterministic `revision_summary` and complete `current_workbook` so it becomes the sole current-state block for the Agent's next decision.

### 13.4 `get_financial_model`

Inputs:

- `model_id`
- optional revision
- optional section: `summary`, `history`, `metrics`, `revenue`, `operations`, `dcf`, `source_income_statement`, `source_balance_sheet`, `source_cash_flow`, or `audit`
- optional cell selector from §7.4: exact cell references, line-item IDs, period IDs, parent ID, role, or period class
- optional detailed-cell flag

Behavior:

- authorize by owner;
- with no revision, section, or selector, return `ModelContextView`: every prior `RevisionSummary` plus the complete latest `CurrentWorkbookView`;
- with a section or selector, return the selected slice in workbook row/period shape, not a flat cell stream;
- a source-statement section is an explicit audit/mapping read and does not cause that source sheet to persist in the next default DCF context;
- with an explicit older revision, return that revision's targeted workbook view without injecting every intervening snapshot;
- include compact source references by default and full fact, assumption, formula-AST, and review lineage only when requested.

### 13.5 `list_financial_models`

Inputs:

- optional symbol
- optional status, from the lifecycle values in §5.3
- optional result limit, default 20, maximum 100
- optional cursor for pagination

Behavior:

- list models owned by the current Agent identity, newest update first;
- exclude `archived` models unless that status is explicitly requested;
- return model ID, symbol, status, current revision, forecast range, update timestamp, and the next cursor when more results exist.

### 13.6 `archive_financial_model`

Inputs:

- `model_id`
- `expected_revision`

Behavior:

- set lifecycle status to `archived`;
- retain every revision, because archival is a visibility change and must not break the lineage that already-issued analyses point at;
- hide the model from default listings;
- return the archive revision summary and archived current workbook.

There is no hard-delete tool. A model that a report cites must remain resolvable.

## 14. Orchestra Integration

### 14.1 New subagent

Add `financial_modeling` to the Agent type system, event-source validation, subagent registry, dispatcher, and prompts.

Responsibilities:

- review structured historical facts;
- inspect automatically recalculated deterministic historical metrics;
- translate research evidence into explicit assumptions;
- define restricted formulas;
- build the forecast and inspect valuation sensitivities;
- return only platform-calculated numerical outputs.

It must not perform web research when `market_research` should supply the evidence, and it must not recompute platform results in prose.

### 14.2 Tool-step budget

Make the subagent tool-step limit configurable per subagent.

- Keep the existing limit of 5 for current subagents (`MAX_TOOL_STEPS` in `src/framework/subagent.ts`).
- Set `financial_modeling` to 12. The happy path alone is seven steps — create, review, revenue, operations, valuation, inspect, finish — so the existing budget of 5 leaves no room for the full workflow or for a `revision_conflict`, provenance rejection, or missing-input retry.

A larger budget is a cushion, not a solution, because a sufficiently contested model will exhaust any fixed limit. The actual guarantee comes from persistence:

**On budget exhaustion the subagent must return `model_id`, the current revision, and the current lifecycle stage instead of a failure.** The model is durable, so the orchestrator can dispatch a continuation task that resumes exactly where the previous one stopped. Running out of steps is a pause, never a lost model.

### 14.3 Model-context projection

`financial_modeling` uses replaceable model-state context rather than an append-only sequence of complete workbooks. Before its first decision for an existing model and whenever it resumes after budget exhaustion, the runtime calls the context view and injects exactly one JSON block:

```text
ModelContextView {
  revisionHistory: all prior deterministic summaries,
  currentWorkbook: the complete latest workbook
}
```

After a successful mutating tool call, its returned `current_workbook` replaces the older workbook block for the same `model_id` before the next LLM continuation. The replaced tool result is retained only as its `RevisionSummary`, tool name, success/failure status, and revision number. The runtime must not append revision 5's complete workbook, then revision 6's complete workbook, then revision 7's complete workbook to the model prompt. This is context projection only; it does not modify stored tool events or immutable model revisions.

Context compaction is deterministic application logic, not LLM summarization. Exact audit reads requested during the current decision remain visible for that decision, but are not promoted into persistent model context. On the next resumption they disappear unless requested again. A `revision_conflict` replaces neither block; it reports the actual current revision and forces a fresh `ModelContextView` read.

For a newly created model, the create response supplies revision zero's complete workbook. For an existing model, the orchestrator must pass `model_id` into the subagent continuation so the runtime can rebuild context without relying on conversation memory.

### 14.4 Tool pool

Add `FINANCIAL_MODELING_TOOLS` containing only the six financial-model tools. Do not expose trading operations or unrestricted arbitrary execution.

### 14.5 Stock-analysis skill

Update the English `stock-analysis` skill to:

- include `financial_modeling` in its Agent list;
- allow the six model tools;
- send filings, news, guidance, macro, and assumption sourcing to `market_research`;
- send historical metrics, forecasts, formulas, FCFF, and DCF to `financial_modeling`;
- require both sensitivity matrices for a full valuation exercise;
- prohibit price targets when a reviewed and successfully calculated valuation is unavailable;
- quote only values returned by the platform.

Keep the main skill concise. Put the detailed workflow and formula guidance in a new `financial-modeling-playbook.md` reference and load it only for modeling or valuation requests.

## 15. Error Handling

Return structured errors for at least:

| Code | Meaning |
| --- | --- |
| `financial_model_not_found` | The model does not exist or is not visible to the current owner. |
| `revision_conflict` | `expected_revision` is stale. |
| `fact_conflict` | Fact state, active-cell uniqueness, or supersede lineage is inconsistent. |
| `invalid_model_operation` | A mutation kind, target, lifecycle transition, or batch invariant is invalid. |
| `invalid_model_query` | A cell selector is malformed or names an unknown model coordinate. |
| `unsupported_model_type` | The entity requires a specialized model, or is an IFRS filer excluded by §3.2. |
| `history_review_required` | Forecasting was requested before historical review completed. |
| `xbrl_runtime_unavailable` | The Arelle runtime is missing or cannot start. |
| `xbrl_parse_failed` | The filing could not be parsed. |
| `xbrl_timeout` | Extraction exceeded the bounded runtime. |
| `unresolved_reconciliation` | Segment and consolidated facts do not reconcile. |
| `incompatible_periods` | A calculation mixes incompatible fiscal contexts. |
| `incompatible_units` | A formula combines incompatible units or currencies. |
| `invalid_assumption` | Assumption coverage, payload, unit, or source classification is invalid. |
| `invalid_formula` | Formula parsing or allowlist validation failed. |
| `circular_dependency` | The formula graph contains a cycle. |
| `missing_formula_input` | A required referenced value is unavailable. |
| `invalid_terminal_assumptions` | WACC, growth, or multiple inputs violate model constraints. |
| `incomplete_equity_bridge` | Per-share equity value cannot be calculated safely. |

Calculation warnings may be committed when they do not invalidate the model. Blocking errors must leave the current revision unchanged.

## 16. Testing Strategy

### 16.1 Formula engine

- parsing and AST normalization
- operator precedence
- rejection of comparisons, booleans, `IF`, and `COALESCE`
- dependency ordering
- lagged period references
- YoY and CAGR calculations
- rejection of hierarchy-based sums outside reviewed aggregation plans
- single-forecast assumption uniqueness
- circular dependencies
- missing references
- division by zero
- unit and currency errors
- polymorphic-zero and dimensionless-identity unit cases
- anchor-relative `YEAR_INDEX`, including forecast periods at or before the anchor
- constant and changing WACC paths through anchor-relative `DISCOUNT_FACTOR`
- cumulative year-end and mid-year factors, including terminal-value timing
- parallel WACC-path shifts in both sensitivity matrices
- reviewed revenue aggregation selects one disclosure set without double-counting
- subtractive eliminations and period-specific aggregation-plan changes
- working-capital plans classify operating assets and liabilities, exclude financing balances, and change definition by period without overlap
- cash-flow-statement working-capital changes reconcile but never double-enter FCFF
- deterministic quantized output under a fixed evaluation order
- expression complexity limits

### 16.2 Historical metrics

- default registry rows exist at model creation and recalculate after prerequisite facts change without a separate metric call
- registered formulas and IDs cannot be overwritten by Agent values or custom formulas
- growth and margin golden cases
- average-balance ROA and ROE
- ROIC input sufficiency
- negative and zero denominators
- missing-input results
- no GAAP/non-GAAP or annual/quarterly mixing

### 16.3 DCF

- explicit forecast present values
- year-end and mid-year conventions
- Gordon terminal value
- exit-multiple terminal value
- invalid WACC/growth combinations
- fixed-role cardinality, including unique EBITDA/FCFF exit-metric selection
- equity-bridge adjustments
- raw cash remains distinct from reviewed cash available for the bridge
- numeric zero, explicit `not_applicable`, and missing equity-bridge inputs remain distinct
- N/A propagates through ordinary DSL formulas and is consumed only by permitted bridge roles
- per-share value
- both sensitivity matrices
- no automatic valuation blending

Two cases anchor the whole engine and must exist before any other DCF test:

1. **Golden end-to-end valuation.** One fixture company with hand-computed intermediate values, checked cell by cell from reviewed revenue through FCFF, terminal value, enterprise value, the equity bridge, and implied value per share. Hand-computed, not snapshot-recorded: a snapshot only proves the engine still does what it did, never that it does the right thing.
2. **Determinism.** Reordering non-semantic input collections such as facts, assumptions, formulas, and line items, loading the snapshot back from SQLite, and calculating it again produce identical ordered cells, valuation outputs, and diagnostics under the same calculation-engine version, including through the float64 boundary in §8.5. The periods array is not shuffled because its stored order is model semantics.

### 16.4 XBRL extraction

Use local fixtures rather than live-network tests. Cover:

- standard consolidated revenue
- custom product revenue concepts
- explicit segment dimensions
- geography axes
- multiple currencies
- amended filings
- comparative-period restatements
- segment-definition changes
- eliminations and reconciliation rows
- incomplete and unreconciled disclosures
- prepared three-sheet source view preserves original rows/periods and never writes LLM-computed totals
- reviewed statement mappings compile add/subtract/exclude members into canonical DCF rows
- mapping reuse keeps normal post-history context DCF-only, while new/unmapped/restated structures reopen review

### 16.5 Persistence and access

- reopen SQLite and restore models
- immutable revision history
- staged and rejected facts excluded from calculation
- one active fact per line item and period
- atomic restatement/manual-correction replacement with retained review decisions
- invalid or forked supersede chains rejected with `fact_conflict`
- stale revision conflicts, including that the conflict response carries the current revision
- validation or snapshot-insert failure creates no revision
- concurrent commits from the same expected revision produce one winner and one `revision_conflict`
- current revision, lifecycle, and update time are derived from the latest immutable revision row
- in-memory store clones on read and write so callers cannot mutate history
- owner scoping of list and read
- cross-Topic discovery for the same Agent identity
- engine-version persistence and deterministic results after reopening SQLite
- immutable deterministic `change_summary_json` for every revision and summary-only history reads without decoding old snapshots
- archived models excluded from default listings while their revisions stay resolvable

### 16.6 Tools, Orchestra, and skill

- tool registration and JSON schemas
- typed operation-union validation with no generic patch escape hatch
- exact and multi-cell reads by cell, line item, period, parent, section, role, and period class
- default `ModelContextView` contains only prior revision summaries plus one complete latest workbook
- initial `statement_mapping` workbook contains the three prepared source sheets plus the DCF template, then deterministically switches to a source-free `dcf` workbook after review
- compact persisted statement mappings are reused without re-injecting source sheets; explicit mapping exceptions and audit reads can restore the required source view
- workbook views materialize `not_modeled` separately from missing, N/A, and divide-by-zero cells and serialize rows and periods deterministically
- after each mutation, subagent context retains the new complete workbook and compacts every older workbook to its stored revision summary without LLM summarization
- explicit old-revision and full-lineage reads remain available on demand and are not persisted in the next resumed context
- atomic multi-operation commits producing one revision, plus read queries producing none
- historical replacements retaining old and new facts plus the paired commit and supersede decisions
- extensible line-item creation respecting fixed-skeleton boundaries
- full create-to-DCF phased workflow
- correct routing to `financial_modeling`
- per-subagent eight-step limit
- structured tool failures
- compact versus full lineage responses
- stock-analysis tool whitelist and workflow constraints
- English-only checks for skills, references, prompts, tool descriptions, schema descriptions, summaries, and errors

Run the TypeScript build, the complete repository test suite, Python adapter fixture tests, and the English-content verification script.

## 17. Acceptance Criteria

The implementation is accepted when:

1. An Agent can create a persistent model for a supported ticker and receive automatically extracted, uncommitted historical candidates.
2. The Agent can select periods and vertical categories from prepared income-statement, balance-sheet, and cash-flow sheets, commit signed mappings into the prebuilt DCF rows, and commit only reconciled or explicitly corrected history. Mapping is reused so later modeling receives only the DCF workbook unless a source exception occurs; replacements are atomic, active source facts are unique per cell, and rejected/superseded facts plus review rationales remain auditable.
3. The platform calculates historical growth and financial metrics without language-model arithmetic.
4. The Agent can read exact or selected model cells and can submit sourced facts, allowed range-level source changes, assumptions, extensible line items, formulas, aggregation plans, and valuation configuration through explicit typed operations; it does not rely on an untyped stage-change patch.
5. The platform recalculates all dependent revenue, operating, FCFF, and valuation rows after every successful mutation batch.
6. Both Gordon-growth and exit-multiple DCF outputs are available separately with sensitivity matrices.
7. Every displayed result can be traced to source facts, assumptions, formulas, and a model revision.
8. Missing or incompatible data produces structured limitations instead of fabricated values.
9. Models remain accessible across Topics owned by the same Agent identity and are not listed or readable under a different `owner_agent_id`. This is namespacing, not confidentiality (§5.2).
10. Orchestra invokes the dedicated modeling subagent for deterministic financial modeling requests.
11. Every number in a `financial_modeling` final report appears in that task's tool outputs. This replaces the untestable phrasing "no LLM-only number is presented as a platform result": the mechanical check is that reported figures are traceable to a tool response, and the residual judgment call stays a review-time criterion rather than pretending to be an automated one.
12. At every modeling decision, the Agent receives deterministic summaries of prior revisions and exactly one complete current workbook; obsolete complete workbooks are not accumulated in context, while explicit old-revision audit reads remain available.
13. All added or modified skill, prompt, and tool content is in English.

## 18. Implementation Areas

Primary implementation areas:

- `src/financial-model/`: model types, persistence, DSL compiler, calculation engine, metrics, and DCF logic.
- `mcp_tools/financial-model/`: public financial-model tools and adapters.
- `skills/stock-analysis/`: Orchestra-facing modeling workflow and progressive-disclosure reference.

### 18.1 Framework touch points

Adding the `financial_modeling` Agent kind requires all six of the following. The fourth is the one that fails silently if missed — an unlisted event kind is dropped rather than rejected, so the subagent would appear to run while producing no visible tool events.

1. `src/framework/types.ts` — the `AgentKind` union.
2. `src/framework/skill.ts` — the `AGENT_KINDS` set used for skill frontmatter validation.
3. `src/framework/sessionState.ts` — the `Source` union **and** the per-source allowed-event-kind map.
4. `src/framework/subagent.ts` — per-subagent tool-step limit plus replaceable `ModelContextView` projection keyed by `model_id`.
5. `src/agent/subagents/registerSubagents.ts` — registry entry.
6. `mcp_tools/registerTools.ts` — the `FINANCIAL_MODELING_TOOLS` pool, plus `src/agent/prompts/subagentPrompts.ts` for the system prompt.

Agent identity propagation touches the tool execution context in **two** places, because the mcp_tools registry is a standalone structural copy of the framework one:

- `mcp_tools/toolRegistry.ts`
- `src/infra/mcp/toolRegistry.ts`

Both `ToolHandler` signatures and both `call` methods must carry `agentId`, along with the HTTP server, dispatcher, and subagent runtime that thread the context through.

## 19. Delivery Phases

The work ships in four phases. The ordering principle is that each phase ends in a state that is verifiable on its own, and that the highest-risk component is not on the critical path to a usable product.

### Phase 1: Core engine

Model and revision types, SQLite persistence, DSL compiler, calculation engine, historical metrics library, and DCF with sensitivity matrices. Pure computation plus storage, no network. Facts enter from the existing SEC Company Facts integration and from Agent-supplied manual facts.

Done when the golden hand-computed DCF and the determinism test in §16.3 pass.

### Phase 2: Tools and framework integration

The six MCP tools, `agentId` propagation, the `financial_modeling` subagent and its six framework touch points, replaceable current-workbook context projection, the tool-step budget, and the resumption contract.

Done when an Agent can run create → review → inspect automatically recalculated metrics → revenue → operations → valuation end to end, with owner scoping and `revision_conflict` under test. **This is the first phase that produces a usable product**; everything after it is enhancement.

### Phase 3: DCF skill

`stock-analysis` integration plus the `financial-modeling-playbook.md` reference: sensitivity requirements, the prohibition on price targets without a calculated valuation, and the rule that only platform values may be quoted.

Done when skill routing tests and the English-content verification script pass.

### Phase 4: Filing-level XBRL extraction

The Arelle adapter, filing-level extraction, candidate mapping, and reconciliation, plugged into the review pipeline that phases 1 and 2 have already stabilized.

Done when the §16.4 fixture cases pass and the system verifiably degrades to Company-Facts-only when the adapter is absent.

**Why extraction is last.** It is the only component that can be omitted entirely: a consolidated-revenue DCF is a complete valuation, and segment decomposition improves precision rather than enabling the result. It also carries the project's only new language runtime, with taxonomy caching, multi-second parses, and a distinct class of operational failures — the three dedicated error codes in §15 are the evidence. Two further reasons are structural: the extracted-fact contract in §6.2 is easier to get right once the review-and-commit pipeline that consumes it exists, and §6.1 already requires graceful degradation, which building extraction last enforces by construction instead of by a retrofitted fallback branch.
