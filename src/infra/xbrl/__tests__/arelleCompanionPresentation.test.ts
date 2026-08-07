import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/xbrl/arelle_companion.py", import.meta.url));

type Node = { nodeId: number; parentNodeId: number | null; conceptQName: string; label: string; abstract: boolean };

/** Arelle is unavailable here, so the presentation walk is exercised through the companion's debug CLI. */
function walk(spec: unknown): Node[] {
  const result = spawnSync("python3", [SCRIPT, "--walk-presentation"], { input: JSON.stringify(spec), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Node[];
}

test("the walk emits nodes in declared order with parent links", () => {
  const nodes = walk({
    roots: ["us-gaap:AssetsAbstract"],
    relationships: [
      { parent: "us-gaap:AssetsAbstract", child: "us-gaap:AssetsCurrent", order: 2, preferredLabel: "Total current assets", abstract: false },
      { parent: "us-gaap:AssetsAbstract", child: "us-gaap:CashAndCashEquivalentsAtCarryingValue", order: 1, preferredLabel: "Cash and cash equivalents", abstract: false },
    ],
    abstractConcepts: ["us-gaap:AssetsAbstract"],
    facts: [],
  });

  assert.deepEqual(nodes.map((node) => [node.nodeId, node.parentNodeId, node.conceptQName, node.label, node.abstract]), [
    [0, null, "us-gaap:AssetsAbstract", "us-gaap:AssetsAbstract", true],
    [1, 0, "us-gaap:CashAndCashEquivalentsAtCarryingValue", "Cash and cash equivalents", false],
    [2, 0, "us-gaap:AssetsCurrent", "Total current assets", false],
  ]);
});

test("one concept under two parents becomes two nodes", () => {
  const nodes = walk({
    roots: ["ex:Root"],
    relationships: [
      { parent: "ex:Root", child: "ex:A", order: 1, preferredLabel: "A", abstract: true },
      { parent: "ex:Root", child: "ex:B", order: 2, preferredLabel: "B", abstract: true },
      { parent: "ex:A", child: "ex:Shared", order: 1, preferredLabel: "Shared under A", abstract: false },
      { parent: "ex:B", child: "ex:Shared", order: 1, preferredLabel: "Shared under B", abstract: false },
    ],
    abstractConcepts: ["ex:Root", "ex:A", "ex:B"],
    facts: [],
  });

  const shared = nodes.filter((node) => node.conceptQName === "ex:Shared");
  assert.equal(shared.length, 2);
  assert.deepEqual(shared.map((node) => node.label), ["Shared under A", "Shared under B"]);
  assert.notEqual(shared[0]!.parentNodeId, shared[1]!.parentNodeId);
});

test("a cycle in the relationships terminates instead of hanging", () => {
  const nodes = walk({
    roots: ["ex:A"],
    relationships: [
      { parent: "ex:A", child: "ex:B", order: 1, preferredLabel: "B", abstract: false },
      { parent: "ex:B", child: "ex:A", order: 1, preferredLabel: "A again", abstract: false },
    ],
    abstractConcepts: [],
    facts: [],
  });

  assert.deepEqual(nodes.map((node) => node.conceptQName), ["ex:A", "ex:B"]);
});

type FactedNode = Node & { facts: Array<{ periodId: string; value: number }>; ambiguousPeriodIds: string[] };

function walkWithFacts(spec: unknown): FactedNode[] {
  return walk(spec) as unknown as FactedNode[];
}

const USD = { kind: "currency", code: "USD" };
const PPE_AXIS = "us-gaap:PropertyPlantAndEquipmentByTypeAxis";

function fact(conceptQName: string, periodId: string, value: number, dimensions: Array<{ axisQName: string; memberQName: string }> = []) {
  return { conceptQName, periodId, value, unit: USD, decimals: -6, contextId: `c-${value}`, sourceAnchor: "https://example.test#f", dimensions };
}

test("a dimensionless fact resolves its node", () => {
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [],
    relationships: [{ parent: "ex:Root", child: "us-gaap:Assets", order: 1, preferredLabel: "Total assets", abstract: false }],
    facts: [fact("us-gaap:Assets", "FY2025", 137806)],
  });

  const assets = nodes.find((node) => node.conceptQName === "us-gaap:Assets")!;
  assert.deepEqual(assets.facts.map((entry) => [entry.periodId, entry.value]), [["FY2025", 137806]]);
});

