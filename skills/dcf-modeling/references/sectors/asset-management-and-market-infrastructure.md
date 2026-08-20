# Sector playbook — Asset Management and Market Infrastructure

Covers four related fee businesses inside GICS Financials: Asset Management & Custody Banks, split traditional/active (BLK, TROW, BEN, IVZ) from alternative (BX, KKR, APO, ARES); Financial Exchanges & Data (CME, ICE, NDAQ, CBOE, SPGI, MCO, MSCI); Transaction & Payment Processing (V, MA, FIS, FISV, GPN); and Investment Banking & Brokerage platforms serving retail (SCHW, IBKR, LPLA, RJF). The structural fact that sets this sector apart from the rest of Financials: unlike banks, insurers and REITs, these are fee businesses that sit on an ordinary FCFF chain — no loan book to roll forward, no float to invest, no property portfolio to depreciate. The care this sector demands is narrower but still real: balance-sheet items that look like debt but are not (client payables, settlement balances, segregated client cash) must stay out of the debt and NWC rows, and one of the four business models earns most of its revenue off a balance sheet rather than a fee at all.

## Chain shape — what to build instead of the default

- Identify which of the five sub-models (traditional AM, alternative AM, exchange/data, payment network/processor, retail broker) an issuer runs, and for a diversified issuer route each segment to its own logic below rather than applying one label to the whole company.
- Split every revenue base into the mechanisms that move it, not one blended growth rate: assets under management move by net flows, market appreciation and acquisitions; payment volume moves separately from take rate; a broker's revenue splits into fee-based and balance-sheet-based streams with different drivers entirely.
- Before writing a single margin assumption, decide whether the issuer's revenue is fee revenue, spread revenue, or both, and forecast them on separate lines — collapsing a broker's net interest income into "other revenue" growing with the fee lines hides the balance-sheet business inside a fee-business chain.
- Client payables, settlement balances and segregated client cash sit on the balance sheet because the issuer is a custodian or clearing venue for that money, not because it borrowed it. Never map them into debt, lease liabilities or the capital-structure weights, and never fold them into operating working capital as if fee revenue produced them.

## Revenue — the decomposition that pays

### Asset managers — traditional and active

Roll forward assets under management explicitly: beginning AUM, plus net client flows, plus market appreciation, plus or minus acquisitions and divestitures, equals ending AUM. Forecast net flows and market appreciation as two separate assumptions. **A model that grows AUM with one rate has hidden a market-return assumption inside a flow assumption** — the two have opposite tractability: flows are a franchise judgment you can defend from distribution, product mix and performance, while market appreciation is a claim about where the index goes, and embedding that claim in a DCF you then discount at a cost of equity built on the same market is close to circular. Hold market appreciation near a long-run reference rate and put the analytical weight on flows. Revenue is average AUM times the realized fee rate; the realized rate compresses as the mix shifts toward passive and fixed income and away from active equity, so a flat terminal fee rate is a claim, not a default.

### Asset managers — alternative

Fee-related earnings, drawn from management and advisory fees on locked-up committed capital, and performance fees or carried interest, drawn from investment gains on a schedule the issuer does not control, are different businesses wearing one income statement. Fee-related earnings deserve the higher multiple: they are contractual, multi-year and insensitive to a single fund's outcome. Performance fees are volatile, lumpy, and structurally a call option on portfolio returns — forecast them off the disclosed fund life cycle (investment period, harvest period, carry hurdle) rather than as a percentage of fee-related revenue, and value them with a wider band or a separate scenario rather than blending them into one steady margin. Fee-related AUM growth is driven by fundraising cycles that are lumpy and disclosed in named vintages, not a smooth annual rate.

### Exchanges and data/index providers

Transaction and clearing revenue is volume times rate per contract; volume is cyclical and rises with volatility, so a quiet-market year is not the base to extrapolate from. Recurring data, index licensing and listing revenue is closer to a subscription annuity and deserves a materially higher multiple than the transaction line. Decompose the two; a consolidated "exchange revenue" growth rate blends a cyclical stream with an annuity and gets both wrong.

### Payment networks and processors

