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
} from "../service.ts";
import { financialModelSnapshotCodec } from "../snapshotCodec.ts";
import { InMemoryModelStore, SqliteModelStore } from "../store.ts";
import type { Fact, Period } from "../types.ts";
import { buildSpineFromUnified } from "../../infra/xbrl/spineFromUnified.ts";
import type { UnifiedStatementsArtifact } from "../../infra/xbrl/unifiedStatements.ts";
import { recalculateWaccSheet, setWaccInput, type WaccSheetComputedInput } from "../waccSheet.ts";

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

function spineFact(lineItemId: string, periodId: string, value: number): Fact {
  return { factId: `${lineItemId}@${periodId}`, status: "staged", lineItemId, periodId, value,
    unit: { kind: "currency", code: "USD" },
    provenance: { sourceType: "unified_statements", sourceRefs: [`unified.${lineItemId}.${periodId}`], asOfDate: "2026-08-07" } };
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

test("a failed required DCF category reconciliation keeps the model reading as draft", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  service.commitSpineFacts("model-1", 0, { facts: [
    spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 110),
    spineFact("operating_income", "FY2024", 20), spineFact("operating_income", "FY2025", 22),
  ], historicalPeriodIds: ["FY2024", "FY2025"] });
  // A category asserting operating_income is fully explained by revenue.total is numerically false
  // (100 != 20): the required reconciliation fails and the derived stage stays draft.
  service.applyOperations("model-1", 1, [{ kind: "set_category_group", group: {
    parentLineItemId: "operating_income", category: "不完整口径", periodIds: ["FY2024", "FY2025"],
    members: [{ lineItemId: "revenue.total", treatment: "add" }], reviewDecisionId: "review:failed-category",
  } }]);
  const snapshot = current(store);
  assert.ok(snapshot.reconciliationResults.some((result) =>
    result.kind === "category" && result.status === "failed"));
  // Lifecycle is derived: unresolved reconciliation keeps the model reading as draft.
  assert.equal(snapshot.lifecycleStage, "draft");
  assert.equal(store.getRevision("model-1")?.revision, 2);
});

test("readCells and targeted getModel reads are workbook slices and never commit", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  service.commitSpineFacts("model-1", 0, { facts: [
    spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 110),
  ], historicalPeriodIds: ["FY2024", "FY2025"] });
  const before = store.getRevision("model-1")!.revision;

  const exact = service.readCells("model-1", {
    kind: "read_cells",
    revision: 1,
    selector: {
      cellRefs: [{ lineItemId: "revenue.total", periodId: "FY2025" }],
    },
  });
  assert.equal(exact.revision, 1);
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
  service.commitSpineFacts("model-1", 0, { facts: [
    spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 110),
  ], historicalPeriodIds: ["FY2024", "FY2025"] });
  const before = store.getRevision("model-1")!.revision;

  const context = service.getModel("model-1");
  assert.ok("currentWorkbook" in context);
  assert.equal(context.currentWorkbook.revision, 1);
  assert.deepEqual(context.revisionHistory.map((summary) => summary.revision), [0]);
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
        assumptionId: "margin-path",
        lineItemId: "margin.operating",
        periods: ["FY2026", "FY2027"],
        payload: { kind: "values", values: [0.1, 0.09], unit: { kind: "percent" } },
        sourceType: "user",
        sourceRefs: ["test"],
        asOfDate: "2026-08-04",
        rationale: "Operating margin path",
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
  service.commitSpineFacts("model-1", 0, { facts: [spineFact("revenue.total", "FY2024", 100)], historicalPeriodIds: ["FY2024"] });
  assert.throws(
    () => service.commitSpineFacts("model-1", 0, { facts: [spineFact("revenue.total", "FY2025", 110)], historicalPeriodIds: ["FY2024"] }),
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

test("an incomplete history reads as draft; the derived stage never blocks a commit", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  service.commitSpineFacts("model-1", 0, { facts: [
    spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 110),
  ], historicalPeriodIds: ["FY2024", "FY2025"] });
  // The thin fixture cannot satisfy the history completeness reading, so the model simply stays
  // draft — but the commit itself landed fine: stages are readings of fact, not gates.
  assert.equal(store.getRevision("model-1")?.revision, 1);
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
    () => service.commitSpineFacts("model-1", 1, { facts: [spineFact("revenue.total", "FY2024", 100)], historicalPeriodIds: ["FY2024"] }),
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
  firstService.commitSpineFacts("model-1", 0, { facts: [
    spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 110),
  ], historicalPeriodIds: ["FY2024", "FY2025"] });
  first.close();

  const second = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(
    path,
    financialModelSnapshotCodec,
  );
  t.after(() => second.close());
  const secondService = new FinancialModelService(second, "sqlite-session");
  const context = secondService.getModel("model-1");
  assert.ok("currentWorkbook" in context);
  assert.equal(context.currentWorkbook.revision, 1);
  assert.equal(context.currentWorkbook.mode, "dcf");
  assert.deepEqual(context.revisionHistory.map((summary) => summary.revision), [0]);
  assert.equal(
    second.getRevision("model-1")?.snapshot.cells.get(cellKey("revenue.total", "FY2025"))?.value,
    110,
  );
});

