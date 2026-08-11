# Stage 1 — Extraction and model creation

Two plain tools, no LLM subagents, no judgment beyond reading the diagnostics honestly.

## extract_filing_statements

`{ symbol, historyYears?, forecastYears?, reportingCurrency? }` — historyYears defaults 5 (range 3–10), forecastYears defaults 5. Arelle resolves the issuer's 10-K / 10-K/A filings from EDGAR, parses every table, the face statements, and the presentation/calculation linkbases, and persists the lot as an immutable ingestion run. You get back statistics and an `ingestionRunId` — never the data itself; the mapping subagents read it from the store later.

Read the response like this:

- **Period coverage** per statement (`income_statement 5/5, …`): a short year means a filing failed to parse or the issuer genuinely lacks the history — check diagnostics before proceeding.
- **Diagnostics** worth distinguishing: `amendment_without_statements:<accession>` is normal (a 10-K/A that only amends exhibits carries no statements and is skipped — Tesla has these); `invalidTransformation` / `unmatched_context` in small counts are filing noise; a filing listed with `NO STATEMENTS` that is NOT an amendment is a real gap.
- Fiscal-year ends are handled per issuer (a June-30 filer's FY2026 is the year ending that June); the period grid follows the issuer, not the calendar.

## create_financial_model

`{ symbol, ingestionRunId }` — creates the revisioned model: revision 0 is the value-free skeleton (period grid, canonical DCF rows, preset metrics, an empty WACC sheet anchored to today), revision 1 stages the filing-level source rows. The workbook has **no spine facts yet** — that is stages 2–3's job.

- **One run, many models.** The ingestion run is reusable: calling create_financial_model on it again mints a fresh, independent model version of the same issuer (scenario variants, a clean re-do). Never re-extract just to get a second model.
- **Version hygiene**: the mapping subagents resolve the model you name in run_dcf_subagent's `modelId`, so parallel versions are safe — but archive_financial_model the ones you abandon, and list_financial_models when resuming to find what exists.
- The response's `statement_coverage` and `current_workbook` are your baseline; note the revision number — every later mutation demands the exact expectedRevision.

## When to stop and re-extract

Only when coverage is wrong at the source: a missing statement in a non-amendment filing, fewer history years than the analysis needs, or the wrong reporting currency. Everything downstream (re-tags, restatements, segment structure) is unification's job, not a reason to re-extract.
