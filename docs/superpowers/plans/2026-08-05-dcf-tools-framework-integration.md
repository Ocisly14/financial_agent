# DCF Tools and Framework Integration (Phase 2) Plan

Date: 2026-08-05
Status: Implementation in progress; hierarchical DCF Agent architecture, model-creation flow, and full filing-level statement extraction agreed

Parent design: `docs/superpowers/specs/2026-08-04-financial-modeling-dcf-platform-design.md`
Phase 1 implementation: `docs/superpowers/plans/2026-08-04-dcf-core-engine.md`

## 1. Goal

Expose the deterministic Phase 1 DCF engine through a hierarchical DCF Agent. The top-level `financial_modeling` Agent is the DCF domain orchestrator and owns lifecycle, revision, and modeling decisions. It delegates bounded read/analyze work to specialized internal subagents, reviews their structured proposals, and alone invokes mutating MCP tools. MCP tools validate and translate requests into `FinancialModelService` calls; the Phase 1 service remains the only calculation and revision authority. Phase 2 also includes filing-level XBRL extraction because the Agent must see complete company-presented statements, including issuer-specific rows, before it can create DCF categories and reviewed mappings.

Phase 2 is complete when an Agent can execute the persisted workflow below end to end with owner scoping, optimistic concurrency, resumable context, and no LLM arithmetic:

```text
create model
-> review historical statements and mappings
-> inspect automatic historical metrics
-> forecast revenue
-> forecast operations and FCFF
-> configure valuation
-> inspect valuation and sensitivities
```

## 2. Design and Implementation Order

The Agent capability contract comes first because tool boundaries must follow the decisions the Agent actually needs to make. Runtime implementation follows a different dependency order so the Agent is never connected to tools that do not yet work:

1. Define the DCF Agent orchestrator, its internal subagent roster, proposal contracts, mutation authority, inputs, outputs, and prohibited behavior.
2. Derive the MCP tool contracts from that workflow.
3. Implement and test the MCP tools as thin adapters over the Phase 1 service.
4. Register the top-level DCF Agent kind, prompt, tool pool, event sources, and dispatcher integration, then add its internal subagent runtime and registry.
5. Add replaceable workbook-context projection, child-specific read projections, revision-conflict refresh, tool-budget handling, and resumption.
6. Run the full create-to-valuation Agent acceptance workflow.

Do not implement the Agent runtime first and invent tool behavior afterward. Do not put financial arithmetic, snapshot mutation, or a second state machine in the MCP layer.

## 3. Hierarchical DCF Agent Contract

### 3.1 Runtime hierarchy

```text
Financial Agent Orchestrator
└── financial_modeling (DCF Agent and domain orchestrator)
    ├── statement_extraction
    ├── historical_mapping
    ├── forecast_modeling
    └── valuation_review
```

Only `financial_modeling` is a top-level Financial Agent `AgentKind` visible to the main orchestrator. The four DCF subagent kinds belong to an internal DCF subagent registry and cannot be dispatched as unrelated top-level agents.

The DCF Agent owns:

- `modelId`, current revision, lifecycle stage, and resumption state;
- selection and sequencing of internal subagent tasks;
- the complete current `ModelContextView`;
- review of every child proposal against current cells, diagnostics, and source evidence;
- all calls to mutating financial-model tools;
- conflict refresh and retry;
- stage advancement and the final platform-grounded report.

Internal subagents receive bounded, stage-specific read projections and return structured proposals. They do not share mutable conversation state, dispatch one another, or independently advance the model lifecycle. Except for dedicated ingestion/insight persistence outside the financial-model revision store, they have read-only model access.

### 3.2 Internal subagents

#### `statement_extraction`

Uses a small model for source-grounded extraction only. It coordinates deterministic filing/Arelle preprocessing, reads deterministic filing chunks, produces `FilingInsight` records, and reports statement and insight coverage/failures. Arelle is a deterministic tool used by this child, not another Agent. This child writes only the dedicated source/insight ingestion stores through bounded ingestion interfaces; it cannot mutate a financial-model revision or propose DCF categories, mappings, formulas, assumptions, or valuation conclusions.

#### `historical_mapping`

Uses a reasoning-capable model. It reads the complete versioned statements, all dimensional entries, compact filing insights, statement coverage, and current DCF template. It proposes:

- selected historical periods;
- issuer-specific DCF detail rows;
- period-scoped `StatementMappingPlan` values;
- arbitrary `DcfCategoryGroup` values and signed members;
- fact review decisions and corrections;
- explanations of unresolved high-level categories and reconciliation issues.

It returns a proposal only. The DCF Agent reviews and submits the atomic history-review mutation.

#### `forecast_modeling`

Uses a reasoning-capable model. It reads reviewed historical DCF rows, automatic metrics, relevant filing insights, and supplied research evidence. It proposes ordered Operations DSL batches for revenue, cost, tax, D&A, capex, operating working capital, NOPAT, and FCFF. It identifies independent operations and dependencies but performs no arithmetic itself.

#### `valuation_review`

Uses a reasoning-capable model. It reads FCFF, annual WACC inputs, terminal assumptions, bridge rows, diagnostics, and both sensitivity outputs. It proposes missing valuation inputs or method configuration, verifies that the engine output is complete, and identifies limitations. It does not calculate or alter valuation outputs.

### 3.3 Proposal and mutation authority

Every internal proposal is tied to the state it inspected:

```ts
type DcfSubagentProposal<T> = {
  subagent: "historical_mapping" | "forecast_modeling" | "valuation_review";
  modelId: string;
  baseRevision: number;
  lifecycleStage: LifecycleStage;
  rationale: string;
  payload: T;
  sourceRefs: string[];
};
```