test("commitSpineFacts commits onto canonical targets and selects the actual periods", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 120)];
  const result = service.commitSpineFacts("model-1", 0, { facts, historicalPeriodIds: ["FY2024", "FY2025"] });
  assert.equal(result.revision, 1);

  const snapshot = store.getRevision("model-1")!.snapshot;
  assert.deepEqual(snapshot.selectedHistoricalPeriodIds, ["FY2024", "FY2025"]);
  // Committed directly — no staged intermediate: the pipeline validated upstream, reconciliation
  // re-validates on this commit, and the revision chain is the audit record.
  const landed = snapshot.facts.filter((fact) => fact.lineItemId === "revenue.total");
  assert.equal(landed.length, 2);
  assert.ok(landed.every((fact) => fact.status === "committed"), JSON.stringify(landed.map((f) => f.status)));
});

test("a revenue detail row is installed as a revenue stream and carries its label", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  service.commitSpineFacts("model-1", 0, {
    facts: [spineFact("revenue.automotive", "FY2024", 80)],
    labels: { "revenue.automotive": "Automotive revenues" },
    historicalPeriodIds: ["FY2024"],
  });
  const view = service.getModel("model-1");
  assert.ok("currentWorkbook" in view);
  const stream = view.currentWorkbook.sections.revenue.find((row) => row.lineItemId === "revenue.automotive");
  assert.equal(stream?.label, "Automotive revenues");
});

test("committed spine facts are history evidence without legacy statement-mapping plans", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const facts = [spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 110)];
  service.commitSpineFacts("model-1", 0, { facts, historicalPeriodIds: ["FY2024", "FY2025"] });
  // One commit is the whole story now: facts land committed with their unified_statements provenance,
  // which is exactly the evidence the derived history reading looks for — no plans, no review step.
  const snapshot = current(store);
  assert.ok(snapshot.facts.some((fact) => fact.status === "committed"
    && fact.provenance.sourceType === "unified_statements"));
});

test("the history commit installs the working-capital identity over exactly the mapped components", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  // AR, inventory, AP mapped; the other four WC components are declared gaps for this issuer —
  // they must drop out of the identity, not null-poison it.
  const facts = [
    spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 110),
    spineFact("accounts_receivable", "FY2024", 30), spineFact("accounts_receivable", "FY2025", 33),
    spineFact("inventory", "FY2024", 10), spineFact("inventory", "FY2025", 11),
    spineFact("accounts_payable", "FY2024", 20), spineFact("accounts_payable", "FY2025", 22),
  ];
  const reviewed = service.commitSpineFacts("model-1", 0, { facts, historicalPeriodIds: ["FY2024", "FY2025"] });
  const formula = store.getRevision("model-1")!.snapshot.formulas
    .find((f) => f.lineItemId === "operating_working_capital" && f.appliesTo === "historical");
  assert.equal(formula?.source, "accounts_receivable + inventory - accounts_payable");
  const operations = reviewed.currentWorkbook.sections.operations;
  assert.equal(operations.find((r) => r.lineItemId === "operating_working_capital")!.cells["FY2025"]!.value, 33 + 11 - 22);
  assert.equal(operations.find((r) => r.lineItemId === "ratio.operating_nwc_to_revenue")!.cells["FY2025"]!.value, (33 + 11 - 22) / 110);
});

