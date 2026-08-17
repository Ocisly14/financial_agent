import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptInventory } from "../conceptInventory.ts";
import type { UnificationDecision } from "../unifiedStatements.ts";
import { applyUnificationPatch, buildUnifiedStatements, checkUnificationCompleteness } from "../unifiedStatements.ts";
import { fact, filing, node, period, statement } from "./spineFixture.ts";

const periods = [period("FY2024", 2024), period("FY2025", 2025)];

function simpleFilings() {
  const older = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 96_000e6)]),
    node(1, null, "us-gaap:CostOfRevenue", "Cost of revenues", [fact("FY2024", 60_000e6)]),
  ])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100_000e6), fact("FY2024", 96_000e6)]),
    node(1, null, "us-gaap:CostOfRevenue", "Cost of revenues", [fact("FY2025", 65_000e6), fact("FY2024", 60_000e6)]),
  ])]);
  return [older, latest];
}

/** Components are shared across years, so a row names its concept once; coverage does the rest. */
function decisionRow(rowId: string, concept: string, weight: 1 | -1 = 1) {
  return { rowId, statement: "income_statement" as const, label: rowId, rationale: "",
    components: [{ conceptQName: concept, weight }] };
}

test("completeness passes when every inventory cell is consumed exactly once", () => {
  const filings = simpleFilings();
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    decisionRow("revenues", "us-gaap:Revenues"),
    decisionRow("cost_of_revenues", "us-gaap:CostOfRevenue"),
  ] };
  assert.deepEqual(checkUnificationCompleteness({ inventory, decision, requestedPeriods: periods }), []);
});

test("completeness rejects a rowId that shadows the workbook's valueless structural root", () => {
  const filings = simpleFilings();
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    decisionRow("revenue", "us-gaap:Revenues"),
    decisionRow("cost_of_revenues", "us-gaap:CostOfRevenue"),
  ] };
  const findings = checkUnificationCompleteness({ inventory, decision, requestedPeriods: periods });
  assert.equal(findings.filter((f) => f.includes('"revenue"') && f.includes("reserved")).length, 1);
});

test("completeness flags dangling inventory cells, unknown components, and double-counts", () => {
  const filings = simpleFilings();
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    decisionRow("revenues", "us-gaap:Revenues"),
    // An empty override drops CostOfRevenue in FY2024, leaving that cell unconsumed -> dangling.
    { ...decisionRow("cost_of_revenues", "us-gaap:CostOfRevenue"),
      perYearOverrides: [{ periodId: "FY2024", components: [], reason: "deliberately dropped" }] },
    // An override naming a concept the period does not carry.
    { ...decisionRow("bogus", "us-gaap:Revenues"),
      perYearOverrides: [{ periodId: "FY2025", components: [{ conceptQName: "us-gaap:DoesNotExist", weight: 1 }], reason: "x" }] },
    // A shared component that exists in no period used to be silently filtered away, yielding an
    // accepted all-null row. It must be rejected before the coverage filter runs.
    decisionRow("shared_bogus", "us-gaap:SharedDoesNotExist"),
    // Revenues consumed a second time within the same statement.
    decisionRow("revenues_again", "us-gaap:Revenues"),
  ] };
  const findings = checkUnificationCompleteness({ inventory, decision, requestedPeriods: periods });
  assert.ok(findings.some((f) => f.includes("dangling") && f.includes("us-gaap:CostOfRevenue") && f.includes("FY2024")), findings.join("\n"));
  assert.ok(findings.some((f) => f.includes("us-gaap:DoesNotExist") && f.includes("not in the inventory")), findings.join("\n"));
  assert.ok(findings.some((f) => f.includes('"shared_bogus"') && f.includes("us-gaap:SharedDoesNotExist")
    && f.includes("not in the inventory")), findings.join("\n"));
  assert.ok(findings.some((f) => f.includes("double-count") && f.includes("us-gaap:Revenues") && f.includes("FY2025")), findings.join("\n"));
});

