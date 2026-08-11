# DCF Spine Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From five filings' per-filing presented statements (`FilingExtraction.statements`), produce the multi-year DCF spine input: a single-agent concept mapping, deterministically backfilled values with provenance, a restatement report, and deterministic verification.

**Architecture:** Four stages per spec `docs/superpowers/specs/2026-08-07-dcf-spine-mapping-design.md`: ① pure concept inventory (`src/infra/xbrl/conceptInventory.ts`), ② single-agent mapping decision loop with completeness pre-check and ≤2 findings-driven re-runs (`src/agent/financial-modeling/spineMappingLoop.ts`), ③ pure backfill, latest-filing-wins (`src/infra/xbrl/spineBackfill.ts`), ④ pure verification (`src/infra/xbrl/verifySpineModel.ts`). The agent never touches a number.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`), `node:test` + `node:assert/strict`, existing `ModelRouter` LLM abstraction, existing `validate()` JsonSchema validator from `mcp_tools/financial-model/schemas.ts`. No new dependencies.

## Global Constraints

- **Do NOT `git commit` yourself.** User rule: after each task, stop and let the user review the diff. Task "commit" steps below are replaced by "pause for user review".
- Run a single test file with: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test <path>`; the full suite with `npm test`.
- Follow repo style: 2-space indent, `.ts` extensions in imports, compact code, comments only for non-obvious constraints.
- Tests use hand-built `FilingExtraction` fixtures (the TSLA protocol-3 fixture does not exist yet; the extraction design is unimplemented). No network, no Arelle.
- Tolerance rule everywhere: `Math.max(1, Math.abs(reported) * 1e-6)` and, when `decimals` is known, at least `0.5 * 10 ** -decimals` (e.g. `decimals: -6` → 500 000). Helper defined in Task 3, reused in Task 4.
- Canonical spine ids come from `CANONICAL_MAPPING_IDS` in `src/financial-model/skeleton.ts`. Never hardcode the list.

---

### Task 1: Concept inventory (stage ①)

**Files:**
- Create: `src/infra/xbrl/conceptInventory.ts`
- Create: `src/infra/xbrl/__tests__/spineFixture.ts` (shared test helpers)
- Test: `src/infra/xbrl/__tests__/conceptInventory.test.ts`

**Interfaces:**
- Consumes: `FilingExtraction`, `PresentationStatementPayload`, `XbrlDimension` from `src/infra/xbrl/types.ts`; `Period`, `StatementKind`, `Unit` from `src/financial-model/types.ts`; `dimensionSignature` from `src/infra/xbrl/mergeCuratedTables.ts`.
- Produces: `InventoryRow` type and `buildConceptInventory(input: { filings: readonly FilingExtraction[]; requestedPeriods: readonly Period[] }): InventoryRow[]`. Tasks 2 and 5 rely on both names exactly.

- [ ] **Step 1: Write the shared fixture helper**

```ts
// src/infra/xbrl/__tests__/spineFixture.ts
import type { Period, Unit } from "../../../financial-model/types.ts";
import type { FilingExtraction, PresentationFactPayload, PresentationNodePayload, PresentationStatementPayload } from "../types.ts";

export const USD: Unit = { kind: "currency", code: "USD" };

export function period(id: string, year: number): Period {
  return { id, label: id, start: `${year}-01-01`, end: `${year}-12-31`, cls: "actual" };
}

export function fact(periodId: string, value: number, over: Partial<PresentationFactPayload> = {}): PresentationFactPayload {
  return { periodId, value, unit: USD, decimals: -6, contextId: `c-${periodId}`, sourceAnchor: `#${periodId}`, dimensions: [], ...over };
}

export function node(nodeId: number, parentNodeId: number | null, conceptQName: string, label: string,
  facts: PresentationFactPayload[], abstract = false): PresentationNodePayload {
  return { nodeId, parentNodeId, conceptQName, label, abstract, facts, ambiguousPeriodIds: [] };
}

export function statement(kind: PresentationStatementPayload["statement"], nodes: PresentationNodePayload[]): PresentationStatementPayload {
  return { statement: kind, roleUri: `http://x/role/${kind}`, roleLabel: kind, declaredAxisQNames: [], nodes };
}

export function filing(accession: string, filedAt: string, statements: PresentationStatementPayload[],
  calculationRelations: FilingExtraction["calculationRelations"] = []): FilingExtraction {
  return { filing: { accession, form: "10-K", filedAt, reportDate: filedAt, primaryDocumentUrl: `https://sec.gov/${accession}` },
    tables: [], calculationRelations, negatedConcepts: [], diagnostics: [], statements };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/infra/xbrl/__tests__/conceptInventory.test.ts
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

test("facts outside the requested periods are ignored", () => {
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2020", 20_000e6)]),
  ])]);
  assert.deepEqual(buildConceptInventory({ filings: [latest], requestedPeriods: periods }), []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/conceptInventory.test.ts`
Expected: FAIL — cannot find module `../conceptInventory.ts`.

- [ ] **Step 4: Implement `conceptInventory.ts`**

```ts
// src/infra/xbrl/conceptInventory.ts
import type { Period, StatementKind, Unit } from "../../financial-model/types.ts";
import { dimensionSignature } from "./mergeCuratedTables.ts";
import type { FilingExtraction, PresentationNodePayload, XbrlDimension } from "./types.ts";

export type InventoryRow = {
  statement: StatementKind;
  conceptQName: string;
  /** "" for dimensionless rows. */
  dimensionSignature: string;
  dimensions: XbrlDimension[];
  /** Distinct display labels, latest filing's first. */
  labels: string[];
  /** Tree position in the latest filing carrying this row; null when onlyInOlderFilings. */
  parentLabel: string | null;
  depth: number;
  onlyInOlderFilings: boolean;
  /** Sorted periodIds with at least one fact across filings. */
  periodCoverage: string[];
  /** Most recent value, for sign/scale judgment only — never backfilled from here. */
  sampleValue: number | null;
  sampleUnit: Unit | null;
};

type Accumulator = InventoryRow & { samplePeriodEnd: string; order: number };

export function buildConceptInventory(input: {
  filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[];
}): InventoryRow[] {
  const requested = new Map(input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => [p.id, p.end]));
  // Newest first: index 0 defines labels[0], tree position, and row order.
  const filings = [...input.filings].sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt));
  const rows = new Map<string, Accumulator>();
  const coverage = new Map<string, Set<string>>();
  let appendOrder = 1_000_000; // rows absent from the latest filing sort after its declared order

  filings.forEach((extraction, filingIndex) => {
    for (const stmt of extraction.statements) {
      const byNodeId = new Map(stmt.nodes.map((n) => [n.nodeId, n]));
      stmt.nodes.forEach((node, nodeOrder) => {
        if (node.abstract) return;
        for (const factPayload of node.facts) {
          const end = requested.get(factPayload.periodId);
          if (end === undefined) continue;
          const signature = dimensionSignature(factPayload.dimensions);
          const key = `${stmt.statement}|${node.conceptQName}|${signature}`;
          let row = rows.get(key);
          if (!row) {
            row = { statement: stmt.statement, conceptQName: node.conceptQName, dimensionSignature: signature,
              dimensions: [...factPayload.dimensions], labels: [], parentLabel: null, depth: 0,
              onlyInOlderFilings: filingIndex > 0, periodCoverage: [], sampleValue: null, sampleUnit: null,
              samplePeriodEnd: "", order: filingIndex === 0 ? nodeOrder : appendOrder++ };
            if (filingIndex === 0) { const pos = treePosition(node, byNodeId); row.parentLabel = pos.parentLabel; row.depth = pos.depth; }
            rows.set(key, row);
            coverage.set(key, new Set());
          }
          if (!row.labels.includes(node.label)) row.labels.push(node.label);
          coverage.get(key)!.add(factPayload.periodId);
          if (end > row.samplePeriodEnd) { row.samplePeriodEnd = end; row.sampleValue = factPayload.value; row.sampleUnit = factPayload.unit; }
        }
      });
    }
  });

  return [...rows.entries()]
    .sort(([, a], [, b]) => statementOrder(a.statement) - statementOrder(b.statement) || a.order - b.order)
    .map(([key, { samplePeriodEnd: _end, order: _order, ...row }]) =>
      ({ ...row, periodCoverage: [...coverage.get(key)!].sort() }));
}

