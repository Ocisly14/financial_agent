import assert from "node:assert/strict";
import test from "node:test";

import type { RegisteredTool } from "../../toolRegistry.ts";
const byName = (tools: RegisteredTool[], name: string): RegisteredTool | undefined => tools.find((tool) => tool.name === name);

/** These are ordinary MCP tools now: async, and the payload rides in generation_context.data.
 *  A failure comes back as an error result rather than a throw. Ownership and the per-task working
 *  set both ride the execution context, exactly as a dispatched run supplies them. */
async function data<T>(tool: RegisteredTool | undefined, input: object,
  context: { sessionId?: string; tenantId?: string; taskId?: string } = {}): Promise<T> {
  const result = await tool!.execute(input as never,
    { sessionId: "session-1", tenantId: "agent-1", ...context });
  if (result.error) throw new Error(result.error.message);
  return result.generation_context!.data as T;
}

import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemorySourceReviewStore, type SourceReviewArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { InMemoryFilingTableStore } from "../../../src/infra/xbrl/filingTableStore.ts";
import type { FilingTable } from "../../../src/infra/xbrl/tableTypes.ts";
import type { FilingTableFactOccurrence, XbrlDimension } from "../../../src/infra/xbrl/types.ts";
import type { Period } from "../../../src/financial-model/types.ts";
import { FinancialModelError } from "../../../src/financial-model/errors.ts";
import { CANONICAL_MAPPING_IDS, REQUIRED_MAPPING_IDS } from "../../../src/financial-model/skeleton.ts";
import { subagentTool } from "../mappingShared.ts";
import { createUnificationAgentTools } from "../unificationDeliveryTools.ts";
import { createSpineAgentTools } from "../spineDeliveryTools.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import type { FinancialModelToolDeps } from "../financialModelTools.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
];

const SEG = "us-gaap:StatementBusinessSegmentsAxis";
const REV = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
const USD = { kind: "currency", code: "USD" } as const;

// Copied from src/infra/xbrl/__tests__/dimensionInventory.test.ts's fixture helpers.
function dim(member: string, memberLabel: string, axis = SEG): XbrlDimension {
  return { axisQName: axis, axisLabel: "Segments", memberQName: member, memberLabel };
}
function dimFact(concept: string, periodId: string, value: number, dims: XbrlDimension[], htmlOrder = 1): FilingTableFactOccurrence {
  return { occurrenceId: `${concept}|${periodId}|${dims.map((d) => d.memberQName).join(",")}|${htmlOrder}`,
    conceptQName: concept, conceptLabel: concept, htmlOrder, contextId: "c", periodId, value,
    unit: USD, decimals: -6, dimensions: dims, sourceAnchor: "#f" };
}
function table(over: Partial<FilingTable> & { accession: string; filedAt: string; facts: FilingTableFactOccurrence[] }): FilingTable {
  const { facts, ...rest } = over;
  return { sourceTableId: `${over.accession}-t1`, form: "10-K", reportDate: over.filedAt,
    heading: "Segment information", htmlOrder: 5, sourceAnchor: "#t1",
    prescreen: { tier: "weak", presentationOverlap: 0, dimensionlessRatio: 0, periodSpan: 2, factCount: facts.length },
    suggestedStatements: [], columns: [],
    rows: [{ order: 1, labelText: "Revenue", indentLevel: 0, cells: facts.map((fact, index) => ({ columnIndex: index + 1, text: String(fact.value), fact })) }],
    ...rest };
}

function review(overrides: Partial<SourceReviewArtifact> = {}): SourceReviewArtifact {
  const view = { candidate: { periods: PERIODS, rows: [] }, filingPresentations: [] };
  return {
    ingestionRunId: "ing-1", coverage: { requestedPeriodIds: [], statements: [], issues: [] },
    dimensionalDisclosures: [], curatedTables: [], curations: [], filings: [], facts: [],
    statementViews: { income_statement: view, balance_sheet: view, cash_flow_statement: view } as never,
    ...overrides,
  };
}

