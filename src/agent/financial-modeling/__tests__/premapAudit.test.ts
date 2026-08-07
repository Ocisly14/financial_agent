import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmMessage, type LlmProvider } from "../../../infra/llm/provider.ts";
import { InMemoryFilingTableStore } from "../../../infra/xbrl/filingTableStore.ts";
import { InMemoryDecompositionStore } from "../../../infra/xbrl/decompositionStore.ts";
import { InMemorySourceReviewStore } from "../../../infra/xbrl/sourceReviewStore.ts";
import { InMemoryFilingInsightStore } from "../../../infra/filing-insights/store.ts";
import type { SourceReviewArtifact } from "../../../infra/xbrl/sourceReviewStore.ts";
import type { PremapSummary } from "../../../financial-model/autoPremap.ts";
import { FinancialModelService, type CreateModelInput } from "../../../financial-model/service.ts";
import { InMemoryModelStore } from "../../../financial-model/store.ts";
import { financialModelSnapshotCodec } from "../../../financial-model/snapshotCodec.ts";
import type { Period } from "../../../financial-model/types.ts";
import type { FinancialModelSnapshot } from "../../../financial-model/operations.ts";
import type { RevisionChangeSummary } from "../../../financial-model/views.ts";
import type { FinancialModelToolDeps } from "../../../../mcp_tools/financial-model/financialModelTools.ts";
import { runMappingReviewLoop } from "../mappingReviewLoop.ts";
import { runFilingDecompositionLoop } from "../filingDecompositionLoop.ts";
import { runDecompositionReduceLoop } from "../decompositionReduceLoop.ts";
import { createDcfSubagentTool } from "../../../../mcp_tools/financial-model/dcfSubagentTool.ts";
import { mintTableFactId, type MintedTableFact } from "../../../infra/xbrl/decompositionTypes.ts";
import type { CandidateScheme } from "../../../infra/xbrl/decompositionTypes.ts";
import { filingTable } from "./curationFixtures.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function premapSummary(overrides: Partial<PremapSummary> = {}): PremapSummary {
  return {
    version: "auto-premap-v1",
    mapped: [{
      targetLineItemId: "revenue.total", targetLabel: "Total revenue",
      sourceRows: [{ sourceLineItemId: "source.income_statement.revenue", label: "Revenue", conceptQName: "us-gaap:Revenues" }],
      periodIds: ["FY2025"], basis: "concept_vocab", reconciliation: "ok",
    }],
    unmapped: { spineTargets: [], sourceRows: [] },
    demoted: [],
    ...overrides,
  };
}

function sourceReviewArtifact(premap?: PremapSummary): SourceReviewArtifact {
  const row = { sourceLineItemId: "source.income_statement.revenue", statement: "income_statement", label: "Revenue",
    unit: { kind: "currency", code: "USD" }, order: 1, conceptQName: "us-gaap:Revenue", depth: 0,
    dimensionSignature: "", dimensions: [], presentationAccessions: ["a"], sourceTableId: "table-1" };
  return { ingestionRunId: "run", filings: [], facts: [{ factId: "fact-1", status: "staged", lineItemId: row.sourceLineItemId,
    periodId: "FY2025", value: 100, unit: row.unit, provenance: { sourceType: "filing_xbrl", sourceRefs: ["#f"], asOfDate: "2025-01-01" } }],
    statementViews: {
      income_statement: { candidate: { periods: [], rows: [row] }, filingPresentations: [] },
      balance_sheet: { candidate: { periods: [], rows: [] }, filingPresentations: [] },
      cash_flow_statement: { candidate: { periods: [], rows: [] }, filingPresentations: [] },
    }, curatedTables: [], curations: [], dimensionalDisclosures: [],
    coverage: { requestedPeriodIds: ["FY2025"], statements: [], issues: [] },
    ...(premap ? { premap } : {}) } as unknown as SourceReviewArtifact;
}

const projection = { subagent: "mapping_review" as const, modelId: "m1", baseRevision: 1,
  lifecycleStage: "draft" as const, workbook: { periods: [], sections: {}, diagnostics: [] }, filingInsights: null };