function treePosition(node: PresentationNodePayload, byNodeId: Map<number, PresentationNodePayload>): { parentLabel: string | null; depth: number } {
  let depth = 0;
  let parent = node.parentNodeId === null ? undefined : byNodeId.get(node.parentNodeId);
  const parentLabel = parent?.label ?? null;
  while (parent) { depth += 1; parent = parent.parentNodeId === null ? undefined : byNodeId.get(parent.parentNodeId); }
  return { parentLabel, depth };
}

const STATEMENT_ORDER: readonly StatementKind[] = ["income_statement", "balance_sheet", "cash_flow_statement"];
function statementOrder(statement: StatementKind): number { return STATEMENT_ORDER.indexOf(statement); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/conceptInventory.test.ts`
Expected: 4 passing.

- [ ] **Step 6: Pause for user review** (no commit — user rule)

---

### Task 2: Mapping decision types + completeness check

**Files:**
- Create: `src/infra/xbrl/spineMappingDecision.ts`
- Test: `src/infra/xbrl/__tests__/spineMappingDecision.test.ts`

**Interfaces:**
- Consumes: `InventoryRow` from Task 1.
- Produces: `PerYearConcept`, `SpineMappingDecision`, and `checkMappingCompleteness(input: { inventory: readonly InventoryRow[]; decision: SpineMappingDecision; spineIds: ReadonlySet<string> }): string[]` (empty array = pass; each string is one finding). Tasks 3–5 rely on these names exactly.

- [ ] **Step 1: Write the failing tests**

```ts
// src/infra/xbrl/__tests__/spineMappingDecision.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptInventory } from "../conceptInventory.ts";
import { checkMappingCompleteness, type SpineMappingDecision } from "../spineMappingDecision.ts";
import { fact, filing, node, period, statement } from "./spineFixture.ts";

const periods = [period("FY2025", 2025)];
const inventory = buildConceptInventory({ filings: [filing("acc-2025", "2026-01-30", [statement("income_statement", [
  node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e6)]),
  node(1, null, "us-gaap:CostOfRevenue", "Cost of revenues", [fact("FY2025", 60e6)]),
])])], requestedPeriods: periods });
const spineIds = new Set(["revenue.total", "cost_of_revenue"]);

