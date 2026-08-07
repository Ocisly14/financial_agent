# TSLA Revenue-Decomposition Smoke Report

Date: 2026-08-06
Symbol: TSLA · history: 5 years · run id: `ing_82cc6731-5ade-4782-bc81-b6b0444827ff`
Script: `scripts/xbrl/smoke-revenue-decomposition.ts`
Output: `data/smoke/xbrl/tsla-5y-revenue-decomposition-2026-08-06/`
Wall clock: 04:08:54 → 04:18:28 UTC (~9.5 min)

## 1. Verdict

The map-reduce revenue-decomposition pipeline runs end to end against live SEC data and produces a
usable driver scheme. Two of eight per-filing map agents still fail on provider-side rate limiting,
and that loss is visible in the result: the driver scheme covers FY2021–FY2024 with a 0 % residual
but has no FY2025 data, so it carries a `residual_ratio_above_30pct` flag for that year.

## 2. What ran

| Stage | Result |
|---|---|
| Arelle XBRL extraction | 8 filings (5× 10-K, 3× 10-K/A), FY2021–FY2025 |
| Filing-insight extraction | 60 small-model calls; 9 returned an empty insight array |
| `filing_decomposition` (map) | 8 dispatched, **6 succeeded, 2 failed** |
| Host validation / alignment | 2 candidate schemes built, 0 open alignment questions |
| `decomposition_reduce` | 13 DCF-subagent calls total; ranked 2, picked 1 driver, 0 `merge_children` |
| Materialization | not exercised — the smoke script stops after reduce |

Filings in the run:

```
0001628280-26-003952  10-K    filed 2026-01-29  FY2025   ← map agent FAILED
0001104659-26-053166  10-K/A  filed 2026-04-30  FY2025
0001628280-25-003063  10-K    filed 2025-01-30  FY2024
0001104659-25-042659  10-K/A  filed 2025-04-30  FY2024
0001628280-24-002390  10-K    filed 2024-01-29  FY2023   ← map agent FAILED
0000950170-23-001409  10-K    filed 2023-01-31  FY2022
0000950170-22-000796  10-K    filed 2022-02-07  FY2021
0001564590-22-016871  10-K/A  filed 2022-05-02  FY2021
```

## 3. Candidate schemes

### Driver — `cs-0c70a8d9886a` "Revenue by Segment"

- Axis: `us-gaap:StatementBusinessSegmentsAxis`
- Children: **Automotive**, **Energy generation and storage**
- Coverage: both children FY2021, FY2022, FY2023, FY2024
- Residual ratio: FY2021–FY2024 = **0 %**; FY2025 = **100 %**
- Flags: `residual_ratio_above_30pct` (driven entirely by the missing FY2025)

### Runner-up — `cs-671c869c45d8` "Revenue by Geography"

- Axis: `srt:StatementGeographicalAxis`
- Children: **United States**, **China**, **Other international**
- Coverage: all three children FY2021–FY2024
- Residual ratio: FY2021–FY2024 = **0 %**; FY2025 = **100 %**
- Flags: `residual_ratio_above_30pct` (same cause)

Reduce agent's stated reason for the pick: the segment breakdown gives a clean split of total
revenue with full coverage and zero residual; geography is a valid alternative; the remaining
schemes covered only FY2021 or did not target consolidated total revenue, so they were dropped.

## 4. Diagnostics

```
filing_decomposition_failed 0001628280-26-003952: Invalid JSON response
filing_decomposition_failed 0001628280-24-002390: Invalid JSON response
```

`Invalid JSON response` originates in the Vertex/ai-sdk client, not in our parsing — the API
returned a non-JSON body, the signature of rate limiting. The FY2025 residual gap traces directly
to the first failure: `0001628280-26-003952` is the filing that carries FY2025 segment facts.

## 5. Progression across runs

| Run | Map agents OK | Candidates | Driver | Blocking issue |
|---|---|---|---|---|
| 1 (initial) | 0 / 5 | 0 | — | Output contract never specified scheme fields; every proposal rejected for missing `schemeId`, and validation failure aborted the filing |
| 2 (contract + one-round retry) | 5 / 5 | 0 | — | `axisHint` sent as a semantic word (`product`, `geography`); host requires the literal `axisQName` present in the facts' dimensions |
| 3 (axis semantics fixed) | 2 / 5 | 3 | Product & Service | Full fan-out plus zero-delay retry hit provider rate limits; 3 filings lost |
| 4 (concurrency 3 + 2–4 s backoff) | 6 / 8 | 2 | Revenue by Segment | 2 filings still lost to rate limiting |

Fixes landed along the way (all still uncommitted, in the working tree):

- Output contract now spells out every required scheme field and the exact `axisHint` semantics
  (`filingDecompositionLoop.ts`), mirrored in the `filing_decomposition` registry prompt.
- Both agent loops do one in-band correction round: a schema/validation failure is fed back
  verbatim and the agent re-emits, instead of the filing aborting
  (`filingDecompositionLoop.ts`, `decompositionReduceLoop.ts`).
- Map fan-out limited to 3 concurrent filings, retries spaced by 2–4 s of jitter
  (`revenueDecomposition.ts`).
- Materialized decomposition row ids sanitize `cs-` to `cs_`, because statement-mapping formula
  identifiers reject `-` (it parses as minus) — a real bug that would have broken
  `applyAutoPremap` on live data (`materializeDecomposition.ts`).

## 6. Filing-insight chunking (changed before this run)

The chunker now packs adjacent sections up to the byte budget instead of emitting one chunk per
heading, and the heading regex recognizes `ITEM 1. BUSINESS` / `NOTE 2. REVENUE RECOGNITION` forms.

| Metric | Before | This run |
|---|---|---|
| Chunks per 10-K (TSLA FY2025) | ~40+ | 11 |
| Insight calls, 5 filings | ~200 | 60 |
| Input tokens per call | 1–3 k | median 14.4 k, max 43.7 k |

Note: 80 000 chars is ~35 k tokens on filing text, not the ~20 k a 4-chars-per-token estimate
suggests — financial tables are number-dense. Well inside Haiku's 200 k window; left as is by
request.

## 7. Known gaps (no action taken)

1. Two filings per run are still lost to rate limiting; concurrency 3 reduced but did not
   eliminate it. The FY2025 residual flag is a symptom, not an independent defect.
2. The smoke script stops after reduce, so `apply_revenue_decomposition` materialization and the
   auto-premap injection path are not exercised against live data — only by unit and integration
   tests (67 passing).
3. `merge_children` was never called: the two surviving schemes needed no cross-filing child
   alignment, so that path remains untested on live data.
