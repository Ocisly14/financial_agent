import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryWaccParameterStore } from "../../../src/financial-model/waccStore.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import type { BarRepository, DailyBar } from "../../../src/data/stock/index.ts";
import type { Fact, Period } from "../../../src/financial-model/types.ts";
import { COMPUTE_WACC_TOOL, createComputeWaccTool } from "../waccTool.ts";
import { createFinancialModelTools } from "../financialModelTools.ts";
import type { FinancialModelToolDeps } from "../financialModelTools.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
  { id: "FY2026", label: "FY2026", start: "2026-01-01", end: "2026-12-31", cls: "forecast" },
  { id: "FY2027", label: "FY2027", start: "2027-01-01", end: "2027-12-31", cls: "forecast" },
];

const committedFact = (lineItemId: string, periodId: string, value: number): Fact => ({
  factId: `spine.${lineItemId}.${periodId}`, status: "committed", lineItemId, periodId, value,
  // The engine checks a fact's unit against its row's, so a share count cannot arrive as currency.
  unit: lineItemId === "diluted_shares" ? { kind: "shares" } : { kind: "currency", code: "USD" },
  provenance: { sourceType: "unified_statements", sourceRefs: [], asOfDate: "2026-08-07" },
});

/**
 * Six years of daily closes ending today. It has to reach the present: the equity value is diluted
 * shares times the LAST close, and the tool path uses the real clock, so a series that stops months
 * ago silently costs that term.
 */
