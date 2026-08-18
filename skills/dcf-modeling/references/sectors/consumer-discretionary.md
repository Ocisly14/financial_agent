# Sector playbook — Consumer Discretionary (GICS Consumer Discretionary)

Covers Broadline & Specialty Retail (AMZN, HD, LOW, TJX, ROST, BBY), Automobiles & Components (GM, F, TSLA, APTV), Hotels/Restaurants/Leisure (MCD, SBUX, CMG, MAR, HLT, BKNG, RCL), and Textiles/Apparel & Consumer Durables (NKE, LULU, WHR, DHI, LEN). Four different business models share this GICS label, and none of them share a chain: retail and apparel run store-and-comp economics, autos run unit-and-ASP economics behind a captive lender, restaurants and hotels split into a royalty business and a real-estate-and-labor business under one ticker, and travel splits into asset-heavy operators and an asset-light commission business. The structural fact common to all four: demand is discretionary and income-elastic, so it swings several multiples of GDP through a cycle, and the base year is a cycle position before it is a level.

## Chain shape — what to build instead of the default

- Identify which business model family the issuer runs before writing a chain: store-based retail/apparel, unit-based auto manufacturing (with or without a captive finance arm), franchised-vs-operated restaurant or hotel, or asset-light travel intermediary. A diversified issuer running more than one — a retailer with a large financing arm, a hotel company running both owned and managed properties — needs each line routed to its own logic below, not one label applied to the whole company.
- Screen for a captive finance arm (autos), a franchise/company-operated split (restaurants), or an owned/managed/franchised split (hotels) before writing a single revenue-times-margin chain — each split changes margin structure, capital intensity, and the correct discount rate for the pieces it separates.
- Where format or channel mix is shifting inside the forecast — e-commerce share, franchised share, a refranchising program — that shift is margin-relevant on its own and belongs in the chain as a named driver, never folded into one blended margin.
- Appliance and durable-goods manufacturers (WHR) sit closer to the automobile industrial model below than to the apparel-brand model — fixed manufacturing capacity, unit-and-ASP revenue, and operating leverage that turns negative fast in a downturn — despite sharing a GICS sub-industry with apparel.

## Revenue — the decomposition that pays

### Retail, off-price, and apparel brands

- Decompose store-based revenue as comparable-store (same-store) sales growth plus net new square footage plus e-commerce, not as one consolidated growth number — a shrinking fleet with rising comps and a growing fleet with falling comps produce the same headline growth rate and opposite futures.
- For a brand manufacturer selling through both its own stores/DTC and wholesale (NKE, LULU), split wholesale from direct-to-consumer: DTC carries the full retail margin and its own store/comp economics; wholesale is lower-margin, lower-capex, and working-capital-light on different payment terms. A mix shift toward DTC lifts consolidated margin with no change in product economics.
- E-commerce mix shift moves gross margin and fulfilment cost in opposite directions at once — rising online mix typically compresses product margin (markdowns, shipping) while cutting store operating cost. Model the two together; a margin line that only reflects one side of the shift is reading half the mechanism.

### Automobiles

- Separate the captive finance arm from the industrial business before writing anything else (Working capital, below) — industrial revenue is units × average selling price net of incentives, and incentives are a margin lever wearing a price disguise: rising incentive spend against flat ASP is a margin story, not a volume story.
- Capacity is fixed in the short run and the business is highly operating-levered: forecast decremental margins in a downturn as materially worse than the incremental margins the same capacity produced on the way up, not symmetric with them.
- Treat a disclosed EV transition as a named multi-year capex and mix program with its own trajectory (Reinvestment, below), not as an adjustment folded into the growth rate.

### Restaurants and hotel brands

- Split revenue into franchised/managed (royalty, rent, and management fees on a franchisee's or owner's sales) and company-operated (full unit sales) before forecasting anything — decompose each as unit count × average unit volume (or RevPAR for hotels) × comparable growth, but the two streams carry entirely different margins, capex, and working capital.
- Where the issuer runs a disclosed refranchising or asset-sale program in the forecast window, model it as a transfer: company-operated revenue and its associated cost step down as royalty or fee revenue on the same unit base steps up, so consolidated revenue can fall while consolidated margin rises. Forecasting the two lines as independent trends misses the mechanism entirely.

### Travel — capacity operators and OTAs