test("alsoTaggedAs resolves an overlapping re-tag without dangling or double-counting", () => {
  // Tesla's real shape: each 10-K restates two prior years, so a rename leaves both tags on the seam
  // years carrying the identical number. InterestExpense FY2021-23, InterestExpenseNonoperating FY2022-25.
  const old = "us-gaap:InterestExpense";
  const neu = "us-gaap:InterestExpenseNonoperating";
  const threePeriods = [period("FY2021", 2021), period("FY2022", 2022), period("FY2023", 2023)];
  const older = filing("acc-2023", "2024-01-29", [statement("income_statement", [
    node(0, null, old, "Interest expense", [fact("FY2021", 371e6), fact("FY2022", 191e6), fact("FY2023", 156e6)]),
  ])]);
  const latest = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, neu, "Interest expense", [fact("FY2022", 191e6), fact("FY2023", 156e6)]),
  ])]);
  const filings = [older, latest];
  const inventory = buildConceptInventory({ filings, requestedPeriods: threePeriods });
  const decision: UnificationDecision = { rows: [{
    rowId: "interest_expense", statement: "income_statement", label: "Interest expense", rationale: "renamed in FY2024",
    components: [{ conceptQName: neu, alsoTaggedAs: [{ conceptQName: old }], weight: 1 }] }] };
  // Both names in both seam years are consumed by the one component.
  assert.deepEqual(checkUnificationCompleteness({ inventory, decision, requestedPeriods: threePeriods }), []);
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: threePeriods, inventory });
  // Not 382e6 in the seam years: the component is read once, preferring the newer tag.
  assert.deepEqual(artifact.rows[0]!.values, { FY2021: 371e6, FY2022: 191e6, FY2023: 156e6 });
  assert.deepEqual(artifact.findings, []);
});

test("a roll-up child named by the newest tag still resolves in a period that used the older one", () => {
  const old = "us-gaap:InterestExpense";
  const neu = "us-gaap:InterestExpenseNonoperating";
  const parent = "us-gaap:OperatingIncomeLoss";
  // The newest filing's calculation names the NEW tag; FY2024 only ever carried the OLD one.
  const relations = [{ roleUri: "http://x/role/income_statement", parentConcept: parent,
    children: [{ concept: neu, weight: 1, order: 1 }] }];
  const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, old, "Interest expense", [fact("FY2024", 371e6)]),
    node(1, null, parent, "Operating income", [fact("FY2024", 371e6)]),
  ])], relations)];
  const onePeriod = [period("FY2024", 2024)];
  const inventory = buildConceptInventory({ filings, requestedPeriods: onePeriod });
  const decision: UnificationDecision = { rows: [
    { rowId: "interest_expense", statement: "income_statement", label: "Interest expense", rationale: "",
      components: [{ conceptQName: neu, alsoTaggedAs: [{ conceptQName: old }], weight: 1 }] },
    { rowId: "operating_income", statement: "income_statement", label: "Operating income", rationale: "",
      components: [{ conceptQName: parent, weight: 1 }] }] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: onePeriod, inventory });
  assert.deepEqual(artifact.rollupBreaks, []);
});

test("a sign-flipped alternate tag reconciles instead of reporting a disagreement", () => {
  // Tesla's real pair: "Digital assets gain, net" became "Digital assets loss (gain), net", so the
  // same FY2021 event is +27 under the old name and -27 under the new one.
  const old = "tsla:GainOnDigitalAssets";
  const neu = "tsla:GainLossOnDigitalAssets";
  const filings = [filing("acc-2022", "2023-01-31", [statement("income_statement", [
    node(0, null, old, "Digital assets gain, net", [fact("FY2021", 27e6)]),
    node(1, null, neu, "Digital assets loss (gain), net", [fact("FY2021", -27e6), fact("FY2022", 204e6)]),
  ])])];
  const twoPeriods = [period("FY2021", 2021), period("FY2022", 2022)];
  const inventory = buildConceptInventory({ filings, requestedPeriods: twoPeriods });
  const decision: UnificationDecision = { rows: [{
    rowId: "digital_assets", statement: "income_statement", label: "Digital assets loss (gain), net",
    rationale: "renamed with the polarity flipped",
    components: [{ conceptQName: neu, alsoTaggedAs: [{ conceptQName: old, sign: -1 }], weight: 1 }] }] };
  assert.deepEqual(checkUnificationCompleteness({ inventory, decision, requestedPeriods: twoPeriods }), []);
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: twoPeriods, inventory });
  // Both tags agree once polarity is accounted for, so no finding — and the series keeps the new convention.
  assert.deepEqual(artifact.findings, []);
  assert.deepEqual(artifact.rows[0]!.values, { FY2021: -27e6, FY2022: 204e6 });
});

test("alternate tags that disagree in an overlap year are reported, not silently merged", () => {
  const old = "us-gaap:InterestExpense";
  const neu = "us-gaap:InterestExpenseNonoperating";
  const filings = [filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, old, "Interest expense", [fact("FY2024", 191e6)]),
    node(1, null, neu, "Interest expense", [fact("FY2024", 250e6)]), // not the same number
  ])])];
  const onePeriod = [period("FY2024", 2024)];
  const inventory = buildConceptInventory({ filings, requestedPeriods: onePeriod });
  const decision: UnificationDecision = { rows: [{
    rowId: "interest_expense", statement: "income_statement", label: "Interest expense", rationale: "",
    components: [{ conceptQName: neu, alsoTaggedAs: [{ conceptQName: old }], weight: 1 }] }] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: onePeriod, inventory });
  assert.ok(artifact.findings.some((f) => f.includes("alternate tag") && f.includes("250000000") && f.includes("191000000")),
    artifact.findings.join("\n"));
});