const valid: SpineMappingDecision = {
  mappings: [
    { targetId: "revenue.total", perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:Revenues" }], rationale: "top line" },
    { targetId: "cost_of_revenue", perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:CostOfRevenue" }], rationale: "cogs" },
  ],
  detailRows: [], excluded: [], spineGaps: [],
};

test("a complete decision passes", () => {
  assert.deepEqual(checkMappingCompleteness({ inventory, decision: valid, spineIds }), []);
});

test("an inventory concept left dangling is a finding", () => {
  const decision = { ...valid, mappings: [valid.mappings[0]!] };
  const findings = checkMappingCompleteness({ inventory, decision, spineIds });
  assert.ok(findings.some((f) => f.includes("us-gaap:CostOfRevenue") && f.includes("not covered")));
});

test("a spine id with neither mapping nor gap is a finding, as is an unknown targetId", () => {
  const missing = { ...valid, mappings: [valid.mappings[0]!], excluded: [{ conceptQName: "us-gaap:CostOfRevenue", reason: "n/a" }] };
  assert.ok(checkMappingCompleteness({ inventory, decision: missing, spineIds }).some((f) => f.includes("cost_of_revenue")));
  const unknown = { ...valid, spineGaps: [{ targetId: "not_a_spine_id", reason: "x" }] };
  assert.ok(checkMappingCompleteness({ inventory, decision: unknown, spineIds }).some((f) => f.includes("not_a_spine_id")));
});

test("double-mapping one (targetId, periodId) and referencing an unknown concept are findings", () => {
  const doubled: SpineMappingDecision = { ...valid, mappings: [...valid.mappings,
    { targetId: "revenue.total", perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:CostOfRevenue" }], rationale: "dup" }] };
  assert.ok(checkMappingCompleteness({ inventory, decision: doubled, spineIds }).some((f) => f.includes("revenue.total") && f.includes("FY2025")));
  const ghost: SpineMappingDecision = { ...valid, excluded: [{ conceptQName: "us-gaap:DoesNotExist", reason: "x" }] };
  assert.ok(checkMappingCompleteness({ inventory, decision: ghost, spineIds }).some((f) => f.includes("us-gaap:DoesNotExist")));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/spineMappingDecision.test.ts`
Expected: FAIL — cannot find module `../spineMappingDecision.ts`.

- [ ] **Step 3: Implement `spineMappingDecision.ts`**

```ts
// src/infra/xbrl/spineMappingDecision.ts
import type { InventoryRow } from "./conceptInventory.ts";

export type PerYearConcept = { periodId: string; conceptQName: string; dimensionSignature?: string };

export type SpineMappingDecision = {
  mappings: Array<{ targetId: string; perYear: PerYearConcept[]; rationale: string }>;
  detailRows: Array<{ parentTargetId: string; label: string; perYear: PerYearConcept[]; rationale: string }>;
  excluded: Array<{ conceptQName: string; reason: string }>;
  spineGaps: Array<{ targetId: string; reason: string }>;
};

/** Both directions must be exact: no dangling inventory concepts, no unaddressed spine ids, no third state. */
export function checkMappingCompleteness(input: {
  inventory: readonly InventoryRow[];
  decision: SpineMappingDecision;
  spineIds: ReadonlySet<string>;
}): string[] {
  const findings: string[] = [];
  const { decision } = input;
  const known = new Set(input.inventory.map((row) => row.conceptQName));
  const referenced = new Set<string>();
  const perYearRefs = [...decision.mappings.flatMap((m) => m.perYear), ...decision.detailRows.flatMap((d) => d.perYear)];
  for (const ref of perYearRefs) referenced.add(ref.conceptQName);
  for (const drop of decision.excluded) referenced.add(drop.conceptQName);

  for (const concept of referenced) if (!known.has(concept)) findings.push(`unknown concept referenced: ${concept} is not in the inventory`);
  for (const row of input.inventory) if (!referenced.has(row.conceptQName)) {
    findings.push(`inventory concept not covered: ${row.conceptQName} (${row.statement}) must be mapped, a detail row, or excluded with a reason`);
  }

  const addressed = new Map<string, string>();
  for (const mapping of decision.mappings) addressed.set(mapping.targetId, "mapping");
  for (const gap of decision.spineGaps) {
    if (addressed.has(gap.targetId)) findings.push(`spine id both mapped and declared a gap: ${gap.targetId}`);
    addressed.set(gap.targetId, "gap");
  }
  for (const targetId of addressed.keys()) if (!input.spineIds.has(targetId)) findings.push(`unknown spine targetId: ${targetId}`);
  for (const targetId of input.spineIds) if (!addressed.has(targetId)) {
    findings.push(`spine id unaddressed: ${targetId} needs a mapping or an explicit spineGaps entry`);
  }
  for (const detail of decision.detailRows) if (!input.spineIds.has(detail.parentTargetId)) {
    findings.push(`detail row "${detail.label}" attaches to unknown parentTargetId: ${detail.parentTargetId}`);
  }

  const seen = new Set<string>();
  for (const mapping of decision.mappings) for (const ref of mapping.perYear) {
    const key = `${mapping.targetId}|${ref.periodId}`;
    if (seen.has(key)) findings.push(`double-mapped: ${mapping.targetId} has two concepts for ${ref.periodId}`);
    seen.add(key);
  }
  return findings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/spineMappingDecision.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Pause for user review**

---

### Task 3: Backfill (stage ③)

**Files:**
- Create: `src/infra/xbrl/spineBackfill.ts`
- Test: `src/infra/xbrl/__tests__/spineBackfill.test.ts`

**Interfaces:**
- Consumes: `SpineMappingDecision`, `PerYearConcept` (Task 2); `FilingExtraction` payload types; `Fact`, `Period` from `src/financial-model/types.ts`; `dimensionSignature` from `mergeCuratedTables.ts`.
- Produces (Tasks 4–6 rely on these exactly):

```ts
export type RestatementDifference = { conceptQName: string; dimensionSignature: string; periodId: string;
  chosenAccession: string; chosenValue: number;
  candidates: Array<{ accession: string; value: number; contextId: string; sourceAnchor: string }> };
export type BackfillFinding = { code: "missing_fact"; lineId: string; periodId: string; conceptQName: string; message: string };
export type SpineBackfillResult = { facts: Fact[]; restatements: RestatementDifference[]; findings: BackfillFinding[] };
export function backfillSpine(input: { decision: SpineMappingDecision; filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[] }): SpineBackfillResult;
export function valueTolerance(reported: number, decimals?: number): number;
```

Fact conventions: `factId` = `spine.<lineId>.<periodId>`, `status: "staged"`, `lineItemId` = the spine `targetId` for mappings and `detail.<parentTargetId>.<slug(label)>` for detail rows (slug = lowercase, non-alphanumerics → `_`), provenance `{ sourceType: "xbrl_presentation", sourceRefs: [sourceAnchor], asOfDate: <filedAt of chosen filing>, decimals, accession, concept, filingUrl }`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/infra/xbrl/__tests__/spineBackfill.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { backfillSpine, valueTolerance } from "../spineBackfill.ts";
import type { SpineMappingDecision } from "../spineMappingDecision.ts";
import { fact, filing, node, period, statement } from "./spineFixture.ts";

const periods = [period("FY2024", 2024), period("FY2025", 2025)];
const decision: SpineMappingDecision = {
  mappings: [{ targetId: "revenue.total", rationale: "top line", perYear: [
    { periodId: "FY2024", conceptQName: "us-gaap:Revenues" }, { periodId: "FY2025", conceptQName: "us-gaap:Revenues" }] }],
  detailRows: [], excluded: [], spineGaps: [],
};

test("latest filing wins; agreement within tolerance stays out of the restatement report", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 96_000e6)])])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 96_000e6), fact("FY2025", 100_000e6)])])]);
  const result = backfillSpine({ decision, filings: [older, latest], requestedPeriods: periods });
  assert.equal(result.facts.length, 2);
  const fy24 = result.facts.find((f) => f.periodId === "FY2024")!;
  assert.equal(fy24.provenance.accession, "acc-2025");
  assert.equal(fy24.factId, "spine.revenue.total.FY2024");
  assert.equal(fy24.lineItemId, "revenue.total");
  assert.equal(fy24.status, "staged");
  assert.deepEqual(result.restatements, []);
  assert.deepEqual(result.findings, []);
});

test("a disagreement beyond tolerance lands in the restatement report with all candidates; latest still chosen", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 95_000e6)])])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 96_000e6), fact("FY2025", 100_000e6)])])]);
  const result = backfillSpine({ decision, filings: [older, latest], requestedPeriods: periods });
  assert.equal(result.facts.find((f) => f.periodId === "FY2024")!.value, 96_000e6);
  assert.equal(result.restatements.length, 1);
  assert.equal(result.restatements[0]!.chosenAccession, "acc-2025");
  assert.equal(result.restatements[0]!.candidates.length, 2);
});

