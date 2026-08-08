import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cellKey } from "../dsl/graph.ts";
import { FinancialModelError } from "../errors.ts";
import type { FinancialModelSnapshot, ModelOperation } from "../operations.ts";
import {
  FinancialModelService,
  type CreateModelInput,
  type RevisionChangeSummary,
  type ReviewFactsInput,
} from "../service.ts";
import { financialModelSnapshotCodec } from "../snapshotCodec.ts";
import { InMemoryModelStore, SqliteModelStore } from "../store.ts";
import type { Fact, FactReviewDecision, Period } from "../types.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
  { id: "FY2027", label: "FY2027", start: "2027-01-01", end: "2027-12-31", cls: "forecast" },
];

const CREATE_INPUT: CreateModelInput = {
  modelId: "model-1",
  ownerAgentId: "agent-1",
  originSessionId: "session-1",
  symbol: "TEST",
  metadata: { companyName: "Synthetic Company" },
  reportingCurrency: "USD",
  periods: PERIODS,
  preparedStatementRows: [
    {
      sourceLineItemId: "source.income_statement.revenue",
      statement: "income_statement",
      label: "Revenue",
      unit: { kind: "currency", code: "USD" },
      order: 1,
    },
  ],
};

type TestStore = InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>;

function setup(input: CreateModelInput = CREATE_INPUT): {
  store: TestStore;
  service: FinancialModelService;
} {
  const store = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(
    financialModelSnapshotCodec,
  );
  return { store, service: new FinancialModelService(store, "test-session") };
}

function stagedRevenue(periodId: string, value: number): Fact {
  return {
    factId: `revenue-${periodId}`,
    status: "staged",
    lineItemId: "source.income_statement.revenue",
    periodId,
    value,
    unit: { kind: "currency", code: "USD" },
    provenance: {
      sourceType: "filing",
      sourceRefs: [`filing:${periodId}`],
      asOfDate: "2026-08-04",
    },
  };
}

function commitDecision(fact: Fact): FactReviewDecision {
  return {
    decisionId: `commit-${fact.factId}`,
    factId: fact.factId,
    action: "commit",
    mappedLineItemId: "source.income_statement.revenue",
    rationale: "Reviewed against the income statement",
    reviewedBy: "agent-1",
    reviewedAt: "2026-08-04T12:00:00.000Z",
  };
}

function reviewInput(facts: readonly Fact[]): ReviewFactsInput {
  return {
    decisions: facts.map(commitDecision),
    selectedHistoricalPeriodIds: ["FY2024", "FY2025"],
    categoryLineItems: [],
    statementMappingPlans: [{
      targetLineItemId: "revenue.total",
      periodIds: ["FY2024", "FY2025"],
      members: [{
        sourceLineItemId: "source.income_statement.revenue",
        treatment: "add",
      }],
      reviewDecisionId: "statement-map-revenue",
    }],
    categoryGroups: [],
  };
}

function current(store: TestStore): FinancialModelSnapshot {
  const snapshot = store.getRevision("model-1")?.snapshot;
  assert.ok(snapshot);
  return snapshot;
}

function invalidCode(code: FinancialModelError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof FinancialModelError && error.code === code;
}

test("createModel writes revision zero with the fixed skeleton and default metrics", () => {
  const { store, service } = setup();
  const result = service.createModel(CREATE_INPUT);
  assert.equal(result.revision, 0);
  assert.equal(result.status, "draft");
  const snapshot = current(store);
  assert.ok(snapshot.lineItems.some((item) => item.id === "fcff" && item.role === "fcff"));
  assert.ok(snapshot.lineItems.some((item) => item.id === "metric.roa"));
  assert.ok(snapshot.formulas.some((formula) => formula.lineItemId === "metric.roa"));
  assert.equal(snapshot.compiledFormulas.length, snapshot.formulas.length);
  assert.equal(snapshot.engineVersion.length > 0, true);
  assert.equal(snapshot.cells.size > 0, true);
  assert.equal(result.currentWorkbook.mode, "statement_mapping");
  assert.equal(
    result.currentWorkbook.sourceStatementReview.sheets.income_statement[0]
      ?.sourceLineItemId,
    "source.income_statement.revenue",
  );
  const revenueRow = result.currentWorkbook.sections.revenue.find(
    (row) => row.lineItemId === "revenue.total",
  )!;
  assert.deepEqual(Object.keys(revenueRow.cells), PERIODS.map((period) => period.id));
});

