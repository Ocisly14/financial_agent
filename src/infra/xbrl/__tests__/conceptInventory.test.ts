import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptInventory } from "../conceptInventory.ts";
import { fact, filing, node, period, statement } from "./spineFixture.ts";

const periods = [period("FY2024", 2024), period("FY2025", 2025)];

test("dedupes across filings, lists divergent labels latest-first, unions period coverage", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Total revenues", [fact("FY2024", 96_000e6)]),
  ])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100_000e6), fact("FY2024", 96_000e6)]),
  ])]);
  const rows = buildConceptInventory({ filings: [older, latest], requestedPeriods: periods });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.labels, ["Revenues", "Total revenues"]);
  assert.deepEqual(rows[0]!.values, { FY2024: 96_000e6, FY2025: 100_000e6 });
});

// Period coverage is the key set, so the keys must be ordered — the inventory is rendered into a
// prompt whose cached prefix a reshuffled object would break.
test("values are keyed in ascending period order", () => {
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100_000e6), fact("FY2024", 96_000e6)]),
  ])]);
  const rows = buildConceptInventory({ filings: [latest], requestedPeriods: periods });
  assert.deepEqual(Object.keys(rows[0]!.values), ["FY2024", "FY2025"]);
});

test("a re-tag is visible: old concept only in older filings, coverage split by year", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:SalesRevenueNet", "Revenues", [fact("FY2024", 96_000e6)]),
  ])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100_000e6)]),
  ])]);
  const rows = buildConceptInventory({ filings: [older, latest], requestedPeriods: periods });
  const byConcept = new Map(rows.map((row) => [row.conceptQName, row]));
  assert.deepEqual(Object.keys(byConcept.get("us-gaap:Revenues")!.values), ["FY2025"]);
  assert.deepEqual(Object.keys(byConcept.get("us-gaap:SalesRevenueNet")!.values), ["FY2024"]);
});

// A line the issuer retired is still a line of the statement it was retired from. Nulling its tree
// position because the newest filing lacks it flattened it into an orphan at depth 0, indistinguish-
// able from the superseded half of a re-tag — and MSFT's FY2021 "Cash premium on debt exchange"
// ($1.754B, under Financing) was demoted to supplemental on exactly that reading.
test("a retired row keeps the tree position of the last filing that carried it", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("cash_flow_statement", [
    node(0, null, "us-gaap:FinancingAbstract", "Financing", [], true),
    node(1, 0, "us-gaap:PaymentsOfDebtRestructuringCosts", "Cash premium on debt exchange", [fact("FY2024", 1_754e6)]),
    node(2, 0, "us-gaap:RepaymentsOfDebt", "Repayments of debt", [fact("FY2024", 3_750e6)]),
  ])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("cash_flow_statement", [
    node(0, null, "us-gaap:FinancingAbstract", "Financing", [], true),
    node(1, 0, "us-gaap:RepaymentsOfDebt", "Repayments of debt", [fact("FY2025", 3_000e6)]),
  ])]);
  const rows = buildConceptInventory({ filings: [older, latest], requestedPeriods: periods });
  const retired = rows.find((row) => row.conceptQName === "us-gaap:PaymentsOfDebtRestructuringCosts")!;
  assert.equal(retired.parentLabel, "Financing", "sits where the filing that reported it put it");
  assert.equal(retired.depth, 1);
  assert.equal(retired.parentByPeriod, undefined, "filings agree, so no per-period map is spent");
});

test("a row the issuer moved between sections carries the position per period", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("balance_sheet", [
    node(0, null, "us-gaap:LiabilitiesAbstract", "Other current liabilities", [], true),
    node(1, 0, "us-gaap:CustomerDeposits", "Customer deposits", [fact("FY2024", 1_200e6)]),
  ])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("balance_sheet", [
    node(0, null, "us-gaap:LiabilitiesAbstract", "Accrued liabilities", [], true),
    node(1, 0, "us-gaap:CustomerDeposits", "Customer deposits", [fact("FY2025", 1_400e6)]),
  ])]);
  const rows = buildConceptInventory({ filings: [older, latest], requestedPeriods: periods });
  assert.equal(rows[0]!.parentLabel, "Accrued liabilities", "the primary position is the newest one");
  assert.deepEqual(rows[0]!.parentByPeriod, {
    FY2024: { label: "Other current liabilities", depth: 1 },
    FY2025: { label: "Accrued liabilities", depth: 1 },
  });
});

