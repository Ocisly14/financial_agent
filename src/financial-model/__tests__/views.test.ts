import assert from "node:assert/strict";
import test from "node:test";
import { parseFormula } from "../dsl/parser.ts";
import { evaluate, ENGINE_VERSION } from "../engine.ts";
import { FinancialModelError } from "../errors.ts";
import { installDefaultMetrics } from "../metrics.ts";
import type { FinancialModelSnapshot } from "../operations.ts";
import { addSourceStatementRows, applyStatementMappingPlans, createSkeleton } from "../skeleton.ts";
import type { ModelView, Revision, RevisionHeader } from "../store.ts";
import {
  buildModelContextView, buildWorkbookSlice, buildWorkbookView, type RevisionChangeSummary,
} from "../views.ts";
import type { Period, ValuationConfig } from "../types.ts";

const periods: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" },
];
const valuationConfig: ValuationConfig = {
  anchorPeriodId: "FY2024", discountConvention: "year_end", exitTerminalMetric: "fcff",
  sensitivity: { waccDeltas: [0], terminalGrowthDeltas: [0], exitMultipleDeltas: [0] },
  sourceType: "user", sourceRefs: ["view-test"], asOfDate: "2025-01-01", rationale: "fixture",
};

function snapshot(mapped = false): FinancialModelSnapshot {
  let skeleton = addSourceStatementRows(createSkeleton({ currency: "USD", periods }), [{
    sourceLineItemId: "source.income_statement.revenue", statement: "income_statement",
    label: "Revenue", unit: { kind: "currency", code: "USD" }, order: 1,
  }]);
  const plans = [{
    targetLineItemId: "revenue.total", periodIds: ["FY2024"],
    members: [{ sourceLineItemId: "source.income_statement.revenue", treatment: "add" as const }],
    reviewDecisionId: "mapping-1",
  }];
  if (mapped) skeleton = applyStatementMappingPlans(skeleton, plans);
  skeleton = installDefaultMetrics(skeleton, periods);
  const output = evaluate({ periods, lineItems: skeleton.lineItems, facts: [], assumptions: [],
    formulas: skeleton.formulas, valuationConfig });
  return {
    lifecycleStage: mapped ? "history_committed" : "draft", periods: structuredClone(periods),
    lineItems: skeleton.lineItems, facts: [], factReviewDecisions: [], assumptions: [], formulas: skeleton.formulas,
    compiledFormulas: skeleton.formulas.map((formula) => ({ ...formula, ast: parseFormula(formula.source) })),
    selectedHistoricalPeriodIds: mapped ? ["FY2024"] : [], statementMappingPlans: mapped ? plans : [],
    categoryGroups: [], proposedStatementMappings: [],
    valuationConfig, cells: output.cells, diagnostics: [], mappingDiagnostics: [], reconciliationResults: [], mappingException: null,
    valuation: null, engineVersion: ENGINE_VERSION,
  };
}

function contextFixture(): {
  meta: ModelView;
  headers: RevisionHeader<RevisionChangeSummary>[];
  current: Revision<FinancialModelSnapshot, RevisionChangeSummary>;
} {
  const currentSnapshot = snapshot(true);
  const summary = (kind: "model_created" | "stage_advanced"): RevisionChangeSummary => ({
    changes: kind === "model_created" ? [{ kind }] : [{ kind, from: "draft", to: "history_committed" }],
    changedSections: ["history"], warningCount: 0, blockerCount: 0,
  });
  const headers: RevisionHeader<RevisionChangeSummary>[] = [0, 1].map((revision) => ({
    modelId: "m", revision, parentRevision: revision === 0 ? null : 0,
    lifecycleStage: revision === 0 ? "draft" : "history_committed",
    changeSummary: summary(revision === 0 ? "model_created" : "stage_advanced"), engineVersion: ENGINE_VERSION,
    creatingSessionId: "s", createdAt: `2025-01-0${revision + 1}T00:00:00.000Z`,
  }));
  const meta: ModelView = { modelId: "m", ownerAgentId: "a", originSessionId: "s", symbol: "TEST",
    metadata: {}, currentRevision: 1, lifecycleStage: "history_committed", createdAt: headers[0]!.createdAt,
    updatedAt: headers[1]!.createdAt };
  const current: Revision<FinancialModelSnapshot, RevisionChangeSummary> = {
    ...headers[1]!, snapshot: currentSnapshot,
  };
  return { meta, headers, current };
}

test("mapping mode contains source sheets beside the complete DCF workbook", () => {
  const view = buildWorkbookView("m", 0, snapshot());
  assert.equal(view.mode, "statement_mapping");
  assert.equal(view.sourceStatementReview.sheets.income_statement.length, 1);
  assert.ok(view.sections.revenue.some((row) => row.lineItemId === "revenue.total"));
  const revenue = view.sections.revenue.find((row) => row.lineItemId === "revenue.total")!;
  assert.deepEqual(Object.keys(revenue.cells), ["FY2024", "FY2025"]);
});

