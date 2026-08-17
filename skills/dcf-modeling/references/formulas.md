# DCF formula toolbox

Expression recipes, organized by the analysis move they serve. Adapt every row id to the model at hand: check the workbook catalog first, and prefix library rows with `unified.`. Section §0 is the language contract — everything in it is verified against the engine.

**This file describes expressions, never call shapes.** Which fields an operation takes, what they are named and which are required is stated once, in the tool's own schema, and that is the only place it is correct. A recipe below reads `row | range | expression` — three pieces of information, not a payload to copy. Assembling them into an operation is the schema's business.

That separation exists because it was broken: this file used to write recipes as `set_formula <row> <range>: <expression>`, which reads like a call and is not one. An agent translated the notation literally, sent `{kind, lineItemId, appliesTo, formula: "<expression>"}`, and had the batch rejected — twice, on the last two steps of its budget — because the schema takes a nested `formula` object whose expression field is `source` and whose `periodIds` is required. It ran out of steps with the correct forecast in hand and never wrote it. The run before it, which had not read this file, got the shape right.

## §0 The formula language, exactly

**Syntax**: `+ - * /`, parentheses, unary minus, numeric literals, row ids. Caps: 2000 chars, 400 nodes, depth 32 — far beyond any honest line.

**Functions** (verified semantics):

| function | arity | semantics |
| --- | --- | --- |
| `LAG(row, n)` | n = integer literal | value of `row` n periods back; before the grid starts → null |
| `YOY(row)` | — | `row / prior − 1`, unit percent; prior null → null, prior 0 → divide_by_zero |
| `CAGR(row, n)` | n = integer literal | `(row / row₋ₙ)^(1/n) − 1`, unit percent; base ≤ 0 → null |
| `SUM(row, from, to)` | offsets = integer literals | sum of `row` over the window relative to the current period: `SUM(x, -2, 0)` = trailing 3 periods incl. current; window running off the grid → null |
| `AVERAGE(row, from, to)` | same | windowed mean; useful for two-point average-balance return metrics |
| `MIN(a, b, …)` / `MAX(a, b, …)` | variadic expressions | units must be compatible |
| `ABS(x)` | expression | keeps x's unit |
| `POW(base, exp)` | expressions | base must be dimensionless; result ratio |
| `YEAR_INDEX()` | — | forecast periods only: 1, 2, 3… counted after the valuation anchor (mid-year convention adds 0.5); null in historical periods. The key to fades — see §3 |

**The one trap**: the time functions (`LAG`, `YOY`, `CAGR`, `SUM`, `AVERAGE`) take a **row id, not an expression**. `YOY(a / b)` is illegal. Build the expression as its own row first, then window that row — batch rows may reference each other in any order, so this costs one extra line:

```json
{"rows":[
  {"id": "core_margin",        "formula": "(operating_income - other_income_expense_net) / revenue.total"},
  {"id": "core_margin_drift",  "formula": "core_margin - LAG(core_margin, 1)"}
]}
```

**Units** are inferred from the formula — omit `unit`. What the algebra accepts: same-currency `±`; `currency / currency → ratio`; `currency / shares → per_share`; `currency * ratio → currency`; `shares / shares → ratio`; percent and ratio interchange freely in rate math (`rate ± rate → ratio`). Currency×currency and cross-currency math are refused with a message naming both units.

**`number` is transparent under `*` and `/`, but NOT under `+` and `-`.** `number * ratio → ratio` and `ratio / number → ratio`, so scaling is free. Addition is strict: the operands must be the same unit or both rates, and the only literals that cross that line are `0` (against anything) and `1` (against a rate, so `1 + rate` is legal). A bare number added to a ratio is refused. This is the trap that costs a batch:

| expression | units | verdict |
| --- | --- | --- |
| `a + (t - a) * YEAR_INDEX() / N` | YEAR_INDEX is a **number**, so the whole expression is number | legal |
| `g_t + (g_0 - g_t) * POW(0.7, YEAR_INDEX())` | POW always returns **ratio**, `g_t` is a bare number | **refused** — `cannot apply '+' to number and ratio` |
| `g_0 * POW(0.7, YEAR_INDEX())` | number × ratio | legal, but decays toward 0, not toward `g_t` |
| `<rate row> + (g_0 - <rate row>) * POW(0.7, YEAR_INDEX())` | rate ± ratio | legal — the target lives in a rate-typed row |

To decay toward a non-zero target, the target has to be a rate-typed row you reference, not a literal you type. A number-valued result is still assignable to a ratio row, so the linear fade needs no such workaround.

**Nulls are never zero.** Any null input nulls the result and `missing_input` names the originating row; division by zero flags `divide_by_zero`. A row computing null in every period gets called out in the tool response with its missing inputs — read that instead of guessing.

## §0.5 Derived rows are authored, never prefilled

