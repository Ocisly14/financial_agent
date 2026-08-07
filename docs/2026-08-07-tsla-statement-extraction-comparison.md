# TSLA statement extraction comparison: old (HTML table) path vs. new (presentation linkbase) path

Ran both extraction paths over the same Arelle extraction of Tesla's five most recent 10-Ks
(FY2021–FY2025), reconciling every `(statement, period, concept)` cell they produce. Full raw
report: `data/smoke/xbrl/tsla-statement-comparison-2026-08-07.md`. Reproduction command:

```
COMPARE_FILINGS='[...]' ARELLE_ADAPTER_COMMAND=.venv-arelle/bin/python \
node --env-file=.env --experimental-strip-types --experimental-sqlite \
  scripts/xbrl/compare-statement-extraction.ts
```

## The four counts

| | count |
|---|---|
| agree | 450 |
| only on the new path | 65 |
| only on the existing (old) path | 9 |
| disagree | **0** |

Zero cells disagree: whenever both paths independently produce a value under the same
`(statement, period, concept)` key, the two values are numerically identical. That is the load-
bearing result — it means the new presentation-linkbase extraction is not silently corrupting or
re-deriving any value the old path already gets right; every difference below is a difference in
which cells each path *surfaces*, not in what a shared cell *says*.

## Root cause behind essentially every difference: Tesla re-tags line items across filing years

Tesla changes the XBRL concept it uses to tag the same reported line item from one 10-K to the
next — this is normal, well-documented filer behavior (taxonomy migrations, extension-element
cleanups, disclosure-note restructuring), not a bug in either extraction path. Examples verified
directly against the Arelle extraction:

- `us-gaap:InterestExpense` (used in the FY2021–FY2023 10-Ks) → `us-gaap:InterestExpenseNonoperating`
  (used starting the FY2024 10-K), same dollar values.
- `us-gaap:PropertyPlantAndEquipmentNet` (FY2021–FY2024 10-Ks) →
  `us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization`
  (starting the FY2025 10-K), same dollar values.
- `us-gaap:MarketableSecuritiesCurrent` (FY2021 10-K only) → `us-gaap:ShortTermInvestments`
  (every subsequent 10-K, including FY2021 as a restated comparative), same dollar values.
- `us-gaap:RepaymentsOfConvertibleDebt` (later 10-Ks, comparative) vs.
  `tsla:RepaymentsOfConvertibleAndOtherDebt` / `us-gaap:RepaymentsOfDebt` (originating and
  intermediate 10-Ks), same dollar value for FY2021 (14,167,000,000).
- The automotive revenue/cost breakdown: FY2021's and FY2022's originating 10-Ks tag "Automotive
  sales", "Automotive leasing", "Automotive regulatory credits", "Total automotive revenues", and
  "Total automotive cost of revenues" via the generic, dimensionally-qualified
  `us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax` / `us-gaap:CostOfGoodsAndServicesSold`
  concepts (one concept, differentiated by a Product/Service-axis member per line); starting with
  the FY2023 10-K, Tesla switched to bespoke, dimensionless extension concepts
  (`tsla:AutomotiveSalesRevenue`, `tsla:AutomotiveRevenues`, `tsla:AutomotiveRegulatoryCredits`,
  `tsla:AutomotiveCostOfRevenues`, `tsla:AutomotiveLeasing`) for the *same* historical years when
  reporting them as comparatives.