function capturingProvider(responses: string[]): { router: ModelRouter; calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  const provider: LlmProvider = { name: "scripted", generate: async (messages) => {
    calls.push(messages.map((message) => ({ ...message })));
    return { text: responses[Math.min(calls.length - 1, responses.length - 1)]!,
      metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM" as const, provider: "scripted" } };
  } };
  return { router: new ModelRouter(provider), calls };
}

// ---------------------------------------------------------------------------
// 1. mappingReviewLoop baseContext carries premap
// ---------------------------------------------------------------------------

test("mappingReviewLoop base context embeds sourceReview.premap when present", async () => {
  const finalProposal = { rationale: "audited", payload: { selectedHistoricalPeriodIds: ["FY2025"], decisions: [],
    categoryLineItems: [], statementMappingPlans: [], categoryGroups: [] }, sourceRefs: [] };
  const { router, calls } = capturingProvider([JSON.stringify(finalProposal)]);
  await runMappingReviewLoop({ modelRouter: router, projection, sourceReview: sourceReviewArtifact(premapSummary()),
    tableStore: new InMemoryFilingTableStore(), task: "audit", systemPrompt: "system", maxSteps: 1 });
  const userMessage = calls[0]!.map((message) => message.content).join("\n");
  assert.match(userMessage, /"premap":\{"version":"auto-premap-v1"/);
  assert.match(userMessage, /"targetLineItemId":"revenue\.total"/);
});

test("mappingReviewLoop base context carries premap:null when the source review has none", async () => {
  const finalProposal = { rationale: "audited", payload: { selectedHistoricalPeriodIds: ["FY2025"], decisions: [],
    categoryLineItems: [], statementMappingPlans: [], categoryGroups: [] }, sourceRefs: [] };
  const { router, calls } = capturingProvider([JSON.stringify(finalProposal)]);
  await runMappingReviewLoop({ modelRouter: router, projection, sourceReview: sourceReviewArtifact(undefined),
    tableStore: new InMemoryFilingTableStore(), task: "audit", systemPrompt: "system", maxSteps: 1 });
  const userMessage = calls[0]!.map((message) => message.content).join("\n");
  assert.match(userMessage, /"premap":null/);
});

// ---------------------------------------------------------------------------
// 2. filingDecompositionLoop one-round schema retry
// ---------------------------------------------------------------------------

function decompositionLoopBase(store: InMemoryFilingTableStore, accession: string) {
  const minted: MintedTableFact[] = [];
  return { runId: "run1", accession, tableStore: store,
    faceRows: [{ sourceLineItemId: "row-rev", title: "Net sales", conceptQName: "us-gaap:Revenues" }],
    requestedPeriodIds: ["FY2025"], onMintedFacts: (facts: readonly MintedTableFact[]) => minted.push(...facts),
    task: "decompose revenue", systemPrompt: "map agent", minted } as const;
}

test("filingDecompositionLoop retries once on an invalid final proposal and succeeds with the corrected schemes", async () => {
  const store = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1", heading: "Net sales by product", rowLabels: ["iPhone", "Mac"] });
  store.saveTables("run1", [table]);
  const factId = mintTableFactId(table.accession, "seg-1", 1, "FY2025", "c-FY2025");
  const invalid = JSON.stringify({ rationale: "missing schemeId", sourceRefs: [], payload: { schemes: [{
    label: "by product", axisHint: "presentation-only", targetSourceLineItemId: "row-rev",
    children: [{ label: "iPhone", factRefs: [{ factId, periodId: "FY2025" }] }] }] } });
  const valid = JSON.stringify({ rationale: "corrected", sourceRefs: [], payload: { schemes: [{
    schemeId: "s1", label: "by product", axisHint: "presentation-only", targetSourceLineItemId: "row-rev",
    children: [{ label: "iPhone", factRefs: [{ factId, periodId: "FY2025" }] }] }] } });
  const { router, calls } = capturingProvider([invalid, valid]);
  const base = decompositionLoopBase(store, table.accession);
  const proposal = await runFilingDecompositionLoop({ ...base, modelRouter: router });
  assert.equal(proposal.schemes.length, 1);
  assert.equal(proposal.schemes[0]!.schemeId, "s1");
  assert.equal(calls.length, 2, "one retry round was taken");
  const secondRequestText = calls[1]!.map((message) => message.content).join("\n");
  assert.match(secondRequestText, /\[VALIDATION ERROR\]/);
  assert.match(secondRequestText, /schemeId/);
});

test("filingDecompositionLoop throws when the final proposal is invalid twice in a row", async () => {
  const store = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1" });
  store.saveTables("run1", [table]);
  const invalid = JSON.stringify({ rationale: "bad", sourceRefs: [], payload: { schemes: [{ nope: true }] } });
  const { router, calls } = capturingProvider([invalid, invalid]);
  const base = decompositionLoopBase(store, table.accession);
  await assert.rejects(runFilingDecompositionLoop({ ...base, modelRouter: router }), /schemes|schemeId/);
  assert.equal(calls.length, 2, "no further rounds are attempted after the second failure");
});

// ---------------------------------------------------------------------------
// 3. decompositionReduceLoop one-round schema retry
// ---------------------------------------------------------------------------

function candidate(id: string, children: Array<{ childId: string; label: string }>): CandidateScheme {
  return { candidateSchemeId: id, label: id, axisHint: "srt:ProductOrServiceAxis", targetSourceLineItemId: "row-rev",
    children: children.map((child) => ({ ...child, cells: { FY2025: { factId: `f-${child.childId}`, value: 1, accession: "a",
      filedAt: "2025-10-01", sourceAnchor: "#x" } } })),
    periodIds: ["FY2025"], coverage: Object.fromEntries(children.map((child) => [child.childId, ["FY2025"]])),
    residualRatioByPeriod: { FY2025: 0.01 }, flags: [], openQuestions: [] };
}

function reduceLoopBase(candidates: CandidateScheme[]) {
  return { runId: "run1", store: new InMemoryDecompositionStore(), task: "pick schemes", systemPrompt: "reduce agent", candidates } as const;
}

test("decompositionReduceLoop retries once on a schema-invalid decision and succeeds with the corrected ranking", async () => {
  const invalid = JSON.stringify({ rationale: "bad", sourceRefs: [], payload: { ranked: ["cs-1"] } }); // missing driverSchemeId
  const valid = JSON.stringify({ rationale: "corrected", sourceRefs: [], payload: { ranked: ["cs-1"], driverSchemeId: "cs-1" } });
  const { router, calls } = capturingProvider([invalid, valid]);
  const base = reduceLoopBase([candidate("cs-1", [{ childId: "ch-a", label: "A" }])]);
  const result = await runDecompositionReduceLoop({ ...base, modelRouter: router });
  assert.deepEqual(result.decision.ranked, ["cs-1"]);
  assert.equal(result.decision.driverSchemeId, "cs-1");
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.map((message) => message.content).join("\n"), /\[VALIDATION ERROR\]/);
});

test("decompositionReduceLoop retries once on an unknown candidateSchemeId and succeeds after correction", async () => {
  const invalid = JSON.stringify({ rationale: "bad", sourceRefs: [], payload: { ranked: ["cs-unknown"], driverSchemeId: null } });
  const valid = JSON.stringify({ rationale: "corrected", sourceRefs: [], payload: { ranked: ["cs-1"], driverSchemeId: "cs-1" } });
  const { router, calls } = capturingProvider([invalid, valid]);
  const base = reduceLoopBase([candidate("cs-1", [{ childId: "ch-a", label: "A" }])]);
  const result = await runDecompositionReduceLoop({ ...base, modelRouter: router });
  assert.deepEqual(result.decision.ranked, ["cs-1"]);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.map((message) => message.content).join("\n"), /unknown candidateSchemeId/);
});

