import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore, type SourceReviewArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import type { BreakdownRow, UnifiedStatementsArtifact } from "../../../src/infra/xbrl/unifiedStatements.ts";
import { InMemoryWaccParameterStore } from "../../../src/financial-model/waccStore.ts";
import { period } from "../../../src/infra/xbrl/__tests__/spineFixture.ts";
import { createWorkbenchTools, expandSlugs, UNIFIED_ROWS_PAGE } from "../workbenchTools.ts";
import type { FinancialModelToolDeps } from "../financialModelTools.ts";
import type { Fact, FactReviewDecision } from "../../../src/financial-model/types.ts";

const PERIODS = [period("FY2024", 2024), period("FY2025", 2025)];
const PROD = "us-gaap:ProductOrServiceAxis";
const REGION = "us-gaap:StatementGeographicalAxis";

function baseBreakdownRows(): BreakdownRow[] {
  return [
    { rowId: "net_sales.prod.product_group", parentRowId: "net_sales", axisQName: PROD,
      memberQName: "us-gaap:ProductMember", label: "Product", unit: { kind: "currency", code: "USD" },
      values: { FY2024: 70, FY2025: 75 }, rationale: "", asOfDate: "2026-01-01" },
    { rowId: "net_sales.prod.services_group", parentRowId: "net_sales", axisQName: PROD,
      memberQName: "us-gaap:ServiceMember", label: "Service", unit: { kind: "currency", code: "USD" },
      values: { FY2024: 30, FY2025: 35 }, rationale: "", asOfDate: "2026-01-01" },
    { rowId: "net_sales.prod.iphone", parentRowId: "net_sales", axisQName: PROD,
      memberQName: "x:iPhoneMember", parentMemberQName: "us-gaap:ProductMember", label: "iPhone",
      unit: { kind: "currency", code: "USD" }, values: { FY2024: 40, FY2025: 42 }, rationale: "", asOfDate: "2026-01-01" },
    { rowId: "net_sales.prod.mac", parentRowId: "net_sales", axisQName: PROD,
      memberQName: "x:MacMember", parentMemberQName: "us-gaap:ProductMember", label: "Mac",
      unit: { kind: "currency", code: "USD" }, values: { FY2024: 30, FY2025: 33 }, rationale: "", asOfDate: "2026-01-01" },
    { rowId: "net_sales.region.us", parentRowId: "net_sales", axisQName: REGION,
      memberQName: "us-gaap:UnitedStatesMember", label: "United States", unit: { kind: "currency", code: "USD" },
      values: { FY2024: 60, FY2025: 65 }, rationale: "", asOfDate: "2026-01-01" },
    { rowId: "net_sales.region.intl", parentRowId: "net_sales", axisQName: REGION,
      memberQName: "us-gaap:InternationalMember", label: "International", unit: { kind: "currency", code: "USD" },
      values: { FY2024: 40, FY2025: 45 }, rationale: "", asOfDate: "2026-01-01" },
  ];
}

function baseUnified(overrides: Partial<UnifiedStatementsArtifact> = {}): UnifiedStatementsArtifact {
  return {
    periods: ["FY2024", "FY2025"],
    rows: [
      { rowId: "net_sales", statement: "income_statement", label: "Net sales", rationale: "",
        values: { FY2024: 100, FY2025: 110 } },
      { rowId: "cost_of_sales", statement: "income_statement", label: "Cost of sales", rationale: "",
        values: { FY2024: -40, FY2025: null } },
      { rowId: "total_assets", statement: "balance_sheet", label: "Total assets", rationale: "",
        values: { FY2024: 500, FY2025: 520 } },
    ],
    supplementalRows: [], excluded: [], facts: [], restatements: [], rollupBreaks: [],
    findings: [], unresolvedFindings: [],
    breakdownRows: baseBreakdownRows(),
    ...overrides,
  };
}