function setup(symbols: readonly string[]) {
  const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  const sourceReviewStore = new InMemorySourceReviewStore();
  const service = new FinancialModelService(modelStore, "session-1");
  const modelIds = symbols.map((symbol, index) => {
    const modelId = `fm-${index}`;
    service.createModel({ modelId, ownerTenantId: "agent-1", originSessionId: "session-1", symbol,
      metadata: {}, reportingCurrency: "USD", periods: PERIODS, preparedStatementRows: [] });
    return modelId;
  });
  const deps: FinancialModelToolDeps = { modelStore, sourceReviewStore,
    insightStore: new InMemoryFilingInsightStore(), ingestionStore: sourceReviewStore };
  return { modelStore, sourceReviewStore, modelIds, deps };
}

test("mapping tool preserves typed errors and their correction details", async () => {
  const tool = subagentTool({ name: "typed_failure", description: "test", category: "non_trading",
    inputSchema: { type: "object" } }, () => {
    throw new FinancialModelError("revision_conflict", "revision is stale", { currentRevision: 7 });
  });
  const result = await tool.execute({}, { sessionId: "s", tenantId: "owner" });
  assert.equal(result.error?.code, "revision_conflict");
  assert.equal(result.error?.message, "revision is stale");
  assert.deepEqual(result.generation_context?.data, { error: "revision_conflict", currentRevision: 7 });
});

test("the unification load tool resolves the ticker it was told to work on", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const tools = createUnificationAgentTools(deps);

  const loaded = await data<{ symbol: string }>(byName(tools, "load_concept_inventory"), { symbol: "tsla" });
  assert.equal(loaded.symbol, "TSLA");
});

test("two models for one ticker is refused rather than guessed at", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA", "TSLA"]);
  for (const modelId of modelIds) sourceReviewStore.save(modelId, review({ presentationExtracts: [{} as never] }));
  const tools = createUnificationAgentTools(deps);
  await assert.rejects(() => data(byName(tools, "load_concept_inventory"), { symbol: "TSLA" }),
    /2 models exist for TSLA/);
});

test("a ticker with no extracted data names the step that has to run first", async () => {
  const { deps } = setup(["TSLA"]);
  const tools = createUnificationAgentTools(deps);
  await assert.rejects(() => data(byName(tools, "load_concept_inventory"), { symbol: "AAPL" }),
    /run extract_filing_statements/);
});

test("delivery refuses before a working set is loaded", async () => {
  const { deps } = setup(["TSLA"]);
  const tools = createUnificationAgentTools(deps);
  await assert.rejects(() => data(byName(tools, "submit_unification_decision"), { decision: { rows: [] } }),
    /load_concept_inventory/);
});

test("an accepted decision persists itself; a dirty one leaves the store untouched", async () => {
  // This was the deleted host's job — persist after the run, throw on a dirty candidate. Now the
  // store write IS the acceptance: it happens inside the submit result, and nothing else writes.
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const tools = createUnificationAgentTools(deps);
  await data(byName(tools, "load_concept_inventory"), { symbol: "TSLA" }, { taskId: "t1" });

  // A dirty decision: a row built on a concept the filings never reported.
  const dirty = await data<{ status: string }>(byName(tools, "submit_unification_decision"),
    { decision: { rows: [{ rowId: "ghost", statement: "income_statement", label: "Ghost",
      components: [{ conceptQName: "x:Missing", weight: 1 }], rationale: "r" }] } }, { taskId: "t1" });
  assert.equal(dirty.status, "incomplete");
  assert.equal(sourceReviewStore.get(modelIds[0]!)?.unifiedStatements, undefined,
    "a candidate with findings must never reach the store");

  const accepted = await data<{ status: string; stored?: boolean }>(byName(tools, "submit_unification_decision"),
    { decision: { rows: [] } }, { taskId: "t1" });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.stored, true);
  assert.ok(sourceReviewStore.get(modelIds[0]!)?.unifiedStatements, "acceptance is the store write");
});

test("working sets are task-scoped, so two runs do not share a draft", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const tools = createUnificationAgentTools(deps);
  await data(byName(tools, "load_concept_inventory"), { symbol: "TSLA" }, { taskId: "t1" });
  await assert.rejects(() => data(byName(tools, "submit_unification_decision"),
    { decision: { rows: [] } }, { taskId: "t2" }), /load_concept_inventory/);
});