test("a mapping pointing at a (concept, period) with no fact anywhere is a missing_fact finding, not a silent blank", () => {
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100_000e6)])])]);
  const result = backfillSpine({ decision, filings: [latest], requestedPeriods: periods });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.code, "missing_fact");
  assert.equal(result.findings[0]!.periodId, "FY2024");
});

test("detail rows backfill under detail.<parent>.<slug> ids and dimensional refs match by signature", () => {
  const dims = [{ axisQName: "us-gaap:PropertyPlantAndEquipmentByTypeAxis", axisLabel: "PPE",
    memberQName: "tsla:OperatingLeaseVehiclesMember", memberLabel: "Lease vehicles" }];
  const latest = filing("acc-2025", "2026-01-30", [statement("balance_sheet", [
    node(0, null, "us-gaap:DeferredCostsLeasingNetNoncurrent", "Lease vehicles", [fact("FY2025", 4_912e6, { dimensions: dims })]),
    node(1, null, "us-gaap:DeferredCostsLeasingNetNoncurrent", "Deferred costs", [fact("FY2025", 100e6)])])]);
  const withDetail: SpineMappingDecision = { mappings: [], excluded: [], spineGaps: [], detailRows: [{
    parentTargetId: "property_plant_equipment", label: "Operating Lease Vehicles", rationale: "material",
    perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:DeferredCostsLeasingNetNoncurrent",
      dimensionSignature: "us-gaap:PropertyPlantAndEquipmentByTypeAxis=tsla:OperatingLeaseVehiclesMember:" }] }] };
  const result = backfillSpine({ decision: withDetail, filings: [latest], requestedPeriods: periods });
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]!.value, 4_912e6);
  assert.equal(result.facts[0]!.lineItemId, "detail.property_plant_equipment.operating_lease_vehicles");
});

