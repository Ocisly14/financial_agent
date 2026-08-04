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
- Shared model structure with base, upside, and downside scenarios.
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
- lifecycle status, one of `draft`, `history_committed`, `revenue_forecast`, `operations_fcff`, `valued`, or `archived`
- current revision number
- historical and forecast range
- creation and update timestamps

Each revision contains:

- revision number and parent revision
- logical stage
- reviewed facts and provenance
- assumptions and source metadata
- formula source text and normalized AST
- calculated values
- validation warnings and blockers
- calculation-engine version
- canonical input hash
- creating session and timestamp

Every mutating tool requires `expected_revision`. A stale revision returns `revision_conflict` and does not overwrite the current model.

Because `expected_revision` is mandatory, every tool response — successful or failed — carries a uniform envelope so the Agent always holds a usable revision number:

```json
{ "model_id": "...", "revision": 7, "status": "history_committed", "...": "tool-specific payload" }
```

A `revision_conflict` error returns the current revision in the same envelope so the Agent can re-read and retry without an extra tool call.

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

### 6.4 Agent review

For each candidate, the Agent may:

- approve the proposed mapping;
- map it to another canonical line-item ID;
- reject it;
- relabel it without changing the source fact;
- replace it with a manual fact carrying equivalent provenance;
- add an explicit eliminations, reconciliation, or other row.

Segment totals must reconcile to consolidated revenue within the tolerance implied by XBRL rounding precision. Do not use an arbitrary percentage tolerance.

The tolerance is derived, not chosen. Each fact reported with a `decimals` value of `d` carries a maximum rounding error of half its last retained unit, `0.5 * 10^(-d)`. For a comparison summing `n` segment facts against one consolidated fact, the allowed absolute difference is the sum of the individual bounds:

```text
tolerance = 0.5 * 10^(-d_consolidated) + sum over segments of 0.5 * 10^(-d_i)
```

A fact tagged `decimals="INF"` contributes zero. A fact with no `decimals` attribute makes the comparison indeterminate and is reported as a review item rather than silently passed. Unresolved differences remain blocking review items.

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

Periods form a single ordered grid. Every formula offset in §8 is a position on this grid, never calendar arithmetic.

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
capex
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

Classification is given separately for the historical and forecast ranges because one row normally has different sources in each: `revenue.iphone` is `actual` in historical periods and `formula` in forecast periods. That is the common case, not an exception.

`createModel` generates the standard rows with their roles already bound, and skeleton rows cannot be renamed, re-parented, deleted, or re-roled. The engine binds valuation inputs by role, never by string ID, so a model can never be missing FCFF and a caller's typo can never silently become "no FCFF row found." Callers extend the model only at designated extensible parents; in the first release that is `revenue`, whose children carry the role `revenue_stream`. Adding a revenue stream creates the value row and its growth-assumption row as a pair, because a forecast stream with no growth driver is always a modeling error. `revenue.total` is permanently `SUM_CHILDREN(revenue)`, which makes segment-to-total reconciliation structurally impossible to violate: a residual can only be expressed as an explicit child row.

Classification governs where a cell's value comes from, and the sources are mutually exclusive per `(line_item, scenario, period)`:

| Classification | Value source |
| --- | --- |
| `actual` | a reviewed fact committed in §6 |
| `assumption` | exactly one assumption record (§11) |
| `formula` | one formula evaluated per period (§8) |
| `calculated` | engine-native output (§12), not Agent-writable |

A cell that has both an assumption and a formula is a definition error, not a precedence question, and is rejected with `invalid_formula`.

### 7.3 Scenarios

One model contains shared actuals and formula structure plus named scenario overrides.

- `base` is required for a valuation stage.
- `upside` and `downside` are optional for standalone calculations but required by the full `stock-analysis` workflow.
- A scenario overrides assumptions, not reviewed historical facts.
- Scenario output must identify every assumption that differs from base.

## 8. Restricted Formula DSL

### 8.1 Formula form

The Agent submits formula strings against stable row IDs. The platform parses each formula into an allowlisted AST and stores both representations.

