---
name: stock-analysis
description: Produce evidence-based analysis of one publicly traded US company by combining current market data, sector context, macro transmission, reported fundamentals, valuation context, technical structure, news, catalysts, risks, and conditional forward scenarios. Use when the user asks for a deep dive, investment thesis, outlook, risk review, earnings-informed view, or "what is going on" analysis for a single stock or ticker.
layer: topic
tools: [get_stock_price, get_sector_analysis, stock_sma, stock_ema, stock_rsi, stock_macd, stock_bollinger_bands, stock_atr, stock_obv, stock_vwap, stock_support_resistance, get_sec_company_profile, get_sec_filings, get_sec_company_facts, financial_search]
---

Analyze one operating company in this order: scope -> market baseline -> company evidence -> sector and macro transmission -> valuation and expectations -> technical structure -> forward scenarios. Treat macro conditions and company data as separate evidence streams until synthesis.

## Set the scope

- Resolve the exact ticker, company, listing, and security type. Ask only when the security is ambiguous; never default to a ticker.
- Follow the user's horizon. If none is given, use **1-3 months** for the tactical view and **6-12 months** for the fundamental view.
- Scale depth to the request. A quick view may compress sections but must not omit the evidence ledger, material risks, or invalidation conditions.
- If the symbol is an ETF, fund, SPAC, shell company, or non-operating vehicle, state that the company-fundamental framework only partially applies and adapt the analysis to holdings, structure, or deal terms.

## Collect evidence in two passes

### Pass 1: establish identity and baseline

Run these independent tasks in parallel:

1. Obtain the current quote and default 250-day daily history.
2. Use SEC data to confirm the official filer identity, fiscal calendar, latest reported quarter, and available filing history. Use primary company materials to confirm the business model, reporting currency, primary sector, relevant sector ETF proxy, and latest earnings release.

Do not begin with a generic macro narrative. Let the company's revenue, cost, balance-sheet, and valuation exposures determine which macro variables matter.

### Pass 2: investigate material drivers

Use the baseline to request only the evidence needed to answer the question:

- Obtain the relevant sector baseline and selected technical indicators from market data.
- Research the latest reported results and guidance, prior comparable period, material company news from the past 90 days, and scheduled catalysts in the next 90 days.
- Research only the macro variables with a plausible company-specific transmission channel. Prefer separate focused searches over one broad query.
- Retrieve valuation and consensus context only when the source, metric definition, and as-of date are clear.

Read `macro-transmission-playbook.md` before interpreting macro evidence. Read `company-data-playbook.md` before evaluating fundamentals or valuation. Read `technical-playbook.md` only when technical evidence is material. Read `report-template.md` before synthesis. Load references when they become relevant, not automatically at the beginning.

## Build an evidence ledger

Classify every material input as one of:

1. **Observed market data**: price, return, drawdown, volume, sector-relative data, or indicator output returned by market tools.
2. **Reported company fact**: a filing, earnings release, investor presentation, or attributable management statement.
3. **External confirmed fact**: government, central-bank, regulator, exchange, or other primary-source information.
4. **Expectation**: company guidance or a forecast attributed to a named institution, with its as-of date.
5. **Inference**: the analyst's transmission path or scenario conclusion.

Never merge these categories. Label reported or single-source claims as unverified when they cannot be corroborated. Recency is not reliability.

## Synthesize, do not average

- Write every macro conclusion as a chain: **macro variable -> sector or industry mechanism -> company exposure -> financial line or operating KPI -> observable confirmation**.
- Give company-specific evidence more weight than a generic sector relationship. A favorable macro backdrop does not repair deteriorating unit economics, liquidity, governance, or execution.
- Treat valuation as an expectations test, not as a standalone cheap/expensive label. Identify what operating outcome the current multiple appears to require and what could cause re-rating or de-rating.
- Use technical evidence for trend, positioning, and timing context. Do not let RSI, MACD, moving averages, or chart levels prove business quality or intrinsic value.
- State conflicts explicitly. Do not collapse opposing signals into a composite score.
- Distinguish "the thesis is working" from "the stock price is rising." Price action can confirm market acceptance, but it cannot establish causation.