test("valueTolerance honors decimals", () => {
  assert.equal(valueTolerance(1e9), Math.max(1, 1e9 * 1e-6));
  assert.equal(valueTolerance(1e9, -6), 500_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/spineBackfill.test.ts`
Expected: FAIL — cannot find module `../spineBackfill.ts`.

- [ ] **Step 3: Implement `spineBackfill.ts`**

```ts
// src/infra/xbrl/spineBackfill.ts
import type { Fact, Period } from "../../financial-model/types.ts";
import { dimensionSignature } from "./mergeCuratedTables.ts";
import type { FilingExtraction } from "./types.ts";
import type { PerYearConcept, SpineMappingDecision } from "./spineMappingDecision.ts";

export type RestatementDifference = { conceptQName: string; dimensionSignature: string; periodId: string;
  chosenAccession: string; chosenValue: number;
  candidates: Array<{ accession: string; value: number; contextId: string; sourceAnchor: string }> };

export type BackfillFinding = { code: "missing_fact"; lineId: string; periodId: string; conceptQName: string; message: string };

export type SpineBackfillResult = { facts: Fact[]; restatements: RestatementDifference[]; findings: BackfillFinding[] };

/** XBRL values are rounded to `decimals`; two filings agreeing to that precision are the same number. */
export function valueTolerance(reported: number, decimals?: number): number {
  const base = Math.max(1, Math.abs(reported) * 1e-6);
  return decimals === undefined ? base : Math.max(base, 0.5 * 10 ** -decimals);
}

type Candidate = { accession: string; filedAt: string; value: number; unit: Fact["unit"]; decimals?: number;
  contextId: string; sourceAnchor: string; filingUrl: string };

export function backfillSpine(input: {
  decision: SpineMappingDecision;
  filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[];
}): SpineBackfillResult {
  const requested = new Set(input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => p.id));
  // concept|signature|period -> candidates, newest filing first.
  const index = new Map<string, Candidate[]>();
  const filings = [...input.filings].sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt));
  for (const extraction of filings) {
    for (const stmt of extraction.statements) for (const node of stmt.nodes) for (const payload of node.facts) {
      if (!requested.has(payload.periodId)) continue;
      const key = `${node.conceptQName}|${dimensionSignature(payload.dimensions)}|${payload.periodId}`;
      const list = index.get(key) ?? [];
      list.push({ accession: extraction.filing.accession, filedAt: extraction.filing.filedAt, value: payload.value,
        unit: payload.unit, decimals: payload.decimals, contextId: payload.contextId, sourceAnchor: payload.sourceAnchor,
        filingUrl: extraction.filing.primaryDocumentUrl });
      index.set(key, list);
    }
  }

  const facts: Fact[] = [];
  const restatements: RestatementDifference[] = [];
  const findings: BackfillFinding[] = [];
  const reported = new Set<string>();

  const fill = (lineId: string, ref: PerYearConcept) => {
    if (!requested.has(ref.periodId)) return;
    const signature = ref.dimensionSignature ?? "";
    const candidates = index.get(`${ref.conceptQName}|${signature}|${ref.periodId}`);
    if (!candidates || candidates.length === 0) {
      findings.push({ code: "missing_fact", lineId, periodId: ref.periodId, conceptQName: ref.conceptQName,
        message: `mapping for ${lineId} points at ${ref.conceptQName} in ${ref.periodId}, but no filing carries that fact` });
      return;
    }
    const chosen = candidates[0]!;
    facts.push({ factId: `spine.${lineId}.${ref.periodId}`, status: "staged", lineItemId: lineId,
      periodId: ref.periodId, value: chosen.value, unit: chosen.unit,
      provenance: { sourceType: "xbrl_presentation", sourceRefs: [chosen.sourceAnchor], asOfDate: chosen.filedAt,
        decimals: chosen.decimals, accession: chosen.accession, concept: ref.conceptQName, filingUrl: chosen.filingUrl } });
    const reportKey = `${ref.conceptQName}|${signature}|${ref.periodId}`;
    if (reported.has(reportKey)) return;
    if (candidates.some((c) => Math.abs(c.value - chosen.value) > valueTolerance(chosen.value, chosen.decimals))) {
      reported.add(reportKey);
      restatements.push({ conceptQName: ref.conceptQName, dimensionSignature: signature, periodId: ref.periodId,
        chosenAccession: chosen.accession, chosenValue: chosen.value,
        candidates: candidates.map(({ accession, value, contextId, sourceAnchor }) => ({ accession, value, contextId, sourceAnchor })) });
    }
  };

  for (const mapping of input.decision.mappings) for (const ref of mapping.perYear) fill(mapping.targetId, ref);
  for (const detail of input.decision.detailRows) for (const ref of detail.perYear) {
    fill(`detail.${detail.parentTargetId}.${slug(detail.label)}`, ref);
  }
  return { facts, restatements, findings };
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/spineBackfill.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Pause for user review**

---

### Task 4: Verification (stage ④)

**Files:**
- Create: `src/infra/xbrl/verifySpineModel.ts`
- Test: `src/infra/xbrl/__tests__/verifySpineModel.test.ts`

**Interfaces:**
- Consumes: `SpineMappingDecision` (Task 2), `SpineBackfillResult`, `valueTolerance` (Task 3), `CalculationRelation` from `types.ts`.
- Produces (Task 5 relies on these exactly):

```ts
export type SpineVerification = {
  rollupBreaks: Array<{ roleUri: string; parentConcept: string; periodId: string;
    reported: number; computed: number; difference: number; missingChildren: string[] }>;
  /** Restatement differences re-stated as continuity findings; same data, spec §5.2. */
  continuityBreaks: SpineBackfillResult["restatements"];
  coverageGaps: Array<{ targetId: string; periodId: string }>;
  /** All of the above formatted as agent-readable findings; empty = pass (continuity never blocks). */
  findings: string[];
};
export function verifySpineModel(input: { decision: SpineMappingDecision; backfill: SpineBackfillResult;
  filings: readonly FilingExtraction[]; requestedPeriods: readonly Period[]; spineIds: ReadonlySet<string> }): SpineVerification;
```

`findings` gates the loop: it contains roll-up breaks and coverage gaps (blocking) but NOT continuity breaks (report-only, spec §5.2).

- [ ] **Step 1: Write the failing tests**

```ts
// src/infra/xbrl/__tests__/verifySpineModel.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { backfillSpine } from "../spineBackfill.ts";
import type { SpineMappingDecision } from "../spineMappingDecision.ts";
import { verifySpineModel } from "../verifySpineModel.ts";
import { fact, filing, node, period, statement } from "./spineFixture.ts";

const periods = [period("FY2025", 2025)];
const spineIds = new Set(["revenue.total", "cost_of_revenue", "gross_profit"]);
const relations = [{ roleUri: "http://x/role/income_statement", parentConcept: "us-gaap:GrossProfit",
  children: [{ concept: "us-gaap:Revenues", weight: 1, order: 1 }, { concept: "us-gaap:CostOfRevenue", weight: -1, order: 2 }] }];

function decisionFor(): SpineMappingDecision {
  return { mappings: [
    { targetId: "revenue.total", perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:Revenues" }], rationale: "r" },
    { targetId: "cost_of_revenue", perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:CostOfRevenue" }], rationale: "c" },
    { targetId: "gross_profit", perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:GrossProfit" }], rationale: "g" },
  ], detailRows: [], excluded: [], spineGaps: [] };
}

function filingWith(gross: number) {
  return filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e6)]),
    node(1, null, "us-gaap:CostOfRevenue", "Cost", [fact("FY2025", 60e6)]),
    node(2, null, "us-gaap:GrossProfit", "Gross profit", [fact("FY2025", gross)]),
  ])], relations);
}

test("a consistent roll-up passes and full coverage yields no findings", () => {
  const filings = [filingWith(40e6)];
  const backfill = backfillSpine({ decision: decisionFor(), filings, requestedPeriods: periods });
  const result = verifySpineModel({ decision: decisionFor(), backfill, filings, requestedPeriods: periods, spineIds });
  assert.deepEqual(result.rollupBreaks, []);
  assert.deepEqual(result.coverageGaps, []);
  assert.deepEqual(result.findings, []);
});

test("a broken roll-up is a blocking finding with the difference", () => {
  const filings = [filingWith(45e6)];
  const backfill = backfillSpine({ decision: decisionFor(), filings, requestedPeriods: periods });
  const result = verifySpineModel({ decision: decisionFor(), backfill, filings, requestedPeriods: periods, spineIds });
  assert.equal(result.rollupBreaks.length, 1);
  assert.equal(result.rollupBreaks[0]!.difference, 45e6 - 40e6);
  assert.ok(result.findings.some((f) => f.includes("us-gaap:GrossProfit")));
});

test("a spine id with neither value nor gap declaration is a coverage gap; a declared gap is not", () => {
  const decision = decisionFor();
  decision.mappings = decision.mappings.filter((m) => m.targetId !== "gross_profit");
  const filings = [filingWith(40e6)];
  const backfill = backfillSpine({ decision, filings, requestedPeriods: periods });
  const gapless = verifySpineModel({ decision, backfill, filings, requestedPeriods: periods, spineIds });
  assert.deepEqual(gapless.coverageGaps, [{ targetId: "gross_profit", periodId: "FY2025" }]);
  decision.spineGaps = [{ targetId: "gross_profit", reason: "not presented" }];
  const declared = verifySpineModel({ decision, backfill, filings, requestedPeriods: periods, spineIds });
  assert.deepEqual(declared.coverageGaps, []);
});

test("continuity breaks pass through from the restatement report and never block", () => {
  const older = filing("acc-2024", "2025-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 95e6)])])]);
  const latest = filing("acc-2025", "2026-01-30", [statement("income_statement", [
    node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2024", 96e6), fact("FY2025", 100e6)])])]);
  const twoYears = [period("FY2024", 2024), period("FY2025", 2025)];
  const decision: SpineMappingDecision = { mappings: [{ targetId: "revenue.total", rationale: "r", perYear: [
    { periodId: "FY2024", conceptQName: "us-gaap:Revenues" }, { periodId: "FY2025", conceptQName: "us-gaap:Revenues" }] }],
    detailRows: [], excluded: [], spineGaps: [
      { targetId: "cost_of_revenue", reason: "n/a" }, { targetId: "gross_profit", reason: "n/a" }] };
  const backfill = backfillSpine({ decision, filings: [older, latest], requestedPeriods: twoYears });
  const result = verifySpineModel({ decision, backfill, filings: [older, latest], requestedPeriods: twoYears, spineIds });
  assert.equal(result.continuityBreaks.length, 1);
  assert.deepEqual(result.findings, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/verifySpineModel.test.ts`
Expected: FAIL — cannot find module `../verifySpineModel.ts`.

- [ ] **Step 3: Implement `verifySpineModel.ts`**

```ts
// src/infra/xbrl/verifySpineModel.ts
import type { Period } from "../../financial-model/types.ts";
import type { SpineBackfillResult } from "./spineBackfill.ts";
import { valueTolerance } from "./spineBackfill.ts";
import type { SpineMappingDecision } from "./spineMappingDecision.ts";
import type { FilingExtraction } from "./types.ts";

export type SpineVerification = {
  rollupBreaks: Array<{ roleUri: string; parentConcept: string; periodId: string;
    reported: number; computed: number; difference: number; missingChildren: string[] }>;
  /** Restatement differences re-stated as continuity findings; same data, spec §5.2. */
  continuityBreaks: SpineBackfillResult["restatements"];
  coverageGaps: Array<{ targetId: string; periodId: string }>;
  /** Blocking findings only: roll-up breaks and coverage gaps. Continuity is report-only. */
  findings: string[];
};

export function verifySpineModel(input: {
  decision: SpineMappingDecision;
  backfill: SpineBackfillResult;
  filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[];
  spineIds: ReadonlySet<string>;
}): SpineVerification {
  const actualPeriods = input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => p.id);

  // concept -> periodId -> backfilled value, via the decision's per-year concept choice.
  const values = new Map<string, Map<string, { value: number; decimals?: number }>>();
  const factByLine = new Map(input.backfill.facts.map((f) => [`${f.lineItemId}|${f.periodId}`, f]));
  for (const mapping of input.decision.mappings) for (const ref of mapping.perYear) {
    const backfilled = factByLine.get(`${mapping.targetId}|${ref.periodId}`);
    if (!backfilled) continue;
    const byPeriod = values.get(ref.conceptQName) ?? new Map();
    byPeriod.set(ref.periodId, { value: backfilled.value, decimals: backfilled.provenance.decimals });
    values.set(ref.conceptQName, byPeriod);
  }

  const rollupBreaks: SpineVerification["rollupBreaks"] = [];
  const latest = [...input.filings].sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt))[0];
  const seen = new Set<string>();
  for (const relation of latest?.calculationRelations ?? []) {
    const parents = values.get(relation.parentConcept);
    if (!parents) continue;
    for (const [periodId, parent] of parents) {
      const dedupe = `${relation.roleUri}|${relation.parentConcept}|${periodId}`;
      if (seen.has(dedupe)) continue;
      const present = relation.children.filter((child) => values.get(child.concept)?.has(periodId));
      if (present.length === 0) continue;
      seen.add(dedupe);
      const computed = present.reduce((sum, child) => sum + child.weight * values.get(child.concept)!.get(periodId)!.value, 0);
      const difference = parent.value - computed;
      if (Math.abs(difference) <= valueTolerance(parent.value, parent.decimals)) continue;
      rollupBreaks.push({ roleUri: relation.roleUri, parentConcept: relation.parentConcept, periodId,
        reported: parent.value, computed, difference,
        missingChildren: relation.children.filter((c) => !values.get(c.concept)?.has(periodId)).map((c) => c.concept) });
    }
  }

  const gapDeclared = new Set(input.decision.spineGaps.map((gap) => gap.targetId));
  const coverageGaps: SpineVerification["coverageGaps"] = [];
  for (const targetId of input.spineIds) {
    if (gapDeclared.has(targetId)) continue;
    for (const periodId of actualPeriods) {
      if (!factByLine.has(`${targetId}|${periodId}`)) coverageGaps.push({ targetId, periodId });
    }
  }

  const findings = [
    ...rollupBreaks.map((b) => `roll-up break: ${b.parentConcept} in ${b.periodId} reports ${b.reported} but children compute ${b.computed} (diff ${b.difference}); absent children: ${b.missingChildren.join(", ") || "none"}`),
    ...coverageGaps.map((g) => `coverage gap: ${g.targetId} has no value in ${g.periodId} and no spineGaps declaration`),
  ];
  return { rollupBreaks, continuityBreaks: input.backfill.restatements, coverageGaps, findings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/verifySpineModel.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `npm test`
Expected: all passing (new files touch nothing existing).

- [ ] **Step 6: Pause for user review**

---

### Task 5: Agent loop (stage ②) + prompt

**Files:**
- Create: `src/agent/financial-modeling/spineMappingLoop.ts`
- Modify: `src/agent/prompts/subagentPrompts.ts` (append one exported string constant)
- Test: `src/agent/financial-modeling/__tests__/spineMappingLoop.test.ts`

**Interfaces:**
- Consumes: `buildConceptInventory`/`InventoryRow` (Task 1), `checkMappingCompleteness`/`SpineMappingDecision` (Task 2), `backfillSpine` (Task 3), `verifySpineModel` (Task 4), `ModelRouter` from `src/infra/llm/provider.ts`, `validate` from `mcp_tools/financial-model/schemas.ts`, `CANONICAL_MAPPING_IDS` from `src/financial-model/skeleton.ts`.
- Produces:

```ts
export type SpineMappingRun = { decision: SpineMappingDecision; backfill: SpineBackfillResult;
  verification: SpineVerification; unresolvedFindings: string[] };
export async function runSpineMappingLoop(input: { modelRouter: ModelRouter;
  filings: readonly FilingExtraction[]; requestedPeriods: readonly Period[];
  spineIds?: readonly string[]; maxRuns?: number }): Promise<SpineMappingRun>;
```

Semantics: `maxRuns` defaults to 3 (initial + 2 findings-driven re-runs, spec §5). A clean run returns `unresolvedFindings: []`. After the cap, the last completed run returns with its findings in `unresolvedFindings` — ships, never silently passes. If the completeness pre-check fails on every run (so backfill never ran), throw. Malformed JSON gets one backoff retry; a schema-invalid decision gets one in-band correction round (both copied from `decompositionReduceLoop.ts`).

- [ ] **Step 1: Append the system prompt to `subagentPrompts.ts`**

```ts
/** Stage-② mapper (spec docs/superpowers/specs/2026-08-07-dcf-spine-mapping-design.md §3). Plain string: the loop builds its own messages. */
export const spineMappingSystemPrompt = `You map an issuer's XBRL face-statement concepts onto the canonical DCF spine.
You receive a concept inventory (every face-statement concept across all filings, with labels, tree position, per-year
coverage, and a magnitude sample) and the list of canonical spine target ids.

Rules:
- Every inventory concept must end up in exactly one of: mappings (per-year concept for a spine id), detailRows
  (supplementary row under a canonical parent), or excluded (with a reason). No concept may be left unaddressed.
- Every spine id must be either mapped or declared in spineGaps with a reason (e.g. the issuer has no preferred stock).
- perYear may use different concepts in different years: when the issuer re-tagged a line, align old and new concepts
  explicitly. The coverage column shows re-tags directly.
- One (targetId, periodId) maps to exactly one concept.
- You never output values. Values are resolved from the filings by code; the magnitude sample is for judgment only.
- Prefer dimensionless consolidated concepts for spine mappings; dimensional rows are usually detailRows.
- detailRows are for material issuer-specific lines worth modeling separately (e.g. operating lease vehicles).`;
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/agent/financial-modeling/__tests__/spineMappingLoop.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { fact, filing, node, period, statement } from "../../../infra/xbrl/__tests__/spineFixture.ts";
import { runSpineMappingLoop } from "../spineMappingLoop.ts";

function scripted(responses: string[]): { router: ModelRouter; prompts: () => string[] } {
  let call = 0;
  const seen: string[] = [];
  const provider: LlmProvider = { name: "scripted", generate: async (messages) => {
    seen.push(messages.map((m) => m.content).join("\n---\n"));
    return { text: responses[Math.min(call++, responses.length - 1)]!,
      metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } };
  } };
  return { router: new ModelRouter(provider), prompts: () => seen };
}