function review(overrides: Partial<SourceReviewArtifact> = {}): SourceReviewArtifact {
  return {
    ingestionRunId: "ing-1", coverage: { requestedPeriodIds: [], statements: [], issues: [] },
    dimensionalDisclosures: [], curatedTables: [], curations: [], filings: [], facts: [],
    statementViews: {
      income_statement: { candidate: { periods: PERIODS, rows: [] }, filingPresentations: [] },
      balance_sheet: { candidate: { periods: PERIODS, rows: [] }, filingPresentations: [] },
      cash_flow_statement: { candidate: { periods: PERIODS, rows: [] }, filingPresentations: [] },
    } as never,
    ...overrides,
  };
}

function setup(): { financial: FinancialModelToolDeps; modelId: string; sourceReviewStore: InMemorySourceReviewStore } {
  const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  const sourceReviewStore = new InMemorySourceReviewStore();
  const service = new FinancialModelService(modelStore, "session-1");
  const modelId = "fm-1";
  service.createModel({ modelId, ownerAgentId: "agent-1", originSessionId: "session-1", symbol: "TEST",
    metadata: {}, reportingCurrency: "USD", periods: PERIODS, preparedStatementRows: [] });
  return { modelId, sourceReviewStore,
    financial: { modelStore, sourceReviewStore, ingestionStore: sourceReviewStore,
      insightStore: new InMemoryFilingInsightStore(), waccParameterStore: new InMemoryWaccParameterStore() } };
}

function tools(financial: FinancialModelToolDeps) {
  const [list, get, calculate] = createWorkbenchTools(financial);
  return { list: list!, get: get!, calculate: calculate! };
}

const ctx = { agentId: "agent-1", sessionId: "s1" };

function spineFact(lineItemId: string, periodId: string, value: number): Fact {
  return { factId: `spine.${lineItemId}.${periodId}`, status: "staged", lineItemId, periodId, value,
    unit: { kind: "currency", code: "USD" },
    provenance: { sourceType: "unified_statements", sourceRefs: [`unified.${lineItemId}.${periodId}`], asOfDate: "2026-08-07" } };
}

/** Stages and commits `revenue.total` actuals for FY2024/FY2025 directly onto the canonical target,
 * so a formula referencing `revenue.total` has an input to compute against. */
function seedRevenueTotal(financial: FinancialModelToolDeps, modelId: string): void {
  const service = new FinancialModelService(financial.modelStore, "session-1");
  const facts = [spineFact("revenue.total", "FY2024", 100), spineFact("revenue.total", "FY2025", 110)];
  service.stageSpineFacts(modelId, 0, { facts, historicalPeriodIds: ["FY2024", "FY2025"] });
  const decisions: FactReviewDecision[] = facts.map((fact) => ({
    decisionId: `commit-${fact.factId}`, factId: fact.factId, action: "commit",
    mappedLineItemId: "revenue.total", rationale: "seed", reviewedBy: "agent-1", reviewedAt: "2026-08-04T12:00:00.000Z",
  }));
  service.reviewFacts(modelId, 1, { decisions, selectedHistoricalPeriodIds: ["FY2024", "FY2025"],
    categoryLineItems: [], statementMappingPlans: [], categoryGroups: [] });
}

test("list returns catalog without values and marks axes with member trees", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { list } = tools(financial);
  const result = await list.execute({ modelId }, ctx);
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data as unknown as {
    periods: string[]; rows: Array<{ rowId: string; label: string; statement: string; periodsCovered: number; values?: unknown }>;
    breakdownAxes: Array<{ axisQName: string; parentRowId: string; memberCount: number; hasMemberTree: boolean; inWorkbook: boolean }>;
  };
  assert.deepEqual(data.periods, ["FY2024", "FY2025"]);
  assert.deepEqual(data.rows.map((r) => r.rowId), ["net_sales", "cost_of_sales", "total_assets"]);
  const netSales = data.rows.find((r) => r.rowId === "net_sales")!;
  assert.equal(netSales.periodsCovered, 2);
  assert.equal(netSales.values, undefined);
  const costOfSales = data.rows.find((r) => r.rowId === "cost_of_sales")!;
  assert.equal(costOfSales.periodsCovered, 1);

  const byAxis = new Map(data.breakdownAxes.map((a) => [a.axisQName, a]));
  const prod = byAxis.get(PROD)!;
  assert.equal(prod.parentRowId, "net_sales");
  assert.equal(prod.memberCount, 4);
  assert.equal(prod.hasMemberTree, true);
  assert.equal(prod.inWorkbook, false);
  const region = byAxis.get(REGION)!;
  assert.equal(region.memberCount, 2);
  assert.equal(region.hasMemberTree, false);
  assert.equal(region.inWorkbook, false);
});

