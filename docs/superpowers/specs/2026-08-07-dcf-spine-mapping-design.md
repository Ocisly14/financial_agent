# DCF Spine Mapping from Per-Filing Presented Statements

Date: 2026-08-07
Status: Approved design, not yet implemented
Depends on: `2026-08-07-presentation-linkbase-statement-extraction-design.md` (consumes its
`PresentedStatement` output; types already in the working tree as `PresentationStatementPayload`)

## 1. Purpose and positioning

Turn five filings' per-filing presented statements into the multi-year input the DCF engine
consumes. This deliberately does **not** merge the filings' statements into one unified multi-year
statement. There is no cross-filing structural merge, no unified presentation tree, and no
replacement for `PreparedFilingStatements`.

Instead, the pipeline goes straight from concept-keyed per-filing statements to the DCF spine:

```
① Build concept inventory        (code, deterministic)
② Decide spine mapping           (single agent call)
③ Backfill values                (code, deterministic)
④ Verify                         (code, deterministic; findings re-drive ②, bounded)
```

The agent decides *which concepts the model uses*; it never touches a number. Every value is
resolved by code from the PresentedStatements with full provenance.

The canonical spine (`CANONICAL_MAPPING_IDS` in `src/financial-model/skeleton.ts`, ~40 ids) is the
fixed interface of the valuation engine: FCFF, the equity bridge, and per-share value are computed
over these ids. The mapping's job is to translate any issuer's statements into that vocabulary. The
agent may additionally propose detail rows beyond the spine, attached under a canonical parent
(reusing the `addDcfDetailLineItem` mechanism); the engine's formulas ignore them, but forecasting
and display can use them.

## 2. Stage ①: concept inventory (`src/infra/xbrl/conceptInventory.ts`)

Pure function over all filings' `PresentationStatementPayload`s. One section per statement; one row
per `(conceptQName, dimensionSignature)`:

- **labels** — each filing's display label; when filings disagree, list all (a label change is
  signal, not noise).
- **tree position** — parent concept and depth in the *latest* filing's tree; rows absent from the
  latest filing are marked `only in older filings`.
- **period coverage** — per requested year, whether any filing carries a fact (union across
  filings). An issuer re-tag shows up directly: the old concept covers early years, the new one
  covers later years. No alignment heuristic is needed; the agent reads it off the table.
- **magnitude sample** — the most recent value (for sign/scale judgment only; never used for
  backfill).
- **dimensions** — axis=member for dimensional rows.

Face statements only (~200 rows across five filings after dedupe). Note-level data stays with the
existing `filing_decomposition` / `revenue_decomposition` pipelines.

## 3. Stage ②: mapping decision (`src/agent/financial-modeling/spineMappingLoop.ts`)

Single agent call (pattern: `decompositionReduceLoop`). Input: the inventory plus the canonical
spine id list. Output (zod-validated):

```jsonc
{
  mappings: [{
    targetId: "cost_of_revenue",           // canonical spine id
    perYear: [{ periodId, conceptQName }], // per-year concepts; re-tags aligned explicitly
    rationale: string
  }],
  detailRows: [{
    parentTargetId: string,                // canonical parent to attach under
    label: string,
    perYear: [{ periodId, conceptQName, dimensionSignature? }],
    rationale: string
  }],
  excluded: [{ conceptQName, reason }],    // explicit drops
  spineGaps: [{ targetId, reason }]        // spine ids genuinely absent (e.g. no preferred stock)
}
```

Completeness is checked by code before anything else runs, in both directions:

- `mappings + detailRows + excluded` must cover every inventory row exactly — no dangling concepts.
- `mappings + spineGaps` must cover every canonical id exactly — no third state.
- One `(targetId, periodId)` maps to exactly one concept. A concept may serve both a mapping and a
  detail row.

Violations are findings that re-drive the agent, before any value work.

## 4. Stage ③: backfill (`src/infra/xbrl/spineBackfill.ts`)

For each `(targetId, periodId, conceptQName, dimensionSignature?)`:

- Look up the fact in every filing's PresentedStatements; candidates ordered newest filing first;
  **latest filing wins** (restated basis, comparable with the newest annual report).
- Materialize as a `Fact` with existing `Provenance` (accession, contextId, sourceAnchor,
  decimals). No new downstream concepts.
- **Restatement report**: when overlapping filings disagree beyond the `decimals` tolerance, record
  all candidate values with their filings. Selection still prefers latest; the report ships with
  the artifact rather than blocking.
- A mapping that points at a `(concept, period)` with no fact anywhere is a mapping error: a
  finding for the re-run loop, never a silent blank.

## 5. Stage ④: verification (`src/infra/xbrl/verifySpineModel.ts`)

1. **Roll-up** — per year, feed the mapped spine values into the issuer's own calculation-linkbase
   relations (gross profit, balance-sheet balance, …). Mismatch is a finding.
2. **Cross-year continuity** — adjacent-year overlap comparison (last year's column in this year's
   filing vs. last year's settled value), using the same `decimals` tolerance as the restatement
   report. Breaks go into the report — they are the symptom of a wrong re-tag alignment — but do
   not block.
3. **Coverage** — every canonical id × year is either valued or declared in `spineGaps`. No third
   state.

**Re-run loop**: findings from ③/④ (and the completeness check) are appended to the agent input and
stage ② re-runs, at most twice. Still failing → the artifact ships with its unresolved findings
explicitly attached; the user decides. Never an infinite loop, never a silent pass.

**Error handling**: a filing missing a statement (e.g. a Part III-only 10-K/A) simply contributes
nothing for it; all filings missing a statement blocks, in the style of
`IncompleteFinancialStatementsError`.

## 6. Components and testing

| Component | Role |
|---|---|
| `src/infra/xbrl/conceptInventory.ts` | stage ①, pure |
| `src/agent/financial-modeling/spineMappingLoop.ts` | stage ② loop, completeness pre-check, ≤2 re-runs |
| `src/agent/prompts/subagentPrompts.ts` (extended) | mapping prompt; zod output schema |
| `src/infra/xbrl/spineBackfill.ts` | stage ③, pure |
| `src/infra/xbrl/verifySpineModel.ts` | stage ④, pure |
| `scripts/xbrl/smoke-spine-mapping.ts` | TSLA end-to-end smoke; markdown report incl. restatement report and verification |

Tests are fixture-driven off the TSLA protocol-3 fixture (no network, no Arelle):

- inventory: cross-filing dedupe, label divergence listed, re-tag visible in coverage, dimensional
  rows kept separate;
- completeness: a missed concept, a missed spine id, and a double-mapped `(targetId, period)` are
  each rejected;
- backfill: latest-filing precedence; within-tolerance overlap silent; beyond-tolerance overlap in
  the restatement report; mapping to a nonexistent fact becomes a finding;
- verification: roll-up pass and fail; continuity break reported; coverage third state impossible;
- re-run loop: stubbed agent verifies finding injection and the 2-run cap (existing loop-test
  pattern).

## 7. Out of scope

- Replacing `mergeCuratedTables` / `autoPremap` / `mappingReviewLoop`. They keep serving the
  existing path until this pipeline proves out on TSLA and a second issuer.
- Note-level decomposition (revenue segments etc.) — unchanged, owned by the existing pipelines.
- Forecasting semantics of detail rows — they are materialized and displayed, nothing more here.
