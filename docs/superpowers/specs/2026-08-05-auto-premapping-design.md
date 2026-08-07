# Auto Pre-Mapping Design — Engine Fills, Agent Audits

Status: draft for review
Date: 2026-08-05
Depends on: `2026-08-05-revenue-decomposition-design.md` (decomposition summary / materialized child rows)

## 1. Goal and principle

Today `mapping_review` (renamed from `historical_mapping`; the rename is already applied in code)
proposes every `statementMappingPlan` and every revenue stream from scratch. Most of that mapping is deterministic — face rows carry `conceptQName`, the DCF spine
carries stable ids, and decomposition child rows are minted by our own code. The redesign inverts
the flow:

1. **Engine pre-maps deterministically** at import time: concept vocabulary → spine rows, face
   presentation children of revenue → revenue streams, accepted decomposition schemes → revenue
   streams. Values and YoY growth then compute automatically through existing skeleton formulas.
2. **Agent audits**: the projection shows what the engine filled (with per-row rationale) plus the
   rows it could not place. The agent may confirm, remap, add streams/groups, or split rows — every
   override carries a reason.
3. **Reconciliation is the safety net**: any auto-mapped target that fails identity checks
   (Σ members ≠ face value, Σ streams ≠ revenue.total) is demoted back to unmapped and handed to
   the agent; nothing wrong lands silently.

Deterministic errors are systematic and testable; agent errors are random. Auto-fill therefore
runs first and the agent's job narrows to genuine judgment.

## 2. Inputs the engine already has

- `PreparedStatementRowView` (types.ts:72): `conceptQName`, `dimensionSignature`, `depth`,
  `parentSourceLineItemId`, `negated`, per-statement ordering.
- Spine line items with stable ids/roles (`skeleton.ts createSkeleton`): `revenue.total`,
  `cost_of_revenue` … `net_income` (history section), balance rows, cash-flow rows, bridge rows.
- `StatementMappingPlan` (types.ts:239): `targetLineItemId`, `periodIds`, members with
  add/subtract/exclude treatment.
- `DecompositionSummary` on the SourceReviewArtifact (accepted schemes, child row ids, residuals).

## 3. Layer 1 — vocabulary mapping: face rows → spine rows

A static table `CONCEPT_SPINE_MAP` in `src/financial-model/autoPremap.ts` maps us-gaap concepts
(exact QName match after namespace normalization; no regex except revenue family, reused from
`isRevenueFamilyConcept`) to spine ids. Initial coverage, income statement:

| Spine id | us-gaap concepts (any of) |
|---|---|
| `revenue.total` | `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`, `RevenueFromContractWithCustomerIncludingAssessedTax`, `SalesRevenueNet` |
| `cost_of_revenue` | `CostOfRevenue`, `CostOfGoodsAndServicesSold`, `CostOfGoodsSold` |
| `gross_profit` | `GrossProfit` |
| `research_and_development` | `ResearchAndDevelopmentExpense` |
| `selling_and_marketing` | `SellingAndMarketingExpense`, `SellingGeneralAndAdministrativeExpense`* |
| `general_and_administrative` | `GeneralAndAdministrativeExpense` |
| `operating_expenses` | `OperatingExpenses`, `CostsAndExpenses` |
| `operating_income` | `OperatingIncomeLoss` |
| `interest_income` / `interest_expense` | `InvestmentIncomeInterest` / `InterestExpense`, `InterestExpenseNonoperating` |
| `pretax_income` | `IncomeLossFromContinuingOperationsBeforeIncomeTaxes…` variants |
| `income_tax_expense` | `IncomeTaxExpenseBenefit` |
| `net_income` | `NetIncomeLoss`, `ProfitLoss` |
| `net_income_attributable_nci` | `NetIncomeLossAttributableToNoncontrollingInterest` |
| `depreciation_amortization` | `DepreciationDepletionAndAmortization`, `DepreciationAmortizationAndAccretionNet` |
| `capital_expenditures` | `PaymentsToAcquirePropertyPlantAndEquipment` |

\* `SellingGeneralAndAdministrativeExpense` maps to `selling_and_marketing` only when no separate
G&A row exists; if the filing has combined SG&A, it maps there and `general_and_administrative`
stays empty (agent may re-split later).

Balance and cash-flow tables follow the same pattern (accounts_receivable ←
`AccountsReceivableNetCurrent`, operating_cash_flow ←
`NetCashProvidedByUsedInOperatingActivities`, …) — full table lives in the implementation plan.

Rules:
- Only **dimensionless** face rows participate (`dimensionSignature` empty); dimensional rows are
  segment detail, handled by Layer 2 or left to the agent.
- One spine target ↔ at most one source row per period set. If two face rows match the same spine
  id in the same periods (e.g. concept changed across filings), the engine emits **two plans with
  disjoint periodIds** when periods don't overlap, else marks the target `conflict` and leaves it
  unmapped for the agent.
- `negated` rows get treatment `subtract` only when the spine target semantics require it;
  otherwise sign conventions stay as extracted (facts already carry signed values).
