// Step 8 — the REAL agent, end to end: the financial_modeling subagent runs its production loop
// (real system prompt, its own registered skill roster which it invokes for itself, the full tool
// registry, the 30-step budget with mutation seriality) against a committed model.
// The script builds the foundation and then makes NO modeling choices: forecast structure, WACC
// inputs, and terminal assumptions are all the agent's own; the lifecycle stage derives itself.
//
// Usage: node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/e2e_test/step8-agent-valuation.ts [SYMBOL]
// Reads step1-3 artifacts. Writes step8-agent-valuation.json. Needs a live LLM provider.
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import { createSubagentRegistry } from "../../../src/agent/subagents/registerSubagents.ts";
import { SubagentRuntime } from "../../../src/framework/subagent.ts";
import { SessionState } from "../../../src/framework/sessionState.ts";
import { SkillRegistry } from "../../../src/framework/skill.ts";
import { assertSubagentSkills } from "../../../src/framework/skill.ts";
import { createInvokeSkillTool, createReadSkillReferenceTool } from "../../../src/framework/skillTools.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { createFinancialModelTools, type FinancialModelToolDeps } from "../../../mcp_tools/financial-model/financialModelTools.ts";
import { createWorkbenchTools } from "../../../mcp_tools/financial-model/workbenchTools.ts";
import { createTreasuryYieldTool } from "../../../mcp_tools/financial-model/treasuryYieldTool.ts";
import { createFinancialSearchTool } from "../../../mcp_tools/search/financialSearchTool.ts";
import { resolveDetailLineItemIds } from "../../../src/infra/xbrl/spineFromUnified.ts";
import { InMemorySourceReviewStore } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import type { StatementUnificationRun } from "../../../src/agent/financial-modeling/statementUnificationAgent.ts";
import type { SpineMappingRun } from "../../../src/agent/financial-modeling/spineMappingAgent.ts";
import type { ResolvedFinancialModelSource } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { SqliteModelStore } from "../../../src/financial-model/store.ts";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { deriveWaccParameters, type DerivationDeps } from "../../../src/financial-model/waccDerivation.ts";
import type { WaccSheetComputedInput } from "../../../src/financial-model/waccSheet.ts";
import { fetchTreasury30y } from "../../../src/infra/market/treasuryYield.ts";
import { getSharedBarRepository } from "../../../src/data/stock/index.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import type { Period } from "../../../src/financial-model/types.ts";
import { join } from "node:path";
import { outputDirectory, readStep, symbol, writeStep } from "./common.ts";

const AGENT_ID = "e2e-agent";
// 单次 dispatch 跑全程:给足步数预算,不做外层分轮(分轮会丢掉未入模型的侦察上下文)。
const MAX_TOOL_STEPS = 60;
const source = readStep<ResolvedFinancialModelSource>("step1-source.json");
const { artifact: unified } = readStep<StatementUnificationRun>("step2-unified-statements.json");
const spine = readStep<SpineMappingRun>("step3-spine-mapping.json");

console.log(`# Step 8 — REAL-AGENT end-to-end valuation for ${symbol} → ${outputDirectory}`);

// ---- 持久化模型库:模型跨进程存活,中断后带着 model_id 重跑即从断点续起 ----
const modelStore = SqliteModelStore.open<FinancialModelSnapshot, RevisionChangeSummary>(
  join(outputDirectory, "step8-models.db"), financialModelSnapshotCodec);
const service = new FinancialModelService(modelStore, "e2e-session");
const modelId = `fm-${symbol.toLowerCase()}-agent-valuation`;
const resuming = modelStore.getRevision(modelId) !== undefined;

// ---- foundation: committed model with forecast periods, WACC computed rows filled, holes left ----
const actuals = source.periods.filter((p) => p.cls === "actual");
const last = actuals[actuals.length - 1]!;
const lastYear = Number(last.id.replace("FY", ""));
const forecast: Period[] = Array.from({ length: 5 }, (_, i) => {
  const year = lastYear + 1 + i;
  return { id: `FY${year}`, label: `FY${year}`, cls: "forecast" as const,
    start: last.start.replace(String(lastYear), String(year)), end: last.end.replace(String(lastYear), String(year)) };
});
const periods = [...actuals, ...forecast];
const actualIds = actuals.map((p) => p.id);