Revenue is payment volume times take rate, net of client incentives booked as contra-revenue against the card issuers and merchants the network competes to keep. Incentives grow with contract renewals and portfolio competition, so a gross-volume-times-take-rate forecast that ignores incentive escalation overstates net revenue. Cross-border volume carries a materially higher take rate than domestic volume and is more macro-sensitive (travel, global commerce) — split it out rather than blending it into one take rate. Processors (FIS, FISV, GPN) run a different economics than pure networks (V, MA): more labor- and infrastructure-intensive, lower take rate, lower margin.

### Retail brokers

**The structural surprise: for several of the largest names, most of the revenue is net interest income on client cash, not commissions.** This is a rate-sensitive balance-sheet business wearing a fee-business label. Split net interest revenue (client cash balances times the spread the issuer captures) from fee, commission and advisory revenue; they have unrelated drivers. Within net interest revenue, forecast the mix of client cash sitting in low-yield sweep versus higher-yield alternatives (money funds, purchased money-fund sweep) separately — cash sorting toward higher-yield alternatives is the mechanism that compresses the spread the issuer earns even while the rate environment is unchanged.

## Cost and margin — the level the story lives at

### Asset managers — traditional and active

Compensation to revenue is the primary margin lever, and the cost base is largely fixed in the short run: rising AUM drives margin up through operating leverage, and falling AUM hurts margin fast because compensation does not cut as quickly as fee revenue falls, for retention reasons. A margin forecast has to say which side of that asymmetry the issuer is on.

### Asset managers — alternative

Fee-related earnings margin expands with scale because the cost base (investment professionals, deal teams) is largely fixed against a growing fee-AUM base. Performance fees carry near-zero incremental cost and drop through almost entirely to the bottom line — which is exactly why a margin built on a blended (fee-related plus performance) revenue base overstates the durable, ordinary-course margin.

### Exchanges and data/index providers

Incremental transaction volume costs approach zero, producing some of the highest margins in the market. Acquisitive names (ICE, SPGI, MCO, MSCI) carry substantial purchased-intangible amortization from data and index acquisitions that depresses GAAP operating margin well below the underlying fee economics — read margin history net of that drag before forecasting it forward.

### Payment networks and processors

Networks run extraordinary incremental margin on volume; the swing factor is regulatory (interchange caps, network-fee regulation) and litigation, not cost inflation. Processors run a materially lower, more labor- and infrastructure-driven margin — do not apply a network-level margin band to a processor.

### Retail brokers

A broker's margin is a spread story more than an expense-ratio story: net interest margin is set by the yield curve and the issuer's own cost of funding (frequently near zero on sweep balances), so tie the margin forecast to rate-path and deposit-beta assumptions, not to a generic opex ratio. Fee/advisory margin behaves like the traditional asset-manager case above.

## Reinvestment — capex, D&A, and what maintenance means here

Capital intensity is low across every sub-model — technology platforms, data centers and offices, never manufacturing-scale assets — so maintenance means keeping trading, custody and payment infrastructure current, not replacing physical capacity. For asset managers and exchanges, acquisitions (of managers, of data and index businesses) are frequently the real growth capital, not organic capex; keep disclosed or probable M&A out of the capex-to-revenue ratio, or a roll-up strategy reads as an implausibly high organic reinvestment rate.

## Working capital — the cycle and its sign

True operating working capital is small and stable across this sector — accrued compensation, prepaid data and market-data licensing, fee receivables — because the large balance-sheet items (client cash, segregated cash, settlement receivables and payables) are custodial or clearing balances, not working capital the fee or spread business consumes or generates. Exclude them from operating working capital and from the change in working capital; they belong nowhere in the free-cash-flow chain except as the balance that produces a broker's net interest income.

## Tax and WACC notes

Effective tax rates sit close to the US statutory rate for the domestically-concentrated names in this sector — unlike technology, there is no IP-migration structure lowering it. Exchanges and payment networks with meaningful non-US revenue run modestly below statutory; brokers and traditional asset managers run closest to it. Carried interest at alternative managers has historically been taxed at capital-gains rates below ordinary income and is a recurring legislative target — a terminal tax rate that assumes today's treatment persists forever is a policy bet, and it should be named as one.