test("a line item reported only under a declared axis member still resolves", () => {
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [PPE_AXIS],
    relationships: [{ parent: "ex:Root", child: "us-gaap:DeferredCostsLeasingNetNoncurrent", order: 1, preferredLabel: "Operating lease vehicles, net", abstract: false }],
    facts: [fact("us-gaap:DeferredCostsLeasingNetNoncurrent", "FY2025", 4912, [{ axisQName: PPE_AXIS, memberQName: "tsla:OperatingLeaseVehiclesMember" }])],
  });

  const row = nodes.find((node) => node.conceptQName === "us-gaap:DeferredCostsLeasingNetNoncurrent")!;
  assert.deepEqual(row.facts.map((entry) => entry.value), [4912]);
  assert.deepEqual(row.ambiguousPeriodIds, []);
});

test("a fact on an axis the role does not declare is not a candidate", () => {
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [],
    relationships: [{ parent: "ex:Root", child: "us-gaap:Revenues", order: 1, preferredLabel: "Total revenues", abstract: false }],
    facts: [fact("us-gaap:Revenues", "FY2025", 1000, [{ axisQName: "srt:ProductOrServiceAxis", memberQName: "ex:Auto" }])],
  });

  assert.deepEqual(nodes.find((node) => node.conceptQName === "us-gaap:Revenues")!.facts, []);
});

test("the same fact tagged repeatedly in one context collapses to one value", () => {
  // TSLA tags cash three times in one filing; without collapsing by context these look like
  // three competing candidates and the line blanks out.
  const repeated = { ...fact("us-gaap:CashAndCashEquivalentsAtCarryingValue", "FY2025", 16513), contextId: "c-4" };
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [],
    relationships: [{ parent: "ex:Root", child: "us-gaap:CashAndCashEquivalentsAtCarryingValue", order: 1, preferredLabel: "Cash and cash equivalents", abstract: false }],
    facts: [repeated, { ...repeated }, { ...repeated }],
  });

  const cash = nodes.find((node) => node.conceptQName === "us-gaap:CashAndCashEquivalentsAtCarryingValue")!;
  assert.deepEqual(cash.facts.map((entry) => entry.value), [16513]);
  assert.deepEqual(cash.ambiguousPeriodIds, []);
});

test("within one context the finer decimals wins", () => {
  // The same number at two roundings: -6 is precise to the million, -7 to ten million.
  const coarse = { ...fact("us-gaap:IncomeTaxExpenseBenefit", "FY2025", 1420), contextId: "c-1", decimals: -7 };
  const fine = { ...fact("us-gaap:IncomeTaxExpenseBenefit", "FY2025", 1423), contextId: "c-1", decimals: -6 };
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [],
    relationships: [{ parent: "ex:Root", child: "us-gaap:IncomeTaxExpenseBenefit", order: 1, preferredLabel: "Provision for income taxes", abstract: false }],
    facts: [coarse, fine],
  });

  const tax = nodes.find((node) => node.conceptQName === "us-gaap:IncomeTaxExpenseBenefit")!;
  assert.deepEqual(tax.facts.map((entry) => entry.value), [1423]);
  assert.deepEqual(tax.ambiguousPeriodIds, []);
});

test("a dimensionless fact beats a declared-axis fact for the same period", () => {
  // The consolidated line is the dimensionless fact; members are its breakdown. Treating them as
  // peers blanks out every income-statement line that carries a product breakdown.
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: ["srt:ProductOrServiceAxis"],
    relationships: [{ parent: "ex:Root", child: "us-gaap:CostOfRevenue", order: 1, preferredLabel: "Total cost of revenues", abstract: false }],
    facts: [
      { ...fact("us-gaap:CostOfRevenue", "FY2025", 56267, [{ axisQName: "srt:ProductOrServiceAxis", memberQName: "ex:Automotive" }]), contextId: "c-auto" },
      { ...fact("us-gaap:CostOfRevenue", "FY2025", 11599, [{ axisQName: "srt:ProductOrServiceAxis", memberQName: "ex:Energy" }]), contextId: "c-energy" },
      { ...fact("us-gaap:CostOfRevenue", "FY2025", 77733), contextId: "c-total" },
    ],
  });

  const cost = nodes.find((node) => node.conceptQName === "us-gaap:CostOfRevenue")!;
  assert.deepEqual(cost.facts.map((entry) => entry.value), [77733]);
  assert.deepEqual(cost.ambiguousPeriodIds, []);
});