test("createModel commits a deterministic value-free model-created summary", () => {
  const { store, service } = setup();
  const result = service.createModel(CREATE_INPUT);
  assert.deepEqual(result.revisionSummary.changes, [{ kind: "model_created" }]);
  assert.equal(result.revisionSummary.revision, 0);
  assert.deepEqual(store.listRevisionHeaders("model-1")[0]?.changeSummary.changes, [
    { kind: "model_created" },
  ]);
  const json = JSON.stringify(result.revisionSummary);
  for (const forbidden of ["formulaSource", "provenance", "rationale", "generatedProse"]) {
    assert.equal(json.includes(forbidden), false);
  }
});

test("staging facts creates one full revision but does not make candidates active", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [stagedRevenue("FY2025", 110), stagedRevenue("FY2024", 100)];
  const result = service.stageFacts("model-1", 0, facts);
  assert.equal(result.revision, 1);
  assert.deepEqual(result.revisionSummary.changes, [{
    kind: "facts_staged",
    candidateCount: 2,
    mappedLineItemIds: ["source.income_statement.revenue"],
    periodIds: ["FY2024", "FY2025"],
  }]);
  const snapshot = current(store);
  assert.deepEqual(snapshot.facts.map((fact) => fact.status), ["staged", "staged"]);
  assert.equal(snapshot.cells.get(cellKey("source.income_statement.revenue", "FY2025"))?.value, null);
});

test("prepared statements are atomically imported after a value-free revision zero", () => {
  const { store, service } = setup({ ...CREATE_INPUT, preparedStatementRows: [] });
  const created = service.createModel({ ...CREATE_INPUT, preparedStatementRows: [] });
  assert.equal(created.revision, 0);
  assert.equal(current(store).lineItems.some((item) => item.section.startsWith("source_")), false);

  const facts = [stagedRevenue("FY2024", 100), stagedRevenue("FY2025", 110)];
  const imported = service.stagePreparedStatements(
    "model-1",
    0,
    CREATE_INPUT.preparedStatementRows,
    facts,
  );

  assert.equal(imported.revision, 1);
  assert.deepEqual(imported.revisionSummary.changes, [{
    kind: "statements_staged",
    rowCount: 1,
    candidateCount: 2,
    mappedLineItemIds: ["source.income_statement.revenue"],
    periodIds: ["FY2024", "FY2025"],
  }]);
  assert.ok(current(store).lineItems.some((item) => item.id === "source.income_statement.revenue"));
  assert.deepEqual(current(store).facts.map((fact) => fact.status), ["staged", "staged"]);
  assert.deepEqual(store.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);

  assert.throws(
    () => service.stagePreparedStatements("model-1", 1, CREATE_INPUT.preparedStatementRows, facts),
    invalidCode("invalid_model_operation"),
  );
});

test("prepared statement import rejects candidates outside its rows or model periods", () => {
  const { service } = setup({ ...CREATE_INPUT, preparedStatementRows: [] });
  service.createModel({ ...CREATE_INPUT, preparedStatementRows: [] });
  assert.throws(
    () => service.stagePreparedStatements("model-1", 0, CREATE_INPUT.preparedStatementRows, [{
      ...stagedRevenue("FY2024", 100),
      lineItemId: "revenue.total",
    }]),
    invalidCode("invalid_model_operation"),
  );
  assert.throws(
    () => service.stagePreparedStatements("model-1", 0, CREATE_INPUT.preparedStatementRows, [
      stagedRevenue("FY1900", 100),
    ]),
    invalidCode("invalid_model_operation"),
  );
});

