# Sector playbook — Technology (GICS Information Technology)

Covers three GICS industries with different economics wearing the same label: Software & Services (MSFT, ORCL, CRM, ADBE, NOW), Semiconductors & Semiconductor Equipment (NVDA, AMD, AVGO, TXN, AMAT, LRCX), and Technology Hardware, Storage & Peripherals (AAPL, DELL, HPQ, ANET). The structural fact that breaks the generic chain: for software and fabless issuers the real reinvestment is R&D expensed through operating costs rather than capitalized, so capex understates what the business spends to stay in business and the capacity story lives in operating expense. For issuers that own fabs or data centres, capex means exactly what it normally means and dominates everything else. Decide which case you are in before writing any reinvestment assumption.

## Chain shape — what to build instead of the default

- Identify which of the three business models an issuer runs before choosing a chain. A diversified issuer (AAPL selling devices and services, AVGO selling chips and enterprise software) needs a chain that routes each segment to its own sub-industry logic below, not one label applied to the whole company.
- Segment revenue by economic driver — subscription vs. usage vs. unit-and-price vs. equipment-and-service — not by reporting segment alone when the two diverge; a "products" segment that blends a subscription attach with one-time hardware is two stories, not one.
- Do not default to a single consolidated operating-margin chain the moment two segments carry different gross-margin structures. Forecasting segment gross margins separately is the norm in this sector, not the exception — a chip designer that also sells software (AVGO) or a device maker that also sells services (AAPL) is the common case, not the edge case.
- Declare the SBC treatment (below) and the capitalized-software treatment (below) at the top of the chain, before writing a single margin assumption — both change what operating income and capital expenditure mean for the rest of the model.

## Revenue — the decomposition that pays

### Software/SaaS

- Separate subscription, perpetual/license, and usage-based (consumption) streams — each forecasts on a different mechanism.
- Subscription revenue is largely pre-sold: carry remaining performance obligation, or deferred revenue where RPO is not disclosed, as its own history line and read its growth as the leading indicator for next year's subscription revenue. Last year's revenue growth is the lagging one.
- Perpetual/license revenue is transactional and lumpy; do not smooth it into the subscription growth rate or let one large deal quarter set the forecast base.
- Usage-based revenue tracks customer consumption and is the most cyclical stream in the mix — treat its growth assumption independently, and expect it to compress gross margin as it grows (see Cost and margin below).
- Decompose subscription growth into gross retention, expansion, and new logos. Net revenue retention is gross retention plus expansion and covers only the installed base; new-logo bookings sit outside it entirely. Forecast the pieces separately rather than as one blended growth rate — a flat NRR can hide an accelerating new-logo assumption or the reverse, and the two persist for different reasons.

### Semiconductors

- Decompose as units × ASP, not a single blended growth rate. A unit decline offset by content-per-device or AI-accelerator ASP growth is a different story than volume growth, and the two persist differently.
- The most recent actual year is very often not a representative base: this sector runs multi-year up- and down-cycles. Anchor off a multi-year average or a normalized mid-cycle level, and state explicitly where in the cycle the base year sits.
- Equipment makers (AMAT, LRCX, KLA, ASML) do not forecast off end-market demand directly — they are a derivative of customer capex and technology-node transition timing. Drive their revenue off named customers' disclosed or inferred capex plans and node roadmaps, not off smartphone or PC unit growth one layer removed.

### Hardware

- Forecast off unit refresh cycles (device replacement rate) times ASP, and separately forecast attached services/software revenue, which typically grows faster and carries far higher margin — the mix shift between the two is usually the whole story, not units alone.
- Distinguish sell-in (shipments to channel) from sell-through (sales to end customer). A revenue beat driven by channel stuffing shows up as a sell-in spike with no sell-through confirmation, and it reverses the following period.

## Cost and margin — the level the story lives at

### Software/SaaS