test("two declared-axis members and no dimensionless fact is ambiguous, and no value is invented", () => {
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [PPE_AXIS],
    relationships: [{ parent: "ex:Root", child: "ex:Line", order: 1, preferredLabel: "Line", abstract: false }],
    facts: [
      { ...fact("ex:Line", "FY2025", 10, [{ axisQName: PPE_AXIS, memberQName: "ex:MemberA" }]), contextId: "c-a" },
      { ...fact("ex:Line", "FY2025", 20, [{ axisQName: PPE_AXIS, memberQName: "ex:MemberB" }]), contextId: "c-b" },
    ],
  });

  const line = nodes.find((node) => node.conceptQName === "ex:Line")!;
  assert.deepEqual(line.facts, []);
  assert.deepEqual(line.ambiguousPeriodIds, ["FY2025"]);
});

test("an abstract node never carries facts", () => {
  const nodes = walkWithFacts({
    roots: ["us-gaap:AssetsAbstract"], abstractConcepts: ["us-gaap:AssetsAbstract"], declaredAxisQNames: [],
    relationships: [],
    facts: [fact("us-gaap:AssetsAbstract", "FY2025", 999)],
  });

  assert.deepEqual(nodes[0]!.facts, []);
});

const PERIOD_START = "http://www.xbrl.org/2003/role/periodStartLabel";
const PERIOD_END = "http://www.xbrl.org/2003/role/periodEndLabel";
const CASH = "us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsIncludingDisposalGroupAndDiscontinuedOperations";

/** Two instants: FY2024's close, which is also FY2025's opening balance, and FY2025's close. */
function rollforwardFacts() {
  return [
    { ...fact(CASH, "FY2024", 17037), contextId: "c-2024", startsPeriodId: "FY2025" },
    { ...fact(CASH, "FY2025", 17616), contextId: "c-2025", startsPeriodId: null },
  ];
}

test("a periodStartLabel row reads the opening instant, not the closing one", () => {
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [],
    relationships: [{ parent: "ex:Root", child: CASH, order: 1, preferredLabel: "Cash, beginning of period", preferredLabelRole: PERIOD_START, abstract: false }],
    facts: rollforwardFacts(),
  });

  const opening = nodes.find((node) => node.conceptQName === CASH)!;
  assert.deepEqual(opening.facts.map((entry) => [entry.periodId, entry.value]), [["FY2025", 17037]],
    "the opening row shows the prior close, stamped with the period it opens");
});

test("a periodEndLabel row still reads the closing instant", () => {
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [],
    relationships: [{ parent: "ex:Root", child: CASH, order: 1, preferredLabel: "Cash, end of period", preferredLabelRole: PERIOD_END, abstract: false }],
    facts: rollforwardFacts(),
  });

  const closing = nodes.find((node) => node.conceptQName === CASH)!;
  assert.deepEqual(closing.facts.map((entry) => [entry.periodId, entry.value]), [["FY2024", 17037], ["FY2025", 17616]]);
});

test("the opening and closing rows of one rollforward no longer share values", () => {
  // The regression this task exists for: same concept, two nodes, distinguished only by role.
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [],
    relationships: [
      { parent: "ex:Root", child: CASH, order: 1, preferredLabel: "Cash, beginning of period", preferredLabelRole: PERIOD_START, abstract: false },
      { parent: "ex:Root", child: CASH, order: 2, preferredLabel: "Cash, end of period", preferredLabelRole: PERIOD_END, abstract: false },
    ],
    facts: rollforwardFacts(),
  });

  const rows = nodes.filter((node) => node.conceptQName === CASH);
  assert.equal(rows.length, 2);
  const valueAt = (node: typeof rows[number], periodId: string) =>
    node.facts.find((entry) => entry.periodId === periodId)?.value;
  assert.equal(valueAt(rows[0]!, "FY2025"), 17037);
  assert.equal(valueAt(rows[1]!, "FY2025"), 17616);
});

test("a node with no preferred-label role resolves on periodId", () => {
  const nodes = walkWithFacts({
    roots: ["ex:Root"], abstractConcepts: ["ex:Root"], declaredAxisQNames: [],
    relationships: [{ parent: "ex:Root", child: "us-gaap:Assets", order: 1, preferredLabel: "Total assets", abstract: false }],
    facts: [{ ...fact("us-gaap:Assets", "FY2025", 137806), contextId: "c-a", startsPeriodId: null }],
  });

  assert.deepEqual(nodes.find((node) => node.conceptQName === "us-gaap:Assets")!.facts.map((entry) => entry.value), [137806]);
});
