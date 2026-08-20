// Step 2/3 — statement_unification agent (stage Ⓐ + deterministic backfill/verify).
// Reads step1's extraction, seeds an in-memory model + source review, and runs the REAL
// statement_unification agent through the same path production uses: process-registered tools,
// a Dispatcher, delegate-style dispatch. The agent loads its working set from the seeded store,
// and its accepted decision persists the unified statements there — which is what this prints.
//
// Usage: node --env-file=.env --experimental-strip-types scripts/xbrl/e2e_test/step2-unify.ts [SYMBOL]
// Needs a live LLM provider. Reads step1-*.json; writes:
//   step2-concept-inventory.json   — the inventory the agent's load tool sees
//   step2-unified-statements.json  — { summary, artifact } (rows, values, restatements, roll-up breaks)
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import { createUnificationAgentTools } from "../../../mcp_tools/financial-model/unificationDeliveryTools.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { SkillRegistry } from "../../../src/framework/skill.ts";
import { SessionState } from "../../../src/framework/sessionState.ts";
import { SubagentRuntime } from "../../../src/framework/subagent.ts";
import { Dispatcher } from "../../../src/framework/dispatcher.ts";
import { createSubagentRegistry } from "../../../src/agent/subagents/registerSubagents.ts";
import type { Period } from "../../../src/financial-model/types.ts";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import { InMemorySourceReviewStore, type SourceReviewArtifact } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { InMemoryFilingTableStore } from "../../../src/infra/xbrl/filingTableStore.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { buildConceptInventory } from "../../../src/infra/xbrl/conceptInventory.ts";
import type { ArelleExtractionResponse } from "../../../src/infra/xbrl/types.ts";
import type { ResolvedFinancialModelSource } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import { outputDirectory, readStep, symbol, writeStep } from "./common.ts";

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
const configuredTimeoutMs = Number(process.env["E2E_TIMEOUT_MS"] ?? DEFAULT_STEP_TIMEOUT_MS);
const stepTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
  ? configuredTimeoutMs
  : DEFAULT_STEP_TIMEOUT_MS;

const source = readStep<ResolvedFinancialModelSource>("step1-source.json");
const extraction = readStep<ArelleExtractionResponse>("step1-extraction.json");
const requestedPeriods: Period[] = source.periods.filter((p) => p.cls === "actual");

console.log(`# Step 2 — statement unification for ${symbol} (${requestedPeriods.map((p) => p.id).join(", ")}) → ${outputDirectory}`);
console.log(`Step timeout: ${(stepTimeoutMs / 60_000).toFixed(1)} minute(s)`);

// For inspection only — the agent builds the same inventory itself, from the seeded store.
const inventory = buildConceptInventory({ filings: extraction.filings, requestedPeriods });
const inventoryPath = writeStep("step2-concept-inventory.json", inventory);
console.log(`\nConcept inventory: ${inventory.length} rows (${inventoryPath})`);

const tables = extraction.filings.flatMap((filing) => filing.tables ?? []);
console.log(`Dimension exploration over ${tables.length} table(s)`);

// ── Seed the stores the way step1's extraction would have ──────────────────
const MODEL_ID = "e2e-fm";
const TENANT = "e2e-agent";
const INGESTION = "e2e-ing";
const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
const sourceReviewStore = new InMemorySourceReviewStore();
const tableStore = new InMemoryFilingTableStore();
tableStore.saveTables(INGESTION, tables);
new FinancialModelService(modelStore, "e2e-unify").createModel({
  modelId: MODEL_ID, ownerTenantId: TENANT, originSessionId: "e2e-unify", symbol,
  metadata: {}, reportingCurrency: source.reportingCurrency ?? "USD", periods: source.periods, preparedStatementRows: [],
});
const view = { candidate: { periods: requestedPeriods, rows: [] }, filingPresentations: [] };
sourceReviewStore.save(MODEL_ID, {
  ingestionRunId: INGESTION, coverage: { requestedPeriodIds: [], statements: [], issues: [] },
  dimensionalDisclosures: [], curatedTables: [], curations: [], filings: [], facts: [],
  statementViews: { income_statement: view, balance_sheet: view, cash_flow_statement: view },
  presentationExtracts: extraction.filings,
} as unknown as SourceReviewArtifact);