const periods = [period("FY2025", 2025)];
const filings = [filing("acc-2025", "2026-01-30", [statement("income_statement", [
  node(0, null, "us-gaap:Revenues", "Revenues", [fact("FY2025", 100e6)]),
])])];
const spineIds = ["revenue.total"];
const good = JSON.stringify({ mappings: [{ targetId: "revenue.total", rationale: "top line",
  perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:Revenues" }] }], detailRows: [], excluded: [], spineGaps: [] });

test("a clean decision backfills, verifies, and returns with no unresolved findings in one run", async () => {
  const { router } = scripted([good]);
  const run = await runSpineMappingLoop({ modelRouter: router, filings, requestedPeriods: periods, spineIds });
  assert.deepEqual(run.unresolvedFindings, []);
  assert.equal(run.backfill.facts.length, 1);
  assert.equal(run.backfill.facts[0]!.lineItemId, "revenue.total");
});

test("completeness findings are fed back verbatim and the corrected second run succeeds", async () => {
  const incomplete = JSON.stringify({ mappings: [], detailRows: [], excluded: [], spineGaps: [] });
  const { router, prompts } = scripted([incomplete, good]);
  const run = await runSpineMappingLoop({ modelRouter: router, filings, requestedPeriods: periods, spineIds });
  assert.deepEqual(run.unresolvedFindings, []);
  assert.ok(prompts()[1]!.includes("[FINDINGS FROM PREVIOUS RUN]"));
  assert.ok(prompts()[1]!.includes("us-gaap:Revenues"));
});

test("after maxRuns the last run ships with its unresolved findings instead of looping or passing silently", async () => {
  const phantom = JSON.stringify({ mappings: [{ targetId: "revenue.total", rationale: "r",
    perYear: [{ periodId: "FY2025", conceptQName: "us-gaap:Revenues" }, { periodId: "FY2024", conceptQName: "us-gaap:Revenues" }] }],
    detailRows: [], excluded: [], spineGaps: [] });
  const twoYears = [period("FY2024", 2024), period("FY2025", 2025)];
  const { router } = scripted([phantom, phantom, phantom]);
  const run = await runSpineMappingLoop({ modelRouter: router, filings, requestedPeriods: twoYears, spineIds, maxRuns: 3 });
  assert.ok(run.unresolvedFindings.some((f) => f.includes("missing_fact") || f.includes("FY2024")));
});

test("a schema-invalid decision gets one in-band correction round, then throws", async () => {
  const invalid = JSON.stringify({ mappings: "not an array" });
  const { router } = scripted([invalid, invalid]);
  await assert.rejects(
    runSpineMappingLoop({ modelRouter: router, filings, requestedPeriods: periods, spineIds }),
    /mappings/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/spineMappingLoop.test.ts`
Expected: FAIL — cannot find module `../spineMappingLoop.ts`.

- [ ] **Step 4: Implement `spineMappingLoop.ts`**

```ts
// src/agent/financial-modeling/spineMappingLoop.ts
import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import type { JsonSchema } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { Period } from "../../financial-model/types.ts";
import { CANONICAL_MAPPING_IDS } from "../../financial-model/skeleton.ts";
import { buildConceptInventory } from "../../infra/xbrl/conceptInventory.ts";
import { backfillSpine, type SpineBackfillResult } from "../../infra/xbrl/spineBackfill.ts";
import { checkMappingCompleteness, type SpineMappingDecision } from "../../infra/xbrl/spineMappingDecision.ts";
import { verifySpineModel, type SpineVerification } from "../../infra/xbrl/verifySpineModel.ts";
import type { FilingExtraction } from "../../infra/xbrl/types.ts";
import { spineMappingSystemPrompt } from "../prompts/subagentPrompts.ts";

const PER_YEAR: JsonSchema = { type: "object", additionalProperties: false, required: ["periodId", "conceptQName"],
  properties: { periodId: { type: "string" }, conceptQName: { type: "string" }, dimensionSignature: { type: "string" } } };

const DECISION_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["mappings", "detailRows", "excluded", "spineGaps"], properties: {
    mappings: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["targetId", "perYear", "rationale"],
      properties: { targetId: { type: "string" }, rationale: { type: "string" }, perYear: { type: "array", items: PER_YEAR } } } },
    detailRows: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["parentTargetId", "label", "perYear", "rationale"],
      properties: { parentTargetId: { type: "string" }, label: { type: "string" }, rationale: { type: "string" },
        perYear: { type: "array", items: PER_YEAR } } } },
    excluded: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["conceptQName", "reason"], properties: { conceptQName: { type: "string" }, reason: { type: "string" } } } },
    spineGaps: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["targetId", "reason"], properties: { targetId: { type: "string" }, reason: { type: "string" } } } },
  } };

