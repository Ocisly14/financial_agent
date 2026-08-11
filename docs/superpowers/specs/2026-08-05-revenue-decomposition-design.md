# Revenue Decomposition via Filing Map-Reduce Agents

Date: 2026-08-05
Status: Approved design, not yet implemented

## 1. Decision

Add a revenue-decomposition stage between deterministic face-statement selection and `historical_mapping`. The stage discovers issuer-specific revenue breakdowns (by product line, by geography, and any other axis the filings support) from the already-persisted non-face tables, and turns the best one into the forecast driver for revenue.

The stage follows the platform's established split of responsibilities:

- Deterministic host code does everything rules can do reliably: candidate pre-screening, fact validation, cross-filing value adjudication, label alignment, residual computation, and forecast rewiring.
- Agents do only what requires judgment: deciding which tables support a coherent decomposition for this company, aligning scheme children across filings when labels drift, and ranking schemes by reasonableness.
- Agents never supply a source number. They reference `factId` and `sourceLineItemId` values returned by tools.

Scope is revenue only: rows of the income statement that carry revenue-family concepts, including issuers that already split revenue on the face (e.g. AAPL Products/Services). Cost and segment-profit decomposition are out of scope; the data model (one face row → N schemes → N children) is generic so later extension does not change the architecture.

The existing four subagents (`statement_extraction`, `historical_mapping`, `forecast_modeling`, `valuation_review`) are unchanged. Two subagent kinds are added: `filing_decomposition` (map, one per filing, parallel) and `decomposition_reduce` (reduce, single).

## 2. Pipeline

```text
arelle extraction + deterministic face selection (unchanged)
  -> N parallel filing_decomposition agents (one per filing)
  -> host: fact validation, cross-filing adjudication (filedAt precedence),
           label alignment, coverage matrix, residual ratios
  -> 1 decomposition_reduce agent: select / merge / rank schemes
  -> parent DCF Agent reviews (may reorder, may reject decomposition entirely)
  -> host: materialize child rows, residual "Other" rows, driver rewiring
  -> historical_mapping (receives final decomposition structure in base context)
```

The parallel unit is the filing, not the fiscal year. One 10-K typically discloses up to three comparative years of revenue disaggregation, and tables are stored per filing. Overlapping year coverage across filings is raw material for the host's adjudication step, not a problem for the agents.

## 3. Map stage: `filing_decomposition`

One agent per filing, run in parallel. Uses the standard text tool protocol (`{"action":"call_tool","calls":[{"tool":...,"input":...}]}`) and the same loop/transcript rules as other project subagents.

### 3.1 Base context (title-only, no values)

- The filing's three face statements: row titles with `sourceLineItemId`, column titles with period ids.
- The filing's pre-screened table catalog: `sourceTableId`, heading, prescreen tier, `suggestedStatements`.
- Requested periods.

### 3.2 Private tools

**`list_table_rows({ sourceTableId })`** — row labels, indentation, column headers, and per-cell markers (has fact, dimension-signature digest). No values.

**`get_table_facts({ sourceTableId, rowOrders })`** — exact facts for up to 20 rows: `factId`, value, period, unit, dimensions, concept, source anchor.

Face-statement staging mints `factId` in `mergeCuratedTables()` only, so the host mints ids for non-face table facts on first tool read, using the same recipe with an in-table coordinate: `xbrl-` + sha256(`accession | sourceTableId:rowOrder | periodId | contextId`). Minted ids are persisted with the ingestion run so later validation resolves exactly the facts the agent saw; an id that resolves to nothing is rejected.

### 3.3 Proposal

```ts
{
  rationale,
  payload: {
    schemes: Array<{
      schemeId,                 // local to this filing
      label,                    // e.g. "by product line", "by geography"
      axisHint,                 // dimension axis qname or "presentation-only"
      targetSourceLineItemId,   // which face revenue row is being split
      children: Array<{
        label,
        memberHint,             // dimension member qname when available
        factRefs: Array<{ factId, periodId }>
      }>
    }>
  },
  sourceRefs
}
```

An empty `schemes` array is a legal result meaning "this filing supports no decomposition".

## 4. Host deterministic middle layer (after map, before reduce)