## Produce a forward view

For both horizons, provide base, upside, and downside cases. Each case must include:

- the causal driver;
- the company KPI or financial line affected;
- the next observable confirmation signal;
- a dated or event-based catalyst when known; and
- an invalidation condition.

Use **constructive**, **neutral**, or **cautious** for the overall stance and rate confidence as high, medium, or low based on evidence quality. Do not assign probabilities, returns, price targets, or buy/sell instructions unless the user explicitly requests a valuation exercise and the required sourced inputs are available. Never invent missing estimates.

## Hard constraints

1. Attach every material factual claim to a concrete tool result or cited source with an as-of date. Never rely on model memory for current facts.
2. Quote exact statistics already returned by `get_stock_price`; do not recalculate highs, lows, period returns, drawdowns, or moving averages.
3. Keep GAAP and non-GAAP data, reported results and guidance, and quarterly and annual periods separate. Do not compare incompatible definitions.
4. Prefer primary sources: SEC filings and company materials for company facts; government, central-bank, and regulator publications for macro facts. Use reliable news for context and named institutional research for expectations.
5. If data is stale, missing, contradictory, or based on an unclear definition, state the limitation and lower confidence. Do not fill a gap with narrative.
6. Do not infer company fundamentals from price data or infer market levels and indicator values from news.
7. Finish with thesis-monitoring indicators and explicit kill criteria so the view can be updated as evidence changes.

## for: market_data

Call `get_stock_price` first with the exact ticker and default 250-day history. Use `window` for a user-specified historical period; do not widen `historyDays` to reach an old date. Return the quote timestamp, market session, data freshness, exact tool-provided statistics, and the requested window when present.

Once research confirms the company's sector, use `get_sector_analysis` with the single supported sector ETF proxy. Treat it as sector context only: single-sector output has no cross-sectional rank or strength score.

Choose technical tools after seeing the baseline. For a standard analysis, use daily RSI 14, MACD 12-26-9, ATR 14, and support/resistance only when they answer a material question. Add 15-minute or 60-minute structure only for an explicitly tactical request. Return every indicator's timeframe, parameters, bar count, value, and as-of timestamp.

Do not call a separate SMA or EMA tool solely for a value already present in `get_stock_price`. Do not report divergence without confirming it across two relevant timeframes. An unparameterized `stock_vwap` is cross-day; for current-session VWAP, pass an explicit minute timeframe and restrict `history_bars` to bars elapsed in the current session.

## for: market_research

Resolve relative dates into absolute dates. Use separate focused queries for:

1. the latest filing, earnings release, guidance, and investor materials;
2. company-specific developments from the past 90 days and scheduled catalysts in the next 90 days;
3. the relevant industry and sector drivers; and
4. only the macro variables that transmit into this company's demand, pricing, costs, financing, currency exposure, regulation, or valuation.

Start with `get_sec_company_profile` to resolve the official filer and recent material forms. Use `get_sec_filings` for dated filing discovery and official document links. Use `get_sec_company_facts` for standardized reported values before searching the web. Preserve every SEC fact's taxonomy, concept, unit, period, form, filed date, and accession number. Do not assume that standardized Company Facts contains segment data or company-specific extension concepts.

For every searched item, return the event or publication date, source, URL, evidence class, and the exact company metric or transmission channel it informs. Prefer primary materials and verify that an earnings result is the latest available period. Separate management guidance from third-party consensus and identify the institution and as-of date for every external expectation.

Research reported fundamentals across growth, margins, cash generation, balance-sheet resilience, share count or capital returns, and the company's industry-specific KPIs. Do not force irrelevant metrics. Report definitions and periods exactly as sourced, flag GAAP/non-GAAP differences, and never manufacture a consensus figure or valuation multiple when reliable current data is unavailable.