Examples:

```text
YOY(revenue.iphone)
LAG(revenue.iphone, 1) * (1 + growth.revenue.iphone)
SUM_CHILDREN(revenue)
operating_income * (1 - tax_rate)
nopat + depreciation_amortization - capex - change_nwc
AVERAGE(margin.operating, -2, 0)
IF(revenue.total > 0, capex / revenue.total, 0)
```

### 8.2 Evaluation context

One formula belongs to one line item and is evaluated once per `(period, scenario)` cell. That triple is the entire coordinate system, and the following rules define it completely.

- A bare identifier such as `revenue.iphone` means *the value of that line item in the current period and current scenario*. There is no syntax for an absolute period and no syntax for another scenario; scenario is fixed for the whole evaluation, which is what makes scenario isolation structural rather than a runtime check.
- Every period argument is a **signed offset on the ordered period grid** (§7.1), where `0` is the current period and negative values move backward. Offsets are grid positions, never calendar arithmetic, so a fiscal-year change or a 52/53-week year cannot silently shift a reference.
- Offsets may cross the actual/forecast boundary; that is how the first forecast year references the last actual year. An offset that lands before the first period or after the last period yields a missing value and is reported through `missing_formula_input`, not treated as zero.
- `ttm` periods are skipped by every offset-based function (§7.1).
- `YEAR_INDEX()` returns the discount period of the current forecast period under the model's discount convention: `1, 2, 3, …` for `year_end` and `0.5, 1.5, 2.5, …` for `mid_year`. It is undefined in historical periods and returns a missing value there.

### 8.3 Supported language

Support:

- numeric literals;
- stable line-item identifiers;
- `+`, `-`, `*`, and `/`;
- the comparison operators `>`, `>=`, `<`, `<=`, `=`, and `<>`, which produce boolean values usable **only** as the first argument of `IF`. A boolean reaching arithmetic is `invalid_formula`, so there is no implicit true/false-to-number coercion anywhere in the engine;
- parentheses;
- the allowlisted functions below, each with fixed arity.

| Function | Signature | Meaning |
| --- | --- | --- |
| `SUM` | `SUM(ref, from, to)` | sum of `ref` over the inclusive offset range |
| `SUM_CHILDREN` | `SUM_CHILDREN(ref)` | sum of the direct children of `ref` in the current period |
| `AVERAGE` | `AVERAGE(ref, from, to)` | mean of `ref` over the inclusive offset range |
| `LAG` | `LAG(ref, n)` | `ref` at offset `-n`; `n` is a non-negative integer literal |
| `YOY` | `YOY(ref)` | `ref / LAG(ref, 1) - 1` |
| `CAGR` | `CAGR(ref, n)` | compound annual growth over the `n` grid periods ending at the current period |
| `MIN` / `MAX` | variadic numeric | extremum of the arguments |
| `ABS` | `ABS(x)` | absolute value |
| `IF` | `IF(condition, then, else)` | condition must be a comparison |
| `COALESCE` | `COALESCE(a, b, …)` | first non-missing argument |
| `POW` | `POW(base, exponent)` | exponentiation, see §8.5 |
| `YEAR_INDEX` | `YEAR_INDEX()` | discount period, see §8.2 |

Range bounds and `LAG` counts must be integer literals. A computed offset would make the dependency graph data-dependent and therefore unresolvable before evaluation.

Do not support:

- property access or reflection;
- dynamic function names;
- assignments inside formulas;
- file, network, environment, date, process, or random access;
- loops or recursion;
- JavaScript, Python, SQL, or shell expressions;
- arithmetic on boolean values.

### 8.4 Valuation is engine-native, not DSL

The DSL builds the model down to FCFF. Terminal value, discounting, the equity bridge, and sensitivity matrices are computed by the engine (§12) and are never expressed as Agent formulas.

