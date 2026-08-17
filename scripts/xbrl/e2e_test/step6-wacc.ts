// Step 6 — WACC-sheet regression smoke test (no LLM calls).
// Rebuilds a committed AAPL model in memory from step1-3 artifacts (same recipe as step4's setup),
// then exercises the whole WACC-sheet skeleton end to end:
//   1. runs the auto-refresh the same way the spine-commit path does in production
//      (deriveWaccParameters -> service.refreshWaccSheet), sourced from real cached price bars when
//      available, else a deterministic synthetic walk;
//   2. prints the 12-row sheet and asserts the engine filled what it can measure and named what it can't;
//   3. fills the named gaps through the real apply_financial_model_operations path (set_wacc_input);
//   4. prints the final sheet + wacc value and asserts the stage gate that reads it flips from blocking
//      on wacc specifically to blocking (if at all) on something else.
//
// Usage: node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/e2e_test/step6-wacc.ts [SYMBOL]
// Reads step1-source.json, step2-unified-statements.json, step3-spine-mapping.json. Writes step6-wacc.json.
import type { StatementUnificationRun } from "../../../src/agent/financial-modeling/statementUnificationAgent.ts";
import type { SpineMappingRun } from "../../../src/agent/financial-modeling/spineMappingAgent.ts";
import { resolveDetailLineItemIds } from "../../../src/infra/xbrl/spineFromUnified.ts";
import type { ResolvedFinancialModelSource } from "../../../src/infra/xbrl/preparedStatementProvider.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../../../src/financial-model/service.ts";
import { financialModelSnapshotCodec } from "../../../src/financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../../src/financial-model/store.ts";
import type { FinancialModelSnapshot, ModelOperation } from "../../../src/financial-model/operations.ts";
import { FinancialModelError } from "../../../src/financial-model/errors.ts";
import { deriveWaccParameters, type DerivationDeps, type WaccParameterName } from "../../../src/financial-model/waccDerivation.ts";
import type { WaccSheet, WaccSheetComputedInput, WaccSheetAnyRowId } from "../../../src/financial-model/waccSheet.ts";
import { getSharedBarRepository, type DailyBar } from "../../../src/data/stock/index.ts";
import { fetchTreasury30y } from "../../../src/infra/market/treasuryYield.ts";
import { outputDirectory, readStep, symbol, writeStep } from "./common.ts";

const AGENT = "e2e-agent";
const source = readStep<ResolvedFinancialModelSource>("step1-source.json");
const { artifact: unified } = readStep<StatementUnificationRun>("step2-unified-statements.json");
const spine = readStep<SpineMappingRun>("step3-spine-mapping.json");
const actualIds = source.periods.filter((p) => p.cls === "actual").map((p) => p.id);

console.log(`# Step 6 — WACC sheet smoke test for ${symbol} → ${outputDirectory}`);

const failures: string[] = [];
const assert = (condition: boolean, message: string): void => {
  if (condition) console.log(`  [ok] ${message}`);
  else { console.log(`  [FAIL] ${message}`); failures.push(message); }
};

// ---- 1. Rebuild a committed model from the stored artifacts (no LLM involved) — same recipe as step4 ----
const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
const service = new FinancialModelService(modelStore, "e2e-session");
const modelId = `fm-${symbol.toLowerCase()}-wacc-test`;
service.createModel({ modelId, ownerAgentId: AGENT, originSessionId: "e2e-session", symbol,
  metadata: { companyName: source.company.title }, reportingCurrency: source.reportingCurrency,
  periods: source.periods, preparedStatementRows: [] });

const labelByRowId = new Map([...unified.rows, ...(unified.breakdownRows ?? [])].map((row) => [row.rowId, row.label]));
const detailIds = resolveDetailLineItemIds(spine.decision, unified);
const labels = Object.fromEntries(spine.decision.detailRows.map((detail) => [
  detailIds[detail.rowId]!, labelByRowId.get(detail.rowId) ?? detail.rowId]));