test("a nested stream batch installs the child under its parent stream, whatever the input order", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  // Child listed before its parent: staging must still create revenue.product first.
  service.commitSpineFacts("model-1", 0, {
    facts: [spineFact("revenue.product.iphone", "FY2024", 60), spineFact("revenue.product", "FY2024", 100)],
    labels: { "revenue.product": "Product", "revenue.product.iphone": "iPhone" },
    historicalPeriodIds: ["FY2024"],
  });
  const view = service.getModel("model-1");
  assert.ok("currentWorkbook" in view);
  const revenue = view.currentWorkbook.sections.revenue;
  const stream = revenue.find((row) => row.lineItemId === "revenue.product");
  const child = revenue.find((row) => row.lineItemId === "revenue.product.iphone");
  assert.equal(stream?.label, "Product");
  assert.equal(child?.label, "iPhone");
  assert.equal(child?.parentId, "revenue.product");
});

test("a detail row whose parent refuses children costs that row, not the batch", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  // `free_cash_flow` is a computed DCF node, not a safe detail parent.
  const result = service.commitSpineFacts("model-1", 0, {
    facts: [spineFact("free_cash_flow.invented", "FY2024", 5), spineFact("revenue.total", "FY2024", 100)],
    historicalPeriodIds: ["FY2024"],
  });
  const view = service.getModel("model-1");
  assert.ok("currentWorkbook" in view);
  assert.equal(view.currentWorkbook.revision, result.revision);
  assert.ok(!view.currentWorkbook.sections.dcf.some((row) => row.lineItemId === "free_cash_flow.invented"));
});

// Regression for a Critical finding: a breakdown-derived fact from buildSpineFromUnified must carry a
// non-empty provenance.asOfDate, or snapshotCodec.normalizeProvenance rejects it and commitSpineFacts
// throws for the whole batch — not just the offending detail row.
test("a breakdown detail row's fact stages cleanly end to end through buildSpineFromUnified", () => {
  const netSalesFact: Fact = { factId: "unified.income_statement.net_sales.FY2024", status: "staged",
    lineItemId: "unified.income_statement.net_sales", periodId: "FY2024", value: 90,
    unit: { kind: "currency", code: "USD" },
    provenance: { sourceType: "filing", sourceRefs: [], asOfDate: "2026-01-30" } };
  const unified: UnifiedStatementsArtifact = {
    periods: ["FY2024"], rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales",
      rationale: "", values: { FY2024: 90 } }],
    supplementalRows: [], excluded: [], facts: [netSalesFact], restatements: [], rollupBreaks: [],
    findings: [], unresolvedFindings: [],
    breakdownRows: [{ rowId: "net_sales.seg.products", parentRowId: "net_sales", axisQName: "seg",
      memberQName: "x:ProductsMember", label: "Products", unit: { kind: "currency", code: "USD" },
      values: { FY2024: 60 }, rationale: "product mix", asOfDate: "2026-03-15" }],
  };
  const { facts } = buildSpineFromUnified({ decision: {
    mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "r" }],
    detailRows: [{ parentTargetId: "revenue", rowId: "net_sales.seg.products", rationale: "r" }],
    excluded: [], spineGaps: [] }, unified, spineIds: new Set(["revenue.total"]) });
  const detail = facts.find((f) => f.lineItemId === "revenue.products");
  assert.ok(detail);
  assert.equal(detail!.provenance.asOfDate, "2026-03-15");

  const { service } = setup();
  service.createModel(CREATE_INPUT);
  // Must not throw: this is exactly the path snapshotCodec.normalizeProvenance used to reject when
  // the breakdown row's asOfDate fell back to "".
  const result = service.commitSpineFacts("model-1", 0, { facts, historicalPeriodIds: ["FY2024"],
    labels: { "revenue.products": "Products" } });
  const view = service.getModel("model-1");
  assert.ok("currentWorkbook" in view);
  assert.equal(view.currentWorkbook.revision, result.revision);
  const stream = view.currentWorkbook.sections.revenue.find((row) => row.lineItemId === "revenue.products");
  assert.equal(stream?.label, "Products");
});

