---
name: dcf-modeling
description: How to build a DCF from SEC filings — the six stages from extraction to intrinsic value, the disciplines that bind every stage, and the per-stage playbooks. Invoke this before the first tool call of a valuation, and again whenever you resume one.
layer: agent
---

# Building a DCF

You are building a DCF. Its essence is not filling a template. It is answering one question with evidence: **where does this company's profit come from, and of those sources, what will change and what will stay the same?** The valuation is nothing but that set of judgments translated into cash flows. The tools exist so every judgment is grounded in a number the engine computed, never one you recalled.

## Valuation principle — company first, not template first

Build the valuation from first principles in this order:

1. **Historical company evidence is the anchor.** Start with the issuer's reported revenue streams, margins, cash conversion, reinvestment, balance sheet and capital allocation. History constrains what is plausible; it is not a mechanical extrapolation.
2. **The future is an issuer-specific causal case.** Examine the likely direction of the company's industry over the forecast horizon — demand, product cycles, technology, capacity, competition, regulation and macro conditions — then identify how each reaches this company's named revenue, cost, reinvestment or financing lines. Company strategy, disclosed plans and execution capacity determine whether it benefits from or is hurt by those industry changes.
3. **General valuation inputs are reference points, not answers.** GDP, generic industry growth, peer multiples, long-run ERP, historical averages and current trading prices can test a conclusion or bound a scenario. They may not replace the company's own business logic or be used to force a target valuation.

Every forecast, WACC and terminal assumption must therefore say: which company-specific historical fact it anchors on; what future industry or company development changes or preserves it; and why the generic reference does not override that causal case.

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
- Data hierarchy: stores and workbook first, engine computation second, the web last. financial_search is for what can neither be read nor computed — dated sell-side or industry research, market commentary and consensus context, ERP studies, bond yields, industry data, management guidance and macro evidence. It may corroborate a company-specific forecast mechanism, but it never replaces the issuer's own history or strategy; what it finds enters the model only as a sourced assumption or override, never as a fact.
- Every assumption carries sourceType, sourceRefs, and a rationale stating what changes or persists and why.
- Decide and disclose is the default; ask only when disclosure cannot carry it. A disclosed judgment is auditable — that is what sourceRefs and the rationale are for. But when two readings are irreconcilable, produce materially different values, and nothing you can read or compute settles which is right, call `ask_user` with the readings as the options instead of picking one and labelling it. It pauses you, it does not end the task: you come back to this same work with the answer. Stage 4 (which decomposition is the real driver) and stage 6 (terminal method and rate) are where this actually bites.
- After every mutation, read the recalculated workbook the response carries; a null in a forecast fcff names the input that broke.
- Preserve model_id in every summary so any later task can resume.