test("list with statement filter narrows to that sheet's rows", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { list } = tools(financial);
  const result = await list.execute({ modelId, statement: "balance_sheet" }, ctx);
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data as unknown as {
    rows: Array<{ rowId: string }>; breakdownAxes: unknown[];
  };
  assert.deepEqual(data.rows.map((r) => r.rowId), ["total_assets"]);
  assert.deepEqual(data.breakdownAxes, []);
});

test("get filters compose down the tree to exact members", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { get } = tools(financial);
  const result = await get.execute({ modelId, parentRowId: "net_sales", axisQName: PROD,
    parentMemberQName: "us-gaap:ProductMember" }, ctx);
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data as unknown as { rows: Array<{ rowId: string }>; nextCursor?: number };
  assert.deepEqual(data.rows.map((r) => r.rowId), ["net_sales.prod.iphone", "net_sales.prod.mac"]);
  assert.equal(data.nextCursor, undefined);
});

test("get statement filter composes with a breakdown-level filter to find the parent's disclosure", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { get } = tools(financial);
  // net_sales.prod.* breakdown rows carry no statement of their own; their effective statement is
  // their parent unified row's (net_sales -> income_statement). A statement filter must not exclude
  // them, or every product/region disclosure reads as "not disclosed" to the agent.
  const result = await get.execute({ modelId, statement: "income_statement", axisQName: PROD }, ctx);
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data as unknown as { rows: Array<{ rowId: string }> };
  assert.deepEqual(data.rows.map((r) => r.rowId).sort(), [
    "net_sales.prod.iphone", "net_sales.prod.mac", "net_sales.prod.product_group", "net_sales.prod.services_group",
  ]);

  // A statement filter that does not match the breakdown's parent excludes it, same as it excludes
  // unified rows from other statements.
  const mismatched = await get.execute({ modelId, statement: "balance_sheet", axisQName: PROD }, ctx);
  assert.equal(mismatched.error, undefined);
  const mismatchedData = mismatched.generation_context!.data as unknown as { rows: Array<{ rowId: string }> };
  assert.deepEqual(mismatchedData.rows, []);
});

test("get parentRowId includes the parent unified row itself alongside its breakdown rows", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { get } = tools(financial);
  const result = await get.execute({ modelId, parentRowId: "net_sales" }, ctx);
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data as unknown as { rows: Array<{ rowId: string }> };
  assert.deepEqual(data.rows.map((r) => r.rowId).sort(), [
    "net_sales", "net_sales.prod.iphone", "net_sales.prod.mac", "net_sales.prod.product_group",
    "net_sales.prod.services_group", "net_sales.region.intl", "net_sales.region.us",
  ]);
});

test("get memberQNames narrows to an exact allowlist of members", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { get } = tools(financial);
  const result = await get.execute({ modelId, parentRowId: "net_sales", axisQName: PROD,
    memberQNames: ["x:iPhoneMember", "x:MacMember"] }, ctx);
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data as unknown as { rows: Array<{ rowId: string }> };
  assert.deepEqual(data.rows.map((r) => r.rowId).sort(), ["net_sales.prod.iphone", "net_sales.prod.mac"]);
});