Beta needs the operating-leverage layer on top of ordinary market beta: an asset manager's revenue is a fee applied to a balance that itself tracks the market, so its earnings beta exceeds the beta of the market it is invested in, and further exceeds it wherever performance fees add a second, cycle-amplifying layer. Exchange revenue is comparatively defensive — volatility (their transaction driver) often rises when the broad market falls, which caps their beta below the sector's other names. For brokers, client cash held for customers is not the issuer's financing debt; do not fold it into the debt weight or the equity bridge's debt row.

## Terminal — what steady state means here

Terminal for a traditional asset manager assumes fee compression from the passive shift has largely finished repricing the book, and the flow/market-appreciation split converges to a modest net-flow assumption plus a market-appreciation rate near a long-run reference level. Terminal for an alternative manager is dominated by fee-related earnings; performance fees fade to a modest, cycle-averaged share of the total rather than the outsized share a strong vintage produces in any single explicit year. Terminal for an exchange assumes transaction volume grows near nominal GDP with a stable or slowly rising data/subscription share of revenue. Terminal for a payment network assumes the take rate has found its post-regulatory, post-competition level and that the secular conversion from cash to card has substantially completed, removing the volume tailwind that inflates the explicit years. Terminal for a broker assumes net interest income reverts to a normalized rate environment, not whatever cycle the final forecast year happens to sit in — check the final year against a mid-cycle rate assumption before capitalizing it.

## Terminal-state calibration bands

These bands describe the **steady state only** — the economics this sector settles into once the current market cycle, flow trend, fundraising vintage and rate cycle are all behind it. They say nothing about next year and must not be used to set a near-term assumption: the explicit years are anchored on the issuer's own history, disclosures and the causal case built for them, and a sector band that competed with that evidence would win for the wrong reason. Terminal is the one place the issuer's own history cannot speak, because it is by construction the state after everything that history covers. Read the bands as triage — inside the band needs the ordinary rationale, outside it needs evidence naming what makes this issuer's steady state different — never as the target the number should hit.

Terminal capex and D&A converge to a single steady-state reinvestment intensity, because a steady state replaces the asset base rather than expanding it. Terminal growth cannot exceed long-run nominal GDP.