- Cloud hosting cost sits in cost of revenue, so a revenue mix shifting toward usage-based/consumption products mechanically pulls gross margin down even with no change in unit economics. Model hosting cost per the consumption stream, not as one constant blended COGS ratio.
- Stock-based compensation is a real economic cost, and the FCFF non-cash addback flatters cash flow by treating it as free. Do one of two things explicitly: (a) forecast diluted share count growing at the issuer's historical dilution rate so the equity bridge captures the cost, or (b) treat SBC as a cash-equivalent expense in the margin build. Silently doing neither is where software DCFs most often overstate value.
- Capitalized internal-use software development moves engineering cost from opex into capex/intangibles. Check whether the issuer capitalizes it — a rising capex line that is really capitalized R&D reads as physical reinvestment when it is not, and it inflates the capex/D&A parity check below.

### Semiconductors

- Fabless vs. IDM/foundry is the single biggest determinant of margin structure and capex, and the two do not belong on the same chain: fabless issuers report higher gross margin and near-zero fab capex; IDMs and foundries carry lower gross margin and capex intensity that dwarfs everything else in the sector.
- R&D intensity is the entry ticket to stay on a competitive node or architecture. A margin forecast that expands operating margin while cutting R&D/revenue below the issuer's own multi-year floor is asserting the issuer stops needing to compete for the next node.
- Inventory days and channel (distributor) inventory are the earliest tell of where the cycle sits — rising days into flat revenue usually precedes a revenue air pocket the revenue forecast has not yet priced.

### Hardware

- Mix shift from device toward attached services raises consolidated gross margin without any change in device economics. Decompose the two before crediting margin expansion to device profitability.
- Channel inventory (weeks of supply at distributors/retailers) is this sub-industry's cycle tell, parallel to semis' die-bank inventory: a sell-in run-up against flat sell-through data foreshadows a correction.

## Reinvestment — capex, D&A, and what maintenance means here

- Capex running far below depreciation and amortization is normal and can persist for years in software and fabless names, because the real reinvestment is R&D expensed above the line, not capex below it. Do not read that gap as underinvestment, and do not forecast capex up to close it without a named cause.
- The AI data-center build has inverted this for hyperscaler-adjacent and infrastructure-heavy names: owned-infrastructure capex has grown to multiples of D&A. Treat that inversion as a forecastable, named event — a disclosed multi-year build program with its own trajectory and an eventual plateau — not as noise to fade back toward the pre-program ratio.
- For acquisitive issuers, check what is inside D&A: purchased-intangible amortization from M&A can dominate the D&A line and has no capex counterpart at all. That breaks the capex/D&A parity check at the terminal year unless you split D&A into an intangible-amortization piece (fades toward zero as deals age off) and a PP&E-depreciation piece — the one capex should approach at maturity.
- Where internal-use software is capitalized (Software/SaaS above), strip it from the capex row you compare against D&A, or build a separate "physical/PP&E capex" row for the parity check — otherwise capitalized R&D masquerading as capex hides a real gap between reinvestment and depreciation.

## Working capital — the cycle and its sign

### Software/SaaS

Deferred revenue is collected in cash before it is earned, so operating working capital runs structurally negative and grows more negative as billings grow. Treat a more negative NWC level as a source of cash the business generates by growing, not a use of cash to fund.

### Semiconductors

Inventory is the dominant component and swings hardest with the cycle: IDMs build inventory ahead of demand troughs, and it becomes a drag exactly when revenue is weakest. Do not hold inventory days flat across a cycle you are also forecasting as cyclical — the two rows should move together.

### Hardware

The best operators (build-to-order, just-in-time sourcing) run deeply negative working capital — they collect from customers before paying suppliers, so revenue growth funds itself rather than consuming cash. Confirm which regime an issuer sits in before assuming NWC scales positively with revenue, the way it does for most other sectors.

## Tax and WACC notes