`statement_extraction` returns a separate ingestion result keyed by immutable filing accession, content hash, and extraction-run ID. Its private curation loop selects and verifies face tables before model creation; it does not return a modeling proposal and has no authority to recommend model mutations.

The DCF Agent must reject or refresh a proposal whose `baseRevision` is stale. It may accept, modify, or discard a proposal. Only after review does it call `review_financial_model_history` or `apply_financial_model_operations`. Internal subagents never receive owner credentials that permit model mutation.

This creates one serial writer:

```text
internal subagent reads and proposes
-> DCF Agent reviews against current revision
-> DCF Agent calls one mutating MCP tool
-> platform commits one revision
```

### 3.4 Stepwise responsibilities

The DCF Agent works through the model in explicit steps and delegates analysis to the appropriate internal subagent:

1. Find an existing model or request creation of a new model.
2. Read the complete filing-derived income statement, balance sheet, cash-flow statement, and base DCF template.
3. Select the historical fiscal periods to model.
4. Create issuer-specific DCF detail categories after inspecting the statements.
5. Map prepared statement rows into the selected DCF categories.
6. Define reviewed `DcfCategoryGroup` membership with explicit `add`, `subtract`, and `exclude` treatments, then inspect DCF-table reconciliation.
7. Inspect automatically calculated historical metrics.
8. Submit revenue assumptions or restricted formulas and inspect the revenue forecast.
9. Submit operating-cost, tax, D&A, capex, and operating-working-capital assumptions or formulas.
10. Inspect NOPAT and FCFF.
11. Submit the annual WACC path, terminal assumptions, valuation configuration, equity-bridge inputs, and diluted shares.
12. Inspect both terminal methods and both sensitivity matrices before reporting results.

The Agent may submit several independent or dependent operations in one ordered batch. The Phase 1 dependency graph determines calculation order, and one successful batch creates one revision.

### 3.5 DCF Agent boundaries

The DCF Agent may:

- choose fiscal periods and issuer-specific DCF categories;
- map imported statement rows into DCF categories;
- choose signed mapping and category-group membership;
- translate supplied research evidence into sourced assumptions;
- select registered metrics and submit restricted formulas;
- inspect calculated cells, reconciliation results, diagnostics, lineage, valuation, and sensitivities;
- retry from the latest revision after a structured error.

The DCF Agent and all internal subagents must not:

- add or reconcile statement values in prose;
- calculate ROA, ROE, NOPAT, FCFF, terminal value, or per-share value itself;
- modify snapshots outside the typed Operations DSL;
- perform external evidence research that belongs to `market_research`;
- present a numerical result that does not appear in a tool response;
- predefine product, geography, reporting-basis, or other issuer-specific disclosure categories before reading the imported statements.

## 4. MCP Tool Surface Derived from the Agent Workflow

The currently agreed public tool surface is:

| Agent need | MCP tool |
| --- | --- |
| Create a base model and stage its source statements | `create_financial_model` |
| Commit reviewed periods, categories, mappings, and facts | `review_financial_model_history` |
| Submit assumptions, formulas, categories, configuration, and stage advancement | `apply_financial_model_operations` |
| Read the current context, a workbook section, selected cells, lineage, or an old revision | `get_financial_model` |
| Find models owned by the current Agent | `list_financial_models` |
| Archive a model without deleting its history | `archive_financial_model` |

The six-tool count is not itself a goal. It remains valid only while these tools cover the Agent workflow without generic patches, hidden arithmetic, or duplicated service logic.

## 5. Initial Model-Creation Flow

### 5.1 User trigger

The initial trigger is a user request to create a DCF model for a specific company. The Agent calls `create_financial_model` once. The Agent does not call separate public tools for each financial statement.

The public request initially contains:

```ts
type CreateFinancialModelInput = {
  symbol: string;
  historyYears?: number;   // default 5; allowed 3..10
  forecastYears?: number;  // default 5; allowed 3..10
  filingForms?: string[];
  reportingCurrency?: string;
};
```

Periods are company fiscal periods, not calendar years inferred from the current date. Phase 2 initially uses annual actual periods and forecast periods; it does not construct TTM periods.

### 5.2 Logical flow

```text
user requests a company DCF
-> resolve symbol and minimal filer metadata
-> determine reporting currency, fiscal year end, and authoritative periods
-> create the standard DCF skeleton
-> retrieve the selected annual filings
-> parse the filing-level XBRL presentation and facts
-> reconstruct the three company-presented financial statements
-> split the filing document into source-anchored sections and analyze them with a small model
-> persist important filing disclosures as cited modeling evidence
-> normalize them mechanically into prepared statement rows and staged fact candidates
-> persist it in the model database
-> return the three prepared sheets beside the base DCF template
```

Although the user-visible sequence begins with model creation, the adapter must resolve minimal company and fiscal-calendar metadata before it can create a valid authoritative period grid. Full statement retrieval happens after the base model has been created.

### 5.3 Revision boundary

One successful `create_financial_model` call orchestrates two explicit service revisions:

- Revision `0`: durable base model containing model metadata, authoritative actual and forecast periods, the fixed DCF skeleton, default metric rows, and default formulas.
- Revision `1`: complete filing-derived prepared source-row definitions and uncommitted `staged` fact candidates for the three statements.

The tool returns revision `1` as the current revision. Keeping these steps separate makes the initial data load auditable and leaves a durable revision `0` that can be retried or supplemented if statement staging fails.

No imported value is committed into a DCF historical cell during creation.

### 5.4 Persisted creation data