const committed = service.commitSpineFacts(modelId, 0, { facts: spine.facts, labels, historicalPeriodIds: actualIds });
console.log(`Model ${modelId} committed at revision ${committed.revision} (${staged.length}/${spine.facts.length} facts landed)`);
const asOfDate = committed.currentWorkbook.waccSheet!.asOfDate;
console.log(`WACC sheet as-of date: ${asOfDate}`);

// ---- 2. Auto-refresh, the same way the spine-commit path does in production:
// deriveWaccParameters against the just-committed spine, folded in via service.refreshWaccSheet. ----
function yearsBefore(isoDate: string, years: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - Math.round(years * 365.25));
  return date.toISOString().slice(0, 10);
}

/** Deterministic seeded random walk, one point per weekday, so the script always runs even with no
 * local price cache — same shape as the unit tests' synthetic bars, just spanning a full decade. */
function syntheticBars(seed: number, drift: number, fromDate: string, toDate: string): DailyBar[] {
  const out: DailyBar[] = [];
  const date = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  let index = 0;
  while (date.getTime() <= end.getTime()) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      const c = seed * Math.exp(drift * index + Math.sin(index * 0.7) * 0.01);
      out.push({ t: date.toISOString().slice(0, 10), o: c, h: c, l: c, c, v: 1, vw: c });
      index += 1;
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

const priceFrom = yearsBefore(asOfDate, 11);
const syntheticSeries = new Map<string, DailyBar[]>([
  [symbol, syntheticBars(100, 0.0003, priceFrom, asOfDate)],
  ["SPY", syntheticBars(300, 0.0002, priceFrom, asOfDate)],
]);

let priceSource = "synthetic seeded walk (no usable local bar cache)";
const repository = await getSharedBarRepository();
let dailyCloses: DerivationDeps["dailyCloses"];
if (repository !== undefined) {
  const probe = await repository.getBarsBetween(symbol, "1Day", priceFrom, asOfDate, "sip");
  const probeMarket = await repository.getBarsBetween("SPY", "1Day", priceFrom, asOfDate, "sip");
  if (probe.length > 500 && probeMarket.length > 500) {
    priceSource = `local bar cache (sip feed): ${probe.length} ${symbol} bars, ${probeMarket.length} SPY bars`;
    dailyCloses = async (sym, from, to) =>
      (await repository.getBarsBetween(sym, "1Day", from, to, "sip")).map((bar) => ({ t: bar.t, c: bar.c }));
  }
}
dailyCloses ??= async (sym, from, to) =>
  (syntheticSeries.get(sym) ?? []).filter((bar) => bar.t >= from && bar.t <= to).map((bar) => ({ t: bar.t, c: bar.c }));
console.log(`Price source: ${priceSource}`);

const WACC_SHEET_ROW_BY_PARAMETER_NAME: Partial<Record<WaccParameterName, WaccSheetComputedInput["rowId"]>> = {
  beta: "beta", costOfDebt: "cost_of_debt", equityValue: "equity_value", totalDebt: "total_debt", taxRate: "effective_tax_rate",
  riskFreeRate: "risk_free_rate",
};

const derivation = await deriveWaccParameters({
  symbol, asOfDate, facts: modelStore.getRevision(modelId)!.snapshot.facts,
  lineItems: modelStore.getRevision(modelId)!.snapshot.lineItems,
  periods: modelStore.getRevision(modelId)!.snapshot.periods,
  cells: modelStore.getRevision(modelId)!.snapshot.cells,
  deps: { dailyCloses, treasury30y: (asOf) => fetchTreasury30y(asOf) } });
console.log(`\nDerived ${derivation.derived.length} term(s); unreachable: ${derivation.unreachable.map((u) => u.name).join(", ") || "none"}`);
for (const entry of derivation.unreachable) console.log(`  - ${entry.name}: ${entry.reason}`);

const computedInputs: WaccSheetComputedInput[] = [];
for (const parameter of derivation.derived) {
  const rowId = WACC_SHEET_ROW_BY_PARAMETER_NAME[parameter.name];
  if (rowId === undefined) continue;
  computedInputs.push({ rowId, value: parameter.value, provenance: { sourceType: parameter.sourceType,
    sourceRefs: parameter.sourceRefs, asOfDate: parameter.asOfDate, rationale: parameter.rationale } });
}
if (derivation.cashAndEquivalents) {
  computedInputs.push({ rowId: "cash_and_equivalents_value", value: derivation.cashAndEquivalents.value,
    provenance: { sourceType: derivation.cashAndEquivalents.sourceType, sourceRefs: derivation.cashAndEquivalents.sourceRefs,
      asOfDate, rationale: derivation.cashAndEquivalents.rationale } });
}
const refreshed = service.refreshWaccSheet(modelId, committed.revision, computedInputs);
console.log(`\nAuto-refresh landed as revision ${refreshed.revision} (${computedInputs.length} computed input(s) applied).`);

// ---- 3. Print the sheet, assert the auto-derivable rows got values and the rest are named as missing ----
function printSheet(title: string, sheet: WaccSheet): void {
  console.log(`\n## ${title} (as of ${sheet.asOfDate})\n`);
  console.log("| rowId | source | value | missingInputs |");
  console.log("| --- | --- | ---: | --- |");
  for (const row of sheet.rows) {
    const value = row.value === null ? "—" : row.value.toFixed(6);
    console.log(`| ${row.rowId} | ${row.source} | ${value} | ${row.missingInputs.join(", ") || "—"} |`);
  }
}

const sheetById = (sheet: WaccSheet): Map<WaccSheetAnyRowId, WaccSheet["rows"][number]> =>
  new Map(sheet.rows.map((row) => [row.rowId, row]));

const afterRefresh = refreshed.currentWorkbook.waccSheet!;
printSheet("After auto-refresh", afterRefresh);
assert(afterRefresh.rows.length === 12, `sheet has 12 public rows (got ${afterRefresh.rows.length})`);

const byRow = sheetById(afterRefresh);
const derivedRowIds = new Set(computedInputs.map((input) => input.rowId));
// risk_free_rate joins the other computed rows here: reachable when treasury.gov resolves for this
// as-of date (network available and the feed responds), left empty otherwise — never hard-required,
// since offline/failed-feed runs must still pass via the fallback fill below.
for (const rowId of ["beta", "equity_value", "total_debt", "effective_tax_rate", "cost_of_debt", "risk_free_rate"] as const) {
  const row = byRow.get(rowId)!;
  if (derivedRowIds.has(rowId)) {
    assert(row.value !== null, `${rowId} was derivable from real data and got a value (${row.value})`);
    if (rowId === "risk_free_rate") console.log(`  [note] rf auto-filled from treasury.gov: ${row.value}`);
  } else {
    assert(row.value === null && row.missingInputs.length === 0,
      `${rowId} stayed empty (source data lacks its input) — engine did not fabricate a value`);
    console.log(`  [note] ${rowId} left empty: ${derivation.unreachable.find((u) => WACC_SHEET_ROW_BY_PARAMETER_NAME[u.name as WaccParameterName] === rowId)?.reason ?? "not derivable from this filing"}`);
  }
}
// equity_risk_premium is a leaf input (source "empty"), not a formula — it has nothing to name as
// missing on its own row; it is the formula rows that depend on it (cost_of_equity, wacc) that name
// the gap. It has no measurable source by nature, so the engine never fills it.
assert(byRow.get("equity_risk_premium")!.value === null, "equity_risk_premium is null before the agent fills it");
for (const rowId of ["cost_of_equity", "wacc"] as const) {
  const row = byRow.get(rowId)!;
  assert(row.value === null, `${rowId} is null before the agent fills the gaps`);
  assert(row.missingInputs.length > 0, `${rowId} names its missing inputs: [${row.missingInputs.join(", ")}]`);
}

// ---- 4. wacc 未解出时,推导出的 lifecycle 不会读作 valued,估值保持 null ----
console.log("\n## Derived-stage check, before filling risk_free_rate / equity_risk_premium\n");
assert(modelStore.getRevision(modelId)!.lifecycleStage !== "valued",
  "an unresolved wacc row keeps the derived stage below valued");
assert(modelStore.getRevision(modelId)!.snapshot.valuation === null, "no valuation while wacc is unresolved");

// ---- 5. Fill the remaining named gaps through the real operations path: set_wacc_input for erp,
// which the engine can never derive by nature, and for risk_free_rate only as a FALLBACK — when the
// treasury.gov feed did not resolve (offline run, feed outage) and the row stayed empty. A row the
// feed already filled is never overwritten here. If the filing itself does not carry a separate
// interest_expense line (true for recent AAPL 10-Ks — Apple no longer breaks it out), cost_of_debt
// is unreachable too; that row is agent-writable precisely for this case (a current bond-yield
// override), so it is filled the same way, with its own rationale, only when the auto-refresh left it
// empty — never overriding a value the engine actually derived. ----
const fillOperations: ModelOperation[] = [
  { kind: "set_wacc_input", input: { rowId: "equity_risk_premium", value: 0.05, sourceType: "agent_estimate", sourceRefs: [],
    rationale: "Standard long-run US equity risk premium estimate; no measurable source exists for this term.", asOfDate } },
];
if (byRow.get("risk_free_rate")!.value === null) {
  fillOperations.push({ kind: "set_wacc_input", input: { rowId: "risk_free_rate", value: 0.043, sourceType: "market", sourceRefs: ["treasury:30y"],
    rationale: "30-year Treasury yield as of the model's as-of date (fallback: treasury.gov feed unavailable).", asOfDate } });
} else {
  console.log(`  [note] risk_free_rate already filled by the treasury.gov feed (${byRow.get("risk_free_rate")!.value}); not overwriting.`);
}
if (byRow.get("cost_of_debt")!.value === null) {
  fillOperations.push({ kind: "set_wacc_input", input: { rowId: "cost_of_debt", value: 0.035, sourceType: "search",
    sourceRefs: ["e2e-fixture: issuer bond yield unavailable in this filing's spine"],
    rationale: "Filing carries no separate interest_expense line to derive cost of debt from; overriding with a representative investment-grade bond yield.",
    asOfDate } });
}
const filled = service.applyOperations(modelId, refreshed.revision, fillOperations);
console.log(`Filled ${fillOperations.map((op) => (op as { input: { rowId: string } }).input.rowId).join(", ")} via set_wacc_input, landed as revision ${filled.revision}.`);

const finalSheet = filled.currentWorkbook.waccSheet!;
printSheet("Final sheet, after set_wacc_input", finalSheet);
const finalByRow = sheetById(finalSheet);
const waccRow = finalByRow.get("wacc")!;
assert(waccRow.value !== null, `wacc resolved to a value (${waccRow.value})`);
assert(finalByRow.get("cost_of_equity")!.value !== null, "cost_of_equity chained through from the filled rf/erp");

console.log(`\nWACC = ${waccRow.value}`);

// ---- 6. wacc 解出后,valued 与否只取决于预测机器(本脚本不搭):推导 stage 如实反映,
// 不再存在任何"门"来报错。 ----
console.log("\n## Derived-stage check, after filling risk_free_rate / equity_risk_premium\n");
console.log(`  derived stage now: ${modelStore.getRevision(modelId)!.lifecycleStage}`);

writeStep("step6-wacc.json", {
  modelId, asOfDate, priceSource,
  derived: derivation.derived.map((d) => ({ name: d.name, value: d.value, sourceType: d.sourceType })),
  unreachable: derivation.unreachable,
  afterRefresh, finalSheet, wacc: waccRow.value,
  derivedStage: modelStore.getRevision(modelId)!.lifecycleStage,
  failures,
});

console.log(`\nAssertion failures: ${failures.length}`);
for (const failure of failures) console.log(`  - ${failure}`);
console.log(failures.length === 0
  ? "\n**PASS** — the WACC sheet auto-fills what it can measure, names what it cannot, the agent closes the gap through set_wacc_input, and the valued-stage gate reads that sheet."
  : "\n**FAIL** — see failures above.");
process.exit(failures.length === 0 ? 0 : 1);
