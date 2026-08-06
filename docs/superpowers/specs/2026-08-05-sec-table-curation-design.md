# SEC Filing Tables and Historical DCF Mapping

Date: 2026-08-05
Status: Implemented

## 1. Decision

Arelle and deterministic host code own extraction, pre-screening, face-statement selection, normalization, and staging. There is no statement-curation Agent in the ingestion path.

The former statement-curation Agent is merged into `historical_mapping`. That Agent runs only after the host has selected and normalized the income statement, balance sheet, and cash-flow statement. It uses private, pull-based tools to select source rows and propose mappings into the DCF workbook.

The split is intentional:

- Arelle is reliable at extracting facts, contexts, presentation evidence, table grids, and calculation relations.
- Deterministic scoring is reliable at selecting standard face statements and is auditable.
- An Agent is useful where accounting judgment is required: choosing DCF rows, grouping issuer-specific captions, deciding sign treatment, and reviewing source conflicts.
- The Agent never supplies a source number. It references staged `factId` and `sourceLineItemId` values returned by tools.

## 2. Architecture

```text
SEC submissions
  -> preparedStatementProvider.resolve()
  -> arelle_companion.py (protocol v2)
       grids, contexts, presentation hints, calculation relations
  -> filingTableStore (all extracted tables)
  -> selectFaceStatements() (deterministic, zero LLM calls)
       one IS / BS / CF per report date
  -> mergeCuratedTables()
       normalized rows + staged facts + source anchors
  -> create_financial_model (revision 0 -> revision 1)
  -> historical_mapping tool loop
       inspect rows -> inspect exact facts -> review conflicts -> propose mapping
  -> parent DCF Agent reviews proposal
  -> review_financial_model_history (revision 2)
```

The standard AAPL five-year path selected all 15 face statements without an LLM: HTML tables 23, 25, and 27 in each annual filing.

## 3. Arelle Protocol v2

The companion emits fact-bearing HTML tables rather than presentation-derived pseudo-statements.

Each `FilingTable` contains:

```ts
{
  sourceTableId,
  accession,
  form,
  filedAt,
  reportDate,
  heading,
  htmlOrder,
  sourceAnchor,
  prescreen: {
    tier,
    presentationOverlap,
    dimensionlessRatio,
    periodSpan,
    factCount
  },
  suggestedStatements,
  columns: [{ index, headerText, periodId?, isLabelColumn }],
  rows: [{ order, labelText, indentLevel, cells }]
}
```

A cell may carry rendered text and an XBRL fact with context, period, unit, dimensions, concept, value, accession provenance, and source anchor.

All extracted tables are persisted. Selection does not delete or rewrite the catalog.

## 4. Deterministic Face-Statement Selection

`selectFaceStatements()` groups tables by `reportDate` and assigns distinct candidates to:

- `income_statement`
- `balance_sheet`
- `cash_flow_statement`

The score uses:

- Arelle presentation-derived `suggestedStatements` as primary evidence.
- Exact face-statement heading patterns.
- Strong/weak pre-screen tier.
- Presentation overlap.
- Dimensionless fact ratio.
- Requested-period span.
- Fact count.
- Penalties for parenthetical, supplemental, detail, and schedule headings.

The selector evaluates a joint assignment so one table cannot satisfy two statement types. Weak-tier tables remain eligible when presentation evidence and the heading identify a face statement; this is required for AAPL's 2025 income statement.

Structural success requires all three statements for every requested report date and complete requested-period coverage. Calculation breaks and column-period conflicts are retained as review diagnostics instead of blocking prepared-statement creation.

## 5. Normalization and Staging

`mergeCuratedTables()` applies filing precedence by `filedAt`: the newest filing supplies a period, while older filings fill periods that the newer filing does not contain.

Rows retain the filing's order, label, indentation, statement type, source table, and source anchor. Facts retain their own context period; a conflicting display-column period becomes a review issue.

One HTML row can contain multiple units, such as par value per share, shares outstanding, and a currency balance. Fact buckets therefore use both dimension signature and unit. The normalized source identity is:

```text
source.<statement>.<normalized-label>.<hash(statement|label|dimensions|unit)>
```