The backend persists:

- stable model identity: `modelId`, symbol, CIK, company name, owner Agent ID, and origin session ID;
- reporting metadata: reporting currency and fiscal year end;
- the immutable authoritative period grid;
- the standard DCF skeleton, default metric registry rows, and formulas;
- prepared statement row definitions for the income statement, balance sheet, and cash-flow statement, preserving filing role, presentation hierarchy, source concept, original label, original order, statement identity, dimensions, and unit;
- staged fact candidates preserving value, fiscal period, context, dimensions, source type, source references, filing/accession metadata, and as-of date;
- structured warnings for missing, incompatible, or unavailable source data.
- immutable, source-anchored filing insights extracted by the configured small model, including the source chunk hash and extractor version.

Creation does not persist issuer-specific category groups, mappings, committed active facts, Agent-computed totals, or filled missing values. Those belong to historical review.

Creation has a blocking three-statement type gate and a non-blocking period-coverage review. Arelle must find structurally usable candidates for an income statement, balance sheet, and cash-flow statement, but this is not a final face-statement decision. Gaps in individual requested years are returned to the Agent as structured review issues rather than automatically failing creation.

### 5.5 Initial Agent-facing response

The successful response has this shape:

```ts
type CreateFinancialModelResult = {
  modelId: string;
  revision: 1;
  lifecycleStage: "draft";
  revisionSummary: RevisionSummary;
  filingInsights: FilingInsightContextView;
  currentWorkbook: {
    mode: "statement_mapping";
    sourceStatementReview: {
      incomeStatement: PreparedStatementSheet;
      balanceSheet: PreparedStatementSheet;
      cashFlowStatement: PreparedStatementSheet;
    };
    dcfTemplate: DcfWorkbookView;
  };
  warnings: Diagnostic[];
};
```

The response gives the Agent the complete current mapping view once: the three prepared source sheets and the unpopulated DCF template. After reviewed history is committed, normal context switches to the DCF-only workbook unless an explicit audit or mapping exception reopens source rows.

The response also includes the current compact filing-insight set. Insights remain part of normal model context after the source sheets disappear; they are important modeling evidence rather than a temporary mapping-only view.

Each prepared source sheet has two coordinated views during initial mapping:

```ts
type PreparedStatementMappingView = {
  candidate: {
    periods: Period[];
    rows: PreparedStatementRowView[];
  };
  filingPresentations: Array<{
    accession: string;
    form: "10-K" | "10-K/A";
    filedAt: string;
    isLatest: boolean;
    periodColumns: Period[];
    rows: FilingPresentationRowView[];
  }>;
};
```

`candidate` is the deterministic newest-first, older-backfill workbook produced from tables already selected by the private curation loop. Its facts remain staged until the Agent commits fact decisions. `filingPresentations` shows the latest statement columns and the relevant older statement columns separately, preserving each filing's row labels, concepts, hierarchy, order, and values.

The ingestion store retains every inline-XBRL HTML table containing a requested annual fact. The normal source-review artifact exposes only curated tables and staged fact candidates. Each retained table preserves a deterministic `sourceTableId`, nearby heading, HTML order, grid cells, period/context/unit/dimensions, and real source anchors. Arelle presentation-role overlap is exposed only as `suggestedStatements`; the private curation loop, not `historical_mapping`, decides whether a table is a face statement or a note.

`review_financial_model_history` receives no table-classification payload. Fact decisions, selected periods, DCF rows, statement mappings, and category groups commit atomically in one revision. A second initialization is rejected, so ordinary later work uses only the DCF workbook; the immutable table catalog and ingestion-run curation decisions remain available for audit.

The Agent uses the versioned presentations to recognize renames, splits, combinations, and presentation moves. It then maps distinct source rows into the same DCF detail row with explicit period coverage when appropriate. The platform does not merge rows merely because their labels look similar.

## 6. Data-Source Boundary for Phase 2

Phase 2 uses complete filing-level XBRL statements as the primary historical input. It does not build the Agent's mapping workbook from the current curated SEC Company Facts metric whitelist.

The extraction layer must:

- locate the selected company's annual filings and primary XBRL documents;
- run a bounded Arelle adapter outside the network-free core engine;
- identify candidate presentation roles for the income statement, balance sheet, and cash-flow statement without treating those roles as final authority;
- preserve actual inline-HTML table boundaries, headings, row text/order, individual fact occurrences, and source anchors;
- preserve the company's presentation relationships, hierarchy, labels, and row order;
- retain standard and issuer-specific concepts;
- retain consolidated contexts and disclosed dimensional contexts rather than inferring dimensions;
- normalize dates, units, currencies, and signs mechanically while keeping occurrences from different HTML tables distinct;
- produce `PreparedStatementRow[]` plus staged `Fact[]` with complete provenance;
- never classify a source row into a DCF category or calculate a missing subtotal.

This moves the parent design's original Phase 4 Arelle scope into Phase 2. The remaining later extraction phase, if retained, becomes hardening and coverage expansion rather than the first implementation of full statements.

The initial Phase 2 release has no alternate-source fallback for a missing statement type. SEC Company Facts may be used for diagnostics or validation, but it cannot supply or complete the Agent's three-statement mapping workbook. HTML scraping, small-model extraction, and manual values likewise cannot masquerade as a missing authoritative statement.

The extractor may retry another relevant `10-K` or `10-K/A` accession through the same filing-level XBRL/Arelle path. If no attempted filing set yields all three structurally usable statement types, creation remains at revision `0` and returns `incomplete_financial_statements`. Adding another authoritative provider is a future explicitly designed capability, not an implicit fallback chain in the initial release.