| terminal driver | steady-state band | what puts an issuer at each end |
| --- | --- | --- |
| revenue growth | 3-5% | alternative managers and payment networks with a structural share-of-wallet tailwind near the ceiling; a traditional active manager losing share to passive near the floor. Nothing here escapes nominal GDP |
| operating margin — traditional and active asset managers | 25-40% | scaled, largely-passive-and-fixed-income mix near the ceiling; a smaller active-equity-heavy manager still carrying full distribution cost near the floor |
| operating margin — alternative asset managers (fee-related earnings) | 40-55% | a scaled, diversified-strategy manager with a mature fee-AUM base near the ceiling; a newer or single-strategy manager still building scale near the floor |
| operating margin — exchanges and data/index providers | 50-65% | a pure transaction/clearing franchise near the ceiling; a heavily acquisitive data and index business still amortizing purchased intangibles near the floor |
| operating margin — payment networks | 55-65% | incentive intensity and regulatory cap exposure set the floor; a network with light exposure to interchange regulation sits at the ceiling |
| operating margin — payment processors | 20-35% | scale and proprietary rails near the ceiling; a labor-intensive, pass-through-heavy processing book near the floor |
| operating margin — retail brokers | 35-55% | a highly automated, low-headcount platform near the ceiling; an advisory-heavy, human-capital-intensive brokerage near the floor |
| realized fee rate on AUM | 20-150 bps | a scaled, passive-and-fixed-income-heavy traditional manager near the floor; an alternative manager's fee on committed capital near the ceiling. Structural compression toward the floor is the default direction for traditional active management, not a one-time reset |
| organic net flows, % of beginning AUM | -2% to +4% | a manager losing share to passive or facing performance headwinds sits negative; a differentiated or alternatives-heavy platform sits positive |
| compensation to revenue — traditional asset managers | 25-35% | scale and a largely-passive mix near the floor; a boutique, talent-dependent active manager near the ceiling |
| compensation to revenue — alternative asset managers (fee-related earnings basis) | 18-25% | a mature, scaled platform near the floor; a newer manager still building out deal teams ahead of fee-AUM near the ceiling |
| effective tax rate | 21-26% | domestically concentrated brokers and traditional managers near the ceiling; exchanges and payment networks with international mix near the floor |
| reinvestment intensity (capex and D&A, as a share of revenue) | 2-5% | technology-platform-heavy franchises near the ceiling; a low-headcount, minimal-infrastructure fee collector near the floor. Whichever level, capex and D&A converge there together |
| operating NWC / revenue | -5% to +5% | small and near-zero for most names; a receivables-heavy institutional fee book sits positive, an issuer that bills and collects fees in advance sits negative. Client cash, settlement balances and segregated cash never enter this row |
| beta (through-cycle, a WACC input rather than a terminal one) | 0.8-1.7 | exchanges sit near the floor because volatility is a natural hedge to their own transaction revenue; alternative managers sit near the ceiling because performance fees add a second layer of market exposure on top of AUM-linked fee revenue |
| terminal growth | 2-4% | never above long-run nominal GDP; alternative managers and payment networks with a durable structural tailwind sit near the ceiling |
| exit multiple — traditional asset managers, P/E | 10-16x | scale and flow stability near the ceiling; persistent net outflows near the floor |
| exit multiple — alternative asset managers, P/FRE ex-carry | 15-22x | a diversified, scaled fee-related-earnings base near the ceiling; a young or single-strategy platform near the floor. Never apply this multiple to a performance-fee-inclusive earnings base |
| exit multiple — exchanges and data/index providers, EV/EBITDA | 14-20x | a data/index-heavy revenue mix near the ceiling; a purely transactional, volume-cyclical franchise near the floor |
| exit multiple — payment networks and processors, EV/EBITDA | 12-24x | pure networks (V, MA) near the ceiling; processors near the floor, reflecting the margin gap above |
| exit multiple — retail brokers, P/E | 12-18x | a diversified, automation-heavy platform near the ceiling; a rate-cycle-dependent, NII-concentrated broker near the floor |
| take rate, net of incentives, % of gross payment volume | 0.3-0.6% | a network with light incentive competition near the ceiling; heavy portfolio competition and incentive escalation near the floor |
| net interest income, % of broker total revenue | 15-55% | a banking-license-heavy platform (large sweep balances) near the ceiling; an advisory-fee-driven brokerage with little balance-sheet business near the floor |

## Failure modes specific to this sector

- **A single AUM growth rate standing in for two claims.** Blending net flows and market appreciation into one growth number hides a market-return forecast inside what reads as a franchise (flow) assumption, and that market-return forecast is close to circular once it is discounted at a cost of equity built on the same market.
- **Carried interest and performance fees treated as recurring cash flow.** Capitalizing a strong vintage's performance fees into the terminal value assumes every future vintage performs as well as the best one in the historical record; they belong in a separate, wider-banded scenario, not the base case perpetuity.
- **Client payables, settlement balances or segregated cash mapped into debt.** These balances belong to clients; folding them into the debt row or WACC weights manufactures leverage the issuer does not have and misprices both the discount rate and the equity bridge.
- **A flat terminal fee rate for a traditional active manager.** The passive shift is structural, not cyclical; holding the realized fee rate at its current level into terminal ignores the single most persistent trend in this sub-model's history.
- **A broker modeled as a pure fee business.** Forecasting broker revenue as one blended growth rate off assets or accounts, without separating net interest income and its rate and cash-sorting drivers, misses the majority driver at several of this sub-model's largest names and understates the issuer's rate sensitivity and beta.
- **Payment network gross revenue extrapolated without incentive escalation.** Client incentives grow with contract renewals; a gross-volume-times-take-rate forecast that does not grow the contra-revenue line as fast overstates net revenue every year of the forecast.
- **Exchange margin history read straight off GAAP without adjusting for acquisition amortization.** An acquisitive data and index franchise's margin trend is understated by purchased-intangible amortization that has nothing to do with the transaction or subscription economics; forecasting off the unadjusted trend either overstates the improvement needed or misreads a stable business as improving.
- **Reinvestment inflated by treating acquisitions as organic capex.** A roll-up strategy at an asset manager or an exchange's data-business acquisitions are growth capital, not maintenance; blending them into capex-to-revenue produces an implausible organic reinvestment rate and breaks the terminal capex/D&A parity check.
