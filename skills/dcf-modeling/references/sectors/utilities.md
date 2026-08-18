# Sector playbook — Utilities

Covers regulated electric, gas and water utilities and multi-utility holding companies (NEE, DUK, SO, D, AEP, XEL, WEC, AWK), and independent power producers / merchant generators (VST, NRG, CEG, Talen). The structural fact that inverts the generic chain for the regulated names: capex is not a cost of doing business, it is the growth engine. Earnings are the allowed return on the equity share of the rate base, so the company grows by spending capital, and a forecast that trims capex to lift free cash flow has just forecast lower earnings. Merchant generators share none of this — they sell power into a market with no allowed return — and need a different chain entirely, given below as its own track.

## Chain shape — what to build instead of the default

Decide which track the issuer sits on before writing a single formula; a holding company (D, then-Dominion-style) can carry both and needs each segment routed separately.

### Regulated (rate-base) track

Build the chain off rate base, not off demand. Electricity and gas volumes grow roughly flat — efficiency gains offset electrification for now, except in a handful of data-center-heavy territories. Revenue is what the regulator allows the utility to collect: rate base times the allowed return on equity, plus dollar-for-dollar recovery of fuel, purchased power and most operating costs through trackers and riders. The forecast that matters is rate base growth off the disclosed multi-year capital plan, the allowed ROE granted in the last rate case, the authorized equity layer in the capital structure, and the gap between earned and authorized return that regulatory lag opens up. Rate case filings and test years are dated, named events — treat an upcoming case as a forecastable step change, not noise to smooth over.

### Merchant / IPP track

No rate base, no allowed return, no trackers. Revenue is energy sold at the market clearing price (the spark spread over fuel cost for thermal, or the wholesale price captured by the fleet), plus capacity payments from the relevant capacity market (PJM, ERCOT is energy-only), plus whatever share of output is hedged forward or sold under bilateral power-purchase agreements. Build this as a commodity chain: forecast the hedge book's known-priced volume separately from open merchant volume, forecast capacity revenue off cleared capacity-market prices and the fleet's cleared MW, and treat fuel cost as its own line moving with the same commodity curves. Terminal value here is a commodity-cycle claim, not a growth claim — see Terminal below.

## Revenue — the decomposition that pays

### Regulated

Decompose the allowed-revenue build explicitly: rate base level (prior rate base plus net capex financed) times the authorized ROE times the authorized equity fraction, plus a debt-return component at the authorized cost of debt on the debt fraction, plus O&M and fuel/purchased-power dollars recovered through separate trackers. State each rate case's allowed ROE, equity layer and effective date as named inputs, not as one blended "revenue growth" number — a rate case decision moves the model at a specific date, the way a product launch moves a software model. Between cases, revenue tracks rate base growth at the prior case's authorized terms; regulatory lag is the gap between what the rate base earns and what the last case authorized, and it narrows or widens with how fast rate base is growing relative to the case cadence.

Water utilities and gas local distribution companies run the same rate-base mechanic with two differences worth naming: the capital plan is driven by pipe and main replacement and non-revenue-water reduction rather than by load growth, and system consolidation — acquiring small municipal or investor-owned systems into the regulated rate base — is an additional, sector-specific growth lever with no analog in electric generation or transmission. Treat a disclosed acquisition pipeline as its own named addition to rate base growth, sized to what has actually closed or been filed, not to management's aspirational total addressable count.

### Merchant / IPP

Split revenue into hedged (known price, known volume, from disclosed forward sales and PPAs) and open (market-price exposure). Forecast capacity revenue off the specific capacity market's cleared auction prices for the relevant delivery years — these are public, dated clearing prices, not a growth rate. Do not smooth capacity and energy margin into one blended per-MWh number; capacity revenue is contracted and low-variance, energy margin is not.

A fast-growing third bucket sits between the two: multi-decade, fixed-price power purchase agreements with hyperscale data-center buyers, frequently anchored to nuclear or gas capacity, priced well above historical merchant power levels and carrying investment-grade corporate counterparty credit rather than a utility offtaker's regulatory backing. Model a signed contract of this kind as its own tranche with the contract's own price, term and counterparty — it behaves like a long-dated fixed-income instrument, not like merchant energy, and should not be blended into the open or ordinary-PPA buckets above.