test("get memberFilter matches label case-insensitively and rowIds bypasses filters", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { get } = tools(financial);

  const byLabel = await get.execute({ modelId, memberFilter: "IPHONE" }, ctx);
  assert.equal(byLabel.error, undefined);
  const labelData = byLabel.generation_context!.data as unknown as { rows: Array<{ rowId: string }> };
  assert.deepEqual(labelData.rows.map((r) => r.rowId), ["net_sales.prod.iphone"]);

  // rowIds bypasses every other filter: total_assets is balance_sheet, but the (mismatched)
  // statement filter here must not exclude it.
  const bypass = await get.execute({ modelId, statement: "income_statement",
    rowIds: ["total_assets", "net_sales.prod.iphone"] }, ctx);
  assert.equal(bypass.error, undefined);
  const bypassData = bypass.generation_context!.data as unknown as { rows: Array<{ rowId: string }> };
  assert.deepEqual(bypassData.rows.map((r) => r.rowId).sort(), ["net_sales.prod.iphone", "total_assets"]);
});

test("get paginates at 40 with nextCursor", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  const LARGE_AXIS = "us-gaap:LargeAxis";
  const largeRows: BreakdownRow[] = Array.from({ length: 45 }, (_, i) => ({
    rowId: `net_sales.large.m${i}`, parentRowId: "net_sales", axisQName: LARGE_AXIS,
    memberQName: `x:Member${i}`, label: `Member ${i}`, unit: { kind: "currency", code: "USD" },
    values: { FY2024: i, FY2025: i + 1 }, rationale: "", asOfDate: "2026-01-01",
  }));
  const unified = baseUnified({ breakdownRows: [...baseBreakdownRows(), ...largeRows] });
  sourceReviewStore.save(modelId, review({ unifiedStatements: unified }));
  const { get } = tools(financial);

  const first = await get.execute({ modelId, axisQName: LARGE_AXIS }, ctx);
  assert.equal(first.error, undefined);
  const firstData = first.generation_context!.data as unknown as { rows: Array<{ rowId: string }>; nextCursor?: number };
  assert.equal(firstData.rows.length, UNIFIED_ROWS_PAGE);
  assert.equal(firstData.nextCursor, UNIFIED_ROWS_PAGE);
  assert.deepEqual(firstData.rows.map((r) => r.rowId), largeRows.slice(0, UNIFIED_ROWS_PAGE).map((r) => r.rowId));

  const second = await get.execute({ modelId, axisQName: LARGE_AXIS, cursor: firstData.nextCursor }, ctx);
  assert.equal(second.error, undefined);
  const secondData = second.generation_context!.data as unknown as { rows: Array<{ rowId: string }>; nextCursor?: number };
  assert.equal(secondData.rows.length, 5);
  assert.equal(secondData.nextCursor, undefined);
});

test("missing artifact and foreign owner fail with the documented codes", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  const { list, get } = tools(financial);

  // No unifiedStatements saved at all (artifact absent entirely).
  const noArtifact = await list.execute({ modelId }, ctx);
  assert.equal(noArtifact.error?.code, "unified_statements_unavailable");

  // Artifact saved but statement_unification never ran (unifiedStatements missing).
  sourceReviewStore.save(modelId, review());
  const notRun = await get.execute({ modelId }, ctx);
  assert.equal(notRun.error?.code, "unified_statements_unavailable");

  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const foreignOwner = await get.execute({ modelId }, { agentId: "agent-2", sessionId: "s2" });
  assert.equal(foreignOwner.error?.code, "financial_model_not_found");

  const unknownModel = await list.execute({ modelId: "fm-does-not-exist" }, ctx);
  assert.equal(unknownModel.error?.code, "financial_model_not_found");
});

test("expandSlugs replaces bare batch slugs and leaves metric.custom.* tokens untouched", () => {
  const slugs = new Set(["a", "b"]);
  assert.equal(expandSlugs("a * 2", slugs), "metric.custom.a * 2");
  // "a" must not match inside "abc" — the tokenizer captures the whole identifier run.
  assert.equal(expandSlugs("abc + a", slugs), "abc + metric.custom.a");
  // A token already qualified stays exactly as written — it can never equal a bare slug anyway.
  assert.equal(expandSlugs("metric.custom.a + b", slugs), "metric.custom.a + metric.custom.b");
  assert.equal(expandSlugs("revenue.total / revenue.total", slugs), "revenue.total / revenue.total");
});

