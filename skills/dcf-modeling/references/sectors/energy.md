# Sector playbook — Energy

Covers Oil & Gas Exploration & Production (XOM, CVX, COP, EOG, DVN, FANG), Oil & Gas Equipment & Services (SLB, HAL, BKR), Refining & Marketing (MPC, VLO, PSX), and Oil & Gas Storage & Transportation / midstream (KMI, WMB, OKE, ET). The structural fact that dominates every sub-industry except midstream: the asset a producer sells against is a finite, physically depleting resource priced by a market the company does not influence, so both the revenue line and the terminal claim behave unlike any other sector — growth is not a management choice, it is a race against decline, and steady state is not a resting point, it is a replacement problem.

## Chain shape — what to build instead of the default

- Decide which of the four business models you are chaining before writing a single driver: an integrated major spans more than one, and each segment needs its own sub-industry logic below rather than one label applied to the consolidated statement — an issuer with an upstream segment and a downstream refining segment is two stories, not one.
- The FCFF mechanics hold for all four sub-industries; the break is in the terminal machinery, not the explicit-year chain. The engine offers only a perpetuity-growth or an exit-multiple terminal, and neither, taken at face value, prices a depleting reserve base correctly.
- Resolve early, and say explicitly in the Terminal section, whether this issuer's reserve inventory can support a perpetuity claim or whether you are approximating a decline-and-replace steady state instead of accepting the default terminal machinery's silent assumption of infinite reserve replacement.
- Declare the hedge-accounting treatment before writing a single price assumption: realized price (what actually hit revenue, hedges included) and mark-to-market hedge gains or losses (a non-cash swing that does not belong in the operating forecast) are different lines, and conflating them puts a paper gain or loss into the cash-flow story.

## Revenue — the decomposition that pays

### Exploration & production

- Revenue is production volume times realized price, and those are two forecasts joined by a third: realized price is the benchmark (WTI, Brent, Henry Hub) less a basis differential specific to the issuer's basin and takeaway capacity, then adjusted for the hedge book on the barrels actually hedged. Model the three separately — collapsing them into one blended price-per-boe erases exactly the information a reader needs, since differentials widen when local takeaway is constrained and hedges roll off on a known schedule, leaving only the unhedged tail with full commodity exposure.
- Take the price path from the forward strip, not from spot or a historical trend, and say why spot is the worst of the choices available: spot is a single day's clearing price with no claim on any future period, and a trend extrapolated from a mean-reverting commodity compounds the current cycle's direction indefinitely — the one thing a mean-reverting price never does. The strip is the market's own forward curve and exists for exactly this purpose.
- Production is not a free assumption; decline is physical. A flat-production forecast is a claim that every year's decline was fully offset by new drilling, and that claim carries a capex cost — see Reinvestment.
- Shale decline is front-loaded and steep, with most of a well's lifetime output produced in its first two to three years; conventional and offshore assets decline slower but for longer, and carry a materially different capital cadence and a longer lead time from investment to first oil. Do not apply one decline shape across a shale-plus-conventional portfolio.

### Midstream (storage & transportation)

- Do not forecast midstream on commodity price. Revenue is contracted throughput or capacity times a tariff, largely insulated from price by fee-based, often take-or-pay or minimum-volume-commitment contracts — price reaches this revenue line only through the volumes its upstream customers choose to produce and ship, never directly.
- Forecast off contracted volumes, tariff escalators (frequently indexed to a published inflation measure or a regulatory formula), and contract renewal or recontracting risk at the tenor where existing agreements expire — that renewal date, not a growth rate, is where the real uncertainty sits.
- Expansion projects add a step function to volume and revenue on their in-service date, not a smooth growth curve; model a disclosed project as a named event with its own start date and ramp, not blended into the base growth rate.

### Refining & marketing