test("reviewing facts resolves active history, maps it once, and recalculates metrics", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [stagedRevenue("FY2024", 100), stagedRevenue("FY2025", 110)];
  service.stageFacts("model-1", 0, facts);
  const result = service.reviewFacts("model-1", 1, reviewInput(facts));
  assert.equal(result.revision, 2);
  const snapshot = current(store);
  assert.deepEqual(snapshot.facts.map((fact) => fact.status), ["committed", "committed"]);
  assert.equal(snapshot.cells.get(cellKey("revenue.total", "FY2024"))?.value, 100);
  assert.equal(snapshot.cells.get(cellKey("revenue.total", "FY2025"))?.value, 110);
  assert.equal(snapshot.cells.get(cellKey("growth.revenue.total", "FY2025"))?.value, 0.1);
  assert.equal(snapshot.statementMappingPlans.length, 1);
  assert.ok(snapshot.lineItems.some((item) => item.id.startsWith("source.income_statement.")));
  const summaryJson = JSON.stringify(result.revisionSummary);
  assert.equal(summaryJson.includes("Reviewed against"), false);
  assert.equal(summaryJson.includes("filing:"), false);
  assert.equal(summaryJson.includes("100"), false);
  assert.equal(result.currentWorkbook.mode, "dcf");
  assert.equal("sourceStatementReview" in result.currentWorkbook, false);
});

test("initial review atomically creates Agent categories, maps their DCF members, and reconciles them", () => {
  const input: CreateModelInput = {
    ...CREATE_INPUT,
    preparedStatementRows: [
      ...CREATE_INPUT.preparedStatementRows,
      { sourceLineItemId: "source.income_statement.product_a", statement: "income_statement", label: "Product A", unit: { kind: "currency", code: "USD" }, order: 2 },
      { sourceLineItemId: "source.income_statement.product_b", statement: "income_statement", label: "Product B", unit: { kind: "currency", code: "USD" }, order: 3 },
    ],
  };
  const { store, service } = setup(input);
  service.createModel(input);
  const values = new Map([
    ["source.income_statement.revenue", [100, 110]],
    ["source.income_statement.product_a", [60, 65]],
    ["source.income_statement.product_b", [40, 45]],
  ]);
  const facts = [...values].flatMap(([lineItemId, amounts]) =>
    ["FY2024", "FY2025"].map((periodId, index): Fact => ({
      factId: `${lineItemId}@${periodId}`,
      status: "staged",
      lineItemId,
      periodId,
      value: amounts[index]!,
      unit: { kind: "currency", code: "USD" },
      provenance: { sourceType: "filing", sourceRefs: ["10-k"], asOfDate: "2026-08-04" },
    })));
  service.stageFacts("model-1", 0, facts);
  const plan = (targetLineItemId: string, sourceLineItemId: string) => ({
    targetLineItemId,
    periodIds: ["FY2024", "FY2025"],
    members: [{ sourceLineItemId, treatment: "add" as const }],
    reviewDecisionId: `map:${targetLineItemId}`,
  });
  const reviewed = service.reviewFacts("model-1", 1, {
    decisions: facts.map((fact) => ({ ...commitDecision(fact), mappedLineItemId: fact.lineItemId! })),
    selectedHistoricalPeriodIds: ["FY2024", "FY2025"],
    categoryLineItems: [
      { id: "product_a", label: "Product A", parentLineItemId: "revenue" },
      { id: "product_b", label: "Product B", parentLineItemId: "revenue" },
    ],
    statementMappingPlans: [
      plan("revenue.total", "source.income_statement.revenue"),
      plan("revenue.product_a", "source.income_statement.product_a"),
      plan("revenue.product_b", "source.income_statement.product_b"),
    ],
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "管理层产品口径",
      periodIds: ["FY2024", "FY2025"],
      members: [
        { lineItemId: "revenue.product_a", treatment: "add" },
        { lineItemId: "revenue.product_b", treatment: "add" },
      ],
      reviewDecisionId: "review:product-category",
    }],
  });

  assert.equal(reviewed.revision, 2);
  assert.equal(reviewed.currentWorkbook.mode, "dcf");
  const snapshot = current(store);
  assert.deepEqual(snapshot.categoryGroups.map((group) => group.category), ["管理层产品口径"]);
  assert.deepEqual(
    snapshot.reconciliationResults
      .filter((result) => result.kind === "category")
      .map((result) => result.status),
    ["passed", "passed"],
  );
  assert.equal(snapshot.mappingException, null);
  assert.deepEqual(store.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1, 2]);
});