test("a custom metric row carries its description into the workbook view and survives codec round-trip", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  service.applyOperations("model-1", 0, [
    { kind: "add_line_item", lineItem: { id: "metric.custom.opex_ratio", label: "Opex ratio",
      parentId: "custom_metrics", unit: { kind: "ratio" }, description: "Operating expense intensity" } },
  ]);
  const view = service.getModel("model-1");
  assert.ok("currentWorkbook" in view);
  const row = view.currentWorkbook.sections.metrics.find((r) => r.lineItemId === "metric.custom.opex_ratio");
  assert.equal(row?.description, "Operating expense intensity");
  // codec round-trip: encode → decode 后 description 仍在；老行（无 description）不受影响
  const snapshot = store.getRevision("model-1")!.snapshot;
  const decoded = financialModelSnapshotCodec.decode(financialModelSnapshotCodec.encode(snapshot));
  assert.equal(decoded.lineItems.find((i) => i.id === "metric.custom.opex_ratio")?.description, "Operating expense intensity");
});

test("metric.custom rows accept formulas while registry metrics and fixed drivers stay immutable", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  const result = service.applyOperations("model-1", 0, [
    { kind: "add_line_item", lineItem: { id: "metric.custom.gm", label: "GM", parentId: "custom_metrics", unit: { kind: "ratio" } } },
    { kind: "set_formula", formula: { lineItemId: "metric.custom.gm", appliesTo: "historical",
      source: "revenue.total / revenue.total", periodIds: ["FY2024", "FY2025"] } },
  ]);
  assert.equal(result.revision, 1);
  assert.throws(() => service.applyOperations("model-1", 1, [
    { kind: "set_formula", formula: { lineItemId: "metric.roa", appliesTo: "historical", source: "net_income", periodIds: ["FY2024"] } },
  ]), invalidCode("invalid_model_operation"));
  assert.throws(() => service.applyOperations("model-1", 1, [
    { kind: "set_formula", formula: { lineItemId: "margin.operating", appliesTo: "historical", source: "net_income", periodIds: ["FY2024"] } },
  ]), invalidCode("invalid_model_operation"));
});

test("createModel initializes a 12-row WACC sheet dated today with wacc unresolved", () => {
  const { service } = setup();
  const result = service.createModel(CREATE_INPUT);
  const waccSheet = result.currentWorkbook.waccSheet;
  assert.ok(waccSheet);
  assert.equal(waccSheet.asOfDate, new Date().toISOString().slice(0, 10));
  // Public contract is the 12 rows; the hidden cash_and_equivalents_value row is an
  // implementation detail that must not leak into the workbook view.
  assert.deepEqual(waccSheet.rows.map((row) => row.rowId).sort(), [
    "beta", "cost_of_debt", "cost_of_equity", "d_over_v", "e_over_v", "effective_tax_rate",
    "equity_risk_premium", "equity_value", "net_debt", "risk_free_rate", "total_debt", "wacc",
  ]);
  const wacc = waccSheet.rows.find((row) => row.rowId === "wacc");
  assert.equal(wacc?.value, null);
  assert.ok((wacc?.missingInputs.length ?? 0) > 0);
});

test("the WACC sheet round-trips through the snapshot codec", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const snapshot = store.getRevision("model-1")!.snapshot;
  const decoded = financialModelSnapshotCodec.decode(financialModelSnapshotCodec.encode(snapshot));
  assert.deepEqual(decoded.waccSheet, snapshot.waccSheet);
});

test("decoding a snapshot stored before the WACC sheet existed yields waccSheet: null", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const snapshot = store.getRevision("model-1")!.snapshot;
  const wire = JSON.parse(financialModelSnapshotCodec.encode(snapshot)) as Record<string, unknown>;
  delete wire.waccSheet;
  const decoded = financialModelSnapshotCodec.decode(JSON.stringify(wire));
  assert.equal(decoded.waccSheet, null);
});