- Hotels and cruise lines: capacity (rooms available, berths) × occupancy × rate (RevPAR, or net yield per berth). Rate and occupancy trade off; a chain assuming both expand together every year assumes pricing power with no elasticity, which this demand curve does not support indefinitely.
- Online travel agencies and booking platforms: gross bookings × take rate, not a revenue growth rate taken on its own — take rate is a negotiated commission that moves with merchant and geographic mix, not with the travel cycle itself.
- Do not put a hotel/cruise operator and an OTA on the same chain shape: one owns or contractually operates the capacity being sold, the other intermediates a transaction between two other parties.

## Cost and margin — the level the story lives at

- Retail and apparel: gross margin is set by markdown rate, inbound freight, and channel mix (store vs. DTC vs. wholesale); SG&A leverage comes from occupancy cost spread over comp growth, so a comp deceleration below the issuer's historical occupancy-leverage breakeven flips operating leverage negative even with gross margin unchanged.
- Automobiles: gross margin on the industrial business is the number that matters — a consolidated margin blending the captive arm's spread income overstates or understates industrial profitability depending on where the credit cycle sits. Engineering and software spend for the EV transition is a real cost floor, not a lever to cut for near-term margin.
- Restaurants and hotels: franchised/management-fee margin (fee revenue less minimal direct cost) runs far above company-operated margin (unit sales less food or room cost, labor, and occupancy). Applying one consolidated margin to a mixed-model issuer averages two different businesses into a number that describes neither.
- Travel: hotel and cruise margin is dominated by fixed-cost absorption over occupancy — a few points of occupancy move margin more than an equivalent move in rate. OTA margin tracks marketing spend as a share of bookings, a lever management resets quarter to quarter, more than it tracks the take rate itself.

## Reinvestment — capex, D&A, and what maintenance means here

- Split new-unit/new-store capex (growth investment) from remodel/maintenance capex (sustaining the existing base) wherever disclosed — a capex ratio held flat while unit growth decelerates asserts maintenance spend alone is rising, and that assertion needs its own cause.
- Automobiles: plant, tooling, and the EV/battery buildout dominate capex and run far above D&A during an active investment program. Treat that program as a named, dated event that plateaus once the disclosed capacity target is met — fading it back to a pre-program ratio on schedule, not on a generic multi-year average.
- Franchisors and hotel managers carry minimal capex relative to revenue, because they own little of the real estate or equipment their franchisees and owners use; company-operated restaurant units and owned-hotel/cruise capacity carry capex closer to a real-estate or fleet business. A blended reinvestment ratio for a mixed-model issuer has to be built from the segment weights, not read off the consolidated total.
- Homebuilders (DHI, LEN) do not run a capex/D&A reinvestment story at all: land acquisition and construction cost are working-capital (inventory) spend, and depreciation is immaterial to the model. Build their reinvestment case through land and work-in-process inventory growth against closings and community count — see the calibration table.
- Operating leases are the sector's largest off-balance-sheet capital commitment (store fleets, hotel ground leases, restaurant real estate). Confirm whether lease payments already sit in operating cost — usually true — before adding lease liabilities to the equity bridge; see the double-count warning in stage 6.

## Working capital — the cycle and its sign

### Retail and apparel

Inventory days against payables days set the sign. A scaled retailer with negotiating leverage over suppliers can run payables days well above inventory days, producing negative operating working capital that funds growth from suppliers rather than from the balance sheet — that gap is what separates the best-run operators in this sub-industry from the rest. Confirm which regime an issuer sits in before assuming working capital scales positively with revenue.

### Automobiles

Separate the captive finance arm's receivables (loans and leases extended to customers) and its funding debt from the industrial business entirely before computing an operating working-capital ratio or a leverage figure. A consolidated filer's receivables and debt are dominated by the financing book; folding them into operating working capital or capital-structure weights produces a ratio that describes a lender, not a manufacturer. Read the segment disclosures — most large-cap issuers report a separate financial-services segment — and build the operating chain off the industrial segment alone.

### Restaurants and hotels

Franchised/management-fee revenue carries structurally negative working capital (fees collected against minimal payables); company-operated units and owned hotels run closer to zero or mildly negative. A refranchising program therefore improves the working-capital ratio at the same time it lifts margin — model the two as one mechanism, not two coincidental trends.

### Travel

Customer deposits (advance cruise and hotel bookings) and loyalty-program liabilities are a real, and often large, source of float — cash collected before the service is delivered. Treat deposit growth as a working-capital source scaling with forward bookings, and loyalty-point liabilities as a deferred-revenue-like balance growing with program enrollment, not as a rounding item in the bridge.

Homebuilder inventory (land, land development, and homes under construction) replaces the receivable/payable cycle above as this sub-industry's working-capital story. It turns over on a multi-quarter construction cycle, not a retail restocking cycle, and should be driven off backlog and community count rather than a days-of-revenue ratio built for a faster-turning business.