test("shared components span a re-tag: each year keeps whichever concept it carries", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:SalesRevenueNet", "Net sales", [fact("FY2024", 96_000e6)]),
  ])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Net sales", [fact("FY2025", 100_000e6)]),
  ])]);
  const filings = [older, latest];
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  // One row, both tags listed side by side, no per-year enumeration at all.
  const decision: UnificationDecision = { rows: [{
    rowId: "net_sales", statement: "income_statement", label: "Net sales", rationale: "re-tag in FY2025",
    components: [{ conceptQName: "us-gaap:SalesRevenueNet", weight: 1 }, { conceptQName: "us-gaap:Revenues", weight: 1 }] }] };
  assert.deepEqual(checkUnificationCompleteness({ inventory, decision, requestedPeriods: periods }), []);
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: periods, inventory });
  // Not 196e9: the un-covered tag is dropped per period rather than summed.
  assert.deepEqual(artifact.rows[0]!.values, { FY2024: 96_000e6, FY2025: 100_000e6 });
});

test("an override replaces the shared components for one period", () => {
  const filings = simpleFilings();
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    { rowId: "revenues", statement: "income_statement", label: "Revenues", rationale: "",
      components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }],
      perYearOverrides: [{ periodId: "FY2024", components: [{ conceptQName: "us-gaap:CostOfRevenue", weight: 1 }],
        reason: "FY2024 tagged the figure under the cost concept" }] },
  ] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: periods, inventory });
  assert.deepEqual(artifact.rows[0]!.values, { FY2024: 60_000e6, FY2025: 100_000e6 });
});

test("supplemental keeps values out of the statements; excluded forfeits them; both answer dangling", () => {
  const filings = simpleFilings();
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = {
    rows: [decisionRow("revenues", "us-gaap:Revenues")],
    supplemental: [{ conceptQName: "us-gaap:CostOfRevenue", label: "Cost of revenues", reason: "not a face line here" }],
  };
  assert.deepEqual(checkUnificationCompleteness({ inventory, decision, requestedPeriods: periods }), []);
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: periods, inventory });
  assert.equal(artifact.rows.length, 1);
  assert.equal(artifact.supplementalRows.length, 1);
  assert.deepEqual(artifact.supplementalRows[0]!.values, { FY2024: 60_000e6, FY2025: 65_000e6 });

  const dropped: UnificationDecision = { rows: [decisionRow("revenues", "us-gaap:Revenues")],
    excluded: [{ conceptQName: "us-gaap:CostOfRevenue", reason: "duplicate of a total" }] };
  assert.deepEqual(checkUnificationCompleteness({ inventory, decision: dropped, requestedPeriods: periods }), []);
  const droppedArtifact = buildUnifiedStatements({ decision: dropped, filings, requestedPeriods: periods, inventory });
  assert.equal(droppedArtifact.supplementalRows.length, 0);
  assert.deepEqual(droppedArtifact.excluded,
    [{ conceptQName: "us-gaap:CostOfRevenue", dimensionSignature: "", reason: "duplicate of a total" }]);
});

test("a held-out concept that a row also consumes is a finding", () => {
  const filings = simpleFilings();
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    decisionRow("revenues", "us-gaap:Revenues"), decisionRow("cost_of_revenues", "us-gaap:CostOfRevenue")],
    excluded: [{ conceptQName: "us-gaap:CostOfRevenue", reason: "dropped" }] };
  const findings = checkUnificationCompleteness({ inventory, decision, requestedPeriods: periods });
  assert.ok(findings.some((f) => f.includes("cost_of_revenues") && f.includes("also listed as excluded")), findings.join("\n"));
});