The extraction provider is an adapter boundary. Network access and Arelle execution stay outside `src/financial-model/`; the Phase 1 core continues to accept only prepared rows and plain facts and remains network-free.

### 6.1 Three-statement type gate and period review

`create_financial_model` advances from revision `0` to revision `1` only when the filing set contains structurally usable candidates for all three statement types:

```text
income statement
balance sheet
cash-flow statement
```

The blocking type gate requires:

- at least one candidate filing presentation role for each statement type, used only for the structural gate;
- a non-empty presentation tree and at least one valid statement fact for each type;
- identifiable fiscal periods, duration/instant contexts, units, filing identity, and source provenance;
- no unrecoverable parse corruption or currency/context ambiguity that makes the statement uninterpretable.

If an entire statement type is absent or structurally unusable:

- keep durable revision `0`;
- do not call `stageFacts` and do not create revision `1`;
- persist downloaded filing and extraction artifacts outside the model snapshot for diagnosis and retry;
- return a structured blocking `incomplete_financial_statements` error listing the missing or invalid statement types, attempted accessions, and extraction diagnostics;
- do not label a curated Company Facts core-metric sheet as the missing complete statement;
- allow a later retry to continue from the same `modelId` and revision `0`.

Missing individual years, cells, or line items are review issues rather than creation blockers once all three statement types pass. Apply the newest-first and older-filing backfill rule, stage every valid available fact in revision `1`, and return a deterministic coverage matrix:

```ts
type StatementCoverageView = {
  requestedPeriodIds: string[];
  statements: Array<{
    statement: "income_statement" | "balance_sheet" | "cash_flow_statement";
    availablePeriodIds: string[];
    missingPeriodIds: string[];
  }>;
  issues: Array<{
    code: "missing_period" | "missing_cell" | "incompatible_context" | "presentation_change";
    severity: "review_required";
    statement: string;
    periodIds: string[];
    sourceRefs: string[];
  }>;
};
```

The successful create response includes this coverage view and warnings beside the mapping workbook. The Agent decides whether to:

- select only the adequately covered historical periods;
- retry extraction or inspect another filing;
- provide a reviewed manual fact or correction;
- map changing rows differently by period; or
- leave a nonessential DCF detail missing and accept the resulting diagnostic.

The platform does not infer that a gap is immaterial. The later history-review request explicitly supplies `selectedHistoricalPeriodIds`. Statement coverage remains visible to the Agent, but the `history_committed` completeness gate does not require every source period, source row, detail category, or dimensional disclosure to be present. It evaluates only the required high-level DCF rows in the Agent's selected scope.

Run small-model filing analysis after the three statement types pass, even if the coverage matrix contains review issues. Later small-model failures are non-blocking under §6.4.

### 6.2 Authoritative multi-filing merge

The prepared workbook uses the newest available filing as its authority and uses older annual filings only to fill historical periods that no newer filing reports.

For a requested annual history window:

1. Resolve all relevant `10-K` and `10-K/A` filings and order them by filing date descending, then by accession number as a deterministic tie-breaker.
2. Treat an amendment filed after its original as the newer filing. A value reported or restated by the amendment takes precedence.
3. Use the newest filing that contains a usable presentation for each statement as the primary candidate structure; an amendment with no statements does not make every prior presentation non-latest.
4. Populate each exact source coordinate from the newest filing that reports it.
5. Walk older filings from newest to oldest and fill only still-empty requested fiscal periods. An older filing must never overwrite a value supplied by a newer filing.
6. Retain per-cell provenance identifying the accession, form, filed date, concept, context, unit, and source document that supplied the selected value.
7. Preserve rows that exist only in an older filing when they are needed to represent a backfilled period. Mark their presentation source explicitly; do not silently fold them into a newer row with a different concept.

An exact source coordinate is matched mechanically by statement identity, concept identity, compatible unit, period, and identical dimension signature. Standard concepts with the same taxonomy identity may be joined across filings. Issuer-specific concepts are joined only when their qualified concept identity is the same. Similar labels are not sufficient to merge rows: if a company renames or replaces a concept, keep separate prepared rows and let the Agent map both rows into the appropriate DCF category.

After the curation loop identifies face statements, a comparative value in the newest curated face statement takes precedence even when it differs from the value originally reported in an older filing. `mergeCuratedTables` applies that precedence before facts reach public history review. Older annual filings fill only periods absent from newer face statements.

### 6.3 Presentation changes remain visible to the Agent

The initial `statement_mapping` context includes both:

- the unreviewed candidate columns that become staged facts; and
- separate latest and historical filing presentation columns used to understand how row definitions changed.

For example, if the latest filing reports `Cloud revenue` for `FY2024–FY2025`, while an older filing reports `Subscription revenue` for `FY2021–FY2023`, keep both source rows visible. The Agent may create one DCF row such as `revenue.cloud_services` and submit two non-overlapping mapping plans:

```text
Subscription revenue -> revenue.cloud_services for FY2021..FY2023
Cloud revenue        -> revenue.cloud_services for FY2024..FY2025
```

If a row is split or combined across filings, the Agent can map several explicit `add`/`subtract`/`exclude` members for the affected periods. The calculation engine executes only the committed normalized mappings; it never asks the LLM to perform the sum.

Source-row identity must distinguish concepts and dimension signatures. Filing-version metadata remains attached to the row and cells so the Agent can see which presentation introduced or retired the row. A changed label alone neither creates an automatic equivalence nor prevents exact concept identity from being recognized mechanically.

### 6.4 Small-model filing analysis

