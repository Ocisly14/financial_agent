import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { FinancialModelService } from "../../../src/financial-model/service.ts";
import { AUTO_PREMAP_PLAN_PREFIX } from "../../../src/financial-model/autoPremap.ts";
import type { Fact, Period, StatementKind } from "../../../src/financial-model/types.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore, type FilingIngestionArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { InMemoryDecompositionStore } from "../../../src/infra/xbrl/decompositionStore.ts";
import type { PreparedFilingStatements, PreparedStatementRowView } from "../../../src/infra/xbrl/types.ts";
import type { CandidateScheme } from "../../../src/infra/xbrl/decompositionTypes.ts";
import { createFinancialModelTools, type FinancialModelToolDeps } from "../financialModelTools.ts";

// --- shared fixture plumbing --------------------------------------------------------------------

const PERIODS: Period[] = [
  { id: "FY2023", label: "FY2023", start: "2023-01-01", end: "2023-12-31", cls: "actual" },
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" },
];
const HISTORICAL_PERIOD_IDS = ["FY2023", "FY2024"];
const CURRENCY = { kind: "currency" as const, code: "USD" };

function statementRow(
  sourceLineItemId: string,
  statement: StatementKind,
  label: string,
  conceptQName: string,
  order: number,
  overrides: Partial<PreparedStatementRowView> = {},
): PreparedStatementRowView {
  return {
    sourceLineItemId, statement, label, unit: CURRENCY, order, conceptQName,
    dimensionSignature: "", dimensions: [], depth: 0, presentationAccessions: [],
    ...overrides,
  };
}

function staged(factId: string, lineItemId: string, periodId: string, value: number): Fact {
  return {
    factId, status: "staged", lineItemId, periodId, value, unit: CURRENCY,
    provenance: { sourceType: "filing_xbrl", sourceRefs: ["fixture"], asOfDate: "2026-02-01" },
  };
}

function emptyStatementViews(rows: {
  income_statement?: PreparedStatementRowView[];
  balance_sheet?: PreparedStatementRowView[];
  cash_flow_statement?: PreparedStatementRowView[];
}): PreparedFilingStatements["statementViews"] {
  const kinds: StatementKind[] = ["income_statement", "balance_sheet", "cash_flow_statement"];
  return Object.fromEntries(kinds.map((kind) => [kind, {
    candidate: { periods: PERIODS, rows: rows[kind] ?? [] },
    filingPresentations: [],
  }])) as unknown as PreparedFilingStatements["statementViews"];
}

function buildPrepared(rows: PreparedStatementRowView[], facts: Fact[]): PreparedFilingStatements {
  return {
    filings: [], periods: PERIODS,
    rows: rows.map(({ sourceLineItemId, statement, label, unit, order }) => ({ sourceLineItemId, statement, label, unit, order })),
    facts,
    statementViews: emptyStatementViews({ income_statement: rows.filter((row) => row.statement === "income_statement") }),
    dimensionalDisclosures: [],
    coverage: {
      requestedPeriodIds: HISTORICAL_PERIOD_IDS,
      statements: (["income_statement", "balance_sheet", "cash_flow_statement"] as const).map((statement) => ({
        statement, availablePeriodIds: statement === "income_statement" ? HISTORICAL_PERIOD_IDS : [], missingPeriodIds: [],
      })),
      issues: [],
    },
    diagnostics: [],
  };
}

function harness(): { deps: FinancialModelToolDeps; sourceReview: InMemorySourceReviewStore; decompositionStore: InMemoryDecompositionStore } {
  const sourceReview = new InMemorySourceReviewStore();
  const decompositionStore = new InMemoryDecompositionStore();
  return {
    sourceReview, decompositionStore,
    deps: {
      modelStore: new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec),
      insightStore: new InMemoryFilingInsightStore(),
      sourceReviewStore: sourceReview, ingestionStore: sourceReview, decompositionStore,
    },
  };
}

