# Stage 2 — Statement unification

`run_dcf_subagent { subagent: "statement_unification", modelId, task }`. The task string must name the ticker — the subagent loads its own working set from the store by that name; pasting data into the task is ignored by design.

## What it does (so you can judge its report)

- Builds a concept inventory of every face-statement concept across all filings, then partitions it into unified multi-year rows in the **issuer's own structure** — resolving re-tags (one line renamed across years is one row, not two), rollforwards, sign flips, and cross-filing restatements. Values resolve latest-filing-wins; roll-ups are checked against the calculation linkbase.
- **Explores the issuer's XBRL dimension axes** (segments, products, geography) with progressive-disclosure tools, and attaches breakdown rows to the lines they disaggregate. When an axis mixes hierarchy levels (an aggregate beside its own pieces), it declares the member tree, and the host validates it bottom-up: children must sum to their node, roots to the parent row, each within ±10% (reconciling items cost a few percent — that tolerance is deliberate).
- Everything lands in the store as the unified-statements artifact; you receive counts and a ≤120-word account, never rows.

## Reading the report

- `unified N row(s) over P period(s) [income_statement …]` — sanity-check the shape: three statements present, the full period span.
- **Restatements** are information, not errors: they say where the issuer rewrote its own history (Tesla-grade issuers show 20+). High counts mean stage-4 anchors on those lines deserve suspicion.
- **Material roll-up breaks** mean a statement's internal arithmetic did not reconcile — worth one re-run with a sharper task if they touch lines you will model.
- **Breakdown rows on K axis/axes** is the signal that profit-source decomposition is available downstream. None, for an issuer you know reports segments, is worth one follow-up run asking for the dimensional work explicitly.
- **`SHIPPED WITH n unresolved finding(s)`**: the loop retried and could not clear them; the artifact still shipped. Read the findings in the response data. A dangling dimensional balance-sheet cell is usually acceptable; a finding on a line central to your analysis (revenue, operating income) is not — re-run with a task that names the problem.

## Re-running

The subagent is idempotent per run — a re-run replaces the stored artifact. Re-run when: findings touch load-bearing lines, segment exploration came back empty for a known-segmented issuer, or the task itself was garbled (the host rejects a run whose loaded issuer mismatches the model — restate the ticker). Otherwise accept imperfection that does not touch your analysis and move on: unification serves the model, not its own score.