/**
 * The spine vocabulary reaches the subagent only through this payload. Before the tool-driven
 * rewrite the agent was handed `[REQUIRED SPINE IDS]` and `[OPTIONAL SPINE IDS]` in its prompt; the
 * rewrite moved the statements into this tool and left the ids behind, so the subagent was asked to
 * cover targets whose names it had never been told — and the ids only reached it when the
 * orchestrator happened to spell them out in the dispatch task. These two assertions are what let
 * that task go back to describing intent.
 */
test("the spine loader hands over the target ids, required separated from optional", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ unifiedStatements: { periods: [], rows: [] } as never }));
  const tools = createSpineAgentTools(deps);

  const loaded = await data<{ spineTargets: { required: string[]; optional: string[] } }>(
    byName(tools, "load_unified_statements"), { symbol: "TSLA" });

  assert.deepEqual([...REQUIRED_MAPPING_IDS].sort(), [...loaded.spineTargets.required].sort(),
    "the required set the agent is judged against is the one it is shown");
  assert.deepEqual([...CANONICAL_MAPPING_IDS].sort(),
    [...loaded.spineTargets.required, ...loaded.spineTargets.optional].sort(),
    "every mappable target is offered, and nothing that is not mappable");
  assert.equal(loaded.spineTargets.required.some((id) => loaded.spineTargets.optional.includes(id)), false);
});

test("the spine loader exposes disclosed breakdown rows for revenue-detail selection", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ unifiedStatements: {
    periods: PERIODS,
    rows: [{ rowId: "net_sales", label: "Net sales", statement: "income_statement", unit: USD,
      values: { FY2024: 100, FY2025: 110 } }],
    breakdownRows: [{ rowId: "net_sales.product.products", parentRowId: "net_sales", axisQName: SEG,
      memberQName: "x:ProductsMember", label: "Products", unit: USD, values: { FY2024: 60, FY2025: 66 },
      rationale: "disclosed product split", asOfDate: "2026-01-30" }],
  } as never }));
  const tools = createSpineAgentTools(deps);

  const loaded = await data<{ breakdownRows: Array<{ rowId: string; label: string }> }>(
    byName(tools, "load_unified_statements"), { symbol: "TSLA" });

  assert.deepEqual(loaded.breakdownRows, [{ rowId: "net_sales.product.products", label: "Products", axisQName: SEG,
    memberQName: "x:ProductsMember", unit: USD, values: { FY2024: 60, FY2025: 66 },
    rationale: "disclosed product split", asOfDate: "2026-01-30", parentRowId: "net_sales" }]);
});

test("spine mapping refuses to load before unification has stored anything", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const tools = createSpineAgentTools(deps);
  await assert.rejects(() => data(byName(tools, "load_unified_statements"), { symbol: "TSLA" }),
    /run statement_unification first/);
});

test("another tenant's model is invisible, so a subagent cannot load across owners", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{} as never] }));
  const tools = createUnificationAgentTools(deps);
  await assert.rejects(() => data(byName(tools, "load_concept_inventory"), { symbol: "TSLA" }, { tenantId: "agent-2" }),
    /no model holds extracted data for TSLA/);
});

test("list_dimension_axes returns the axis catalog for the resolved run", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:BMember", "Segment B")]),
  ] })]);
  const tools = createUnificationAgentTools({ ...deps, tableStore });
  const result = await data<{ axes: Array<{ axisQName: string }> }>(byName(tools, "list_dimension_axes"), { symbol: "TST" });
  assert.equal(result.axes.length, 1);
  assert.equal(result.axes[0]!.axisQName, SEG);
});

test("get_axis_breakdown returns member series", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:BMember", "Segment B")]),
  ] })]);
  const tools = createUnificationAgentTools({ ...deps, tableStore });
  const result = await data<{ members: unknown[] }>(byName(tools, "get_axis_breakdown"), { symbol: "TST",
    axisQName: SEG, conceptQName: REV });
  assert.equal(result.members.length, 2);
});

test("an unknown exact axis/concept pair fails with a catalog recovery path", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
  ] })]);
  const tools = createUnificationAgentTools({ ...deps, tableStore });
  await assert.rejects(() => data(byName(tools, "get_axis_breakdown"), { symbol: "TST",
    axisQName: "x:UnknownAxis", conceptQName: REV }), /list_dimension_axes/);
});

