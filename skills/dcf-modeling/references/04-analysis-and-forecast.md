# Stage 4 — Analysis and forecast authoring

The valuation's actual work happens here, in three moves. Read `formulas.md` once before starting — every recipe below lives there with exact syntax.

Read the sector playbook, or playbooks, the skill map routes this issuer to — in the same step, however many that is. The three moves below assume a margin-driven chain fits; for a bank, an insurer or a REIT it does not, and that playbook's chain-shape section replaces the default rather than annotating it. For every other sector it tells you which decomposition pays and where the margin story lives. Its calibration table is terminal only: those bands describe the steady state you will need in stage 6, and pulling one into an explicit year substitutes a sector average for the issuer evidence these three moves exist to find.

## Move 1 — decompose where profit comes from

Profit is not one number; it is a sum of sources with different economics. Take the model apart before forecasting it:

- get_financial_model for the committed workbook; list_unified_statements / get_unified_rows for every dimensional breakdown behind it — including axes spine_mapping did not promote (a geographic split is still evidence; reference it in formulas as `unified.<rowId>`).
- Characterize each source with computed history, never prose arithmetic: one calculate_model_rows batch per theme — mix shares, per-source growth, contribution-to-growth, margin structure, cash conversion (toolbox §1–§2). Contribution-to-growth rows are the fastest honest picture: they sum to total growth, so they self-check.
- Build every metric you need as an explicit formula row. Verify from first principles that its definition fits this issuer, and state what it excludes or normalizes.
- Separate recurring economics from one-off or structurally different streams (regulatory credits, asset sales, interest income on a cash pile): they get their own line and their own judgment, or they silently distort every ratio built on top.

Output: a profit-source ledger — each source with its historical anchor: growth path, margin, share of profit, and how those trended.

## Move 2 — judge, per source, what changes and what persists

For every source and every driver row ask: does the economic structure that produced this history persist?

- **Start from the company, then test the world around it.** Historical stream economics are the forecast anchor. From there, reason forward about the industry's likely demand, technology, supply, competitive and regulatory direction, then the issuer's product roadmap, strategic priorities, capacity, distribution and execution. Translate each conclusion into the named company line it changes. A generic sector growth rate, peer forecast or historical average is a reference check; it never substitutes for this issuer-specific causal chain.
- **"Unchanged" is a claim, not a default.** Keeping a ratio flat asserts its causes persist — say why. The anchors make the claim testable: a driver held flat against a five-year trend moving one direction is a contradiction you must address.
- **"Changed" needs a nameable cause**: product cycle, capacity coming online, competition, policy, mix shift. Evidence comes from the breakdown trends you computed and financial_search for management guidance and macro conditions.
<!-- Filing insights are switched off (FILING_INSIGHTS_ENABLED unset), so an ingestion links an empty
     set flagged filing_insights_disabled and `get_financial_model` with an insightId can only answer
     filing_insight_not_found. Restore this clause verbatim when the flag goes back on:
     "Evidence comes from the breakdown trends you computed, filing insights (get_financial_model with
     insightId), and financial_search for management guidance and macro conditions." -->

- **Macro enters as transmission, not mood.** A rate path reaches this model through named lines — financing cost, discount rate, demand for financed purchases. If you cannot name the receiving line, the macro observation does not belong in the model. The same rule applies to an industry narrative: name the company-specific product, stream, margin or reinvestment mechanism before using it in an assumption.
- Write each conclusion as one sentence you will reuse verbatim as the assumption's rationale: *source X — changes/persists — because Y — evidence Z.*

## Move 3 — translate the judgments into the chain

The chain's shape follows the heterogeneity of your judgments, not habit:

