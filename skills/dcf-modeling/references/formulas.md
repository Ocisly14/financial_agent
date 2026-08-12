# DCF formula toolbox

Recipes for calculate_model_rows and set_formula, organized by the analysis move they serve. Adapt every row id to the model at hand: check the workbook catalog first, and prefix library rows with `unified.`. Section §0 is the language contract — everything in it is verified against the engine.

## §0 The formula language, exactly

**Syntax**: `+ - * /`, parentheses, unary minus, numeric literals, row ids. Caps: 2000 chars, 400 nodes, depth 32 — far beyond any honest line.

**Functions** (verified semantics):

| function | arity | semantics |
| --- | --- | --- |
| `LAG(row, n)` | n = integer literal | value of `row` n periods back; before the grid starts → null |
| `YOY(row)` | — | `row / prior − 1`, unit percent; prior null → null, prior 0 → divide_by_zero |
| `CAGR(row, n)` | n = integer literal | `(row / row₋ₙ)^(1/n) − 1`, unit percent; base ≤ 0 → null |
| `SUM(row, from, to)` | offsets = integer literals | sum of `row` over the window relative to the current period: `SUM(x, -2, 0)` = trailing 3 periods incl. current; window running off the grid → null |
| `AVERAGE(row, from, to)` | same | windowed mean; `AVERAGE(x, -1, 0)` is the two-point average balance the preset ROA/ROE/ROIC use |
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

**Units** are inferred from the formula — omit `unit`. What the algebra accepts: same-currency `±`; `currency / currency → ratio`; `currency / shares → per_share`; `currency * ratio → currency`; `shares / shares → ratio`; percent and ratio interchange freely in rate math (`rate ± rate → ratio`, `1 + rate` is legal); `number` is transparent. Currency×currency and cross-currency math are refused with a message naming both units.

**Nulls are never zero.** Any null input nulls the result and `missing_input` names the originating row; division by zero flags `divide_by_zero`. A row computing null in every period gets called out in the tool response with its missing inputs — read that instead of guessing.

## §0.5 Preset rows — reference points, not truth

The model carries computed, read-only anchor rows. Treat every preset as **someone else's first draft of the measurement**: before leaning on one, check from first principles that its definition measures what YOUR analysis needs for THIS issuer. A correct preset needs nothing — reference it (`metric.*` ids work inside formulas like any row). A wrong or insufficient one is never edited (they are read-only by design) — you **supersede** it with your own calculate_model_rows row whose description says what the preset missed.

Definitions genuinely differ where it matters. Real examples: `metric.net_debt` subtracts cash AND short_term_investments, while the WACC sheet's `net_debt` subtracts cash only — same name, different scope, both defensible, and only you know which your ratio needs. `metric.free_cash_flow` is CFO − capex, which quietly treats stock-based compensation as free — an owner-earnings view needs your own row. `margin.operating` includes lines a "core margin" analysis might strip.

Fixed drivers (historical side auto-derived, forecast side takes your set_assumption):

```text
growth.revenue.total = YOY(revenue.total)          ratio.da_to_revenue   = depreciation_amortization / revenue.total
margin.operating     = operating_income / revenue.total   ratio.capex_to_revenue = capital_expenditures / revenue.total
tax_rate             = income_tax_expense / pretax_income ratio.operating_nwc_to_revenue = operating_working_capital / revenue.total
```

Metrics registry (read-only, historical):

```text
metric.gross_margin   metric.ebitda_margin   metric.net_margin   metric.ocf_margin   metric.fcf_margin
metric.free_cash_flow = operating_cash_flow - capital_expenditures
metric.ocf_conversion = operating_cash_flow / net_income
metric.operating_income_yoy  metric.net_income_yoy  metric.diluted_eps_yoy  metric.ocf_yoy  metric.fcf_yoy
metric.current_ratio  metric.debt_to_equity
metric.net_debt = debt - cash_and_equivalents - short_term_investments
metric.invested_capital = debt + shareholders_equity - cash_and_equivalents - short_term_investments
metric.roa / metric.roe / metric.roic   (two-point average balances via AVERAGE(x, -1, 0))
metric.net_income_per_share  metric.ocf_per_share  metric.fcf_per_share
metric.revenue_cagr_3p  metric.revenue_cagr_5p
```

calculate_model_rows is for what is NOT here: everything issuer-specific — segment structure, one-off isolation, days metrics, and any driver you invent. Also on the sheet already: the WACC table (beta, rates, weights) — never recompute those in a formula row.

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
| per-source growth | `YOY(revenue.energygenerationandstorage)` (streams also carry auto `growth.revenue.<id>` rows) |
| compound anchor | `CAGR(revenue.total, 4)` — or read `metric.revenue_cagr_3p/5p` |
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
| growth vs reinvestment cross-check | `metric.roic` × the reinvestment row ≈ sustainable growth — a claim of faster growth without reinvestment must say where it comes from |

A ratio trending one direction for five years is an anchor AND a question: Move 2 must say whether the trend continues, stops, or reverses — and why.

## §3 Translate judgments into the chain (Move 3)

set_formula / set_assumption patterns via apply_financial_model_operations. The skeleton is inert: writing a formula or assumption is itself what declares that range formula- or assumption-sourced after the batch recalculates. Use set_line_item_source only when clearing or replacing existing coverage, in the same batch as its replacement.