test("calculate stages a mini sheet: out-of-order cross references compute in one revision", async () => {
  const { financial, modelId } = setup();
  seedRevenueTotal(financial, modelId);
  const { calculate } = tools(financial);

  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "b", formula: "a * 2" },
    { id: "a", formula: "revenue.total / revenue.total", description: "sanity ratio" },
  ] }, ctx);
  assert.equal(result.error, undefined);
  const data = result.generation_context!.data as unknown as {
    model_id: string; revision: number;
    rows: Array<{ lineItemId: string; label: string; description?: string; formula: string; values: Record<string, number | null> }>;
  };
  assert.equal(data.model_id, modelId);
  assert.equal(data.revision, 3);
  const b = data.rows.find((r) => r.lineItemId === "metric.custom.b")!;
  assert.equal(b.values["FY2024"], 2);
  assert.equal(b.values["FY2025"], 2);
  assert.equal(b.formula, "a * 2");
  const a = data.rows.find((r) => r.lineItemId === "metric.custom.a")!;
  assert.equal(a.description, "sanity ratio");
  assert.equal(a.values["FY2024"], 1);
});

test("a formula referencing a library row imports it deterministically and computes", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  seedRevenueTotal(financial, modelId);
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { calculate } = tools(financial);

  // net_sales.region.us is in the operable library (step2 data layer) but NOT in the workbook.
  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "us_share", formula: "unified.net_sales.region.us / revenue.total", description: "US revenue share" },
  ] }, ctx);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const data = result.generation_context!.data as unknown as {
    rows: Array<{ lineItemId: string; formula: string; values: Record<string, number | null> }>;
    imported: Array<{ lineItemId: string; label: string; values: Record<string, number | null> }>;
  };
  assert.equal(data.rows[0]!.values["FY2024"], 0.6); // 60 / 100
  // The engine rounds calculated cells; compare approximately.
  assert.ok(Math.abs((data.rows[0]!.values["FY2025"] ?? 0) - 65 / 110) < 1e-9);
  assert.deepEqual(data.imported.map((r) => r.lineItemId), ["unified.net_sales.region.us"]);
  assert.equal(data.imported[0]!.label, "United States");
  // The imported row is a real, committed workbook row with provenance-carrying facts…
  const snapshot = financial.modelStore.getRevision(modelId)!.snapshot;
  const fact = snapshot.facts.find((f) => f.lineItemId === "unified.net_sales.region.us" && f.periodId === "FY2024")!;
  assert.equal(fact.status, "committed");
  assert.equal(fact.value, 60);
  assert.equal(fact.provenance.sourceType, "unified_statements");
  assert.ok(fact.provenance.asOfDate.length > 0);
  // …but its definition is read-only: it is evidence, not an authorable row.
  const service = new FinancialModelService(financial.modelStore, "session-1");
  assert.throws(() => service.applyOperations(modelId, snapshot ? 3 : 3, [
    { kind: "set_formula", formula: { lineItemId: "unified.net_sales.region.us", appliesTo: "historical",
      source: "revenue.total", periodIds: ["FY2024"] } },
  ]));
});