test("a rollforward's opening and closing balance are separate cells, not one merged concept", () => {
  // Tesla's real shape: one concept, two presentation rows. Closing FY2024 is 17.037B while the
  // FY2025 row's opening balance is that same 17.037B — merging them made the closing row read the
  // opening number and shifted the whole cash series by a year.
  const cash = "us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents";
  const twoPeriods = [period("FY2024", 2024), period("FY2025", 2025)];
  const filings = [filing("acc-2025", "2026-01-29", [statement("cash_flow_statement", [
    { ...node(0, null, cash, "Cash, beginning of period", [fact("FY2024", 17.189e9), fact("FY2025", 17.037e9)]), openingBalance: true },
    node(1, null, cash, "Cash, end of period", [fact("FY2024", 17.037e9), fact("FY2025", 17.616e9)]),
  ])])];
  const inventory = buildConceptInventory({ filings, requestedPeriods: twoPeriods });
  // Two inventory rows, not one row with two labels.
  assert.equal(inventory.length, 2);
  assert.deepEqual(inventory.map((r) => r.openingBalance).sort(), [false, true]);

  const decision: UnificationDecision = { rows: [
    { rowId: "cash_beginning", statement: "cash_flow_statement", label: "Cash, beginning of period", rationale: "",
      components: [{ conceptQName: cash, openingBalance: true, weight: 1 }] },
    { rowId: "cash_end", statement: "cash_flow_statement", label: "Cash, end of period", rationale: "",
      components: [{ conceptQName: cash, weight: 1 }] },
  ] };
  assert.deepEqual(checkUnificationCompleteness({ inventory, decision, requestedPeriods: twoPeriods }), []);
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: twoPeriods, inventory });
  assert.deepEqual(artifact.rows.find((r) => r.rowId === "cash_end")!.values, { FY2024: 17.037e9, FY2025: 17.616e9 });
  assert.deepEqual(artifact.rows.find((r) => r.rowId === "cash_beginning")!.values, { FY2024: 17.189e9, FY2025: 17.037e9 });
  // The two rows read different facts, so neither is a restatement of the other.
  assert.deepEqual(artifact.restatements, []);
});

test("a row summing across units is refused rather than producing a meaningless number", () => {
  const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e9)]),
    node(1, null, "us-gaap:EarningsPerShareBasic", "EPS", [{ ...fact("FY2025", 6.08), unit: { kind: "per_share", code: "USD" } }]),
  ])])];
  const onePeriod = [period("FY2025", 2025)];
  const inventory = buildConceptInventory({ filings, requestedPeriods: onePeriod });
  const decision: UnificationDecision = { rows: [{
    rowId: "nonsense", statement: "income_statement", label: "Revenue plus EPS", rationale: "",
    components: [{ conceptQName: "us-gaap:Revenues", weight: 1 },
      { conceptQName: "us-gaap:EarningsPerShareBasic", weight: 1 }] }] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: onePeriod, inventory });
  assert.equal(artifact.rows[0]!.values["FY2025"], null);
  assert.ok(artifact.findings.some((f) => f.includes("different units") && f.includes("currency:USD") && f.includes("per_share:USD")),
    artifact.findings.join("\n"));
});

test("consuming a dimensionless total and its members together is reported as a double count", () => {
  const concept = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
  const axis = { axisQName: "srt:ProductOrServiceAxis", axisLabel: "Product", memberQName: "tsla:AutomotiveMember", memberLabel: "Automotive" };
  const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, concept, "Total revenues", [fact("FY2025", 100e9)]),
    node(1, null, concept, "Automotive", [{ ...fact("FY2025", 70e9), dimensions: [axis] }]),
  ])])];
  const onePeriod = [period("FY2025", 2025)];
  const inventory = buildConceptInventory({ filings, requestedPeriods: onePeriod });
  const decision: UnificationDecision = { rows: [
    { rowId: "total_revenue", statement: "income_statement", label: "Total revenues", rationale: "",
      components: [{ conceptQName: concept, weight: 1 }] },
    { rowId: "automotive_revenue", statement: "income_statement", label: "Automotive", rationale: "",
      components: [{ conceptQName: concept, dimensionSignature: inventory.find((r) => r.dimensionSignature !== "")!.dimensionSignature, weight: 1 }] },
  ] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: onePeriod, inventory });
  assert.ok(artifact.findings.some((f) => f.includes("double-count risk") && f.includes(concept)), artifact.findings.join("\n"));
});

test("a patch replaces rows in place, appends new ones, and leaves the rest untouched", () => {
  const base: UnificationDecision = {
    rows: [decisionRow("a", "us-gaap:A"), decisionRow("b", "us-gaap:B"), decisionRow("c", "us-gaap:C")],
    excluded: [{ conceptQName: "us-gaap:Old", reason: "abstract" }],
  };
  const patched = applyUnificationPatch(base, {
    upsertRows: [{ ...decisionRow("b", "us-gaap:B2"), label: "corrected" }, decisionRow("d", "us-gaap:D")],
    deleteRowIds: ["c"],
  });
  assert.deepEqual(patched.rows.map((r) => r.rowId), ["a", "b", "d"]);
  assert.equal(patched.rows[1]!.label, "corrected");
  assert.equal(patched.rows[1]!.components[0]!.conceptQName, "us-gaap:B2");
  // Untouched rows keep their previous content, and an omitted list is carried forward.
  assert.equal(patched.rows[0]!.components[0]!.conceptQName, "us-gaap:A");
  assert.deepEqual(patched.excluded, base.excluded);
});

