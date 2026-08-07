# Statement Extraction from the Presentation Linkbase

Date: 2026-08-07
Status: Approved design, not yet implemented

## 1. Purpose

Extract each filing's three face statements directly from its XBRL presentation linkbase and facts,
instead of scraping the filing's rendered HTML tables and guessing which table is which statement.

The current path reaches the same statements through a chain of inferences, and every inference has
produced a defect:

| Inference | Defect it produced |
|---|---|
| Score 58 HTML tables to guess which is the balance sheet | needs a combinatorial assignment search |
| Map HTML columns to reporting periods | a single stray instant fact claimed a whole period and silently dropped two years of the cash flow statement |
| Derive row hierarchy from HTML indentation | 0 of 46 TSLA balance-sheet rows got a parent |
| Use the normalized caption as cross-filing row identity | TSLA embeds share counts in captions, forking one row into five phantom rows |
| Compare a cell's column period against its fact period | the `incompatible_context` conflict class exists only because of this |

None of these inferences is necessary. The issuer already declares the structure.

## 2. Evidence

A 50-line probe (pick the presentation role, walk the tree, look up facts by concept and period)
produced TSLA's FY2025 balance sheet complete, correctly nested, in the issuer's own order and with
the issuer's own captions, on the first attempt:

```
Total assets                137,806
Total liabilities            54,941
Redeemable NCI                   58
Total stockholders' equity   82,137
Noncontrolling interests        670
                            -------
                            137,806  =  Total liabilities and equity  137,806
```

All five real TSLA 10-Ks carry a calculation linkbase (49-61 relations, 23-28 roles). The three
10-K/A amendments carry none, which is correct: they contain no statements.

Two facts that shaped this design:

- The balance-sheet calculation role reaches `us-gaap:Liabilities` and both
  `tsla:LongTermDebtAndFinanceLeases*` extension concepts. Issuer extension concepts are ordinary
  tree members here, so the "a static us-gaap vocabulary can never match `tsla:` concepts" problem
  does not arise on this path.
- The income-statement calculation role declares `NetIncomeLoss = ProfitLoss -
  NetIncomeLossAttributableToNoncontrollingInterest`, the tie-break that currently costs one agent
  call per run.

## 3. Scope

### 3.1 In scope

- A new companion protocol field carrying, per filing, the three face statements as presentation
  trees with resolved facts.
- TypeScript types and a pure builder that shapes those trees into a per-(accession, statement)
  artifact scoped to the requested periods.
- Three deterministic verifications over that artifact.
- A reconciliation harness that runs the new and existing extraction paths over the same filings and
  reports every per-cell difference.
- Fixture-based unit tests.

### 3.2 Explicitly out of scope

- `mergeCuratedTables`, `autoPremap`, `skeleton`, statement mapping, the DCF spine, forecast, and
  valuation are not touched.
- Cross-year merging of per-filing statements. Each filing yields its own statements; combining them
  is separate work.
- Generalizing dimensional decomposition beyond revenue. The existing `revenue_decomposition`
  pipeline is unchanged.
- Switching the pipeline over to the new path. That decision follows the reconciliation report.

The HTML table layer stays. The note tables feed `filing_decomposition` (`list_table_rows`,
`get_table_facts`) and filing insights read prose. Only the three face statements stop depending on
it.

## 4. Companion protocol change

`scripts/xbrl/arelle_companion.py`, `PROTOCOL_VERSION` 2 to 3. Existing fields (`tables`,
`calculationRelations`, `negatedConcepts`, `diagnostics`) are unchanged, so the current pipeline
keeps working while both paths run side by side.

New per-filing field:

```jsonc
statements: [{
  statement: "income_statement" | "balance_sheet" | "cash_flow_statement",
  roleUri: string,
  roleLabel: string,
  nodes: [{
    nodeId: number,                 // pre-order index within this statement
    parentNodeId: number | null,
    conceptQName: string,
    label: string,                  // the relationship's preferredLabel, else the standard label
    abstract: boolean,              // structure-only node, carries no facts
    dimensions: [{ axisQName: string, memberQName: string }],
    facts: [{ periodId, value, unit, decimals, contextId, sourceAnchor }]
  }]
}]
```

Design notes:

- **Role selection reuses `choose_statement_roles`**, which already picks a presentation role per
  statement from the role's definition text. It is currently computed and used only to score HTML
  tables; here it becomes the primary output.
- **The tree is emitted pre-order flattened with an explicit `parentNodeId`** rather than nested, so
  a concept appearing under two parents stays two distinct nodes.