The model begins with facts only. Historical and forecast derived rows are your formulas, written only when they serve the valuation you are building. Before relying on any shorthand, verify that its definition fits this issuer and record the formula in the workbook rather than doing arithmetic in prose.

For a conventional FCFF valuation, write the historical anchors explicitly after the spine commit:

```text
tax_rate                  = income_tax_expense / pretax_income
ebitda                    = operating_income + depreciation_amortization
nopat                     = operating_income * (1 - tax_rate)
operating_working_capital = accounts_receivable + inventory - accounts_payable
change_nwc                = operating_working_capital - LAG(operating_working_capital, 1)
fcff                      = nopat + depreciation_amortization - capital_expenditures - change_nwc
```

Adjust the working-capital composition to the issuer's mapped facts; do not add a component merely because a generic template names it. Formula rows such as margin, growth, returns, per-share measures, and custom metrics are also authored as needed. The WACC table's relationship rows remain locked, but its filing-derived inputs read the final workbook cells: write the calculation on the canonical skeleton item (for example `debt` or `lease_liabilities`) rather than recreating it in prose or bypassing it with a hard-coded WACC value.

## §1 Decompose profit sources (Move 1)

Mix and structure — who contributes what, and how it is shifting:

| purpose | formula |
| --- | --- |
| source share of revenue | `revenue.energygenerationandstorage / revenue.total` |
| share within a parent stream | `revenue.automotiverevenues.automotiveleasing / revenue.automotiverevenues` |
| unpromoted axis, via the library | `unified.total_revenues.statementbusinesssegments.automotivesegment / revenue.total` |
| one-off / non-operating share | `revenue.automotiverevenues.automotiveregulatorycredits / revenue.total` |
| recurring base, one-offs stripped | `revenue.total - revenue.automotiverevenues.automotiveregulatorycredits` |
| margin on the recurring base | build the base row above, then `operating_income / recurring_base` |
| **contribution to growth** — how much of total growth each source supplied | `(revenue.energygenerationandstorage - LAG(revenue.energygenerationandstorage, 1)) / LAG(revenue.total, 1)` |
| intensity rows the registry lacks | `research_and_development / revenue.total`, `general_and_administrative / revenue.total`, `share_based_compensation / revenue.total` |

Contribution-to-growth rows across all sources are the fastest honest picture of where growth actually comes from — they sum to `growth.revenue.total`, so they also self-check.

## §2 Characterize each source's history (anchors for Move 2)

| purpose | formula |
| --- | --- |
| per-source growth | `YOY(revenue.energygenerationandstorage)` |
| compound anchor | `CAGR(revenue.total, 4)` |
| smoothed anchor for a noisy ratio | first make the ratio a row, then `AVERAGE(that_row, -2, 0)` |
| trailing-sum base (bumpy flows) | `SUM(capital_expenditures, -2, 0) / SUM(revenue.total, -2, 0)` |
| growth spread between sources | `YOY(revenue.energygenerationandstorage) - YOY(revenue.automotiverevenues)` |
| margin drift per year | `margin.operating - LAG(margin.operating, 1)` |
| operating leverage | `YOY(operating_income) / YOY(revenue.total)` |
| capex vs depreciation cycle | `capital_expenditures / depreciation_amortization` |
| FCF conversion of operating income | `(operating_income - capital_expenditures + depreciation_amortization) / operating_income` |
| reinvestment rate | `(capital_expenditures - depreciation_amortization + change_nwc) / nopat` |
| receivable / inventory / payable days | `accounts_receivable / revenue.total * 365`, `inventory / cost_of_revenue * 365`, `accounts_payable / cost_of_revenue * 365` |
| cash conversion cycle | build the three days rows, then `dso + dio - dpo` |
| growth vs reinvestment cross-check | write `roic = nopat / AVERAGE(invested_capital, -1, 0)`; then `roic × reinvestment` ≈ sustainable growth — a claim of faster growth without reinvestment must say where it comes from |

A ratio trending one direction for five years is an anchor AND a question: Move 2 must say whether the trend continues, stops, or reverses — and why.

## §3 Translate judgments into the chain (Move 3)

Patterns for the formula and assumption operations. The skeleton is inert: writing a formula or assumption is itself what declares that range formula- or assumption-sourced after the batch recalculates. Clearing or replacing existing coverage is its own operation, issued in the same batch as its replacement.

`add_line_item` creates your own rows under one of: revenue, cost_of_revenue, operating_expenses, total_current_assets, total_current_liabilities, operating_working_capital, or custom_metrics — a driver you invent lives there.

The six conventional driver rows (growth.revenue.total, margin.operating, tax_rate, ratio.da_to_revenue, ratio.capex_to_revenue, ratio.operating_nwc_to_revenue) are available but unconfigured. Author their historical anchor formulas and any forecast assumptions you use; if a driver does not fit the issuer, do not write it and instead author formulas at the level where the story lives.

**Segment-driven revenue** (sources with different stories):