if (resuming) {
  const revision = modelStore.getRevision(modelId)!;
  console.log(`Resuming existing model at revision ${revision.revision} (${revision.lifecycleStage}); foundation build skipped.`);
} else {
  service.createModel({ modelId, ownerAgentId: AGENT_ID, originSessionId: "e2e-session", symbol,
    metadata: { companyName: source.company.title }, reportingCurrency: source.reportingCurrency,
    periods, preparedStatementRows: [] });
  const labelByRowId = new Map([...unified.rows, ...(unified.breakdownRows ?? [])].map((row) => [row.rowId, row.label]));
  const detailIds = resolveDetailLineItemIds(spine.decision, unified);
  const labels = Object.fromEntries(spine.decision.detailRows.map((detail) => [
    detailIds[detail.rowId]!, labelByRowId.get(detail.rowId) ?? detail.rowId]));
  let current = service.commitSpineFacts(modelId, 0, { facts: spine.facts, labels, historicalPeriodIds: actualIds });

  const sheet = modelStore.getRevision(modelId)!.snapshot.waccSheet!;
  const repository = await getSharedBarRepository();
  const derivationDeps: DerivationDeps = {
    dailyCloses: async (sym, from, to) => repository === undefined ? []
      : (await repository.getBarsBetween(sym, "1Day", from, to)).map((bar) => ({ t: bar.t, c: bar.c })),
    treasury30y: (asOf) => fetchTreasury30y(asOf),
  };
  const derivation = await deriveWaccParameters({ symbol, asOfDate: sheet.asOfDate,
    facts: modelStore.getRevision(modelId)!.snapshot.facts, periods, deps: derivationDeps });
  const computed: WaccSheetComputedInput[] = [
    ...derivation.derived.flatMap((entry) => {
      const rowId = ({ beta: "beta", costOfDebt: "cost_of_debt", equityValue: "equity_value", totalDebt: "total_debt",
        taxRate: "effective_tax_rate", riskFreeRate: "risk_free_rate" } as const)[entry.name as string];
      return rowId ? [{ rowId, value: entry.value, provenance: { sourceType: entry.sourceType,
        sourceRefs: entry.sourceRefs, asOfDate: entry.asOfDate, rationale: entry.rationale } } as WaccSheetComputedInput] : [];
    }),
    ...(derivation.cashAndEquivalents ? [{ rowId: "cash_and_equivalents_value",
      value: derivation.cashAndEquivalents.value,
      provenance: { sourceType: "filing", sourceRefs: derivation.cashAndEquivalents.sourceRefs,
        asOfDate: sheet.asOfDate, rationale: derivation.cashAndEquivalents.rationale } } as WaccSheetComputedInput] : []),
  ];
  current = service.refreshWaccSheet(modelId, current.revision, computed);
  console.log(`Foundation ready at revision ${current.revision}; WACC holes left for the agent:`,
    modelStore.getRevision(modelId)!.snapshot.waccSheet!.rows.filter((r) => r.value === null).map((r) => r.rowId).join(", "));
}

// ---- source review store so the read tools and library imports work ----
const sourceReviewStore = new InMemorySourceReviewStore();
sourceReviewStore.save(modelId, { ingestionRunId: "e2e", coverage: { requestedPeriodIds: [], statements: [], issues: [] },
  dimensionalDisclosures: [], curatedTables: [], curations: [], filings: [], facts: [],
  statementViews: {} as never, unifiedStatements: unified } as never);
const deps = { modelStore, insightStore: new InMemoryFilingInsightStore(),
  sourceReviewStore, ingestionStore: sourceReviewStore } as FinancialModelToolDeps;

// ---- the REAL tool registry and the REAL skill roster ----
// No guidance is spliced into the task here: the agent owns dcf-modeling and calls
// invoke_skill for itself, exactly as it does in production.
const skills = new SkillRegistry();
await skills.loadFromDirectory("skills");
const subagents = createSubagentRegistry();
assertSubagentSkills(subagents.list(), skills);