test("after history mapping the default workbook is DCF-only with compact mapping refs", () => {
  const view = buildWorkbookView("m", 1, snapshot(true));
  assert.equal(view.mode, "dcf");
  assert.equal("sourceStatementReview" in view, false);
  const revenue = view.sections.revenue.find((row) => row.lineItemId === "revenue.total")!;
  assert.deepEqual(revenue.mappingRefs, [{ periodIds: ["FY2024"], sourceLineItemIds: ["source.income_statement.revenue"] }]);
});

test("not-modeled cells remain distinct from modeled missing inputs", () => {
  const view = buildWorkbookView("m", 0, snapshot());
  const revenueRoot = view.sections.revenue.find((row) => row.lineItemId === "revenue")!;
  const revenueTotal = view.sections.revenue.find((row) => row.lineItemId === "revenue.total")!;
  assert.equal(revenueRoot.cells["FY2024"]?.status, "not_modeled");
  assert.equal(revenueTotal.cells["FY2024"]?.status, "missing_input");
});

test("workbook slices validate selectors, preserve order, and do not mutate snapshots", () => {
  const model = snapshot(true);
  const before = structuredClone(model);
  const view = buildWorkbookSlice("m", 1, model, {
    lineItemIds: ["fcff", "revenue.total", "revenue.total"], periodIds: ["FY2024"],
  });
  assert.deepEqual(view.rows.map((row) => "lineItemId" in row ? row.lineItemId : row.sourceLineItemId), ["revenue.total", "fcff"]);
  assert.deepEqual(model, before);
  assert.throws(() => buildWorkbookSlice("m", 1, model, { lineItemIds: ["typo"] }),
    (error: unknown) => error instanceof FinancialModelError && error.code === "invalid_model_query");
});

test("selectors fully intersect exact cells, row filters, period filters, and preserve coordinate order", () => {
  const model = snapshot(true);
  const exact = buildWorkbookSlice("m", 1, model, {
    cellRefs: [
      { lineItemId: "fcff", periodId: "FY2025" },
      { lineItemId: "revenue.total", periodId: "FY2024" },
      { lineItemId: "revenue.total", periodId: "FY2024" },
    ],
    lineItemIds: ["fcff", "revenue.total", "revenue.total"],
  });
  assert.deepEqual(exact.periods.map((period) => period.id), ["FY2024", "FY2025"]);
  assert.deepEqual(exact.rows.map((row) => "lineItemId" in row ? row.lineItemId : row.sourceLineItemId), ["revenue.total", "fcff"]);
  assert.deepEqual(exact.rows.map((row) => Object.keys(row.cells)), [["FY2024"], ["FY2025"]]);

  const intersected = buildWorkbookSlice("m", 1, model, {
    cellRefs: [
      { lineItemId: "fcff", periodId: "FY2025" },
      { lineItemId: "revenue.total", periodId: "FY2024" },
    ],
    periodIds: ["FY2024"],
    section: "revenue",
    role: "revenue_total",
    parentId: "revenue",
    periodClass: "actual",
  });
  assert.deepEqual(intersected.periods.map((period) => period.id), ["FY2024"]);
  assert.deepEqual(intersected.rows.map((row) => "lineItemId" in row ? row.lineItemId : row.sourceLineItemId), ["revenue.total"]);
  assert.throws(() => buildWorkbookSlice("m", 1, model, { parentId: "missing_parent" }), FinancialModelError);
});

test("active formulas and assumptions appear once at row level while ASTs stay out of the workbook", () => {
  const model = snapshot(true);
  model.assumptions.push({
    assumptionId: "wacc-1", lineItemId: "wacc", periods: ["FY2025"],
    payload: { kind: "values", values: [0.1], unit: { kind: "percent" } },
    sourceType: "user", sourceRefs: ["input"], asOfDate: "2025-01-01", rationale: "Test WACC",
  });
  const view = buildWorkbookView("m", 1, model);
  const revenue = view.sections.revenue.find((row) => row.lineItemId === "revenue.total")!;
  const wacc = view.sections.dcf.find((row) => row.lineItemId === "wacc")!;
  assert.equal(revenue.formulas.filter((formula) => formula.appliesTo === "historical").length, 1);
  assert.deepEqual(wacc.assumptions.map((entry) => entry.assumptionId), ["wacc-1"]);
  const json = JSON.stringify(view);
  assert.equal(json.includes("compiledFormulas"), false);
  assert.equal(json.includes('"ast"'), false);
});