1. **Validation.** Every referenced `factId` must exist in the filing's extraction, carry a revenue-family concept, and be consistent with the scheme's `axisHint`. "Revenue-family" is decided deterministically: the concept either matches the us-gaap revenue set (`Revenues`, `RevenueFromContractWithCustomer*`, `SalesRevenue*`) or is connected to the target face revenue row's concept through the filing's calculation relations. An invalid reference rejects the whole scheme and records a diagnostic.
2. **Cross-filing adjudication.** When the same (child, period) cell is supplied by multiple filings, the newest `filedAt` wins — the same precedence rule as `mergeCuratedTables()`.
3. **Preliminary alignment.** Children are aligned across filings by `normalizeLabel()` plus `memberHint`. The output is a set of candidate cross-year schemes, each with:
   - a **coverage matrix** (child × year: value present or gap; gaps are never fabricated);
   - per-year **residual ratios** (face revenue minus sum of children, as a fraction).
4. Ambiguous alignments (similar labels the rules cannot confidently merge) are listed as open questions for the reduce agent.

## 5. Reduce stage: `decomposition_reduce`

Single agent. Injected base context: structural summaries of every candidate cross-year scheme — label, axis, child labels, coverage matrix, residual ratios — plus the host's open alignment questions. No values.

### 5.1 Private tools

**`inspect_scheme({ schemeId })`** — per-year, per-child detail of one candidate scheme (ids and coverage markers, no values).

**`merge_children({ schemeId, childIds })`** — declares that two host-separated children are the same line across filings, overriding automatic alignment. Invalid ids are rejected.

### 5.2 Proposal

The final scheme list, ranked by reasonableness. Ranking evidence goes into the rationale: year coverage, residual ratio, child granularity, caption stability across filings. The top-ranked scheme is marked as the forecast driver. Schemes that only exist in isolated years and cannot be aligned are dropped here.

The parent DCF Agent may reorder the ranking, drop schemes, or reject decomposition entirely (falling back to whole-line revenue forecasting). Only the parent calls public mutation tools.

## 6. Host materialization: residual rows and forecast rewiring

- Each accepted scheme materializes as a group of child rows under the target face revenue row. Row identity: `source.income_statement.revenue.<schemeId>.<hash(scheme|childLabel|axis|member)>`. Values come from adjudicated facts only.
- Per year, if |residual| / face revenue > 0.5%, an "Other / unallocated" residual child is generated so the identity `face revenue = Σ children` holds exactly. Agents never handle residuals.
- **Driver scheme:** the face revenue row becomes a computed row (`= Σ children`); each child carries its own growth assumption over forecast periods.
- **Non-driver schemes:** actual-period values only; forecast cells stay empty. They are retained as analysis views.
- `historical_mapping` receives a summary of the final decomposition structure in its base context, and its `statementMappingPlans` may reference child rows.

## 7. Failure behavior

| Condition | Result |
| --- | --- |
| A filing's map agent fails or times out | Diagnostic recorded; other filings proceed; reduce runs with lower coverage. |
| No filing yields a scheme | Reduce is skipped; revenue forecast stays whole-line; ingestion does not fail. |
| Invalid `factId` or non-revenue concept in a scheme | Scheme rejected; diagnostic recorded. |
| Residual ratio > 30% for a scheme | Scheme retained but host-flagged; injected as strong negative ranking evidence. |
| No scheme survives reduce or parent review | Same graceful fallback as "no filing yields a scheme". |
| Invalid tool envelope or unknown ids | Explicit protocol / scoped tool error, consistent with existing subagents. |

## 8. Persistence and audit

SQLite additionally retains: per-filing map proposals, host validation diagnostics, candidate cross-year schemes with coverage and residuals, `merge_children` overrides, the reduce proposal, and the parent's final decision. All are tied to the `ingestionRunId` of the table catalog they reference.

## 9. Verification

- Map and reduce loops: deterministic mock-provider tests following the `subagents.test.ts` pattern (tool protocol, empty-scheme result, invalid-reference rejection, `merge_children` override).
- Host layer: pure unit tests for validation, filedAt adjudication, label alignment, coverage matrix, residual generation, and driver rewiring.
- Smoke: extend the AAPL five-year run with a decomposition path. Expected outcome: two schemes (by product line, by geography); the product-line scheme ranks first on full coverage and low residual, and becomes the revenue driver.