test("dimensional facts fork their own row and abstract nodes give tree position, not rows", () => {
  const dims = [{ axisQName: "us-gaap:PropertyPlantAndEquipmentByTypeAxis", axisLabel: "PPE Type",
    memberQName: "tsla:OperatingLeaseVehiclesMember", memberLabel: "Operating lease vehicles" }];
  const latest = filing("acc-2025", "2026-01-30", [statement("balance_sheet", [
    node(0, null, "us-gaap:AssetsAbstract", "Assets", [], true),
    node(1, 0, "us-gaap:DeferredCostsLeasingNetNoncurrent", "Operating lease vehicles, net",
      [fact("FY2025", 4_912e6, { dimensions: dims })]),
    node(2, 0, "us-gaap:DeferredCostsLeasingNetNoncurrent", "Deferred leasing costs", [fact("FY2025", 100e6)]),
  ])]);
  const rows = buildConceptInventory({ filings: [latest], requestedPeriods: periods });
  assert.equal(rows.length, 2);
  const dimensional = rows.find((row) => row.dimensionSignature !== "")!;
  assert.deepEqual(dimensional.values, { FY2025: 4_912e6 });
  assert.equal(dimensional.parentLabel, "Assets");
  assert.equal(dimensional.depth, 1);
  assert.ok(!rows.some((row) => row.conceptQName === "us-gaap:AssetsAbstract"));
});

// MSFT tagged commercial paper at 0 in FY2025 and $6.693B in FY2024. A single most-recent sample
// showed the 0, the unification agent read the line as a zero-value legacy row and demoted it to
// supplemental, and FY2024's current liabilities lost 5% of their detail with no finding raised.
test("a line that is zero in its newest year still carries the year it was material", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("balance_sheet", [
    node(0, null, "us-gaap:CommercialPaper", "Short-term debt", [fact("FY2024", 6_693e6)]),
  ])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("balance_sheet", [
    node(0, null, "us-gaap:CommercialPaper", "Short-term debt", [fact("FY2025", 0)]),
  ])]);
  const rows = buildConceptInventory({ filings: [older, latest], requestedPeriods: periods });
  assert.deepEqual(rows[0]!.values, { FY2024: 6_693e6, FY2025: 0 });
});

test("values are consistent after orientation when filings flip a concept's calc weight", () => {
  const concept = "us-gaap:IncreaseDecreaseInAccountsReceivable";
  const parent = "us-gaap:NetCashProvidedByUsedInOperatingActivities";
  // Older filing: calc weight -1, raw -130. Latest: calc weight +1, raw +261.
  const older = filing("acc-2024", "2025-01-30", [statement("cash_flow_statement", [
    node(0, null, concept, "Accounts receivable", [fact("FY2024", -130e6)]),
  ])], [{ roleUri: "http://x/cf", parentConcept: parent, children: [{ concept, weight: -1, order: 1 }] }]);
  const latest = filing("acc-2025", "2026-01-30", [statement("cash_flow_statement", [
    node(0, null, concept, "Accounts receivable", [fact("FY2025", 261e6)]),
  ])], [{ roleUri: "http://x/cf", parentConcept: parent, children: [{ concept, weight: 1, order: 1 }] }]);
  const rows = buildConceptInventory({ filings: [older, latest], requestedPeriods: periods });
  assert.equal(rows.length, 1);
  // FY2024 resolves from the older filing; its -1 weight vs the latest's +1 flips the raw -130 to +130.
  assert.deepEqual(rows[0]!.values, { FY2024: 130e6, FY2025: 261e6 });
});

test("facts outside the requested periods are ignored", () => {
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2020", 20_000e6)]),
  ])]);
  assert.deepEqual(buildConceptInventory({ filings: [latest], requestedPeriods: periods }), []);
});