test("a failed required DCF category reconciliation reopens source context and blocks history", () => {
  const input: CreateModelInput = {
    ...CREATE_INPUT,
    preparedStatementRows: [
      ...CREATE_INPUT.preparedStatementRows,
      { sourceLineItemId: "source.income_statement.operating_income", statement: "income_statement", label: "Operating income", unit: { kind: "currency", code: "USD" }, order: 2 },
    ],
  };
  const { store, service } = setup(input);
  service.createModel(input);
  const facts = [
    stagedRevenue("FY2024", 100),
    stagedRevenue("FY2025", 110),
    ...[20, 22].map((value, index): Fact => ({
      factId: `operating-income-${index}`,
      status: "staged",
      lineItemId: "source.income_statement.operating_income",
      periodId: ["FY2024", "FY2025"][index]!,
      value,
      unit: { kind: "currency", code: "USD" },
      provenance: { sourceType: "filing", sourceRefs: ["10-k"], asOfDate: "2026-08-04" },
    })),
  ];
  service.stageFacts("model-1", 0, facts);
  service.reviewFacts("model-1", 1, {
    decisions: facts.map((fact) => ({ ...commitDecision(fact), mappedLineItemId: fact.lineItemId! })),
    selectedHistoricalPeriodIds: ["FY2024", "FY2025"],
    categoryLineItems: [],
    statementMappingPlans: [
      ...reviewInput(facts.slice(0, 2)).statementMappingPlans,
      {
        targetLineItemId: "operating_income",
        periodIds: ["FY2024", "FY2025"],
        members: [{ sourceLineItemId: "source.income_statement.operating_income", treatment: "add" }],
        reviewDecisionId: "map:operating-income",
      },
    ],
    categoryGroups: [{
      parentLineItemId: "operating_income",
      category: "不完整口径",
      periodIds: ["FY2024", "FY2025"],
      members: [{ lineItemId: "revenue.total", treatment: "add" }],
      reviewDecisionId: "review:failed-category",
    }],
  });
  const snapshot = current(store);
  assert.ok(snapshot.reconciliationResults.some((result) =>
    result.kind === "category" && result.status === "failed"));
  assert.equal(snapshot.mappingException?.reason, "reconciliation");
  assert.throws(
    () => service.applyOperations("model-1", 2, [
      { kind: "advance_stage", stage: "history_committed" },
    ]),
    invalidCode("unresolved_reconciliation"),
  );
  assert.equal(store.getRevision("model-1")?.revision, 2);
});

test("readCells and targeted getModel reads are workbook slices and never commit", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [stagedRevenue("FY2024", 100), stagedRevenue("FY2025", 110)];
  service.stageFacts("model-1", 0, facts);
  service.reviewFacts("model-1", 1, reviewInput(facts));
  const before = store.getRevision("model-1")!.revision;

  const exact = service.readCells("model-1", {
    kind: "read_cells",
    revision: 2,
    selector: {
      cellRefs: [{ lineItemId: "revenue.total", periodId: "FY2025" }],
    },
  });
  assert.equal(exact.revision, 2);
  assert.deepEqual(exact.periods.map((period) => period.id), ["FY2025"]);
  assert.equal(exact.rows.length, 1);
  const exactRow = exact.rows[0]!;
  assert.ok("lineItemId" in exactRow);
  assert.deepEqual(Object.keys(exactRow.cells), ["FY2025"]);

  const oldMetrics = service.getModel("model-1", {
    revision: 0,
    section: "metrics",
  });
  assert.ok("rows" in oldMetrics);
  assert.equal(oldMetrics.revision, 0);
  assert.ok(oldMetrics.rows.every((row) => "section" in row && row.section === "metrics"));

  const sourceAudit = service.getModel("model-1", {
    section: "source_income_statement",
    includeLineage: true,
  });
  assert.ok("rows" in sourceAudit);
  assert.equal(sourceAudit.rows.length, 1);
  assert.ok(sourceAudit.lineage);
  assert.equal(store.getRevision("model-1")!.revision, before);
});

test("default getModel returns prior summaries and exactly one complete latest workbook", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [stagedRevenue("FY2024", 100), stagedRevenue("FY2025", 110)];
  service.stageFacts("model-1", 0, facts);
  service.reviewFacts("model-1", 1, reviewInput(facts));
  const before = store.getRevision("model-1")!.revision;

  const context = service.getModel("model-1");
  assert.ok("currentWorkbook" in context);
  assert.equal(context.currentWorkbook.revision, 2);
  assert.deepEqual(context.revisionHistory.map((summary) => summary.revision), [0, 1]);
  assert.deepEqual(context.revisionHistory[0]?.changes, [{ kind: "model_created" }]);
  assert.equal(context.currentWorkbook.mode, "dcf");
  assert.equal(store.getRevision("model-1")!.revision, before);
});