test("decompositionReduceLoop retries once when driverSchemeId is not ranked[0] and succeeds after correction", async () => {
  const invalid = JSON.stringify({ rationale: "bad", sourceRefs: [], payload: { ranked: ["cs-1", "cs-2"], driverSchemeId: "cs-2" } });
  const valid = JSON.stringify({ rationale: "corrected", sourceRefs: [], payload: { ranked: ["cs-1", "cs-2"], driverSchemeId: "cs-1" } });
  const { router, calls } = capturingProvider([invalid, valid]);
  const base = reduceLoopBase([candidate("cs-1", [{ childId: "ch-a", label: "A" }]), candidate("cs-2", [{ childId: "ch-b", label: "B" }])]);
  const result = await runDecompositionReduceLoop({ ...base, modelRouter: router });
  assert.equal(result.decision.driverSchemeId, "cs-1");
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.map((message) => message.content).join("\n"), /driverSchemeId/);
});

test("decompositionReduceLoop throws when the decision is invalid twice in a row", async () => {
  const invalid = JSON.stringify({ rationale: "bad", sourceRefs: [], payload: { ranked: ["cs-unknown"], driverSchemeId: null } });
  const { router, calls } = capturingProvider([invalid, invalid]);
  const base = reduceLoopBase([candidate("cs-1", [{ childId: "ch-a", label: "A" }])]);
  await assert.rejects(runDecompositionReduceLoop({ ...base, modelRouter: router }), /unknown candidateSchemeId/);
  assert.equal(calls.length, 2, "no further rounds are attempted after the second failure");
});

