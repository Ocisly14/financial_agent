# Stage 6 — Terminal value, sensitivities, and the verdict

The engine needs four things to value: fcff in every forecast period (stage 4), the wacc row (stage 5), and your `terminal_growth` and `exit_multiple` assumptions. Everything else — discounting, the equity bridge (cash available, non-operating investments, debt, leases, preferred, NCI, diluted shares), per-share value, sensitivities — is engine arithmetic you read, never redo.

## Terminal assumptions — the ultimate "unchanged" claim

The terminal value asserts the company has reached steady state forever. Treat it with the same change/persist discipline as any Move-2 judgment:

- **terminal_growth**: hard ceiling — long-run nominal GDP growth; nothing outgrows the economy forever. Below that, justify the number from your final-year trajectory: the explicit years should glide into it, not cliff (check `YOY(fcff)` in the last forecast years).
- **exit_multiple**: cross-check against what your own explicit years imply (final-year ebitda vs the terminal value your growth assumption produces) rather than importing a market comp. A large gap between the two methods is a claim about what changes after the horizon — defend it or shrink it.
- Set both with set_assumption (they are dcf-section assumption rows), each with rationale.

## valuationConfig — set_valuation_config when the defaults do not fit

`{ anchorPeriodId, discountConvention: "year_end" | "mid_year", exitTerminalMetric: "ebitda" | "fcff", sensitivity: { waccDeltas, terminalGrowthDeltas, exitMultipleDeltas }, sourceType, sourceRefs, asOfDate, rationale }` — the anchor is the period discounting counts from (defaults to the last actual); mid_year shifts discount periods by half a year (and YEAR_INDEX returns +0.5 offsets to match). Sensitivity deltas are offsets around your central assumptions — keep them honest (e.g. ±1% wacc, ±0.5% terminal growth), not decorative.

## Reading the result

The lifecycle stage is a reading the engine derives after every mutation, never something you advance: committed history reads as history_committed, forecast revenue.total cells as revenue_forecast, a closed forecast fcff chain as operations_fcff, and the moment the wacc row and your terminal assumptions exist the valuation computes and the model reads as valued. If the stage is lower than you expect, some input is missing — read the workbook (a null fcff cell names its broken input; the WACC sheet names its missing rows) and fill the named thing.

The equity bridge demands a numeric value at the anchor for every bridge row (cash available, non-operating investments, debt, leases, preferred, NCI). A row the issuer simply lacks must be handled explicitly, not left null: construct it from mapped rows where honest (`set_formula` historical: `cash_available_for_bridge = cash_and_equivalents + short_term_investments`) and zero the truly absent ones (`set_line_item_source` historical → formula, then `set_formula` source `0`, rationale saying the issuer reports none). `incomplete_equity_bridge` names exactly which row is missing.

The valuation output carries: enterprise value, the terminal value and its share of EV (a terminal share above ~80% means your explicit years barely matter — say so), the equity bridge line by line, per-share value against diluted shares, and the sensitivity grid over your deltas.

## The trial before the verdict

Put the forecast on trial against your own Move-2 sentences (toolbox §4 has the formula for each):

- implied FCF growth path vs history — a jump with no named cause is a lie somewhere;
- margin drift over the forecast vs every "persists" claim;
- terminal-year reinvestment (capex/D&A ≈ 1 in steady state) and growth-vs-ROIC×reinvestment consistency;
- final-year fcff growth vs terminal_growth continuity.

## The verdict

Report: intrinsic value and per-share value; the market context if you have it; the terminal share of EV; the **three load-bearing assumptions** with their Move-2 rationales (read the sensitivity grid to find which axis moves the answer most — that is what the valuation is really exposed to); the model_id and revision. A DCF without its assumptions is not a result — the number is the least interesting line of the report.