The reason is that those steps need capabilities the row-by-row DSL deliberately lacks: anchoring to a specific period rather than an offset (`FCFF(n+1)` for Gordon growth), expanding one calculation across a parameter matrix, and enforcing constraints such as `WACC > terminal_growth` before evaluating. Adding those to the DSL would roughly double its surface for one caller. Agents therefore control valuation by supplying **assumptions** — WACC, terminal growth, exit multiple, discount convention, bridge components — not formulas. The `fcff / POW(1 + wacc, YEAR_INDEX())` form remains legal DSL for a model that wants an explicit-period present-value row, but the reported valuation comes from the engine.

### 8.5 Numeric policy

Values are computed in float64 and quantized to 12 significant digits before storage.

Decimal arithmetic is deliberately **not** used. Determinism does not require it: IEEE 754 is bit-reproducible under a fixed operation order, and §8.7 fixes that order by making the topological sequence total — ties break on line-item order, then ID. Nor does this system have an exact-cents requirement, since inputs are already-rounded reported figures and outputs are valuations. Relative error near 1e-16 is roughly 1e-5 absolute on the 1e11-magnitude aggregates involved, orders of magnitude inside the XBRL rounding tolerance of §6.4. Quantization at storage removes the `0.1 + 0.2` display artifacts that motivate decimal in the first place, at no dependency cost.

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
| percent or ratio | `+` `-` | percent or ratio | percent or ratio |
| percent or ratio | `*` `/` | number, percent, or ratio | ratio |
| shares | `+` `-` | shares | shares |
| number | any | number | number |

Every combination not listed is `incompatible_units`. Comparison operators require both operands to reduce to the same unit. `MIN`, `MAX`, `AVERAGE`, `SUM`, and `COALESCE` require all arguments to share one unit.

### 8.7 Evaluation rules

- Compile references into a dependency graph over `(line_item, period)` nodes, so a lagged self-reference such as `LAG(revenue.iphone, 1) * (1 + growth.revenue.iphone)` on the `revenue.iphone` row is a legal chain rather than a cycle.
- Evaluate in topological order, made total by breaking ties on line-item order and then ID, so the same model always evaluates in the same sequence.
- Reject circular dependencies before calculation. A cycle is a cycle among cells, not among rows.
- Enforce expression length, AST depth, and node-count limits.
- Return structured missing-reference and divide-by-zero errors.
- Recalculate every affected downstream cell after a committed change.

## 9. Historical Metrics Library

`calculate_financial_metrics` adds deterministic derived rows to a reviewed model revision.

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

Every unavailable metric returns `null` plus `missing_inputs`. Do not silently annualize data, fill absent values with zero, combine currencies, or mix GAAP and non-GAAP definitions.

## 10. Forecast Workflow

The `financial_modeling` subagent builds the model in explicit stages.

### Stage 1: Historical review

1. Create the model and run automatic SEC/Arelle extraction.
2. Review staged consolidated and dimensional facts.
3. Resolve blockers and commit reviewed history.
4. Calculate historical growth and operating metrics.

### Stage 2: Revenue forecast

1. Identify the relevant revenue streams.
2. Examine their historical growth and company-specific drivers.
3. Convert sourced management, industry, macro, or analyst evidence into explicit scenario assumptions.
4. Define revenue formulas and let the platform calculate each forecast period.
5. Reconcile forecast segment revenue to total revenue.

### Stage 3: Operations and FCFF

1. Define operating-cost or margin assumptions.
2. Define tax, D&A, capex, and working-capital assumptions.
3. Calculate NOPAT.
4. Calculate FCFF:

```text
FCFF = NOPAT + D&A - Capex - Change in Net Working Capital
```

### Stage 4: Valuation

1. Supply a sourced WACC or its sourced component assumptions and formula.
2. Supply Gordon-growth and exit-multiple assumptions.
3. Supply the complete equity bridge and diluted share count.
4. Calculate enterprise value, equity value, per-share value, and sensitivity matrices.

## 11. Assumption Contract

An assumption is **the value source for the `(line_item_id, scenario, period)` cells it names** (§7.2), not a parallel object type. The referenced line item must already exist with classification `assumption`, and a cell may carry at most one assumption per scenario.