- Effective tax rates sit well below the US statutory rate across all three sub-industries because IP (patents, software licenses, chip designs) is domiciled in low-tax jurisdictions. A persistent multi-year gap between effective and statutory rate is the domiciling structure working as intended, not a forecast error to close toward 21% — carry it forward unless the issuer discloses a restructuring that changes it.
- Beta is not one number for the sector: semiconductor and AI-capex-linked names carry the highest beta and it moves with the cycle; mature diversified platform software sits lowest; hardware sits in between. Do not apply one "tech beta" across an issuer whose segments span sub-industries.
- Mega-cap names here are the canonical case of a buried interest-expense line — Apple and Microsoft disclose no separate interest expense, so cost of debt cannot be derived from the statements at all. Source it from the issuer's current bond yields instead of leaving it unresolved.
- Net-cash balance sheets are common at the top of this sector. That does not make the debt weight negative — capital-structure weights use total debt, not net debt — but it does mean equity value dominates the weighting, so an error in diluted share count or in the price you anchor on moves WACC more here than in a levered sector.

## Terminal — what steady state means here

- EV/EBITDA is the terminal metric across all three sub-industries, and the metric your comparables are quoted on must be the metric you apply the multiple to. Reaching for EV/revenue instead is a signal about the forecast, not about the sector: it means the issuer has not reached steady-state profitability by the horizon, so extend the explicit years until it does.
- Terminal value assumes the product line generating it still exists at the horizon. This sector obsoletes products inside a ten-year window more readily than most — a chip architecture, a software category, a device form factor superseded — so a terminal case resting on the current product's current economics owes a sentence on why the issuer's business, not just its current product, persists.
- For semiconductors specifically, do not terminal-value off a peak-cycle or trough-cycle final forecast year; normalize to a mid-cycle margin and reinvestment level first, or the terminal value inherits whichever half of the cycle the forecast happened to end in.
- For equipment makers, terminal growth is a claim about node transitions continuing indefinitely at a similar cadence and capital intensity — state that explicitly rather than letting a GDP-bounded number stand in for it silently.

## Terminal-state calibration bands

These bands describe the **steady state only** — the economics the business settles into after the explicit forecast, when growth has normalized and the current cycle, product ramp or build programme is over. They say nothing about next year, and you must not use them to set a near-term assumption: the explicit years are anchored on this issuer's own history, disclosures and the causal case you built for them, and a sector band that competed with that evidence would be the wrong master. Terminal is the one place the issuer's history cannot speak, because it is by construction the state after everything the history covers.

Read them as triage: a terminal assumption inside its band is ordinary and needs the ordinary rationale; one outside it is a claim that this issuer's steady state differs from its sector's, and that claim now needs evidence naming what makes it durable. The band never picks the number.

Two structural facts constrain the whole table. Terminal capex and D&A converge — a steady state is by definition one where the asset base is replaced, not expanded, so the reinvestment row below is the level both approach and their ratio sits near 1.0. And terminal growth cannot exceed long-run nominal GDP.

