# AAPL DCF full-chain E2E validation

Date: 2026-08-19
Status: **PASS (engineering workflow)**. The valuation assumptions and terminal sensitivity still
require human investment judgment — a passing run validates that the pipeline builds an auditable
model, not that its economics are right.

## What this run proves

Starting from an empty model, with no pre-seeded statement mappings, formulas, or assumptions, the
DCF agent took AAPL from SEC filings to a `valued` workbook in **one round**. It chose for itself
which cell should come from a filing mapping, a formula, or an assumption, and delegated the two
mapping stages to their own agents through the same `delegate_to_agent` contract every agent uses.

| | |
| --- | --- |
| Model / final revision / lifecycle | `fm_3a9547e3…` / 15 / `valued` |
| Historical / forecast periods | FY2021–FY2025 / FY2026–FY2030 |
| Rounds | 1 |
| Wall clock | 21.2 min |
| LLM calls / tool calls | 63 / 76 |
| Unified statements | 73 rows + 11 dimensional breakdown rows; 7 restatements resolved; 0 roll-up breaks; 0 unresolved findings |
| Spine mapping | 205 facts committed, zero reconciliation failures |
| Agent-authored assumptions / analysis rows | 16 / 17 |

## Delegation

The data foundation is built by two delegated agents, each reached with `delegate_to_agent` and each
persisting its own result the moment its checks pass — an accepted unification decision stores the
statements and lands a `statements_unified` revision; an accepted spine mapping commits its facts and
refreshes the WACC sheet inside the same tool result.

| Delegate | Rounds | Threads | Non-ok |
| --- | --- | --- | --- |
| `statement_unification` | 1 | 1 | 0 |
| `spine_mapping` | 1 | 1 | 0 |

`market_research` was never delegated to in this run: the agent still held `financial_search` and
used it directly for a single named lookup. That is the observation that led to removing the direct
search tools from the DCF pool — a search payload is retained in the agent's progress for the whole
run, so the cheap-looking call is re-billed on every remaining step, while a delegated round burns
the delegate's context and returns a bounded account.

## Skill discipline

The `dcf-modeling` skill makes reading a stage's playbook a precondition of acting in that stage, and
stage 4 additionally requires the issuer's sector playbook. Both held, in order:

```
01-extraction → 02-unification → 03-spine-and-commit → 04-analysis-and-forecast
  → formulas → sectors/technology.md → 05-wacc → 06-valuation
```

`sectors/technology.md` was chosen by what Apple actually does, not by a GICS label, and read at the
start of stage 4 where the playbook requires it. No reference read failed.

## What the agent decided

| Assumption | Values | Source |
| --- | --- | --- |
| `metric.custom.gross_margin_product` | [0.353, 0.363, 0.365, 0.372, 0.368] | `company_disclosure` |
| `metric.custom.gross_margin_service` | [0.697, 0.717, 0.708, 0.739, 0.754] | `company_disclosure` |
| `metric.custom.gross_margin_product` | [0.37, 0.37, 0.37, 0.37, 0.37] | `analyst_inference` |
| `metric.custom.gross_margin_service` | [0.762, 0.769, 0.775, 0.78, 0.784] | `analyst_inference` |
| `growth.revenue.product` | [0.03, 0.03, 0.03, 0.03, 0.03] | `analyst_inference` |
| `growth.revenue.service` | [0.12, 0.11, 0.105, 0.1, 0.095] | `analyst_inference` |
| `metric.custom.opex_to_revenue` | [0.15, 0.152, 0.153, 0.154, 0.155] | `analyst_inference` |
| `tax_rate` | [0.16, 0.16, 0.16, 0.16, 0.16] | `analyst_inference` |
| `ratio.da_to_revenue` | [0.029, 0.029, 0.029, 0.029, 0.029] | `analyst_inference` |
| `ratio.capex_to_revenue` | [0.029, 0.029, 0.029, 0.029, 0.029] | `analyst_inference` |
| `ratio.operating_nwc_to_revenue` | [-0.103, -0.116, -0.124, -0.173, -0.125, -0.14, -0.14, -0.14, -0.14, -0.14] | `analyst_inference` |
| `lease_liabilities` | [0] | `company_disclosure` |
| `preferred_equity` | [0] | `company_disclosure` |
| `non_controlling_interests` | [0] | `company_disclosure` |
| `terminal_growth` | [0.035] | `analyst_inference` |
| `exit_multiple` | [15] | `analyst_inference` |

WACC resolved to **10.47%** from beta 1.20 (computed against SPY over 10 years), a 5.19% risk-free
anchor and a 4.5% equity risk premium the agent stated as its own judgment.

That anchor is the one methodological fault this run exposed. The agent chose the 30Y Treasury,
defending it in its own rationale — the terminal value dominates, so the long end matches the cash
flows' duration — and then quoted Damodaran's implied ERP beside it, whose own rationale says it is
measured *over the 10Y*. A premium is only defined relative to some rate, so pairing a 10Y-based
premium with a 30Y anchor adds the term spread twice: once in the rate, once inside a premium
calibrated without it. The agent noticed the mismatch and wrote it down without adjusting for it.
The default anchor is now the 10Y, and `05-wacc.md` requires the rate and the premium to name the
same tenor; worth roughly 50bp of cost of equity, about $12 per share here.

## Valuation

| Method | Enterprise value | Equity value | Implied value / share |
| --- | --- | --- | --- |
| Perpetuity growth (3.5%) | $2,112B | $2,146B | **$143.03** |
| Exit multiple (15x) | $2,534B | $2,567B | **$171.11** |

Both sit well below the market price, and the model says why rather than hiding it: 73% of enterprise
value is terminal, and at a 10.47% discount rate the perpetuity terminal multiple is only
14.8x terminal FCFF against the ~36x the market was paying. Independent published DCFs on the
same issuer land nearer $244–260 using ~8% discount rates. The gap is the discount rate, not a defect
in the chain — which is exactly the kind of disagreement the sensitivity grid exists to expose, and
the reason every input is an override away from being re-run.

## Prompt cost

Read the weighted total, never `tokens_in` alone: a cache read bills at ~0.1x and a cache write at
~1.25x, so a change can cut `tokens_in` by 93% and still cost more. A `cache_read_write_ratio` below
1 means the run wrote cache entries it never read back.

| Agent | Calls | tokens_in | cache_read | cache_write | Equivalent input | r/w |
| --- | --- | --- | --- | --- | --- | --- |
| `subagent:financial_modeling` | 47 | 1,616,295 | 2,009,087 | 782,179 | 2,794,927 | 2.57 |
| `subagent:statement_unification` | 13 | 83,542 | 364,904 | 38,564 | 168,237 | 9.46 |
| `subagent:spine_mapping` | 3 | 32,769 | 9,210 | 18,394 | 56,683 | 0.5 |

## Reproducing

```bash
node --env-file=.env --experimental-strip-types --experimental-sqlite \
  scripts/xbrl/e2e_test/dcf-agent-e2e.ts AAPL --fresh
```

Artifacts land under `data/e2e-test/dcf-agent/aapl/`: `summary.json` carries the verdict, the
delegation and skill-discipline accounting, and the cost table; `model/` carries the revision
headers, the final snapshot, and the source review.