function seedIngestion(
  deps: FinancialModelToolDeps, ingestionRunId: string, modelId: string, symbol: string, prepared: PreparedFilingStatements,
): void {
  const artifact: FilingIngestionArtifact = {
    ingestionRunId, modelId, ownerAgentId: "owner-1", symbol, status: "ready",
    source: { company: { cik: 1, ticker: symbol, title: "Test Co" }, reportingCurrency: "USD", fiscalYearEnd: "12-31", periods: PERIODS, filings: [] },
    prepared, diagnostics: [],
  };
  (deps.ingestionStore as InMemorySourceReviewStore).saveIngestion(artifact);
}

async function createModel(deps: FinancialModelToolDeps, ingestionRunId: string, symbol = "TEST") {
  const tools = new Map(createFinancialModelTools(deps).map((tool) => [tool.name, tool]));
  const result = await tools.get("create_financial_model")!.execute(
    { symbol, ingestionRunId }, { agentId: "owner-1", sessionId: "s1" });
  return { tools, result };
}

// --- scenario builders ---------------------------------------------------------------------------

/** Vocab-mappable rows: revenue.total, cost_of_revenue, net_income; no revenue face children. */
function vocabMappableRows(): { rows: PreparedStatementRowView[]; facts: Fact[] } {
  const rows = [
    statementRow("source.income_statement.revenue", "income_statement", "Total revenues",
      "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", 0),
    statementRow("source.income_statement.cost_of_revenue", "income_statement", "Cost of revenue",
      "us-gaap:CostOfRevenue", 1),
    statementRow("source.income_statement.net_income", "income_statement", "Net income",
      "us-gaap:NetIncomeLoss", 2),
  ];
  const facts = [
    staged("f-rev-2023", "source.income_statement.revenue", "FY2023", 1000),
    staged("f-rev-2024", "source.income_statement.revenue", "FY2024", 1200),
    staged("f-cor-2023", "source.income_statement.cost_of_revenue", "FY2023", 400),
    staged("f-cor-2024", "source.income_statement.cost_of_revenue", "FY2024", 480),
    staged("f-ni-2023", "source.income_statement.net_income", "FY2023", 100),
    staged("f-ni-2024", "source.income_statement.net_income", "FY2024", 150),
  ];
  return { rows, facts };
}

/** Revenue with two face children (product / service) that exactly partition revenue.total. */
function revenueWithFaceChildren(): { rows: PreparedStatementRowView[]; facts: Fact[] } {
  const revenueId = "source.income_statement.revenue";
  const rows = [
    statementRow(revenueId, "income_statement", "Total revenues",
      "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", 0),
    statementRow("source.income_statement.product_revenue", "income_statement", "Product revenue",
      "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTaxByProduct", 1,
      { parentSourceLineItemId: revenueId, depth: 1 }),
    statementRow("source.income_statement.service_revenue", "income_statement", "Service revenue",
      "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTaxByService", 2,
      { parentSourceLineItemId: revenueId, depth: 1 }),
  ];
  const facts = [
    staged("f-rev-2023", revenueId, "FY2023", 1000),
    staged("f-rev-2024", revenueId, "FY2024", 1200),
    staged("f-prod-2023", "source.income_statement.product_revenue", "FY2023", 600),
    staged("f-prod-2024", "source.income_statement.product_revenue", "FY2024", 700),
    staged("f-svc-2023", "source.income_statement.service_revenue", "FY2023", 400),
    staged("f-svc-2024", "source.income_statement.service_revenue", "FY2024", 500),
  ];
  return { rows, facts };
}

/** Rows whose concepts never appear in the auto-premap vocabulary. */
function unmappableRows(): { rows: PreparedStatementRowView[]; facts: Fact[] } {
  const rows = [
    statementRow("source.income_statement.mystery", "income_statement", "Mystery line",
      "us-gaap:SomeUnknownConceptThatIsNeverMapped", 0),
  ];
  const facts = [staged("f-mystery-2023", "source.income_statement.mystery", "FY2023", 42)];
  return { rows, facts };
}