// ---------------------------------------------------------------------------
// 4. subagentTool: remaps of engine-mapped targets require rationale
// ---------------------------------------------------------------------------

const OWNER = { agentId: "owner-1", sessionId: "s1" };
const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
];
const CREATE_INPUT: CreateModelInput = {
  modelId: "m1", ownerAgentId: OWNER.agentId, originSessionId: OWNER.sessionId, symbol: "TEST",
  metadata: {}, reportingCurrency: "USD", periods: PERIODS,
  preparedStatementRows: [{ sourceLineItemId: "source.income_statement.revenue", statement: "income_statement",
    label: "Revenue", unit: { kind: "currency", code: "USD" }, order: 1 }],
};

function mappingReviewProposal(rationale: string): string {
  return JSON.stringify({ rationale, sourceRefs: [], payload: { selectedHistoricalPeriodIds: ["FY2025"], decisions: [],
    categoryLineItems: [], statementMappingPlans: [{ targetLineItemId: "revenue.total", periodIds: ["FY2025"],
      members: [{ sourceLineItemId: "source.income_statement.revenue", treatment: "add" }], reviewDecisionId: "remap-1" }],
    categoryGroups: [] } });
}

function buildMappingReviewTool(premap: PremapSummary | undefined, responseText: string) {
  const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  new FinancialModelService(modelStore, OWNER.sessionId).createModel(CREATE_INPUT);
  const sourceReviewStore = new InMemorySourceReviewStore();
  sourceReviewStore.save("m1", sourceReviewArtifact(premap));
  const financial: FinancialModelToolDeps = { modelStore, insightStore: new InMemoryFilingInsightStore(),
    sourceReviewStore, ingestionStore: sourceReviewStore, decompositionStore: new InMemoryDecompositionStore() };
  const provider: LlmProvider = { name: "scripted", generate: async () => ({ text: responseText,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM" as const, provider: "scripted" } }) };
  return createDcfSubagentTool({ modelRouter: new ModelRouter(provider), financial, tableStore: new InMemoryFilingTableStore() });
}

test("subagentTool rejects a mapping_review remap of an engine-mapped target with empty rationale", async () => {
  const tool = buildMappingReviewTool(premapSummary(), mappingReviewProposal(""));
  await assert.rejects(tool.execute({ subagent: "mapping_review", modelId: "m1", task: "audit" }, OWNER), /requires rationale/);
});

test("subagentTool rejects a mapping_review remap of an engine-mapped target with missing rationale field", async () => {
  const responseText = JSON.stringify({ sourceRefs: [], payload: { selectedHistoricalPeriodIds: ["FY2025"], decisions: [],
    categoryLineItems: [], statementMappingPlans: [{ targetLineItemId: "revenue.total", periodIds: ["FY2025"],
      members: [{ sourceLineItemId: "source.income_statement.revenue", treatment: "add" }], reviewDecisionId: "remap-1" }],
    categoryGroups: [] } });
  const tool = buildMappingReviewTool(premapSummary(), responseText);
  await assert.rejects(tool.execute({ subagent: "mapping_review", modelId: "m1", task: "audit" }, OWNER), /requires rationale/);
});

test("subagentTool accepts a mapping_review remap of an engine-mapped target when a rationale is stated", async () => {
  const tool = buildMappingReviewTool(premapSummary(), mappingReviewProposal("engine miscategorized this row; moving it under total revenue"));
  const result = await tool.execute({ subagent: "mapping_review", modelId: "m1", task: "audit" }, OWNER);
  assert.equal(result.error, undefined);
  const proposal = result.generation_context!.data["proposal"] as Record<string, unknown>;
  assert.equal(proposal["modelId"], "m1");
});

test("subagentTool is a no-op for older source-review artifacts with no premap, even with empty rationale", async () => {
  const tool = buildMappingReviewTool(undefined, mappingReviewProposal(""));
  const result = await tool.execute({ subagent: "mapping_review", modelId: "m1", task: "audit" }, OWNER);
  assert.equal(result.error, undefined, "no premap on the artifact means the rationale gate never engages");
});
