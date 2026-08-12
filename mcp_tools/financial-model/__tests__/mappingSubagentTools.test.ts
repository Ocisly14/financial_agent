import assert from "node:assert/strict";
import test from "node:test";

import type { RegisteredTool } from "../../toolRegistry.ts";
const byName = (tools: RegisteredTool[], name: string): RegisteredTool | undefined => tools.find((tool) => tool.name === name);

/** These are ordinary MCP tools now: async, and the payload rides in generation_context.data.
 *  A failure comes back as an error result rather than a throw. */
async function data<T>(tool: RegisteredTool | undefined, input: object): Promise<T> {
  const result = await tool!.execute(input as never, { sessionId: "s", agentId: "owner" });
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
import { CANONICAL_MAPPING_IDS, REQUIRED_MAPPING_IDS } from "../../../src/financial-model/skeleton.ts";
import { createSpineMappingTools, createStatementUnificationTools } from "../mappingSubagentTools.ts";

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
    service.createModel({ modelId, ownerAgentId: "agent-1", originSessionId: "session-1", symbol,
      metadata: {}, reportingCurrency: "USD", periods: PERIODS, preparedStatementRows: [] });
    return modelId;
  });
  return { modelStore, sourceReviewStore, modelIds,
    deps: { modelStore, sourceReviewStore, ownerAgentId: "agent-1" } };
}

test("the unification subagent's load tool resolves the ticker it was told to work on", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const loader = createStatementUnificationTools(deps);

  const loaded = await data<{ symbol: string }>(byName(loader.tools, "load_concept_inventory"), { symbol: "tsla" });
  assert.equal(loaded.symbol, "TSLA");
  // The host reads this back to check the subagent worked on the model the orchestrator named.
  assert.deepEqual(loader.loaded(), { symbol: "TSLA", modelId: modelIds[0] });
});

test("a pinned modelId resolves among multiple versions of one ticker, and catches a wrong-ticker instruction", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST", "TST"]);
  sourceReviewStore.save(modelIds[1]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const { tools } = createStatementUnificationTools({ ...deps, modelId: modelIds[1]! });
  const loaded = await data<{ symbol: string }>(byName(tools, "load_concept_inventory"), { symbol: "TST" });
  assert.equal(loaded.symbol, "TST");
  await assert.rejects(() => data(byName(tools, "load_concept_inventory"), { symbol: "NOPE" }), /not the issuer|NOPE/);
});

test("two models for one ticker is refused rather than guessed at", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA", "TSLA"]);
  for (const modelId of modelIds) sourceReviewStore.save(modelId, review({ presentationExtracts: [{} as never] }));
  const loader = createStatementUnificationTools(deps);
  await assert.rejects(() => data(byName(loader.tools, "load_concept_inventory"), { symbol: "TSLA" }),
    /2 models exist for TSLA/);
});

test("a ticker with no extracted data names the step that has to run first", async () => {
  const { deps } = setup(["TSLA"]);
  const loader = createStatementUnificationTools(deps);
  await assert.rejects(() => data(byName(loader.tools, "load_concept_inventory"), { symbol: "AAPL" }),
    /run extract_filing_statements/);
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
  const loader = createSpineMappingTools(deps);

  const loaded = await data<{ spineTargets: { required: string[]; optional: string[] } }>(
    byName(loader.tools, "load_unified_statements"), { symbol: "TSLA" });

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
  const loader = createSpineMappingTools(deps);

  const loaded = await data<{ breakdownRows: Array<{ rowId: string; label: string }> }>(
    byName(loader.tools, "load_unified_statements"), { symbol: "TSLA" });

  assert.deepEqual(loaded.breakdownRows, [{ rowId: "net_sales.product.products", label: "Products", axisQName: SEG,
    memberQName: "x:ProductsMember", unit: USD, values: { FY2024: 60, FY2025: 66 },
    rationale: "disclosed product split", asOfDate: "2026-01-30", parentRowId: "net_sales" }]);
});

test("spine mapping refuses to load before unification has stored anything", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const loader = createSpineMappingTools(deps);
  await assert.rejects(() => data(byName(loader.tools, "load_unified_statements"), { symbol: "TSLA" }),
    /run statement_unification first/);
  assert.equal(loader.loaded(), undefined);
});

test("another agent's model is invisible, so a subagent cannot load across owners", async () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{} as never] }));
  const loader = createStatementUnificationTools({ ...deps, ownerAgentId: "agent-2" });
  await assert.rejects(() => data(byName(loader.tools, "load_concept_inventory"), { symbol: "TSLA" }),
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
  const { tools } = createStatementUnificationTools({ ...deps, tableStore });
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
  const { tools } = createStatementUnificationTools({ ...deps, tableStore });
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
  const { tools } = createStatementUnificationTools({ ...deps, tableStore });
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
  const { tools } = createStatementUnificationTools({ ...deps, tableStore });
  const breakdownTool = byName(tools, "get_axis_breakdown")!;
  const filtered = await data<{ members: Array<{ memberQName: string }> }>(breakdownTool, { symbol: "TST", axisQName: SEG, conceptQName: REV,
    memberFilter: "segment b" });
  assert.deepEqual(filtered.members.map((m) => m.memberQName), ["x:BMember"]);
  const paged = await data<{ members: Array<{ memberQName: string }> }>(breakdownTool, { symbol: "TST", axisQName: SEG, conceptQName: REV,
    cursor: 1 });
  assert.deepEqual(paged.members.map((m) => m.memberQName), ["x:BMember"]);
  await assert.rejects(() => data(breakdownTool, { symbol: "TST", axisQName: SEG, conceptQName: REV, cursor: -1 }));
});

test("dimension tools are absent without a tableStore", async () => {
  const { deps } = setup(["TST"]);
  const { tools } = createStatementUnificationTools(deps);
  assert.equal(byName(tools, "list_dimension_axes"), undefined);
  assert.equal(byName(tools, "get_axis_breakdown"), undefined);
});
