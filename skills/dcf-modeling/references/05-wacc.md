# Stage 5 — The WACC sheet

Twelve rows beside the DCF grid, anchored at the model's **creation date** (not today): beta windows and prices are measured as of when the model began, so a refresh years later still measures the same moment. It rides along in `current_workbook.waccSheet` on every read and mutation — never ask separately.

## What fills itself, and when

The moment spine_mapping's facts commit, the engine derives what it can reach and lands it in a follow-up revision:

| row | derived from |
| --- | --- |
| beta | 10-year daily+weekly regression vs SPY over cached prices |
| equity_value | diluted shares × close as of the anchor date |
| total_debt | the committed debt lines (commercial paper + current + long-term) |
| effective_tax_rate | income tax ÷ pretax income history |
| cost_of_debt | trailing interest expense ÷ average debt — only if the spine carries a separate interest_expense line |
| risk_free_rate | the official 30-year Treasury yield from treasury.gov's daily curve |

Locked formulas then cascade: cost_of_equity = rf + beta × ERP; e_over_v / d_over_v from equity_value and total_debt (weights use TOTAL debt — cash is a bridge item, not a weight; net_debt is a display row); wacc = weighted average with the tax shield. A refresh **never overwrites a row you wrote** and skips committing when nothing changed.

## What is yours to fill

Read the sheet's missingInputs — each empty row names exactly what is absent:

- **equity_risk_premium — always yours.** It has no measurable source by nature; state it as your judgment via set_wacc_input (inside apply_financial_model_operations) with sourceType `agent_estimate` and a rationale that says what regime you are assuming.
- **risk_free_rate** — only if the Treasury feed was unreachable: get_treasury_yield fetches the official curve at any tenor (`{ term: "30Y" | "10Y" | … }`); if you deliberately prefer a different tenor than the auto 30Y, fetch it and override with sourceType `market` and the tenor in the rationale.
- **cost_of_debt** — override when the engine could not derive it (no separate interest-expense line — Apple and Microsoft both bury it) or when its backward-looking estimate is stale: search the issuer's current bond yields (financial_search), override with sourceType `search` and the source in refs.

set_wacc_input on any locked row is refused; there is no wacc assumption to set anywhere — the wacc row's value IS the model's one official discount rate, valuation reads it directly, and the valuation cannot compute (so the model never reads as valued) until it resolves non-null. When it is null, its missingInputs chain tells you which input to fill next.

## Judgment notes

- ERP: pick a defensible long-run figure and hold it across scenarios — sensitivity handles the range; do not tune ERP to move the answer.
- A cash-rich issuer showing negative net_debt is normal and does not make D/V negative — that is why weights use total debt.
- Beta from a 10-year window smooths regime changes; if the business transformed recently (major acquisition, delisting-scale buybacks), say so in the ERP/beta discussion in your final report rather than hand-editing beta.
