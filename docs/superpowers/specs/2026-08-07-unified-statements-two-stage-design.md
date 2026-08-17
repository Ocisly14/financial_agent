# Two-Stage Spine Mapping: Unified Multi-Year Statements, then DCF Selection

Date: 2026-08-07
Status: Draft for review
Supersedes: the single-stage decision in `2026-08-07-dcf-spine-mapping-design.md` §1 ("does not
merge the filings' statements into one unified multi-year statement"). Stages ①/③/④ of that spec
survive as building blocks; stage ② is split into two agent decisions.
Depends on: `2026-08-07-presentation-linkbase-statement-extraction-design.md` (consumes
`FilingExtraction.statements`).

## 1. Why the single-stage design is being revised

The implemented single-stage `spine_mapping` agent fuses two judgments into one decision:

- **cross-year row alignment** — which rows across five filings are the same business line
  (re-tags, label changes, split/merged presentations);
- **DCF placement** — which of those lines the DCF engine models, under which canonical spine id.

Fusing them has two costs. First, the issuer's own statement structure is discarded: no unified
multi-year income statement / balance sheet / cash flow statement ever exists, only spine-shaped
output. That intermediate table is independently valuable — display, audit, restatement
reconciliation all naturally live there. Second, the one-concept-per-`(targetId, periodId)` rule
cannot express merges: when an issuer splits a line in some years (selling vs. G&A with no combined
concept) the fused decision has no way to state "these concepts sum to one row."

The revision separates the two judgments into two agents under the DCF Agent, with deterministic
code between and after them. Neither agent ever touches a number.

```
① Build concept inventory              (code, deterministic — extended with per-year sign samples)
Ⓐ statement_unification agent          (cross-year alignment; merges allowed)
② Backfill unified statements          (code: per-component resolution + summation, latest wins)
③ Verify unified statements            (code: roll-up, continuity, lossless-coverage; re-drives Ⓐ, ≤2)
Ⓑ spine_mapping agent                  (DCF selection over unified rows)
④ Backfill spine                       (code: sum unified row values into spine facts)
⑤ Verify spine                         (code: coverage; re-drives Ⓑ, ≤2)
```

## 2. Stage Ⓐ: `statement_unification` (new DCF subagent)

Input: the concept inventory plus the requested periods. `conceptInventory.ts` is extended: each row
carries its **resolved value per covered period** (`values`, after the deterministic sign
normalization of §3), so the agent sees the whole series rather than inferring it from one sample.

This supersedes the earlier `sampleValue` + per-year signs pairing, which cost more bytes than the
values do (85 rows of MSFT: 18.5k chars of signs and samples vs 10k of values) while hiding scale —
a line that is zero in its newest tagged year and billions in an earlier one read as dead legacy,
and MSFT's FY2024 commercial paper was demoted to supplemental on exactly that reading. Output
(schema-validated):

```jsonc
{
  rows: [{
    rowId: "automotive_cost_of_revenues",   // agent-chosen stable slug, unique
    statement: "income_statement",
    label: "Automotive cost of revenues",   // display label, normally the latest filing's
    perYear: [{
      periodId: "FY2023",
      components: [{ conceptQName, dimensionSignature?, weight }]  // weight ±1; ≥1 component
    }],
    rationale: string                        // required when perYear uses >1 component or
  }]                                         // different concepts across years (re-tag/merge)
}
```

Semantics:

- **Lossless**: every inventory row must appear in exactly one unified row's components for every
  period it covers. Nothing is dropped here — dropping is a DCF judgment and belongs to stage Ⓑ.
  Completeness is checked by code in both directions before any value work.
- **Merging**: a unified row's `components` may sum several concepts (weights ±1) when the issuer
  presents a line split without an aggregate concept. The agent only declares the composition; the
  summation is deterministic code in stage ②.
- **Re-tags**: different years may use different components for the same row; the inventory's
  period-coverage column shows the seam directly.
- One `(conceptQName, dimensionSignature, periodId)` may feed at most one unified row — no
  double-counting within a statement.
- **Per-year sign alignment (last resort)**: component `weight` is per-year, so when the
  deterministic normalization of §3 cannot orient a year (concept absent from that filing's
  calculation tree) and the per-year sign samples show a flip, the agent may set `weight: -1` for
  the flipped years, with the reason stated in `rationale`. Mechanically recoverable signs are
  handled in code first; the agent is the fallback, and roll-up verification is the check on both.

## 3. Stage ②/③: unified backfill and verification (code)

Backfill (generalizes `spineBackfill.ts`): for each unified row × period, resolve every component
fact with latest-filing-wins and the existing `decimals` tolerance, then sum by weight. The
materialized `Fact` carries `lineItemId = unified.<statement>.<rowId>` and provenance listing every
component's accession/sourceAnchor. The restatement report (overlapping filings disagreeing beyond
tolerance) is produced here, per component.

