// Step 5 — end-to-end tool-loop test: the LLM DISCOVERS the operable library through the real read
// tools, then authors parameters through the real calculate tool. Nothing is pasted into the prompt
// except the workbook catalog and the tool protocol; every piece of library data the model uses, it
// fetched itself.
//
// Usage: node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/e2e_test/step5-explore-calculate.ts [SYMBOL]
// Needs a live LLM provider. Reads step1-3 artifacts. Writes step5-explore-calculate.json.
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import type { StatementUnificationRun } from "../../../src/agent/financial-modeling/statementUnificationAgent.ts";
import type { SpineMappingRun } from "../../../src/agent/financial-modeling/spineMappingAgent.ts";
import { ModelRouter, type LlmMessage } from "../../../src/infra/llm/provider.ts";
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
const MAX_STEPS = 10;
const source = readStep<ResolvedFinancialModelSource>("step1-source.json");
const { artifact: unified } = readStep<StatementUnificationRun>("step2-unified-statements.json");
const spine = readStep<SpineMappingRun>("step3-spine-mapping.json");
const actualIds = source.periods.filter((p) => p.cls === "actual").map((p) => p.id);

console.log(`# Step 5 — explore-then-calculate tool loop for ${symbol} → ${outputDirectory}`);

// ---- committed model, identical to step4's setup ----
const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
const service = new FinancialModelService(modelStore, "e2e-session");
const modelId = `fm-${symbol.toLowerCase()}-explore-test`;
service.createModel({ modelId, ownerTenantId: AGENT, originSessionId: "e2e-session", symbol,
  metadata: { companyName: source.company.title }, reportingCurrency: source.reportingCurrency,
  periods: source.periods, preparedStatementRows: [] });
const labelByRowId = new Map([...unified.rows, ...(unified.breakdownRows ?? [])].map((row) => [row.rowId, row.label]));
const detailIds = resolveDetailLineItemIds(spine.decision, unified);
const labels = Object.fromEntries(spine.decision.detailRows.map((detail) => [
  detailIds[detail.rowId]!, labelByRowId.get(detail.rowId) ?? detail.rowId]));
const committed = service.commitSpineFacts(modelId, 0, { facts: spine.facts, labels, historicalPeriodIds: actualIds });

const sourceReviewStore = new InMemorySourceReviewStore();
sourceReviewStore.save(modelId, { ingestionRunId: "e2e", coverage: { requestedPeriodIds: [], statements: [], issues: [] },
  dimensionalDisclosures: [], curatedTables: [], curations: [], filings: [], facts: [],
  statementViews: {} as never, unifiedStatements: unified } as never);
const deps = { modelStore, insightStore: new InMemoryFilingInsightStore(),
  sourceReviewStore, ingestionStore: sourceReviewStore } as FinancialModelToolDeps;
const tools = new Map(createWorkbenchTools(deps).map((tool) => [tool.name, tool]));
const ctx = { tenantId: AGENT, sessionId: "e2e-session" };

const workbookCatalog = Object.values(committed.currentWorkbook.sections).flat()
  .filter((row) => actualIds.some((p) => row.cells[p]?.value !== null && row.cells[p]?.value !== undefined))
  .map((row) => ({ id: row.lineItemId, label: row.label, unit: row.unit.kind }));

// ---- the tool loop ----
const system = `You are a financial analyst working a ${symbol} DCF model through tools.
Your job, in order:
1. EXPLORE: use list_unified_statements then get_unified_rows (modelId "${modelId}") to discover the
   disclosed data behind this model — especially dimensional breakdowns whose members are NOT in the
   workbook catalog below. Filters: statement, parentRowId, axisQName, parentMemberQName, memberQNames,
   memberFilter, rowIds, cursor.
2. CALCULATE: call calculate_model_rows ONCE with expectedRevision ${committed.revision} and 4-6
   parameter rows {id, formula, label, description} that would anchor a DCF. Formulas use the DSL
   (+ - * / parentheses, SUM AVERAGE LAG YOY CAGR MIN MAX ABS POW; LAG(x,1) is the prior period).
   Reference workbook ids AND at least two library rows you discovered in step 1 — reference a
   library row as unified.<its exact rowId> (bare library rowIds are refused); the engine imports it
   automatically.
3. FINISH after the calculation succeeds.
Each turn return EXACTLY one JSON object and nothing else:
either {"tool":"<name>","input":{...}} or {"done":true,"summary":"<one line>"}.

[WORKBOOK CATALOG]
${JSON.stringify(workbookCatalog)}`;

