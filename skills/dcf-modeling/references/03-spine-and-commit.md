# Stage 3 — Spine mapping and the history commit

The subagent maps and its facts commit directly — the pipeline verified roll-ups per filing upstream, and the engine re-validates via reconciliation on the commit itself. Your job is not to pre-approve numbers but to judge the mapping report and correct what you distrust on a later revision.

## delegate_to_agent { agent: "spine_mapping", task }

The task string must name the ticker — the subagent loads the unified statements and the spine target list from the store itself. Say what this model is for and what you want the mapping to respect: the user's stated preferences, how this issuer reports (a segment split worth preserving, a restatement you already distrust), what the analysis downstream turns on. Do not hand it a chart of accounts. Which unified row answers to which spine id is the judgment you delegated, and a task that pre-decides it narrows the mapping to your list instead of the issuer's statements.

Maps the unified rows onto the canonical spine, and an accepted mapping COMMITS its facts in the same moment (the WACC sheet auto-refreshes in its own follow-up revision — see 05). The delegate's finish summary carries the committed revision — read it, and refresh with get_financial_model before your next mutation. What its decision contains:

- **mappings** — one or more unified rows summed into each spine target. The subagent loads the canonical target list with the statements, required ids marked, and owes an answer on every required one: mapped, or declared a **spine gap** with an issuer-specific reason. You do not need to know that list, and naming accounts in the task will not improve it — the host checks coverage against the engine's own required set and returns a finding for anything missed. Judge the reasons like an auditor: "Tesla's customer deposits were absorbed into accrued liabilities after FY2022, no standalone line remains" is credible; a generic shrug is not — re-run.
- **detailRows** — supplementary lines worth their own row. Under revenue they become **streams** (summable, forecastable); breakdown members chosen together mirror their declared member tree into a stream tree (`revenue.automotiverevenues.automotivesales`), so picking an aggregate AND its pieces is legitimate two-level modeling, not double-counting — the host nests them. One axis only under revenue; other axes' members stay in the library as evidence.
- **excluded** — every unmapped unified row with a reason (subtotals, equity components, CF mechanics). Skim for anything you disagree with; it is preserved upstream either way.

What to check in its summary: the committed revision and fact count vs coverage gaps (a required target with no value in some year and no declared gap is a finding — expect zero on a clean run). No committed revision in the summary means nothing was committed; re-dispatch on the same thread.

## What the commit triggers

The spine commit is the watershed: mapped cells fill and become actual-sourced, reconciliation identities run, and the WACC sheet auto-refreshes in its own follow-up revision (see 05). It does not invent historical anchors, metrics, or a forecast chain: write every derived formula for the economics you actually model.

## What to inspect before moving to stage 4

get_financial_model after the commit: the history section carries the mapped statement lines with values; revenue's stream tree matches the decision. If a required line came through null in a year the filing plainly covers, the mapping is wrong — re-run spine_mapping with a task that names the problem, rather than patching numbers by hand. You never author historical values, but you do author formulas that combine them.