- Every generated plan gets `reviewDecisionId: "auto-premap-v1"` prefix +
  shortHash(target|periods) so agent overrides are distinguishable from engine output.

## 4. Layer 2 — revenue streams: two sources, one arbitration

**(a) Face presentation children.** Rows whose `parentSourceLineItemId` chain reaches the
revenue-total face row and whose own concept is in the revenue family become auto streams — e.g.
Tesla's Automotive sales / Automotive leasing / Energy / Services rows. Slug =
kebab→snake of normalized label; stream label = face label; one mapping plan per stream
(`members: [that row]`, add).

**(b) Accepted decomposition schemes.** When `apply_revenue_decomposition` materializes child +
residual rows, it also emits streams and plans for them (child → `revenue.<slug>`, residual →
`revenue.other_<axis>`). Residual ratio > 30 % keeps the existing spec flag and the scheme is NOT
auto-injected — it goes to the agent as a proposal instead.

**Arbitration (face-first).** If face children already decompose revenue on some axis, a
decomposition scheme on the *same* axis is not injected (its labels normalize-match ≥ 50 % of face
children ⇒ same axis); a scheme on a different axis (e.g. geography vs product) may coexist only as
**category groups**, not as a second set of streams — streams must partition `revenue.total`
exactly once. Default: streams come from the highest-priority source available
(face children > accepted scheme > none), other axes become read-only category groups.

**Identity guard.** After injection the engine evaluates Σ streams (+ residual) vs `revenue.total`
per historical period; |gap| > 0.5 % of total demotes the whole stream set to unmapped + a
diagnostic, agent decides.

## 5. Agent audit interface

`projectForDcfSubagent` for `mapping_review` gains a `premap` block (replacing nothing —
existing fields stay):

```jsonc
premap: {
  version: "auto-premap-v1",
  mapped: [ { targetLineItemId, targetLabel, sourceRows: [{ sourceLineItemId, label, conceptQName }],
              periodIds, basis: "concept_vocab" | "face_child" | "decomposition_scheme",
              reconciliation: "ok" | "gap", gapDetail? } ],
  unmapped: { spineTargets: [ids with no plan], sourceRows: [face rows not consumed, with label+concept] },
  demoted: [ { targetLineItemId, reason } ],
}
```

The agent's proposal payload (existing `parseHistoryReviewInput` shape) is reinterpreted as a
**delta over the premap**, with four verbs the prompt names explicitly:

- **confirm** — default; absent targets in the proposal mean "accept engine mapping as-is".
- **remap** — a `statementMappingPlan` for an already-mapped target replaces the engine plan
  (service keeps one plan per target/period-set; engine plans are replaceable because their
  `reviewDecisionId` carries the auto prefix). Requires rationale.
- **add** — new streams (`categoryLineItems` parentId=revenue) or groups for rows the engine left
  unmapped.
- **split** — remap one engine-mapped source row into ≥ 2 targets (e.g. combined SG&A split via a
  decomposition table); expressed as remap of the original target + add of the new one.

Prompt change: the mapping-review system prompt states the engine has already mapped N rows,
instructs the agent to audit titles/mappings rather than rebuild, and to touch only rows it
disagrees with plus the unmapped remainder.

## 6. Where it runs

- **`import_source_review`** (model creation): Layer 1 + Layer 2(a) run inside
  `stagePreparedStatements`/service import path, before the first workbook revision is returned.
  The model is immediately populated: historical values filled, `YOY(revenue.total)` and per-stream
  growth computed by existing formulas. This does not depend on the decomposition pipeline.
- **`apply_revenue_decomposition`**: Layer 2(b) incremental — materializes source rows (existing
  behavior) and injects streams/plans through the same one-plan-per-target service path. Because
  initial mappings may already be committed by then, injection uses the
  `set_statement_mapping_plan` path, not the one-shot initial import guard (service.ts:305).
- Re-running apply stays idempotent: engine-owned streams/plans (auto reviewDecisionId prefix) are
  replaced as a set, mirroring the existing materialization strip-and-rewrite.

## 7. Failure modes

| Failure | Behavior |
|---|---|
| Concept matches two spine ids | vocabulary is checked at build time to be injective; CI test |
| Two source rows → one spine id, overlapping periods | target left unmapped, `demoted` entry, agent decides |
| Σ streams ≠ revenue.total beyond 0.5 % | stream set demoted, diagnostic, agent decides |
| Combined SG&A | maps to selling_and_marketing, G&A empty; agent may split |
| Concept changes across filings | disjoint-period plans per concept when periods don't overlap |
| Decomposition residual > 30 % | scheme surfaces as proposal only, no auto injection |
| Face children and scheme on same axis | face wins; scheme dropped from stream injection |
| Agent proposes plan for engine-mapped target without rationale | proposal rejected by validator |

## 8. Non-goals

- No fuzzy/label-based matching in the engine (concept QName only); labels are for the agent.
- No auto-mapping of dimensional face rows outside the revenue-children rule.
- No change to forecast logic; streams inherit the existing YOY/LAG formula wiring.