const router = new ModelRouter(resolveLlmProvider());
const messages: LlmMessage[] = [
  { role: "system", content: system },
  { role: "user", content: `Begin. Model ${modelId} is at revision ${committed.revision}.` },
];
const transcript: Array<{ tool: string; input: JsonObject; ok: boolean }> = [];
let calculated: JsonObject | undefined;

for (let step = 1; step <= MAX_STEPS; step += 1) {
  // The provider occasionally returns an empty text block; one spaced retry rides it out.
  let completion;
  try { completion = await router.generate(messages, { modelClass: "MEDIUM", temperature: 0.1,
    metadata: { mode: "e2e_explore_calculate" } }); }
  catch {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    completion = await router.generate(messages, { modelClass: "MEDIUM", temperature: 0.1,
      metadata: { mode: "e2e_explore_calculate", retry: "provider_error" } });
  }
  messages.push({ role: "assistant", content: completion.text });
  const start = completion.text.indexOf("{"); const end = completion.text.lastIndexOf("}");
  if (start < 0 || end < start) { messages.push({ role: "user", content: "[ERROR]\nReturn one JSON object." }); continue; }
  const parsed = JSON.parse(completion.text.slice(start, end + 1)) as { done?: boolean; tool?: string; input?: JsonObject };
  if (parsed.done === true) { console.log(`\n[done] after ${step - 1} tool call(s)`); break; }
  const tool = parsed.tool !== undefined ? tools.get(parsed.tool) : undefined;
  if (!tool) { messages.push({ role: "user", content: `[ERROR]\nunknown tool: ${String(parsed.tool)}` }); continue; }
  const result = await tool.execute(parsed.input ?? {}, ctx);
  const ok = result.error === undefined;
  transcript.push({ tool: tool.name, input: parsed.input ?? {}, ok });
  console.log(`  [${step}] ${tool.name}(${JSON.stringify(parsed.input).slice(0, 140)}) → ${ok ? "ok" : `ERROR ${result.error!.code}`}`);
  if (tool.name === "calculate_model_rows" && ok) calculated = result.generation_context?.data as JsonObject;
  const payload = JSON.stringify({ summary: result.summary, ...(result.error ? { error: result.error } : {}),
    ...(result.generation_context?.data ? { data: result.generation_context.data } : {}) });
  messages.push({ role: "user", content: `[TOOL RESULT ${tool.name}]\n${payload.length > 20_000 ? payload.slice(0, 20_000) + "…" : payload}` });
}

// ---- verdict ----
if (!calculated) {
  writeStep("step5-explore-calculate.json", { transcript, calculated: null });
  console.log("\n**FAIL** — the loop never landed a successful calculate_model_rows call.");
  process.exit(1);
}
const rows = calculated["rows"] as Array<{ lineItemId: string; formula: string; values: Record<string, number | null> }>;
const imported = (calculated["imported"] ?? []) as Array<{ lineItemId: string; label: string }>;
const explored = transcript.filter((t) => t.tool !== "calculate_model_rows").length;
console.log(`\n## Result: ${explored} exploration call(s), ${rows.length} parameter(s), ${imported.length} library import(s)\n`);
console.log(`| id | formula | ${actualIds.join(" | ")} |`);
console.log(`| --- | --- |${actualIds.map(() => " ---: |").join("")}`);
const fmt = (value: number | null) => value === null ? "—"
  : Math.abs(value) >= 1e9 ? (value / 1e9).toFixed(1) + "B" : value.toFixed(4);
for (const row of rows) {
  console.log(`| ${row.lineItemId} | \`${row.formula}\` | ${actualIds.map((p) => fmt(row.values[p] ?? null)).join(" | ")} |`);
}
if (imported.length > 0) console.log(`\nImported: ${imported.map((r) => `${r.lineItemId} (${r.label})`).join(", ")}`);
writeStep("step5-explore-calculate.json", { transcript, rows, imported });
const usedLibrary = imported.length >= 1;
console.log(usedLibrary
  ? "\n**PASS** — the agent discovered library data through the read tools and computed against it."
  : "\n**PASS-WITHOUT-LIBRARY** — formulas computed, but no library row was referenced; check the transcript.");
process.exit(usedLibrary ? 0 : 1);
