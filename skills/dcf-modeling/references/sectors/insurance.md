# Sector playbook — Insurance

Covers property & casualty (TRV, CB, PGR, ALL, CINF), life & annuity (MET, PRU, AFL, LNC), reinsurance and specialty (RNR, EG, WRB, AIG), and title insurance. An underwriter holds policyholder premium as a liability, invests it as float until claims come due, and prices risk it does not fully control — none of that is capex, working capital or debt-funded operations, so the generic FCFF-to-EV chain does not describe how these businesses make money. Insurance brokers are the deliberate exception: they earn commissions and fees, carry no underwriting risk and no float, and belong on the ordinary asset-light chain this file otherwise displaces.

## Chain shape — what to build instead of the default

- Build free cash flow to equity, not free cash flow to the firm. Distributable cash is net income adjusted for the change in required capital, not operating income less capex less a working-capital delta — there is no capex line and no operating working capital in the ordinary sense for an underwriter.
- Discount at the cost of equity, not at a debt-weighted average. Equity value is the direct output; do not run a debt-deducting equity bridge on top of it — the underwriter's liabilities are policy reserves and float that fund an investment portfolio, not borrowed capital the bridge is entitled to net out. Double-counting that deduction understates equity value by treating funding liabilities as if they were debt.
- Where the issuer's disclosure supports it, cross-check with a residual-income construction on book value: value equals book value plus the present value of future economic profit, defined as net income in excess of the cost-of-equity charge on beginning book value. This is the natural check because insurers are regulated and valued on capital, and it reconciles cleanly to the terminal return-on-equity framing below.
- Express the terminal value as sustainable return on equity against cost of equity, which implies a price-to-book multiple rather than an EV/EBITDA or EV/revenue multiple — enterprise value is not the operative concept for an underwriter, since there is no operating asset base separate from the investment portfolio that float already funds.
- Brokers keep the default chain entirely: forecast revenue, operating margin, a small capex and D&A line, minimal working capital, discount FCFF at a debt-weighted WACC, and value enterprise value bridging to equity in the ordinary way. Do not force a broker onto the FCFE or book-value framework built for underwriters.

## Revenue — the decomposition that pays

Two profit engines drive every underwriter, and a forecast that models only one misses the economics: the underwriting result (earned premium less losses and expenses, summarized by the combined ratio, where a reading below 100 means underwriting profit) and net investment income earned on the float — policyholder money held between premium collection and claim payment, which is the reason a low-margin underwriting business is worth owning at all. Forecast premium and investment income as two separate lines with two separate mechanisms; do not fold investment income into a blended margin the way an operating business folds interest income into EBIT.

- Decompose premium into rate (price per unit of exposure) and exposure (units written — policies, insured value, payroll). The underwriting cycle — hard and soft markets driven by industry-wide capital availability, not customer demand — sets the rate component, so premium growth is a pricing-cycle read, not a demand forecast the way revenue growth is for an operating company.
- Track written premium against earned premium separately: written premium leads earned premium by the policy term, so a rate change shows up in written premium first and earns into the income statement over the following year or more. Use this lag when the issuer is mid-cycle.

### Property & casualty

Split personal and commercial lines separately — they run different pricing cycles and different loss-cost trends (auto severity from vehicle repair cost and litigation trends; property severity from construction cost and catastrophe frequency). Retention rate and new business growth are separate levers within exposure growth; a book renewing at high retention but stalled new business is a different story than the reverse.

### Life & annuity

Decompose into recurring premium, single-premium and deposit-based products (fixed and variable annuity deposits are not premium — they are liabilities the issuer must credit and eventually pay back), and fee income on separate-account assets under management. Forecast deposit-based flows against annuity industry demand and rate competitiveness of the crediting rate offered, not as a growth rate on the premium line.

### Reinsurance and specialty

Decompose by line (property catastrophe, casualty, specialty) and note that reinstatement premiums — additional premium a cedant pays to restore coverage after a loss — are a mechanical function of the loss activity you are also forecasting, not an independent revenue driver. Property-catastrophe reinsurance premium is the most cycle-sensitive revenue line in the sector; treat its growth assumption independently from casualty reinsurance, which prices on a multi-year loss-development cycle instead.

### Title insurance

Title premium tracks real estate transaction volume and average property values, not an underwriting cycle — it is a transaction-volume business wearing an insurance label. Forecast it off mortgage origination and existing-home-sale volume, with a refinancing-driven surge treated as transitory, not a base to extrapolate.

