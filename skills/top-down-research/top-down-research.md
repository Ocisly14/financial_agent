---
name: top-down-research
description: Use when the user wants to work from market conditions down to specific stocks — read the macro picture, narrow to a few sectors, then find candidates inside the sectors the user picks.
layer: research
---

Use a three-round top-down research process. End every round with one user decision. Make the choice clear, but never choose on the user's behalf.

## Three rounds

**Round 1: Macro conditions → sector candidates**
Inspect the roster first. If a semantically relevant member already exists, call `fetch_from_topic` to see what it covered before deciding whether to ask again. Create a macro Topic with `create_topic` only when no suitable member exists. Ask it to identify the sectors currently leading and return a verified tradable proxy ticker for each one. Narrow the result to roughly three candidates, then call `ask_user` to end the round.

**Round 2: Screen within each sector**
After the user selects sectors, prepare one member Topic per sector and call every `ask_topic` in parallel in the **same step**. Each Topic performs screening only: return 3–5 candidates for its sector with one selection reason each, but do not perform a deep analysis. Combine the results into a cross-sector candidate overview, then call `ask_user` to end the round.

**Round 3: Deep analysis**
Drive the appropriate Topic to analyze each security selected by the user. Choose the destination Topic from context: reuse a Topic with the same name, or create a dedicated Topic when the user explicitly wants to track one security over time. Do not call `ask_user` in this round; write the complete report.

## Hard constraints

1. **Stop every round at the user's decision.** Round 1 and Round 2 must end with `ask_user` as the only tool call in that step. Never choose a sector or security for the user, and never merge both rounds into one uninterrupted workflow.
2. **Dispatch all sectors in the same round with one parallel step.** Serial `ask_topic` calls are roughly three times slower and consume the step budget.
3. **Accept proxy tickers only from a Topic response.** You have no market-data tool, so a ticker you supply yourself is fabricated. Exclude any ticker for which the Topic could not obtain market data.
4. **Use at most one `fetch_from_topic` probe per round.** Probe only to avoid duplicate work, not to read an entire member history.
5. **Honor supplied user preferences.** If risk tolerance or holding period is absent, do not spend a separate round on a questionnaire. Add those two questions to the Round 1 `ask_user` request alongside the sector selection.

## Question shape

`ask_user` supports at most three questions and 2–8 options per question. Therefore:

- Round 1: Question 1 asks which sectors to explore. Use one option per sector with `min_selections: 1` and `max_selections: 3`. If preferences are missing, add questions for risk tolerance and holding period.
- Round 2: Use **one question per sector**, with that sector's candidate securities as the options. Put the ticker in `label` and a one-sentence selection reason in `description`. Cross-sector candidate lists often exceed eight items, so splitting by sector respects the per-question limit.
- Do not repeat every option in `reply`; the option card already shows them. Use `reply` for the judgment and supporting evidence.

## Round outputs

- Round 1: A macro view plus roughly three sectors, each with a proxy ticker and selection reason.
- Round 2: A cross-sector candidate overview.
- Round 3: A complete report with the cross-security conclusion first, supporting evidence for each security second, and disagreements or unresolved items last.

If a sector Topic times out or fails, identify the missing sector in the output. Never fill the gap with figures from another sector.

## for: topic

Please support every conclusion with a concrete reading and date. Omit judgments that have no supporting reading.

For every security you mention, provide its tradable ticker and confirm that market data is available for it. State plainly when the ticker cannot be verified.

Do not provide a buy or sell signal. Provide the analytical dimensions and evidence behind your judgment.

Return only the conclusion and evidence; do not recap the process.