const tools = new McpToolRegistry();
for (const tool of createFinancialModelTools(deps)) tools.register(tool);
for (const tool of createWorkbenchTools(deps)) tools.register(tool);
tools.register(createTreasuryYieldTool());
tools.register(createFinancialSearchTool());
tools.register(createInvokeSkillTool(skills));
tools.register(createReadSkillReferenceTool(skills));

const definition = { ...subagents.get("financial_modeling"),
  defaultTools: tools.list().map((tool) => tool.name), maxToolSteps: MAX_TOOL_STEPS };
const runtime = new SubagentRuntime(new ModelRouter(resolveLlmProvider()), tools, skills);
const state = new SessionState("e2e-session", new Date().toISOString());
state.beginTurn("step8");

const baseTask = resuming
  ? `Resume and finish the DCF for ${symbol}, model_id ${modelId}. Read the model first to see what is `
    + `already filled, keep what holds, and complete only what is missing through to the valued stage.`
  : `Continue the DCF for ${symbol}. The data foundation is done: history is committed and `
  + `the WACC sheet's computed rows are filled. Your work now: analyze the profit sources, author the `
  + `forecast (your judgment on unified vs per-segment growth), complete the WACC sheet and the `
  + `terminal assumptions, and finish when the model reads as valued. model_id ${modelId}.`;

const task = baseTask;
const dispatch = state.recordDispatch("financial_modeling", task);
await runtime.run(definition, { sessionId: "e2e-session", agentId: AGENT_ID, taskId: dispatch.event_id,
  request: { agent: "financial_modeling", task, model_id: modelId },
  allowedTools: tools.list(), state, parentEventId: dispatch.event_id });
const summary = state.task(dispatch.event_id)?.result?.summary ?? "";
console.log(`agent result: ${summary.slice(0, 300)}`);
console.log(`lifecycle now: ${modelStore.getRevision(modelId)!.lifecycleStage}`);

// ---- the verdict, read from the model the agent built ----
const snapshot = modelStore.getRevision(modelId)!.snapshot;
const valuation = snapshot.valuation as unknown as Record<string, unknown> | null;
const assumptions = snapshot.assumptions.map((a) => ({ lineItemId: a.lineItemId,
  values: a.payload.kind === "values" ? a.payload.values : "n/a", sourceType: a.sourceType, rationale: a.rationale }));
const customRows = snapshot.lineItems.filter((i) => i.id.startsWith("metric.custom."))
  .map((i) => ({ id: i.id, description: i.description }));
const waccRow = snapshot.waccSheet?.rows.find((r) => r.rowId === "wacc");
writeStep("step8-agent-valuation.json", { modelId, lifecycle: snapshot.lifecycleStage,
  finalSummary: summary, wacc: waccRow?.value ?? null, assumptions, customRows, valuation });

console.log(`\n## Agent's assumptions (${assumptions.length})`);
for (const a of assumptions) console.log(`  ${a.lineItemId}: [${Array.isArray(a.values) ? a.values.join(", ") : a.values}] (${a.sourceType}) — ${a.rationale.slice(0, 140)}`);
console.log(`\n## Agent's custom analysis rows (${customRows.length})`);
for (const row of customRows) console.log(`  ${row.id} — ${(row.description ?? "").slice(0, 110)}`);
console.log(`\nWACC: ${waccRow?.value === null || waccRow?.value === undefined ? "unresolved" : (waccRow.value * 100).toFixed(2) + "%"}`);
if (snapshot.lifecycleStage === "valued" && valuation) {
  const perpetuity = valuation["perpetuityGrowth"] as Record<string, number>;
  const exit = valuation["exitMultiple"] as Record<string, number>;
  console.log(`Perpetuity: $${perpetuity["impliedValuePerShare"]?.toFixed(2)} /sh | Exit: $${exit["impliedValuePerShare"]?.toFixed(2)} /sh`);
  console.log(`\n**PASS** — the agent reached valued on its own judgment in one dispatch.`);
} else {
  console.log(`\n**INCOMPLETE** — lifecycle ${snapshot.lifecycleStage}; see summary above.`);
  process.exit(1);
}