function cell(workbook: unknown, section: string, lineItemId: string, periodId: string): { value: number | null } | undefined {
  const row = (workbook as any).sections[section].find((candidate: any) => candidate.lineItemId === lineItemId);
  return row?.cells[periodId];
}

function sectionRow(workbook: unknown, section: string, lineItemId: string): any {
  return (workbook as any).sections[section].find((candidate: any) => candidate.lineItemId === lineItemId);
}

// --- 1. create_financial_model: vocab-mappable rows -----------------------------------------------

test("create_financial_model premaps vocab-mappable rows: premap payload, historical values, YOY growth", async () => {
  const { deps } = harness();
  const { rows, facts } = vocabMappableRows();
  seedIngestion(deps, "ing-1", "model-1", "TEST", buildPrepared(rows, facts));
  const { result } = await createModel(deps, "ing-1");
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data;

  // premap sits alongside statement_coverage in the payload.
  assert.ok("statement_coverage" in data);
  assert.ok("premap" in data);
  const premap = data["premap"] as any;
  assert.equal(premap.version, "auto-premap-v1");
  const mappedTargets = premap.mapped.map((entry: any) => entry.targetLineItemId).sort();
  assert.deepEqual(mappedTargets, ["cost_of_revenue", "net_income", "revenue.total"]);

  const workbook = data["current_workbook"];
  // Historical values landed on the mapped spine rows.
  assert.equal(cell(workbook, "revenue", "revenue.total", "FY2023")?.value, 1000);
  assert.equal(cell(workbook, "revenue", "revenue.total", "FY2024")?.value, 1200);
  assert.equal(cell(workbook, "history", "cost_of_revenue", "FY2023")?.value, 400);
  assert.equal(cell(workbook, "history", "net_income", "FY2024")?.value, 150);
  // YOY growth computed once >= 2 actual periods exist; the first actual period has no prior.
  assert.equal(cell(workbook, "revenue", "growth.revenue.total", "FY2023")?.value, null);
  assert.equal(cell(workbook, "revenue", "growth.revenue.total", "FY2024")?.value, 0.2);

  // Revision reflects the post-premap commit: revision 0 (skeleton), 1 (statements staged), 2 (premap).
  assert.equal(data["revision"], 2);
});

// --- 2. revenue face children produce streams ------------------------------------------------------

test("create_financial_model with revenue face children installs revenue.<slug> streams with growth", async () => {
  const { deps } = harness();
  const { rows, facts } = revenueWithFaceChildren();
  seedIngestion(deps, "ing-2", "model-2", "TEST", buildPrepared(rows, facts));
  const { result } = await createModel(deps, "ing-2");
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data;
  const premap = data["premap"] as any;
  const streamTargets = premap.mapped
    .filter((entry: any) => entry.basis === "face_child")
    .map((entry: any) => entry.targetLineItemId)
    .sort();
  assert.deepEqual(streamTargets, ["revenue.product_revenue", "revenue.service_revenue"]);

  const workbook = data["current_workbook"];
  assert.equal(cell(workbook, "revenue", "revenue.product_revenue", "FY2023")?.value, 600);
  assert.equal(cell(workbook, "revenue", "revenue.product_revenue", "FY2024")?.value, 700);
  assert.equal(cell(workbook, "revenue", "revenue.service_revenue", "FY2023")?.value, 400);
  assert.equal(cell(workbook, "revenue", "revenue.service_revenue", "FY2024")?.value, 500);
  // Per-stream growth rows exist and compute YOY once two actuals are present.
  assert.ok(sectionRow(workbook, "revenue", "growth.revenue.product_revenue"));
  assert.ok(sectionRow(workbook, "revenue", "growth.revenue.service_revenue"));
  const productGrowth = cell(workbook, "revenue", "growth.revenue.product_revenue", "FY2024")?.value as number;
  assert.ok(Math.abs(productGrowth - (700 / 600 - 1)) < 1e-9);
  assert.equal(cell(workbook, "revenue", "growth.revenue.service_revenue", "FY2024")?.value, 0.25);
});