## Cost and margin — the level the story lives at

The combined ratio — loss ratio plus expense ratio — is where the underwriting story lives, and its two components persist for different reasons: the loss ratio reflects claims frequency and severity trends the issuer only partly controls, while the expense ratio reflects acquisition cost and overhead the issuer sets. Forecast them separately.

- **Prior-year reserve development is the sector's signature base-year trap.** Reserves are an actuarial estimate of unpaid claims, and the estimate is revised every period. Releasing redundant reserves from a prior accident year flatters the current year's combined ratio with income that is not repeatable — it is a correction of a past estimate, not current-year underwriting performance — and adverse development does the reverse. Read several years of reserve development against the combined ratio before anchoring a forecast on the most recent actual year; strip the development component and forecast off the accident-year (current-period) combined ratio instead.
- **Catastrophe losses must enter as a modelled long-run load, never as the actual figure from a quiet or a terrible year.** A single actual year is not a sample size for tail risk. Build a normalized catastrophe load from the issuer's multi-year average or disclosed modelled expectation, and treat a large positive or negative deviation in the base year as exactly that — a deviation to normalize out, not a level to carry forward.
- Expense ratio splits into acquisition cost (commissions, underwriting expense tied to writing the policy) and general overhead; acquisition cost scales with premium and rarely improves without a distribution-model change, while overhead carries operating leverage as premium grows.

### Life & annuity

The margin equivalent is the benefit ratio and, for spread business, the net interest margin between what the portfolio earns and what the issuer credits policyholders. Mortality and morbidity experience (actual claims against the pricing assumption) is the loss-ratio analogue; a favorable experience year is as much a base-year trap as reserve releases are for P&C — check it against multi-year experience before anchoring.

### Reinsurance and specialty

Attritional (non-catastrophe) loss ratio and the catastrophe load are different economic claims and must be forecast as different lines; a reinsurer's headline combined ratio swings far more than a primary insurer's on the same underlying attritional trend because catastrophe losses are lumpy and concentrated in this book by design.

### Brokers

The cost line that matters is compensation and benefits, typically the majority of revenue — an EBITDAC margin (earnings before interest, tax, depreciation, amortization and change in contingent consideration) is the sector's standard profitability read and behaves like an ordinary operating margin: it expands with scale and organic growth, and compresses when acquired revenue is integrated.

## Underwriting capacity and capital — what reinvestment means here

There is no capex or PP&E cycle to speak of — offices and systems are immaterial reinvestment relative to premium. The real reinvestment decision is how much statutory capital the issuer must hold to keep writing more premium, and it binds through leverage, not through a depreciating asset base.

- The closest capex analogue is deferred acquisition cost: commissions and underwriting expense directly tied to writing new policies are capitalized and amortized against the premium they helped generate. Growing the book fast means deferring more acquisition cost, exactly as growing capacity means adding more PP&E in an operating business — model the amortization schedule against the premium it supports rather than treating it as a fixed ratio to revenue.
- Growing premium requires growing statutory capital roughly in proportion — regulators and rating agencies set minimum leverage (premium-to-surplus or a risk-based capital ratio), and breaching it forces either slower growth, a capital raise, or reinsurance to cede risk off the balance sheet. Treat capital growth as the reinvestment rate: retained earnings not upstreamed to the holding company fund it.
- **Dividend capacity, not accounting earnings, is what reaches shareholders.** Insurance subsidiaries dividend up to the holding company under state (or jurisdictional) limits tied to statutory surplus and prior-year statutory income; a year of strong GAAP earnings does not mechanically translate into cash available for buybacks or dividends if statutory capital needs rebuilding after a loss year. Forecast free cash flow to equity off distributable capital, not off GAAP net income directly.

## Float and reserves — the balance sheet that funds the business

Loss reserves and unearned premium reserves are float — a liability that funds the investment portfolio rather than a working-capital asset consuming cash. Its sign is the reverse of an operating company's working capital: a growing book of business generates more float, which is a source of investable assets, not a use of cash.