```text
row                       range       expression
growth.revenue.<stream>   historical  YOY(revenue.<stream>)
growth.revenue.<stream>   forecast    one assumption per stream; rationale = the Move-2 sentence
revenue.<stream>          forecast    LAG(revenue.<stream>, 1) * (1 + growth.revenue.<stream>)
revenue.total             forecast    revenue.<stream_a> + revenue.<stream_b> + revenue.<stream_c>
```

A two-level tree forecasts at the level where the story lives: give the leaves growth assumptions and make the parent stream their sum (same pattern, one level down) — or drive the parent and leave the leaves informational.

**Segment economics — required companion to segment revenue**:

If forecast revenue is split into material segments, first look for segment cost-of-revenue, gross-profit, margin, or management disclosure that supports a distinct economic view. Do not silently collapse different segment economics into a single consolidated operating-margin assumption. Build the bridge at the most evidenced level:

```text
row                        range       expression
gross_margin.<segment>     historical  gross_profit.<segment> / revenue.<segment>
gross_margin.<segment>     forecast    an assumption, with the segment-specific causal rationale
gross_profit.<segment>     forecast    revenue.<segment> * gross_margin.<segment>
gross_profit               forecast    gross_profit.<segment_a> + gross_profit.<segment_b> + ...
operating_income           forecast    gross_profit - operating_expenses

attributable operating-expense rows are forecast per segment where disclosed;
shared expenses are forecast separately as their own pool.
```

If the statements provide segment revenue but only consolidated costs, do **not** manufacture an allocation merely to fill the rows. Use a consolidated gross-margin or operating-margin chain only after recording: (a) the missing disclosure, (b) why a cost allocation would be unsupported, and (c) the historical and company-specific evidence behind the consolidated driver. The same discipline applies to shared R&D, corporate and platform costs: model them as a named shared pool unless the company discloses a defensible allocation.

**Cost structure at the story's level**:

```text
gross-margin story
  metric.custom.gm_fcst    historical  the anchor row you compute for the purpose
  metric.custom.gm_fcst    forecast    an assumption — the margin path you defend
  gross_profit             forecast    revenue.total * metric.custom.gm_fcst
  operating_income         forecast    gross_profit - operating_expenses
  (a range that already carries coverage is re-sourced in the same batch that rewrites it)

single-margin story
  margin.operating         historical  operating_income / revenue.total
  margin.operating         forecast    an assumption
  operating_income         forecast    revenue.total * margin.operating
```

**Fades — the honest middle between "changes" and "persists"** (YEAR_INDEX is forecast-only, so these formulas belong on forecast ranges only):

```text
linear margin fade from anchor a to target t over N years
  <margin row>   forecast   a + (t - a) * YEAR_INDEX() / N
growth decay toward terminal g_t from starting g_0
  <growth row>   forecast   <g_t rate row> + (g_0 - <g_t rate row>) * POW(0.7, YEAR_INDEX())
capex fading to depreciation parity (steady state)
  ratio.capex_to_revenue   forecast   a fade whose endpoint ≈ ratio.da_to_revenue's anchor
```

The decay form references a rate-typed row for its terminal value rather than a literal, because POW
returns a ratio and a bare number cannot be added to one — see §0. The linear form is all numbers and
needs no such row.

**Working capital**: author `operating_working_capital` from the operating components you mapped, then author `change_nwc` from it. The lever can be `ratio.operating_nwc_to_revenue` (assumption), or component-level stories via the days rows you built in §2, translated back into that ratio's path.

**Retiring a fixed driver**: never redefine it — rewrite the amount row so nothing references it (`operating_income = gross_profit - operating_expenses` makes `margin.operating` a spectator). It stays visible as the historical anchor it is.

## §4 Self-consistency (Move 4)

Put the forecast on trial against your own Move-2 sentences — each check is one calculate row after the chain closes:

| question | formula |
| --- | --- |
| implied FCF growth path vs history | `YOY(fcff)` over forecast periods — a jump with no named cause is a lie somewhere |
| does margin drift contradict a "persists" claim | rebuild `margin drift` (§2) over the forecast range |
| terminal-year reinvestment sanity | `capital_expenditures / depreciation_amortization` in the final year — steady state sits near 1 |
| terminal continuity | final-year `YOY(fcff)` should approach terminal_growth, not cliff into it |
| growth funded by what | reinvestment rate (§2) over forecast years vs your explicit ROIC row — growth ≈ ROIC × reinvestment, and a forecast violating it needs an explicit story (mix shift, pricing power) |
| exit multiple vs explicit years | compare valuationConfig's exit multiple with the final-year `ebitda`-implied value; a gap is a claim about what changes after the horizon — defend or shrink it |

Hard ceiling: terminal growth may not exceed long-run nominal GDP growth — nothing outgrows the economy forever. Everything else is principle, not number: every departure from an anchor names its cause; every "unchanged" names why it holds.