// --- 3. zero mappable rows: import behaves exactly as without premap --------------------------------

test("zero mappable rows: premap is present but empty, revision matches the no-premap path", async () => {
  const { deps } = harness();
  const { rows, facts } = unmappableRows();
  seedIngestion(deps, "ing-3", "model-3", "TEST", buildPrepared(rows, facts));
  const { result } = await createModel(deps, "ing-3");
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data;
  const premap = data["premap"] as any;
  assert.deepEqual(premap.mapped, []);
  assert.deepEqual(premap.demoted, []);
  // No premap commit happened: revision stops at 1 (skeleton=0, statements staged=1), same as the
  // pre-existing (non-premap) import path exercised by financialModelTools.test.ts.
  assert.equal(data["revision"], 1);
});

// --- 4 & 6. apply_revenue_decomposition: streams, idempotency, demoted/premap in payload -------------

test("apply_revenue_decomposition installs engine streams via the decomposition driver scheme, is idempotent, and reports demoted/premap", async () => {
  const { deps, decompositionStore } = harness();
  const { rows, facts } = vocabMappableRows(); // no face children
  seedIngestion(deps, "ing-4", "model-4", "TEST", buildPrepared(rows, facts));
  const { tools, result: created } = await createModel(deps, "ing-4");
  assert.equal(created.error, undefined);
  const revisionAfterImport = created.generation_context!.data["revision"] as number;

  const scheme: CandidateScheme = {
    candidateSchemeId: "scheme_1", label: "By product", axisHint: "us-gaap:ProductAxis",
    targetSourceLineItemId: "source.income_statement.revenue",
    children: [
      { childId: "child-a", label: "Widgets", cells: {
        FY2023: { factId: "mf-w-2023", value: 600, accession: "acc-1", filedAt: "2026-02-01", sourceAnchor: "anchor-w-2023" },
        FY2024: { factId: "mf-w-2024", value: 700, accession: "acc-1", filedAt: "2026-02-01", sourceAnchor: "anchor-w-2024" },
      } },
      { childId: "child-b", label: "Gadgets", cells: {
        FY2023: { factId: "mf-g-2023", value: 400, accession: "acc-1", filedAt: "2026-02-01", sourceAnchor: "anchor-g-2023" },
        FY2024: { factId: "mf-g-2024", value: 500, accession: "acc-1", filedAt: "2026-02-01", sourceAnchor: "anchor-g-2024" },
      } },
    ],
    periodIds: HISTORICAL_PERIOD_IDS,
    coverage: { "child-a": HISTORICAL_PERIOD_IDS, "child-b": HISTORICAL_PERIOD_IDS },
    residualRatioByPeriod: { FY2023: 0, FY2024: 0 },
    flags: [], openQuestions: [],
  };
  decompositionStore.saveCandidates("ing-4", [scheme]);

  const applyArgs = { modelId: "model-4", acceptedSchemeIds: ["scheme_1"], driverSchemeId: "scheme_1", rationale: "adopt product split" };
  const applied = await tools.get("apply_revenue_decomposition")!.execute(applyArgs, { agentId: "owner-1", sessionId: "s1" });
  assert.equal(applied.error, undefined);
  const appliedData = applied.generation_context!.data;

  // 6: payload carries demoted and premap.
  assert.ok(Array.isArray(appliedData["demoted"]));
  assert.ok("premap" in appliedData);

  // 4: engine streams appear from the driver scheme.
  const workbook = appliedData["current_workbook"];
  assert.ok(sectionRow(workbook, "revenue", "revenue.widgets"));
  assert.ok(sectionRow(workbook, "revenue", "revenue.gadgets"));
  assert.equal(cell(workbook, "revenue", "revenue.widgets", "FY2024")?.value, 700);
  assert.equal(cell(workbook, "revenue", "revenue.gadgets", "FY2024")?.value, 500);
  const appliedRevision = appliedData["revision"] as number;
  assert.ok(appliedRevision > revisionAfterImport);

  // Idempotent no-op: calling again with the same decision returns the same revision.
  const reapplied = await tools.get("apply_revenue_decomposition")!.execute(applyArgs, { agentId: "owner-1", sessionId: "s1" });
  assert.equal(reapplied.error, undefined);
  assert.equal(reapplied.generation_context!.data["revision"], appliedRevision);
});