export type SpineMappingRun = {
  decision: SpineMappingDecision;
  backfill: SpineBackfillResult;
  verification: SpineVerification;
  /** Findings the ≤maxRuns loop could not clear. Empty on a clean run. Never silently empty on a dirty one. */
  unresolvedFindings: string[];
};

export async function runSpineMappingLoop(input: {
  modelRouter: ModelRouter;
  filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[];
  spineIds?: readonly string[];
  /** Initial run + findings-driven re-runs. Spec §5: 3 (initial + 2). */
  maxRuns?: number;
}): Promise<SpineMappingRun> {
  const spineIds: ReadonlySet<string> = new Set(input.spineIds ?? [...CANONICAL_MAPPING_IDS]);
  const inventory = buildConceptInventory({ filings: input.filings, requestedPeriods: input.requestedPeriods });
  const maxRuns = input.maxRuns ?? 3;
  let findings: string[] = [];
  let last: SpineMappingRun | undefined;

  for (let run = 1; run <= maxRuns; run += 1) {
    const decision = await requestDecision(input.modelRouter, inventory, spineIds, findings);
    findings = checkMappingCompleteness({ inventory, decision, spineIds });
    if (findings.length > 0) continue;
    const backfill = backfillSpine({ decision, filings: input.filings, requestedPeriods: input.requestedPeriods });
    const verification = verifySpineModel({ decision, backfill,
      filings: input.filings, requestedPeriods: input.requestedPeriods, spineIds });
    findings = [...backfill.findings.map((f) => `${f.code}: ${f.message}`), ...verification.findings];
    last = { decision, backfill, verification, unresolvedFindings: findings };
    if (findings.length === 0) return last;
  }
  if (!last) throw new Error(`spine_mapping completeness check failed on all ${maxRuns} runs:\n${findings.join("\n")}`);
  return last;
}

