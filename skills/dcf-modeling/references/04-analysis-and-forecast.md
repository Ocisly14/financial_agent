# Stage 4 — Analysis and forecast authoring

The valuation's actual work happens here, in three moves. Read `formulas.md` once before starting — every recipe below lives there with exact syntax.

## Move 1 — decompose where profit comes from

Profit is not one number; it is a sum of sources with different economics. Take the model apart before forecasting it:

- get_financial_model for the committed workbook; list_unified_statements / get_unified_rows for every dimensional breakdown behind it — including axes spine_mapping did not promote (a geographic split is still evidence; reference it in formulas as `unified.<rowId>`).
- Characterize each source with computed history, never prose arithmetic: one calculate_model_rows batch per theme — mix shares, per-source growth, contribution-to-growth, margin structure, cash conversion (toolbox §1–§2). Contribution-to-growth rows are the fastest honest picture: they sum to total growth, so they self-check.
- The preset metric rows are reference points, not truth: verify from first principles that each definition measures what your analysis needs (toolbox §0.5 shows where definitions genuinely diverge — net-debt scopes, SBC-blind FCF). A correct preset you use as-is; a wrong or insufficient one you supersede with your own row and say why.
- Separate recurring economics from one-off or structurally different streams (regulatory credits, asset sales, interest income on a cash pile): they get their own line and their own judgment, or they silently distort every ratio built on top.

Output: a profit-source ledger — each source with its historical anchor: growth path, margin, share of profit, and how those trended.

## Move 2 — judge, per source, what changes and what persists

For every source and every driver row ask: does the economic structure that produced this history persist?

- **"Unchanged" is a claim, not a default.** Keeping a ratio flat asserts its causes persist — say why. The anchors make the claim testable: a driver held flat against a five-year trend moving one direction is a contradiction you must address.
- **"Changed" needs a nameable cause**: product cycle, capacity coming online, competition, policy, mix shift. Evidence comes from the breakdown trends you computed and financial_search for management guidance and macro conditions.
<!-- Filing insights are switched off (FILING_INSIGHTS_ENABLED unset), so an ingestion links an empty
     set flagged filing_insights_disabled and `get_financial_model` with an insightId can only answer
     filing_insight_not_found. Restore this clause verbatim when the flag goes back on:
     "Evidence comes from the breakdown trends you computed, filing insights (get_financial_model with
     insightId), and financial_search for management guidance and macro conditions." -->

- **Macro enters as transmission, not mood.** A rate path reaches this model through named lines — financing cost, discount rate, demand for financed purchases. If you cannot name the receiving line, the macro observation does not belong in the model.
- Write each conclusion as one sentence you will reuse verbatim as the assumption's rationale: *source X — changes/persists — because Y — evidence Z.*

## Move 3 — translate the judgments into the chain

The chain's shape follows the heterogeneity of your judgments, not habit:

- **One shared story** → author the margin-driven chain explicitly: historical anchor formulas, forecast amount formulas, then the six driver assumptions (growth.revenue.total, margin.operating, tax_rate, ratio.da_to_revenue, ratio.capex_to_revenue, ratio.operating_nwc_to_revenue). Nothing is a default chain; the formulas are your Move-2 judgment and must be traceable.
- **Different stories per source** (a shrinking segment beside an exploding one) → give each revenue stream its own historical growth formula and forecast formula such as `LAG(stream,1) * (1 + growth.revenue.<stream>)`, then make revenue.total the sum of streams; drive costs at whatever level your story actually lives at. Use fades (YEAR_INDEX) for stories that are neither "changes now" nor "never changes".
- A two-level stream tree forecasts at the level where the story lives: leaves with assumptions and the parent as their sum, or the parent driven with leaves informational.
- Every set_assumption carries sourceType, sourceRefs, and the Move-2 sentence as rationale. The assumption's unit must match the row's own unit exactly: `growth.*`, `margin.*`, and `tax_rate` rows are `{"kind":"percent"}`; `ratio.*` rows are `{"kind":"ratio"}` — a percent payload on a ratio row is rejected whole-batch. After each mutation read the recalculated workbook: a null fcff in any forecast period names the input that broke — fix before proceeding. The chain is done when fcff holds a value in every forecast period and every assumption traces to a ledger sentence.

Budget note: each revision mutation must be a solo tool step — batch related operations into one apply_financial_model_operations call (operations execute in order within a batch), and do not spend steps re-reading state you already hold.
