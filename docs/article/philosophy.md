# I. Design Philosophy

After spending a considerable amount of time building AI agent systems, I've come to realize that—regardless of whether people call themselves context engineers or harness engineers—once you strip away the buzzwords, the core design philosophy remains the same:

> Given the limited context window of an LLM, maximize the system's overall capability through agent specialization and progressive disclosure, while using deterministic code to constrain errors introduced by model hallucinations.

Starting from first principles, I settled on three guiding principles:

### 1. Context is finite. Progressive disclosure is effectively unlimited.

Progressive disclosure allows us to expose information only when necessary, but it cannot magically reduce context usage without sacrificing either information density or accuracy. There is no free lunch.

### 2. LLMs are flexible. Code is deterministic.

LLMs will hallucinate. They will make mistakes.

Therefore, every point where an LLM is allowed to write persistent state must be guarded by a deterministic code engine responsible for validation, normalization, and enforcement.

### 3. LLMs are tools. Humans own the judgment.

Auditability and traceability are prerequisites for any valuation system that people can actually trust. The final deliverable should therefore be a workbook where every single cell can be traced back to its origin.

---

# II. Agent Topology

Inspired by systems such as LangGraph, the overall architecture of a single agent system is topology-based:

- Agents can be freely composed.
- Skills and tools are registered independently.
- Agents can communicate directly with one another.

The objective is to minimize information loss caused by multiple layers of message passing, preserving both information density and accuracy throughout the system.

At the same time, each individual agent should remain narrowly focused on doing one job exceptionally well.

**Attention is all it needs.**

---

# III. Conversation Itself Is Progressive Disclosure: Topics & Research

Beyond conventional progressive disclosure mechanisms (such as Skills), the conversation itself serves as another layer of progressive disclosure.

A conversation room represents a **Topic**—for example, research on a specific company or a macroeconomic study of an industry. A Topic is a highly reusable knowledge asset. It accumulates:

- conversations,
- charts,
- citations,
- source materials,
- and every DCF modeling workflow ever initiated for that subject.

A **Research** workspace sits one level above Topics. It allows multiple Topics to be combined together, while the same Topic may simultaneously belong to multiple Research workspaces.

Users interact only with the Research workspace. Behind the scenes, the system coordinates all associated Topics, enabling users to:

- perform deeper comparative analysis,
- dispatch new instructions to one or many Topics,
- or create entirely new research Topics on demand.

---

# IV. DCF: A Dual-Layer Architecture of LLM Agents and a Deterministic Code Engine

Hallucination is unavoidable whenever an LLM is involved. For that reason, the valuation system adopts a dual-layer architecture:

- **LLM agents make judgments.**
- **The code engine makes the final decisions.**

The end-to-end pipeline is:

```
SEC/EDGAR extraction → multi-year statement unification → DCF spine mapping
→ historical facts & formulas → forecasting & FCFF
→ WACC / terminal value / equity bridge
→ revisioned valuation model with sensitivity analysis
```

## Preparation: Let the Agent Make Only the Decisions It Should Make

Financial statements are parsed directly from EDGAR using Arelle. For each issuer, the system extracts every 10-K / 10-K/A filing, including:

- every table,
- face statements,
- presentation linkbases,
- calculation linkbases,

and stores them as an immutable ingestion run. Only summary statistics and an `ingestionRunId` are returned to the agent—never the raw data itself.

Hundreds of financial tables cannot fit into an LLM's context window. Instead, dedicated progressive-reading tools allow the agent to inspect information incrementally:

- table summaries,
- structural statistics,
- complete tables,
- or individual line items.

Meanwhile, the engine performs an initial screening across all extracted tables, identifying those most likely to represent the primary financial statements. For each candidate, it generates a structural summary, allowing the agent to select the correct statements.

Once selected:

- the `statement_unification` sub-agent constructs unified historical financial statements (while extracting useful auxiliary dimension tables),
- and the `spine_mapping` sub-agent maps the unified data into the DCF model spine.

The spine itself is intentionally source-free. Revision 0 contains nothing except semantic rows and an empty WACC table anchored to today's date. No row is predefined as historical or forecasted. No formulas exist by default. A row only becomes an actual, formula, or assumption after supporting evidence has been committed.

## Core Principle: Agents May Write Only Formulas and Mappings

At the DCF modeling stage, the modeling agent receives:

- unified historical financial statements,
- and the mapped DCF spine.

Its responsibility is limited to writing:

- formulas (through the DSL tool),
- accounting mappings,
- and valuation assumptions.

These include assumptions such as:

- equity risk premium,
- EV/EBITDA exit multiples,
- terminal growth rates,
- and other valuation inputs.

The deterministic engine then performs the actual valuation calculations.

Throughout the entire workflow, LLMs are allowed to generate only formulas and account mappings. Every numerical value remains fully traceable back to the original SEC filings.

---

# V. Auditability: Every Update Creates a New Revision

Every modification to the valuation model creates a new immutable revision, making both human review and agent-driven refinement straightforward.

Specifically:

- Values directly disclosed in SEC filings are mapped with their original Fact IDs.
- Derived values (for example, `Bridge Cash = Cash + Short-Term Investments`) must always be represented as explicit formulas rather than hard-coded numbers.
- Forecast inputs are stored as assumptions, each accompanied by rationale and source references.

---

# VI. A Real End-to-End Validation

On August 19, the complete Apple (AAPL) valuation pipeline successfully completed an end-to-end run from an entirely empty model:

- No predefined mappings.
- No predefined formulas.
- No predefined assumptions.

Using a real LLM provider and live EDGAR access.

| Metric | Result |
| --- | --- |
| Final Revision / Lifecycle | 15 / valued |
| Historical Period | FY2021–FY2025 |
| Forecast Period | FY2026–FY2030 |
| Total Runs | 1 |
| Wall-clock Time | 21.2 minutes |
| LLM Calls | 63 |
| Tool Calls | 76 |
| Unified Statements | 73 rows + 11 dimensional breakdown rows |
| Restatement Issues Resolved | 7 |
| Roll-up Integrity Failures | 0 |
| Facts Committed to Spine | 205 |
| Mapping Validation Failures | 0 |
| Agent-generated Assumptions | 16 |
| Agent-generated Analytical Rows | 17 |

The resulting WACC converged to **10.47%**, consisting of:

- β = 1.20, calculated through a 10-year regression against SPY,
- a 4.65% risk-free rate anchor,
- and a 4.5% equity risk premium explicitly identified as the agent's own judgment.

Pipeline execution:

```
01-extraction → 02-unification → 03-spine-and-commit
→ 04-analysis-and-forecast → formulas → sectors/technology.md
→ 05-wacc → 06-valuation
```

---

# VII. Closing Thoughts

To be candid, the inherent complexity of historical financial reporting—and the enormous variation in reporting structures across industries—means that the stability of fully automated DCF modeling still has room for improvement.

More importantly, valuation assumptions are inherently subjective. Selecting an appropriate equity risk premium, terminal growth rate, or exit multiple depends heavily on the analyst's own judgment, experience, and investment philosophy.

What this successful run validates is the engineering pipeline—not economic correctness. A successful end-to-end execution demonstrates that the system can construct an auditable valuation model. It does not demonstrate that every assumption is correct. Nor does it constitute investment advice.

More broadly, AI agents exist to improve human productivity—not to replace human thinking. Their purpose is to eliminate repetitive work so that people can devote more attention to reasoning, judgment, and decision-making.

**AI should augment thinking, not replace it.**