test("a patch that includes a held-out list replaces that list wholesale", () => {
  const base: UnificationDecision = { rows: [decisionRow("a", "us-gaap:A")],
    excluded: [{ conceptQName: "us-gaap:Old", reason: "abstract" }],
    supplemental: [{ conceptQName: "us-gaap:Shares", label: "Shares", reason: "not a face line" }] };
  const patched = applyUnificationPatch(base, { excluded: [] });
  assert.deepEqual(patched.excluded, []);
  assert.deepEqual(patched.supplemental, base.supplemental);
});

test("a patch can incrementally upsert and delete held-out entries", () => {
  const base: UnificationDecision = { rows: [decisionRow("a", "us-gaap:A")],
    excluded: [{ conceptQName: "us-gaap:Abstract", reason: "abstract" }],
    supplemental: [{ conceptQName: "us-gaap:Shares", label: "Shares", reason: "not a face line" }] };
  const patched = applyUnificationPatch(base, {
    upsertExcluded: [{ conceptQName: "us-gaap:Old", reason: "superseded" }],
    deleteSupplemental: [{ conceptQName: "us-gaap:Shares" }],
  });
  assert.deepEqual(patched.excluded, [
    { conceptQName: "us-gaap:Abstract", reason: "abstract" },
    { conceptQName: "us-gaap:Old", reason: "superseded" },
  ]);
  assert.deepEqual(patched.supplemental, []);
});

test("a merged row sums its components by weight", () => {
  const filings = simpleFilings();
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [{
    rowId: "gross_profit", statement: "income_statement", label: "Gross profit", rationale: "revenues minus cost",
    components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }, { conceptQName: "us-gaap:CostOfRevenue", weight: -1 }] }] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: periods, inventory });
  assert.deepEqual(artifact.rows[0]!.values, { FY2024: 36_000e6, FY2025: 35_000e6 });
  const factFY2025 = artifact.facts.find((f) => f.periodId === "FY2025")!;
  assert.equal(factFY2025.lineItemId, "unified.income_statement.gross_profit");
  assert.equal(factFY2025.value, 35_000e6);
  assert.equal(factFY2025.provenance.concept, "us-gaap:Revenues+us-gaap:CostOfRevenue");
  assert.equal(factFY2025.provenance.sourceRefs.length, 2);
  assert.equal(factFY2025.provenance.accession, "acc-2025");
});

test("sign orientation flips older-filing values, keeps the series consistent, reports no false restatement", () => {
  const concept = "us-gaap:IncreaseDecreaseInAccountsReceivable";
  const parent = "us-gaap:NetCashProvidedByUsedInOperatingActivities";
  const threePeriods = [period("FY2023", 2023), ...periods];
  // Older filing: weight +1 convention, raw negatives. Latest: weight -1 convention, raw positives.
  const older = filing("acc-2024", "2025-01-30", [statement("cash_flow_statement", [
    node(0, null, concept, "Accounts receivable", [fact("FY2023", 100e6), fact("FY2024", 130e6)]),
  ])], [{ roleUri: "http://x/role/cash_flow_statement", parentConcept: parent, children: [{ concept, weight: 1, order: 1 }] }]);
  const latest = filing("acc-2025", "2026-01-30", [statement("cash_flow_statement", [
    node(0, null, concept, "Accounts receivable", [fact("FY2024", -130e6), fact("FY2025", -261e6)]),
  ])], [{ roleUri: "http://x/role/cash_flow_statement", parentConcept: parent, children: [{ concept, weight: -1, order: 1 }] }]);
  const filings = [older, latest];
  const inventory = buildConceptInventory({ filings, requestedPeriods: threePeriods });
  const decision: UnificationDecision = { rows: [{
    rowId: "change_in_accounts_receivable", statement: "cash_flow_statement", label: "Accounts receivable", rationale: "",
    components: [{ conceptQName: concept, weight: 1 as const }] }] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: threePeriods, inventory });
  // Reference orientation is the latest filing's (-1 weight); the older filing's raw values are negated.
  assert.deepEqual(artifact.rows[0]!.values, { FY2023: -100e6, FY2024: -130e6, FY2025: -261e6 });
  // Both filings carry FY2024 under opposite conventions — normalized, they agree: no restatement.
  assert.deepEqual(artifact.restatements, []);
  assert.deepEqual(artifact.rollupBreaks, []);
  const byPeriod = new Map(artifact.facts.map((f) => [f.periodId, f]));
  assert.equal(byPeriod.get("FY2023")!.provenance.signFlipped, true);
  assert.equal(byPeriod.get("FY2023")!.value, -100e6);
  assert.equal(byPeriod.get("FY2024")!.provenance.signFlipped, undefined);
  assert.equal(byPeriod.get("FY2025")!.provenance.signFlipped, undefined);
});