// --- 5. engine plans are replaceable; initial-mapping one-shot guard --------------------------------

test("agent review replaces one engine-mapped target, retains others, and the one-shot guard still fires on a second review", async () => {
  const { deps } = harness();
  const { rows, facts } = vocabMappableRows(); // revenue.total + cost_of_revenue mapped by the engine
  seedIngestion(deps, "ing-5", "model-5", "TEST", buildPrepared(rows, facts));
  const { result: created } = await createModel(deps, "ing-5");
  assert.equal(created.error, undefined);
  const revisionAfterImport = created.generation_context!.data["revision"] as number;

  const service = new FinancialModelService(deps.modelStore, "s1");
  const beforeReview = deps.modelStore.getRevision("model-5")!.snapshot;
  const enginePlansBefore = beforeReview.statementMappingPlans.filter((plan) => plan.reviewDecisionId.startsWith(AUTO_PREMAP_PLAN_PREFIX));
  assert.deepEqual(enginePlansBefore.map((plan) => plan.targetLineItemId).sort(), ["cost_of_revenue", "net_income", "revenue.total"]);

  // Agent restates revenue.total only; this is the FIRST agent-authored review, so the one-shot guard
  // must permit it even though engine plans already exist.
  const agentPlan = {
    targetLineItemId: "revenue.total",
    periodIds: HISTORICAL_PERIOD_IDS,
    members: [{ sourceLineItemId: "source.income_statement.revenue", treatment: "add" as const }],
    reviewDecisionId: "agent-review-1",
  };
  const firstReview = service.reviewFacts("model-5", revisionAfterImport, {
    decisions: [], selectedHistoricalPeriodIds: HISTORICAL_PERIOD_IDS, categoryLineItems: [],
    statementMappingPlans: [agentPlan], categoryGroups: [],
  });
  assert.ok(firstReview.revision > revisionAfterImport);

  const afterFirst = deps.modelStore.getRevision("model-5")!.snapshot;
  const plansAfterFirst = afterFirst.statementMappingPlans;
  const enginePlansAfter = plansAfterFirst.filter((plan) => plan.reviewDecisionId.startsWith(AUTO_PREMAP_PLAN_PREFIX));
  const agentPlansAfter = plansAfterFirst.filter((plan) => !plan.reviewDecisionId.startsWith(AUTO_PREMAP_PLAN_PREFIX));
  // The engine plan for revenue.total was dropped; the other engine plans are retained.
  assert.deepEqual(enginePlansAfter.map((plan) => plan.targetLineItemId).sort(), ["cost_of_revenue", "net_income"]);
  assert.deepEqual(agentPlansAfter.map((plan) => plan.targetLineItemId), ["revenue.total"]);

  // A SECOND agent-authored review is now rejected: the initial-mapping window is closed.
  const secondPlan = {
    targetLineItemId: "cost_of_revenue",
    periodIds: HISTORICAL_PERIOD_IDS,
    members: [{ sourceLineItemId: "source.income_statement.cost_of_revenue", treatment: "add" as const }],
    reviewDecisionId: "agent-review-2",
  };
  assert.throws(() => service.reviewFacts("model-5", firstReview.revision, {
    decisions: [], selectedHistoricalPeriodIds: HISTORICAL_PERIOD_IDS, categoryLineItems: [],
    statementMappingPlans: [secondPlan], categoryGroups: [],
  }), /initial statement mappings are already committed/);
});