Every hard-coded forecast or valuation assumption contains:

```json
{
  "assumption_id": "a_7f3c1e",
  "line_item_id": "growth.revenue.services",
  "scenario": "base",
  "periods": ["FY2027", "FY2028", "FY2029"],
  "values": [0.12, 0.10, 0.08],
  "unit": "percent",
  "source_type": "management_guidance",
  "source_refs": ["https://example.com/source"],
  "as_of_date": "2026-08-01",
  "rationale": "The assumption translates the cited demand and guidance evidence into a forecast path."
}
```

`values` has either length 1, meaning one constant applied to every listed period, or exactly the length of `periods`, meaning a per-period path. Any other length is a validation error. A single scalar cannot express a decaying growth path, which is the common case, so the array form is the primary one rather than an extension.

Allowed `source_type` values:

- `user`
- `management_guidance`
- `company_disclosure`
- `consensus`
- `macro_research`
- `industry_research`
- `analyst_inference`

`analyst_inference` still requires source references to the underlying evidence and a rationale explaining the transmission into the modeled line item.

## 12. DCF Calculation

### 12.1 Explicit forecast period

For each scenario and forecast year:

```text
Revenue stream = Prior-year revenue stream * (1 + Growth assumption)
Total revenue = Sum of revenue streams
NOPAT = EBIT * (1 - Tax rate)
FCFF = NOPAT + D&A - Capex - Change in NWC
PV of FCFF = FCFF / (1 + WACC) ^ Discount period
```

Support `year_end` and `mid_year` discount conventions. Default to `year_end`; store the selected convention as a valuation assumption.

### 12.2 Gordon-growth terminal value

```text
Terminal value = FCFF(n + 1) / (WACC - Terminal growth)
```

Require `WACC > terminal_growth`. Invalid combinations appear as unavailable sensitivity cells rather than producing negative or infinite values.

### 12.3 Exit-multiple terminal value

```text
Terminal value = Terminal metric * Exit multiple
```

Support terminal EBITDA or terminal FCFF as the metric. The selected multiple must be sourced and must identify its definition and as-of date.

### 12.4 Equity bridge

```text
Equity value
  = Enterprise value
  + Cash
  + Non-operating investments
  - Debt
  - Lease liabilities
  - Preferred equity
  - Non-controlling interests
  +/- Other explicit adjustments
```

Every bridge component must be sourced or explicitly marked `not_applicable`. Do not silently treat an unavailable item as zero.

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
- create a persistent draft model;
- retrieve standardized facts;
- run filing-level XBRL extraction;
- return `model_id`, revision, staged candidates, reconciliation results, and review blockers.

### 13.2 `review_financial_model_history`

Inputs:

- `model_id`
- `expected_revision`
- candidate decisions
- optional manual facts and corrections

Behavior:

- validate provenance and period compatibility;
- require resolution of blocking candidates;
- commit reviewed actuals as a new revision;
- return the committed history and remaining non-blocking warnings.

### 13.3 `calculate_financial_metrics`

Inputs:

- `model_id`
- `expected_revision`
- optional metric list
- optional line-item list
- optional CAGR windows

Behavior:

- require reviewed history;
- add deterministic metric formulas and results;
- commit a new revision;
- return values, periods, formulas, inputs, and missing-input details.

### 13.4 `update_financial_model_stage`

Inputs:

- `model_id`
- `expected_revision`
- `stage`: `revenue_forecast`, `operations_fcff`, or `valuation`
- scenario assumption updates
- formula updates

Behavior:

- validate assumption provenance and formulas;
- compile the dependency graph;
- calculate the affected scenario outputs;
- reject blocking validation errors without mutation;
- commit a new revision on success.

### 13.5 `get_financial_model`

Inputs:

- `model_id`
- optional revision
- optional scenario
- optional section: `summary`, `history`, `metrics`, `revenue`, `operations`, `dcf`, or `audit`
- optional detailed-cell flag

Behavior:

