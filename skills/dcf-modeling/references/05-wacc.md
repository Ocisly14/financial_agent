# Stage 5 — The WACC sheet

Twelve rows beside the DCF grid, anchored at the model's **creation date** (not today): beta windows and prices are measured as of when the model began, so a refresh years later still measures the same moment. It rides along in `current_workbook.waccSheet` on every read and mutation — never ask separately.

## Measured starting values — and the workbook is authoritative

The moment spine_mapping's facts commit, the engine may derive measured starting values and land them in a follow-up revision. Those values are evidence, not a parallel capital-structure model: every filing-derived WACC term is read from the **recalculated workbook cell**, so an agent-authored formula on a canonical skeleton item is what WACC uses.

| row | derived from |
| --- | --- |
| beta | 10-year daily+weekly regression vs SPY over cached prices |
| equity_value | diluted shares × close as of the anchor date |
| total_debt | final `debt` workbook value (use a formula if it must combine borrowings and finance leases) |
| effective_tax_rate | final `income_tax_expense` and `pretax_income` workbook values |
| cost_of_debt | final `interest_expense ÷ average debt` workbook values — only if the workbook carries a separate interest-expense line |
| risk_free_rate | the official 30-year Treasury yield from treasury.gov's daily curve |

If a mapped fact has the wrong economic scope, correct the **canonical item** before relying on WACC. For example, when `lease_liabilities` includes operating leases but the equity bridge deducts only finance leases, set that skeleton item's historical source to `formula` and write its formula from the finance-lease fact rows. Do not leave the correction only in prose or in a WACC override.

Locked formulas then cascade: cost_of_equity = rf + beta × ERP; e_over_v / d_over_v from equity_value and total_debt (weights use TOTAL debt — cash is a bridge item, not a weight; net_debt is a display row); wacc = weighted average with the tax shield. A refresh **never overwrites a row you wrote** and skips committing when nothing changed.

## What is yours to fill

Read the sheet's missingInputs and review every direct input. All direct rows (`beta`, `risk_free_rate`, `equity_risk_premium`, `cost_of_debt`, `equity_value`, `total_debt`, and `effective_tax_rate`) are writable through `set_wacc_input`; the relationship rows remain locked. Use the final workbook calculation for filing-derived values, and use a sourced market or research value only when the workbook cannot calculate it. **Before valuation, you must explicitly write the selected `risk_free_rate` and `equity_risk_premium`.** Automatic Treasury data is a candidate, not the selected duration; ERP is always an agent judgment. Beta, equity value, total debt, tax rate, cost of debt, E/V, D/V, cost of equity, net debt and WACC itself remain mechanical outputs unless you have an evidenced reason to override a writable direct input.

- **equity_risk_premium — always yours.** It has no measurable source by nature; state it as your judgment via set_wacc_input (inside apply_financial_model_operations) with sourceType `agent_estimate` and a rationale that says what regime you are assuming. **Name the tenor it is measured against, and make it the same one `risk_free_rate` uses** — a premium is only defined relative to some rate, and published implied-ERP estimates are computed over the 10Y. Quoting one of those beside a 30Y risk-free rate adds the term spread twice: once in the rate, once inside a premium that was calibrated without it.
- **risk_free_rate** — the automatic 10Y Treasury point is a measurable starting value, not a methodological default you are obliged to keep. Before valuation, confirm the curve date and choose the tenor that fits this issuer's cash-flow duration and forecast horizon. get_treasury_yield fetches the official curve at any tenor (`{ term: "30Y" | "10Y" | … }`); if a different tenor is more defensible, fetch it and override with sourceType `market`, preserving the curve date, tenor and reason in the rationale.
  **Whatever tenor you settle on, the ERP above must be measured against the SAME one** — see its bullet. Moving to the 30Y for a terminal-value-heavy issuer is defensible; doing it without taking the term spread back out of the ERP is not, and the two rationales have to agree on which tenor they are both quoting.
- **cost_of_debt** — override when the engine could not derive it (no separate interest-expense line — Apple and Microsoft both bury it) or when its backward-looking estimate is stale: delegate_to_agent → market_research for the issuer's current bond yields, naming the issuer and the maturity you want, then override with sourceType `search` and the source it cites in refs.

set_wacc_input on a locked relationship row is refused; there is no wacc assumption to set anywhere — the wacc row's value IS the model's one official discount rate, valuation reads it directly, and the valuation cannot compute (so the model never reads as valued) until it resolves non-null. When it is null, its missingInputs chain tells you which input to fill next.

## Judgment notes

- ERP: pick a defensible long-run figure and hold it across scenarios — sensitivity handles the range; do not tune ERP to move the answer.
- The discount-rate review is a classification of economic duration, not a way to close a gap to the share price. State the as-of date and why the selected risk-free-rate tenor fits the DCF. A current quote is a reasonableness check after the valuation, never an input target for WACC, ERP, beta, or cost of debt.
- A cash-rich issuer showing negative net_debt is normal and does not make D/V negative — that is why weights use total debt.
- Beta from a 10-year window smooths regime changes; if the business transformed recently (major acquisition, delisting-scale buybacks), say so in the ERP/beta discussion in your final report rather than hand-editing beta.