test("refreshWaccSheet fills the derivable rows, leaves an agent override alone, and lands one wacc_sheet_refreshed revision", () => {
  const { store, service } = setup();
  const created = service.createModel(CREATE_INPUT);

  // The agent has already overridden cost_of_debt with a current bond yield before any refresh runs —
  // a refresh must never clobber a row the agent authored, even one it could otherwise compute itself.
  const before = store.getRevision("model-1")!;
  const asOfDate = before.snapshot.waccSheet!.asOfDate;
  const withAgentOverride = structuredClone(before.snapshot);
  withAgentOverride.waccSheet = recalculateWaccSheet(setWaccInput(withAgentOverride.waccSheet!, {
    rowId: "cost_of_debt", value: 0.09, sourceType: "search", sourceRefs: ["bond:issue"],
    rationale: "current issue yield", asOfDate,
  }));
  store.commit("model-1", before.revision, {
    lifecycleStage: withAgentOverride.lifecycleStage, snapshot: withAgentOverride,
    changeSummary: { changes: [], changedSections: [], warningCount: 0, blockerCount: 0 },
    engineVersion: "test", creatingSessionId: "test",
  });
  const revisionBeforeRefresh = store.getRevision("model-1")!.revision;

  const provenance = (rationale: string) => ({ sourceType: "computed", sourceRefs: [], asOfDate, rationale });
  const inputs: WaccSheetComputedInput[] = [
    { rowId: "beta", value: 1.2, provenance: provenance("beta") },
    { rowId: "cost_of_debt", value: 0.05, provenance: provenance("should not apply — agent already wrote this row") },
    { rowId: "equity_value", value: 3_000_000_000_000, provenance: provenance("equity value") },
    { rowId: "total_debt", value: 100_000_000_000, provenance: provenance("total debt") },
    { rowId: "effective_tax_rate", value: 0.15, provenance: provenance("tax rate") },
    { rowId: "cash_and_equivalents_value", value: 30_000_000_000, provenance: provenance("cash") },
  ];
  const result = service.refreshWaccSheet("model-1", revisionBeforeRefresh, inputs);

  assert.equal(result.revision, revisionBeforeRefresh + 1);
  const sheet = result.currentWorkbook.waccSheet!;
  assert.equal(sheet.asOfDate, asOfDate); // as-of never moves on refresh
  assert.equal(sheet.rows.find((row) => row.rowId === "beta")?.value, 1.2);
  assert.equal(sheet.rows.find((row) => row.rowId === "equity_value")?.value, 3_000_000_000_000);
  assert.equal(sheet.rows.find((row) => row.rowId === "total_debt")?.value, 100_000_000_000);
  assert.equal(sheet.rows.find((row) => row.rowId === "effective_tax_rate")?.value, 0.15);
  // The agent's cost_of_debt survives untouched — the refresh's own 0.05 for that row was skipped.
  assert.equal(sheet.rows.find((row) => row.rowId === "cost_of_debt")?.value, 0.09);

  const change = result.revisionSummary.changes.find((entry) => entry.kind === "wacc_sheet_refreshed");
  assert.ok(change, "expected exactly one wacc_sheet_refreshed change");
  if (change?.kind === "wacc_sheet_refreshed") {
    assert.deepEqual([...change.rowIds].sort(),
      ["beta", "cash_and_equivalents_value", "effective_tax_rate", "equity_value", "total_debt"].sort());
  }
});

test("refreshWaccSheet is a no-op (no new revision) when every derivable row has already been agent-overridden", () => {
  // Regression for I3: refreshWaccSheet used to throw invalid_model_operation when the filter left
  // nothing to apply — a perfectly legitimate state, not an error — which the tool then surfaced as a
  // misleading "wacc sheet refresh applied no rows" skip reason.
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const before = store.getRevision("model-1")!;
  const asOfDate = before.snapshot.waccSheet!.asOfDate;
  const withAgentOverride = structuredClone(before.snapshot);
  withAgentOverride.waccSheet = recalculateWaccSheet(setWaccInput(withAgentOverride.waccSheet!, {
    rowId: "cost_of_debt", value: 0.09, sourceType: "search", sourceRefs: ["bond:issue"],
    rationale: "current issue yield", asOfDate,
  }));
  store.commit("model-1", before.revision, {
    lifecycleStage: withAgentOverride.lifecycleStage, snapshot: withAgentOverride,
    changeSummary: { changes: [], changedSections: [], warningCount: 0, blockerCount: 0 },
    engineVersion: "test", creatingSessionId: "test",
  });
  const revisionBeforeRefresh = store.getRevision("model-1")!.revision;

  // The only input the derivation could offer is the row the agent already wrote.
  const inputs: WaccSheetComputedInput[] = [
    { rowId: "cost_of_debt", value: 0.05, provenance: { sourceType: "computed", sourceRefs: [], asOfDate, rationale: "should not apply" } },
  ];
  const result = service.refreshWaccSheet("model-1", revisionBeforeRefresh, inputs);
  assert.equal(result.revision, revisionBeforeRefresh, "no new revision should be committed");
  assert.equal(result.currentWorkbook.waccSheet!.rows.find((row) => row.rowId === "cost_of_debt")?.value, 0.09);
  assert.equal(store.listRevisionHeaders("model-1").length, revisionBeforeRefresh + 1,
    "the revision ledger must not have grown");
});

