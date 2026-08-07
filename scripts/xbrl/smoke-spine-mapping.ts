// Usage: node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/smoke-spine-mapping.ts <protocol3-response.json> <FY2021,FY2022,...>
// Two-stage smoke over a hand-captured protocol-3 companion response (never runs Arelle):
// stage Ⓐ statement_unification → unified multi-year statements, then stage Ⓑ spine_mapping.
// Needs a live LLM provider for both agent decisions.
import { readFileSync } from "node:fs";
import { resolveLlmProvider } from "../../src/agent/createApp.ts";
import { runSpineMappingAgent } from "../../src/agent/financial-modeling/spineMappingAgent.ts";
import { runStatementUnificationAgent } from "../../src/agent/financial-modeling/statementUnificationAgent.ts";
import { DcfSubagentRegistry } from "../../src/agent/financial-modeling/subagents.ts";
import type { Period } from "../../src/financial-model/types.ts";
import { ModelRouter } from "../../src/infra/llm/provider.ts";
import type { ArelleExtractionResponse } from "../../src/infra/xbrl/types.ts";

const responsePath = process.argv[2];
if (!responsePath) {
  console.error("usage: smoke-spine-mapping.ts <protocol3-response.json> [FY2021,FY2022,...]");
  process.exit(1);
}
const response = JSON.parse(readFileSync(responsePath, "utf8")) as ArelleExtractionResponse;
const periodIds = (process.argv[3] ?? "FY2021,FY2022,FY2023,FY2024,FY2025").split(",");
const requestedPeriods: Period[] = periodIds.map((id) => {
  const year = Number(id.slice(2));
  return { id, label: id, start: `${year}-01-01`, end: `${year}-12-31`, cls: "actual" };
});

const modelRouter = new ModelRouter(resolveLlmProvider());
const registry = new DcfSubagentRegistry();
const money = (value: number) => value.toLocaleString("en-US");

console.log(`# Two-stage spine mapping smoke — ${periodIds.join(", ")}`);
console.log(`\nFilings: ${response.filings.map((f) => `${f.filing.accession} (${f.filing.filedAt})`).join(", ")}`);

const unification = await runStatementUnificationAgent({ modelRouter,
  systemPrompt: registry.get("statement_unification").prompt,
  filings: response.filings, requestedPeriods });
const unified = unification.artifact;

console.log("\n## Unified statements (stage Ⓐ)\n");
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

const printRestatements = (rows: typeof unified.restatements) => {
  if (rows.length === 0) { console.log("None."); return; }
  for (const row of rows) {
    console.log(`- ${row.conceptQName}${row.dimensionSignature ? ` [${row.dimensionSignature}]` : ""} ${row.periodId}: chose ${money(row.chosenValue)} from ${row.chosenAccession}`);
    for (const candidate of row.candidates) console.log(`  - ${candidate.accession}: ${money(candidate.value)} (${candidate.contextId}, ${candidate.sourceAnchor})`);
  }
};

console.log("\n## Restatement report\n");
printRestatements(unified.restatements);

console.log("\n## Roll-up breaks\n");
if (unified.rollupBreaks.length === 0) console.log("None.");
for (const brk of unified.rollupBreaks) {
  console.log(`- ${brk.parentConcept} ${brk.periodId}: reported ${money(brk.reported)} vs computed ${money(brk.computed)} (diff ${money(brk.difference)}); missing children: ${brk.missingChildren.join(", ") || "none"}`);
}

console.log("\n## Unification unresolved findings\n");
if (unified.unresolvedFindings.length === 0) console.log("None.");
for (const finding of unified.unresolvedFindings) console.log(`- ${finding}`);

const spine = await runSpineMappingAgent({ modelRouter,
  systemPrompt: registry.get("spine_mapping").prompt, unified });
const factByLine = new Map(spine.facts.map((f) => [`${f.lineItemId}|${f.periodId}`, f]));

console.log("\n## Spine mappings (stage Ⓑ)\n");
console.log("| targetId | rows | period | value |");
console.log("| --- | --- | --- | ---: |");
for (const mapping of spine.decision.mappings) for (const periodId of unified.periods) {
  const fact = factByLine.get(`${mapping.targetId}|${periodId}`);
  if (fact) console.log(`| ${mapping.targetId} | ${mapping.rowIds.join(" + ")} | ${periodId} | ${money(fact.value)} |`);
}

console.log("\n## Detail rows\n");
if (spine.decision.detailRows.length === 0) console.log("None.");
for (const detail of spine.decision.detailRows) console.log(`- detail.${detail.parentTargetId}.${detail.rowId}: ${detail.rationale}`);

console.log("\n## Excluded\n");
if (spine.decision.excluded.length === 0) console.log("None.");
for (const drop of spine.decision.excluded) console.log(`- ${drop.rowId}: ${drop.reason}`);

console.log("\n## Spine gaps\n");
if (spine.decision.spineGaps.length === 0) console.log("None.");
for (const gap of spine.decision.spineGaps) console.log(`- ${gap.targetId}: ${gap.reason}`);

console.log("\n## Coverage gaps\n");
if (spine.coverageGaps.length === 0) console.log("None.");
for (const gap of spine.coverageGaps) console.log(`- ${gap.targetId} has no value in ${gap.periodId}`);

console.log("\n## Spine unresolved findings\n");
if (spine.unresolvedFindings.length === 0) console.log("None.");
for (const finding of spine.unresolvedFindings) console.log(`- ${finding}`);

const clean = unified.unresolvedFindings.length === 0 && spine.unresolvedFindings.length === 0;
console.log(clean ? "\n**PASS**" : "\n**SHIPPED-WITH-FINDINGS**");