- authorize by owner;
- return the requested revision and section;
- include compact lineage by default and full lineage only when requested.

### 13.6 `list_financial_models`

Inputs:

- optional symbol
- optional status, from the lifecycle values in §5.3
- optional result limit, default 20, maximum 100
- optional cursor for pagination

Behavior:

- list models owned by the current Agent identity, newest update first;
- exclude `archived` models unless that status is explicitly requested;
- return model ID, symbol, status, current revision, forecast range, update timestamp, and the next cursor when more results exist.

### 13.7 `archive_financial_model`

Inputs:

- `model_id`
- `expected_revision`

Behavior:

- set lifecycle status to `archived`;
- retain every revision, because archival is a visibility change and must not break the lineage that already-issued analyses point at;
- hide the model from default listings.

There is no hard-delete tool. A model that a report cites must remain resolvable.

## 14. Orchestra Integration

### 14.1 New subagent

Add `financial_modeling` to the Agent type system, event-source validation, subagent registry, dispatcher, and prompts.

Responsibilities:

- review structured historical facts;
- request deterministic historical metrics;
- translate research evidence into explicit assumptions;
- define restricted formulas;
- build and compare model scenarios;
- return only platform-calculated numerical outputs.

It must not perform web research when `market_research` should supply the evidence, and it must not recompute platform results in prose.

### 14.2 Tool-step budget

Make the subagent tool-step limit configurable per subagent.

- Keep the existing limit of 5 for current subagents (`MAX_TOOL_STEPS` in `src/framework/subagent.ts`).
- Set `financial_modeling` to 12. The happy path alone is eight steps — create, review, metrics, revenue, operations, valuation, inspect, finish — so a budget of 8 leaves no room for a single `revision_conflict`, provenance rejection, or missing-input retry, any one of which would strand the Agent mid-model.

A larger budget is a cushion, not a solution, because a sufficiently contested model will exhaust any fixed limit. The actual guarantee comes from persistence:

**On budget exhaustion the subagent must return `model_id`, the current revision, and the current lifecycle stage instead of a failure.** The model is durable, so the orchestrator can dispatch a continuation task that resumes exactly where the previous one stopped. Running out of steps is a pause, never a lost model.

### 14.3 Tool pool

Add `FINANCIAL_MODELING_TOOLS` containing only the seven financial-model tools. Do not expose trading operations or unrestricted arbitrary execution.

### 14.4 Stock-analysis skill

Update the English `stock-analysis` skill to:

- include `financial_modeling` in its Agent list;
- allow the seven model tools;
- send filings, news, guidance, macro, and assumption sourcing to `market_research`;
- send historical metrics, forecasts, formulas, FCFF, and DCF to `financial_modeling`;
- require base, upside, and downside assumptions for a full valuation exercise;
- prohibit price targets when a reviewed and successfully calculated valuation is unavailable;
- quote only values returned by the platform.

Keep the main skill concise. Put the detailed workflow and formula guidance in a new `financial-modeling-playbook.md` reference and load it only for modeling or valuation requests.

## 15. Error Handling

Return structured errors for at least:

| Code | Meaning |
| --- | --- |
| `financial_model_not_found` | The model does not exist or is not visible to the current owner. |
| `revision_conflict` | `expected_revision` is stale. |
| `unsupported_model_type` | The entity requires a specialized model, or is an IFRS filer excluded by §3.2. |
| `history_review_required` | Forecasting was requested before historical review completed. |
| `xbrl_runtime_unavailable` | The Arelle runtime is missing or cannot start. |
| `xbrl_parse_failed` | The filing could not be parsed. |
| `xbrl_timeout` | Extraction exceeded the bounded runtime. |
| `unresolved_reconciliation` | Segment and consolidated facts do not reconcile. |
| `incompatible_periods` | A calculation mixes incompatible fiscal contexts. |
| `incompatible_units` | A formula combines incompatible units or currencies. |
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
- dependency ordering
- lagged period references
- YoY and CAGR calculations
- hierarchical sums
- scenario isolation
- circular dependencies
- missing references
- division by zero
- unit and currency errors
- deterministic quantized output under a fixed evaluation order
- expression complexity limits