- **`dimensions` records the dimensions of the fact that was resolved for the node, and the pairing
  is not structural.** In TSLA's balance sheet the axis subtree
  (`us-gaap:PropertyPlantAndEquipmentByTypeAxis` with its two members) and the line items sit in
  *sibling* branches under `StatementTable`; nothing in the tree says which member belongs to which
  line. The link exists only in the facts:

  ```
  us-gaap:DeferredCostsLeasingNetNoncurrent  4,912  [PropertyPlantAndEquipmentByTypeAxis=OperatingLeaseVehiclesMember]
  tsla:LeasedAssetsNet                       4,604  [PropertyPlantAndEquipmentByTypeAxis=EnergyGenerationAndStorageSystemsMember]
  ```

  Resolution rule, which contains no judgement:

  1. **Collapse by context.** An XBRL fact is `(concept, context, unit)`. An inline document tags the
     same fact wherever it appears, so the raw fact list repeats it — TSLA tags
     `CashAndCashEquivalentsAtCarryingValue` three times for one period. Index by
     `(conceptQName, contextId)` first. Within one context, a filer may state the same number at two
     roundings (`decimals=-6` → 1,423,000,000 and `decimals=-7` → 1,420,000,000, which are consistent
     within their precisions); keep the finer one. That is one assertion at higher resolution, not a
     choice between two values.
  2. **A dimensionless context is the line.** If the concept has a dimensionless fact for the period,
     that is the value. Dimensional facts are its breakdown and are not consulted.
  3. **Otherwise fall back to a declared axis.** If the concept has exactly one fact for the period
     whose dimensions use only axes declared in this role, that is the value.
  4. **Otherwise no value**, and if the losing step had more than one candidate, record the period in
     `ambiguousPeriodIds` and emit nothing.

  Measured against TSLA's FY2025 10-K, across the three face statements: 232 concept-periods resolve
  at step 2 with **zero** cases of competing dimensionless contexts, 4 resolve at step 3 (exactly the
  two lease rows above, two periods each), and **zero** reach step 4. `ambiguousPeriodIds` is a safety
  net for other filers, not a routine outcome.

  Steps 1 and 2 are not optional refinements. Without step 1, every repeatedly tagged line — cash, net
  income, total current liabilities — has "multiple candidates" and blanks out. Without step 2, the
  income statement's `CostOfRevenue` competes with its five `srt:ProductOrServiceAxis` members and
  blanks out too.

  Getting this right is also load-bearing for the roll-up check: without the two dimensional lease
  rows TSLA's asset roll-up is short by 9,516; with them it ties exactly
  (`68,642 + 4,912 + 4,604 + 40,643 + 6,027 + 1,008 + 6,925 + 5,045 = 137,806`). The check in §5.2 is
  therefore also the guard on this rule.