**Deterministic sign normalization.** Extraction is faithful to each filing, and filers flip a
concept's sign convention across years (observed: `IncreaseDecreaseInAccountsReceivable` −130 in
FY2021 vs +261 in FY2025) — consumed raw, the multi-year series mixes orientations. The orientation
information is mechanical and already extracted, so code fixes it, not an agent:

- Every resolved fact is oriented by **its own source filing's** declarations before any use:
  effective value = raw value × the calculation-linkbase `weight` of the concept under its parent
  in that filing (sign only), consulting `negatedConcepts` for display-negated presentation rows.
  This yields one consistent orientation per concept across years regardless of how each filing
  tagged it.
- When a concept appears under multiple parents with conflicting weights in one filing, or appears
  in no calculation tree, the value passes through unnormalized and the case is surfaced: the
  inventory's per-year sign samples show it to stage Ⓐ (which can set per-year `weight: -1`), and
  roll-up verification catches whatever remains.
- Normalization applies identically in restatement/continuity comparisons — two filings reporting
  the same economics under opposite conventions must compare equal, not as a false restatement.
- Provenance records the applied orientation (`signFlipped: true` plus the source relation), so
  every normalized number remains auditable back to the raw filed value.

Verification:

1. **Roll-up** — the issuer's calculation-linkbase relations, evaluated over component concept
   values per year. Belongs here (it is a property of the issuer's statements, not of the DCF).
   Roll-up is also the check on sign normalization: a wrongly-oriented component breaks its
   parent's sum for exactly the affected years, so sign mistakes cannot pass silently.
2. **Cross-year continuity** — restatement differences re-stated per unified row; report-only.
3. **Lossless coverage** — every inventory `(concept, signature, period)` consumed exactly once.
4. **missing_fact** — a component pointing at a `(concept, period)` no filing carries.

Blocking findings (roll-up, coverage, missing_fact) re-drive stage Ⓐ, at most twice; then the
artifact ships with unresolved findings attached. The output artifact — the **unified statements**:
three tables, issuer's own rows × requested years, every cell with provenance — is persisted and is
this pipeline's first-class deliverable, independent of the DCF.

## 4. Stage Ⓑ: `spine_mapping` (revised DCF subagent)

Input: the unified statements (rowId, statement, label, tree position, per-year values — values are
visible for materiality judgment only). Output:

```jsonc
{
  mappings: [{ targetId, rowIds: [..], rationale }],  // ≥1 unified rows sum into one spine id
  detailRows: [{ parentTargetId, rowId, rationale }], // issuer-specific lines worth modeling
  excluded: [{ rowId, reason }],                      // explicit drops, with reasons
  spineGaps: [{ targetId, reason }]                   // spine ids genuinely absent
}
```

- Every unified row lands in exactly one of `mappings`/`excluded`; it may additionally appear as a
  `detailRow`. Every canonical id is mapped or declared a gap. No third state — checked by code.
- Materiality is judged against **this issuer's** business (labels, magnitudes, tree position), and
  the issuer-specific reasoning must be stated in the rationale.
- Cross-year alignment is settled by stage Ⓐ and is not revisited here: the decision is per-row,
  not per-year.

## 5. Stage ④/⑤: spine backfill and verification (code)

Backfill is a pure re-labelling/summation of unified row values: `lineItemId = targetId` (or
`detail.<parent>.<slug>`), `status: "staged"`, provenance chaining to the unified facts. No filing
lookup happens here — stage ② already settled every number.

Verification: coverage (every canonical id × year valued or declared a gap). Findings re-drive Ⓑ,
at most twice; then ship with unresolved findings. Continuity/roll-up are not re-checked — they are
stage ③'s responsibility and unchanged by re-labelling.

## 6. Persistence and wiring into the DCF Agent

The pipeline's inputs and outputs are persisted so both agents are reachable through
`run_dcf_subagent`, following the `revenue_decomposition` precedent.

**Persisting the extraction input.** `FilingExtraction.tables` is large and already lives in the
`FilingTableStore`; the presentation data this pipeline needs is small. New trimmed type:

```ts
export type PresentationExtract =
  Pick<FilingExtraction, "filing" | "calculationRelations" | "negatedConcepts" | "statements">;
```

`runStatementExtraction` adds `presentationExtracts: PresentationExtract[]` to the
`FilingIngestionArtifact`, and the parent's accept step copies it (with `periods`) onto the
`SourceReviewArtifact`. Older artifacts without the field make both new subagents return a
`presentation_extract_unavailable` error — re-run `statement_extraction`; nothing is faked.

**Persisting the unified statements.** Stage ③'s output is stored on the `SourceReviewArtifact` as
`unifiedStatements?: UnifiedStatementsArtifact` (rows, facts, restatement report, verification,
unresolved findings) — mirroring how `decomposition`/`premap` already live there.

**Tool branches** in `run_dcf_subagent` (both take `{subagent, modelId, task}`):

- `statement_unification` — requires `presentationExtracts`; runs stages Ⓐ–③; saves
  `unifiedStatements` back onto the source review; returns the three unified tables (labels,
  per-year values, provenance summary) plus restatement report and unresolved findings.
- `spine_mapping` — requires `unifiedStatements`; runs stages Ⓑ–⑤; returns the decision and the
  staged spine facts as a proposal in `generation_context`. Committing those facts into the model
  revision stays with the parent DCF Agent through the existing fact review/commit operations —
  this tool never mutates a model, matching every other subagent's authority.

Ordering is enforced by data, not by convention: `spine_mapping` without a stored
`unifiedStatements` fails with `unified_statements_unavailable`.

## 7. Components

| Component | Role |
|---|---|
| `src/infra/xbrl/conceptInventory.ts` | stage ①, extended: per-year sign samples (post-normalization) |
| `src/agent/financial-modeling/statementUnificationAgent.ts` | stage Ⓐ loop (new) |
| `src/infra/xbrl/unifiedStatements.ts` | stage ②/③: backfill + verify + artifact type (new; absorbs most of `spineBackfill.ts`/`verifySpineModel.ts`) |
| `src/agent/financial-modeling/spineMappingAgent.ts` | stage Ⓑ loop (revised: row-level decision) |
| `src/infra/xbrl/spineFromUnified.ts` | stage ④/⑤ (new, small) |
| `subagents.ts` registry | `statement_unification` registered; `spine_mapping` prompt rewritten |
| `subagents.ts` (`runStatementExtraction`) | persists `presentationExtracts` on the ingestion artifact |
| `sourceReviewStore.ts` types | `presentationExtracts` + `unifiedStatements` on `SourceReviewArtifact` |
| `subagentTool.ts` | two new branches: `statement_unification`, `spine_mapping` |
| `scripts/xbrl/smoke-spine-mapping.ts` | revised: prints unified statements, then the spine report |

Both agents follow the existing loop pattern (schema validation with one in-band correction,
backoff retry, findings-driven re-runs capped at 3 total, ship-with-findings).

## 8. Out of scope

- Whether this path replaces `mergeCuratedTables`/`autoPremap`/`mappingReviewLoop` — undecided,
  both paths coexist until this one proves out.
- Note-level decomposition — unchanged, owned by `revenue_decomposition`.
- Forecasting semantics of detail rows — unchanged.
