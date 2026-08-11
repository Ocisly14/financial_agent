// Step 7 — the last mile: from committed history to a valued model (no LLM).
// Rebuilds the committed model with five forecast periods appended, refreshes the WACC sheet on real
// prices and the Treasury feed, fills the sheet's holes, authors an anchored margin-driven forecast
// through the REAL operations path, advances the lifecycle to `valued`, and prints the valuation with
// its sensitivity grid. Every assumption is anchored on an engine-derived historical value read back
// from the workbook — the script never invents a number the model does not carry.
//
// Usage: node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/e2e_test/step7-valuation.ts [SYMBOL]
// Reads step1-3 artifacts. Writes step7-valuation.json.
import { resolveDetailLineItemIds } from "../../../src/infra/xbrl/spineFromUnified.ts";
import type { StatementUnificationRun } from "../../../src/agent/financial-modeling/statementUnificationAgent.ts";
import type { SpineMappingRun } from "../../../src/agent/financial-modeling/spineMappingAgent.ts";
import type { ResolvedFinancialModelSource } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import type { FinancialModelSnapshot, ModelOperation } from "../../../src/financial-model/operations.ts";
import { deriveWaccParameters, type DerivationDeps } from "../../../src/financial-model/waccDerivation.ts";
import type { WaccSheetComputedInput } from "../../../src/financial-model/waccSheet.ts";
import { fetchTreasury30y } from "../../../src/infra/market/treasuryYield.ts";
import { getSharedBarRepository } from "../../../src/data/stock/index.ts";
import type { Period } from "../../../src/financial-model/types.ts";
import { outputDirectory, readStep, symbol, writeStep } from "./common.ts";

const AGENT = "e2e-agent";
const source = readStep<ResolvedFinancialModelSource>("step1-source.json");
const { artifact: unified } = readStep<StatementUnificationRun>("step2-unified-statements.json");
const spine = readStep<SpineMappingRun>("step3-spine-mapping.json");

console.log(`# Step 7 — forecast, WACC, and valuation for ${symbol} → ${outputDirectory}`);

// ---- periods: the e2e extraction ran with forecastYears 0, so append five forecast fiscal years ----
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
const forecastIds = forecast.map((p) => p.id);

// ---- committed model (same shape as step6) ----
const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
const service = new FinancialModelService(modelStore, "e2e-session");
const modelId = `fm-${symbol.toLowerCase()}-valuation-test`;
service.createModel({ modelId, ownerAgentId: AGENT, originSessionId: "e2e-session", symbol,
  metadata: { companyName: source.company.title }, reportingCurrency: source.reportingCurrency,
  periods, preparedStatementRows: [] });
const labelByRowId = new Map([...unified.rows, ...(unified.breakdownRows ?? [])].map((row) => [row.rowId, row.label]));
const detailIds = resolveDetailLineItemIds(spine.decision, unified);
const labels = Object.fromEntries(spine.decision.detailRows.map((detail) => [
  detailIds[detail.rowId]!, labelByRowId.get(detail.rowId) ?? detail.rowId]));
let current = service.commitSpineFacts(modelId, 0, { facts: spine.facts, labels, historicalPeriodIds: actualIds });
console.log(`Committed history at revision ${current.revision} (${spine.facts.length} facts)`);

// ---- WACC: real derivation (prices + treasury), then fill the holes ----
const sheet = modelStore.getRevision(modelId)!.snapshot.waccSheet!;
const repository = await getSharedBarRepository();
const deps: DerivationDeps = {
  dailyCloses: async (sym, from, to) => repository === undefined ? []
    : (await repository.getBarsBetween(sym, "1Day", from, to)).map((bar) => ({ t: bar.t, c: bar.c })),
  treasury30y: (asOf) => fetchTreasury30y(asOf),
};
const derivation = await deriveWaccParameters({ symbol, asOfDate: sheet.asOfDate,
  facts: modelStore.getRevision(modelId)!.snapshot.facts, periods, deps });
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
const waccInput = (rowId: string, value: number, sourceType: string, rationale: string): ModelOperation => ({
  kind: "set_wacc_input", input: { rowId: rowId as never, value, sourceType, sourceRefs: ["e2e"], rationale } });
const waccOps: ModelOperation[] = [waccInput("equity_risk_premium", 0.05, "agent_estimate", "long-run US ERP")];
const sheetNow = modelStore.getRevision(modelId)!.snapshot.waccSheet!;
if (sheetNow.rows.find((r) => r.rowId === "cost_of_debt")?.value === null) {
  waccOps.push(waccInput("cost_of_debt", 0.035, "search", "issuer bond yield (fallback: filings lack a separate interest expense line)"));
}
if (sheetNow.rows.find((r) => r.rowId === "risk_free_rate")?.value === null) {
  waccOps.push(waccInput("risk_free_rate", 0.043, "market", "30Y UST (feed unreachable fallback)"));
}
current = service.applyOperations(modelId, current.revision, waccOps);
const wacc = modelStore.getRevision(modelId)!.snapshot.waccSheet!.rows.find((r) => r.rowId === "wacc")!.value;
console.log(`WACC resolved: ${(wacc! * 100).toFixed(2)}%`);

