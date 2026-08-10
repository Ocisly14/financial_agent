// Step 4/3+ — agent formula-writing capability test (live LLM + real engine).
// Rebuilds a committed AAPL model in memory from step1-3 artifacts, hands the LLM the
// workbook's line-item catalog, asks it to author analysis parameters as DSL formulas,
// then runs them through the REAL calculate_model_rows tool — schema validation, slug
// expansion, applyOperations, engine evaluation — and verifies the computed series.
//
// Usage: node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/e2e_test/step4-formulas.ts [SYMBOL]
// Needs a live LLM provider. Reads step1-source.json, step2-unified-statements.json, step3-spine-mapping.json.
// Writes step4-formula-test.json.
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import type { StatementUnificationRun } from "../../../src/agent/financial-modeling/statementUnificationAgent.ts";
import type { SpineMappingRun } from "../../../src/agent/financial-modeling/spineMappingAgent.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { InMemoryFilingInsightStore } from "../../../src/infra/filing-insights/store.ts";
import { InMemorySourceReviewStore } from "../../../src/infra/xbrl/sourceReviewStore.ts";
import { resolveDetailLineItemIds } from "../../../src/infra/xbrl/spineFromUnified.ts";
import type { ResolvedFinancialModelSource } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import type { FinancialModelSnapshot } from "../../../src/financial-model/operations.ts";
import { createWorkbenchTools } from "../../../mcp_tools/financial-model/workbenchTools.ts";
import type { FinancialModelToolDeps } from "../../../mcp_tools/financial-model/financialModelTools.ts";
import type { JsonObject } from "../../../src/framework/types.ts";
import { outputDirectory, readStep, symbol, writeStep } from "./common.ts";

const AGENT = "e2e-agent";
const source = readStep<ResolvedFinancialModelSource>("step1-source.json");
const { artifact: unified } = readStep<StatementUnificationRun>("step2-unified-statements.json");
const spine = readStep<SpineMappingRun>("step3-spine-mapping.json");
const actualIds = source.periods.filter((p) => p.cls === "actual").map((p) => p.id);

console.log(`# Step 4 — agent formula test for ${symbol} → ${outputDirectory}`);

// ---- 1. Rebuild a committed model from the stored artifacts (no LLM involved) ----
const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
const service = new FinancialModelService(modelStore, "e2e-session");
const modelId = `fm-${symbol.toLowerCase()}-formula-test`;
service.createModel({ modelId, ownerAgentId: AGENT, originSessionId: "e2e-session", symbol,
  metadata: { companyName: source.company.title }, reportingCurrency: source.reportingCurrency,
  periods: source.periods, preparedStatementRows: [] });

const labelByRowId = new Map([...unified.rows, ...(unified.breakdownRows ?? [])].map((row) => [row.rowId, row.label]));
const detailIds = resolveDetailLineItemIds(spine.decision, unified);
const labels = Object.fromEntries(spine.decision.detailRows.map((detail) => [
  detailIds[detail.rowId]!, labelByRowId.get(detail.rowId) ?? detail.rowId]));
service.stageSpineFacts(modelId, 0, { facts: spine.facts, labels, historicalPeriodIds: actualIds });
// Staging drops details whose parent refuses children (supplementary by design), so commit only what landed.
const staged = modelStore.getRevision(modelId)!.snapshot.facts.filter((fact) => fact.status === "staged");
const committed = service.reviewFacts(modelId, 1, {
  decisions: staged.map((fact) => ({ decisionId: `d-${fact.factId}`, factId: fact.factId,
    action: "commit" as const, mappedLineItemId: fact.lineItemId!, rationale: "e2e formula test",
    reviewedBy: AGENT, reviewedAt: new Date().toISOString() })),
  selectedHistoricalPeriodIds: actualIds, categoryLineItems: [], statementMappingPlans: [], categoryGroups: [] });
console.log(`Model ${modelId} committed at revision ${committed.revision} (${staged.length}/${spine.facts.length} facts landed)`);

// ---- 2. Catalog the rows the LLM may reference (id, label, unit, latest value) ----
const workbook = committed.currentWorkbook;
const latest = actualIds[actualIds.length - 1]!;
const catalog = Object.values(workbook.sections).flat()
  .filter((row) => actualIds.some((p) => row.cells[p]?.value !== null && row.cells[p]?.value !== undefined))
  .map((row) => ({ id: row.lineItemId, label: row.label, unit: row.unit.kind,
    [latest]: row.cells[latest]?.value ?? null }));
console.log(`Catalog: ${catalog.length} rows with historical values`);

// The operable library: breakdown rows step3 never promoted into the workbook (e.g. the geographic
// axis). Referencing one in a formula makes the tool import it deterministically.
const workbookIds = new Set(catalog.map((row) => row.id));
const library = (unified.breakdownRows ?? [])
  .filter((row) => ![...workbookIds].some((id) => id.endsWith(`.${row.rowId.split(".").pop()}`)))
  .map((row) => ({ rowId: row.rowId, label: row.label, [latest]: row.values[latest] ?? null }));
console.log(`Operable library (not in workbook): ${library.length} rows`);