test("refreshWaccSheet is a no-op (no new revision) when the derived values are byte-identical to the sheet's current values", () => {
  // Regression for I3: a refresh whose derived values match the sheet exactly used to still commit a
  // new (no-op) wacc_sheet_refreshed revision on top of the existing one.
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const asOfDate = store.getRevision("model-1")!.snapshot.waccSheet!.asOfDate;
  const inputs: WaccSheetComputedInput[] = [
    { rowId: "beta", value: 1.1, provenance: { sourceType: "computed", sourceRefs: ["bars"], asOfDate, rationale: "beta" } },
    { rowId: "equity_value", value: 200, provenance: { sourceType: "market", sourceRefs: ["bars"], asOfDate, rationale: "equity value" } },
  ];
  const first = service.refreshWaccSheet("model-1", 0, inputs);
  assert.equal(first.revision, 1, "the first refresh with real changes commits a revision");

  const second = service.refreshWaccSheet("model-1", first.revision, inputs);
  assert.equal(second.revision, first.revision, "an identical re-derivation must not commit a new revision");
  assert.equal(store.listRevisionHeaders("model-1").length, 2,
    "the revision ledger must not have grown for the byte-identical refresh");
});

test("refreshWaccSheet recalculates the workbook so the wacc line item's forecast cells track the sheet", () => {
  // Regression for I1: refreshWaccSheet used to commit the sheet without calling recalculate(), so
  // the wacc line item's forecast cells (seeded only inside recalculate() via
  // materializedWaccAssumptions) kept whatever value they had before the refresh — stale or missing —
  // even though the sheet itself had a resolved wacc value.
  const { service } = setup();
  service.createModel(CREATE_INPUT);

  // The agent fills the two terms it supplies directly before any auto-refresh lands the rest — an
  // ordinary ordering — so the wacc row is still unresolved at this point.
  const filled = service.applyOperations("model-1", 0, [
    { kind: "set_wacc_input", input: { rowId: "risk_free_rate", value: 0.04,
      sourceType: "market", sourceRefs: ["treasury"], rationale: "current 10y yield", asOfDate: "2026-01-01" } },
    { kind: "set_wacc_input", input: { rowId: "equity_risk_premium", value: 0.05,
      sourceType: "agent_estimate", sourceRefs: [], rationale: "analyst judgment", asOfDate: "2026-01-01" } },
  ]);

  const inputs: WaccSheetComputedInput[] = [
    { rowId: "beta", value: 1.1, provenance: { sourceType: "computed", sourceRefs: ["bars"], asOfDate: "2026-01-01", rationale: "beta" } },
    { rowId: "cost_of_debt", value: 0.03, provenance: { sourceType: "filing", sourceRefs: ["10-K"], asOfDate: "2026-01-01", rationale: "cost of debt" } },
    { rowId: "equity_value", value: 200, provenance: { sourceType: "market", sourceRefs: ["bars"], asOfDate: "2026-01-01", rationale: "equity value" } },
    { rowId: "total_debt", value: 50, provenance: { sourceType: "filing", sourceRefs: ["10-K"], asOfDate: "2026-01-01", rationale: "total debt" } },
    { rowId: "effective_tax_rate", value: 0.2, provenance: { sourceType: "computed", sourceRefs: ["10-K"], asOfDate: "2026-01-01", rationale: "tax rate" } },
    { rowId: "cash_and_equivalents_value", value: 0, provenance: { sourceType: "filing", sourceRefs: ["10-K"], asOfDate: "2026-01-01", rationale: "cash" } },
  ];
  const refreshed = service.refreshWaccSheet("model-1", filled.revision, inputs);

  const waccRow = refreshed.currentWorkbook.waccSheet!.rows.find((row) => row.rowId === "wacc")!;
  assert.ok(waccRow.value !== null, "the sheet's own wacc value should now be resolved");
  const forecastPeriodId = PERIODS.find((period) => period.cls === "forecast")!.id;
  const waccLineItemRow = refreshed.currentWorkbook.sections.dcf.find((row) => "lineItemId" in row && row.lineItemId === "wacc") as
    { cells: Record<string, { value: number | null }> } | undefined;
  assert.ok(waccLineItemRow, "expected a wacc row in the dcf section");
  assert.equal(waccLineItemRow!.cells[forecastPeriodId]?.value, waccRow.value);
});