- Float scales with premium written and with how long claims take to settle (the "tail" — short for auto physical damage, decades for asbestos, workers' compensation or long-term-care liabilities). A longer tail means more float per dollar of premium and more room for reserve estimates to move.
- The portfolio's net investment yield rolls slowly from its embedded book yield toward the current new-money yield as bonds mature and get replaced — a rate move takes years to fully reach earnings, and the pace is set by portfolio duration and asset mix (P&C duration runs several years, life duration runs a decade or more to match long-tailed liabilities). Do not assume book yield reprices to the current curve immediately.

### Life & annuity

Life insurers are a spread business whose reserves are themselves discounted at an assumed rate, which makes book value and earnings acutely sensitive to interest rates in both directions — falling rates compress the spread between portfolio yield and what the issuer must credit or reserve for, and can trigger reserve strengthening; rising rates eventually widen the spread but pressure surrender activity as policyholders lapse into higher-yielding alternatives. Mortality, morbidity, lapse and (for long-term-care blocks) morbidity-and-longevity assumptions are actuarial judgments embedded in reserves — a DCF must not silently inherit whatever the issuer's own assumption update did to a given year's earnings; read whether a reported gain or charge is an assumption unlock before treating it as recurring.

### Title insurance

Title claims are typically identified and paid quickly after closing, so title insurers hold little float relative to premium — investment income is a minor contributor here, unlike the rest of the sector, and the balance-sheet framing above applies much more weakly.

## Tax and WACC notes

- Effective tax rate commonly sits below the statutory rate because insurers hold meaningful municipal-bond allocations for their tax-exempt income; a persistent gap is the investment-portfolio composition working as intended, not a rate to fade toward statutory.
- Fill the discount-rate sheet honestly even though the chain discounts free cash flow to equity, not the enterprise: total debt should reflect only holding-company (financial) debt — senior notes and hybrid capital — never policy reserves or float, which are not debt-service obligations; cost of debt should come from the issuer's own holding-company bond yields. Because insurers run thin holding-company leverage relative to their balance sheet size, the equity weight typically dominates and a debt-weighted average lands close to the cost of equity anyway — use the sheet's cost-of-equity output as the actual discount rate for the FCFE chain, and disclose that the blended figure is a cross-check, not the rate applied.
- Beta differs sharply by line: P&C carries moderate beta, since underwriting results are cyclical but capital-light relative to the broader market; life insurers carry higher beta because discounted reserves make book value directly rate-sensitive; catastrophe-exposed reinsurers carry beta that swings with the capital cycle — a hard market after a large industry loss year raises returns and can lower measured beta as pricing power dominates, so read a reinsurer's beta window against where the cycle sat within it; brokers carry the lowest beta in the sector, closer to a stable services business, consistent with the ordinary WACC chain they use.

## Terminal — what steady state means here

Terminal value is not an exit multiple on EBITDA — there is no EBITDA-like operating metric that captures an underwriter's economics. Express it as sustainable return on equity against cost of equity: a business earning its cost of equity forever is worth exactly its book value (implied price-to-book of 1.0x); every point of ROE above cost of equity, net of the growth rate, adds value above book, and every point below subtracts it. Anchor the terminal ROE on a normalized combined ratio (cat load and reserve development stripped out, as above) and a normalized investment yield — not on the final explicit year's reported ROE, which usually still carries cycle or development noise.

For life insurers, the terminal state is set by a normalized net interest spread over the crediting rate on in-force liabilities, since new-money reinvestment yield and crediting competition determine what spread persists once current-year rate dynamics fade. For reinsurers and specialty writers, terminal ROE must already reflect the normalized catastrophe load — do not terminal-value off whichever half of the cat cycle the final forecast year happened to land in. Brokers terminal-value the ordinary way: an exit multiple or perpetuity growth on FCFF, since their economics are the default chain's.

## Terminal-state calibration bands

These bands describe the steady state only — the economics an issuer settles into once the current underwriting cycle, rate cycle and reserve development have run their course. They say nothing about next year and must not set a near-term assumption: the explicit years are anchored on the issuer's own history and disclosed reserve, catastrophe and portfolio detail, and a sector band sitting beside that evidence would compete with it and win for the wrong reasons. Terminal is the one place the issuer's own history cannot speak, because it is by construction the state after everything the history covers. Read the bands as triage — a terminal figure inside the band needs the ordinary rationale, one outside it is a claim that this issuer's steady state differs from its peers', and that claim needs evidence naming what makes it durable.

| terminal driver | steady-state band | what puts an issuer at each end |
| --- | --- | --- |
| combined ratio (P&C, accident-year, cat-normalized) | 95-101% | disciplined personal-lines pricing with data-driven segmentation near the floor; catastrophe-exposed property or commoditized commercial lines near the ceiling |
| — loss ratio component | 60-70% | short-tail, well-priced lines at the floor; long-tail casualty with social-inflation exposure at the ceiling |
| — expense ratio component | 28-35% | scaled direct distribution at the floor; agency-heavy or specialty distribution at the ceiling |
| normalized catastrophe load (points of combined ratio) | 4-8 pts diversified P&C; 15-25 pts property-catastrophe reinsurance | national diversification and reinsurance protection at the floor; coastal or wildfire concentration at the ceiling |
| premium growth | nominal GDP to GDP+2 pts | a mature, rate-disciplined book near the floor; continued market-share gains or geographic expansion near the ceiling — never assume a hard-market pricing spike persists |
| net investment yield (book) | 3.5-5.5% | short-duration, cash-heavy portfolios at the floor; longer-duration, credit-diversified life portfolios at the ceiling — steady state assumes book yield has converged to prevailing new-money yield, so do not carry a stale reinvestment gap into the terminal year |
| float/reserves-to-equity leverage | 1.5-3.0x for P&C; 8-15x for life & annuity | short-tail personal lines at the P&C floor; long-tail casualty or workers' compensation at the P&C ceiling; life's much higher ratio is structural, not a leverage choice to fade toward P&C norms |
| sustainable return on equity | 10-15% P&C; 10-14% life; 8-13% reinsurance (wider band — cat exposure) | pricing discipline and scale at the ceiling in every line; chronic underpricing or reserve inadequacy at the floor |
| cost of equity | 9-12% | low-beta, diversified personal-lines and brokers at the floor; catastrophe-exposed reinsurance and rate-sensitive life at the ceiling |
| terminal growth | 2-4%, capped at long-run nominal GDP | never above the GDP ceiling regardless of any near-term hard-market pricing momentum |
| implied price-to-book | roughly (ROE - g) / (cost of equity - g); 1.0-2.2x across the sector | 1.0x is the ROE-equals-cost-of-equity case, not a floor to avoid; sustained ROE well above cost of equity is what a premium multiple must be earned by, not assumed |
| life spread over crediting rate | 150-250 bps | strong in-force pricing power and expense scale at the ceiling; heavy legacy long-term-care or guaranteed-rate blocks at the floor |
| life mortality/lapse margin | issuer's own pricing margin over the industry mortality table; do not invent a number where the issuer discloses none — say so in the cell | favorable underwriting selection and a diversified block at the ceiling; concentrated or aging blocks at the floor |
| broker organic revenue growth | 4-7% | expanding specialty and pricing tailwind at the ceiling; a mature, primarily P&C-retail mix at the floor |
| broker EBITDAC margin | 30-40% | scale and completed integration of acquired books at the ceiling; ongoing acquisition integration drag at the floor |

## Failure modes specific to this sector

- **A base year carrying reserve releases or a quiet catastrophe year forward.** Both flatter the accident-year combined ratio in a way that will not repeat; a forecast anchored on that year without normalizing either one overstates every future year's underwriting margin.
- **An equity bridge deducting policy reserves as if they were debt.** Reserves and float fund the investment portfolio the issuer already owns; netting them out of equity value the way a debt-deducting bridge would double-counts a liability the FCFE chain has already accounted for through the capital-and-dividend mechanism.
- **A discount rate borrowed from an operating-company WACC template without checking what total debt captures.** Including reserves or float in the debt weight, or omitting holding-company hybrid capital, moves the blended rate away from the cost of equity that should actually be applied.
- **Terminal value expressed as an EV/EBITDA exit multiple.** There is no EBITDA-equivalent operating metric here; a multiple sourced from an unrelated framework produces a number with no economic anchor. Use the return-on-equity-to-price-to-book relationship instead.
- **Premium growth read as a demand forecast.** Because pricing moves with the industry-wide underwriting cycle rather than customer demand, extrapolating a hard-market growth rate — or a soft-market one — into the terminal period assumes the cycle stopped exactly when the forecast happened to end.
- **A life insurer's rate sensitivity left implicit.** Because life reserves are themselves discounted, a rate scenario that is not explicitly translated into the crediting spread, reserve discount rate and lapse assumption is not really in the model, no matter how carefully premium and expense are forecast.
- **Treating a broker like an underwriter, or an underwriter like a broker.** Forcing a broker onto the FCFE and float framework invents balance-sheet mechanics it does not have; forcing an underwriter onto FCFF and an EV/EBITDA exit ignores the capital and float mechanics that actually drive its value.