// ---- 3. Ask the LLM to author parameter formulas ----
const system = `You are a financial analyst writing DCF analysis parameters as formulas for a calculation engine.
The formula language: operators + - * / and parentheses, numeric literals, line item ids, and the functions
SUM, AVERAGE, LAG, YOY, CAGR, MIN, MAX, ABS, POW. LAG(x, 1) is the prior period's value; YOY(x) is x's
year-over-year growth. Formulas are evaluated per historical period.
Rules:
- Reference ids from the provided catalog, exactly as written. You may ALSO reference a row from the
  [OPERABLE LIBRARY] — disclosed series not yet in the model — by writing unified.<rowId> (the bare
  rowId is refused); the engine imports it on first use.
  At least 2 of your parameters must use a library row (e.g. a geographic mix or its growth).
- Each parameter: a lowercase slug "id" (a-z0-9_, must not equal any catalog id), a "formula", a short
  "label", and a one-sentence "description" of what it measures and why it is useful for a DCF.
- Formulas may reference other parameters in this same batch by their bare slug.
- Write 8 parameters that would genuinely anchor a ${symbol} DCF: margins, cost/expense intensities,
  segment shares or growth, cash conversion — your judgment, grounded in the catalog.
Return EXACTLY one JSON object: {"rows":[{"id","formula","label","description"}]}`;
const router = new ModelRouter(resolveLlmProvider());
const completion = await router.generate([
  { role: "system", content: system },
  { role: "user", content: `[LINE ITEM CATALOG]\n${JSON.stringify(catalog)}\n\n[OPERABLE LIBRARY]\n${JSON.stringify(library)}` },
], { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "e2e_formula_test" } });
const start = completion.text.indexOf("{"); const end = completion.text.lastIndexOf("}");
if (start < 0 || end < start) throw new Error("LLM did not return JSON");
const proposed = (JSON.parse(completion.text.slice(start, end + 1)) as { rows: JsonObject[] }).rows;
console.log(`\nLLM proposed ${proposed.length} parameter(s):`);
for (const row of proposed) console.log(`  - ${row["id"]}: ${row["formula"]}`);

// ---- 4. Execute through the REAL tool (schema -> slug expansion -> operations -> engine) ----
// The tool resolves library references through the model's source review artifact.
const sourceReviewStore = new InMemorySourceReviewStore();
sourceReviewStore.save(modelId, { ingestionRunId: "e2e", coverage: { requestedPeriodIds: [], statements: [], issues: [] },
  dimensionalDisclosures: [], curatedTables: [], curations: [], filings: [], facts: [],
  statementViews: {} as never, unifiedStatements: unified } as never);
const deps = { modelStore, insightStore: new InMemoryFilingInsightStore(),
  sourceReviewStore, ingestionStore: sourceReviewStore } as FinancialModelToolDeps;
const calculate = createWorkbenchTools(deps).find((tool) => tool.name === "calculate_model_rows")!;
const result = await calculate.execute({ modelId, expectedRevision: committed.revision, rows: proposed },
  { agentId: AGENT, sessionId: "e2e-session" });

if (result.error) {
  console.log(`\nTool REJECTED the batch: [${result.error.code}] ${result.error.message}`);
  writeStep("step4-formula-test.json", { catalog, proposed, result });
  console.log("\n**FAIL** — the agent's formulas did not survive the engine's front door.");
  process.exit(1);
}

// ---- 5. Verify: every row computed, values present where inputs exist ----
const data = result.generation_context!.data as { revision: number;
  rows: Array<{ lineItemId: string; label: string; description?: string; formula: string; values: Record<string, number | null> }>;
  imported?: Array<{ lineItemId: string; label: string }> };
if (data.imported?.length) {
  console.log(`\nImported from the operable library: ${data.imported.map((r) => `${r.lineItemId} (${r.label})`).join(", ")}`);
}
const fmt = (value: number | null) => value === null ? "—"
  : Math.abs(value) >= 1e9 ? (value / 1e9).toFixed(1) + "B" : value.toFixed(4);
console.log(`\n## Engine results (revision ${data.revision})\n`);
console.log(`| id | formula | ${actualIds.join(" | ")} |`);
console.log(`| --- | --- |${actualIds.map(() => " ---: |").join("")}`);
const failures: string[] = [];
for (const row of data.rows) {
  const cells = actualIds.map((p) => fmt(row.values[p] ?? null));
  console.log(`| ${row.lineItemId} | \`${row.formula}\` | ${cells.join(" | ")} |`);
  const nonNull = actualIds.filter((p) => row.values[p] !== null && row.values[p] !== undefined).length;
  // LAG/YOY-style formulas legitimately lose the first period; anything sparser suggests a bad reference.
  if (nonNull < actualIds.length - 1) failures.push(`${row.lineItemId}: only ${nonNull}/${actualIds.length} periods computed`);
  if (!row.description) failures.push(`${row.lineItemId}: missing description`);
}

writeStep("step4-formula-test.json", { catalog, proposed, revision: data.revision, rows: data.rows, failures });
console.log(`\nCoverage findings: ${failures.length}`);
for (const failure of failures) console.log(`  - ${failure}`);
console.log(failures.length === 0 ? "\n**PASS** — all agent formulas parsed, evaluated, and persisted."
  : "\n**PASS-WITH-GAPS** — engine accepted the batch; sparse rows above need a look.");