- **A `periodStartLabel` row reads the opening instant, not the closing one.** The cash rollforward's
  "beginning of period" and "end of period" lines are the same concept; the presentation linkbase
  distinguishes them only by the relationship's `preferredLabel` role:

  ```
  us-gaap:CashCashEquivalentsRestrictedCash…  http://www.xbrl.org/2003/role/periodEndLabel
  us-gaap:CashCashEquivalentsRestrictedCash…  http://www.xbrl.org/2003/role/periodStartLabel
  ```

  Resolving both by `(concept, period)` gives them identical values — TSLA's opening row would read
  17,616 for FY2025 where it should read 17,037, the 2024-12-31 instant. So each fact carries two
  period keys: `periodId`, the requested period whose END the fact's moment matches, and
  `startsPeriodId`, the requested period whose START it opens (an instant only, dated the day before
  that period's start). A node whose relationship role is `periodStartLabel` resolves on
  `startsPeriodId`; every other node resolves on `periodId`. The emitted fact is stamped with the
  display period either way, so nothing downstream needs to know which key was used.

  This is the same row whose stray instant caused the existing HTML path to silently drop two years
  of the cash flow statement. On this path it cannot claim a period, but it would still print a wrong
  number, so it is handled rather than tolerated.

- **Facts are resolved by the companion**, since only it holds the Arelle model. `periodId` is
  matched against the request's periods by the context's instant or duration end date, normalized
  with the companion's existing `iso_date(..., subtract_day=True)` helper. Arelle reports both as
  the following midnight, so the subtraction is required, not cosmetic.
- A filing with no presentation role for a statement emits no entry for that statement. This is not
  an error; it is what a Part III-only amendment looks like.

## 5. TypeScript components

### 5.1 `src/infra/xbrl/presentedStatement.ts`

Types mirroring the protocol, plus:

```ts
buildPresentedStatements(input: {
  filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[];
}): PresentedStatement[]
```

One `PresentedStatement` per (accession, statement). A pure data transform: keep nodes in declared
order, drop facts outside the requested periods, and record which periods survived. No scoring, no
heuristics, no cross-filing logic.

### 5.2 `src/infra/xbrl/verifyPresentedStatement.ts`

```ts
verifyPresentedStatement(
  statement: PresentedStatement,
  relations: readonly CalculationRelation[],
): StatementVerification
```

Three checks:

1. **Roll-up.** For each calculation relation whose `roleUri` matches this statement's role, and for
   each period, compare the parent's fact against the weighted sum of the children's facts. Reuses
   the arithmetic and tolerance rule already in `verifyCalculationRollups`. A relation with no
   children present in the tree is skipped; a relation with some children present and some absent is
   reported with the absent concepts listed, as it is today.
2. **Balance.** Balance sheet only: `us-gaap:Assets` equals `us-gaap:LiabilitiesAndStockholdersEquity`
   per period. Both are reported facts, so this is an equality check, not a roll-up. Skipped without
   a diagnostic when the filer does not tag `LiabilitiesAndStockholdersEquity`.
3. **Period completeness.** A statement's reported periods are the periods in which its total nodes
   carry facts, where a total node is any node that is a parent in the statement's calculation
   relations. This deliberately replaces the current "any fact in this statement exists for this
   period" rule, which one stray beginning-of-period instant was enough to satisfy while five years
   of the cash flow statement were in fact missing.

   When the role has no calculation relations, there are no total nodes to test. The verification
   then reports `totalsUnavailable: true` and sets `reportedPeriodIds` to the union of periods over
   all non-abstract nodes. It must not silently report full coverage, and it must not report a
   break: absent a calculation linkbase there is nothing to check against.

`StatementVerification` carries `rollupBreaks`, `balanceBreaks`, and `reportedPeriodIds`. It returns
findings; it does not throw and does not gate anything in this phase.

### 5.3 `scripts/xbrl/compare-statement-extraction.ts`

Runs both extraction paths over the same filings and joins them on
`(statement, periodId, conceptQName)`. Emits a markdown report with four sections: values that
agree, present only on the new path, present only on the existing path, and values that disagree.
Also prints each statement's `StatementVerification`.

This report is the acceptance artifact. Known differences to expect, all of which the report should
make explicit rather than hide:

- Rows the existing path lost to the period-claiming defect (fixed in the current working tree, so
  the baseline should already carry them).
- The phantom caption-forked rows, which exist only on the existing path.
- Dimensional balance-sheet rows, which exist only on the new path unless `dimensions` handling is
  correct.

## 6. Testing

Fixture-driven, following the existing `scripts/xbrl/fixtures/` and `validate_fixture` pattern.
Capture one protocol-3 companion response for TSLA's FY2025 10-K and commit it as a fixture, so the
tests need neither network nor Arelle.

Unit tests cover:

- an abstract node contributes structure and no facts;
- a node under an axis/member chain resolves its dimensional fact, and the same concept's
  dimensionless fact is not substituted for it;
- `parentNodeId` reconstructs the declared nesting, including a concept appearing under two parents;
- facts outside the requested periods are dropped;
- a roll-up whose children sum correctly passes, and one that does not is reported with its
  difference and its absent children;
- `Assets` equal to `LiabilitiesAndStockholdersEquity` passes, unequal is reported, and an untagged
  `LiabilitiesAndStockholdersEquity` is skipped silently;
- period completeness excludes a period in which only a non-total node carries a fact, which is the
  cash-flow regression in test form.

Python-side tests for the companion follow the existing `arelleCompanion*.test.ts` pattern, driving
the companion over stdin with a recorded model where possible.

## 7. Risks and open questions

1. **`choose_statement_roles` is scored from role definition text.** It works on TSLA. It is not
   verified against a second issuer, and a filer with unusual role labels could select the wrong
   role. The reconciliation report surfaces this as a wholesale mismatch rather than a subtle one,
   which is the failure mode we want. Validating against a second issuer, AAPL, should happen before
   any switchover.
2. **Comprehensive income is a separate role.** Filers who present a combined statement of
   operations and comprehensive income may put rows we expect in the income statement into a role
   that scores as comprehensive income. Not handled here; the reconciliation report will show it.
3. **Dimensional fact resolution is the only genuinely new logic** and therefore the most likely
   source of new defects. The unit test above and the roll-up check are the guards. The known
   failure mode is an issuer whose face statement carries two members of the same axis for one
   concept, which the rule reports as ambiguous rather than resolving; that surfaces as a roll-up
   break, not as a silently wrong number.
4. **The existing path's column-to-period inference becomes dead code if the switch happens.** The
   `claimed` fix made to it on 2026-08-07 stays valuable in the meantime, because the existing path
   is the reconciliation baseline and must be correct for the comparison to mean anything.

## 8. What this does not answer

Cross-year merging. Each filing yields its own statements with its own structure, per the decision
to build per-year statements first. How five filings' statements become one five-year model is the
next design, and it is now a concept-keyed problem rather than a caption-matching one, which should
make it substantially easier than it is today.