## Tax and WACC notes

- Confirm in the lease note whether operating lease expense remains in operating cost — true for most store, restaurant, and hotel real estate — before adding lease liabilities to the equity bridge; see stage 6's double-count warning.
- Through-cycle beta for this sector sits above a defensive, non-discretionary consumer business, because demand is income-elastic and amplifies the broader market cycle. Do not anchor beta on a staples or grocery comp for a genuinely discretionary issuer, and do not assume every discretionary name is high-beta — a scaled off-price retailer that gains share in a downturn can trade at a materially lower beta than the sector average.
- For autos, source cost of debt and leverage weights off the industrial segment's own debt, excluding the captive finance arm's funding debt, which is collateralized by and sized to its receivables book rather than to the operating business.
- Franchisors should not be benchmarked for tax rate or leverage against operator peers in the same GICS sub-industry — royalty economics support materially less operating risk and a different capital structure than a real-estate-and-labor operator, even inside the same brand family.

## Terminal — what steady state means here

- Terminal growth here is a claim about durable share of consumer wallet and unit/store count reaching saturation, not a GDP pass-through alone — state which of the two, share gain or category growth, the terminal number assumes.
- Do not terminal-value off a cyclical peak or trough year: normalize comp growth, margin, and reinvestment intensity to a mid-cycle level first, the same discipline a cyclical semiconductor name requires — this sector's swings are demand-driven rather than capacity-driven but comparably wide.
- A franchisor's terminal state resembles a royalty annuity: minimal terminal capex, structurally negative working capital, and a high terminal margin that does not compress toward an operator's. Do not converge a mixed-model issuer's terminal margin toward an average of its two segments; carry each segment's economics to its own steady state and reweight by terminal segment revenue.
- Homebuilder terminal value is unusually sensitive to land strategy: terminal-valuing off a period of aggressive land-light (option-heavy) growth understates steady-state capital intensity, and anchoring to a heavy owned-land-bank period overstates it. State which land strategy the terminal case assumes.

## Terminal-state calibration bands

These bands describe the **steady state only** — the economics the business settles into once growth has normalized and the current cycle, refranchising program, or capacity build is over. They say nothing about next year and must not set a near-term assumption: the explicit years are anchored on this issuer's own history, disclosures, and the causal case built for them in Move 2, and a sector band competing with that evidence would be the wrong master. Terminal is the one place the issuer's history cannot speak, because it is by construction the state after everything the history covers.

Read them as triage: a terminal assumption inside its band is ordinary and needs the ordinary rationale; one outside it is a claim that this issuer's steady state differs from its sector's, and that claim now needs evidence naming what makes it durable. The band never picks the number.

Two structural facts constrain the whole table, with one sub-industry exception. Terminal capex and D&A converge everywhere except homebuilders — steady state replaces the asset base rather than expanding it, so reinvestment intensity is the single level both approach. Homebuilders have no meaningful depreciation to converge toward; their reinvestment row is land-and-work-in-process inventory against revenue instead. And terminal growth cannot exceed long-run nominal GDP.