test("two formulas sharing one library row import it once, and a later batch reuses it without re-import", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  seedRevenueTotal(financial, modelId);
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { calculate } = tools(financial);

  const first = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "us_share", formula: "unified.net_sales.region.us / revenue.total" },
    { id: "us_growth", formula: "YOY(unified.net_sales.region.us)" },
  ] }, ctx);
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const firstData = first.generation_context!.data as unknown as { revision: number; imported: Array<{ lineItemId: string }> };
  assert.equal(firstData.imported.length, 1);

  // NOTE: unified row "total_assets" would collide with the skeleton's own total_assets row, and the
  // workbook must win that resolution — so the unified-row import path is exercised via cost_of_sales.
  const second = await calculate.execute({ modelId, expectedRevision: firstData.revision, rows: [
    { id: "us_to_cogs", formula: "unified.net_sales.region.us / unified.cost_of_sales" },
  ] }, ctx);
  assert.equal(second.error, undefined, JSON.stringify(second.error));
  const secondData = second.generation_context!.data as unknown as {
    imported: Array<{ lineItemId: string }>; rows: Array<{ values: Record<string, number | null> }> };
  // net_sales.region.us already materialized; only cost_of_sales (a unified statement row) is new.
  assert.deepEqual(secondData.imported.map((r) => r.lineItemId), ["unified.cost_of_sales"]);
  assert.equal(secondData.rows[0]!.values["FY2024"], 60 / -40);
  assert.equal(secondData.rows[0]!.values["FY2025"], null); // cost_of_sales FY2025 is null in the library
});

test("strict namespaces: unified.<rowId> reaches a shadowed library row, and the bare form is refused with a hint", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  seedRevenueTotal(financial, modelId);
  // The library row deliberately shadows the skeleton's structural `revenue` root (which has no values).
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified({ rows: [
    { rowId: "revenue", statement: "income_statement", label: "Net sales", rationale: "",
      values: { FY2024: 200, FY2025: 220 } },
  ] }) }));
  const { calculate } = tools(financial);
  // Bare library reference: rejected upfront, naming the prefix to use.
  const bare = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "us_x", formula: "net_sales.region.us / revenue.total" },
  ] }, ctx);
  assert.equal(bare.error?.code, "invalid_tool_input");
  assert.match(bare.error!.message, /unified\.net_sales\.region\.us/);
  // Explicit prefix reaches the library's Net sales (200/100) — no double-prefix, no ambiguity.
  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "lib_share", formula: "unified.revenue / revenue.total" },
    { id: "naive_share", formula: "revenue / revenue.total" },
  ] }, ctx);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const data = result.generation_context!.data as unknown as {
    rows: Array<{ lineItemId: string; values: Record<string, number | null> }>;
    imported: Array<{ lineItemId: string }>; warnings: string[] };
  assert.deepEqual(data.imported.map((r) => r.lineItemId), ["unified.revenue"]);
  assert.equal(data.rows.find((r) => r.lineItemId === "metric.custom.lib_share")!.values["FY2024"], 2);
  // The bare `revenue` token legally means the workbook's structural root, which has no values —
  // that row comes back all-null and the response warns instead of staying silent.
  assert.equal(data.rows.find((r) => r.lineItemId === "metric.custom.naive_share")!.values["FY2024"], null);
  assert.equal(data.warnings.length, 1);
  assert.match(data.warnings[0]!, /naive_share/);
  assert.match(result.summary, /WARNING/);
});

test("a library row with a null period computes null there, not zero", async () => {
  const { financial, modelId, sourceReviewStore } = setup();
  seedRevenueTotal(financial, modelId);
  sourceReviewStore.save(modelId, review({ unifiedStatements: baseUnified() }));
  const { calculate } = tools(financial);
  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "cogs_ratio", formula: "unified.cost_of_sales / revenue.total" }, // cost_of_sales FY2025 is null
  ] }, ctx);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const data = result.generation_context!.data as unknown as { rows: Array<{ values: Record<string, number | null> }> };
  assert.equal(data.rows[0]!.values["FY2024"], -0.4);
  assert.equal(data.rows[0]!.values["FY2025"], null);
});