## Cost and margin — the level the story lives at

### Regulated

Most operating cost is not a margin lever at all — fuel and purchased power pass through trackers dollar for dollar, so a spike in gas prices does not compress margin, it compresses timing (see Working capital). The real margin story is the spread between allowed O&M recovery and actual O&M spend: an operator holding O&M growth below the rate case's assumed level earns above its authorized ROE until the next case resets it; one whose O&M outruns the allowance earns below it. State which side of that gap the issuer sits on and why it persists or closes at the next filing.

### Merchant / IPP

Margin is the spark spread (or dark spread for coal, spread to fuel cost generally): power price received less the marginal fuel cost of the marginal unit dispatched, times the fleet's heat-rate efficiency. Nuclear and hydro carry near-zero marginal fuel cost, so their margin moves almost one for one with power price; gas-fired margin moves with the gas-to-power spread, which can compress independently of either commodity's level.

## Reinvestment — capex, D&A, and what maintenance means here

Capex running well above depreciation for a decade is the correct, disclosed state of a regulated utility in a capital programme — it is what grows the rate base, and it is not a modelling error to be faded down. Forecast capex off the issuer's own multi-year capital plan, not off a capex-to-revenue ratio, because the plan is the causal driver and the ratio is only its shadow. Depreciation is set largely by the regulator's approved book lives, so it need not track any economic useful-life logic — treat the regulator's depreciation schedule as the anchor, not a modelled D&A ratio. Allowance for funds used during construction (AFUDC) capitalizes a return on construction work in progress before it enters rate base as a non-cash addition to both income and the asset base; where the issuer discloses it, it belongs in the FCFF build as a non-cash item to strip out of NOPAT, the same way D&A is added back, or the forecast overstates cash generation during heavy construction years. Securitized storm-cost or extreme-weather recovery bonds fund a specific regulator-approved cost recovery outside the normal capital plan — model their debt service and recovery revenue as a matched pair, not as ordinary capex or ordinary debt.

Large-load interconnection requests — hyperscale data centers seeking gigawatt-scale service — are now a named, dated item in many regulated capital plans and rate case filings, frequently paired with minimum-take contracts or special tariffs that shift some demand risk back onto the customer requesting it. Treat a disclosed large-load pipeline as an explicit addition layered on top of the flat organic-demand baseline described under Revenue, sized to what has converted from announced request to signed, in-service agreement rather than to the full headline gigawatt figure utilities routinely disclose.

## Working capital — the cycle and its sign

Fuel and purchased-power cost trackers create a regulatory asset (utility under-recovered, owed cash back) or regulatory liability (utility over-recovered, owes customers) whenever the commodity price the utility paid diverges from the price baked into current rates. This swings with commodity price timing lags, not with revenue growth — a gas price spike this year and its recovery next year shows up as a working-capital swing with no margin effect at all. Do not model this working-capital component as scaling with revenue; tie it to the disclosed regulatory asset/liability balance and its recovery schedule instead. Pension funding status is unusually large on a utility balance sheet relative to its market cap and belongs in the equity bridge, not buried in working capital.

## Tax and WACC notes

### Tax

A statutory tax-rate assumption is simply wrong here. Accelerated tax depreciation, normalization rules that require the tax benefit of that acceleration to flow back to customers over the asset's book life rather than immediately, and production and investment tax credits on wind, solar and storage assets push cash taxes and the effective rate far below 21% for years — often to near zero or negative in heavy-build years. Deferred tax liabilities are correspondingly enormous and are a real, disclosed balance-sheet item, not a modelling artifact. Forecast the effective rate off the issuer's own credit-generating asset mix and its multi-year deferred-tax trajectory, and state the terminal rate as a judgment about how much of the current credit and accelerated-depreciation benefit survives once the current build slows (see Terminal).

Accumulated deferred income taxes are not a balance-sheet memo item: regulators subtract the ADIT balance from rate base because it represents capital effectively financed at zero cost, so a growing ADIT balance from continued accelerated depreciation is a modest, structural drag on rate base growth at the same time as it lowers cash taxes — model the two together rather than treating the tax benefit and the rate-base growth it dampens as unrelated.

### WACC