test("a missing component fact yields a finding and a null cell with no fact", () => {
  const filings = simpleFilings();
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [{
    rowId: "revenues", statement: "income_statement", label: "Revenues", rationale: "",
    components: [{ conceptQName: "us-gaap:Revenues", weight: 1 }],
    // Overrides are not coverage-filtered, so this reaches the fact lookup and finds nothing.
    perYearOverrides: [{ periodId: "FY2025", components: [{ conceptQName: "us-gaap:SalesRevenueNet", weight: 1 }], reason: "re-tag" }] }] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: periods, inventory });
  assert.deepEqual(artifact.rows[0]!.values, { FY2024: 96_000e6, FY2025: null });
  assert.ok(artifact.findings.some((f) => f.includes("us-gaap:SalesRevenueNet") && f.includes("FY2025")));
  assert.ok(!artifact.facts.some((f) => f.periodId === "FY2025"));
});

test("roll-up verification catches a parent that does not equal its children", () => {
  const relations = [{ roleUri: "http://x/role/income_statement", parentConcept: "us-gaap:GrossProfit",
    children: [{ concept: "us-gaap:Revenues", weight: 1, order: 1 }, { concept: "us-gaap:CostOfRevenue", weight: -1, order: 2 }] }];
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e9)]),
    node(1, null, "us-gaap:CostOfRevenue", "Cost of revenues", [fact("FY2025", 70e9)]),
    node(2, null, "us-gaap:GrossProfit", "Gross profit", [fact("FY2025", 40e9)]), // should be 30e9
  ])], relations);
  const inventory = buildConceptInventory({ filings: [latest], requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    decisionRow("revenues", "us-gaap:Revenues"),
    decisionRow("cost_of_revenues", "us-gaap:CostOfRevenue"),
    decisionRow("gross_profit", "us-gaap:GrossProfit"),
  ] };
  const artifact = buildUnifiedStatements({ decision, filings: [latest], requestedPeriods: periods, inventory });
  assert.equal(artifact.rollupBreaks.length, 1);
  assert.equal(artifact.rollupBreaks[0]!.parentConcept, "us-gaap:GrossProfit");
  assert.equal(artifact.rollupBreaks[0]!.reported, 40e9);
  assert.equal(artifact.rollupBreaks[0]!.computed, 30e9);
  assert.equal(artifact.rollupBreaks[0]!.difference, 10e9);
  assert.ok(artifact.findings.some((f) => f.includes("roll-up break") && f.includes("us-gaap:GrossProfit")));
});

test("a roll-up residual inside the materiality ratio is recorded but not raised as a finding", () => {
  const relations = [{ roleUri: "http://x/role/income_statement", parentConcept: "us-gaap:GrossProfit",
    children: [{ concept: "us-gaap:Revenues", weight: 1, order: 1 }] }];
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e9)]),
    node(1, null, "us-gaap:GrossProfit", "Gross profit", [fact("FY2025", 100.4e9)]), // 0.4% short
  ])], relations);
  const inventory = buildConceptInventory({ filings: [latest], requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    decisionRow("revenues", "us-gaap:Revenues"), decisionRow("gross_profit", "us-gaap:GrossProfit")] };
  const artifact = buildUnifiedStatements({ decision, filings: [latest], requestedPeriods: periods, inventory });
  assert.equal(artifact.rollupBreaks.length, 1);
  assert.equal(artifact.rollupBreaks[0]!.material, false);
  assert.deepEqual(artifact.findings, []);
  // The same residual is material under a stricter ratio.
  const strict = buildUnifiedStatements({ decision, filings: [latest], requestedPeriods: periods, inventory,
    rollupMateriality: 0.001 });
  assert.equal(strict.rollupBreaks[0]!.material, true);
  assert.equal(strict.findings.length, 1);
});