async function requestDecision(modelRouter: ModelRouter, inventory: unknown, spineIds: ReadonlySet<string>,
  priorFindings: readonly string[]): Promise<SpineMappingDecision> {
  const messages: LlmMessage[] = [
    { role: "system", content: `${spineMappingSystemPrompt}\n\nReturn EXACTLY one JSON object: {"mappings":[...],"detailRows":[...],"excluded":[...],"spineGaps":[...]} and nothing else.` },
    { role: "user", content: `[CANONICAL SPINE IDS]\n${JSON.stringify([...spineIds])}\n\n[CONCEPT INVENTORY]\n${JSON.stringify(inventory)}${priorFindings.length > 0 ? `\n\n[FINDINGS FROM PREVIOUS RUN]\n${priorFindings.join("\n")}\n\nFix every finding and re-emit the FULL decision.` : ""}` },
  ];
  let schemaRetried = false;
  for (;;) {
    let completion;
    try { completion = await modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "spine_mapping" } }); }
    catch (firstError) {
      // Transient provider errors need spacing, not an instant retry.
      await new Promise((resolve) => setTimeout(resolve, 2_000 + Math.floor(Math.random() * 2_000)));
      try { completion = await modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "spine_mapping", retry: "malformed_response" } }); }
      catch { throw firstError; }
    }
    const start = completion.text.indexOf("{"); const end = completion.text.lastIndexOf("}");
    try {
      if (start < 0 || end < start) throw new Error("spine_mapping did not return JSON");
      const parsed: unknown = JSON.parse(completion.text.slice(start, end + 1));
      validate(parsed, DECISION_SCHEMA, "$", true);
      return parsed as SpineMappingDecision;
    } catch (validationError) {
      if (schemaRetried) throw validationError;
      schemaRetried = true;
      messages.push({ role: "assistant", content: completion.text });
      messages.push({ role: "user", content: `[VALIDATION ERROR]\n${validationError instanceof Error ? validationError.message : String(validationError)}\n\nRe-emit the FULL corrected decision as one JSON object.` });
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/spineMappingLoop.test.ts`
Expected: 4 passing.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all passing.

- [ ] **Step 7: Pause for user review**

---

### Task 6: End-to-end smoke script

**Files:**
- Create: `scripts/xbrl/smoke-spine-mapping.ts`

**Interfaces:**
- Consumes: `runSpineMappingLoop` (Task 5), `ArelleExtractionResponse` from `src/infra/xbrl/types.ts`, whatever `ModelRouter` construction the other smoke scripts use (copy the setup from `scripts/xbrl/smoke-revenue-decomposition.ts`).
- Produces: a markdown report on stdout. Input is a **protocol-3 companion response JSON file passed as `argv[2]`** — the script does not run Arelle itself, so it stays runnable the moment the extraction design's companion lands, and testable before that against any hand-captured response.

- [ ] **Step 1: Write the script**

```ts
// scripts/xbrl/smoke-spine-mapping.ts
// Usage: node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/smoke-spine-mapping.ts <protocol3-response.json> <FY2021,FY2022,...>
// Copy the ModelRouter/provider bootstrap from smoke-revenue-decomposition.ts verbatim.
import { readFileSync } from "node:fs";
import type { ArelleExtractionResponse } from "../../src/infra/xbrl/types.ts";
import type { Period } from "../../src/financial-model/types.ts";
import { runSpineMappingLoop } from "../../src/agent/financial-modeling/spineMappingLoop.ts";

const response = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as ArelleExtractionResponse;
const periodIds = (process.argv[3] ?? "FY2021,FY2022,FY2023,FY2024,FY2025").split(",");
const requestedPeriods: Period[] = periodIds.map((id) => {
  const year = Number(id.slice(2));
  return { id, label: id, start: `${year}-01-01`, end: `${year}-12-31`, cls: "actual" };
});

const run = await runSpineMappingLoop({ modelRouter, filings: response.filings, requestedPeriods });

// Report sections, in order: Mappings | Detail rows | Excluded | Spine gaps | Restatement report |
// Roll-up breaks | Continuity breaks | Coverage gaps | Unresolved findings.
// Mappings section: one table row per (targetId, periodId) with conceptQName, backfilled value, accession.
// Restatement/continuity: every candidate value with its accession. End with PASS/SHIPPED-WITH-FINDINGS.
```

Fill in the report printer (plain `console.log` markdown, same style as the other smoke reports in `docs/`) and the `modelRouter` bootstrap copied from `smoke-revenue-decomposition.ts`.

- [ ] **Step 2: Type-check the script**

Run: `npm run build`
Expected: `tsc` passes with the new script included.

- [ ] **Step 3: Note the runtime dependency**

The script runs for real only once the presentation-linkbase companion (protocol 3) can produce a response file. Do not fake one. Record in the final handoff message that the smoke run is pending on that dependency.

- [ ] **Step 4: Pause for user review**

---

## Self-Review Results

- **Spec coverage:** §2 inventory → Task 1; §3 decision shape + completeness → Task 2; §4 backfill/restatements/missing-fact findings → Task 3; §5 roll-up/continuity/coverage + re-run cap semantics → Tasks 4–5; §6 smoke → Task 6. Spec's "filing missing a statement contributes nothing" falls out of Task 1/3 iterating only over present statements; the "all filings missing a statement" hard block is deferred to pipeline wiring (out of this plan's scope — no caller exists yet).
- **Placeholders:** Task 6 intentionally leaves the report printer as a described-not-coded step because it is presentation-only; everything load-bearing is coded.
- **Type consistency:** `SpineMappingDecision`/`checkMappingCompleteness` (Task 2) match their uses in Tasks 3–5; `valueTolerance` defined once (Task 3), imported in Task 4; `SpineMappingRun` field names match the Task 5 tests.
