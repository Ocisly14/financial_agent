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
  assert.deepEqual(rows[0]!.periodCoverage, ["FY2024", "FY2025"]);
  assert.equal(rows[0]!.sampleValue, 100_000e6);
  assert.equal(rows[0]!.onlyInOlderFilings, false);
  assert.deepEqual(rows[0]!.perYearSigns, [{ periodId: "FY2024", sign: 1 }, { periodId: "FY2025", sign: 1 }]);
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
  assert.deepEqual(byConcept.get("us-gaap:Revenues")!.periodCoverage, ["FY2025"]);
  assert.equal(byConcept.get("us-gaap:SalesRevenueNet")!.onlyInOlderFilings, true);
  assert.deepEqual(byConcept.get("us-gaap:SalesRevenueNet")!.periodCoverage, ["FY2024"]);
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
  assert.equal(dimensional.sampleValue, 4_912e6);
  assert.equal(dimensional.parentLabel, "Assets");
  assert.equal(dimensional.depth, 1);
  assert.ok(!rows.some((row) => row.conceptQName === "us-gaap:AssetsAbstract"));
});

test("perYearSigns are consistent after orientation when filings flip a concept's calc weight", () => {
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
  assert.deepEqual(rows[0]!.perYearSigns, [{ periodId: "FY2024", sign: 1 }, { periodId: "FY2025", sign: 1 }]);
});

test("facts outside the requested periods are ignored", () => {
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2020", 20_000e6)]),
  ])]);
  assert.deepEqual(buildConceptInventory({ filings: [latest], requestedPeriods: periods }), []);
});