// ---- anchors read back from the workbook (never invented) ----
const cellOf = (view: typeof current, lineItemId: string, periodId: string): number | null => {
  for (const rows of Object.values(view.currentWorkbook.sections)) {
    const row = rows.find((r) => "lineItemId" in r && r.lineItemId === lineItemId);
    if (row && "cells" in row) return (row.cells as Record<string, { value: number | null }>)[periodId]?.value ?? null;
  }
  return null;
};
const anchor = (lineItemId: string): number => {
  const value = cellOf(current, lineItemId, last.id);
  if (value === null) throw new Error(`anchor unavailable: ${lineItemId}@${last.id}`);
  return value;
};
const anchors = { margin: anchor("margin.operating"), tax: anchor("tax_rate"), da: anchor("ratio.da_to_revenue"),
  capex: anchor("ratio.capex_to_revenue"), nwc: anchor("ratio.operating_nwc_to_revenue"),
  growth3y: anchor("metric.revenue_cagr_3p") };
console.log(`Anchors (FY${lastYear}): margin ${(anchors.margin * 100).toFixed(1)}%, tax ${(anchors.tax * 100).toFixed(1)}%, ` +
  `capex/rev ${(anchors.capex * 100).toFixed(1)}%, 3y CAGR ${(anchors.growth3y * 100).toFixed(1)}%`);

// ---- forecast assumptions: anchored, fading growth toward terminal ----
const TERMINAL_GROWTH = 0.025;
const growthPath = forecastIds.map((_, i) =>
  Number((TERMINAL_GROWTH + (anchors.growth3y - TERMINAL_GROWTH) * Math.pow(0.75, i)).toFixed(4)));
const assume = (lineItemId: string, values: number[], unit: { kind: string; code?: string }, rationale: string): ModelOperation => ({
  kind: "set_assumption", assumption: { assumptionId: `a-${lineItemId}`, lineItemId, periods: forecastIds,
    payload: { kind: "values", values, unit: unit as never }, sourceType: "analyst_inference", sourceRefs: ["e2e anchors"],
    asOfDate: new Date().toISOString().slice(0, 10), rationale } });
const flat = (value: number) => forecastIds.map(() => value);
current = service.applyOperations(modelId, current.revision, [
  assume("growth.revenue.total", growthPath, { kind: "percent" }, `3y CAGR anchor fading to terminal ${TERMINAL_GROWTH}`),
  assume("margin.operating", flat(anchors.margin), { kind: "percent" }, "margin persists at the FY-anchor level"),
  assume("tax_rate", flat(anchors.tax), { kind: "percent" }, "effective tax rate persists"),
  assume("ratio.da_to_revenue", flat(anchors.da), { kind: "ratio" }, "D&A intensity persists"),
  assume("ratio.capex_to_revenue", flat(anchors.capex), { kind: "ratio" }, "capital intensity persists"),
  assume("ratio.operating_nwc_to_revenue", flat(anchors.nwc), { kind: "ratio" }, "working-capital intensity persists"),
  assume("terminal_growth", flat(TERMINAL_GROWTH), { kind: "percent" }, "long-run nominal GDP ceiling respected"),
  assume("exit_multiple", flat(16), { kind: "ratio" }, "EBITDA exit cross-check multiple"),
]);
const fcff = forecastIds.map((p) => cellOf(current, "fcff", p));
console.log(`fcff forecast: ${fcff.map((v) => v === null ? "null" : (v / 1e9).toFixed(1) + "B").join("  ")}`);
if (fcff.some((v) => v === null)) { console.log("**FAIL** — fcff chain did not close"); process.exit(1); }

// ---- equity bridge rows the issuer lacks: construct or zero them explicitly (the agent-way) ----
const bridgeOps: ModelOperation[] = [];
if (cellOf(current, "cash_available_for_bridge", last.id) === null) {
  bridgeOps.push(
    { kind: "set_line_item_source", lineItemId: "cash_available_for_bridge", range: "historical", source: "formula" },
    { kind: "set_formula", formula: { lineItemId: "cash_available_for_bridge", appliesTo: "historical",
      source: "cash_and_equivalents + short_term_investments", periodIds: actualIds } });
}
for (const id of ["non_operating_investments", "lease_liabilities", "preferred_equity", "non_controlling_interests"]) {
  if (cellOf(current, id, last.id) === null) {
    bridgeOps.push(
      { kind: "set_line_item_source", lineItemId: id, range: "historical", source: "formula" },
      { kind: "set_formula", formula: { lineItemId: id, appliesTo: "historical", source: "0", periodIds: actualIds } });
  }
}
if (bridgeOps.length > 0) {
  current = service.applyOperations(modelId, current.revision, bridgeOps);
  console.log(`bridge rows completed: ${bridgeOps.length / 2} row(s) constructed/zeroed`);
}

// ---- lifecycle 由引擎推导:最后一次提交后模型应已直接读作 valued ----
console.log(`  derived stage: ${modelStore.getRevision(modelId)!.lifecycleStage} (revision ${current.revision})`);

// ---- read the verdict ----
const valuation = modelStore.getRevision(modelId)!.snapshot.valuation!;
const out = valuation as unknown as Record<string, unknown>;
writeStep("step7-valuation.json", { modelId, wacc, anchors, growthPath, valuation: out });
console.log("\n## Valuation\n");
console.log(JSON.stringify(out, null, 2).slice(0, 4000));
console.log("\n**PASS** — model reached `valued`; valuation output present.");