### 16.2 Historical metrics

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
- equity-bridge adjustments
- per-share value
- both sensitivity matrices
- no automatic valuation blending

Two cases anchor the whole engine and must exist before any other DCF test:

1. **Golden end-to-end valuation.** One fixture company with hand-computed intermediate values, checked cell by cell from reviewed revenue through FCFF, terminal value, enterprise value, the equity bridge, and implied value per share. Hand-computed, not snapshot-recorded: a snapshot only proves the engine still does what it did, never that it does the right thing.
2. **Determinism.** The same inputs calculated twice produce byte-identical stored values and an identical canonical input hash, including through the float64 boundary in §8.5.

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

### 16.5 Persistence and access

- reopen SQLite and restore models
- immutable revision history
- stale revision conflicts, including that the conflict response carries the current revision
- transaction rollback after validation failure
- owner scoping of list and read
- cross-Topic discovery for the same Agent identity
- input-hash and engine-version persistence
- archived models excluded from default listings while their revisions stay resolvable

### 16.6 Tools, Orchestra, and skill

- tool registration and JSON schemas
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
2. The Agent can review segment mappings and commit only reconciled or explicitly corrected history.
3. The platform calculates historical growth and financial metrics without language-model arithmetic.
4. The Agent can submit sourced base, upside, and downside assumptions in logical stages.
5. The platform recalculates all dependent revenue, operating, FCFF, and valuation rows after every successful stage.
6. Both Gordon-growth and exit-multiple DCF outputs are available separately with sensitivity matrices.
7. Every displayed result can be traced to source facts, assumptions, formulas, and a model revision.
8. Missing or incompatible data produces structured limitations instead of fabricated values.
9. Models remain accessible across Topics owned by the same Agent identity and are not listed or readable under a different `owner_agent_id`. This is namespacing, not confidentiality (§5.2).
10. Orchestra invokes the dedicated modeling subagent for deterministic financial modeling requests.
11. Every number in a `financial_modeling` final report appears in that task's tool outputs. This replaces the untestable phrasing "no LLM-only number is presented as a platform result": the mechanical check is that reported figures are traceable to a tool response, and the residual judgment call stays a review-time criterion rather than pretending to be an automated one.
12. All added or modified skill, prompt, and tool content is in English.

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
4. `src/framework/subagent.ts` — per-subagent tool-step limit replacing the module-level `MAX_TOOL_STEPS`.
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

The seven MCP tools, `agentId` propagation, the `financial_modeling` subagent and its six framework touch points, the tool-step budget, and the resumption contract.

Done when an Agent can run create → review → metrics → revenue → operations → valuation end to end, with owner scoping and `revision_conflict` under test. **This is the first phase that produces a usable product**; everything after it is enhancement.

### Phase 3: DCF skill

`stock-analysis` integration plus the `financial-modeling-playbook.md` reference: scenario requirements, the prohibition on price targets without a calculated valuation, and the rule that only platform values may be quoted.

Done when skill routing tests and the English-content verification script pass.

### Phase 4: Filing-level XBRL extraction

The Arelle adapter, filing-level extraction, candidate mapping, and reconciliation, plugged into the review pipeline that phases 1 and 2 have already stabilized.

Done when the §16.4 fixture cases pass and the system verifiably degrades to Company-Facts-only when the adapter is absent.

**Why extraction is last.** It is the only component that can be omitted entirely: a consolidated-revenue DCF is a complete valuation, and segment decomposition improves precision rather than enabling the result. It also carries the project's only new language runtime, with taxonomy caching, multi-second parses, and a distinct class of operational failures — the three dedicated error codes in §15 are the evidence. Two further reasons are structural: the extracted-fact contract in §6.2 is easier to get right once the review-and-commit pipeline that consumes it exists, and §6.1 already requires graceful degradation, which building extraction last enforces by construction instead of by a retrofitted fallback branch.