test("cell projection distinguishes divide-by-zero and N/A and retains N/A assumption source", () => {
  const model = snapshot(true);
  model.assumptions.push({
    assumptionId: "bridge-na", lineItemId: "cash_available_for_bridge", periods: ["FY2024"],
    payload: { kind: "not_applicable" }, sourceType: "user", sourceRefs: ["input"],
    asOfDate: "2025-01-01", rationale: "No available cash",
  });
  model.cells.set("cash_available_for_bridge@FY2024", {
    value: null, unit: { kind: "currency", code: "USD" },
    diagnostics: [{ code: "not_applicable", refs: ["cash_available_for_bridge@FY2024"] }],
  });
  model.cells.set("margin.operating@FY2024", {
    value: null, unit: { kind: "percent" },
    diagnostics: [{ code: "divide_by_zero", refs: ["revenue.total@FY2024"] }],
  });
  const view = buildWorkbookView("m", 1, model);
  const bridge = view.sections.dcf.find((row) => row.lineItemId === "cash_available_for_bridge")!;
  const margin = view.sections.operations.find((row) => row.lineItemId === "margin.operating")!;
  assert.equal(bridge.cells.FY2024?.status, "not_applicable");
  assert.deepEqual(bridge.cells.FY2024?.source, { kind: "assumption", assumptionId: "bridge-na" });
  assert.equal(margin.cells.FY2024?.status, "divide_by_zero");
});

test("mapping exceptions reopen only affected source rows and periods", () => {
  const model = snapshot(true);
  model.lineItems.push({
    id: "source.balance_sheet.cash", label: "Cash", role: "none",
    unit: { kind: "currency", code: "USD" }, section: "source_balance_sheet", order: 2,
    historical: "actual", forecast: "none",
  });
  model.mappingException = {
    reason: "restatement",
    sourceLineItemIds: ["source.income_statement.revenue"],
    periodIds: ["FY2024"],
  };
  const view = buildWorkbookView("m", 2, model);
  assert.equal(view.mode, "statement_mapping");
  assert.equal(view.sourceStatementReview.sheets.income_statement.length, 1);
  assert.equal(view.sourceStatementReview.sheets.balance_sheet.length, 0);
  assert.deepEqual(Object.keys(view.sourceStatementReview.sheets.income_statement[0]!.cells), ["FY2024"]);
  assert.deepEqual(view.sourceStatementReview.selectedPeriodIds, ["FY2024"]);
});

test("explicit lineage slices expand only records for selected coordinates", () => {
  const model = snapshot(true);
  model.facts.push(
    {
      factId: "selected", status: "committed", lineItemId: "source.income_statement.revenue",
      periodId: "FY2024", value: 100, unit: { kind: "currency", code: "USD" },
      provenance: { sourceType: "filing", sourceRefs: ["selected"], asOfDate: "2024-12-31" },
    },
    {
      factId: "unselected", status: "committed", lineItemId: "debt",
      periodId: "FY2024", value: 20, unit: { kind: "currency", code: "USD" },
      provenance: { sourceType: "filing", sourceRefs: ["unselected"], asOfDate: "2024-12-31" },
    },
  );
  const view = buildWorkbookSlice("m", 1, model, {
    cellRefs: [{ lineItemId: "source.income_statement.revenue", periodId: "FY2024" }],
  }, true);
  assert.deepEqual(view.lineage?.facts.map((fact) => fact.factId), ["selected"]);
  assert.deepEqual(view.lineage?.statementMappingPlans.map((plan) => plan.targetLineItemId), ["revenue.total"]);
});

test("model context contains prior summaries and exactly one current workbook", () => {
  const { meta, headers, current } = contextFixture();
  const before = structuredClone(current.snapshot);
  const context = buildModelContextView(meta, headers, current);
  assert.deepEqual(context.revisionHistory.map((entry) => entry.revision), [0]);
  assert.equal(context.currentWorkbook.revision, 1);
  assert.deepEqual(current.snapshot, before);
  assert.throws(() => buildModelContextView(meta, [headers[1]!], current), FinancialModelError);
});

test("model context rejects malformed summaries and inconsistent current headers", () => {
  const malformed = contextFixture();
  malformed.headers[0]!.changeSummary = {
    changes: [{ kind: "facts_staged" } as never],
    changedSections: ["history"], warningCount: 0, blockerCount: 0,
  };
  assert.throws(() => buildModelContextView(malformed.meta, malformed.headers, malformed.current), FinancialModelError);

  const inconsistent = contextFixture();
  inconsistent.current.engineVersion = "different";
  assert.throws(() => buildModelContextView(inconsistent.meta, inconsistent.headers, inconsistent.current), FinancialModelError);

  const unordered = contextFixture();
  unordered.headers[0]!.changeSummary.changedSections = ["revenue", "history"];
  assert.throws(() => buildModelContextView(unordered.meta, unordered.headers, unordered.current), FinancialModelError);
});