| terminal driver | steady-state band | what puts an issuer at each end |
| --- | --- | --- |
| revenue growth | 2-4% | a platform with pricing power and a durable install base near the ceiling; a hardware franchise facing commoditization or substitution near the floor. Nothing here escapes nominal GDP |
| gross margin — software | 70-80% | consumption and hosting-heavy mix settles lower because hosting cost scales with usage; low-support subscription or license mix settles higher |
| gross margin — semiconductors, fabless | 50-62% | assume the leading-edge premium erodes: a mature node or commoditizing product sits at the floor, an architecture with a durable moat at the ceiling |
| gross margin — semiconductors, IDM/foundry/equipment | 35-48% at mid-cycle utilization | never terminal-value off peak or trough utilization; the band is the utilization-normalized level |
| gross margin — hardware | 20-38% | box assembly at the floor; a device franchise whose services attach survives to steady state at the ceiling |
| operating margin — software | 28-38% | go-to-market spend at steady state is renewal-weighted, not new-logo-weighted, which is what lets margin sit here rather than at the growth-phase level |
| operating margin — semiconductors, fabless | 28-38% | R&D intensity does not fall at maturity in this sub-industry — that is what caps the ceiling |
| operating margin — semiconductors, IDM/foundry/equipment | 18-28% | fixed-cost absorption at normalized utilization sets the floor |
| operating margin — hardware | 8-18% | commodity assembly at the floor; integrated device-plus-services at the ceiling |
| R&D/revenue | 12-20% software; 15-25% semiconductors | this is the entry ticket, and it does not expire at steady state. A terminal margin funded by R&D falling below the issuer's own multi-year floor asserts competition ends |
| effective tax rate | 15-21% | the global minimum tax is the floor, so a terminal rate below it asserts the IP-domiciling structure survives a regime explicitly built to stop it — say so if you assume it. Rates at the top assume the structure unwinds |
| reinvestment intensity (capex, and D&A, as a share of revenue) | 3-7% software, fabless and hardware assembly; 12-20% IDM, foundry and equipment | insourced data-centre capacity or owned fabs at the top; leased infrastructure and outsourced manufacturing at the bottom. Whichever level you pick, capex and D&A must arrive there together |
| operating NWC/revenue | -15% to -5% software; -10% to 0% hardware; +10% to +20% semiconductors | deferred revenue keeps software structurally negative forever, not just while growing; inventory keeps semiconductors structurally positive. The sign is a property of the business model and does not converge to zero |
| beta (through-cycle, a WACC input rather than a terminal one) | 1.0-1.5 | diversified platform software at the bottom; cyclical semiconductor and capex-linked names at the top |
| exit multiple — EV/EBITDA | 10-18x | commodity hardware at the bottom; a differentiated semiconductor, equipment or platform franchise at the top. Read it against what your own terminal growth implies and defend the gap |
| exit multiple — EV/revenue | not a terminal metric | needing it at the horizon says the issuer has still not reached steady-state profitability there, which means the explicit forecast is too short. Extend the horizon rather than terminal-valuing a business that has not matured |

## Failure modes specific to this sector

- **A steady-state band borrowed for an explicit year.** The terminal bands describe the business after the cycle and the build programme are over. Pulling a terminal margin or reinvestment level into year one overwrites this issuer's own evidence with a sector average — and pulling a current, cycle-peak margin into the terminal year does the reverse damage. The explicit years come from the issuer; only the terminal comes from the sector.
- **A semiconductor base year taken at face value.** LAG-anchored formulas inherit whatever cycle phase the last actual period sat in; a chain built off a peak year compounds peak margins and peak ASPs forward, off a trough year compounds the opposite. Normalize before anchoring, or the null-and-unit checks will pass on a forecast that is wrong by construction.
- **SBC addback with no offsetting cost anywhere.** A software chain that adds SBC back in FCFF and never grows the diluted share count or treats SBC as a cash cost overstates per-share value every year of the forecast — it passes every engine check because nothing in the schema requires the offset.
- **A consolidated margin default hiding a mix shift.** Forecasting operating margin flat while usage-based or AI-server revenue grows as a share of the total asserts hosting/component cost mix does not matter — it always does in this sector; the gross-margin story lives at the stream or segment level even when the issuer reports one consolidated number.
- **Flat AI-infrastructure capex through an active build cycle.** Fading capex intensity back to its five-year average during a disclosed multi-year infrastructure build ignores a named, dated event; the forecast should track the disclosed program, not the pre-program ratio.
- **Positive working-capital investment forced onto a negative-NWC business model.** Applying a generic "NWC grows with revenue" assumption to a deferred-revenue software business or a build-to-order hardware business inverts the sign of a genuine cash source into a modeled cash use.
- **An equipment maker's revenue forecast built off end-market units instead of customer capex.** AMAT/LRCX/KLA-type names miss the mechanism entirely if driven by phone or PC shipment growth rather than the capex and node-transition plans of the handful of customers that actually buy their tools.
- **Capitalized R&D read as physical capacity.** A software issuer capitalizing internal-use development shows rising capex that is headcount cost relabeled, not servers or buildings; crediting it as reinvestment capacity overstates the terminal-year capex/D&A parity check and understates true opex-side reinvestment.
