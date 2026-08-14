# Stage 6 — Terminal value, sensitivities, and the verdict

The engine needs five things to value: fcff in every forecast period (stage 4), the wacc row (stage 5), your `terminal_growth` and `exit_multiple` assumptions, and the three valuationConfig judgments. Everything else — discounting, the equity bridge (cash available, non-operating investments, debt, leases, preferred, NCI, diluted shares), per-share value, sensitivities — is engine arithmetic you read, never redo.

## Terminal assumptions — the ultimate "unchanged" claim

The terminal value asserts the company has reached steady state forever. Treat it with the same change/persist discipline as any Move-2 judgment:

- **terminal_growth**: hard ceiling — long-run nominal GDP growth; nothing outgrows the economy forever. Below that, justify the number from your final-year trajectory: the explicit years should glide into it, not cliff (check `YOY(fcff)` in the last forecast years).
- **exit_multiple**: read off a comparable set — the section below is how. The engine computes both methods side by side, so also read your multiple against what your own growth assumption implies (the terminal value it produces, over final-year ebitda). A large gap between the two is a claim about what changes after the horizon — make it deliberately, or shrink it.
- **method coherence**: perpetuity growth and the exit multiple must describe compatible terminal economics. If they produce materially different enterprise or per-share values, identify the long-run growth, return, margin, or multiple claim causing the divergence. Keep them as separately labelled scenarios; never average them or alter an input merely to make either result match the market price.
- **company before convention**: GDP ceilings, peer multiples and market norms only test the terminal case. The central terminal claim comes from the issuer's own final-year mix, competitive position, reinvestment needs, margins and durable strategy after the explicit forecast; explain why those economics can or cannot persist.
- Set both with set_assumption (they are dcf-section assumption rows), each with rationale.

## exit_multiple — read it off comparables, not off this issuer

The multiple is the one terminal input with an observable market answer, so neither invent it nor derive it from the issuer's own current trading level: today's price embeds today's growth, which is exactly what the terminal year no longer has. "Below where this company trades now" is not a rationale — it anchors on the wrong company. Build a peer set and read the multiple off that.

What makes a peer, in order of weight:

- **Revenue composition** — the mix of business lines, because mix is what sets margin and growth. A hardware-plus-services issuer is not comparable to a pure-hardware one, however well the headline industry matches.
- **Scale** — comparable revenue and EBITDA magnitude. Multiples compress with size; a small fast-growing peer prices differently from a mega-cap in the same business.
- Industry alone is not a peer test. Same sector, different mix, different size — not a comp.

Pick the peer set for the company **at the end of your forecast**, not the company today. If your own forecast shifts the mix — a higher-margin segment growing from a quarter of revenue to a third — then the terminal company resembles a different peer set than the current one. Name which, and why.

financial_search is the right tool here: peer multiples are exactly the case the data hierarchy reserves the web for, a market datum the stores cannot hold and the engine cannot compute. Set the assumption with sourceType `search` or `market`, sourceRefs pointing at what you actually read, and a rationale that names the peers and states the composition-and-scale grounds on which they stand in for this issuer.

## valuationConfig — three judgments the model will not make for you

`{ anchorPeriodId, discountConvention: "year_end" | "mid_year", exitTerminalMetric: "ebitda" | "fcff", sensitivity: { waccDeltas, terminalGrowthDeltas, exitMultipleDeltas }, sourceType, sourceRefs, asOfDate, rationale }`

A new model starts with `discountConvention`, `exitTerminalMetric`, and `sensitivity` all null, and **the valuation does not compute until you set all three with set_valuation_config**. The engine has no basis to choose them, and seeding a default would hand back a decision nobody took. Only `anchorPeriodId` is derived for you — the last actual period, which discounting counts from.

What each one costs you: mid_year shifts discount periods by half a year (and YEAR_INDEX returns +0.5 offsets to match), which raises every present value against year_end. exitTerminalMetric names the row your multiple multiplies, so it must match the multiple you sourced — an EV/EBITDA comp requires `ebitda`. Sensitivity deltas are offsets around your central assumptions — keep them honest (e.g. ±1% wacc, ±0.5% terminal growth), not decorative.

