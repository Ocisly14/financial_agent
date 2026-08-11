---
name: dcf-modeling
description: How to build a DCF from SEC filings — the six stages from extraction to intrinsic value, the disciplines that bind every stage, and the per-stage playbooks. Invoke this before the first tool call of a valuation, and again whenever you resume one.
layer: agent
---

# Building a DCF

You are building a DCF. Its essence is not filling a template. It is answering one question with evidence: **where does this company's profit come from, and of those sources, what will change and what will stay the same?** The valuation is nothing but that set of judgments translated into cash flows. The tools exist so every judgment is grounded in a number the engine computed, never one you recalled.

The work runs in six stages. This is only the map — **each stage has a detailed playbook you fetch with read_skill_reference (skill: `dcf-modeling`) when you are about to do it**, and a formula toolbox shared by all of them. Read a stage's playbook before its first tool call, not all of them upfront: they are written to be read at the moment of use.

| stage | you are about to… | read first |
| --- | --- | --- |
| 1. Extraction | pull the issuer's 10-Ks and create the model | `01-extraction.md` |
| 2. Unification | run statement_unification, judge its report | `02-unification.md` |
| 3. Spine & commit | run spine_mapping, judge its report, correct what you distrust | `03-spine-and-commit.md` |
| 4. Analysis & forecast | decompose profit sources, judge change vs persistence, author the chain | `04-analysis-and-forecast.md` |
| 5. WACC | complete the discount-rate sheet | `05-wacc.md` |
| 6. Valuation | terminal value, sensitivities, the verdict | `06-valuation.md` |
| — | write any formula | `formulas.md` (the toolbox; read once before stage 4) |

Resuming an existing model: read get_financial_model first, locate the stage from the lifecycle and what is filled, and fetch only that stage's playbook.

Disciplines that bind every stage:

- Never do arithmetic in prose — put it in a row and read the engine's number back.
- Data hierarchy: stores and workbook first, engine computation second, the web last. financial_search is for what can neither be read nor computed — published research (ERP studies, bond yields, industry data, guidance, macro) — and what it finds enters the model only as a sourced assumption or override, never as a fact.
- Every assumption carries sourceType, sourceRefs, and a rationale stating what changes or persists and why.
- Decide and disclose is the default; ask only when disclosure cannot carry it. A disclosed judgment is auditable — that is what sourceRefs and the rationale are for. But when two readings are irreconcilable, produce materially different values, and nothing you can read or compute settles which is right, call `ask_user` with the readings as the options instead of picking one and labelling it. It pauses you, it does not end the task: you come back to this same work with the answer. Stage 4 (which decomposition is the real driver) and stage 6 (terminal method and rate) are where this actually bites.
- After every mutation, read the recalculated workbook the response carries; a null in a forecast fcff names the input that broke.
- Preserve model_id in every summary so any later task can resume.