test("get_axis_breakdown passes memberFilter and cursor through and rejects a bad cursor", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:BMember", "Segment B")]),
  ] })]);
  const tools = createUnificationAgentTools({ ...deps, tableStore });
  const breakdownTool = byName(tools, "get_axis_breakdown")!;
  const filtered = await data<{ members: Array<{ memberQName: string }> }>(breakdownTool, { symbol: "TST", axisQName: SEG, conceptQName: REV,
    memberFilter: "segment b" });
  assert.deepEqual(filtered.members.map((m) => m.memberQName), ["x:BMember"]);
  const paged = await data<{ members: Array<{ memberQName: string }> }>(breakdownTool, { symbol: "TST", axisQName: SEG, conceptQName: REV,
    cursor: 1 });
  assert.deepEqual(paged.members.map((m) => m.memberQName), ["x:BMember"]);
  await assert.rejects(() => data(breakdownTool, { symbol: "TST", axisQName: SEG, conceptQName: REV, cursor: -1 }));
});

test("without a tableStore the dimension tools refuse instead of exploring", async () => {
  // Registered regardless — the topology's pool must resolve — but the capability is honest about
  // being unavailable rather than returning an empty catalog that reads as "no dimensions disclosed".
  const { deps } = setup(["TST"]);
  const tools = createUnificationAgentTools({ modelStore: deps.modelStore, sourceReviewStore: deps.sourceReviewStore });
  await assert.rejects(() => data(byName(tools, "list_dimension_axes"), { symbol: "TST" }),
    /dimension exploration is unavailable/);
});

/**
 * A spine target used to arrive as a bare id. Amazon's income statement carries a line labelled
 * "Total operating expenses" that INCLUDES cost of sales, so mapping it onto `operating_expenses` is
 * the obvious move from the label alone — and it double-counts COGS, because the engine checks
 * `operating_income = gross_profit - operating_expenses` and gross_profit has already netted it. The
 * mapper could not have known: that identity lives in reconciliation.ts, which it never sees. The
 * cost landed downstream, where financial_modeling spent most of a round diagnosing five failed
 * reconciliations and overriding the row with a formula.
 */
test("spine targets carry the identities that decide whether a mapping is right", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ unifiedStatements: { periods: [], rows: [] } as never }));
  const tools = createSpineAgentTools(deps);

  const loaded = await data<{ spineTargets: { required: string[]; optional: string[];
    semantics: Record<string, string> } }>(byName(tools, "load_unified_statements"), { symbol: "TSLA" });

  const opex = loaded.spineTargets.semantics["operating_expenses"];
  assert.ok(opex, "the target most often mis-mapped has to say what it means");
  assert.match(opex, /operating_income = gross_profit - operating_expenses/,
    "the identity that judges the mapping travels with the target");
  assert.match(opex, /exclud/i, "and the scope that the issuer's same-named line does not share");

  assert.match(loaded.spineTargets.semantics["gross_profit"] ?? "", /revenue\.total = cost_of_revenue \+ gross_profit/);
  // Ids that no identity reads carry no note rather than a filler one.
  assert.equal(loaded.spineTargets.semantics["diluted_shares"], undefined);
});