| terminal driver | steady-state band | what puts an issuer at each end |
| --- | --- | --- |
| revenue growth | 2-4% | durable share gains (off-price retail taking share from full-price) near the ceiling; mature, replacement-driven categories (auto, appliances, homebuilding tied to household formation) near the floor |
| gross margin — off-price/broadline retail | 24-34% | continuous markdown competition holds off-price and broadline discount near the floor; specialty and home-improvement retail with pricing power and less markdown pressure sit near the ceiling |
| gross margin — apparel/footwear brand | 42-55% | wholesale-heavy legacy brands near the floor; DTC-and-premium-positioned brands near the ceiling |
| gross margin — automobiles, industrial (ex-captive) | 8-15% | mass-market, incentive-heavy nameplates near the floor; premium or technology-differentiated nameplates and component suppliers near the ceiling |
| operating margin — restaurant/hotel franchisor or manager | 35-50% | a system that has completed its shift to near-full franchise/management, collecting fee revenue against minimal direct cost, sits at the ceiling; an issuer still carrying transitional corporate cost from an incomplete refranchising sits at the floor |
| operating margin — restaurant company-operated, casual/full-service | 8-16% | labor- and occupancy-intensive full-service concepts near the floor; high-throughput quick-service near the ceiling |
| operating margin — cruise and owned-hotel (asset-heavy travel) | 15-27% | an owned-asset operator at high normalized utilization sits at the ceiling; one carrying excess capacity or a weaker brand sits at the floor |
| franchised/managed revenue mix — restaurants and hotels | 85-98% | mature franchisors converge here; an issuer mid-way through a disclosed refranchising or asset-sale program sits below until the program completes |
| effective tax rate | 22-26% | this sector's income is overwhelmingly domestic operating income with little structural offshore-IP shielding, so unlike technology there is no durable reason to sit far below statutory |
| reinvestment intensity — retail, apparel, franchised/managed restaurant and hotel | 2-4% | new-unit growth capex fades out at steady state, leaving remodel and systems maintenance alone |
| reinvestment intensity — automobiles | 5-8% | tooling and plant renewal at a mature platform cadence; an issuer mid-build on EV capacity sits above this band only until the disclosed program completes, then converges into it |
| reinvestment intensity — cruise and owned-hotel | 6-10% | fleet and property renewal at a normalized replacement cadence, above the asset-light travel businesses because the asset actually being replaced sits on this issuer's balance sheet |
| land and work-in-process inventory / revenue — homebuilders | 60-90% | this replaces the capex/D&A parity check for this sub-industry entirely; a land-light, option-heavy strategy sits at the floor, a heavy owned-land-bank strategy at the ceiling |
| operating NWC/revenue — retail and apparel | -8% to +5% | scaled operators with supplier leverage run negative, funding growth from payables; smaller or fashion-cycle-exposed issuers carrying more inventory risk run positive |
| operating NWC/revenue — automobiles, industrial (ex-captive) | +5% to +12% | finished-vehicle and parts inventory dominate; this excludes the captive finance book entirely |
| operating NWC/revenue — franchised restaurant/hotel and OTA | -20% to -8% | fees and commissions collected against minimal payables, plus (for hotel and OTA) customer deposits and loyalty liabilities collected before service — the larger the asset-light share of the system, the more negative |
| through-cycle beta | 1.0-1.8 | franchised/royalty models and scaled off-price retail sit at the low end on earnings stability; capital-intensive cyclicals — automobiles, cruise, owned-hotel — sit at the high end |
| exit multiple — EV/EBITDA | 5-20x | the widest range in this file, because the sector spans a royalty business and a capital-intensive manufacturer under one label. Automobile OEMs sit at the low end for cyclicality and capital intensity; franchised restaurant/hotel systems and OTAs sit at the high end for asset-light, high-incremental-margin economics. Read the multiple off the peer set matching the issuer's actual segment mix at the horizon, never off "consumer discretionary" as a whole |

## Failure modes specific to this sector

- **A consolidated auto filer's operating leverage and NWC computed from the whole balance sheet.** Leaving the captive finance arm's receivables and debt inside the operating chain produces a leverage figure and a working-capital ratio that describe a lender, not a manufacturer — neither the WACC weights nor the FCFF chain mean what they claim to.
- **One margin for a franchised-plus-operated system.** Franchised/management-fee margin and company-operated margin differ by tens of points; a consolidated margin assumption held flat while the franchised mix shifts silently re-weights the forecast toward whichever segment happens to be growing, without saying so.
- **Refranchising modeled as two independent trends.** Revenue stepping down and margin stepping up in the same years is one mechanism, a unit transferring from company-operated to franchised — modeling them as separate assumption rows risks a chain where they no longer move together, or where the transfer's cash and working-capital effects go unmodeled.
- **Terminal-valuing off a cycle extreme.** A retail base year anchored on a post-stimulus demand peak, an auto base year anchored on a chip-shortage-constrained trough, or a cruise base year anchored on a post-disruption recovery surge each compounds an unrepresentative level into perpetuity if capitalized directly rather than normalized first.
- **A positive-NWC default forced onto a structurally negative-NWC business.** Off-price retail's supplier float, a franchisor's royalty collections, and an OTA's merchant-model cash-before-payout each run negative by design; a generic "working capital grows with revenue" assumption inverts a genuine cash source into a modeled cash use.
- **A homebuilder capex/D&A parity check applied where no such parity exists.** Chasing capex toward a depreciation line that is economically immaterial for a homebuilder produces a reinvestment ratio that answers a question this sub-industry does not ask; the land-and-inventory row is the reinvestment case, not the capex row.
- **Beta borrowed from the wrong shelf.** Applying one "consumer discretionary beta" across an off-price retailer and a cruise operator, or anchoring a genuinely cyclical issuer's beta on a defensive staples comp, misprices the discount rate in the direction that happens to be convenient rather than the direction the business's earnings volatility supports.