test("set_wacc_input chains risk_free_rate and equity_risk_premium into cost_of_equity", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  const asOfDate = service.getModel("model-1");
  assert.ok("currentWorkbook" in asOfDate);
  const sheetAsOfDate = asOfDate.currentWorkbook.waccSheet!.asOfDate;

  const rf = service.applyOperations("model-1", 0, [
    { kind: "set_wacc_input", input: { rowId: "risk_free_rate", value: 0.04,
      sourceType: "market_data", sourceRefs: ["treasury:10y"], rationale: "10y treasury yield",
      asOfDate: sheetAsOfDate } },
  ]);
  const change = rf.revisionSummary.changes.find((entry) => entry.kind === "wacc_input_set");
  assert.ok(change, "expected a wacc_input_set change");
  if (change?.kind === "wacc_input_set") assert.equal(change.rowId, "risk_free_rate");

  const erp = service.applyOperations("model-1", rf.revision, [
    { kind: "set_wacc_input", input: { rowId: "equity_risk_premium", value: 0.05,
      sourceType: "analyst_inference", sourceRefs: ["research:erp"], rationale: "consensus ERP",
      asOfDate: sheetAsOfDate } },
  ]);

  const sheet = erp.currentWorkbook.waccSheet!;
  const beta = sheet.rows.find((row) => row.rowId === "beta");
  const costOfEquity = sheet.rows.find((row) => row.rowId === "cost_of_equity");
  if (beta?.value !== null && beta?.value !== undefined) {
    // cost_of_equity = risk_free_rate + beta * equity_risk_premium, chained once beta is known.
    assert.ok(Math.abs((costOfEquity?.value ?? NaN) - (0.04 + beta.value * 0.05)) < 1e-9);
  } else {
    // beta is not computed yet in a bare createModel snapshot — cost_of_equity stays unresolved,
    // but risk_free_rate and equity_risk_premium themselves must have landed.
    assert.equal(sheet.rows.find((row) => row.rowId === "risk_free_rate")?.value, 0.04);
    assert.equal(sheet.rows.find((row) => row.rowId === "equity_risk_premium")?.value, 0.05);
    assert.ok(costOfEquity?.missingInputs.includes("beta"));
  }
});

test("set_wacc_input with a formula commits cleanly and round-trips through the codec", () => {
  // Regression for C1: the codec's locked_formula<->formulaSource invariant used to reject any row
  // with both source: "agent" and a formulaSource, which is exactly the shape setWaccInput produces
  // when the agent supplies a formula rather than a bare value.
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const sheetAsOfDate = store.getRevision("model-1")!.snapshot.waccSheet!.asOfDate;
  const result = service.applyOperations("model-1", 0, [
    { kind: "set_wacc_input", input: { rowId: "risk_free_rate", formula: "0.02 + 0.02",
      sourceType: "market_data", sourceRefs: ["treasury:10y"], rationale: "sum of two rates",
      asOfDate: sheetAsOfDate } },
  ]);
  const row = result.currentWorkbook.waccSheet!.rows.find((entry) => entry.rowId === "risk_free_rate");
  assert.equal(row?.source, "agent");
  assert.equal(row?.formulaSource, "0.02 + 0.02");
  assert.ok(Math.abs((row?.value ?? NaN) - 0.04) < 1e-9);

  const stored = store.getRevision("model-1", result.revision)!.snapshot;
  const decoded = financialModelSnapshotCodec.decode(financialModelSnapshotCodec.encode(stored));
  assert.deepEqual(decoded.waccSheet, stored.waccSheet);
});