## Reading the result

The lifecycle stage is a reading the engine derives after every mutation, never something you advance: committed history reads as history_committed, forecast revenue.total cells as revenue_forecast, a closed forecast fcff chain as operations_fcff, and the moment the wacc row, your terminal assumptions, and the three valuationConfig judgments all exist the valuation computes and the model reads as valued. If the stage is lower than you expect, some input is missing — read the workbook (a null fcff cell names its broken input; the WACC sheet names its missing rows; a null in valuationConfig names the judgment still owed) and fill the named thing.

The equity bridge demands a numeric value at the anchor for every bridge row (cash available, non-operating investments, debt, leases, preferred, NCI). A row the issuer simply lacks must be handled explicitly, not left null: construct it from mapped rows where honest (`set_formula` historical: `cash_available_for_bridge = cash_and_equivalents + short_term_investments`) and zero only a genuinely absent obligation (`set_formula` source `0`, rationale citing that absence). The host derives the formula source from the write. `incomplete_equity_bridge` names exactly which row is missing.

**Lease treatment is a classification decision.** Read the filing's lease note before writing `lease_liabilities`. If operating lease expense remains in operating costs and the FCFF chain has not been normalized to add it back, subtracting the operating-lease liability in the bridge would double count it. Finance-lease debt, however, must be included in debt or the lease bridge row unless it is already included in the committed debt amount. Record which treatment applies and why; never use zero merely because the face balance sheet aggregates lease liabilities into another caption.

The valuation output carries: enterprise value, the terminal value and its share of EV (a terminal share above ~80% means your explicit years barely matter — say so), the equity bridge line by line, per-share value against diluted shares, and the sensitivity grid over your deltas.

## Failure modes in the terminal and the bridge

Each of these produces a valuation the engine computes without complaint:

- **Terminal inputs defensible one by one, incoherent together.** Perpetual growth has to be funded: it needs reinvestment, and reinvestment at the terminal return is what the steady state can afford. A terminal_growth argued from GDP, a margin argued from the final forecast year and a capex ratio argued from the current build cycle can each hold up alone while jointly describing a company that grows forever on someone else's capital. Read the three together as one claim about steady-state economics.
- **A terminal year that is still a growth year.** The last explicit period often carries the whole forecast's momentum — margin at its peak, capex still elevated or still suppressed, working capital still moving. Terminal value capitalizes that year into perpetuity. Ask whether the year you are capitalizing is the steady state you mean, and if it is not, say which of its features the terminal case drops.
- **A bridge assembled from convenient values.** Every bridge row should stand at the same anchor period, and "cash" should mean cash this equity can actually claim — not balances committed to buybacks already announced, held against near-term maturities, or trapped where repatriation costs something. A bridge row taken from a different period, or read as a face balance without checking what the caption aggregates, moves per-share value silently because nothing downstream recomputes it.
- **A grid that cannot move.** Sensitivity deltas narrow enough to leave every cell on the same side of the reader's decision confirm the central case instead of testing it. Choose deltas wide enough that the grid could have changed your mind, then report what it actually did.

## The trial before the verdict

Put the forecast on trial against your own Move-2 sentences (toolbox §4 has the formula for each):

- implied FCF growth path vs history — a jump with no named cause is a lie somewhere;
- margin drift over the forecast vs every "persists" claim;
- terminal-year reinvestment (capex/D&A ≈ 1 in steady state) and growth-vs-ROIC×reinvestment consistency;
- final-year fcff growth vs terminal_growth continuity.
- perpetuity-growth versus exit-multiple result: a material gap is an explicit scenario distinction, not noise to average away;
- implied per-share value versus the anchor-date market price already present in the WACC sheet: investigate a material difference through forecast, WACC, terminal and bridge inputs, but do not reverse-engineer assumptions to close it.

## The verdict

Report: intrinsic value and per-share value; the market context if you have it; the terminal share of EV; whether the two terminal methods are coherent or deliberately separate; the **three load-bearing assumptions** with their Move-2 rationales (read the sensitivity grid to find which axis moves the answer most — that is what the valuation is really exposed to); the model_id and revision. A DCF without its assumptions is not a result — the number is the least interesting line of the report.
