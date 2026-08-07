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
import { DcfSubagentRegistry } from "../../../src/agent/financial-modeling/subagents.ts";
import type { Period } from "../../../src/financial-model/types.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { buildConceptInventory } from "../../../src/infra/xbrl/conceptInventory.ts";
import type { ArelleExtractionResponse } from "../../../src/infra/xbrl/types.ts";
import type { ResolvedFinancialModelSource } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import { outputDirectory, readStep, symbol, writeStep } from "./common.ts";

const source = readStep<ResolvedFinancialModelSource>("step1-source.json");
const extraction = readStep<ArelleExtractionResponse>("step1-extraction.json");
const requestedPeriods: Period[] = source.periods.filter((p) => p.cls === "actual");

console.log(`# Step 2 — statement unification for ${symbol} (${requestedPeriods.map((p) => p.id).join(", ")}) → ${outputDirectory}`);

const inventory = buildConceptInventory({ filings: extraction.filings, requestedPeriods });
const inventoryPath = writeStep("step2-concept-inventory.json", inventory);
console.log(`\nConcept inventory: ${inventory.length} rows (${inventoryPath})`);

// E2E_MAX_RUNS=1 spends exactly one LLM call and ships whatever it produced, findings and all —
// the way to read what the agent actually decided instead of what it converged to after retries.
const maxRuns = Number(process.env["E2E_MAX_RUNS"] ?? 3);
console.log(`Unification runs allowed: ${maxRuns}`);

const run = await runStatementUnificationAgent({
  modelRouter: new ModelRouter(resolveLlmProvider()),
  systemPrompt: new DcfSubagentRegistry().get("statement_unification").prompt,
  filings: extraction.filings,
  requestedPeriods,
  maxRuns,
});
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