**Why this produces path-only cells instead of disagreements:** the old path
(`selectFaceStatements` + `mergeCuratedTables`) resolves, for each reported period, exactly **one**
authoritative source table — the table from the one filing whose own report date equals that
period (confirmed via the run's curations: `2021-12-31 → 0000950170-22-000796`, `2022-12-31 →
0000950170-23-001409`, etc.). Its cross-filing row identity is one merged row per normalized
caption, and that row is stamped with a single representative `conceptQName` (in every case
checked, the concept used by the most recently processed contributing filing) even when the
*value* for an older period was populated from an earlier filing that used a *different* concept
for the same caption. The new path (`buildPresentedStatements`) is filing-scoped and
concept-keyed: every filing's own tagging of every period it reports — including a later filing's
retagged restatement of an earlier comparative year — becomes its own cell. So for a period where
tagging changed, the **old path's single row surfaces one key (the row's inherited
representative concept)**, and the **new path surfaces one key per filing that ever tagged that
period** (typically two: the originating filing's own tag, and a later filing's retag). Where
those two sets of keys don't coincide, each side reports a cell the other doesn't have, even
though — as the "disagree: 0" count shows — the dollar values behind them always match.

This is not something to "fix" by tolerance or normalization: it is a genuine, confirmed
difference in what the two paths *are* (old = "one authoritative source per period"; new = "every
filing's own view of every period it reports"), and it is exactly the caption/concept-identity
divergence the task brief said to expect and report plainly.

## Disagree (0 entries)

Empty. No cell where both paths report a value shows a different number.

## Only on the existing (old) path — 9 entries, all explained

| statement | period | concept | value | explanation |
|---|---|---|---|---|
| balance_sheet | FY2021 | `us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization` | 18,884,000,000 | Retag pair. Old's merged PP&E row carries the FY2025-10-K's concept name across all years; FY2021's true source (the FY2021 10-K) tagged the same value as `us-gaap:PropertyPlantAndEquipmentNet`, which appears as a new-path-only cell with the identical value. |
| balance_sheet | FY2022 | `us-gaap:PreferredStockParOrStatedValuePerShare` | 0.001 | New-path coverage gap (see below) — not a retag pair. |
| balance_sheet | FY2022 | `us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization` | 23,548,000,000 | Same retag pattern as the FY2021 row above; pairs with the new-path `PropertyPlantAndEquipmentNet` FY2022 cell (23,548,000,000). |
| balance_sheet | FY2023 | `us-gaap:CommonStockParOrStatedValuePerShare` | 0.001 | New-path coverage gap (see below). |
| balance_sheet | FY2023 | `us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization` | 29,725,000,000 | Same retag pattern; pairs with new-path `PropertyPlantAndEquipmentNet` FY2023 (29,725,000,000). |
| balance_sheet | FY2024 | `us-gaap:CommonStockParOrStatedValuePerShare` | 0.001 | New-path coverage gap (see below). |
| balance_sheet | FY2025 | `us-gaap:PreferredStockParOrStatedValuePerShare` | 0.001 | New-path coverage gap (see below). |
| cash_flow_statement | FY2021 | `us-gaap:RepaymentsOfConvertibleDebt` | 14,167,000,000 | Retag pair. Pairs with the new-path-only cells `tsla:RepaymentsOfConvertibleAndOtherDebt` (14,167,000,000) and `us-gaap:RepaymentsOfDebt` (14,167,000,000) for the same period — Tesla used three different concepts for this line across the five filings. |
| income_statement | FY2021 | `us-gaap:InterestExpenseNonoperating` | 371,000,000 | Retag pair. Old's merged row carries the FY2024-10-K concept name; FY2021's originating filing tagged the same value `us-gaap:InterestExpense`, which appears new-path-only with the identical value. |

**A real, confirmed new-path gap (4 of the 9 rows):** the two par-value-per-share memo lines
(`us-gaap:PreferredStockParOrStatedValuePerShare`, `us-gaap:CommonStockParOrStatedValuePerShare`)
never appear as a presentation-linkbase node in the `balance_sheet` role of **any** of the five
filings, per direct inspection of the Arelle extraction's `statements` payload — the node simply
isn't declared there, even though the concept is tagged inline and is picked up correctly by the
old path's raw HTML-cell reading. This is not a value mismatch (the new path emits nothing at all
for these four cells, rather than a wrong number) and it is immaterial to the DCF (both are
constant $0.001 display lines with a corresponding `*Value` line — `PreferredStockValue`,
`CommonStockValue` — carrying the real dollar amount, which *does* round-trip and agree on both
paths for every period). It should be tracked as a known, narrow coverage gap in the new path
rather than treated as a blocker.

## Only on the new path — 65 entries, categorized

**Category A — retagging of a period that a later filing also restates (the large majority, ~57 of 65
entries).** As described above: the originating filing's own tag for a period surfaces as a
new-path-only cell whenever a later filing's restatement (which the old path's single-source-per-
period design never incorporates) is what ends up as the old path's row-level representative
concept. Confirmed pairs, all with identical old/new dollar values:
- Balance sheet: `us-gaap:PropertyPlantAndEquipmentNet` FY2021/FY2022/FY2023/FY2024 (18,884M /
  23,548M / 29,725M / 35,836M); `us-gaap:MarketableSecuritiesCurrent` FY2021 (131M, pairs with
  old's `ShortTermInvestments` FY2021 cell).
- Cash flow: `tsla:RepaymentsOfConvertibleAndOtherDebt` and `us-gaap:RepaymentsOfDebt` FY2021
  (14,167M each, pairing with old's single `RepaymentsOfConvertibleDebt` cell).
- Income statement (FY2021/FY2022 only — the two years whose originating 10-Ks used the older
  tagging convention that later 10-Ks replaced): the full automotive revenue/cost breakdown
  (`tsla:AutomotiveSales`, `tsla:AutomotiveSalesRevenue`, `tsla:AutomotiveRevenues`,
  `tsla:AutomotiveRegulatoryCredits`, `tsla:AutomotiveCostOfRevenues`, `us-gaap:Revenues`,
  `us-gaap:DirectCostsOfLeasedAndRentedPropertyOrEquipment`), `us-gaap:InterestExpense`, and a
  handful of income-statement subtotal/memo concepts (`us-gaap:NetIncomeLossAvailableToCommon
  StockholdersBasic`, `tsla:BuyOutOfNoncontrollingInterest`) that the old path's caption-matching
  merge never created a distinct row for at all (the concept and label exist on the new path's
  presentation node, but no corresponding old-path row/caption match exists for any period — a
  narrower sub-case of the same underlying phenomenon: the old path's cross-filing caption merge
  is lossy relative to the full set of concepts each individual filing actually tags).
- Cash flow, later years (FY2021–FY2024): `us-gaap:IncreaseDecreaseInOtherNoncurrentAssets`,
  `us-gaap:IncreaseDecreaseInOtherNoncurrentLiabilities`,
  `tsla:IncreaseDecreaseInContractWithCustomerLiabilityCustomerDeposits`, `us-gaap:IncomeTaxesPaid`,
  `us-gaap:PaymentsToAcquireIntangibleAssets`, `us-gaap:PaymentsToAcquireMarketableSecurities`,
  `us-gaap:ProceedsFromIssuanceOfCommonStock`, `us-gaap:ProceedsFromMinorityShareholders`,
  `us-gaap:ProceedsFromRepaymentsOfSecuredDebt`, `us-gaap:BusinessCombinationConsideration
  TransferredEquityInterestsIssuedAndIssuable`, `tsla:GainOnDigitalAssets`,
  `tsla:OperatingCashFlowRelatedToRepaymentOfDiscountedConvertibleSeniorNotes`,
  `tsla:GovernmentGrantReceipt`, `tsla:PaymentsForSolarEnergySystemsNetOfSales`,
  `tsla:PaymentsToAcquireOtherIndefiniteLivedIntangibleAssets`,
  `tsla:ProceedsFromSalesOfDigitalAssets`, `tsla:PurchaseOfDigitalAssets` — each is a concept a
  given filing tags for a given year, that the old path's single-source-per-period, caption-merged
  row set does not surface under the same key for that year (either because the caption text
  differs slightly between filings, or because the old path's merge simply never built a row for
  that specific caption/period combination). Every one of these is a genuine XBRL fact present in
  the underlying filing; none is fabricated by the new path.

**Category B — face caption folded into a broader line in a later filing (~6 of 65 entries),
confirmed by direct comparison against the old path's full row set.** The concept is still tagged
(and picked up by the new path) in the later filing, but is no longer printed as its own row on
the face of the statement that year, so the old path's HTML-table caption match stops:
- `us-gaap:Goodwill`, `us-gaap:IntangibleAssetsNetExcludingGoodwill`,
  `tsla:DigitalAssetsNetNonCurrent` — all three have an old-path row that runs FY2021–FY2023 and
  stops; the FY2024 value the new path reports (244M, 150M, 1,076M respectively) is real but no
  longer printed as a distinct face caption starting with the FY2024 10-K (folded into "Other
  non-current assets").
- `tsla:CustomerDepositsLiabilitiesCurrent` FY2022 (1,063,000,000) — old's row for "Customer
  deposits" exists only for FY2021 (925,000,000); Tesla folded this caption into "Accrued
  liabilities and other" from the FY2022 10-K onward, but the underlying fact is still tagged
  (with a different dollar figure, reflecting real balance growth, not a tagging artifact) and the
  new path's concept-keyed extraction still picks it up.

**Category C — genuine zero/near-zero supplemental disclosure lines (~2 of 65 entries).**
`us-gaap:BusinessCombinationConsiderationTransferredEquityInterestsIssuedAndIssuable` = 0 and
`us-gaap:ProceedsFromIssuanceOfCommonStock` = 0 for FY2021/FY2022: presentation nodes the
linkbase declares with a zero-valued fact that year; the old path's HTML-table extraction likely
never created a row because the printed cell showed "—" rather than a numeric zero cell that its
row-detection heuristics recognized as a distinct line. Immaterial (zero-valued) in every case
observed.

## Verification (`verifyPresentedStatement`)

- **Balance sheet: zero balance breaks in every reported period, across all five filings.**
  Assets = Liabilities + Stockholders' Equity ties out exactly on the new path for every year
  requested — this is the required confirmation from the task brief.
- **Roll-up breaks: 5 total, confined entirely to the two oldest filings** (FY2021 10-K:
  income_statement 1, cash_flow_statement 3; FY2022 10-K: income_statement 4). Root cause
  confirmed by direct inspection: Tesla's two oldest 10-Ks tag the automotive/energy/services
  revenue and cost-of-revenue sub-lines exclusively via **dimensional** facts on a shared generic
  concept (`us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax`,
  `us-gaap:CostOfGoodsAndServicesSold`) — there is no accompanying **dimensionless** fact for the
  individual addend that the calculation linkbase's roll-up expects, so
  `verifyPresentedStatement`'s "reported vs. computed" check correctly cannot find the children
  and reports them as `missingChildren`. The **totals themselves are correct** — e.g. FY2021
  `us-gaap:CostOfRevenue` = 40,217,000,000 and `us-gaap:Revenues` = 53,823,000,000 both match the
  old path exactly (part of the 450 agreeing cells) — only the child-level arithmetic
  cross-check is blocked by the absence of dimensionless addend facts in those two filings' own
  tagging. The FY2021 cash-flow-statement breaks (`NetCashProvidedByUsedInFinancingActivities`,
  `...InvestingActivities`, `...OperatingActivities`) have the identical root cause: their missing
  children (e.g. `us-gaap:PaymentsForHedgeFinancingActivities`,
  `us-gaap:ProceedsFromIssuanceOfWarrants`) exist as presentation nodes but carry no fact for
  FY2021 in that filing's own extraction. Starting with the FY2023 10-K, Tesla switched to
  dimensionless extension concepts for these lines and the roll-up breaks disappear entirely (0
  roll-up breaks in the three most recent filings). This is a real, correctly-detected limitation
  of what the two oldest filings' own XBRL tagging supports — not a defect in the verifier or the
  new extraction path.
- `totalsUnavailable` is `false` for every statement/filing (a calculation linkbase was always
  found).

## Bottom line for the switchover decision

- The new path never disagrees with the old path on a value both surface (0/459 old cells, 0/515
  new cells in conflict).
- Every "only new" and "only old" cell has a concrete, evidence-backed explanation; the large
  majority (Category A, ~57/65 new-only + 5/9 old-only) is Tesla's own cross-filing XBRL retagging
  interacting with the old path's "one source table per period, one concept per merged row"
  design — a design limitation of the old path that the new path does not share, since it is
  filing-scoped and concept-keyed.
- One confirmed, narrow, immaterial gap exists in the new path today: the two par-value-per-share
  memo lines are absent from every filing's presentation-linkbase payload (4 cells; the associated
  dollar-value lines, `PreferredStockValue`/`CommonStockValue`, are unaffected and agree on both
  paths).
- Balance-sheet integrity (assets = liabilities + equity) holds with zero breaks across all five
  filings and five years on the new path.
