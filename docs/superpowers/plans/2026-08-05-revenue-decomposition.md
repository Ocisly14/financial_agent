# Revenue Decomposition Map-Reduce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a revenue-decomposition stage (parallel per-filing map agents + one reduce agent + deterministic host layers) that discovers issuer-specific revenue breakdowns from persisted non-face tables and materializes the best one as child rows and the forecast driver.

**Architecture:** Two new private LLM loops (`filing_decomposition` per filing, `decomposition_reduce` once) modeled on `historicalMappingLoop.ts`, sandwiched between three pure deterministic layers: fact minting/validation, cross-filing adjudication/alignment, and materialization into the `SourceReviewArtifact`. Spec: `docs/superpowers/specs/2026-08-05-revenue-decomposition-design.md`.

**Tech Stack:** TypeScript (Node >= 23, `--experimental-strip-types`), `node:sqlite`, `node:test`, no new dependencies.

## Global Constraints

- **Never `git commit` without the user's review.** (User preference overrides the default commit steps below: at each "Commit" step, instead STOP and report the diff for user review; only commit after explicit approval.)
- Agents never supply a source number; every value flows through a `factId` or `sourceLineItemId` minted/validated by the host (spec §1).
- Tool protocol is the literal `{"action":"call_tool","calls":[{"tool":...,"input":...}]}` envelope parsed by `parseSubagentStep()`; no alternate field names (spec §7 of the curation design).
- Revenue-family concept check is deterministic: `us-gaap:Revenues`, `us-gaap:RevenueFromContractWithCustomer*`, `us-gaap:SalesRevenue*`, or connected to the target face row's concept via calculation relations (spec §4.1).
- Minted factId recipe: `"xbrl-" + sha256(accession | sourceTableId:rowOrder | periodId | contextId).hex.slice(0,24)` (spec §3.2).
- Residual child row generated when `|residual| / face revenue > 0.5%`; residual ratio `> 30%` flags the scheme (spec §6, §7).
- Run tests with: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test <file>`; full suite via `pnpm test`. Typecheck via `pnpm build`.
- Follow existing style: bracket access for index-signature reads (`input["key"]`), compact single-purpose files, `structuredClone` for store copies, `additionalProperties: false` schemas validated by `validate()` from `mcp_tools/financial-model/schemas.ts`.

---

### Task 1: Decomposition types and table-fact minting

**Files:**
- Create: `src/infra/xbrl/decompositionTypes.ts`
- Test: `src/infra/xbrl/__tests__/decompositionTypes.test.ts`

**Interfaces:**
- Consumes: `FilingTable` (`src/infra/xbrl/tableTypes.ts`), `Unit` (`src/financial-model/types.ts`), `XbrlDimension` (`src/infra/xbrl/types.ts`).
- Produces (used by every later task):
  - `mintTableFactId(accession: string, sourceTableId: string, rowOrder: number, periodId: string, contextId: string): string`
  - `mintTableFacts(table: FilingTable): MintedTableFact[]`
  - Types: `SchemeFactRef`, `FilingSchemeChild`, `FilingDecompositionScheme`, `FilingDecompositionProposal`, `MintedTableFact`, `CandidateChildCell`, `CandidateChild`, `CandidateScheme`, `ChildMergeRecord`, `ReduceDecision`, `FinalDecompositionDecision`, `DecompositionSummary`.

- [ ] **Step 1: Write the failing test**

```ts
// src/infra/xbrl/__tests__/decompositionTypes.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mintTableFactId, mintTableFacts } from "../decompositionTypes.ts";
import { filingTable } from "../../../agent/financial-modeling/__tests__/curationFixtures.ts";

test("mintTableFactId is stable and shaped like staged fact ids", () => {
  const id = mintTableFactId("acc-1", "t1", 3, "FY2025", "c-9");
  assert.equal(id, mintTableFactId("acc-1", "t1", 3, "FY2025", "c-9"));
  assert.match(id, /^xbrl-[0-9a-f]{24}$/);
  assert.notEqual(id, mintTableFactId("acc-2", "t1", 3, "FY2025", "c-9"));
});

