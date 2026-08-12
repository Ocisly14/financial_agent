---
name: sector-analysis
description: Analyze US equity sectors using relative-strength and trend data, recent news, macro drivers, and conditional forward scenarios. Use for sector rotation, sector leadership, which sectors are improving or weakening, comparisons among sectors, or a deep diagnosis of one S&P 500 GICS sector.
layer: topic
tools: [get_sector_analysis, financial_search]
---

Analyze in this order: scope → data baseline → news interpretation → dual-horizon scenarios. Separate observed facts from inference before giving a forward view.

## Define the scope

Send only these 11 S&P 500 GICS sectors and their tradable proxies to the sector data tool:

| Sector | ETF | Sector | ETF |
|---|---|---|---|
| Communication Services | XLC | Consumer Discretionary | XLY |
| Consumer Staples | XLP | Energy | XLE |
| Financials | XLF | Health Care | XLV |
| Industrials | XLI | Materials | XLB |
| Real Estate | XLRE | Technology | XLK |
| Utilities | XLU |  |  |

- For a whole-market rotation or leadership request, analyze the complete 11-sector universe.
- When the user explicitly selects several sectors, compare only that subset and label the rank as a rank within the selected subset.
- For one sector, produce a single-sector diagnostic without a cross-sectional rank or strength score.
- Do not silently substitute a parent sector for an industry, theme, or unsupported ETF. If user input is available, ask whether the broader GICS sector is an acceptable proxy. If user input is unavailable, state the coverage gap and do not make a proxy-based data judgment.

## Organize data collection

Reuse sector data already present in the current turn when its scope matches and its date is explicit. Do not fetch the same data twice.

For a whole-market request, obtain the complete ranking first. Use the result to select the leading, improving, and weakening sectors whose news needs explanation, together with common macro drivers. Do not choose news targets from prior beliefs before seeing the ranking.

For one sector or an explicit subset, market data and news research are independent and may run in parallel in the same step.

Read `forward-analysis-playbook.md` before evaluating news evidence or constructing scenarios. Read `report-template.md` before writing the answer. Both references may be read in one step.

## Synthesize the view

Relate every material news item to the market data as confirmation, explanation, conflict, or not yet reflected. Proximity between a news event and a price move is not proof of causation.

Provide a tactical outlook for the next **1–3 months** and a structural outlook for the next **6–12 months**. For each horizon, write base, upside, and downside scenarios with drivers, confirmation signals, catalysts, and invalidation conditions. Use constructive / neutral / cautious relative views and qualitative confidence. Do not provide unsupported return forecasts, price targets, or probabilities.

In whole-market mode, show every successfully returned sector before grouping forward implications by leading / improving / weakening / lagging. Never truncate the result to the top three. In single-sector mode, expand the complete dual-horizon scenario analysis and state that no cross-sectional ranking was performed.

## Hard constraints

1. Treat `strength_score` only as a cross-sectional percentile within the current comparison universe. It is not an upside probability or a buy signal. A fully declining universe still has a first-ranked sector.
2. Keep `relative_phase` separate from `absolute_trend`. Explicitly flag a relatively leading sector that is falling in absolute terms as a conflicting signal.
3. Support every data conclusion with a concrete payload reading and `as_of` date. List unavailable sectors and never fill missing values.
4. Do not invent catalysts from price data. Do not invent prices, volume, valuation, earnings estimates, or technical levels from news. Do not discuss volume because the sector tool explicitly excludes it.
5. Label confirmed facts, institutional expectations, media reports, and your own inferences separately. Downgrade a material claim supported by only one unofficial source to unverified, and do not use it as a factual premise in the base case.
6. If a data or news task fails, preserve the remaining verified results and state the gap. Never replace a missing sector with evidence from another sector.
7. Provide relative sector judgments and conditional scenarios, not direct buy or sell instructions.

## for: market_data

Use `get_sector_analysis` as the sole price-based baseline. Omit `sector_symbols` for a whole-market overview, pass one supported ETF for a single-sector request, and pass only the user-selected ETFs for an explicit subset.

Return `comparison_scope`, `as_of`, benchmark, every successful sector, unavailable entries, and the methodology. In whole-market or subset mode, preserve each sector's rank, strength score, relative phase, absolute trend, at least one absolute return, and at least one return relative to SPY. In single-sector mode, state that rank and score do not apply.

Keep absolute trend distinct from relative strength. Do not interpret the score as a forecast, and do not add volume, news, valuation, or indicators absent from the tool result.

## for: market_research

Resolve relative dates into absolute dates. By default, cover realized drivers from the past 30 days and scheduled catalysts in the next 90 days. Follow the user's window when one is specified.

Use separate focused queries for common macro drivers and the sectors that need explanation. Do not pretend that one broad query covers all 11 sectors. Prefer official announcements, regulators, company materials, and verifiable economic data, followed by reliable news sources.

Return the event date, source, URL, and evidence type for every item: confirmed fact, scheduled catalyst, institutional expectation, or reported/unverified. Distinguish the event itself from a journalist's or analyst's interpretation of its impact. State plainly when no reliable evidence was found.