test("one ordered operation batch commits exactly one revision and fully recalculates", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const operations: ModelOperation[] = [
    {
      kind: "set_assumption",
      assumption: {
        assumptionId: "growth-path",
        lineItemId: "growth.revenue.total",
        periods: ["FY2026", "FY2027"],
        payload: { kind: "values", values: [0.1, 0.05], unit: { kind: "percent" } },
        sourceType: "user",
        sourceRefs: ["test"],
        asOfDate: "2026-08-04",
        rationale: "Forecast path",
      },
    },
    {
      kind: "set_assumption",
      assumption: {
        assumptionId: "wacc-path",
        lineItemId: "wacc",
        periods: ["FY2026", "FY2027"],
        payload: { kind: "values", values: [0.1, 0.09], unit: { kind: "percent" } },
        sourceType: "user",
        sourceRefs: ["test"],
        asOfDate: "2026-08-04",
        rationale: "Discount path",
      },
    },
  ];
  const result = service.applyOperations("model-1", 0, operations);
  assert.equal(result.revision, 1);
  assert.deepEqual(store.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);
  assert.equal(current(store).assumptions.length, 2);
});

test("empty batches, compile failures, gate blockers, and conflicts write nothing", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const before = financialModelSnapshotCodec.encode(current(store));
  assert.throws(
    () => service.applyOperations("model-1", 0, []),
    invalidCode("invalid_model_operation"),
  );
  assert.throws(
    () => service.stageFacts("model-1", 0, []),
    invalidCode("invalid_model_operation"),
  );
  assert.throws(
    () => service.applyOperations("model-1", 0, [{
      kind: "set_formula",
      formula: {
        lineItemId: "operating_income",
        appliesTo: "forecast",
        periodIds: ["FY2026"],
        source: "unknown_metric + 1",
      },
    }]),
    invalidCode("invalid_formula"),
  );
  assert.throws(
    () => service.applyOperations("model-1", 0, [{
      kind: "advance_stage",
      stage: "history_committed",
    }]),
    invalidCode("history_review_required"),
  );
  service.stageFacts("model-1", 0, [stagedRevenue("FY2024", 100)]);
  assert.throws(
    () => service.stageFacts("model-1", 0, [stagedRevenue("FY2025", 110)]),
    (error: unknown) => {
      assert.ok(error instanceof FinancialModelError);
      assert.equal(error.code, "revision_conflict");
      assert.deepEqual(error.details, { currentRevision: 1 });
      return true;
    },
  );
  assert.deepEqual(store.listRevisionHeaders("model-1").map((header) => header.revision), [0, 1]);
  assert.equal(financialModelSnapshotCodec.encode(store.getRevision("model-1", 0)!.snapshot), before);
});

test("stage gates run only on explicit advancement", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [stagedRevenue("FY2024", 100), stagedRevenue("FY2025", 110)];
  service.stageFacts("model-1", 0, facts);
  service.reviewFacts("model-1", 1, reviewInput(facts));
  assert.equal(current(store).lifecycleStage, "draft");
  assert.throws(
    () => service.applyOperations("model-1", 2, [{
      kind: "advance_stage",
      stage: "history_committed",
    }]),
    (error: unknown) => {
      assert.ok(error instanceof FinancialModelError);
      assert.equal(error.code, "history_review_required");
      assert.ok(Array.isArray(error.details?.["missing"]));
      assert.ok(error.details?.["historicalDcfCompleteness"]);
      return true;
    },
  );
  assert.equal(store.getRevision("model-1")?.revision, 2);
  assert.equal(current(store).lifecycleStage, "draft");
});

test("archive creates one immutable archived snapshot and listing derives latest state", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const result = service.archive("model-1", 0);
  assert.equal(result.revision, 1);
  assert.equal(result.status, "archived");
  assert.deepEqual(service.listModels(), []);
  assert.equal(service.listModels({ includeArchived: true })[0]?.lifecycleStage, "archived");
  assert.equal(store.getRevision("model-1", 0)?.lifecycleStage, "draft");
  assert.throws(
    () => service.stageFacts("model-1", 1, [stagedRevenue("FY2024", 100)]),
    invalidCode("invalid_model_operation"),
  );
});