// ── The production path: registered tools, a Dispatcher, one dispatched run ───────────────
const registry = new McpToolRegistry();
for (const tool of createUnificationAgentTools({ modelStore, sourceReviewStore, tableStore })) registry.register(tool);
const skills = new SkillRegistry();
await skills.loadFromDirectory("skills");
const subagents = createSubagentRegistry();
const runtime = new SubagentRuntime(new ModelRouter(resolveLlmProvider()), registry, skills, subagents);
const state = new SessionState("e2e-unify", new Date().toISOString());
state.beginTurn("step2");
const dispatcher = new Dispatcher("e2e-unify", subagents, runtime, registry, state, TENANT);

const { result } = await dispatcher.runOne({
  agent: "statement_unification",
  task: `Unify ${symbol}'s extracted filings into multi-year statements.`,
  timeout_ms: stepTimeoutMs,
});
console.log(`\nAgent finished (${result.status}): ${result.summary}`);

const unified = sourceReviewStore.get(MODEL_ID)?.unifiedStatements;
if (!unified) {
  console.error("\n**FAIL** — the run ended without an accepted decision; nothing was stored.");
  process.exit(1);
}

const money = (value: number) => value.toLocaleString("en-US");
console.log("\n## Unified statements\n");
for (const statement of ["income_statement", "balance_sheet", "cash_flow_statement"] as const) {
  const rows = unified.rows.filter((row) => row.statement === statement);
  if (rows.length === 0) continue;
  console.log(`\n### ${statement}\n`);
  console.log(`| row | label | ${unified.periods.join(" | ")} |`);
  console.log(`| --- | --- |${unified.periods.map(() => " ---: |").join("")}`);
  for (const row of rows) {
    const cells = unified.periods.map((p) => { const v = row.values[p]; return v === null || v === undefined ? "—" : money(v); });
    console.log(`| ${row.rowId} | ${row.label} | ${cells.join(" | ")} |`);
  }
}

const breakdownRows = unified.breakdownRows ?? [];
if (breakdownRows.length > 0) {
  console.log("\n### dimension breakdowns\n");
  console.log(`| row | parent | axis | under | label | ${unified.periods.join(" | ")} |`);
  console.log(`| --- | --- | --- | --- | --- |${unified.periods.map(() => " ---: |").join("")}`);
  for (const row of breakdownRows) {
    const cells = unified.periods.map((p) => { const v = row.values[p]; return v === null || v === undefined ? "—" : money(v); });
    console.log(`| ${row.rowId} | ${row.parentRowId} | ${row.axisQName} | ${row.parentMemberQName ?? "—"} | ${row.label} | ${cells.join(" | ")} |`);
  }
}

console.log(`\nRestatements: ${unified.restatements.length}; roll-up breaks: ${unified.rollupBreaks.length}`);
for (const brk of unified.rollupBreaks) {
  console.log(`  - ${brk.parentConcept} ${brk.periodId}: reported ${money(brk.reported)} vs computed ${money(brk.computed)} (diff ${money(brk.difference)})`);
}
console.log(`Unresolved findings: ${unified.unresolvedFindings.length}`);
for (const finding of unified.unresolvedFindings) console.log(`  - ${finding}`);

const unifiedPath = writeStep("step2-unified-statements.json", { summary: result.summary, artifact: unified });
console.log(`\nWrote ${unifiedPath}`);
console.log(unified.unresolvedFindings.length === 0 ? "\n**PASS**" : "\n**SHIPPED-WITH-FINDINGS**");
console.log("\nNext: step3-spine.ts");
