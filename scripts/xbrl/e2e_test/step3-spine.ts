// Step 3/3 — spine_mapping agent (stage Ⓑ + deterministic spine backfill/coverage).
// Reads step2's unified statements artifact, seeds an in-memory model + source review, and runs the
// REAL spine_mapping agent through the production path: process-registered tools, a Dispatcher, one
// dispatched run. An accepted mapping commits its facts into the seeded workbook; this prints what
// landed there, plus the final decision teed off the delivery tools for inspection.
//
// Usage: node --env-file=.env --experimental-strip-types scripts/xbrl/e2e_test/step3-spine.ts [SYMBOL]
// Needs a live LLM provider. Reads step2-unified-statements.json; writes:
//   step3-spine-mapping.json — { decision, facts, coverageGaps, unresolvedFindings }
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import { createSpineAgentTools } from "../../../mcp_tools/financial-model/spineDeliveryTools.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { SkillRegistry } from "../../../src/framework/skill.ts";
import { SessionState } from "../../../src/framework/sessionState.ts";
import { SubagentRuntime } from "../../../src/framework/subagent.ts";
import { Dispatcher } from "../../../src/framework/dispatcher.ts";
import { createSubagentRegistry } from "../../../src/agent/subagents/registerSubagents.ts";
import type { JsonObject } from "../../../src/framework/types.ts";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore, type SourceReviewArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { CANONICAL_MAPPING_IDS, REQUIRED_MAPPING_IDS } from "../../../src/financial-model/skeleton.ts";
import { applySpinePatch, buildSpineFromUnified, type SpineDecision, type SpinePatch } from "../../../src/infra/xbrl/spineFromUnified.ts";
import type { UnifiedStatementsArtifact } from "../../../src/infra/xbrl/unifiedStatements.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { outputDirectory, readStep, symbol, writeStep } from "./common.ts";

const { artifact: unified } = readStep<{ artifact: UnifiedStatementsArtifact }>("step2-unified-statements.json");

console.log(`# Step 3 — spine mapping for ${symbol} (${unified.periods.join(", ")}) → ${outputDirectory}`);
console.log(`Unified rows in: ${unified.rows.length}`);

// ── Seed the stores: a fresh model whose review already holds step2's artifact ─────────
const MODEL_ID = "e2e-fm";
const TENANT = "e2e-agent";
const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
const sourceReviewStore = new InMemorySourceReviewStore();
const periods = unified.periods.map((id) => {
  const year = Number(id.replace(/\D/g, ""));
  return { id, label: id, start: `${year}-01-01`, end: `${year}-12-31`, cls: "actual" as const };
});
new FinancialModelService(modelStore, "e2e-spine").createModel({
  modelId: MODEL_ID, ownerTenantId: TENANT, originSessionId: "e2e-spine", symbol,
  metadata: {}, reportingCurrency: "USD", periods, preparedStatementRows: [],
});
const view = { candidate: { periods, rows: [] }, filingPresentations: [] };
sourceReviewStore.save(MODEL_ID, {
  ingestionRunId: "e2e-ing", coverage: { requestedPeriodIds: [], statements: [], issues: [] },
  dimensionalDisclosures: [], curatedTables: [], curations: [], filings: [], facts: [],
  statementViews: { income_statement: view, balance_sheet: view, cash_flow_statement: view },
  unifiedStatements: unified,
} as unknown as SourceReviewArtifact);

// ── Tools + a tee: the decision lives in the agent's submissions, so record the last one ──
let lastDecision: SpineDecision | undefined;
const registry = new McpToolRegistry();
for (const tool of createSpineAgentTools({ modelStore, sourceReviewStore,
  insightStore: new InMemoryFilingInsightStore(), ingestionStore: sourceReviewStore })) {
  const execute = tool.execute;
  registry.register({ ...tool, execute: async (input: JsonObject, context) => {
    if (tool.name === "submit_spine_decision") lastDecision = input["decision"] as unknown as SpineDecision;
    if (tool.name === "patch_spine_decision" && lastDecision) {
      lastDecision = applySpinePatch(lastDecision, input["patch"] as unknown as SpinePatch);
    }
    return execute(input, context);
  } });
}

const skills = new SkillRegistry();
await skills.loadFromDirectory("skills");
const subagents = createSubagentRegistry();
const runtime = new SubagentRuntime(new ModelRouter(resolveLlmProvider()), registry, skills, subagents);
const state = new SessionState("e2e-spine", new Date().toISOString());
state.beginTurn("step3");
const dispatcher = new Dispatcher("e2e-spine", subagents, runtime, registry, state, TENANT);

const { result } = await dispatcher.runOne({
  agent: "spine_mapping",
  task: `Map ${symbol}'s unified statements onto the canonical spine.`,
});
console.log(`\nAgent finished (${result.status}): ${result.summary}`);
if (!lastDecision) {
  console.error("\n**FAIL** — the run ended without submitting a mapping.");
  process.exit(1);
}

// Rebuild deterministically from the final decision, exactly as the delivery evaluation does.
const spine = buildSpineFromUnified({ decision: lastDecision, unified,
  spineIds: new Set(CANONICAL_MAPPING_IDS), requiredIds: REQUIRED_MAPPING_IDS });

const money = (value: number) => value.toLocaleString("en-US");
const factByLine = new Map(spine.facts.map((f) => [`${f.lineItemId}|${f.periodId}`, f]));

console.log("\n## Spine mappings\n");
console.log("| targetId | rows | period | value |");
console.log("| --- | --- | --- | ---: |");
for (const mapping of lastDecision.mappings) for (const periodId of unified.periods) {
  const fact = factByLine.get(`${mapping.targetId}|${periodId}`);
  if (fact) console.log(`| ${mapping.targetId} | ${mapping.rowIds.join(" + ")} | ${periodId} | ${money(fact.value)} |`);
}

console.log("\n## Detail rows");
if (lastDecision.detailRows.length === 0) console.log("None.");
for (const detail of lastDecision.detailRows) console.log(`  - detail.${detail.parentTargetId}.${detail.rowId}: ${detail.rationale}`);

console.log("\n## Excluded");
if (lastDecision.excluded.length === 0) console.log("None.");
for (const drop of lastDecision.excluded) console.log(`  - ${drop.rowId}: ${drop.reason}`);

console.log("\n## Spine gaps");
if (lastDecision.spineGaps.length === 0) console.log("None.");
for (const gap of lastDecision.spineGaps) console.log(`  - ${gap.targetId}: ${gap.reason}`);

console.log("\n## Coverage gaps");
if (spine.coverageGaps.length === 0) console.log("None.");
for (const gap of spine.coverageGaps) console.log(`  - ${gap.targetId} @ ${gap.periodId}`);

console.log(`\nFindings: ${spine.findings.length}`);
for (const finding of spine.findings) console.log(`  - ${finding}`);

const spinePath = writeStep("step3-spine-mapping.json", { decision: lastDecision, facts: spine.facts,
  coverageGaps: spine.coverageGaps, unresolvedFindings: spine.findings });
console.log(`\nWrote ${spinePath}`);
console.log(spine.findings.length === 0 && result.status === "ok" ? "\n**PASS**" : "\n**CHECK THE FINDINGS ABOVE**");