Full-statement XBRL extraction and narrative filing analysis are parallel pipelines with different authority:

```text
filing XBRL -> Arelle grids -> private curation -> curated statements and staged numeric facts
filing document -> deterministic chunks -> small model -> cited filing insights
```

The DCF Agent invokes its private `statement_extraction` subagent for this stage. That subagent invokes the bounded Arelle adapter for deterministic statement extraction and the configured small model for chunk analysis, then returns a structured ingestion/coverage result. The top-level Financial Agent does not dispatch it independently.

The filing-insight model does not replace Arelle and does not create authoritative financial facts. Its purpose is to find important information in long filings that is useful for mapping, assumptions, and model review but is not adequately represented by consolidated XBRL cells.

#### Deterministic chunking

Chunk the filing before model inference using filing structure rather than arbitrary conversation turns:

- filing accession and source-document URL;
- `Item` and section heading;
- financial-statement note and subsection;
- table identity where available;
- stable paragraph/table index and character offsets;
- bounded chunk size with minimal deterministic overlap when one section is too large;
- a content hash for cache identity and reprocessing.

Keep tables with their headings and nearby explanatory text when possible. Never concatenate unrelated filing sections merely to fill a token budget.

#### Small-model output

Each chunk produces zero or more structured candidates:

```ts
type FilingInsight = {
  insightId: string;
  modelId: string;
  accession: string;
  filingForm: "10-K" | "10-K/A";
  filedAt: string;
  sourceDocumentUrl: string;
  section: string;
  sourceAnchor: {
    chunkId: string;
    contentHash: string;
    paragraphOrTableIds: string[];
    startOffset?: number;
    endOffset?: number;
  };
  topic: string;
  summary: string;
  importanceReason: string;
  periodRefs: string[];
  conceptRefs: string[];
  relatedSourceLineItemIds: string[];
  shortEvidence: string;
  confidence: "high" | "medium" | "low";
  extractor: {
    modelClass: "small";
    modelVersion: string;
    promptVersion: string;
  };
  status: "candidate" | "reviewed" | "rejected";
};
```

`topic` is an Agent-readable semantic label rather than a DCF category enum. Useful content includes, without limiting the model to a fixed disclosure taxonomy:

- segment, product, and geography definitions or changes;
- revenue recognition and disaggregation;
- cost structure and operating-expense composition;
- acquisitions, disposals, restructuring, and discontinued operations;
- restatements and accounting-policy changes;
- debt, leases, cash restrictions, investments, and other equity-bridge evidence;
- tax, capex, D&A, working-capital, and share-count disclosures;
- management explanations of material historical changes;
- contractual commitments or other items that could affect forecasts.

The schema may retain numbers in `shortEvidence` as reported text, but those numbers are not model facts and cannot enter calculation cells automatically. Any number used by the model must still come from an authoritative XBRL/prepared fact or be submitted later as a sourced, reviewed fact or assumption.

The small model is deliberately not a mapping or modeling planner. It must not propose:

- DCF categories or line-item creation;
- equivalence between old and new statement rows;
- `StatementMappingPlan` membership;
- `DcfCategoryGroup` membership or `add`/`subtract`/`exclude` treatment;
- formulas, forecast methods, assumptions, WACC, terminal inputs, or valuation conclusions.

`relatedSourceLineItemIds` means only that the source text explicitly names or is anchored beside those extracted statement rows. It is a retrieval link, not a recommendation to merge or map them. The main `financial_modeling` Agent performs all cross-chunk reasoning and modeling decisions after receiving the statements, dimensional entries, and cited insight summaries.

#### Persistence and reproducibility

Persist filing insights outside the immutable financial-model snapshot and link them by `modelId` and accession. The database retains:

- the source chunk and its content hash;
- every structured insight;
- model and prompt versions;
- processing time and failure state;
- review status;
- superseded extraction runs rather than last-write-wins replacement.

Reprocessing the same content hash with the same extractor version may reuse the stored result. A new prompt or model version creates a new extraction run and never silently rewrites the old record.

Small-model analysis is non-blocking. If authoritative filing retrieval, Arelle extraction, three-statement reconstruction, and fact staging succeed, `create_financial_model` succeeds even when some or all filing chunks fail model analysis. The active insight set records its coverage explicitly:

```ts
type FilingInsightSetStatus = {
  status: "complete" | "partial" | "unavailable";
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  failureCodes: string[];
};
```

Failed chunks retain their accession, section, source anchor, content hash, attempt count, and structured failure. The create response and automatically injected insight context include a warning and the coverage status, while every successfully extracted insight remains usable. Missing insight output is never interpreted as evidence that a disclosure does not exist.

Retries operate on failed content hashes without rerunning successful chunks. A retry writes a new immutable extraction run. If its result is activated for the model, activation creates a new financial-model revision with the new `filingInsightSetId`; it does not silently change the insight set attached to an existing revision.

The current workbook stores only the active `filingInsightSetId` and compact insight references needed for lineage. Full filing text and chunk payloads are not embedded in DCF snapshots.

#### Agent use

During initial statement mapping, show insights about presentation changes, segment definitions, restatements, accounting policies, and relevant note disclosures beside the versioned statements. The compact current insight set is also injected automatically during forecast and valuation stages, rather than requiring the Agent to remember to call a separate disclosure tool.

Every injected insight must retain its filing citation and source anchor. The main Agent decides whether an insight affects category mapping or a sourced assumption. The small model cannot commit mappings, facts, formulas, assumptions, or lifecycle changes.

#### Automatic context injection