Leverage here is structurally high and deliberately regulator-sanctioned — it is close to the authorized capital structure, not a market choice to relever. Beta sits among the lowest in the market because regulated cash flows are close to a bond substitute; that same bond-like character makes equity value unusually sensitive to the discount rate and to the tenor of the risk-free rate chosen, more than in almost any other sector, because so much of the value sits in a terminal that is being discounted back over decades. The regulator's own authorized ROE is a market-observable, third-party estimate of the cost of equity for this exact business — read the model's cost of equity against it as a sanity check, not as a substitute for the standard estimation, and explain a material gap. In the bridge: AFUDC-financed construction work in progress not yet in rate base, securitized storm-recovery debt (often excluded from the utility's own leverage covenants because it is customer-charge-backed, not general obligation), and the pension funded-status figure all belong as named bridge items, not folded into "debt" or ignored.

### Merchant / IPP

Beta runs materially higher than the regulated track — commodity-price and capacity-market exposure with no allowed-return floor makes these among the most cyclical names in the broader utility sector, closer to a commodity producer than to a rate-base utility. Do not apply a regulated-utility beta to an IPP merely because the ticker sits in the same GICS bucket.

## Terminal — what steady state means here

### Regulated

The central tension: a DCF terminal state requires capex to converge to depreciation, because steady state means replacing the existing asset base, not expanding it. A regulated utility's whole equity story through the explicit years is the opposite — rate base growing faster than depreciation, funded by continuous capex above D&A. Terminal is where that has to end: terminal growth for a regulated utility is, in substance, a claim about long-run rate base growth, and rate base growth is bounded by what customers' bills can absorb before regulators or legislators intervene, which in turn is bounded by nominal GDP. A terminal case that keeps capex above D&A forever is asserting the rate base compounds faster than the economy indefinitely with no regulatory or affordability pushback — state explicitly, if you assume any capex/D&A gap persists into the terminal year, what caps it and why it is temporary rather than structural. The honest resolution in most cases is to let the explicit forecast carry the still-elevated build programme and let capex and D&A converge only at the terminal boundary itself.

### Merchant / IPP

There is no rate base to converge and no regulator-set ceiling. Terminal here is a claim that the commodity cycle has normalized: power prices sit at a long-run marginal-cost equilibrium (new-entry cost for the marginal technology, typically gas or the prevailing renewable-plus-storage combination), and capacity prices sit at whatever level clears enough new entry to meet the reserve margin — not at today's tight, elevated auction clears. A terminal case built off today's power and capacity prices smuggles in a cyclical peak as if it were permanent; say explicitly whether the terminal margin assumes today's tightness persists or reverts, and why.

## Terminal-state calibration bands

These bands describe the steady state only — the economics the business settles into once the current capital programme, rate-case cycle or commodity cycle is over, not next year. The explicit years are anchored on this issuer's own capital plan, rate cases and disclosed hedge book; a sector band competing with that evidence for the explicit years would be the wrong master and would win for the wrong reasons. Terminal is the one place the issuer's own history cannot speak, because it is by construction the state after everything that history covers. Read the table as triage: an assumption inside its band needs the ordinary rationale, one outside it is a claim that this issuer's steady state differs from its sector's, and that claim needs evidence naming what makes it durable — the band never picks the number.

For the regulated track, terminal capex must converge toward depreciation — this is the one point in the whole regulated narrative where that convergence is required and correct, precisely because it does not hold anywhere in the explicit years (see Terminal above). Terminal growth cannot exceed long-run nominal GDP, and for a regulated utility it is in practice well below GDP because bill affordability binds first.

| terminal driver | steady-state band | what puts an issuer at each end |
| --- | --- | --- |
| revenue / rate base growth — regulated | 3-5% | a slow-growth, no-electrification service territory near the floor; a territory with durable data-center or industrial load growth and continued regulatory support for capital investment near the ceiling — never above nominal GDP |
| allowed ROE — regulated (cost-of-equity cross-check) | 9-10.5% | favorable, constructive commissions (Southeast, parts of the Midwest) near the ceiling; adversarial or politically pressured commissions (parts of the Northeast, California) near the floor |
| authorized equity layer | 45-55% | water utilities and smaller gas LDCs cluster at the top; large multi-state electric holdcos cluster lower |
| operating margin — regulated | 20-30% | trackers insulate this margin from commodity swings, so the band is narrow; position within it reflects the earned-vs-authorized ROE gap (Cost and margin above), not commodity exposure |
| reinvestment intensity (capex, and D&A, as a share of revenue) — regulated, terminal | 12-18%, one level capex and D&A both approach | this is a steady-state replacement level, not the elevated build-cycle ratio in the explicit years — do not carry a near-term capex/revenue ratio into this row |
| operating working capital / revenue — regulated | -2% to +3% | driven by the net regulatory asset/liability position from fuel-cost trackers, not by revenue scale; near zero for a utility with tight, frequent trackers, more positive for one with slow cost-recovery mechanisms |
| effective tax rate — regulated, terminal | 8-16% | assumes some credit-generating renewable buildout and accelerated depreciation continue; a rate near 21% asserts the credit and normalization structure has largely run off, which needs its own evidence |
| through-cycle beta — regulated | 0.35-0.65 | pure-wires, no-generation utilities near the floor; utilities with meaningful unregulated generation or merchant exposure inside a holding company drift toward the ceiling |
| exit multiple — EV/EBITDA, regulated | 9-13x | slower-growing, higher-risk-commission utilities near the floor; utilities with strong constructive regulation and durable rate-base growth near the ceiling |
| revenue / margin growth — merchant/IPP, terminal | long-run marginal-cost equilibrium, not a growth rate | terminal power price should equal the new-entry cost of the marginal generation technology in the relevant market; do not fade to a % growth number, fade to that price level |
| effective tax rate — merchant/IPP, terminal | 15-21% | credits fade as the renewable buildout plateaus faster here than at a regulated peer with a continuing rate-base programme |
| reinvestment intensity — merchant/IPP, terminal | 8-14% of revenue, capex and D&A converging | maintenance-only fleet replacement once the current build (gas peakers, data-center-driven builds) is complete; no rate base to expand into |
| through-cycle beta — merchant/IPP | 1.1-1.6 | nuclear- and hydro-heavy fleets with high hedge coverage near the floor; gas-heavy fleets with open commodity exposure near the ceiling |
| exit multiple — EV/EBITDA, merchant/IPP | 7-11x | short-dated capacity contracts and thin hedge books near the floor; long-dated contracted revenue (data-center PPAs, nuclear capacity locked years out) near the ceiling |

## Failure modes specific to this sector

- **Trimming capex to improve free cash flow.** For the regulated track this has forecast lower rate base and therefore lower earnings — it is not a free lever, it is the opposite of the growth story the issuer is telling.
- **A statutory or near-statutory terminal tax rate.** Ignores that normalization rules and renewable credits are structural, disclosed features of this sector's tax position, not temporary noise.
- **An enterprise-level forecast that misses the dilution.** Funding a multi-year capex programme while holding the authorized equity ratio requires continuous equity issuance; an FCFF chain that looks fine at the enterprise level can still overstate per-share value if the forecast does not grow diluted shares to match the financing plan implied by the capital programme.
- **Terminal capex forced to equal D&A inside the explicit years.** Collapses the capex/D&A gap before the disclosed capital plan says it closes, understating the very growth the issuer is executing on.
- **Terminal capex left permanently above D&A with no bound stated.** The opposite error — asserts unbounded rate-base compounding with nothing said about the affordability or regulatory ceiling that stops it.
- **Applying a regulated-utility beta or WACC to a merchant generator, or vice versa**, because both tickers carry a "utility" GICS label — the two have almost nothing in common in risk or cash-flow shape.
- **Reading a commodity-price-driven working-capital swing as a margin change.** A fuel-tracker regulatory asset building up looks like deteriorating cash conversion; it is a timing lag against a dollar-for-dollar recovery mechanism, not a cost the utility is absorbing.
- **Terminal-valuing an IPP off today's power and capacity prices** during a tight cycle, carrying a cyclical peak into a number meant to describe forever.
- **Extrapolating a hyperscale interconnection pipeline as if fully contracted.** Announced large-load requests convert to signed, energized demand at a fraction of the headline gigawatt figure; carrying the full pipeline into the revenue or capital-plan forecast overstates both the load and the rate base it would justify.