test("mintTableFacts mints one fact per fact-bearing cell with provenance coordinates", () => {
  const table = filingTable({ sourceTableId: "seg-1", heading: "Net sales by product", rowLabels: ["iPhone", "Mac"] });
  const minted = mintTableFacts(table);
  assert.equal(minted.length, 2);
  const first = minted[0]!;
  assert.equal(first.sourceTableId, "seg-1");
  assert.equal(first.rowOrder, 1);
  assert.equal(first.accession, table.accession);
  assert.equal(first.filedAt, table.filedAt);
  assert.equal(first.value, 100);
  assert.equal(first.factId, mintTableFactId(table.accession, "seg-1", 1, first.periodId, first.contextId));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/decompositionTypes.test.ts`
Expected: FAIL — cannot find module `../decompositionTypes.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/infra/xbrl/decompositionTypes.ts
import { createHash } from "node:crypto";
import type { Unit } from "../../financial-model/types.ts";
import type { XbrlDimension } from "./types.ts";
import type { FilingTable } from "./tableTypes.ts";

/** Agent-side shapes: references only, never values. */
export type SchemeFactRef = { factId: string; periodId: string };
export type FilingSchemeChild = { label: string; memberHint?: string; factRefs: SchemeFactRef[] };
export type FilingDecompositionScheme = {
  schemeId: string;
  label: string;
  /** Dimension axis qname, or the literal "presentation-only". */
  axisHint: string;
  targetSourceLineItemId: string;
  children: FilingSchemeChild[];
};
export type FilingDecompositionProposal = {
  accession: string;
  rationale: string;
  schemes: FilingDecompositionScheme[];
  sourceRefs: string[];
};

/** Host-minted identity for a non-face table fact (spec §3.2). */
export type MintedTableFact = {
  factId: string;
  accession: string;
  filedAt: string;
  sourceTableId: string;
  rowOrder: number;
  periodId: string;
  contextId: string;
  value: number;
  unit: Unit;
  dimensions: XbrlDimension[];
  conceptQName: string;
  sourceAnchor: string;
};

/** Host-side cross-filing shapes produced by the deterministic middle layer. */
export type CandidateChildCell = { factId: string; value: number; accession: string; filedAt: string; sourceAnchor: string };
export type CandidateChild = {
  childId: string;
  label: string;
  memberHint?: string;
  /** periodId -> adjudicated cell; gaps are simply absent, never fabricated. */
  cells: Record<string, CandidateChildCell>;
};
export type CandidateScheme = {
  candidateSchemeId: string;
  label: string;
  axisHint: string;
  targetSourceLineItemId: string;
  children: CandidateChild[];
  periodIds: string[];
  /** childId -> periodIds with data (coverage matrix, spec §4.3). */
  coverage: Record<string, string[]>;
  /** periodId -> |face - Σchildren| / face; null when the face value is unavailable. */
  residualRatioByPeriod: Record<string, number | null>;
  flags: string[];
  openQuestions: string[];
};
export type ChildMergeRecord = { candidateSchemeId: string; keepChildId: string; mergeChildIds: string[] };
export type ReduceDecision = { ranked: string[]; driverSchemeId: string | null; rationale: string };
export type FinalDecompositionDecision = { acceptedSchemeIds: string[]; driverSchemeId: string | null; decidedBy: string; rationale: string };
export type DecompositionSummary = {
  schemes: Array<{
    candidateSchemeId: string;
    label: string;
    axisHint: string;
    targetSourceLineItemId: string;
    driver: boolean;
    children: Array<{ childRowId: string; label: string; residual?: true }>;
  }>;
};

export function mintTableFactId(accession: string, sourceTableId: string, rowOrder: number, periodId: string, contextId: string): string {
  return `xbrl-${createHash("sha256").update(`${accession}|${sourceTableId}:${rowOrder}|${periodId}|${contextId}`).digest("hex").slice(0, 24)}`;
}

export function mintTableFacts(table: FilingTable): MintedTableFact[] {
  return table.rows.flatMap((row) => row.cells.flatMap((cell) => {
    const fact = cell.fact;
    if (!fact) return [];
    return [{
      factId: mintTableFactId(table.accession, table.sourceTableId, row.order, fact.periodId, fact.contextId),
      accession: table.accession, filedAt: table.filedAt, sourceTableId: table.sourceTableId, rowOrder: row.order,
      periodId: fact.periodId, contextId: fact.contextId, value: fact.value, unit: structuredClone(fact.unit),
      dimensions: structuredClone(fact.dimensions), conceptQName: fact.conceptQName, sourceAnchor: fact.sourceAnchor,
    }];
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/decompositionTypes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, then stop for review**

Run: `pnpm build`
Expected: no errors. Report the diff to the user for review (no commit without approval).

---

### Task 2: DecompositionStore (in-memory + SQLite)

**Files:**
- Create: `src/infra/xbrl/decompositionStore.ts`
- Test: `src/infra/xbrl/__tests__/decompositionStore.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `interface DecompositionStore` with methods `saveMapProposal(runId, proposal: FilingDecompositionProposal)`, `listMapProposals(runId): FilingDecompositionProposal[]`, `saveMintedFacts(runId, facts: readonly MintedTableFact[])`, `listMintedFacts(runId): MintedTableFact[]`, `saveCandidates(runId, candidates: readonly CandidateScheme[])`, `listCandidates(runId): CandidateScheme[]`, `saveChildMerge(runId, merge: ChildMergeRecord)`, `listChildMerges(runId): ChildMergeRecord[]`, `saveReduceDecision(runId, decision: ReduceDecision)`, `getReduceDecision(runId): ReduceDecision | undefined`, `saveFinalDecision(runId, decision: FinalDecompositionDecision)`, `getFinalDecision(runId): FinalDecompositionDecision | undefined`
  - `class InMemoryDecompositionStore implements DecompositionStore`
  - `class SqliteDecompositionStore implements DecompositionStore` with `static open(path: string)` and `close()`

- [ ] **Step 1: Write the failing test**

```ts
// src/infra/xbrl/__tests__/decompositionStore.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDecompositionStore, SqliteDecompositionStore, type DecompositionStore } from "../decompositionStore.ts";
import type { CandidateScheme, FilingDecompositionProposal, MintedTableFact } from "../decompositionTypes.ts";

const proposal: FilingDecompositionProposal = { accession: "acc-1", rationale: "r", sourceRefs: [], schemes: [
  { schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis", targetSourceLineItemId: "row-rev",
    children: [{ label: "iPhone", factRefs: [{ factId: "xbrl-a", periodId: "FY2025" }] }] }] };
const minted: MintedTableFact = { factId: "xbrl-a", accession: "acc-1", filedAt: "2025-10-01", sourceTableId: "t1", rowOrder: 1,
  periodId: "FY2025", contextId: "c1", value: 5, unit: { kind: "currency", code: "USD" }, dimensions: [],
  conceptQName: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", sourceAnchor: "#a" };
const candidate: CandidateScheme = { candidateSchemeId: "cs1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
  targetSourceLineItemId: "row-rev", children: [], periodIds: ["FY2025"], coverage: {}, residualRatioByPeriod: {}, flags: [], openQuestions: [] };

function exercise(store: DecompositionStore): void {
  store.saveMapProposal("run1", proposal);
  store.saveMintedFacts("run1", [minted]);
  store.saveCandidates("run1", [candidate]);
  store.saveChildMerge("run1", { candidateSchemeId: "cs1", keepChildId: "a", mergeChildIds: ["b"] });
  store.saveReduceDecision("run1", { ranked: ["cs1"], driverSchemeId: "cs1", rationale: "best coverage" });
  store.saveFinalDecision("run1", { acceptedSchemeIds: ["cs1"], driverSchemeId: "cs1", decidedBy: "parent", rationale: "ok" });
  assert.deepEqual(store.listMapProposals("run1"), [proposal]);
  assert.deepEqual(store.listMintedFacts("run1"), [minted]);
  assert.deepEqual(store.listCandidates("run1"), [candidate]);
  assert.equal(store.listChildMerges("run1").length, 1);
  assert.equal(store.getReduceDecision("run1")?.driverSchemeId, "cs1");
  assert.equal(store.getFinalDecision("run1")?.decidedBy, "parent");
  assert.deepEqual(store.listMapProposals("other"), []);
  assert.equal(store.getReduceDecision("other"), undefined);
  // Upsert: same key overwrites, does not duplicate.
  store.saveMintedFacts("run1", [minted]);
  assert.equal(store.listMintedFacts("run1").length, 1);
}

test("in-memory decomposition store round-trips all artifact kinds", () => exercise(new InMemoryDecompositionStore()));

test("sqlite decomposition store round-trips all artifact kinds", () => {
  const store = SqliteDecompositionStore.open(join(mkdtempSync(join(tmpdir(), "decomp-")), "d.sqlite"));
  try { exercise(store); } finally { store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/decompositionStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

One generic keyed-JSON table keeps the SQLite schema small (mirrors `sourceReviewStore.ts` conventions). Kinds are namespaced by a string column; keys give per-kind identity for upsert.

```ts
// src/infra/xbrl/decompositionStore.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CandidateScheme, ChildMergeRecord, FilingDecompositionProposal, FinalDecompositionDecision,
  MintedTableFact, ReduceDecision,
} from "./decompositionTypes.ts";

export interface DecompositionStore {
  saveMapProposal(runId: string, proposal: FilingDecompositionProposal): void;
  listMapProposals(runId: string): FilingDecompositionProposal[];
  saveMintedFacts(runId: string, facts: readonly MintedTableFact[]): void;
  listMintedFacts(runId: string): MintedTableFact[];
  saveCandidates(runId: string, candidates: readonly CandidateScheme[]): void;
  listCandidates(runId: string): CandidateScheme[];
  saveChildMerge(runId: string, merge: ChildMergeRecord): void;
  listChildMerges(runId: string): ChildMergeRecord[];
  saveReduceDecision(runId: string, decision: ReduceDecision): void;
  getReduceDecision(runId: string): ReduceDecision | undefined;
  saveFinalDecision(runId: string, decision: FinalDecompositionDecision): void;
  getFinalDecision(runId: string): FinalDecompositionDecision | undefined;
}

type Kind = "map_proposal" | "minted_fact" | "candidates" | "child_merge" | "reduce_decision" | "final_decision";

export class InMemoryDecompositionStore implements DecompositionStore {
  private readonly rows = new Map<string, unknown>();
  private key(runId: string, kind: Kind, key: string): string { return `${runId} ${kind} ${key}`; }
  private put(runId: string, kind: Kind, key: string, value: unknown): void { this.rows.set(this.key(runId, kind, key), structuredClone(value)); }
  private list<T>(runId: string, kind: Kind): T[] {
    const prefix = `${runId} ${kind} `;
    return [...this.rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v) as T);
  }
  saveMapProposal(runId: string, proposal: FilingDecompositionProposal): void { this.put(runId, "map_proposal", proposal.accession, proposal); }
  listMapProposals(runId: string): FilingDecompositionProposal[] { return this.list(runId, "map_proposal"); }
  saveMintedFacts(runId: string, facts: readonly MintedTableFact[]): void { for (const fact of facts) this.put(runId, "minted_fact", fact.factId, fact); }
  listMintedFacts(runId: string): MintedTableFact[] { return this.list(runId, "minted_fact"); }
  saveCandidates(runId: string, candidates: readonly CandidateScheme[]): void { this.put(runId, "candidates", "all", candidates); }
  listCandidates(runId: string): CandidateScheme[] { return this.list<CandidateScheme[]>(runId, "candidates")[0] ?? []; }
  saveChildMerge(runId: string, merge: ChildMergeRecord): void { this.put(runId, "child_merge", `${merge.candidateSchemeId}|${merge.keepChildId}`, merge); }
  listChildMerges(runId: string): ChildMergeRecord[] { return this.list(runId, "child_merge"); }
  saveReduceDecision(runId: string, decision: ReduceDecision): void { this.put(runId, "reduce_decision", "one", decision); }
  getReduceDecision(runId: string): ReduceDecision | undefined { return this.list<ReduceDecision>(runId, "reduce_decision")[0]; }
  saveFinalDecision(runId: string, decision: FinalDecompositionDecision): void { this.put(runId, "final_decision", "one", decision); }
  getFinalDecision(runId: string): FinalDecompositionDecision | undefined { return this.list<FinalDecompositionDecision>(runId, "final_decision")[0]; }
}

export class SqliteDecompositionStore implements DecompositionStore {
  private readonly db: DatabaseSync;
  private constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS decomposition_artifacts (
      ingestion_run_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      artifact_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
      PRIMARY KEY (ingestion_run_id, kind, key));`);
  }
  static open(path: string): SqliteDecompositionStore { mkdirSync(dirname(path), { recursive: true }); return new SqliteDecompositionStore(new DatabaseSync(path)); }
  private put(runId: string, kind: Kind, key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO decomposition_artifacts VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(ingestion_run_id, kind, key) DO UPDATE SET artifact_json=excluded.artifact_json, recorded_at=excluded.recorded_at`)
      .run(runId, kind, key, JSON.stringify(value), new Date().toISOString());
  }
  private list<T>(runId: string, kind: Kind): T[] {
    return (this.db.prepare("SELECT artifact_json FROM decomposition_artifacts WHERE ingestion_run_id=? AND kind=?")
      .all(runId, kind) as Array<{ artifact_json: string }>).map((row) => JSON.parse(row.artifact_json) as T);
  }
  saveMapProposal(runId: string, proposal: FilingDecompositionProposal): void { this.put(runId, "map_proposal", proposal.accession, proposal); }
  listMapProposals(runId: string): FilingDecompositionProposal[] { return this.list(runId, "map_proposal"); }
  saveMintedFacts(runId: string, facts: readonly MintedTableFact[]): void { for (const fact of facts) this.put(runId, "minted_fact", fact.factId, fact); }
  listMintedFacts(runId: string): MintedTableFact[] { return this.list(runId, "minted_fact"); }
  saveCandidates(runId: string, candidates: readonly CandidateScheme[]): void { this.put(runId, "candidates", "all", [...candidates]); }
  listCandidates(runId: string): CandidateScheme[] { return this.list<CandidateScheme[]>(runId, "candidates")[0] ?? []; }
  saveChildMerge(runId: string, merge: ChildMergeRecord): void { this.put(runId, "child_merge", `${merge.candidateSchemeId}|${merge.keepChildId}`, merge); }
  listChildMerges(runId: string): ChildMergeRecord[] { return this.list(runId, "child_merge"); }
  saveReduceDecision(runId: string, decision: ReduceDecision): void { this.put(runId, "reduce_decision", "one", decision); }
  getReduceDecision(runId: string): ReduceDecision | undefined { return this.list<ReduceDecision>(runId, "reduce_decision")[0]; }
  saveFinalDecision(runId: string, decision: FinalDecompositionDecision): void { this.put(runId, "final_decision", "one", decision); }
  getFinalDecision(runId: string): FinalDecompositionDecision | undefined { return this.list<FinalDecompositionDecision>(runId, "final_decision")[0]; }
  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/decompositionStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, then stop for review**

Run: `pnpm build` → no errors. Report diff for user review.

---

### Task 3: Scheme validation (host middle layer, part 1)

**Files:**
- Create: `src/infra/xbrl/decompositionAnalysis.ts`
- Test: `src/infra/xbrl/__tests__/decompositionAnalysis.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `CalculationRelation` from `src/infra/xbrl/types.ts`.
- Produces:
  - `isRevenueFamilyConcept(conceptQName: string, targetConcept: string, relations: readonly CalculationRelation[]): boolean`
  - `validateFilingSchemes(input: { proposal: FilingDecompositionProposal; minted: ReadonlyMap<string, MintedTableFact>; faceRows: ReadonlyMap<string, { conceptQName: string }>; calculationRelations: readonly CalculationRelation[] }): { schemes: FilingDecompositionScheme[]; diagnostics: string[] }`

Validation rules (spec §4.1): every `factRef.factId` must resolve in `minted` with matching `periodId`; `targetSourceLineItemId` must exist in `faceRows`; every referenced fact's concept must be revenue-family relative to the target row's concept; when `axisHint` is a qname, every referenced fact must carry a dimension with that `axisQName`; `"presentation-only"` imposes no dimension requirement. Any violation rejects the whole scheme with a diagnostic; valid schemes pass through untouched.

- [ ] **Step 1: Write the failing test**

```ts
// src/infra/xbrl/__tests__/decompositionAnalysis.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { isRevenueFamilyConcept, validateFilingSchemes } from "../decompositionAnalysis.ts";
import type { FilingDecompositionProposal, MintedTableFact } from "../decompositionTypes.ts";

function minted(overrides: Partial<MintedTableFact>): MintedTableFact {
  return { factId: "xbrl-a", accession: "acc-1", filedAt: "2025-10-01", sourceTableId: "t1", rowOrder: 1, periodId: "FY2025",
    contextId: "c1", value: 100, unit: { kind: "currency", code: "USD" },
    dimensions: [{ axisQName: "srt:ProductOrServiceAxis", axisLabel: "Product", memberQName: "aapl:IPhoneMember", memberLabel: "iPhone" }],
    conceptQName: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", sourceAnchor: "#a", ...overrides };
}
function proposal(overrides: Partial<FilingDecompositionProposal["schemes"][number]>): FilingDecompositionProposal {
  return { accession: "acc-1", rationale: "r", sourceRefs: [], schemes: [{ schemeId: "s1", label: "by product",
    axisHint: "srt:ProductOrServiceAxis", targetSourceLineItemId: "row-rev",
    children: [{ label: "iPhone", memberHint: "aapl:IPhoneMember", factRefs: [{ factId: "xbrl-a", periodId: "FY2025" }] }], ...overrides }] };
}
const faceRows = new Map([["row-rev", { conceptQName: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" }]]);

test("revenue family accepts us-gaap revenue concepts and calc-connected concepts", () => {
  assert.ok(isRevenueFamilyConcept("us-gaap:Revenues", "us-gaap:Revenues", []));
  assert.ok(isRevenueFamilyConcept("us-gaap:SalesRevenueNet", "us-gaap:Revenues", []));
  assert.ok(isRevenueFamilyConcept("aapl:CustomConcept", "us-gaap:Revenues",
    [{ roleUri: "r", parentConcept: "us-gaap:Revenues", children: [{ concept: "aapl:CustomConcept", weight: 1, order: 1 }] }]));
  assert.equal(isRevenueFamilyConcept("us-gaap:CostOfRevenue", "us-gaap:Revenues", []), false);
});

test("a fully resolvable scheme validates unchanged", () => {
  const result = validateFilingSchemes({ proposal: proposal({}), minted: new Map([["xbrl-a", minted({})]]), faceRows, calculationRelations: [] });
  assert.equal(result.schemes.length, 1);
  assert.deepEqual(result.diagnostics, []);
});

test("an unknown factId rejects the whole scheme with a diagnostic", () => {
  const result = validateFilingSchemes({ proposal: proposal({ children: [{ label: "iPhone", factRefs: [{ factId: "xbrl-missing", periodId: "FY2025" }] }] }),
    minted: new Map([["xbrl-a", minted({})]]), faceRows, calculationRelations: [] });
  assert.equal(result.schemes.length, 0);
  assert.match(result.diagnostics[0]!, /unknown factId/);
});

test("a non-revenue concept and a missing axis dimension each reject the scheme", () => {
  const wrongConcept = validateFilingSchemes({ proposal: proposal({}),
    minted: new Map([["xbrl-a", minted({ conceptQName: "us-gaap:CostOfRevenue" })]]), faceRows, calculationRelations: [] });
  assert.equal(wrongConcept.schemes.length, 0);
  const wrongAxis = validateFilingSchemes({ proposal: proposal({}),
    minted: new Map([["xbrl-a", minted({ dimensions: [] })]]), faceRows, calculationRelations: [] });
  assert.equal(wrongAxis.schemes.length, 0);
});

test("presentation-only schemes need no dimensions and unknown target rows reject", () => {
  const ok = validateFilingSchemes({ proposal: proposal({ axisHint: "presentation-only" }),
    minted: new Map([["xbrl-a", minted({ dimensions: [] })]]), faceRows, calculationRelations: [] });
  assert.equal(ok.schemes.length, 1);
  const badTarget = validateFilingSchemes({ proposal: proposal({ targetSourceLineItemId: "row-nope" }),
    minted: new Map([["xbrl-a", minted({})]]), faceRows, calculationRelations: [] });
  assert.equal(badTarget.schemes.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/decompositionAnalysis.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/infra/xbrl/decompositionAnalysis.ts
import type { CalculationRelation } from "./types.ts";
import type { FilingDecompositionProposal, FilingDecompositionScheme, MintedTableFact } from "./decompositionTypes.ts";

const REVENUE_CONCEPT = /^us-gaap:(Revenues$|RevenueFromContractWithCustomer|SalesRevenue)/;

export function isRevenueFamilyConcept(conceptQName: string, targetConcept: string, relations: readonly CalculationRelation[]): boolean {
  if (REVENUE_CONCEPT.test(conceptQName) || conceptQName === targetConcept) return true;
  // Walk calculation children of the target concept transitively.
  // CalculationRelation is { roleUri, parentConcept, children: [{ concept, weight, order }] } (src/infra/xbrl/types.ts:46).
  const childrenOf = new Map<string, string[]>();
  for (const relation of relations) {
    const children = childrenOf.get(relation.parentConcept) ?? [];
    children.push(...relation.children.map((child) => child.concept));
    childrenOf.set(relation.parentConcept, children);
  }
  const seen = new Set<string>();
  const queue = [targetConcept];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenOf.get(parent) ?? []) {
      if (child === conceptQName) return true;
      if (!seen.has(child)) { seen.add(child); queue.push(child); }
    }
  }
  return false;
}

export function validateFilingSchemes(input: {
  proposal: FilingDecompositionProposal;
  minted: ReadonlyMap<string, MintedTableFact>;
  faceRows: ReadonlyMap<string, { conceptQName: string }>;
  calculationRelations: readonly CalculationRelation[];
}): { schemes: FilingDecompositionScheme[]; diagnostics: string[] } {
  const schemes: FilingDecompositionScheme[] = [];
  const diagnostics: string[] = [];
  for (const scheme of input.proposal.schemes) {
    const reject = (reason: string) => diagnostics.push(`decomposition_scheme_rejected ${input.proposal.accession}/${scheme.schemeId}: ${reason}`);
    const target = input.faceRows.get(scheme.targetSourceLineItemId);
    if (!target) { reject(`unknown target row ${scheme.targetSourceLineItemId}`); continue; }
    if (scheme.children.length === 0) { reject("no children"); continue; }
    let valid = true;
    for (const child of scheme.children) {
      for (const ref of child.factRefs) {
        const fact = input.minted.get(ref.factId);
        if (!fact) { reject(`unknown factId ${ref.factId}`); valid = false; break; }
        if (fact.periodId !== ref.periodId) { reject(`factId ${ref.factId} period mismatch`); valid = false; break; }
        if (!isRevenueFamilyConcept(fact.conceptQName, target.conceptQName, input.calculationRelations)) {
          reject(`factId ${ref.factId} concept ${fact.conceptQName} is not revenue-family`); valid = false; break;
        }
        if (scheme.axisHint !== "presentation-only" && !fact.dimensions.some((dimension) => dimension.axisQName === scheme.axisHint)) {
          reject(`factId ${ref.factId} lacks axis ${scheme.axisHint}`); valid = false; break;
        }
      }
      if (!valid) break;
    }
    if (valid) schemes.push(scheme);
  }
  return { schemes, diagnostics };
}
```


- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/decompositionAnalysis.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck, then stop for review**

Run: `pnpm build` → no errors. Report diff for user review.

---

### Task 4: Candidate building — adjudication, alignment, coverage, residuals (host middle layer, part 2)

**Files:**
- Modify: `src/infra/xbrl/decompositionAnalysis.ts`
- Test: `src/infra/xbrl/__tests__/decompositionAnalysis.test.ts` (append)

**Interfaces:**
- Consumes: `normalizeLabel` from `src/infra/xbrl/mergeCuratedTables.ts`; Task 1/3 outputs.
- Produces:
  - `buildCandidateSchemes(input: { validated: Array<{ accession: string; filedAt: string; schemes: FilingDecompositionScheme[] }>; minted: ReadonlyMap<string, MintedTableFact>; requestedPeriodIds: readonly string[]; faceValues: ReadonlyMap<string, ReadonlyMap<string, number>>; merges?: readonly ChildMergeRecord[] }): CandidateScheme[]`
  - `applyChildMerges(candidates: readonly CandidateScheme[], merges: readonly ChildMergeRecord[]): CandidateScheme[]` (exported separately so the reduce loop's `merge_children` tool can re-run it)

Rules (spec §4.2–4.4): candidates group by `(targetSourceLineItemId, axisHint)`; `candidateSchemeId = "cs-" + sha256(target|axis).slice(0,12)`; children align by `memberHint` when both sides have one, else by `normalizeLabel(label)`; `childId = "ch-" + sha256(axis|memberHint or normalized label).slice(0,12)`; per (child, period) the newest `filedAt` wins; coverage lists available periodIds per child restricted to `requestedPeriodIds`; residual ratio per period is `|face − Σ children| / |face|` (null without a face value); ratio > 0.30 adds flag `"residual_ratio_above_30pct"`; two distinct children whose normalized labels are equal after stripping non-alphanumerics but were NOT auto-merged (memberHints differ) add an `openQuestions` entry naming both childIds.

- [ ] **Step 1: Write the failing test (append to the Task 3 test file)**

```ts
import { applyChildMerges, buildCandidateSchemes } from "../decompositionAnalysis.ts";

function validatedFiling(accession: string, filedAt: string, factId: string, childLabel: string, periodId: string) {
  return { accession, filedAt, schemes: [{ schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
    targetSourceLineItemId: "row-rev", children: [{ label: childLabel, memberHint: "aapl:IPhoneMember",
      factRefs: [{ factId, periodId }] }] }] };
}

test("children align across filings and the newest filedAt supplies each period", () => {
  const mintedMap = new Map([
    ["xbrl-old", minted({ factId: "xbrl-old", accession: "acc-1", filedAt: "2024-10-01", value: 90, periodId: "FY2024" })],
    ["xbrl-dup", minted({ factId: "xbrl-dup", accession: "acc-2", filedAt: "2025-10-01", value: 91, periodId: "FY2024" })],
    ["xbrl-new", minted({ factId: "xbrl-new", accession: "acc-2", filedAt: "2025-10-01", value: 120, periodId: "FY2025" })],
  ]);
  const candidates = buildCandidateSchemes({
    validated: [
      validatedFiling("acc-1", "2024-10-01", "xbrl-old", "iPhone", "FY2024"),
      { accession: "acc-2", filedAt: "2025-10-01", schemes: [{ schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
        targetSourceLineItemId: "row-rev", children: [{ label: "iPhone ", memberHint: "aapl:IPhoneMember",
          factRefs: [{ factId: "xbrl-dup", periodId: "FY2024" }, { factId: "xbrl-new", periodId: "FY2025" }] }] }] },
    ],
    minted: mintedMap, requestedPeriodIds: ["FY2024", "FY2025"],
    faceValues: new Map([["row-rev", new Map([["FY2024", 91], ["FY2025", 150]])]]),
  });
  assert.equal(candidates.length, 1);
  const scheme = candidates[0]!;
  assert.equal(scheme.children.length, 1, "same member across filings is one child");
  const child = scheme.children[0]!;
  assert.equal(child.cells["FY2024"]!.value, 91, "newer filedAt wins FY2024");
  assert.equal(child.cells["FY2025"]!.value, 120);
  assert.deepEqual(scheme.coverage[child.childId], ["FY2024", "FY2025"]);
  assert.equal(scheme.residualRatioByPeriod["FY2024"], 0, "91 of 91");
  assert.equal(scheme.residualRatioByPeriod["FY2025"], 0.2, "|150-120|/150");
});

test("high residual flags the scheme and missing face value yields null ratio", () => {
  const mintedMap = new Map([["xbrl-a", minted({ value: 10 })]]);
  const candidates = buildCandidateSchemes({ validated: [validatedFiling("acc-1", "2025-10-01", "xbrl-a", "iPhone", "FY2025")],
    minted: mintedMap, requestedPeriodIds: ["FY2024", "FY2025"],
    faceValues: new Map([["row-rev", new Map([["FY2025", 100]])]]) });
  const scheme = candidates[0]!;
  assert.ok(scheme.flags.includes("residual_ratio_above_30pct"));
  assert.equal(scheme.residualRatioByPeriod["FY2024"], null);
});

test("applyChildMerges folds one child's cells into another", () => {
  const mintedMap = new Map([
    ["xbrl-a", minted({ factId: "xbrl-a", value: 10, periodId: "FY2024" })],
    ["xbrl-b", minted({ factId: "xbrl-b", value: 12, periodId: "FY2025", contextId: "c2" })],
  ]);
  const candidates = buildCandidateSchemes({ validated: [
    { accession: "acc-1", filedAt: "2024-10-01", schemes: [{ schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
      targetSourceLineItemId: "row-rev", children: [{ label: "Wearables", factRefs: [{ factId: "xbrl-a", periodId: "FY2024" }] }] }] },
    { accession: "acc-2", filedAt: "2025-10-01", schemes: [{ schemeId: "s1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
      targetSourceLineItemId: "row-rev", children: [{ label: "Wearables, Home and Accessories", factRefs: [{ factId: "xbrl-b", periodId: "FY2025" }] }] }] },
  ], minted: mintedMap, requestedPeriodIds: ["FY2024", "FY2025"], faceValues: new Map() });
  const scheme = candidates[0]!;
  assert.equal(scheme.children.length, 2, "different labels stay separate before merge");
  const [keep, merge] = scheme.children.map((child) => child.childId);
  const merged = applyChildMerges(candidates, [{ candidateSchemeId: scheme.candidateSchemeId, keepChildId: keep!, mergeChildIds: [merge!] }]);
  const child = merged[0]!.children.find((candidateChild) => candidateChild.childId === keep)!;
  assert.equal(merged[0]!.children.length, 1);
  assert.equal(child.cells["FY2024"]!.value, 10);
  assert.equal(child.cells["FY2025"]!.value, 12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `buildCandidateSchemes` not exported.

- [ ] **Step 3: Write the implementation (append to `decompositionAnalysis.ts`)**

```ts
import { createHash } from "node:crypto";
import { normalizeLabel } from "./mergeCuratedTables.ts";
import type { CandidateChild, CandidateScheme, ChildMergeRecord } from "./decompositionTypes.ts";

const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

export function buildCandidateSchemes(input: {
  validated: Array<{ accession: string; filedAt: string; schemes: FilingDecompositionScheme[] }>;
  minted: ReadonlyMap<string, MintedTableFact>;
  requestedPeriodIds: readonly string[];
  faceValues: ReadonlyMap<string, ReadonlyMap<string, number>>;
  merges?: readonly ChildMergeRecord[];
}): CandidateScheme[] {
  const requested = new Set(input.requestedPeriodIds);
  const groups = new Map<string, { label: string; axisHint: string; target: string; children: Map<string, CandidateChild & { filedAtByPeriod: Record<string, string> }> }>();
  for (const filing of input.validated) {
    for (const scheme of filing.schemes) {
      const candidateSchemeId = `cs-${short(`${scheme.targetSourceLineItemId}|${scheme.axisHint}`)}`;
      const group = groups.get(candidateSchemeId)
        ?? { label: scheme.label, axisHint: scheme.axisHint, target: scheme.targetSourceLineItemId, children: new Map() };
      groups.set(candidateSchemeId, group);
      for (const child of scheme.children) {
        const identity = child.memberHint ?? normalizeLabel(child.label);
        const childId = `ch-${short(`${scheme.axisHint}|${identity}`)}`;
        const existing = group.children.get(childId)
          ?? { childId, label: child.label, ...(child.memberHint ? { memberHint: child.memberHint } : {}), cells: {}, filedAtByPeriod: {} };
        group.children.set(childId, existing);
        for (const ref of child.factRefs) {
          const fact = input.minted.get(ref.factId);
          if (!fact || !requested.has(fact.periodId)) continue;
          const current = existing.filedAtByPeriod[fact.periodId];
          if (current !== undefined && current >= fact.filedAt) continue; // newest filedAt wins
          existing.filedAtByPeriod[fact.periodId] = fact.filedAt;
          existing.cells[fact.periodId] = { factId: fact.factId, value: fact.value, accession: fact.accession,
            filedAt: fact.filedAt, sourceAnchor: fact.sourceAnchor };
        }
      }
    }
  }
  const candidates = [...groups.entries()].map(([candidateSchemeId, group]): CandidateScheme => {
    const children = [...group.children.values()].map(({ filedAtByPeriod: _drop, ...child }) => child);
    const periodIds = [...requested];
    const coverage = Object.fromEntries(children.map((child) => [child.childId,
      periodIds.filter((periodId) => child.cells[periodId] !== undefined)]));
    const faceByPeriod = input.faceValues.get(group.target);
    const residualRatioByPeriod = Object.fromEntries(periodIds.map((periodId) => {
      const face = faceByPeriod?.get(periodId);
      if (face === undefined || face === 0) return [periodId, null];
      const sum = children.reduce((total, child) => total + (child.cells[periodId]?.value ?? 0), 0);
      return [periodId, Math.abs(face - sum) / Math.abs(face)];
    }));
    const flags = Object.values(residualRatioByPeriod).some((ratio) => ratio !== null && ratio > 0.3)
      ? ["residual_ratio_above_30pct"] : [];
    const openQuestions = ambiguousPairs(children).map(([left, right]) =>
      `children ${left.childId} ("${left.label}") and ${right.childId} ("${right.label}") may be the same line; merge_children if so`);
    return { candidateSchemeId, label: group.label, axisHint: group.axisHint, targetSourceLineItemId: group.target,
      children, periodIds, coverage, residualRatioByPeriod, flags, openQuestions };
  });
  return input.merges?.length ? applyChildMerges(candidates, input.merges) : candidates;
}

function ambiguousPairs(children: readonly CandidateChild[]): Array<[CandidateChild, CandidateChild]> {
  const strip = (label: string) => normalizeLabel(label).replace(/[^a-z0-9]/g, "");
  const pairs: Array<[CandidateChild, CandidateChild]> = [];
  for (let left = 0; left < children.length; left += 1) for (let right = left + 1; right < children.length; right += 1) {
    const a = children[left]!; const b = children[right]!;
    const overlap = strip(a.label).startsWith(strip(b.label)) || strip(b.label).startsWith(strip(a.label));
    if (overlap) pairs.push([a, b]);
  }
  return pairs;
}

export function applyChildMerges(candidates: readonly CandidateScheme[], merges: readonly ChildMergeRecord[]): CandidateScheme[] {
  return candidates.map((candidate) => {
    const relevant = merges.filter((merge) => merge.candidateSchemeId === candidate.candidateSchemeId);
    if (relevant.length === 0) return structuredClone(candidate) as CandidateScheme;
    const next = structuredClone(candidate) as CandidateScheme;
    for (const merge of relevant) {
      const keep = next.children.find((child) => child.childId === merge.keepChildId);
      if (!keep) continue;
      for (const mergeId of merge.mergeChildIds) {
        const index = next.children.findIndex((child) => child.childId === mergeId);
        if (index < 0) continue;
        const [removed] = next.children.splice(index, 1);
        for (const [periodId, cell] of Object.entries(removed!.cells)) keep.cells[periodId] ??= cell;
        delete next.coverage[mergeId];
      }
      next.coverage[keep.childId] = next.periodIds.filter((periodId) => keep.cells[periodId] !== undefined);
    }
    return next;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run the Task 3 test file command. Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck, then stop for review**

Run: `pnpm build` → no errors. Report diff for user review.

---

### Task 5: Materialization into the SourceReviewArtifact

**Files:**
- Modify: `src/infra/xbrl/sourceReviewStore.ts` (add `decomposition?: DecompositionSummary` to `SourceReviewArtifact`)
- Create: `src/infra/xbrl/materializeDecomposition.ts`
- Test: `src/infra/xbrl/__tests__/materializeDecomposition.test.ts`

**Interfaces:**
- Consumes: `SourceReviewArtifact`, `CandidateScheme`, `FinalDecompositionDecision`, `DecompositionSummary`, `Fact`/`PreparedStatementRowView`.
- Produces:
  - `materializeDecomposition(input: { artifact: SourceReviewArtifact; candidates: readonly CandidateScheme[]; decision: FinalDecompositionDecision; residualThreshold?: number }): SourceReviewArtifact` — returns a NEW artifact (never mutates the input) with: child rows appended to `statementViews.income_statement.candidate.rows` (id `source.income_statement.revenue.<candidateSchemeId>.<hash>`, `parentSourceLineItemId` = target row, `depth` = target depth + 1); staged `Fact`s appended to `artifact.facts` (`status: "staged"`, `lineItemId` = child row id, provenance `sourceType: "filing_xbrl_decomposition"`, `sourceRefs: [cell.sourceAnchor]`, `asOfDate: cell.filedAt`, `accession: cell.accession`); per-period residual children when `|face − Σ| / |face| > residualThreshold` (default `0.005`), labeled `"Other / unallocated"`; and `artifact.decomposition` summary with `driver: true` on the decision's `driverSchemeId`.

Behavioral rules:
- Only schemes in `decision.acceptedSchemeIds` materialize; unknown ids throw `Error("unknown candidateSchemeId: <id>")`.
- Child row identity hash: `short(candidateSchemeId + "|" + child.label + "|" + axisHint + "|" + (memberHint ?? ""))` with the same 12-hex `short` as Task 4 (import it or re-declare locally — export `short` as `shortHash` from `decompositionAnalysis.ts` and reuse).
- Face value per period = the staged fact of the target row in `artifact.facts` (`lineItemId === targetSourceLineItemId`, matching `periodId`); residual = face − Σ child cells; the residual fact's provenance is `sourceType: "derived_residual"` with `sourceRefs` = the child facts' anchors.
- The face row's unit is reused for child and residual rows.

- [ ] **Step 1: Write the failing test**

```ts
// src/infra/xbrl/__tests__/materializeDecomposition.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { materializeDecomposition } from "../materializeDecomposition.ts";
import type { SourceReviewArtifact } from "../sourceReviewStore.ts";
import type { CandidateScheme } from "../decompositionTypes.ts";

function artifact(): SourceReviewArtifact {
  const period = { id: "FY2025", label: "FY2025", start: "2024-09-29", end: "2025-09-27", cls: "actual" as const };
  return {
    ingestionRunId: "run1", filings: [], facts: [
      { factId: "xbrl-face", status: "staged", lineItemId: "row-rev", periodId: "FY2025", value: 100,
        unit: { kind: "currency", code: "USD" }, provenance: { sourceType: "filing_xbrl", sourceRefs: ["#rev"], asOfDate: "2025-10-01" } },
    ],
    statementViews: { income_statement: { candidate: { periods: [period], rows: [
      { sourceLineItemId: "row-rev", statement: "income_statement", label: "Net sales", unit: { kind: "currency", code: "USD" },
        order: 1, conceptQName: "us-gaap:Revenues", dimensionSignature: "", dimensions: [], depth: 0, presentationAccessions: [] },
    ] }, filingPresentations: [] },
      balance_sheet: { candidate: { periods: [period], rows: [] }, filingPresentations: [] },
      cash_flow_statement: { candidate: { periods: [period], rows: [] }, filingPresentations: [] } },
    coverage: { requestedPeriodIds: ["FY2025"], statements: [], issues: [] },
    dimensionalDisclosures: [], curatedTables: [], curations: [],
  } as unknown as SourceReviewArtifact;
}
const scheme: CandidateScheme = { candidateSchemeId: "cs-1", label: "by product", axisHint: "srt:ProductOrServiceAxis",
  targetSourceLineItemId: "row-rev", periodIds: ["FY2025"], flags: [], openQuestions: [],
  children: [
    { childId: "ch-a", label: "iPhone", cells: { FY2025: { factId: "xbrl-i", value: 60, accession: "acc", filedAt: "2025-10-01", sourceAnchor: "#i" } } },
    { childId: "ch-b", label: "Mac", cells: { FY2025: { factId: "xbrl-m", value: 30, accession: "acc", filedAt: "2025-10-01", sourceAnchor: "#m" } } },
  ],
  coverage: { "ch-a": ["FY2025"], "ch-b": ["FY2025"] }, residualRatioByPeriod: { FY2025: 0.1 } };

test("accepted schemes materialize child rows, staged facts, a residual child, and the summary", () => {
  const result = materializeDecomposition({ artifact: artifact(), candidates: [scheme],
    decision: { acceptedSchemeIds: ["cs-1"], driverSchemeId: "cs-1", decidedBy: "parent", rationale: "ok" } });
  const rows = result.statementViews.income_statement.candidate.rows;
  const childRows = rows.filter((row) => row.parentSourceLineItemId === "row-rev");
  assert.equal(childRows.length, 3, "iPhone + Mac + residual (10% > 0.5%)");
  assert.ok(childRows.every((row) => row.sourceLineItemId.startsWith("source.income_statement.revenue.cs-1.")));
  const residualRow = childRows.find((row) => row.label === "Other / unallocated")!;
  const residualFact = result.facts.find((fact) => fact.lineItemId === residualRow.sourceLineItemId)!;
  assert.equal(residualFact.value, 10, "100 - 90");
  assert.equal(residualFact.provenance.sourceType, "derived_residual");
  const iphoneFact = result.facts.find((fact) => fact.factId === "xbrl-i")!;
  assert.equal(iphoneFact.status, "staged");
  assert.equal(result.decomposition?.schemes[0]?.driver, true);
  assert.equal(result.decomposition?.schemes[0]?.children.length, 3);
  // Input untouched:
  assert.equal(artifact().facts.length, 1);
});

test("a tiny residual generates no residual child and unknown scheme ids throw", () => {
  const nearExact = structuredClone(scheme);
  nearExact.children[1]!.cells["FY2025"]!.value = 39.9; // residual 0.1 of 100 = 0.1% < 0.5%
  const result = materializeDecomposition({ artifact: artifact(), candidates: [nearExact],
    decision: { acceptedSchemeIds: ["cs-1"], driverSchemeId: null, decidedBy: "parent", rationale: "ok" } });
  const childRows = result.statementViews.income_statement.candidate.rows.filter((row) => row.parentSourceLineItemId === "row-rev");
  assert.equal(childRows.length, 2);
  assert.throws(() => materializeDecomposition({ artifact: artifact(), candidates: [scheme],
    decision: { acceptedSchemeIds: ["cs-missing"], driverSchemeId: null, decidedBy: "parent", rationale: "" } }), /unknown candidateSchemeId/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

First add to `sourceReviewStore.ts` (import type from `decompositionTypes.ts`):

```ts
import type { DecompositionSummary } from "./decompositionTypes.ts";
// inside SourceReviewArtifact:
  /** Present after the parent accepts a revenue decomposition (spec §6). */
  decomposition?: DecompositionSummary;
```

Then:

```ts
// src/infra/xbrl/materializeDecomposition.ts
import type { Fact } from "../../financial-model/types.ts";
import type { SourceReviewArtifact } from "./sourceReviewStore.ts";
import type { CandidateScheme, DecompositionSummary, FinalDecompositionDecision } from "./decompositionTypes.ts";
import { shortHash } from "./decompositionAnalysis.ts";

const DEFAULT_RESIDUAL_THRESHOLD = 0.005;

export function materializeDecomposition(input: {
  artifact: SourceReviewArtifact;
  candidates: readonly CandidateScheme[];
  decision: FinalDecompositionDecision;
  residualThreshold?: number;
}): SourceReviewArtifact {
  const threshold = input.residualThreshold ?? DEFAULT_RESIDUAL_THRESHOLD;
  const artifact = structuredClone(input.artifact) as SourceReviewArtifact;
  const byId = new Map(input.candidates.map((candidate) => [candidate.candidateSchemeId, candidate]));
  const view = artifact.statementViews.income_statement;
  const faceRows = new Map(view.candidate.rows.map((row) => [row.sourceLineItemId, row]));
  const faceFacts = new Map(artifact.facts.filter((fact) => fact.lineItemId)
    .map((fact) => [`${fact.lineItemId}|${fact.periodId}`, fact]));
  const summary: DecompositionSummary = { schemes: [] };
  for (const schemeId of input.decision.acceptedSchemeIds) {
    const scheme = byId.get(schemeId);
    if (!scheme) throw new Error(`unknown candidateSchemeId: ${schemeId}`);
    const target = faceRows.get(scheme.targetSourceLineItemId);
    if (!target) throw new Error(`decomposition target row missing: ${scheme.targetSourceLineItemId}`);
    const summaryChildren: DecompositionSummary["schemes"][number]["children"] = [];
    let order = view.candidate.rows.length;
    const childRow = (label: string, hashInput: string) => {
      const sourceLineItemId = `source.income_statement.revenue.${scheme.candidateSchemeId}.${shortHash(hashInput)}`;
      order += 1;
      view.candidate.rows.push({ ...structuredClone(target), sourceLineItemId, label, order,
        depth: target.depth + 1, parentSourceLineItemId: target.sourceLineItemId, presentationAccessions: [] });
      return sourceLineItemId;
    };
    for (const child of scheme.children) {
      const rowId = childRow(child.label, `${scheme.candidateSchemeId}|${child.label}|${scheme.axisHint}|${child.memberHint ?? ""}`);
      summaryChildren.push({ childRowId: rowId, label: child.label });
      for (const [periodId, cell] of Object.entries(child.cells)) {
        artifact.facts.push({ factId: cell.factId, status: "staged", lineItemId: rowId, periodId, value: cell.value,
          unit: structuredClone(target.unit), provenance: { sourceType: "filing_xbrl_decomposition",
            sourceRefs: [cell.sourceAnchor], asOfDate: cell.filedAt, accession: cell.accession } });
      }
    }
    // Residual children per period (spec §6): identity face = Σ children holds exactly.
    const residualByPeriod = scheme.periodIds.flatMap((periodId) => {
      const face = faceFacts.get(`${scheme.targetSourceLineItemId}|${periodId}`);
      if (!face || face.value === 0) return [];
      const sum = scheme.children.reduce((total, child) => total + (child.cells[periodId]?.value ?? 0), 0);
      const residual = face.value - sum;
      return Math.abs(residual) / Math.abs(face.value) > threshold ? [{ periodId, residual, anchors:
        scheme.children.flatMap((child) => child.cells[periodId] ? [child.cells[periodId]!.sourceAnchor] : []) }] : [];
    });
    if (residualByPeriod.length > 0) {
      const rowId = childRow("Other / unallocated", `${scheme.candidateSchemeId}|__residual__|${scheme.axisHint}|`);
      summaryChildren.push({ childRowId: rowId, label: "Other / unallocated", residual: true });
      for (const { periodId, residual, anchors } of residualByPeriod) {
        artifact.facts.push({ factId: `xbrl-${shortHash(`residual|${rowId}|${periodId}`)}`, status: "staged", lineItemId: rowId,
          periodId, value: residual, unit: structuredClone(target.unit),
          provenance: { sourceType: "derived_residual", sourceRefs: anchors, asOfDate: new Date().toISOString().slice(0, 10) } });
      }
    }
    summary.schemes.push({ candidateSchemeId: scheme.candidateSchemeId, label: scheme.label, axisHint: scheme.axisHint,
      targetSourceLineItemId: scheme.targetSourceLineItemId, driver: input.decision.driverSchemeId === scheme.candidateSchemeId,
      children: summaryChildren });
  }
  artifact.decomposition = summary;
  return artifact;
}
```

Also rename Task 4's local `short` to exported `shortHash` in `decompositionAnalysis.ts` (`export const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);`) and update its internal call sites.

Note: `PreparedStatementRowView` (see `src/infra/xbrl/types.ts:73`) is the row type inside `view.candidate.rows` — the `{ ...structuredClone(target), ... }` spread relies on target being that type; verify the exact required fields against the type before finalizing, and the residual `Fact` requires only `Provenance` fields present in `src/financial-model/types.ts:103`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/materializeDecomposition.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + typecheck, then stop for review**

Run: `pnpm build && pnpm test` (the `sourceReviewStore` change is additive; existing tests must stay green). Report diff for user review.

---

### Task 6: Map loop — `filing_decomposition`

**Files:**
- Create: `src/agent/financial-modeling/filingDecompositionLoop.ts`
- Test: `src/agent/financial-modeling/__tests__/filingDecompositionLoop.test.ts`

**Interfaces:**
- Consumes: `formatAllowedTools`/`parseSubagentStep` (`src/framework/subagent.ts`), `validate` (`mcp_tools/financial-model/schemas.ts`), `FilingTableStore`, `catalogEntry`, `mintTableFacts`, `ModelRouter`.
- Produces:
  - `runFilingDecompositionLoop(input: { modelRouter: ModelRouter; runId: string; accession: string; tableStore: FilingTableStore; faceRows: Array<{ sourceLineItemId: string; title: string; conceptQName: string }>; requestedPeriodIds: readonly string[]; onMintedFacts: (facts: readonly MintedTableFact[]) => void; task: string; systemPrompt: string; maxSteps?: number }): Promise<FilingDecompositionProposal>`
  - `createFilingDecompositionTools(runId: string, accession: string, tableStore: FilingTableStore, onMintedFacts: (facts: readonly MintedTableFact[]) => void): Map<string, { execute(input: JsonObject): JsonValue } & ToolDefinition>`

Loop mechanics copy `historicalMappingLoop.ts` exactly (MAX_STEPS 16, single malformed-response retry, full transcript retention, `parseObject` + `parseSubagentStep`). Base context: income-statement `faceRows` (title + id + concept), the filing's table catalog from `tableStore.listTables(runId, { accession, tier: "all" })` paginated to exhaustion and projected to `{ sourceTableId, heading, rowLabels, columnHeaders, prescreen: { tier, dimensionlessRatio, factCount, periodSpan } }`, and `requestedPeriodIds`. Final-response contract: `{"rationale","payload":{"schemes":[...]},"sourceRefs":[]}` — validate with a local JSON schema (`schemes` array of objects with required `schemeId,label,axisHint,targetSourceLineItemId,children`; children require `label,factRefs`; factRefs require `factId,periodId`; `additionalProperties: false` throughout). Empty `schemes` is legal.

Tools:
- `list_table_rows({ sourceTableId })` → `{ heading, columns: [{index, headerText, periodId?}], rows: [{ order, labelText, indentLevel, cells: [{ columnIndex, hasFact, axes: ["srt:ProductOrServiceAxis=aapl:IPhoneMember", ...] }] }] }` — from `tableStore.getTables(runId, [sourceTableId])[0]`; unknown table → throw. No values.
- `get_table_facts({ sourceTableId, rowOrders })` (max 20 rows) → mints via `mintTableFacts` filtered to the requested rows, calls `onMintedFacts(minted)`, returns `{ facts: [{ factId, rowOrder, periodId, value, unit, conceptQName, dimensions, sourceAnchor }] }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/financial-modeling/__tests__/filingDecompositionLoop.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { runFilingDecompositionLoop } from "../filingDecompositionLoop.ts";
import { InMemoryFilingTableStore } from "../../../infra/xbrl/filingTableStore.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { mintTableFactId, type MintedTableFact } from "../../../infra/xbrl/decompositionTypes.ts";
import { filingTable } from "./curationFixtures.ts";

function scripted(responses: string[]): ModelRouter {
  let call = 0;
  const provider: LlmProvider = { name: "scripted", generate: async () => ({ text: responses[Math.min(call++, responses.length - 1)]!,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  return new ModelRouter(provider);
}

test("map loop reads a table, mints fact ids, and returns a validated proposal", async () => {
  const store = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1", heading: "Net sales by product", rowLabels: ["iPhone", "Mac"] });
  store.saveTables("run1", [table]);
  const minted: MintedTableFact[] = [];
  const expectedFactId = mintTableFactId(table.accession, "seg-1", 1, "FY2025", "c-FY2025");
  const proposal = await runFilingDecompositionLoop({
    modelRouter: scripted([
      JSON.stringify({ action: "call_tool", calls: [{ tool: "list_table_rows", input: { sourceTableId: "seg-1" } }] }),
      JSON.stringify({ action: "call_tool", calls: [{ tool: "get_table_facts", input: { sourceTableId: "seg-1", rowOrders: [1, 2] } }] }),
      JSON.stringify({ rationale: "found product split", sourceRefs: [], payload: { schemes: [{ schemeId: "s1", label: "by product",
        axisHint: "presentation-only", targetSourceLineItemId: "row-rev",
        children: [{ label: "iPhone", factRefs: [{ factId: expectedFactId, periodId: "FY2025" }] }] }] } }),
    ]),
    runId: "run1", accession: table.accession, tableStore: store,
    faceRows: [{ sourceLineItemId: "row-rev", title: "Net sales", conceptQName: "us-gaap:Revenues" }],
    requestedPeriodIds: ["FY2025"], onMintedFacts: (facts) => minted.push(...facts),
    task: "decompose revenue", systemPrompt: "map agent" });
  assert.equal(proposal.accession, table.accession);
  assert.equal(proposal.schemes.length, 1);
  assert.equal(minted.length, 2, "get_table_facts minted both requested rows");
  assert.ok(minted.some((fact) => fact.factId === expectedFactId));
});

test("empty schemes is a legal result and malformed payloads throw", async () => {
  const store = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1" });
  store.saveTables("run1", [table]);
  const base = { runId: "run1", accession: table.accession, tableStore: store,
    faceRows: [{ sourceLineItemId: "row-rev", title: "Net sales", conceptQName: "us-gaap:Revenues" }],
    requestedPeriodIds: ["FY2025"], onMintedFacts: () => {}, task: "t", systemPrompt: "p" } as const;
  const empty = await runFilingDecompositionLoop({ ...base,
    modelRouter: scripted([JSON.stringify({ rationale: "nothing splittable", sourceRefs: [], payload: { schemes: [] } })]) });
  assert.deepEqual(empty.schemes, []);
  await assert.rejects(runFilingDecompositionLoop({ ...base,
    modelRouter: scripted([JSON.stringify({ rationale: "bad", sourceRefs: [], payload: { schemes: [{ nope: true }] } })]) }),
  /schemes/);
});
```

Note on the fixture: `curationFixtures.filingTable` builds cells with `contextId: "c-<periodId>"`; the `expectedFactId` above depends on that. If the fixture differs, read it and adjust the expected context id.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Follow `historicalMappingLoop.ts` structure verbatim (same imports, retry, transcript). Key parts:

```ts
// src/agent/financial-modeling/filingDecompositionLoop.ts
import { validate } from "../../../mcp_tools/financial-model/schemas.ts";
import { formatAllowedTools, parseSubagentStep } from "../../framework/subagent.ts";
import type { JsonObject, JsonSchema, JsonValue, ToolDefinition } from "../../framework/types.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import type { FilingTableStore } from "../../infra/xbrl/filingTableStore.ts";
import { mintTableFacts, type FilingDecompositionProposal, type MintedTableFact } from "../../infra/xbrl/decompositionTypes.ts";

type LoopTool = ToolDefinition & { execute(input: JsonObject): JsonValue };
const MAX_STEPS = 16;
const MAX_FACT_ROWS = 20;

const PROPOSAL_SCHEMA: JsonSchema = { type: "object", additionalProperties: false,
  required: ["rationale", "payload", "sourceRefs"], properties: {
    rationale: { type: "string" }, sourceRefs: { type: "array", items: { type: "string" } },
    payload: { type: "object", additionalProperties: false, required: ["schemes"], properties: {
      schemes: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["schemeId", "label", "axisHint", "targetSourceLineItemId", "children"], properties: {
          schemeId: { type: "string" }, label: { type: "string" }, axisHint: { type: "string" },
          targetSourceLineItemId: { type: "string" },
          children: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "factRefs"],
            properties: { label: { type: "string" }, memberHint: { type: "string" },
              factRefs: { type: "array", items: { type: "object", additionalProperties: false,
                required: ["factId", "periodId"], properties: { factId: { type: "string" }, periodId: { type: "string" } } } } } } } } } } } } } };

export async function runFilingDecompositionLoop(input: {
  modelRouter: ModelRouter; runId: string; accession: string; tableStore: FilingTableStore;
  faceRows: Array<{ sourceLineItemId: string; title: string; conceptQName: string }>;
  requestedPeriodIds: readonly string[];
  onMintedFacts: (facts: readonly MintedTableFact[]) => void;
  task: string; systemPrompt: string; maxSteps?: number;
}): Promise<FilingDecompositionProposal> {
  const tools = createFilingDecompositionTools(input.runId, input.accession, input.tableStore, input.onMintedFacts);
  const catalog = drainCatalog(input.tableStore, input.runId, input.accession);
  const baseContext = { accession: input.accession, requestedPeriodIds: input.requestedPeriodIds,
    incomeStatementRows: input.faceRows, tables: catalog };
  const messages: LlmMessage[] = [
    { role: "system", content: `${input.systemPrompt}\n\nAllowed private tools:\n${formatAllowedTools([...tools.values()])}\n\nOutput contract — return EXACTLY one JSON object and nothing else:\n- Tool step: {"action":"call_tool","calls":[{"tool":"<name>","input":{}}]}\n- Final proposal: {"rationale":"...","payload":{"schemes":[...]},"sourceRefs":[]}\nEvery factId must come from a get_table_facts result. An empty schemes array is a valid final answer when this filing supports no revenue decomposition.` },
    { role: "user", content: `${input.task}\n\n[BASE CONTEXT — TITLES ONLY, NO VALUES]\n${JSON.stringify(baseContext)}\n\nOutput the next tool step or the final proposal.` },
  ];
  for (let step = 1; step <= (input.maxSteps ?? MAX_STEPS); step += 1) {
    let completion;
    try { completion = await input.modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "filing_decomposition" } }); }
    catch (firstError) {
      try { completion = await input.modelRouter.generate(messages, { modelClass: "MEDIUM", temperature: 0.1, metadata: { mode: "dcf_subagent", subagent: "filing_decomposition", retry: "malformed_response" } }); }
      catch { throw firstError; }
    }
    const parsed = parseObject(completion.text);
    if (parsed["action"] !== "call_tool") {
      validate(parsed, PROPOSAL_SCHEMA, "$", true);
      const payload = parsed["payload"] as { schemes: FilingDecompositionProposal["schemes"] };
      return { accession: input.accession, rationale: String(parsed["rationale"]), schemes: payload.schemes,
        sourceRefs: (parsed["sourceRefs"] as string[]) };
    }
    const action = parseSubagentStep(completion.text);
    if (action.action !== "call_tool") throw new Error("filing_decomposition returned an invalid tool envelope");
    const toolResults = action.calls.map((call) => {
      const tool = tools.get(call.tool);
      if (!tool) return { tool: call.tool, error: { code: "invalid_tool", message: `unknown tool: ${call.tool}` } };
      try { return { tool: call.tool, result: tool.execute(call.input) }; }
      catch (error) { return { tool: call.tool, error: { code: "invalid_tool_input", message: error instanceof Error ? error.message : String(error) } }; }
    });
    messages.push({ role: "assistant", content: completion.text });
    messages.push({ role: "user", content: `[TOOL RESULTS]\n${JSON.stringify(toolResults)}\n\nContinue with another tool step or the final proposal.` });
  }
  throw new Error(`filing_decomposition did not produce a proposal after ${input.maxSteps ?? MAX_STEPS} tool steps`);
}
```

`createFilingDecompositionTools` implements the two tools per the interface block above (schemas via the same `object()`/`validate` helpers as `createHistoricalMappingTools`; `get_table_facts` filters `mintTableFacts(table)` to requested `rowOrders`, throws when `rowOrders` is empty or exceeds `MAX_FACT_ROWS`). `drainCatalog` loops `listTables` with `tier: "all"` following `nextCursor` and maps entries to `{ sourceTableId, heading, rowLabels, rowLabelsTruncated, columnHeaders, prescreen: { tier: e.prescreen.tier, dimensionlessRatio: e.prescreen.dimensionlessRatio, factCount: e.prescreen.factCount, periodSpan: e.prescreen.periodSpan } }`. `parseObject` copies the one in `historicalMappingLoop.ts` with the loop name in messages.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/filingDecompositionLoop.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, then stop for review**

Run: `pnpm build` → no errors. Report diff for user review.

---

### Task 7: Reduce loop — `decomposition_reduce`

**Files:**
- Create: `src/agent/financial-modeling/decompositionReduceLoop.ts`
- Test: `src/agent/financial-modeling/__tests__/decompositionReduceLoop.test.ts`

**Interfaces:**
- Consumes: `applyChildMerges` (Task 4), `DecompositionStore` (Task 2), loop helpers as in Task 6.
- Produces:
  - `runDecompositionReduceLoop(input: { modelRouter: ModelRouter; runId: string; candidates: readonly CandidateScheme[]; store: DecompositionStore; task: string; systemPrompt: string; maxSteps?: number }): Promise<{ decision: ReduceDecision; candidates: CandidateScheme[] }>` — returns the decision plus the candidates with any `merge_children` overrides applied.

Base context (no values): per candidate — `candidateSchemeId`, `label`, `axisHint`, `targetSourceLineItemId`, child list (`childId`, `label`, `memberHint`), `coverage`, `residualRatioByPeriod`, `flags`, `openQuestions`. Tools:
- `inspect_scheme({ candidateSchemeId })` → the same summary for one scheme plus per-child per-period availability booleans (still no values); unknown id throws.
- `merge_children({ candidateSchemeId, keepChildId, mergeChildIds })` → validates ids exist in the current (already-merged) candidate set, records via `store.saveChildMerge`, re-applies `applyChildMerges` to the working set, returns the updated child list.

Final contract: `{"rationale","payload":{"ranked":["cs-..."],"driverSchemeId":"cs-..."|null},"sourceRefs":[]}` validated by a local schema; every id in `ranked` must be a known candidateSchemeId and `driverSchemeId` must be `ranked[0]` or null (host check after parse — reject otherwise). Ranking may drop schemes (dropped = not in `ranked`).

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/financial-modeling/__tests__/decompositionReduceLoop.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { runDecompositionReduceLoop } from "../decompositionReduceLoop.ts";
import { InMemoryDecompositionStore } from "../../../infra/xbrl/decompositionStore.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import type { CandidateScheme } from "../../../infra/xbrl/decompositionTypes.ts";

function scripted(responses: string[]): ModelRouter {
  let call = 0;
  const provider: LlmProvider = { name: "scripted", generate: async () => ({ text: responses[Math.min(call++, responses.length - 1)]!,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  return new ModelRouter(provider);
}
function candidate(id: string, children: Array<{ childId: string; label: string }>): CandidateScheme {
  return { candidateSchemeId: id, label: id, axisHint: "srt:ProductOrServiceAxis", targetSourceLineItemId: "row-rev",
    children: children.map((child) => ({ ...child, cells: { FY2025: { factId: `f-${child.childId}`, value: 1, accession: "a",
      filedAt: "2025-10-01", sourceAnchor: "#x" } } })),
    periodIds: ["FY2025"], coverage: Object.fromEntries(children.map((child) => [child.childId, ["FY2025"]])),
    residualRatioByPeriod: { FY2025: 0.01 }, flags: [], openQuestions: [] };
}

test("reduce loop merges children on request, records the override, and returns a ranked decision", async () => {
  const store = new InMemoryDecompositionStore();
  const result = await runDecompositionReduceLoop({
    modelRouter: scripted([
      JSON.stringify({ action: "call_tool", calls: [{ tool: "merge_children",
        input: { candidateSchemeId: "cs-1", keepChildId: "ch-a", mergeChildIds: ["ch-b"] } }] }),
      JSON.stringify({ rationale: "product split has full coverage", sourceRefs: [],
        payload: { ranked: ["cs-1", "cs-2"], driverSchemeId: "cs-1" } }),
    ]),
    runId: "run1", store, task: "pick schemes", systemPrompt: "reduce agent",
    candidates: [candidate("cs-1", [{ childId: "ch-a", label: "Wearables" }, { childId: "ch-b", label: "Wearables, Home" }]),
      candidate("cs-2", [{ childId: "ch-c", label: "Americas" }])] });
  assert.deepEqual(result.decision.ranked, ["cs-1", "cs-2"]);
  assert.equal(result.decision.driverSchemeId, "cs-1");
  assert.equal(result.candidates.find((scheme) => scheme.candidateSchemeId === "cs-1")!.children.length, 1);
  assert.equal(store.listChildMerges("run1").length, 1);
});

test("a driver outside rank one is rejected and unknown ranked ids throw", async () => {
  const store = new InMemoryDecompositionStore();
  const base = { runId: "run1", store, task: "t", systemPrompt: "p",
    candidates: [candidate("cs-1", [{ childId: "ch-a", label: "A" }])] } as const;
  await assert.rejects(runDecompositionReduceLoop({ ...base,
    modelRouter: scripted([JSON.stringify({ rationale: "", sourceRefs: [], payload: { ranked: ["cs-unknown"], driverSchemeId: null } })]) }),
  /unknown candidateSchemeId/);
  await assert.rejects(runDecompositionReduceLoop({ ...base,
    modelRouter: scripted([JSON.stringify({ rationale: "", sourceRefs: [], payload: { ranked: ["cs-1"], driverSchemeId: "cs-2" } })]) }),
  /driverSchemeId/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Same loop skeleton as Task 6 (copy the generate/retry/parse/transcript block; metadata `subagent: "decomposition_reduce"`; MAX_STEPS 12). Working state: `let working = candidates.map((candidate) => structuredClone(candidate))`. Tools close over `working`:

```ts
// merge_children execute core:
const scheme = working.find((candidate) => candidate.candidateSchemeId === raw["candidateSchemeId"]);
if (!scheme) throw new Error(`unknown candidateSchemeId: ${String(raw["candidateSchemeId"])}`);
const ids = new Set(scheme.children.map((child) => child.childId));
const keep = String(raw["keepChildId"]); const merge = (raw["mergeChildIds"] as string[]);
if (!ids.has(keep) || merge.some((id) => !ids.has(id))) throw new Error("unknown childId in merge_children");
const record = { candidateSchemeId: scheme.candidateSchemeId, keepChildId: keep, mergeChildIds: merge };
store.saveChildMerge(runId, record);
working = applyChildMerges(working, [record]);
return { children: working.find((candidate) => candidate.candidateSchemeId === scheme.candidateSchemeId)!.children
  .map((child) => ({ childId: child.childId, label: child.label })) };
```

Final validation after schema check: every `ranked` id must exist in `working` (else `Error("unknown candidateSchemeId: <id>")`); `driverSchemeId !== null && driverSchemeId !== ranked[0]` → `Error("driverSchemeId must be ranked[0] or null")`. Persist with `store.saveReduceDecision(runId, decision)` before returning `{ decision, candidates: working }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/decompositionReduceLoop.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, then stop for review**

Run: `pnpm build` → no errors. Report diff for user review.

---

### Task 8: Orchestrator — parallel map, middle layer, reduce, graceful fallbacks

**Files:**
- Create: `src/agent/financial-modeling/revenueDecomposition.ts`
- Test: `src/agent/financial-modeling/__tests__/revenueDecomposition.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7; `SourceReviewArtifact`.
- Produces:
  - `runRevenueDecomposition(input: { modelRouter: ModelRouter; sourceReview: SourceReviewArtifact; tableStore: FilingTableStore; store: DecompositionStore; mapPrompt: string; reducePrompt: string; task: string }): Promise<{ candidates: CandidateScheme[]; decision: ReduceDecision | null; diagnostics: string[] }>`

Flow:
1. Derive `faceRows` from `sourceReview.statementViews.income_statement.candidate.rows` (id, title=label, conceptQName) and `requestedPeriodIds` from `sourceReview.coverage.requestedPeriodIds`; `runId = sourceReview.ingestionRunId`.
2. `Promise.allSettled` over `sourceReview.filings`, each `runFilingDecompositionLoop` with `onMintedFacts: (facts) => store.saveMintedFacts(runId, facts)`. A rejected promise adds diagnostic `filing_decomposition_failed <accession>: <message>` and the run continues (spec §7 row 1). Fulfilled proposals are persisted via `store.saveMapProposal`.
3. Build `minted` map from `store.listMintedFacts(runId)`, validate each proposal with `validateFilingSchemes` (calculationRelations: pass `[]` — relations are not persisted on the SourceReviewArtifact today; the us-gaap concept set carries validation, and a follow-up can thread relations through if issuers need it. Record this limitation as diagnostic `calculation_relations_unavailable` once whenever any scheme was rejected ONLY for the concept check — implement as: if a scheme rejection message contains "not revenue-family", append the limitation diagnostic once).
4. `faceValues`: from `sourceReview.facts` where `lineItemId` matches a scheme target — build `Map<targetSourceLineItemId, Map<periodId, value>>`.
5. `buildCandidateSchemes` with `merges: store.listChildMerges(runId)`; `store.saveCandidates`.
6. Zero candidates → return `{ candidates: [], decision: null, diagnostics: [...collected, "no_decomposition_candidates"] }` — reduce skipped (spec §7 row 2).
7. Otherwise `runDecompositionReduceLoop`; persist updated candidates (`store.saveCandidates` again with the merged set); return.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/financial-modeling/__tests__/revenueDecomposition.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { runRevenueDecomposition } from "../revenueDecomposition.ts";
import { InMemoryDecompositionStore } from "../../../infra/xbrl/decompositionStore.ts";
import { InMemoryFilingTableStore } from "../../../infra/xbrl/filingTableStore.ts";
import { ModelRouter, type LlmProvider } from "../../../infra/llm/provider.ts";
import { mintTableFactId } from "../../../infra/xbrl/decompositionTypes.ts";
import { filingTable } from "./curationFixtures.ts";
import type { SourceReviewArtifact } from "../../../infra/xbrl/sourceReviewStore.ts";

// Build one filing whose segment table is discoverable, plus a source review with
// a face revenue row. Reuse the artifact shape from materializeDecomposition.test.ts,
// with filings: [{ accession: table.accession, form: "10-K", filedAt: table.filedAt,
// reportDate: table.reportDate, primaryDocumentUrl: "https://example.test/doc" }].
// (Write a local artifact() helper mirroring that test, with the face fact valued 205
// so children 100+101 leave residual 4 ≈ 2%.)

test("orchestrator runs map agents per filing, validates, builds candidates, and reduces", async () => {
  const tableStore = new InMemoryFilingTableStore();
  const table = filingTable({ sourceTableId: "seg-1", heading: "Net sales by product", rowLabels: ["iPhone", "Mac"] });
  // Fixture concepts are us-gaap:Row1/Row2 — override to revenue concepts so validation passes:
  for (const row of table.rows) for (const cell of row.cells) if (cell.fact) cell.fact.conceptQName = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
  tableStore.saveTables("run1", [table]);
  const store = new InMemoryDecompositionStore();
  const factId = (order: number) => mintTableFactId(table.accession, "seg-1", order, "FY2025", "c-FY2025");
  let call = 0;
  const responses = [
    JSON.stringify({ action: "call_tool", calls: [{ tool: "get_table_facts", input: { sourceTableId: "seg-1", rowOrders: [1, 2] } }] }),
    JSON.stringify({ rationale: "product split", sourceRefs: [], payload: { schemes: [{ schemeId: "s1", label: "by product",
      axisHint: "presentation-only", targetSourceLineItemId: "row-rev", children: [
        { label: "iPhone", factRefs: [{ factId: factId(1), periodId: "FY2025" }] },
        { label: "Mac", factRefs: [{ factId: factId(2), periodId: "FY2025" }] }] }] } }),
    JSON.stringify({ rationale: "only one scheme", sourceRefs: [], payload: { ranked: [], driverSchemeId: null } }), // placeholder; replaced below
  ];
  // The reduce response needs the real candidateSchemeId, which is deterministic:
  // cs-<sha256("row-rev|presentation-only").slice(0,12)>. Compute it in the test via shortHash.
  const provider: LlmProvider = { name: "scripted", generate: async () => ({ text: responses[Math.min(call++, responses.length - 1)]!,
    metrics: { tokens_in: 1, tokens_out: 1, ms: 0, model_class: "MEDIUM", provider: "scripted" } }) };
  const result = await runRevenueDecomposition({ modelRouter: new ModelRouter(provider), sourceReview: artifact(table),
    tableStore, store, mapPrompt: "map", reducePrompt: "reduce", task: "decompose" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.decision?.driverSchemeId, result.candidates[0]!.candidateSchemeId);
  assert.equal(store.listMapProposals("run1").length, 1);
  assert.ok(store.listMintedFacts("run1").length >= 2);
});

test("a failed map agent degrades to a diagnostic and zero candidates skip reduce", async () => {
  const tableStore = new InMemoryFilingTableStore();
  const store = new InMemoryDecompositionStore();
  const provider: LlmProvider = { name: "explode", generate: async () => { throw new Error("provider down"); } };
  const result = await runRevenueDecomposition({ modelRouter: new ModelRouter(provider),
    sourceReview: artifact(filingTable({ sourceTableId: "seg-1" })), tableStore, store,
    mapPrompt: "map", reducePrompt: "reduce", task: "decompose" });
  assert.equal(result.decision, null);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.diagnostics.some((line) => line.startsWith("filing_decomposition_failed")));
  assert.ok(result.diagnostics.includes("no_decomposition_candidates"));
});
```

Import `shortHash` from `../../../infra/xbrl/decompositionAnalysis.ts` in the test to compute the expected `candidateSchemeId` and build the third scripted response as `{ ranked: [thatId], driverSchemeId: thatId }` (replace the placeholder line with the computed string before constructing the provider).

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/agent/financial-modeling/revenueDecomposition.ts
import type { ModelRouter } from "../../infra/llm/provider.ts";
import type { FilingTableStore } from "../../infra/xbrl/filingTableStore.ts";
import type { SourceReviewArtifact } from "../../infra/xbrl/sourceReviewStore.ts";
import type { DecompositionStore } from "../../infra/xbrl/decompositionStore.ts";
import type { CandidateScheme, ReduceDecision } from "../../infra/xbrl/decompositionTypes.ts";
import { buildCandidateSchemes, validateFilingSchemes } from "../../infra/xbrl/decompositionAnalysis.ts";
import { runFilingDecompositionLoop } from "./filingDecompositionLoop.ts";
import { runDecompositionReduceLoop } from "./decompositionReduceLoop.ts";

export async function runRevenueDecomposition(input: {
  modelRouter: ModelRouter; sourceReview: SourceReviewArtifact; tableStore: FilingTableStore;
  store: DecompositionStore; mapPrompt: string; reducePrompt: string; task: string;
}): Promise<{ candidates: CandidateScheme[]; decision: ReduceDecision | null; diagnostics: string[] }> {
  const runId = input.sourceReview.ingestionRunId;
  const diagnostics: string[] = [];
  const faceRows = input.sourceReview.statementViews.income_statement.candidate.rows
    .map((row) => ({ sourceLineItemId: row.sourceLineItemId, title: row.label, conceptQName: row.conceptQName }));
  const requestedPeriodIds = input.sourceReview.coverage.requestedPeriodIds;
  const settled = await Promise.allSettled(input.sourceReview.filings.map((filing) =>
    runFilingDecompositionLoop({ modelRouter: input.modelRouter, runId, accession: filing.accession,
      tableStore: input.tableStore, faceRows, requestedPeriodIds,
      onMintedFacts: (facts) => input.store.saveMintedFacts(runId, facts),
      task: input.task, systemPrompt: input.mapPrompt })));
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      diagnostics.push(`filing_decomposition_failed ${input.sourceReview.filings[index]!.accession}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
    } else input.store.saveMapProposal(runId, outcome.value);
  }
  const minted = new Map(input.store.listMintedFacts(runId).map((fact) => [fact.factId, fact]));
  const faceRowMap = new Map(faceRows.map((row) => [row.sourceLineItemId, { conceptQName: row.conceptQName }]));
  const filedAtByAccession = new Map(input.sourceReview.filings.map((filing) => [filing.accession, filing.filedAt]));
  const validated = input.store.listMapProposals(runId).map((proposal) => {
    const result = validateFilingSchemes({ proposal, minted, faceRows: faceRowMap, calculationRelations: [] });
    diagnostics.push(...result.diagnostics);
    return { accession: proposal.accession, filedAt: filedAtByAccession.get(proposal.accession) ?? "", schemes: result.schemes };
  });
  if (diagnostics.some((line) => line.includes("not revenue-family"))) diagnostics.push("calculation_relations_unavailable");
  const faceValues = new Map<string, Map<string, number>>();
  for (const fact of input.sourceReview.facts) {
    if (!fact.lineItemId) continue;
    const byPeriod = faceValues.get(fact.lineItemId) ?? new Map<string, number>();
    byPeriod.set(fact.periodId, fact.value); faceValues.set(fact.lineItemId, byPeriod);
  }
  const candidates = buildCandidateSchemes({ validated, minted, requestedPeriodIds, faceValues,
    merges: input.store.listChildMerges(runId) });
  input.store.saveCandidates(runId, candidates);
  if (candidates.length === 0) return { candidates: [], decision: null, diagnostics: [...diagnostics, "no_decomposition_candidates"] };
  const reduced = await runDecompositionReduceLoop({ modelRouter: input.modelRouter, runId, candidates,
    store: input.store, task: input.task, systemPrompt: input.reducePrompt });
  input.store.saveCandidates(runId, reduced.candidates);
  return { candidates: reduced.candidates, decision: reduced.decision, diagnostics };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/revenueDecomposition.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, then stop for review**

Run: `pnpm build` → no errors. Report diff for user review.

---

### Task 9: Wiring — registry kinds, subagent tool branch, apply tool, historical-mapping context

**Files:**
- Modify: `src/agent/financial-modeling/subagents.ts` (extend `DcfSubagentKind`, exclude new kinds from `ModelingProposalSubagent`, register prompts)
- Modify: `src/agent/financial-modeling/subagentTool.ts` (input-schema branch + execution path for `revenue_decomposition`)
- Modify: `mcp_tools/financial-model/financialModelTools.ts` (add `decompositionStore` to `FinancialModelToolDeps` + default SQLite wiring + new `apply_revenue_decomposition` tool)
- Modify: `src/agent/financial-modeling/historicalMappingLoop.ts` (base context gains `decomposition`)
- Test: `src/agent/financial-modeling/__tests__/revenueDecompositionWiring.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `DcfSubagentKind = "statement_extraction" | "filing_decomposition" | "decomposition_reduce" | "historical_mapping" | "forecast_modeling" | "valuation_review"`; `ModelingProposalSubagent = Exclude<DcfSubagentKind, "statement_extraction" | "filing_decomposition" | "decomposition_reduce">`.
  - `run_dcf_subagent` accepts `{ subagent: "revenue_decomposition", modelId, task }` (a pipeline name, deliberately not a registry kind: it drives the two registered kinds internally) and returns `generation_context.data` = `{ decomposition: { candidates: <ranked summaries without cell values>, driverSchemeId, diagnostics } }`.
  - Public tool `apply_revenue_decomposition` with input `{ modelId: string, acceptedSchemeIds: string[], driverSchemeId?: string, rationale: string }`: loads `sourceReviewStore.get(modelId)` and `decompositionStore.listCandidates(artifact.ingestionRunId)`, requires `driverSchemeId === undefined || acceptedSchemeIds.includes(driverSchemeId)`, calls `materializeDecomposition`, saves the new artifact via `sourceReviewStore.save(modelId, next)` and `decompositionStore.saveFinalDecision(runId, { acceptedSchemeIds, driverSchemeId: driverSchemeId ?? null, decidedBy: context.agentId, rationale })`, returns the `DecompositionSummary`.
  - `historicalMappingLoop` base context gains `decomposition: input.sourceReview.decomposition ?? null`.

Registry registrations (in the `DcfSubagentRegistry` constructor):

```ts
this.register({ name: "filing_decomposition", modelClass: "MEDIUM", authority: "read_only_proposal",
  prompt: "You are the private filing_decomposition subagent of the DCF Agent, scoped to ONE filing. From the base-context table catalog (titles only), find tables that break the income statement's revenue rows into product, service, geographic, or segment components. Use list_table_rows to inspect structure and get_table_facts to obtain exact factIds. Propose zero or more decomposition schemes; every child must reference factIds returned by get_table_facts. Never write a source number yourself. An empty schemes array is the correct answer when this filing supports no decomposition. Return JSON {rationale,payload:{schemes},sourceRefs}." });
this.register({ name: "decomposition_reduce", modelClass: "MEDIUM", authority: "read_only_proposal",
  prompt: "You are the private decomposition_reduce subagent of the DCF Agent. The host has aligned per-filing revenue decomposition schemes into cross-year candidates with coverage matrices and residual ratios. Resolve the open alignment questions with merge_children where two children are the same business line, then rank the candidate schemes by reasonableness (year coverage, residual ratio, child granularity, caption stability) and pick at most one driver (ranked[0]) for revenue forecasting. Drop schemes that cannot be aligned across years. Never handle source values. Return JSON {rationale,payload:{ranked,driverSchemeId},sourceRefs}." });
```

`subagentTool.ts` changes: add a third `oneOf` branch `{ subagent: enum ["revenue_decomposition"], modelId, task }`; in `execute`, before the proposal-subagent path:

```ts
if (subagent === "revenue_decomposition") {
  const modelId = requiredString(input, "modelId");
  const meta = deps.financial.modelStore.getMeta(modelId);
  if (!meta || meta.ownerAgentId !== context.agentId) return { summary: "Financial model not found.", error: { code: "financial_model_not_found", message: "Financial model not found." } };
  const sourceReview = deps.financial.sourceReviewStore.get(modelId);
  if (!sourceReview) return { summary: "Source review unavailable.", error: { code: "source_review_unavailable", message: "revenue_decomposition requires a prepared source review" } };
  const result = await runRevenueDecomposition({ modelRouter: deps.modelRouter, sourceReview,
    tableStore: filingTableStore(), store: deps.financial.decompositionStore,
    mapPrompt: subagents.get("filing_decomposition").prompt, reducePrompt: subagents.get("decomposition_reduce").prompt,
    task: requiredString(input, "task") });
  const ranked = result.decision?.ranked ?? [];
  const summaries = ranked.map((id) => result.candidates.find((candidate) => candidate.candidateSchemeId === id)!)
    .map((candidate) => ({ candidateSchemeId: candidate.candidateSchemeId, label: candidate.label, axisHint: candidate.axisHint,
      targetSourceLineItemId: candidate.targetSourceLineItemId, coverage: candidate.coverage,
      residualRatioByPeriod: candidate.residualRatioByPeriod, flags: candidate.flags,
      children: candidate.children.map((child) => ({ childId: child.childId, label: child.label })) }));
  return { summary: ranked.length === 0 ? "No revenue decomposition available; revenue stays whole-line."
      : `revenue_decomposition ranked ${ranked.length} scheme(s); driver ${result.decision?.driverSchemeId ?? "none"}. Accept with apply_revenue_decomposition.`,
    generation_context: { data: { decomposition: { candidates: summaries,
      driverSchemeId: result.decision?.driverSchemeId ?? null, diagnostics: result.diagnostics } as unknown as JsonObject } } };
}
```

`financialModelTools.ts`: extend `FinancialModelToolDeps` with `decompositionStore: DecompositionStore`; default deps add `decompositionStore: SqliteDecompositionStore.open(databasePath)`; register the `apply_revenue_decomposition` tool alongside existing tools (add its name to `FINANCIAL_MODELING_TOOLS` — check how that constant enumerates tools and follow it). `subagentTool.ts` reaches the store via `deps.financial.decompositionStore`.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/financial-modeling/__tests__/revenueDecompositionWiring.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { DcfSubagentRegistry } from "../subagents.ts";

test("decomposition kinds are registered as private read-only subagents", () => {
  const registry = new DcfSubagentRegistry();
  assert.equal(registry.get("filing_decomposition").authority, "read_only_proposal");
  assert.equal(registry.get("decomposition_reduce").authority, "read_only_proposal");
  assert.match(registry.get("filing_decomposition").prompt, /Never write a source number/);
  assert.match(registry.get("decomposition_reduce").prompt, /merge_children/);
});
```

Plus an end-to-end wiring test in the same file that constructs `createDcfSubagentTool` with in-memory deps (mirror how `subagentTool` tests build `FinancialModelToolDeps` — find the existing test that exercises `run_dcf_subagent` with `statement_extraction` in `src/agent/financial-modeling/__tests__/` and copy its dependency scaffolding; the codebase already has in-memory implementations for every store), then:
1. seed `sourceReviewStore.save("m1", artifact)` and `tableStore.saveTables(runId, [table])` as in Task 8's test;
2. call the tool with `{ subagent: "revenue_decomposition", modelId: "m1", task: "decompose" }` and a scripted router; assert the summary mentions the driver;
3. call `apply_revenue_decomposition` with the returned `driverSchemeId`; assert `sourceReviewStore.get("m1")!.decomposition!.schemes[0]!.driver === true` and that child rows appear in the saved artifact's income-statement view;
4. assert `historicalMappingLoop`'s base context now carries the summary: run `runHistoricalMappingLoop` with a scripted router whose first response is the final proposal, and assert the injected user message contains `"decomposition"` (capture via a router that records `messages`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/revenueDecompositionWiring.test.ts`
Expected: FAIL — `filing_decomposition` is an unknown DCF subagent.

- [ ] **Step 3: Implement all four file changes** (registry + tool branch + apply tool + base-context line). The `historicalMappingLoop.ts` change is one line in `baseContext`: `decomposition: input.sourceReview.decomposition ?? null,`.

- [ ] **Step 4: Run the new test, then the full suite**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/revenueDecompositionWiring.test.ts` → PASS.
Run: `pnpm build && pnpm test` → all green. Watch specifically `subagents.test.ts` ("only financial_modeling is top-level..." iterates the registry list — the new kinds must not be top-level, which holds automatically) and any test asserting the `run_dcf_subagent` input schema.

- [ ] **Step 5: Stop for review**

Report the full diff for user review.

---

### Task 10: AAPL smoke script (manual, network-gated)

**Files:**
- Create: `scripts/xbrl/smoke-revenue-decomposition.ts`

**Interfaces:**
- Consumes: the real pipeline (`createPreparedStatementProvider`, `runStatementExtraction` deps, `runRevenueDecomposition`) with `SEC_USER_AGENT` and a live LLM provider from the existing environment config; mirrors `scripts/xbrl/smoke-aapl-tsla.ts` conventions (read that script first and follow its provider/env setup exactly).

- [ ] **Step 1: Write the script**

The script: resolve + extract AAPL 5 years (same as the existing smoke), run face selection and `mergeCuratedTables`, build a `SourceReviewArtifact`, run `runRevenueDecomposition` with real prompts from `DcfSubagentRegistry`, print per-scheme label/axis/coverage/residuals and the driver, and write the JSON output under `data/smoke/xbrl/aapl-5y-revenue-decomposition-<date>/`. Expected outcome per spec §9: a by-product and a by-geography scheme, product ranked first.

- [ ] **Step 2: Typecheck only**

Run: `pnpm build` → no errors. Actually executing the smoke needs network + LLM credentials — run it only when the user asks, and report results.

- [ ] **Step 3: Stop for review**

Report the diff and the smoke instructions (`node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/smoke-revenue-decomposition.ts`).

---

## Self-Review Notes (already applied)

- Spec §3.2 minting ↔ Task 1/6 (`mintTableFactId`, `get_table_facts` minting + persistence via `onMintedFacts` → store).
- Spec §4 validation/adjudication/alignment ↔ Tasks 3–4. Known deviation: `calculationRelations` are passed as `[]` in the orchestrator because relations are not persisted on `SourceReviewArtifact`; the concept-set check still enforces revenue-family, and the `calculation_relations_unavailable` diagnostic surfaces the gap (Task 8 step 3). If the user wants full calc-relation validation, a follow-up must persist per-filing relations on the artifact.
- Spec §5 reduce ↔ Task 7 (`inspect_scheme` is listed in the interface block; implement it alongside `merge_children` — it returns the per-scheme summary from the working set).
- Spec §6 materialization/driver ↔ Task 5 + Task 9 apply tool; forecast-side per-child growth assumptions ride the existing `revenue_stream` / `categoryLineItems` machinery via historical_mapping (base context now carries the summary), so no engine change is needed in this plan.
- Spec §7 failure rows ↔ Task 8 (map failure, zero candidates), Task 3 (invalid refs), Task 4 (30% flag), Task 7 (invalid ids/envelope errors).
- Spec §8 persistence ↔ Task 2 store used at every stage.
- Spec §9 verification ↔ per-task tests + Task 10 smoke.