test("a statement-less amendment filed after the 10-K does not disable roll-up verification", () => {
  const relations = [{ roleUri: "http://x/role/income_statement", parentConcept: "us-gaap:GrossProfit",
    children: [{ concept: "us-gaap:Revenues", weight: 1, order: 1 }] }];
  const annual = filing("acc-2025", "2026-01-29", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e9)]),
    node(1, null, "us-gaap:GrossProfit", "Gross profit", [fact("FY2025", 130e9)]), // should be 100e9
  ])], relations);
  // A 10-K/A filed later carrying no face statements at all — the real shape of TSLA's amendments.
  const amendment = filing("acc-2025-a", "2026-04-30", [], []);
  const inventory = buildConceptInventory({ filings: [annual, amendment], requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    decisionRow("revenues", "us-gaap:Revenues"), decisionRow("gross_profit", "us-gaap:GrossProfit")] };
  const artifact = buildUnifiedStatements({ decision, filings: [annual, amendment], requestedPeriods: periods, inventory });
  assert.equal(artifact.rollupBreaks.length, 1);
  assert.equal(artifact.rollupBreaks[0]!.difference, 30e9);
});

test("each period is verified against the structure of the filing that still reports it", () => {
  // Tesla's real shape: a line the early years had ("Customer deposits") is gone from the newest
  // filing's balance sheet, so the newest structure cannot explain the older year's total.
  const twoPeriods = [period("FY2021", 2021), period("FY2022", 2022)];
  const relationsOld = [{ roleUri: "http://x/role/balance_sheet", parentConcept: "us-gaap:LiabilitiesCurrent",
    children: [{ concept: "us-gaap:AccountsPayableCurrent", weight: 1, order: 1 },
      { concept: "us-gaap:CustomerDepositsCurrent", weight: 1, order: 2 }] }];
  const relationsNew = [{ roleUri: "http://x/role/balance_sheet", parentConcept: "us-gaap:LiabilitiesCurrent",
    children: [{ concept: "us-gaap:AccountsPayableCurrent", weight: 1, order: 1 }] }];
  const older = filing("acc-2021", "2022-02-07", [statement("balance_sheet", [
    node(0, null, "us-gaap:AccountsPayableCurrent", "Accounts payable", [fact("FY2021", 10_025e6)]),
    node(1, null, "us-gaap:CustomerDepositsCurrent", "Customer deposits", [fact("FY2021", 925e6)]),
    node(2, null, "us-gaap:LiabilitiesCurrent", "Total current liabilities", [fact("FY2021", 10_950e6)]),
  ])], relationsOld);
  const latest = filing("acc-2022", "2023-01-31", [statement("balance_sheet", [
    node(0, null, "us-gaap:AccountsPayableCurrent", "Accounts payable", [fact("FY2022", 15_255e6)]),
    node(1, null, "us-gaap:LiabilitiesCurrent", "Total current liabilities", [fact("FY2022", 15_255e6)]),
  ])], relationsNew);
  const filings = [older, latest];
  const inventory = buildConceptInventory({ filings, requestedPeriods: twoPeriods });
  const decision: UnificationDecision = { rows: [
    { rowId: "accounts_payable", statement: "balance_sheet", label: "Accounts payable", rationale: "",
      components: [{ conceptQName: "us-gaap:AccountsPayableCurrent", weight: 1 }] },
    { rowId: "customer_deposits", statement: "balance_sheet", label: "Customer deposits", rationale: "",
      components: [{ conceptQName: "us-gaap:CustomerDepositsCurrent", weight: 1 }] },
    { rowId: "total_current_liabilities", statement: "balance_sheet", label: "Total current liabilities", rationale: "",
      components: [{ conceptQName: "us-gaap:LiabilitiesCurrent", weight: 1 }] },
  ] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: twoPeriods, inventory });
  // FY2021 checks against the FY2021 filing's structure, which still knows about customer deposits.
  assert.deepEqual(artifact.rollupBreaks, []);
});

test("a footnote role's calculation does not verify against face-statement values", () => {
  // Apple's EPS footnote decomposes diluted shares as basic + incremental, but only the face
  // statement's concepts are unified — the incremental share concept lives in the footnote alone.
  // Checking the face values against that decomposition would break in every period.
  const footnote = { roleUri: "http://x/role/EarningsPerShareDetails",
    parentConcept: "us-gaap:GrossProfit",
    children: [{ concept: "us-gaap:Revenues", weight: 1, order: 1 },
      { concept: "us-gaap:NotOnTheFaceStatement", weight: 1, order: 2 }] };
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e9)]),
    node(1, null, "us-gaap:GrossProfit", "Gross profit", [fact("FY2025", 130e9)]),
  ])], [footnote]);
  const inventory = buildConceptInventory({ filings: [latest], requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [
    decisionRow("revenues", "us-gaap:Revenues"), decisionRow("gross_profit", "us-gaap:GrossProfit")] };
  const artifact = buildUnifiedStatements({ decision, filings: [latest], requestedPeriods: periods, inventory });
  assert.deepEqual(artifact.rollupBreaks, []);
  assert.deepEqual(artifact.findings, []);
});