`add_line_item` creates your own rows under one of: revenue, cost_of_revenue, operating_expenses, total_current_assets, total_current_liabilities, operating_working_capital, or custom_metrics — a driver you invent lives there.

The six conventional driver rows (growth.revenue.total, margin.operating, tax_rate, ratio.da_to_revenue, ratio.capex_to_revenue, ratio.operating_nwc_to_revenue) are available but unconfigured. Author their historical anchor formulas and any forecast assumptions you use; if a driver does not fit the issuer, do not write it and instead author formulas at the level where the story lives.

**Segment-driven revenue** (sources with different stories):

```text
1. set_formula growth.revenue.<stream> historical: YOY(revenue.<stream>)
2. set_assumption growth.revenue.<stream> per stream, rationale = the Move-2 sentence
3. set_formula revenue.<stream> forecast: LAG(revenue.<stream>, 1) * (1 + growth.revenue.<stream>)
4. set_formula revenue.total forecast:
   revenue.automotiverevenues + revenue.energygenerationandstorage + revenue.servicesandother
```

A two-level tree forecasts at the level where the story lives: give the leaves growth assumptions and make the parent stream their sum (same pattern, one level down) — or drive the parent and leave the leaves informational.

**Segment economics — required companion to segment revenue**:

If forecast revenue is split into material segments, first look for segment cost-of-revenue, gross-profit, margin, or management disclosure that supports a distinct economic view. Do not silently collapse different segment economics into a single consolidated operating-margin assumption. Build the bridge at the most evidenced level:

```text
1. set_formula gross_margin.<segment> historical: gross_profit.<segment> / revenue.<segment>
2. set_assumption gross_margin.<segment> forecast, with the segment-specific causal rationale
3. set_formula gross_profit.<segment> forecast:
   revenue.<segment> * gross_margin.<segment>
4. set_formula gross_profit forecast:
   gross_profit.<segment_a> + gross_profit.<segment_b> + ...
5. forecast attributable operating-expense rows per segment where disclosed; forecast shared expenses separately
6. set_formula operating_income forecast:
   gross_profit - operating_expenses
```

If the statements provide segment revenue but only consolidated costs, do **not** manufacture an allocation merely to fill the rows. Use a consolidated gross-margin or operating-margin chain only after recording: (a) the missing disclosure, (b) why a cost allocation would be unsupported, and (c) the historical and company-specific evidence behind the consolidated driver. The same discipline applies to shared R&D, corporate and platform costs: model them as a named shared pool unless the company discloses a defensible allocation.

**Cost structure at the story's level**:

```text
gross-margin story:   calculate_model_rows {id:"gm_fcst"}          (historical anchor row)
                      set_line_item_source metric.custom.gm_fcst forecast -> assumption
                      set_assumption      metric.custom.gm_fcst   the margin path you defend
                      set_line_item_source gross_profit forecast -> formula
                      set_formula gross_profit = revenue.total * metric.custom.gm_fcst
                      set_line_item_source operating_income forecast -> formula
                      set_formula operating_income = gross_profit - operating_expenses
single-margin story:  author margin.operating's historical formula and forecast assumption, then author operating_income = revenue.total * margin.operating
```

**Fades — the honest middle between "changes" and "persists"** (YEAR_INDEX is forecast-only, so these formulas belong on forecast ranges only):

```text
linear margin fade from anchor a to target t over N years:
  set_formula margin_row forecast:  a + (t - a) * YEAR_INDEX() / N
growth decay toward terminal g_t from starting g_0:
  set_formula growth_row forecast:  g_t + (g_0 - g_t) * POW(0.7, YEAR_INDEX())
capex fading to depreciation parity (steady state):
  drive ratio.capex_to_revenue with a fade whose endpoint ≈ ratio.da_to_revenue's anchor
```

**Working capital**: `operating_working_capital` is identity-derived from its components — do not rewrite it. The lever is `ratio.operating_nwc_to_revenue` (assumption), or component-level stories via the days rows you built in §2, translated back into that ratio's path.

**Retiring a fixed driver**: never redefine it — rewrite the amount row so nothing references it (`operating_income = gross_profit - operating_expenses` makes `margin.operating` a spectator). It stays visible as the historical anchor it is.

## §4 Self-consistency (Move 4)

Put the forecast on trial against your own Move-2 sentences — each check is one calculate row after the chain closes:

| question | formula |
| --- | --- |
| implied FCF growth path vs history | `YOY(fcff)` over forecast periods — a jump with no named cause is a lie somewhere |
| does margin drift contradict a "persists" claim | rebuild `margin drift` (§2) over the forecast range |
| terminal-year reinvestment sanity | `capital_expenditures / depreciation_amortization` in the final year — steady state sits near 1 |
| terminal continuity | final-year `YOY(fcff)` should approach terminal_growth, not cliff into it |
| growth funded by what | reinvestment rate (§2) over forecast years vs `metric.roic` — growth ≈ ROIC × reinvestment, and a forecast violating it needs an explicit story (mix shift, pricing power) |
| exit multiple vs explicit years | compare valuationConfig's exit multiple with the final-year `ebitda`-implied value; a gap is a claim about what changes after the horizon — defend or shrink it |

Hard ceiling: terminal growth may not exceed long-run nominal GDP growth — nothing outgrows the economy forever. Everything else is principle, not number: every departure from an anchor names its cause; every "unchanged" names why it holds.
