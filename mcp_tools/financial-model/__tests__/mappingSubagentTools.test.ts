import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemorySourceReviewStore, type SourceReviewArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { InMemoryFilingTableStore } from "../../../src/infra/xbrl/filingTableStore.ts";
import type { FilingTable } from "../../../src/infra/xbrl/tableTypes.ts";
import type { FilingTableFactOccurrence, XbrlDimension } from "../../../src/infra/xbrl/types.ts";
import type { Period } from "../../../src/financial-model/types.ts";
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

test("the unification subagent's load tool resolves the ticker it was told to work on", () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const loader = createStatementUnificationTools(deps);

  const loaded = loader.tools.get("load_concept_inventory")!.execute({ symbol: "tsla" }) as { symbol: string };
  assert.equal(loaded.symbol, "TSLA");
  // The host reads this back to check the subagent worked on the model the orchestrator named.
  assert.deepEqual(loader.loaded(), { symbol: "TSLA", modelId: modelIds[0] });
});

test("a pinned modelId resolves among multiple versions of one ticker, and catches a wrong-ticker instruction", () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST", "TST"]);
  sourceReviewStore.save(modelIds[1]!, review({ presentationExtracts: [{ filing: { accession: "a" },
    calculationRelations: [], negatedConcepts: [], statements: [] } as never] }));
  const { tools } = createStatementUnificationTools({ ...deps, modelId: modelIds[1]! });
  const loaded = tools.get("load_concept_inventory")!.execute({ symbol: "TST" }) as { symbol: string };
  assert.equal(loaded.symbol, "TST");
  assert.throws(() => tools.get("load_concept_inventory")!.execute({ symbol: "NOPE" }), /not the issuer|NOPE/);
});

test("two models for one ticker is refused rather than guessed at", () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA", "TSLA"]);
  for (const modelId of modelIds) sourceReviewStore.save(modelId, review({ presentationExtracts: [{} as never] }));
  const loader = createStatementUnificationTools(deps);
  assert.throws(() => loader.tools.get("load_concept_inventory")!.execute({ symbol: "TSLA" }),
    /2 models exist for TSLA/);
});

test("a ticker with no extracted data names the step that has to run first", () => {
  const { deps } = setup(["TSLA"]);
  const loader = createStatementUnificationTools(deps);
  assert.throws(() => loader.tools.get("load_concept_inventory")!.execute({ symbol: "AAPL" }),
    /run extract_filing_statements/);
});

test("spine mapping refuses to load before unification has stored anything", () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const loader = createSpineMappingTools(deps);
  assert.throws(() => loader.tools.get("load_unified_statements")!.execute({ symbol: "TSLA" }),
    /run statement_unification first/);
  assert.equal(loader.loaded(), undefined);
});

test("another agent's model is invisible, so a subagent cannot load across owners", () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TSLA"]);
  sourceReviewStore.save(modelIds[0]!, review({ presentationExtracts: [{} as never] }));
  const loader = createStatementUnificationTools({ ...deps, ownerAgentId: "agent-2" });
  assert.throws(() => loader.tools.get("load_concept_inventory")!.execute({ symbol: "TSLA" }),
    /no model holds extracted data for TSLA/);
});

test("list_dimension_axes returns the axis catalog for the resolved run", () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:BMember", "Segment B")]),
  ] })]);
  const { tools } = createStatementUnificationTools({ ...deps, tableStore });
  const result = tools.get("list_dimension_axes")!.execute({ symbol: "TST" }) as { axes: Array<{ axisQName: string }> };
  assert.equal(result.axes.length, 1);
  assert.equal(result.axes[0]!.axisQName, SEG);
});

test("get_axis_breakdown returns member series", () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:BMember", "Segment B")]),
  ] })]);
  const { tools } = createStatementUnificationTools({ ...deps, tableStore });
  const result = tools.get("get_axis_breakdown")!.execute({ symbol: "TST",
    axisQName: SEG, conceptQName: REV }) as { members: unknown[] };
  assert.equal(result.members.length, 2);
});

test("get_axis_breakdown passes memberFilter and cursor through and rejects a bad cursor", () => {
  const { sourceReviewStore, modelIds, deps } = setup(["TST"]);
  sourceReviewStore.save(modelIds[0]!, review());
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:BMember", "Segment B")]),
  ] })]);
  const { tools } = createStatementUnificationTools({ ...deps, tableStore });
  const breakdownTool = tools.get("get_axis_breakdown")!;
  const filtered = breakdownTool.execute({ symbol: "TST", axisQName: SEG, conceptQName: REV,
    memberFilter: "segment b" }) as { members: Array<{ memberQName: string }> };
  assert.deepEqual(filtered.members.map((m) => m.memberQName), ["x:BMember"]);
  const paged = breakdownTool.execute({ symbol: "TST", axisQName: SEG, conceptQName: REV,
    cursor: 1 }) as { members: Array<{ memberQName: string }> };
  assert.deepEqual(paged.members.map((m) => m.memberQName), ["x:BMember"]);
  assert.throws(() => breakdownTool.execute({ symbol: "TST", axisQName: SEG, conceptQName: REV, cursor: -1 }));
});

test("dimension tools are absent without a tableStore", () => {
  const { deps } = setup(["TST"]);
  const { tools } = createStatementUnificationTools(deps);
  assert.equal(tools.has("list_dimension_axes"), false);
  assert.equal(tools.has("get_axis_breakdown"), false);
});