test("a genuine restatement beyond tolerance is recorded with orientation-normalized candidates", () => {
  const concept = "us-gaap:Revenues";
  const parent = "us-gaap:GrossProfit";
  // Older filing uses the opposite convention AND a different magnitude: normalized -(-96e9) = 96e9 vs 100e9.
  const older = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, concept, "Revenues", [fact("FY2024", -96_000e6)]),
  ])], [{ roleUri: "http://x/role/income_statement", parentConcept: parent, children: [{ concept, weight: -1, order: 1 }] }]);
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, concept, "Revenues", [fact("FY2024", 100_000e6)]),
  ])], [{ roleUri: "http://x/role/income_statement", parentConcept: parent, children: [{ concept, weight: 1, order: 1 }] }]);
  const filings = [older, latest];
  const inventory = buildConceptInventory({ filings, requestedPeriods: periods });
  const decision: UnificationDecision = { rows: [decisionRow("revenues", concept)] };
  const artifact = buildUnifiedStatements({ decision, filings, requestedPeriods: periods, inventory });
  assert.equal(artifact.restatements.length, 1);
  const restatement = artifact.restatements[0]!;
  assert.equal(restatement.chosenAccession, "acc-2025");
  assert.equal(restatement.chosenValue, 100_000e6);
  const olderCandidate = restatement.candidates.find((c) => c.accession === "acc-2024")!;
  assert.equal(olderCandidate.value, 96_000e6); // normalized, not the raw -96e9
  assert.equal(artifact.rows[0]!.values["FY2024"], 100_000e6);
});

test("a concept absorbed into another line stops resolving in the periods that restated it", () => {
  // Tesla's real shape. Customer deposits was its own balance-sheet line through the FY2022 10-K,
  // and the FY2023 10-K folded it into accrued liabilities — restating the FY2022 comparative from
  // 7,142 to 8,205, a difference of exactly the 1,063 deposits line. The deposits fact still exists
  // in the older filing for FY2022, so resolving "newest filing that carries THIS CONCEPT" keeps
  // paying it out and the same 1,063 lands in the statements twice. The authority for a period is
  // the newest filing that reports that period at all: for FY2022 that is the FY2023 10-K, which
  // does not carry the line. FY2021's authority is still the FY2022 10-K, which does — so FY2021
  // must keep its value. That contrast is the whole rule.
  const twoPeriods = [period("FY2021", 2021), period("FY2022", 2022)];
  const deposits = "tsla:CustomerDepositsLiabilitiesCurrent";
  const accrued = "tsla:AccruedAndOtherCurrentLiabilities";
  const older = filing("acc-2022", "2023-01-31", [statement("balance_sheet", [
    node(0, null, accrued, "Accrued liabilities and other", [fact("FY2022", 7_142e6), fact("FY2021", 5_719e6)]),
    node(1, null, deposits, "Customer deposits", [fact("FY2022", 1_063e6), fact("FY2021", 925e6)]),
  ])]);
  const latest = filing("acc-2023", "2024-01-29", [statement("balance_sheet", [
    node(0, null, accrued, "Accrued liabilities and other", [fact("FY2022", 8_205e6)]),
  ])]);
  const filings = [older, latest];
  const inventory = buildConceptInventory({ filings, requestedPeriods: twoPeriods });
  const decision: UnificationDecision = { rows: [
    { rowId: "accrued", statement: "balance_sheet", label: "Accrued", rationale: "",
      components: [{ conceptQName: accrued, weight: 1 }] },
    { rowId: "customer_deposits", statement: "balance_sheet", label: "Customer deposits", rationale: "",
      components: [{ conceptQName: deposits, weight: 1 }] },
  ] };
  const built = buildUnifiedStatements({ decision, filings, requestedPeriods: twoPeriods, inventory });
  const row = built.rows.find((r) => r.rowId === "customer_deposits")!;

  assert.equal(row.values["FY2021"], 925e6, "FY2021's authority still reports the line — keep it");
  assert.equal(row.values["FY2022"], null, "FY2022 was restated to fold this line in — it must not be paid out twice");
  assert.equal(built.rows.find((r) => r.rowId === "accrued")!.values["FY2022"], 8_205e6);
  // The drop has to be legible as a restatement, not as a hole in the extraction.
  const finding = built.findings.find((f) => f.includes("customer_deposits") && f.includes("FY2022"));
  assert.ok(finding !== undefined && finding.includes("acc-2023"), built.findings.join("\n"));
});