- Revenue is a near dollar-for-dollar pass-through of crude cost plus a margin, so a consolidated revenue growth rate or a margin-on-revenue ratio is close to meaningless: a crude price spike inflates revenue and drives margin-on-revenue down even when the refiner's actual economics improved.
- Build the chain from throughput volume (barrels processed, bounded by nameplate capacity and utilization) times the crack spread the issuer's crude and product slate actually earn, not from a revenue growth assumption.
- Utilization, not capacity, is the near-term lever — a refiner does not add nameplate capacity in a normal forecast horizon, so period-to-period volume changes come almost entirely from planned or unplanned downtime and throughput optimization, not from new capacity coming online.

### Oilfield services

- Revenue is a derivative of customer capital spending and active rig or frac-fleet count, one step removed from the commodity price that actually moves it — an E&P's price deck decides whether it drills, and only that decision reaches the services company.
- Forecast off activity levels (rig count, completions, fleet utilization, dayrates or pricing per stage) for the basins and product lines the issuer actually serves, not off a commodity price applied directly.
- International and offshore activity lags North American land activity by several quarters and is contracted on longer terms, so a single global activity assumption blends two cycles running out of phase with each other.

## Cost and margin — the level the story lives at

### Exploration & production

- Forecast the cost stack as unit metrics, not a margin percentage: cash operating cost per barrel of oil equivalent (lease operating expense, gathering and processing, production taxes, transportation), finding and development cost per boe added, and the recycle ratio (netback per boe over F&D cost per boe) that tells you whether the last dollar of drilling capital was profitably spent.
- These unit metrics are the honest cost forecast in a business where the margin percentage swings entirely with a price the company does not set — a margin history is a price history in disguise, not a cost-structure history.

### Midstream

- Operating cost is largely fixed (compression, maintenance, labor) against contracted, largely volume-insensitive revenue, so operating margin is structurally high and stable — model it as a cost base growing with inflation and throughput-linked maintenance, not as a ratio that tracks revenue.

### Refining & marketing

- Margin is the crack spread the issuer captures (its own crude and product slate against a benchmark spread such as 3-2-1) times throughput, less operating cost per barrel; a dollar move in the blended crack spread swings annual margin by a multiple of that dollar times total throughput, which is the operating leverage that makes a single spot-margin year a bad base to forecast from.
- Renewable fuel obligation costs (or equivalent compliance credit purchases) are a real, volatile operating cost layered on top of the crack spread, not a rounding item — a period of rising credit prices compresses realized margin even with an unchanged crack spread.

### Oilfield services

- Extreme operating leverage: a high fixed-cost base (crews, equipment, facilities) against activity-driven revenue means margin compresses violently in a downturn and expands violently in a recovery. Do not fade margin smoothly across a cycle the activity forecast itself already says is cyclical.
- Pricing, not just volume, drives the swing: dayrates and per-stage pricing collapse in oversupplied conditions well before activity counts fall, and recover before activity counts rise — treat price and volume as two levers, not one.

## Reinvestment — capex, D&A, and what maintenance means here

- Depletion is typically recognized on a unit-of-production basis tied to produced volume against booked reserves, not straight-line against asset life, so D&A moves with production and reserve revisions in a way capex does not automatically mirror — the two can decouple for years without either being wrong. Do not read a capex/D&A gap here the way you would in an asset base depreciated on a fixed schedule.
- For E&P, maintenance capex is the spend required to hold production flat against the decline curve, and it is large: a forecast that holds volume flat while letting the capex ratio fall is asserting the reservoir stopped depleting, which it did not. Growth capex sits on top of that maintenance floor and should be justified by named drilling inventory, not by a blended ratio.
- For midstream, capex is either sustaining (integrity management, compression replacement) or contracted growth (a new pipeline or terminal backed by signed shipper agreements) — treat the two separately, since only the first belongs in a steady-state reinvestment ratio; folding an announced growth project into a flat maintenance ratio either overstates steady state or hides the project's own return.
- For refining, capex is dominated by turnaround maintenance (periodic, mandatory, unit-by-unit, and lumpy in the year it falls) plus regulatory and reliability spending; there is essentially no organic capacity-growth lever, since capacity additions in a mature refining market are rare and expensive.
- For oilfield services, reinvestment is equipment replacement and technology upgrades that track fleet age and utilization, and it is the first spending category cut in a downturn — a capex ratio held flat through a modeled activity trough overstates cash outflow exactly when the issuer itself would be deferring it.
- Asset retirement obligations (plugging and abandonment for E&P, decommissioning for midstream and refining assets) are a real future cash cost outside the ordinary capex line; they belong in the equity bridge as a debt-like obligation, not folded silently into either capex or ignored.