- **Segment revenue requires a segment economics decision.** When revenue is forecast by segment, do not jump straight from consolidated revenue to a single operating margin by default. For every material segment, seek the disclosed or defensible segment gross-margin / cost-of-revenue evidence, forecast its gross margin, calculate `segment gross profit = segment revenue × segment gross margin`, and make consolidated gross profit their sum. Forecast operating expenses at the level where their economics live — segment-specific costs where they are attributable, plus a separately modelled shared-cost pool where they are not — then calculate operating profit from that bridge. A consolidated margin shortcut is permitted only when the issuer does not disclose enough cost structure to allocate defensibly; record that limitation and why a segment allocation would be invented rather than evidenced.
- **One shared story** → author the margin-driven chain explicitly: historical anchor formulas, forecast amount formulas, then the six driver assumptions (growth.revenue.total, margin.operating, tax_rate, ratio.da_to_revenue, ratio.capex_to_revenue, ratio.operating_nwc_to_revenue). Nothing is a default chain; the formulas are your Move-2 judgment and must be traceable.
- **Different stories per source** (a shrinking segment beside an exploding one) → give each revenue stream its own historical growth formula and forecast formula such as `LAG(stream,1) * (1 + growth.revenue.<stream>)`, then make revenue.total the sum of streams; drive costs at whatever level your story actually lives at. Use fades (YEAR_INDEX) for stories that are neither "changes now" nor "never changes".
- A two-level stream tree forecasts at the level where the story lives: leaves with assumptions and the parent as their sum, or the parent driven with leaves informational.
- Every set_assumption carries sourceType, sourceRefs, and the Move-2 sentence as rationale. The assumption's unit must match the row's own unit exactly: `growth.*`, `margin.*`, and `tax_rate` rows are `{"kind":"percent"}`; `ratio.*` rows are `{"kind":"ratio"}` — a percent payload on a ratio row is rejected whole-batch. After each mutation read the recalculated workbook: a null fcff in any forecast period names the input that broke — fix before proceeding. The chain is done when fcff holds a value in every forecast period and every assumption traces to a ledger sentence.

## Failure modes the engine will not catch

The engine checks units, nulls and formula resolution. A batch that applies cleanly and an fcff row with no nulls prove the chain computes, not that it is right. These are the shapes that pass both checks:

- **Every driver drifting the same way.** Each assumption defends itself — a point of margin here, a slightly easier working-capital ratio there, capex tapering as the build-out completes — and none looks unreasonable alone. Read them together: if growth, margin, tax, D&A, capex and NWC all move in the direction that lifts fcff, the chain asserts everything gets easier at once, which almost nothing does. Name the tension you expect — growth bought with margin, margin bought with capex — or show why this issuer escapes it.
- **A base year that is not a base.** LAG-anchored formulas propagate whatever sits in the last actual period, one-offs included: a settlement, a strike, a channel restock, a discrete tax item. Read the anchor period against the years before it. If it is unrepresentative, forecast off a normalized row you build for the purpose, or state that the abnormal level persists and why.
- **A ratio reasoned at the wrong level.** `ratio.operating_nwc_to_revenue` holds a level; fcff consumes its change. A judgment about working capital as a flow ("the build unwinds next year") has to be written as the level that produces that unwind, or it lands inverted. The same trap appears wherever your story is about a delta and the row holds a stock.
- **Ratios whose physical story is impossible.** capex against D&A implies an asset base growing, holding or shrinking — check that the implied direction matches the growth you forecast, because capacity does not expand on maintenance capex. A tax_rate set to statutory when the effective rate has sat persistently below it asserts the structure causing that gap disappears. An NWC level far off its own history says the cash conversion cycle changed; name what changed it.
- **A rationale written after the number.** A sentence assembled to justify an assumption already chosen looks identical to one that produced it, and only the first kind is testable. The tell is a rationale that cites a direction but no mechanism, or evidence that would equally support the neighbouring value. If the sentence would not have picked this number out of the range on its own, the judgment is still owed.

Budget note: each revision mutation must be a solo tool step — batch related operations into one apply_financial_model_operations call (operations execute in order within a batch), and do not spend steps re-reading state you already hold.