test("an omitted unit is inferred from the formula, not defaulted to ratio", async () => {
  const { financial, modelId } = setup();
  seedRevenueTotal(financial, modelId);
  const { calculate } = tools(financial);
  // A currency-valued formula and a batch cross-reference onto it — both without a declared unit.
  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "rev_delta", formula: "revenue.total - LAG(revenue.total, 1)" },
    { id: "rev_delta_share", formula: "rev_delta / revenue.total" },
  ] }, ctx);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const data = result.generation_context!.data as unknown as { rows: Array<{ lineItemId: string; values: Record<string, number | null> }> };
  assert.equal(data.rows.find((r) => r.lineItemId === "metric.custom.rev_delta")!.values["FY2025"], 10);
  const snapshot = financial.modelStore.getRevision(modelId)!.snapshot;
  assert.deepEqual(snapshot.lineItems.find((i) => i.id === "metric.custom.rev_delta")!.unit, { kind: "currency", code: "USD" });
  assert.deepEqual(snapshot.lineItems.find((i) => i.id === "metric.custom.rev_delta_share")!.unit, { kind: "ratio" });
});

test("a circular batch is rejected atomically", async () => {
  const { financial, modelId } = setup();
  seedRevenueTotal(financial, modelId);
  const { calculate } = tools(financial);

  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "a", formula: "b + 1" },
    { id: "b", formula: "a + 1" },
  ] }, ctx);
  assert.ok(result.error);
  assert.equal(financial.modelStore.getMeta(modelId)?.currentRevision, 2);
});

test("duplicate slug in one batch is rejected before any operation runs", async () => {
  const { financial, modelId } = setup();
  seedRevenueTotal(financial, modelId);
  const { calculate } = tools(financial);

  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "a", formula: "revenue.total" },
    { id: "a", formula: "revenue.total * 2" },
  ] }, ctx);
  assert.equal(result.error?.code, "invalid_tool_input");
  assert.equal(financial.modelStore.getMeta(modelId)?.currentRevision, 2);
});

test("a formula referencing an unknown line item fails the whole batch", async () => {
  const { financial, modelId } = setup();
  seedRevenueTotal(financial, modelId);
  const { calculate } = tools(financial);

  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "a", formula: "no_such_line_item * 2" },
  ] }, ctx);
  assert.ok(result.error);
  assert.equal(financial.modelStore.getMeta(modelId)?.currentRevision, 2);
});

test("a batch row id colliding with an existing model line item is rejected before any operation runs", async () => {
  const { financial, modelId } = setup();
  seedRevenueTotal(financial, modelId);
  const { calculate } = tools(financial);

  // "net_income" is one of the ~58 skeleton line items every model is created with (see
  // src/financial-model/skeleton.ts), so it already collides at the store level without any setup.
  // A batch defining a row with that same slug would silently shadow the real line item: every bare
  // "net_income" reference elsewhere in the batch would resolve to the placeholder, not the real row.
  const collidingId = "net_income";
  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: collidingId, formula: "revenue.total * 0.1" },
    { id: "npm2", formula: `${collidingId} / revenue.total` },
  ] }, ctx);
  assert.equal(result.error?.code, "invalid_tool_input");
  assert.match(result.error!.message, new RegExp(collidingId));
  // Rejected atomically: the batch never touched the store.
  assert.equal(financial.modelStore.getMeta(modelId)?.currentRevision, 2);
});

test("a stale expectedRevision surfaces currentRevision in the error details, not just a bare code", async () => {
  const { financial, modelId } = setup();
  seedRevenueTotal(financial, modelId);
  const { calculate } = tools(financial);

  // Model is at revision 2 after seeding; call with a stale expectedRevision of 1.
  const result = await calculate.execute({ modelId, expectedRevision: 1, rows: [
    { id: "a", formula: "revenue.total" },
  ] }, ctx);
  assert.equal(result.error?.code, "revision_conflict");
  const data = result.generation_context!.data as unknown as { currentRevision?: number };
  assert.equal(data.currentRevision, 2);
});

test("foreign owner gets financial_model_not_found", async () => {
  const { financial, modelId } = setup();
  seedRevenueTotal(financial, modelId);
  const { calculate } = tools(financial);

  const result = await calculate.execute({ modelId, expectedRevision: 2, rows: [
    { id: "a", formula: "revenue.total" },
  ] }, { agentId: "agent-2", sessionId: "s2" });
  assert.equal(result.error?.code, "financial_model_not_found");
});