## Working capital — the cycle and its sign

- E&P and midstream working capital is small relative to revenue — mostly receivables from purchasers or shippers against modest payables, with little inventory, since production is sold as it flows rather than warehoused.
- Refining is the opposite: crude and refined-product inventory is large, and its dollar value swings with the crude price itself, so a working-capital ratio built off a high-price year overstates the cash tied up at a lower price and vice versa. Normalize inventory in physical-volume terms before ratio-ing it back to a revenue forecast that itself moves with price.
- Oilfield services carries meaningful receivables against equipment and materials inventory, and collection terms lengthen exactly when customers are cutting activity — working capital is a cash drag precisely in the part of the cycle that can least afford it.

## Tax and WACC notes

- Effective tax rate across all four sub-industries sits close to the statutory federal rate plus state income and production-based taxes (severance, ad valorem) that do not move with profitability the way an income tax does. Treat production taxes as a cost line tied to revenue or volume, not as part of the income-tax rate.
- Many midstream issuers are structured as partnerships or converted former partnerships. Where a partnership structure survives, distributable cash flow and distribution coverage — not net income — govern what can be paid out, and unit count rather than share count, plus any surviving incentive-distribution-rights economics, changes what the equity bridge and per-unit value mean; confirm which structure applies before building the bridge.
- Through-cycle beta is high and dispersed across the sector: highest in oilfield services, where operating leverage amplifies every commodity swing; high in E&P, levered directly to price; lowest in midstream, whose contracted cash flows behave closer to a utility; refining sits in between, levered to the crack spread rather than to crude price directly. Do not apply one "energy beta" across an integrated issuer spanning several of these.
- Cost of debt for the sector is sensitive to commodity-price-linked credit ratings — a producer's bond spread widens in a downturn independent of anything the company itself did, so a stale or trailing cost-of-debt figure understates financing cost precisely when the forecast most needs to reflect stress.

## Terminal — what steady state means here

- Terminal value is genuinely problematic for a pure-play E&P, and you must say so rather than let the default machinery answer quietly. A perpetuity assumes the company replaces its produced reserves forever at an economic finding cost — for an issuer with a defined, disclosed inventory of drilling locations, that is a checkable claim, not a formality: state the reserve life (years of proved reserves at the current production rate) and the implied annual replacement spend at the issuer's own recent finding cost.
- Where inventory depth is short relative to the forecast horizon, say plainly that a perpetuity overstates value, because it is paying for reserves the issuer has not shown it can find.
- Two ways to be honest inside the engine's terminal machinery, in order of preference: extend the explicit forecast far enough to model the decline-and-replace (or decline-to-exhaustion) path directly with named volume and capex formulas, so the terminal year is genuinely representative rather than a peak-inventory year capitalized forever; or, if a perpetuity terminal must be used, set terminal growth low — at or below zero — as the closest honest proxy to a maturing, self-funding asset base, rather than defaulting to a GDP-adjacent figure that assumes reserve growth the disclosed inventory does not support.
- Either way, report a reserve-based cross-check (value per proved reserve barrel, or an externally sourced PV-10) alongside the DCF output as a sanity bound the engine cannot compute itself, not as a row inside the model.
- Treat the energy-transition demand overlay as a terminal question — a multi-decade claim about whether the product category still exists at the horizon — not as a near-term forecast line; it belongs in the same sentence as the reserve-life discussion, not folded into next year's price deck.
- Midstream terminal value is comparatively ordinary: it is a claim that the contracted, fee-based cash flow persists and recontracts near current terms, so the relevant terminal question is renewal risk and tariff escalation, not physical depletion.
- Refining terminal value rests on a mid-cycle crack spread, never the current one — capitalizing a peak or trough margin year into perpetuity inherits whichever half of the cycle the forecast happened to end on.
- Oilfield services terminal value likewise must sit on mid-cycle activity and margin, not on whatever phase of the rig-count cycle the final forecast year lands in.
- Across every sub-industry, the commodity price (or crack spread, or activity level) behind the terminal year must be a mid-cycle assumption, never the price on the day you are building the model.