function bars(seed: number, drift: number): DailyBar[] {
  const days = 1600;
  const out: DailyBar[] = [];
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Math.round(days * 7 / 5));
  for (let index = 0; index < days; index += 1) {
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    const c = seed * Math.exp(drift * index + Math.sin(index * 0.7) * 0.01);
    out.push({ t: date.toISOString().slice(0, 10), o: c, h: c, l: c, c, v: 1, vw: c });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

function repository(): BarRepository {
  const series = new Map([["AAPL", bars(100, 0.0004)], ["SPY", bars(300, 0.0002)]]);
  return {
    getBars: async () => [],
    getBarsBetween: async (symbol, _timeframe, from, to) =>
      (series.get(symbol) ?? []).filter((bar) => bar.t >= from && bar.t <= to),
  };
}

function harness() {
  const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  const review = new InMemorySourceReviewStore();
  const parameterStore = new InMemoryWaccParameterStore();
  const financial: FinancialModelToolDeps = { modelStore, insightStore: new InMemoryFilingInsightStore(),
    sourceReviewStore: review, ingestionStore: review, waccParameterStore: parameterStore };
  const service = new FinancialModelService(modelStore, "session-1");
  service.createModel({ modelId: "fm-1", ownerAgentId: "agent-1", originSessionId: "session-1", symbol: "AAPL",
    metadata: {}, reportingCurrency: "USD", periods: PERIODS, preparedStatementRows: [] });
  return { modelStore, financial, service, parameterStore };
}

function fixture(facts: Fact[]) {
  const { modelStore, financial, service, parameterStore } = harness();
  // Land the facts through the real path: staged by spine mapping, then committed by the review the
  // owning agent performs. Derivation reads committed facts only, so both steps matter.
  if (facts.length > 0) {
    const staged = service.stageSpineFacts("fm-1", 0, { facts: facts.map((fact) => ({ ...fact, status: "staged" })),
      historicalPeriodIds: ["FY2024", "FY2025"] });
    service.reviewFacts("fm-1", staged.revision, {
      decisions: facts.map((fact) => ({ decisionId: `commit-${fact.factId}`, factId: fact.factId,
        action: "commit" as const, mappedLineItemId: fact.lineItemId!, rationale: "fixture",
        reviewedBy: "agent-1", reviewedAt: "2026-02-02T00:00:00Z" })),
      selectedHistoricalPeriodIds: ["FY2024", "FY2025"],
      categoryLineItems: [], statementMappingPlans: [], categoryGroups: [],
    });
  }
  const tool = createComputeWaccTool({ financial, parameterStore,
    barRepository: async () => repository(), now: () => new Date("2026-02-02T00:00:00Z") });
  return { tool, modelStore, parameterStore };
}

const FULL_FACTS = [
  committedFact("income_tax_expense", "FY2024", 16_000), committedFact("pretax_income", "FY2024", 100_000),
  committedFact("income_tax_expense", "FY2025", 16_000), committedFact("pretax_income", "FY2025", 100_000),
  committedFact("debt", "FY2024", 90_000), committedFact("debt", "FY2025", 100_000),
  committedFact("diluted_shares", "FY2025", 1_000),
  committedFact("interest_expense", "FY2025", 3_800),
];

const context = { agentId: "agent-1", sessionId: "session-1" } as never;

/**
 * Commits the fixture facts through review_financial_model_history — the tool the DCF Agent actually
 * calls — so the automatic derivation fires the way it does in production rather than being invoked
 * directly by the test.
 */
async function commitFactsThroughTools(facts: Fact[]) {
  const { financial, parameterStore, modelStore, service } = harness();
  const staged = service.stageSpineFacts("fm-1", 0, { facts: facts.map((fact) => ({ ...fact, status: "staged" as const })),
    historicalPeriodIds: ["FY2024", "FY2025"] });
  const tools = new Map(createFinancialModelTools({ ...financial,
    barRepository: async () => repository() }).map((tool) => [tool.name, tool]));
  const commitResult = await tools.get("review_financial_model_history")!.execute({
    modelId: "fm-1", expectedRevision: staged.revision,
    decisions: facts.map((fact) => ({ decisionId: `commit-${fact.factId}`, factId: fact.factId,
      action: "commit", mappedLineItemId: fact.lineItemId!, rationale: "fixture", reviewedBy: "agent-1" })),
    selectedHistoricalPeriodIds: ["FY2024", "FY2025"],
    categoryLineItems: [], statementMappingPlans: [], categoryGroups: [],
  }, context);
  return { commitResult, tools, parameterStore, modelStore };
}

test("the engine derives every term it can and names the ones it cannot, changing nothing", async () => {
  const { tool, parameterStore, modelStore } = fixture(FULL_FACTS);
  const before = modelStore.getRevision("fm-1")!.revision;
  const result = await tool.execute({ modelId: "fm-1" }, context);

  assert.equal(result.error, undefined);
  const data = (result.generation_context!.data as never as { wacc: { complete: boolean; parameters: Array<{ name: string; value: number }>; missing: Array<{ name: string; reason: string }> } }).wacc;
  assert.equal(data.complete, false);
  // Five derived without the agent lifting a finger; the two with no source are the ones it is asked for.
  assert.deepEqual(data.parameters.map((p) => p.name).sort(),
    ["beta", "costOfDebt", "equityValue", "taxRate", "totalDebt"]);
  assert.deepEqual(data.missing.map((m) => m.name), ["riskFreeRate", "equityRiskPremium"]);
  assert.ok(data.missing[1]!.reason.includes("no measurable source"), data.missing[1]!.reason);

  const tax = data.parameters.find((p) => p.name === "taxRate")!;
  assert.ok(Math.abs(tax.value - 0.16) < 1e-9, `${tax.value}`);
  // interest 3,800 over average debt (90,000 + 100,000)/2 = 95,000 → 4.0%
  assert.ok(Math.abs(data.parameters.find((p) => p.name === "costOfDebt")!.value - 0.04) < 1e-9);
  // The derived terms are persisted, so a later call does not recompute from nothing.
  assert.equal(parameterStore.list("fm-1").length, 5);
  // A preview commits no revision.
  assert.equal(modelStore.getRevision("fm-1")!.revision, before);
});

test("a missing spine target is reported as the mapping gap it is, not as a defaulted number", async () => {
  const { tool } = fixture(FULL_FACTS.filter((fact) => fact.lineItemId !== "debt"));
  const result = await tool.execute({ modelId: "fm-1" }, context);
  const data = (result.generation_context!.data as never as { wacc: { missing: Array<{ name: string; reason: string }> } }).wacc;
  const debt = data.missing.find((entry) => entry.name === "totalDebt")!;
  assert.ok(debt.reason.includes("spine target `debt`"), debt.reason);
  assert.ok(debt.reason.includes("spine_mapping"), debt.reason);
});

test("overrides complete the set and the preview computes without committing", async () => {
  const { tool, modelStore } = fixture(FULL_FACTS);
  const before = modelStore.getRevision("fm-1")!.revision;
  const result = await tool.execute({ modelId: "fm-1",
    overrides: { riskFreeRate: 0.0465, equityRiskPremium: 0.05 },
    rationale: "30-year Treasury on 2026-02-02; ERP from Damodaran's implied series." }, context);

  assert.equal(result.error, undefined);
  const data = (result.generation_context!.data as never as { wacc: { complete: boolean; committed: boolean; wacc: number } }).wacc;
  assert.equal(data.complete, true);
  assert.equal(data.committed, false);
  assert.ok(data.wacc > 0 && data.wacc < 0.5, `${data.wacc}`);
  assert.ok(result.summary.includes("Not yet committed"), result.summary);
  assert.equal(modelStore.getRevision("fm-1")!.revision, before);
});

test("an override without a rationale is refused: it replaces a term the engine measured", async () => {
  const { tool } = fixture(FULL_FACTS);
  const result = await tool.execute({ modelId: "fm-1", overrides: { costOfDebt: 0.052 } }, context);
  assert.equal(result.error?.code, "wacc_override_needs_rationale");
});

test("naming a revision finalizes the WACC as a committed assumption over the forecast periods", async () => {
  const { tool, modelStore } = fixture(FULL_FACTS);
  const result = await tool.execute({ modelId: "fm-1", expectedRevision: modelStore.getRevision("fm-1")!.revision,
    overrides: { riskFreeRate: 0.0465, equityRiskPremium: 0.05, costOfDebt: 0.052 },
    sourceRefs: ["search:AAPL 2035 notes yield"],
    rationale: "Cost of debt from the current bond yield rather than the trailing filing average." }, context);

  assert.equal(result.error, undefined);
  const data = (result.generation_context!.data as never as { wacc: { committed: boolean; revision: number; wacc: number } }).wacc;
  assert.equal(data.committed, true);

  const snapshot = modelStore.getRevision("fm-1")!.snapshot;
  const assumption = snapshot.assumptions.find((entry) => entry.lineItemId === "wacc")!;
  assert.deepEqual(assumption.periods, ["FY2026", "FY2027"]);
  assert.equal(assumption.payload.kind, "values");
  if (assumption.payload.kind === "values") {
    assert.deepEqual(assumption.payload.values, [data.wacc, data.wacc]);
  }
  // The assumption points back at the stored terms, so reading it alone still shows WACC was computed.
  assert.ok(assumption.sourceRefs.includes("wacc_parameter:beta"), assumption.sourceRefs.join(", "));
  assert.ok(assumption.sourceRefs.includes("search:AAPL 2035 notes yield"));
  assert.ok(assumption.rationale.includes("computed from stored parameters"), assumption.rationale);
});

test("another agent's model is not reachable", async () => {
  const { tool } = fixture(FULL_FACTS);
  const result = await tool.execute({ modelId: "fm-1" }, { agentId: "agent-2", sessionId: "s" } as never);
  assert.equal(result.error?.code, "financial_model_not_found");
  assert.equal(tool.name, COMPUTE_WACC_TOOL);
});

test("committing facts derives the WACC terms by itself and reports them on that commit", async () => {
  // Nobody asked for WACC here: this is the ordinary fact-review commit, and the status rides along.
  const { commitResult } = await commitFactsThroughTools(FULL_FACTS);
  assert.equal(commitResult.error, undefined);
  const status = commitResult.generation_context!.data["wacc_status"] as never as
    { parameters: Array<{ name: string }>; missing: Array<{ name: string; reason: string }> };
  assert.ok(status, "the commit must report where WACC stands");
  assert.deepEqual(status.parameters.map((entry) => entry.name).sort(),
    ["beta", "costOfDebt", "equityValue", "taxRate", "totalDebt"]);
  assert.deepEqual(status.missing.map((entry) => entry.name), ["riskFreeRate", "equityRiskPremium"]);
  // The summary says it in one line, so the agent can act without opening the payload.
  assert.ok(commitResult.summary.includes("5/7 term(s) derived"), commitResult.summary);
  assert.ok(commitResult.summary.includes("riskFreeRate"), commitResult.summary);
});

test("reading the model shows the same WACC picture, so the agent can always see where it is", async () => {
  const { tools } = await commitFactsThroughTools(FULL_FACTS);
  const read = await tools.get("get_financial_model")!.execute({ modelId: "fm-1" }, context);
  const status = read.generation_context!.data["wacc_status"] as never as { missing: Array<{ name: string }> };
  assert.deepEqual(status.missing.map((entry) => entry.name), ["riskFreeRate", "equityRiskPremium"]);
  assert.ok(read.summary.includes("WACC:"), read.summary);
});
