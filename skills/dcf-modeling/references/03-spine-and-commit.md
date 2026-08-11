# Stage 3 — Spine mapping and the history commit

The subagent maps and its facts commit directly — the pipeline verified roll-ups per filing upstream, and the engine re-validates via reconciliation on the commit itself. Your job is not to pre-approve numbers but to judge the mapping report and correct what you distrust on a later revision.

## run_dcf_subagent { subagent: "spine_mapping", modelId, task }

Maps the unified rows onto the canonical spine and COMMITS the resulting facts (the WACC sheet auto-refreshes in its own follow-up revision — see 05). What its decision contains:

- **mappings** — one or more unified rows summed into each spine target. REQUIRED targets (revenue.total, operating_income, pretax_income, income_tax_expense, D&A, capex, and the working-capital identity's components) must each be mapped or declared a **spine gap** with an issuer-specific reason. Judge those reasons like an auditor: "Tesla's customer deposits were absorbed into accrued liabilities after FY2022, no standalone line remains" is credible; a generic shrug is not — re-run.
- **detailRows** — supplementary lines worth their own row. Under revenue they become **streams** (summable, forecastable); breakdown members chosen together mirror their declared member tree into a stream tree (`revenue.automotiverevenues.automotivesales`), so picking an aggregate AND its pieces is legitimate two-level modeling, not double-counting — the host nests them. One axis only under revenue; other axes' members stay in the library as evidence.
- **excluded** — every unmapped unified row with a reason (subtotals, equity components, CF mechanics). Skim for anything you disagree with; it is preserved upstream either way.

The report's counts to check: committed fact count vs coverage gaps (a required target with no value in some year and no declared gap is a finding — expect zero on a clean run).

## What the commit triggers

The spine commit is the watershed: cells fill, the historical anchors and preset metrics compute, the working-capital identity installs over exactly the mapped components, reconciliation identities run, and the WACC sheet auto-refreshes in its own follow-up revision (see 05). The lifecycle reading advances by itself when the history is complete.

## What to inspect before moving to stage 4

get_financial_model after the commit: the history section carries the mapped statement lines with values; sections.metrics shows which preset metrics computed (a null one names its missing input — usually an unmapped line, which is information about the issuer, not necessarily a defect); revenue's stream tree matches the decision. If a required line came through null in a year the filing plainly covers, the mapping is wrong — re-run spine_mapping with the specifics rather than patching numbers by hand. You never author historical values.