test("set_wacc_input omitting asOfDate defaults it to the sheet's own asOfDate", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const sheetAsOfDate = store.getRevision("model-1")!.snapshot.waccSheet!.asOfDate;
  const result = service.applyOperations("model-1", 0, [
    { kind: "set_wacc_input", input: { rowId: "risk_free_rate", value: 0.04,
      sourceType: "market_data", sourceRefs: ["treasury:10y"], rationale: "10y treasury yield" } },
  ]);
  const row = result.currentWorkbook.waccSheet!.rows.find((r) => r.rowId === "risk_free_rate");
  assert.equal(row?.provenance?.asOfDate, sheetAsOfDate);
});

test("set_wacc_input rejects writes to computed and locked-formula rows", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  assert.throws(() => service.applyOperations("model-1", 0, [
    { kind: "set_wacc_input", input: { rowId: "wacc", value: 0.1,
      sourceType: "user", sourceRefs: ["manual"], rationale: "override", asOfDate: "2026-01-01" } },
  ]), invalidCode("invalid_model_operation"));
  assert.throws(() => service.applyOperations("model-1", 0, [
    { kind: "set_wacc_input", input: { rowId: "e_over_v", value: 0.5,
      sourceType: "user", sourceRefs: ["manual"], rationale: "override", asOfDate: "2026-01-01" } },
  ]), invalidCode("invalid_model_operation"));
});

test("a model with an unresolved wacc row never carries a valuation and reads as its actual stage", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  const revision = store.getRevision("model-1")!;
  assert.equal(revision.lifecycleStage, "draft");
  assert.equal(revision.snapshot.valuation, null);
});

test("filling risk_free_rate and equity_risk_premium resolves the wacc row once the other terms are already computed", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  const inputs: WaccSheetComputedInput[] = [
    { rowId: "beta", value: 1, provenance: { sourceType: "computed", sourceRefs: ["bars"], asOfDate: "2026-01-01", rationale: "beta" } },
    { rowId: "cost_of_debt", value: 0.05, provenance: { sourceType: "filing", sourceRefs: ["10-K"], asOfDate: "2026-01-01", rationale: "cost of debt" } },
    { rowId: "equity_value", value: 100, provenance: { sourceType: "market", sourceRefs: ["bars"], asOfDate: "2026-01-01", rationale: "equity value" } },
    { rowId: "total_debt", value: 0, provenance: { sourceType: "filing", sourceRefs: ["10-K"], asOfDate: "2026-01-01", rationale: "total debt" } },
    { rowId: "effective_tax_rate", value: 0.25, provenance: { sourceType: "computed", sourceRefs: ["10-K"], asOfDate: "2026-01-01", rationale: "tax rate" } },
    { rowId: "cash_and_equivalents_value", value: 0, provenance: { sourceType: "filing", sourceRefs: ["10-K"], asOfDate: "2026-01-01", rationale: "cash" } },
  ];
  const refreshed = service.refreshWaccSheet("model-1", 0, inputs);
  const filled = service.applyOperations("model-1", refreshed.revision, [
    { kind: "set_wacc_input", input: { rowId: "risk_free_rate", value: 0.04,
      sourceType: "market", sourceRefs: ["treasury"], rationale: "current 30y yield", asOfDate: "2026-01-01" } },
    { kind: "set_wacc_input", input: { rowId: "equity_risk_premium", value: 0.06,
      sourceType: "agent_estimate", sourceRefs: [], rationale: "analyst judgment", asOfDate: "2026-01-01" } },
  ]);
  const waccRow = filled.currentWorkbook.waccSheet!.rows.find((row) => row.rowId === "wacc")!;
  assert.equal(waccRow.value, 0.1);
  // wacc resolved, but the model has no committed history or fcff chain, so the derived stage stays
  // draft and no valuation is produced — the wacc sheet alone never makes a model read as valued.
  assert.equal(filled.status, "draft");
  assert.equal(filled.currentWorkbook.valuation ?? null, null);
});