## Terminal-state calibration bands

These bands describe the steady state only — the economics the business settles into once the explicit forecast's decline profile, contract book or build programme has played out, growth has normalized, and (for E&P specifically) the terminal method chosen above has already resolved whether a perpetuity is even the right structure. They say nothing about next year and must not be used to set a near-term assumption: the explicit years are anchored on this issuer's own history, disclosed reserves and forward strip, and a sector band sitting next to that evidence would compete with it and win for the wrong reasons. Terminal is the one place the issuer's own history cannot speak, because it is by construction the state after everything the history covers.

Read the table as triage, not as a target: a terminal assumption inside its band is ordinary and still needs its own rationale; one outside it is a claim that this issuer's steady state differs from its sector's, and that claim needs evidence naming what makes it durable. Terminal capex and D&A converge to one steady-state reinvestment intensity — a steady state replaces the asset base rather than expanding it — except that for E&P this convergence point is high relative to other sectors, because replacing a depleting reserve base costs far more per dollar of revenue than replacing a factory. Terminal growth cannot exceed long-run nominal GDP growth, and for E&P specifically a positive terminal growth rate is itself a reserve-replacement claim that needs the reserve-life evidence from the Terminal section above, not just a GDP ceiling.

| terminal driver | steady-state band | what puts an issuer at each end |
| --- | --- | --- |
| revenue growth | E&P 0-2%; midstream 2-4%; refining 0-1%; oilfield services 1-3% | E&P sits near flat because terminal volume is a replacement claim, not a growth claim, capped further by the GDP ceiling; midstream tracks contracted volume and escalator growth; refining is capacity-capped with no organic growth lever; services tracks E&P capex growth one step removed |
| terminal commodity price basis | WTI-equivalent real price roughly flat at a mid-cycle level, not the spot price on the modeling date; Henry Hub equivalently mid-cycle | an issuer priced off the current strip's near-term contango or backwardation at the terminal year is capitalizing a temporary market condition, not a steady state |
| cash operating margin (E&P) / crack-spread margin (refining) | E&P cash operating margin (netback over revenue) 55-70% mid-cycle; refining margin-on-revenue is not a meaningful terminal metric — state the mid-cycle crack spread and throughput utilization instead | low-cost basins (Permian, Marcellus) and low basis differentials sit at the top for E&P; a refiner's crack-spread level, not a margin percentage, is what actually distinguishes issuers |
| operating margin | E&P 30-45%; midstream 40-55%; refining 2-5% (thin because revenue is a crude-cost pass-through, not because the business is weak); oilfield services 10-18% | scale and basin quality set the E&P range; contract mix and fee escalation set midstream; refining's low percentage is structural, not a distress signal — judge it against crack-spread dollars instead; services sits low mid-cycle and swings hardest across the table in either direction |
| effective tax rate | 21-26% across all four | state severance and production taxes sit outside this line as a cost, not inside it; a converted-to-C-corp former MLP moves toward the top of the range as pass-through tax treatment unwinds |
| reinvestment intensity (capex and D&A as a share of revenue) | E&P 25-40%; midstream 8-15% (sustaining only — exclude contracted growth capex from a steady-state ratio); refining 2-4% of revenue but state turnaround capital per unit of capacity as the real metric, since revenue's crude pass-through makes the ratio itself close to meaningless; oilfield services 5-10% | E&P's high band is the reserve-replacement cost made explicit; refining and midstream ratios read low mainly because their revenue bases are large relative to the physical capital they turn over, not because they reinvest little in absolute terms |
| operating working capital / revenue | E&P and midstream 0-5%; refining 8-15% (inventory-heavy, and value swings with the crude price itself — normalize in volume terms first); oilfield services 15-25% | refining's positive band is inventory, not receivables; services' band is collection-term risk that lengthens exactly when activity is falling |
| reserve life (years of proved reserves at current production) and recycle ratio — E&P only | reserve life 8-15 years; recycle ratio 1.5-2.5x at mid-cycle prices | below roughly 8 years, treat a perpetuity terminal as overstating value per the Terminal section above; a recycle ratio near or below 1x at mid-cycle prices says the last drilling dollar is not economic and a growing terminal case is unsupported |
| through-cycle beta | E&P 1.3-1.8; midstream 0.8-1.2; refining 1.0-1.4; oilfield services 1.4-2.0 | midstream's contracted cash flow sits lowest; services' operating leverage and its position as the first and deepest cut in a downturn puts it highest |
| exit multiple | E&P EV/EBITDAX 3-7x (cross-check against EV per flowing barrel or an externally sourced EV/proved-reserve metric, never plain EV/EBITDA on a peak year); midstream EV/EBITDA 9-12x; refining EV/EBITDA 5-7x on mid-cycle EBITDA only; oilfield services EV/EBITDA 6-9x on mid-cycle EBITDA only | EV/EBITDAX exists because EBITDA alone ignores the exploration expense a producer must keep incurring to replace reserves; midstream's premium multiple reflects contracted cash-flow visibility, not growth; refining and services multiples applied to a cyclically peak year materially overstate value — mid-cycle normalization is not optional here |

