// Step 2/3 — statement_unification agent (stage Ⓐ + deterministic backfill/verify).
// Reads step1's extraction, builds the concept inventory (persisted for inspection —
// this is exactly what the agent sees), runs the unification agent, and persists the
// unified multi-year statements artifact.
//
// Usage: node --env-file=.env --experimental-strip-types scripts/xbrl/e2e_test/step2-unify.ts [SYMBOL]
// Needs a live LLM provider. Reads step1-*.json; writes:
//   step2-concept-inventory.json   — the inventory injected into the agent
//   step2-unified-statements.json  — { decision, artifact } (rows, values, facts, restatements, roll-up breaks)
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import { runStatementUnificationAgent } from "../../../src/agent/financial-modeling/statementUnificationAgent.ts";
import { subagentTool } from "../../../mcp_tools/financial-model/mappingSubagentTools.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { SkillRegistry } from "../../../src/framework/skill.ts";
import { SessionState } from "../../../src/framework/sessionState.ts";
import { SubagentRuntime } from "../../../src/framework/subagent.ts";
import { createSubagentRegistry } from "../../../src/agent/subagents/registerSubagents.ts";
import type { JsonObject, JsonValue } from "../../../src/framework/types.ts";
import type { Period } from "../../../src/financial-model/types.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { buildConceptInventory } from "../../../src/infra/xbrl/conceptInventory.ts";
import type { ArelleExtractionResponse } from "../../../src/infra/xbrl/types.ts";
import type { ResolvedFinancialModelSource } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import { buildAxisBreakdown, buildAxisCatalog } from "../../../src/infra/xbrl/dimensionInventory.ts";
import { fileLoader, outputDirectory, readStep, symbol, writeStep } from "./common.ts";

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

const inventory = buildConceptInventory({ filings: extraction.filings, requestedPeriods });
const inventoryPath = writeStep("step2-concept-inventory.json", inventory);
console.log(`\nConcept inventory: ${inventory.length} rows (${inventoryPath})`);

// E2E_MAX_RUNS=1 spends exactly one LLM call and ships whatever it produced, findings and all —
// the way to read what the agent actually decided instead of what it converged to after retries.

// Same dimension tools production wires through the table store, here fed from step1's extraction
// (FilingExtraction carries every table), so this run exercises the exploration loop for real.
const tables = extraction.filings.flatMap((filing) => filing.tables ?? []);
console.log(`Dimension exploration over ${tables.length} table(s)`);
// Mirror production's loader payload exactly. The delivery host independently rebuilds the inventory
// for validation, but the agent's read tool is its only view of the rows it must classify.
const readTools = fileLoader("load_concept_inventory", {
  symbol, requestedPeriods: requestedPeriods.map((p) => p.id), inventory,
});
const dimensionTool = (name: string, body: (input: JsonObject) => JsonValue): void => {
  readTools.push(subagentTool({ name, category: "non_trading", description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: true } },
    (input) => { console.log(`  [explore] ${name}(${JSON.stringify(input)})`); return body(input); }));
};
dimensionTool("list_dimension_axes", () =>
  ({ symbol, axes: buildAxisCatalog({ tables, requestedPeriods }) }) as JsonValue);
dimensionTool("get_axis_breakdown", (input) =>
  ({ symbol, ...buildAxisBreakdown({ tables, requestedPeriods,
    axisQName: String(input["axisQName"]), conceptQName: String(input["conceptQName"]),
    ...(typeof input["memberFilter"] === "string" ? { memberFilter: input["memberFilter"] } : {}),
    ...(typeof input["cursor"] === "number" ? { cursor: input["cursor"] } : {}) }) }) as JsonValue);

// The same runtime production uses; the agent decides its own sequence from its skill.
const skills = new SkillRegistry();
await skills.loadFromDirectory("skills");
const subagents = createSubagentRegistry();
const state = new SessionState("e2e-unify", new Date().toISOString());
state.beginTurn("step2");

const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error(`Step 2 exceeded ${stepTimeoutMs}ms`)), stepTimeoutMs);
let run;
try {
  run = await runStatementUnificationAgent({
    subagentRuntime: new SubagentRuntime(new ModelRouter(resolveLlmProvider()), new McpToolRegistry(), skills),
    definition: subagents.get("statement_unification"),
    state, sessionId: "e2e-unify", tenantId: "e2e-agent",
    task: `Unify ${symbol}'s extracted filings into multi-year statements.`,
    readTools,
    filings: extraction.filings,
    requestedPeriods,
    tables,
    signal: abort.signal,
  });
} finally {
  clearTimeout(deadline);
}
const unified = run.artifact;

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

const unifiedPath = writeStep("step2-unified-statements.json", run);
console.log(`\nWrote ${unifiedPath}`);
console.log(unified.unresolvedFindings.length === 0 ? "\n**PASS**" : "\n**SHIPPED-WITH-FINDINGS**");
console.log("\nNext: step3-spine.ts");