This prevents a currency fact from being staged under a per-share row while preserving stability across cosmetic label changes and issuer re-tagging.

## 6. Historical Mapping Agent

`historical_mapping` receives a stable base context containing:

- model id, revision, and lifecycle stage;
- actual and forecast periods;
- DCF target row definitions without cells;
- diagnostic counts;
- filing and source-coverage summary.
- every normalized row title and stable `sourceLineItemId` from the three statements;
- every normalized period column title and id;
- exact conflict coordinates with table, row, and column titles, but no values.

It does not receive full filing tables, source values, full normalized facts, `sourceStatementReview`, or a complete workbook snapshot. The row/column-title base context remains present for the whole loop.

### 6.1 Private tools

**`get_statement_rows({ sourceLineItemIds })`**

Returns up to 20 exact rows. Results are grouped by row; the shared unit and row metadata appear once. Each fact contains `periodId`, value, `factId`, source anchor, accession, as-of date, and concept without repeating filing-level provenance fields.

**`waive_column_conflicts({ waivers })`**

Records a rationale for an exact deterministic conflict coordinate. Invented or stale coordinates are rejected. Waivers are scoped to the ingestion run.

### 6.2 Proposal

The final proposal matches `review_financial_model_history` except that ownership fields are injected by the host:

```ts
{
  rationale,
  payload: {
    selectedHistoricalPeriodIds,
    decisions,
    categoryLineItems,
    statementMappingPlans,
    categoryGroups
  },
  sourceRefs
}
```

The parent DCF Agent may accept, modify, or reject the proposal. Only the parent calls the public mutation tool.

## 7. Tool Protocol

Historical mapping uses the same text tool protocol as every other project subagent:

```json
{"action":"call_tool","calls":[{"tool":"<name>","input":{}}]}
```

`tool`, `input`, and `calls` are literal field names. `toolName`, `tool_name`, `args`, native function calls, and alternate envelopes are not accepted. `formatAllowedTools()` labels schemas as `input fields`, and `parseSubagentStep()` is the single parser.

The loop keeps the complete assistant/tool transcript. Earlier exact-row reads and waiver results remain visible on every later step, while the title-only base context is injected once rather than repeated as a new progress object. A malformed empty response from the provider is retried once for the same step.

## 8. Persistence and Audit

SQLite retains:

- every extracted filing table;
- deterministic face-statement decisions;
- exact conflict waivers and rationales;
- immutable filing ingestion artifacts;
- normalized source review artifacts;
- financial-model revisions.

The source-review artifact includes `ingestionRunId` so the mapping Agent's waiver tools remain tied to the correct table catalog. Public workbook reads expose only `source_statement_summary`, never the full artifact.

## 9. Failure Behavior

| Condition | Result |
| --- | --- |
| Arelle unavailable, timeout, or protocol error | Failed ingestion. |
| No fact-bearing tables | Failed ingestion. |
| Missing face statement or requested period | Ready but incomplete ingestion; model creation refuses staging. |
| Calculation break | Review diagnostic for historical mapping. |
| Column/fact period conflict | Review diagnostic; historical mapping may waive the exact coordinate. |
| Invalid mapping tool envelope | Explicit protocol error; no alternate field-name compatibility. |
| Unknown row or conflict coordinate | Scoped tool error. |
| Stale model revision | Proposal rejected before mutation. |
| Unit mismatch inside a normalized source row | Rejected during staging. |

## 10. Verification

Deterministic tests cover grid extraction, pre-screening, face selection, period precedence, row identity, unit separation, conflict detection, persistence, grouped row reads, exact waivers, proposal schema validation, and strict `tool/input` protocol handling.

The AAPL five-year smoke output is under:

```text
data/smoke/xbrl/aapl-5y-deterministic-selection-2026-08-05-v2/
```

Observed extraction result:

- 5 annual filings.
- 182 extracted tables persisted.
- 15 deterministic face-statement selections.
- 17 normalized income-statement rows.
- 31 normalized balance-sheet rows.
- 27 normalized cash-flow rows.
- 293 staged facts covering FY2021–FY2025.
- revision 1 created in `statement_mapping` mode.