test("the core create, stage, review, and read flow persists through SQLite reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dcf-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "models.sqlite");
  const first = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(
    path,
    financialModelSnapshotCodec,
  );
  const firstService = new FinancialModelService(first, "sqlite-session");
  firstService.createModel(CREATE_INPUT);
  const facts = [stagedRevenue("FY2024", 100), stagedRevenue("FY2025", 110)];
  firstService.stageFacts("model-1", 0, facts);
  firstService.reviewFacts("model-1", 1, reviewInput(facts));
  first.close();

  const second = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(
    path,
    financialModelSnapshotCodec,
  );
  t.after(() => second.close());
  const secondService = new FinancialModelService(second, "sqlite-session");
  const context = secondService.getModel("model-1");
  assert.ok("currentWorkbook" in context);
  assert.equal(context.currentWorkbook.revision, 2);
  assert.equal(context.currentWorkbook.mode, "dcf");
  assert.deepEqual(context.revisionHistory.map((summary) => summary.revision), [0, 1]);
  assert.equal(
    second.getRevision("model-1")?.snapshot.cells.get(cellKey("revenue.total", "FY2025"))?.value,
    110,
  );
});

test("the host stamps reviewedAt, so an agent-supplied timestamp never reaches the ledger", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [stagedRevenue("FY2024", 100), stagedRevenue("FY2025", 110)];
  service.stageFacts("model-1", 0, facts);
  const before = new Date().toISOString();

  const input = reviewInput(facts);
  service.reviewFacts("model-1", 1, {
    ...input,
    decisions: input.decisions.map((decision) => ({ ...decision, reviewedAt: "2019-01-01T00:00:00.000Z" })),
  });

  const after = new Date().toISOString();
  const stamps = current(store).factReviewDecisions.map((decision) => decision.reviewedAt);
  assert.equal(stamps.length, 2);
  for (const stamp of stamps) {
    assert.ok(stamp >= before && stamp <= after, `${stamp} must be stamped by the host, not the agent`);
  }
});

const spineFact = (lineItemId: string, periodId: string, value: number): Fact => ({
  factId: `spine.${lineItemId}.${periodId}`, status: "staged", lineItemId, periodId, value,
  unit: { kind: "currency", code: "USD" },
  provenance: { sourceType: "unified_statements", sourceRefs: [`unified.${lineItemId}.${periodId}`], asOfDate: "2026-08-07" },
});

test("stageSpineFacts stages onto canonical targets and selects the actual periods", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 120)];
  const result = service.stageSpineFacts("model-1", 0, { facts, historicalPeriodIds: ["FY2024", "FY2025"] });
  assert.equal(result.revision, 1);

  const snapshot = store.getRevision("model-1")!.snapshot;
  assert.deepEqual(snapshot.selectedHistoricalPeriodIds, ["FY2024", "FY2025"]);
  // Staged, never committed: the subagent has no authority to accept its own numbers.
  const landed = snapshot.facts.filter((fact) => fact.lineItemId === "revenue.total");
  assert.equal(landed.length, 2);
  assert.ok(landed.every((fact) => fact.status === "staged"), JSON.stringify(landed.map((f) => f.status)));
});

test("a revenue detail row is installed as a revenue stream and carries its label", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  service.stageSpineFacts("model-1", 0, {
    facts: [spineFact("revenue.automotive", "FY2024", 80)],
    labels: { "revenue.automotive": "Automotive revenues" },
    historicalPeriodIds: ["FY2024"],
  });
  const view = service.getModel("model-1");
  assert.ok("currentWorkbook" in view);
  const stream = view.currentWorkbook.sections.revenue.find((row) => row.lineItemId === "revenue.automotive");
  assert.equal(stream?.label, "Automotive revenues");
});

test("a detail row whose parent refuses children costs that row, not the batch", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  // `free_cash_flow` is a computed DCF node, not a safe detail parent.
  const result = service.stageSpineFacts("model-1", 0, {
    facts: [spineFact("free_cash_flow.invented", "FY2024", 5), spineFact("revenue.total", "FY2024", 100)],
    historicalPeriodIds: ["FY2024"],
  });
  const view = service.getModel("model-1");
  assert.ok("currentWorkbook" in view);
  assert.equal(view.currentWorkbook.revision, result.revision);
  assert.ok(!view.currentWorkbook.sections.dcf.some((row) => row.lineItemId === "free_cash_flow.invented"));
});
