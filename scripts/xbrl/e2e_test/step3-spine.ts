// Step 3/3 — spine_mapping agent (stage Ⓑ + deterministic spine backfill/coverage).
// Reads step2's unified statements artifact, runs the spine mapping agent, and
// persists the DCF spine selection with its backfilled facts.
//
// Usage: node --env-file=.env --experimental-strip-types scripts/xbrl/e2e_test/step3-spine.ts [SYMBOL]
// Needs a live LLM provider. Reads step2-unified-statements.json; writes:
//   step3-spine-mapping.json — { decision, facts, coverageGaps, unresolvedFindings }
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import { runSpineMappingAgent } from "../../../src/agent/financial-modeling/spineMappingAgent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { SkillRegistry } from "../../../src/framework/skill.ts";
import { SessionState } from "../../../src/framework/sessionState.ts";
import { SubagentRuntime } from "../../../src/framework/subagent.ts";
import { createSubagentRegistry } from "../../../src/agent/subagents/registerSubagents.ts";
import type { StatementUnificationRun } from "../../../src/agent/financial-modeling/statementUnificationAgent.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { fileLoader, outputDirectory, readStep, symbol, writeStep } from "./common.ts";

const { artifact: unified } = readStep<StatementUnificationRun>("step2-unified-statements.json");

console.log(`# Step 3 — spine mapping for ${symbol} (${unified.periods.join(", ")}) → ${outputDirectory}`);
console.log(`Unified rows in: ${unified.rows.length}`);

// The same runtime production uses; the agent decides its own sequence from its skill.
const skills = new SkillRegistry();
await skills.loadFromDirectory("skills");
const subagents = createSubagentRegistry();
const state = new SessionState("e2e-spine", new Date().toISOString());
state.beginTurn("step3");

const spine = await runSpineMappingAgent({
  subagentRuntime: new SubagentRuntime(new ModelRouter(resolveLlmProvider()), new McpToolRegistry(), skills),
  definition: subagents.get("spine_mapping"),
  state, sessionId: "e2e-spine", agentId: "e2e-agent",
  task: `Map ${symbol}'s unified statements onto the canonical spine.`,
  readTools: fileLoader("load_unified_statements", { symbol, periods: unified.periods, rows: unified.rows }),
  unified,
});

const money = (value: number) => value.toLocaleString("en-US");
const factByLine = new Map(spine.facts.map((f) => [`${f.lineItemId}|${f.periodId}`, f]));

console.log("\n## Spine mappings\n");
console.log("| targetId | rows | period | value |");
console.log("| --- | --- | --- | ---: |");
for (const mapping of spine.decision.mappings) for (const periodId of unified.periods) {
  const fact = factByLine.get(`${mapping.targetId}|${periodId}`);
  if (fact) console.log(`| ${mapping.targetId} | ${mapping.rowIds.join(" + ")} | ${periodId} | ${money(fact.value)} |`);
}

console.log("\n## Detail rows");
if (spine.decision.detailRows.length === 0) console.log("None.");
for (const detail of spine.decision.detailRows) console.log(`  - detail.${detail.parentTargetId}.${detail.rowId}: ${detail.rationale}`);

console.log("\n## Excluded");
if (spine.decision.excluded.length === 0) console.log("None.");
for (const drop of spine.decision.excluded) console.log(`  - ${drop.rowId}: ${drop.reason}`);

console.log("\n## Spine gaps");
if (spine.decision.spineGaps.length === 0) console.log("None.");
for (const gap of spine.decision.spineGaps) console.log(`  - ${gap.targetId}: ${gap.reason}`);

console.log("\n## Coverage gaps");
if (spine.coverageGaps.length === 0) console.log("None.");
for (const gap of spine.coverageGaps) console.log(`  - ${gap.targetId} has no value in ${gap.periodId}`);

console.log(`\nUnresolved findings: ${spine.unresolvedFindings.length}`);
for (const finding of spine.unresolvedFindings) console.log(`  - ${finding}`);

const spinePath = writeStep("step3-spine-mapping.json", spine);
console.log(`\nWrote ${spinePath}`);
console.log(spine.unresolvedFindings.length === 0 ? "\n**PASS**" : "\n**SHIPPED-WITH-FINDINGS**");