## Failure modes specific to this sector

- **Flat production with falling or flattening capex.** This is the sector's single most common tell: it asserts the reservoir stopped depleting. Check the capex path against the decline rate implied by the issuer's own basin and well vintage before accepting flat or growing volumes.
- **A blended price-per-boe instead of benchmark, differential and hedge modeled separately.** It hides exactly the information that matters — a widening differential from takeaway constraints, or a hedge book rolling off into full price exposure next year — inside one number that looks stable.
- **A perpetuity terminal on a short-inventory E&P.** Capitalizing the current drilling program forever when the disclosed location count runs out well inside a normal terminal horizon is paying for reserves that do not exist yet on paper.
- **A refiner's margin read as a revenue percentage.** Revenue is a crude-cost pass-through; a margin-on-revenue ratio compresses in a crude price spike even when the crack spread — the number that actually measures the business — improved.
- **A midstream chain driven by commodity price instead of contracted volume.** Take-or-pay and minimum-volume-commitment structures mean price moves the customer's economics, not this issuer's fee revenue directly — modeling price-elasticity into a contracted revenue line invents a sensitivity the contract does not have.
- **Terminal-valuing a cyclical sub-industry off its most recent actual year.** E&P price decks, refining crack spreads and services activity levels are all mid-cycle claims; anchoring the terminal year on whichever phase of the cycle the last actual period happened to sit in inherits that phase's bias into a value meant to hold forever.
- **A recycle ratio near or below 1x carried into a growing terminal case.** If the last dollar of drilling capital is barely economic at mid-cycle prices, a terminal case that still assumes profitable reserve growth needs a named reason the issuer's economics improve from here.