There is no separate public filing-insight query tool in Phase 2. `create_financial_model`, the default `get_financial_model` context read, model resumption, and successful mutation responses all expose one replaceable `FilingInsightContextView` alongside the revision history and current workbook:

```ts
type FilingInsightContextView = {
  insightSetId: string;
  extractorVersion: string;
  coverage: FilingInsightSetStatus;
  filings: Array<{
    accession: string;
    form: "10-K" | "10-K/A";
    filedAt: string;
  }>;
  insights: Array<{
    insightId: string;
    topic: string;
    summary: string;
    importanceReason: string;
    periodRefs: string[];
    relatedSourceLineItemIds: string[];
    confidence: "high" | "medium" | "low";
    accession: string;
    section: string;
    sourceAnchor: FilingInsight["sourceAnchor"];
  }>;
};
```

The automatic block contains every deduplicated insight accepted into the active set in compact form. It omits full filing text, complete chunks, extraction traces, and superseded extraction runs. An explicit detailed `get_financial_model` read by insight ID or source anchor may return the stored short evidence and source chunk when the Agent needs to verify the summary.

The context projection becomes:

```text
ModelContextView {
  revisionHistory: all prior deterministic revision summaries,
  filingInsights: one complete compact active insight set,
  currentWorkbook: one complete latest workbook
}
```

Neither old complete workbooks nor old complete insight sets accumulate in the prompt. A successful model mutation replaces only the workbook block and retains the referenced active insight set. A new extraction run is invisible until it is explicitly activated and linked through a new model revision.

`filingInsightSetId` is revision-linked even though insight bodies live in separate database tables. Reading the same model revision therefore reconstructs the same insight set. Reprocessing a filing cannot silently change historical model context; activating a new set requires a revision that records the new set ID.

### 6.5 Complete dimensional-disclosure view

The initial `statement_mapping` workbook automatically exposes every dimensional XBRL disclosure extracted from the selected filings. The platform does not preselect product, geography, business segment, channel, customer type, legal entity, or another disclosure basis for the Agent.

The view groups facts mechanically without deciding their financial meaning:

```ts
type DimensionalDisclosureView = {
  statementOrNoteRole: string;
  concept: {
    qname: string;
    label: string;
    unit: Unit;
  };
  dimensions: Array<{
    axisQName: string;
    axisLabel: string;
    memberQName: string;
    memberLabel: string;
    typedMemberValue?: string;
  }>;
  dimensionSignature: string;
  periods: Array<{
    periodId: string;
    value: number | null;
    accession: string;
    contextId: string;
    sourceAnchor: string;
  }>;
};
```

Include all dimension signatures disclosed in the selected filing set, including explicit eliminations, reconciliation members, and historical members that disappear in the latest filing. Keep the consolidated no-dimension fact separate from every dimensional fact. Preserve filing role, axis/member labels, context identity, period, unit, decimals, accession, and source location.

No dimensional item is automatically additive. The same economic amount can appear under several independent axes, so the platform must not sum product, geography, and segment views together or mix a consolidated fact with its components. Displaying every item is a review surface, not an aggregation instruction.

The Agent decides:

- which disclosed dimensions are useful for the DCF;
- whether two members should remain separate or map into one DCF detail row;
- whether a member is `add`, `subtract`, or `exclude`;
- which disclosure basis reconciles to a DCF parent for each period range;
- how to handle renamed, split, combined, introduced, or retired members across filings;
- whether several independent category views should coexist for analysis.

The Agent expresses the decision by creating issuer-specific DCF rows, period-scoped `StatementMappingPlan` values, and arbitrary `DcfCategoryGroup` values. Only committed mappings enter calculations. Reconciliation runs afterward over DCF rows, not over raw dimensional facts.

All dimensional entries are stored in the backend and automatically included in the initial mapping context in a compact structured representation. After history is reviewed, they leave the normal DCF-only workbook; an explicit audit read, unmapped new member, structural change, restatement, or reconciliation exception can reopen the relevant entries. Compact `FilingInsight` summaries remain automatically injected under the separate insight policy in §6.4.

## 7. Historical Review Contract Implied by Creation

Creation ends after table curation but before DCF mapping. After inspecting the three sheets, the Agent calls `review_financial_model_history` with one atomic review payload:

```ts
type ReviewFinancialModelHistoryInput = {
  modelId: string;
  expectedRevision: number;
  selectedHistoricalPeriodIds: string[];
  decisions: FactReviewDecision[];
  categoryLineItems: NewDcfCategoryLineItem[];
  statementMappingPlans: StatementMappingPlan[];
  categoryGroups: DcfCategoryGroup[];
};
```

The review tool must not accept the removed specialized revenue or working-capital aggregation-plan types. Product, geography, reporting basis, operating-cost detail, working-capital membership, eliminations, and other disclosure views are Agent-classified `DcfCategoryGroup` values over DCF rows.

### 7.1 High-level DCF completeness gate

Source-statement completeness and DCF readiness are separate questions. Source gaps are review information; advancing to `history_committed` checks only the required high-level rows in the prebuilt DCF backbone for each `selectedHistoricalPeriodId`.

The high-level set is role-based and contains the main accounting and DCF categories, not every issuer-specific detail row. The fixed `history_committed` registry is:

| High-level category | Fixed line item | Gate treatment |
| --- | --- | --- |
| Revenue | `revenue.total` | Required for every selected period |
| Cost of revenue / COGS | `cost_of_revenue` | Required for every selected period |
| Gross profit | `gross_profit` | Required for every selected period |
| Operating expenses | `operating_expenses` | Required for every selected period |
| EBIT / operating income | `operating_income` | Required for every selected period |
| Depreciation and amortization | `depreciation_amortization` | Required for every selected period |
| EBITDA | `ebitda` | Required; may be calculated from EBIT plus D&A |
| Pretax income | `pretax_income` | Required for every selected period |
| Income tax expense | `income_tax_expense` | Required for every selected period |
| Net income | `net_income` | Required for every selected period |
| NOPAT | `nopat` | Required; may be calculated from operating income and tax rate |
| Capital expenditures | `capital_expenditures` | Required for every selected period |
| Operating working capital | `operating_working_capital` | Required; may be calculated from reviewed operating assets and liabilities |
| Change in operating NWC | `change_nwc` | First selected period is `not_applicable`; later periods are required |
| FCFF | `fcff` | First selected period is `not_applicable` when change in NWC has no prior balance sheet; later periods may be calculated from NOPAT, D&A, capex, and change in NWC |

These are the previously discussed major revenue, cost, profit, income, operating-capital, and cash-flow-to-DCF rows. `EBIT` and `operating income` are one fixed category rather than two duplicate requirements.

Issuer-specific detail rows are never part of the fixed registry. Examples include product revenue, geographic revenue, R&D, sales and marketing, G&A, individual receivables, inventory, payables, and custom segment members. The Agent may use any of them to build a required parent, but the gate checks only the parent result.

Balance-sheet metric inputs such as total assets and shareholders' equity remain desirable for automatic ROA/ROE, but missing optional metrics do not block `history_committed`. Equity-bridge balances, diluted shares, annual WACC, terminal growth, and exit multiple are checked later by the `valued` gate, not by the history gate.

The gate checks the calculated DCF cells, not how many source rows produced them. A required parent is complete when its selected-period cell is resolved by one of these reviewed paths:

- a direct consolidated statement mapping;
- an Agent-created category formula with explicit signed members;
- a built-in formula whose required high-level inputs are resolved;
- an explicit status permitted for that fixed role, such as first-period change in NWC being `not_applicable`.

The following do not fail the completeness gate by themselves:

- an unavailable year outside `selectedHistoricalPeriodIds`;
- an unused or rejected source-statement row;
- a missing optional detail category;
- an unmapped dimensional disclosure not selected for the DCF;
- incomplete or unavailable small-model insights;
- an unavailable optional metric such as a CAGR whose lookback exceeds selected history.

Completeness is distinct from correctness. After the high-level cells are populated, DCF-table reconciliation still checks submitted category arithmetic and built-in accounting identities. A material `failed` reconciliation remains a correctness issue; `insufficient_data` and `not_applicable` remain explicit diagnostics rather than fabricated zeros. The gate must never demand a source itemline merely to satisfy a predefined disclosure layout.

```ts
type HistoricalDcfCompletenessView = {
  selectedHistoricalPeriodIds: string[];
  categories: Array<{
    lineItemId: string;
    role: LineItemRole;
    periods: Array<{
      periodId: string;
      status: "complete" | "missing" | "not_applicable";
      refs: string[];
    }>;
  }>;
};
```

Return this view to the Agent before or with a failed stage-advance attempt so it can see exactly which DCF parent remains unresolved without inspecting every source fact again.

## 8. Initial Implementation Tasks