// Regression for an Important finding: a breakdown row's label lives in unifiedStatements.breakdownRows,
// not .rows, so the commit's label lookup must search both — otherwise the label falls back to the
// rowId slug and the workbook shows e.g. "net_sales.statementbusinesssegments.products" instead of
// "Products". The commit now happens inside submit_spine_decision, so that is where this drives it.
test("an accepted spine mapping commits itself, labelling detail rows from breakdownRows", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TEST"]);
  sourceReviewStore.save(modelIds[0]!, review({
    unifiedStatements: {
      periods: ["FY2025"],
      rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales", rationale: "",
        values: { FY2025: 100e6 } }],
      supplementalRows: [], excluded: [], restatements: [], rollupBreaks: [], findings: [], unresolvedFindings: [],
      facts: [{ factId: "unified.income_statement.net_sales.FY2025", status: "staged",
        lineItemId: "unified.income_statement.net_sales", periodId: "FY2025", value: 100e6,
        unit: USD,
        provenance: { sourceType: "filing", sourceRefs: [], asOfDate: "2026-01-30" } }],
      breakdownRows: [{ rowId: "net_sales.seg.products", parentRowId: "net_sales",
        axisQName: SEG, memberQName: "x:ProductsMember", label: "Products",
        unit: USD, values: { FY2025: 60e6 }, rationale: "product mix",
        asOfDate: "2026-01-30" }],
    } as never,
  }));
  const tools = createSpineAgentTools(deps);
  await data(byName(tools, "load_unified_statements"), { symbol: "TEST" }, { taskId: "t-spine" });

  const otherRequired = [...REQUIRED_MAPPING_IDS].filter((targetId) => targetId !== "revenue.total");
  const submitted = await data<{ status: string; committedRevision?: number }>(
    byName(tools, "submit_spine_decision"),
    { decision: {
      mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "top line" }],
      detailRows: [{ parentTargetId: "revenue.total", rowId: "net_sales.seg.products", rationale: "product mix" }],
      excluded: [],
      spineGaps: otherRequired.map((targetId) => ({ targetId, reason: "not modeled in this test" })),
    } }, { taskId: "t-spine" });

  assert.equal(submitted.status, "accepted");
  assert.equal(typeof submitted.committedRevision, "number", "acceptance IS the commit");

  const service = new FinancialModelService(deps.modelStore, "session-1");
  const view = service.getModel(modelIds[0]!);
  assert.ok("currentWorkbook" in view);
  const stream = view.currentWorkbook.sections.revenue.find((row) => row.lineItemId === "revenue.products");
  assert.equal(stream?.label, "Products", JSON.stringify(view.currentWorkbook.sections.revenue.map((r) => r.lineItemId)));
});

test("an accepted unification lands a revision, so the model's own history shows its foundation", async () => {
  // The artifact lives in the source-review store, not the workbook — but without a revision the
  // model's history jumped from "created" straight to "spine committed", hiding the heaviest
  // judgment in the whole data foundation, and nothing watching revisions (the workspace panel, a
  // resumed agent) could tell this stage had run.
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const tools = createUnificationAgentTools(deps);
  const before = deps.modelStore.getMeta(modelIds[0]!)!.currentRevision;
  await data(byName(tools, "load_concept_inventory"), { symbol: "TSLA" }, { taskId: "t-unify" });

  const accepted = await data<{ status: string; model_id?: string; revision?: number }>(
    byName(tools, "submit_unification_decision"), { decision: { rows: [] } }, { taskId: "t-unify" });

  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.model_id, modelIds[0]);
  assert.equal(accepted.revision, before + 1, "acceptance advances the model's revision");
  // model_id + revision together are what make a tool result refresh the workspace panel.
  assert.equal(typeof accepted.revision, "number");

  const summary = deps.modelStore.getRevision(modelIds[0]!, accepted.revision!)!.changeSummary;
  const unified = (summary.changes as Array<{ kind: string; rowCount?: number }>).find((c) => c.kind === "statements_unified");
  assert.ok(unified, "the revision names what happened");

  // The stage does not advance: the workbook gains no history until spine_mapping commits facts.
  assert.equal(deps.modelStore.getMeta(modelIds[0]!)!.lifecycleStage, "draft");
});

test("a decision with findings advances nothing — no store write, no revision", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const tools = createUnificationAgentTools(deps);
  const before = deps.modelStore.getMeta(modelIds[0]!)!.currentRevision;
  await data(byName(tools, "load_concept_inventory"), { symbol: "TSLA" }, { taskId: "t2" });

  const dirty = await data<{ status: string; revision?: number }>(byName(tools, "submit_unification_decision"),
    { decision: { rows: [{ rowId: "ghost", statement: "income_statement", label: "Ghost",
      components: [{ conceptQName: "x:Missing", weight: 1 }], rationale: "r" }] } }, { taskId: "t2" });

  assert.equal(dirty.status, "incomplete");
  assert.equal(dirty.revision, undefined);
  assert.equal(deps.modelStore.getMeta(modelIds[0]!)!.currentRevision, before, "a dirty candidate must not move the model");
});