- [x] Fix the runtime hierarchy: one top-level `financial_modeling` DCF Agent with private `statement_extraction`, `historical_mapping`, `forecast_modeling`, and `valuation_review` subagents.
- [x] Register only `financial_modeling` in the main Financial Agent dispatcher; keep the four DCF subagents in a private DCF subagent registry.
- [ ] Implement stage-specific child context projections and typed ingestion/proposal result schemas.
- [ ] Enforce a single serial writer: children may read/analyze, but only the DCF Agent may invoke revision-mutating financial-model tools.
- [ ] Reject or refresh stale child proposals by `modelId`, `baseRevision`, and lifecycle stage before mutation.
- [x] Add hierarchy tests for private-subagent isolation, child tool allowances, read-only proposal behavior, stale proposals, serial mutation, and resumption.
- [ ] Amend the parent design so full filing-level Arelle extraction is part of Phase 2, the `financial_modeling` budget is consistently 12, and generic `DcfCategoryGroup` replaces specialized aggregation plans.
- [ ] Define the filing and prepared-statement provider interfaces used by `create_financial_model`.
- [x] Prohibit alternate-source statement fallback in the initial release; only filing-level XBRL/Arelle may satisfy the three-statement type gate.
- [x] Select complete filing-derived prepared statement rows rather than the curated SEC Company Facts core metric set.
- [x] Define and implement the bounded Arelle process adapter and its strict JSON input/output protocol.
- [x] Preserve presentation-linkbase overlap and preferred-label evidence as auxiliary input while exposing actual HTML grids to the private curation loop.
- [x] Build prepared rows and staged facts only from curated face tables, without DCF semantic classification.
- [x] Select the newest filing value for every reported comparative period and backfill only absent periods from older annual filings.
- [x] Implement the deterministic multi-filing merge with amendment precedence, exact-coordinate matching, older-only rows, and per-cell accession provenance.
- [x] Expose the latest and historical filing presentation columns to the Agent during initial mapping instead of hiding structural changes in one merged sheet.
- [x] Implement paired candidate and versioned-presentation statement views, keeping historical comparative values read-only unless selected by the newest-first backfill rule.
- [x] Persist the complete table catalog outside snapshots and persist ingestion-run curation decisions separately from model revisions.
- [x] Require the private curation loop to identify and verify all three face statements for each requested fiscal year; keep partial runs explicit in ingestion diagnostics.
- [x] Add a source-anchored small-model filing-analysis pipeline alongside deterministic XBRL extraction.
- [ ] Define deterministic section/table chunking and immutable chunk storage.
- [ ] Define the strict `FilingInsight` schema, small-model prompt, relevance criteria, and extractor versioning.
- [x] Limit the small model to source-grounded extraction and summarization; prohibit category, mapping, formula, assumption, and valuation proposals.
- [ ] Implement bounded parallel chunk analysis, retry behavior, deduplication, and immutable extraction runs.
- [x] Treat partial or total small-model insight failure as non-blocking when complete filing statements and staged facts succeeded.
- [ ] Persist per-chunk failures and coverage status, return structured warnings, and retry only failed content hashes.
- [ ] Persist full insights outside model revisions and expose only compact references in workbook lineage.
- [ ] Add fixture tests proving that every insight has a valid source anchor and that insight numbers never become calculation facts automatically.
- [x] Automatically inject the active compact filing-insight set whenever the Agent creates, reads, resumes, or mutates a model; do not add a seventh public tool.
- [ ] Add revision-linked `filingInsightSetId` storage and deterministic `FilingInsightContextView` projection.
- [ ] Extend `create_financial_model` and default `get_financial_model` responses plus subagent context replacement to carry one active compact insight block.
- [ ] Support explicit detailed reads by insight ID or source anchor through `get_financial_model` without persisting full chunks in normal context.
- [x] Automatically expose every filing-reported dimensional disclosure entry during initial mapping and let the Agent decide all DCF splits and combinations.
- [ ] Implement compact grouping by exact concept and dimension signature while retaining consolidated facts, eliminations, historical members, context IDs, and provenance separately.
- [ ] Add tests proving independent axes are never automatically summed, no dimensional entry is semantically filtered, and only committed DCF mappings participate in reconciliation.
- [ ] Define strict public schemas for `create_financial_model` and its result.
- [ ] Implement owner-aware tool execution context and propagate `agentId` through both tool registries.
- [ ] Implement the create adapter using Phase 1 `createModel` followed by `stageFacts`.
- [x] Require all three structurally usable statement types, while returning individual period and cell gaps to the Agent for review.
- [ ] Persist and return revision `0` when the statement-type gate fails, with a structured retryable `incomplete_financial_statements` error.
- [ ] Create revision `1` with every available staged fact when all three types exist, plus a deterministic `StatementCoverageView` for period and cell gaps.
- [ ] Add tests for a missing statement type, empty or corrupt presentation roles, successful creation with period gaps, Agent-selected shorter history, incompatible contexts, and successful older-filing backfill.
- [ ] Add local filing-fixture tests for fiscal-period selection, role selection, complete three-sheet reconstruction, custom concepts, dimensions, comparative facts, revision boundaries, provenance, incomplete source data, timeout, and retry behavior.
- [ ] Implement the revised history-review tool contract with Agent-created categories and generic category groups.
- [x] Limit the history completeness gate to required high-level DCF backbone rows over the Agent-selected periods.
- [x] Fix the history registry to the agreed revenue, cost, profit, income, NOPAT, capex, operating-NWC, and FCFF parent rows.
- [ ] Implement the fixed role-based high-level completeness registry and `HistoricalDcfCompletenessView` projection.
- [ ] Keep statement-period, detail-row, dimensional, insight, and optional-metric gaps outside the high-level completeness blocker set.
- [ ] Test direct consolidated mappings, Agent category formulas, built-in parent formulas, first-period NWC N/A, missing selected parents, and ignored unselected source gaps.
- [ ] Continue deriving the remaining tool and runtime details from subsequent design discussions.

### 8.1 Implemented table-curation slice (2026-08-05)

Superseded implementation details for the original table-classification slice have been removed. The current contract is defined by `docs/superpowers/specs/2026-08-05-sec-table-curation-design.md`: Arelle protocol v2 emits structured grids, a private `statement_extraction` tool loop curates and verifies face tables, `mergeCuratedTables` applies cross-filing precedence, and `historical_mapping` handles DCF mapping only. Table curation is ingestion-run state and is not part of the public history-review mutation.

Verification completed:

- `npm run build` passes;
- the focused XBRL, curation-loop, financial-modeling, and financial-model tool tests pass;
- the smoke script now invokes the real private curation path before model creation.

## 9. Open Decisions for the Next Discussion

The hierarchy, import breadth, multi-filing precedence, presentation of structural changes, small-model filing analysis, automatic insight injection, dimensional-disclosure scope, and small-model reasoning boundary are decided. Phase 2 has one top-level `financial_modeling` DCF Agent and four private internal subagents. Only the DCF Agent owns lifecycle and model mutations; its subagents return bounded ingestion results or revision-bound proposals. Phase 2 imports curated filing-derived statements, uses the newest curated filing wherever it reports a period, uses older annual filings only to fill missing periods, shows the latest and historical filing columns separately, exposes every reported dimensional entry during initial mapping, persists source-anchored important disclosures extracted from deterministic filing chunks, and injects the active compact insight set whenever the Agent reads or resumes the model. The curation model selects and annotates tables inside the ingestion run; the filing-insight model only extracts and summarizes; the DCF Agent owns mapping and modeling decisions.

Incomplete or unavailable small-model insights are non-blocking once all three statement types exist. A missing or structurally unusable statement type blocks creation; individual period, cell, and line-item gaps are persisted as review issues. The later history completeness gate checks only required high-level DCF rows in the Agent-selected periods, while reconciliation separately checks the correctness of populated category and accounting relationships.

The high-level history registry and initial no-fallback policy are decided. The next decision is context-size handling without semantically filtering dimensional entries or the active insight set.
