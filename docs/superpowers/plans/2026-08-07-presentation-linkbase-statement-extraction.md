# Presentation-Linkbase Statement Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract each filing's three face statements directly from its XBRL presentation linkbase and facts, and prove the result against the existing HTML-scraping path with a per-cell reconciliation report.

**Architecture:** The Arelle companion (Python) gains a `statements` field carrying each face statement as a pre-order flattened presentation tree with resolved facts. TypeScript gains a pure builder that scopes those trees to the requested periods, and a verifier that runs three deterministic checks (calculation roll-up, `Assets == LiabilitiesAndStockholdersEquity`, period completeness). A comparison script runs old and new paths side by side. Nothing downstream of extraction is touched.

**Tech Stack:** Python 3 + `arelle-release` (companion, run through `.venv-arelle/bin/python`), TypeScript on Node 24 with `--experimental-strip-types`, `node:test` + `node:assert/strict`.

## Global Constraints

- Arelle companion protocol version moves from `2` to `3`. Existing fields (`tables`, `calculationRelations`, `negatedConcepts`, `diagnostics`) keep their shapes exactly, so both extraction paths run side by side.
- Do not modify `src/infra/xbrl/mergeCuratedTables.ts`, `src/infra/xbrl/selectFaceStatements.ts`, `src/financial-model/autoPremap.ts`, `src/financial-model/skeleton.ts`, or anything in the DCF/valuation path.
- Every new pure function must be testable without Arelle and without network. Arelle-dependent code stays in a thin adapter layer, following the precedent of the companion's `--expand-table` debug CLI.
- Run the full suite with `npm test`. Run one file with:
  `node --env-file=.env --experimental-strip-types --experimental-sqlite --test <path>`
- Typecheck with `npm run build` (`tsc -p tsconfig.json`). It must pass before every commit.
- TSLA fixture accession for manual checks: `0001628280-26-003952`, primary document
  `https://www.sec.gov/Archives/edgar/data/1318605/000162828026003952/tsla-20251231.htm`.
  All eight TSLA filings are already in the local Arelle web cache, so Arelle-backed manual probes run offline.

---

### Task 1: Protocol version 3 with an empty `statements` field

Bump the protocol on both sides and thread an always-empty `statements: []` through, so the two paths can coexist before any new logic exists.

**Files:**
- Modify: `scripts/xbrl/arelle_companion.py` (`PROTOCOL_VERSION`, `extract_filing` return dicts)
- Modify: `src/infra/xbrl/types.ts` (`FilingExtraction`, `ArelleExtractionRequest`, `ArelleExtractionResponse`)
- Modify: `src/infra/xbrl/arelleAdapter.ts:106-130` (`validateResponse`), and the request builder's `protocolVersion`
- Modify: `scripts/xbrl/fixtures/minimal-response.json`
- Test: `src/infra/xbrl/__tests__/arelleCompanion.test.ts`, `src/infra/xbrl/__tests__/arelleAdapter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PresentationStatementPayload` on `FilingExtraction.statements`, consumed by Tasks 2-5.

```ts
export type PresentationFactPayload = {
  periodId: string;
  value: number;
  unit: Unit;
  decimals?: number;
  contextId: string;
  sourceAnchor: string;
  dimensions: XbrlDimension[];
};

export type PresentationNodePayload = {
  nodeId: number;
  parentNodeId: number | null;
  conceptQName: string;
  label: string;
  abstract: boolean;
  facts: PresentationFactPayload[];
  ambiguousPeriodIds: string[];
};

export type PresentationStatementPayload = {
  statement: StatementKind;
  roleUri: string;
  roleLabel: string;
  declaredAxisQNames: string[];
  nodes: PresentationNodePayload[];
};
```

- [ ] **Step 1: Write the failing adapter test**

Append to `src/infra/xbrl/__tests__/arelleAdapter.test.ts`:

The existing tests drive the real runner with a fake Node process that writes one JSON response.
Follow that pattern exactly — the runner is called as `runner(REQUEST)`, not `runner.extract(...)`:

```ts
const FILING = {
  filing: { accession: "a1", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31",
    primaryDocumentUrl: "https://example.test/a1.htm" },
  tables: [], calculationRelations: [], negatedConcepts: [], diagnostics: [],
};

/** Spawns a Node process that emits `response` verbatim, matching the fake-process tests above. */
function fakeCompanion(response: unknown) {
  return createArelleProcessRunner({
    command: process.execPath,
    args: ["-e", `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(response))}))`],
    timeoutMs: 2_000,
  });
}

test("a protocol 3 response carrying an empty statements array is accepted", async () => {
  const runner = fakeCompanion({ protocolVersion: 3, diagnostics: [], filings: [{ ...FILING, statements: [] }] });
  const response = await runner(REQUEST);
  assert.deepEqual(response.filings[0]!.statements, []);
});

test("a filing without a statements array is a protocol error", async () => {
  const runner = fakeCompanion({ protocolVersion: 3, diagnostics: [], filings: [FILING] });
  await assert.rejects(runner(REQUEST), (error) => error instanceof ArelleAdapterError
    && error.code === "xbrl_protocol_error" && /malformed filing/.test(error.message));
});
```

The file's shared `REQUEST` constant is `{ protocolVersion: 2 as const, filings: [], periods: [] }`; change its
`2` to `3` in this step, which also makes the three existing fake-process tests exercise the new version.

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/arelleAdapter.test.ts`
Expected: FAIL — the first test rejects with "does not match protocol version 2".

- [ ] **Step 3: Bump the TypeScript side**

In `src/infra/xbrl/types.ts`, add the three payload types above (importing `Unit` from `../../financial-model/types.ts` and reusing the existing `XbrlDimension` and `StatementKind`), add `statements: PresentationStatementPayload[]` to `FilingExtraction`, and change both `protocolVersion: 2` literals to `3`.

In `src/infra/xbrl/arelleAdapter.ts:107`, change `value.protocolVersion !== 2` to `!== 3` and the message to "protocol version 3". In the filing loop at line 111, add `|| !Array.isArray(filing.statements)` to the malformed-filing condition. Update the request builder's `protocolVersion` literal to `3`.

- [ ] **Step 4: Bump the Python side**

In `scripts/xbrl/arelle_companion.py`, set `PROTOCOL_VERSION = 3`. In `extract_filing`, add `"statements": []` to both the success return dict (around line 734) and the exception return dict (around line 737).

- [ ] **Step 5: Update the fixture and companion tests**

In `scripts/xbrl/fixtures/minimal-response.json`, set `"protocolVersion": 3` and add `"statements": []` to the single filing object.

In `src/infra/xbrl/__tests__/arelleCompanion.test.ts`, change the `REQUEST` literal's `protocolVersion` to `3` and the `assert.equal(output["protocolVersion"], 2)` to `3`. Then add:

```ts
assert.deepEqual(filings[0]!["statements"], []);
```

- [ ] **Step 6: Run the full suite**

Run: `npm run build && npm test`
Expected: build clean, all tests pass. Any other file asserting `protocolVersion` 2 must be updated in this step — search with `grep -rn "protocolVersion" src scripts | grep -v node_modules`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(xbrl): bump Arelle companion protocol to 3 with an empty statements field"
```

---

### Task 2: Pure presentation-tree walk in the companion, behind a debug CLI

Build the node list from a plain description of presentation relationships. No Arelle, no facts yet.

**Files:**
- Modify: `scripts/xbrl/arelle_companion.py` (add `build_statement_nodes`, `walk_presentation_cli`, `--walk-presentation` flag)
- Test: `src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts` (create)

**Interfaces:**
- Consumes: `PresentationStatementPayload` from Task 1.
- Produces: Python `build_statement_nodes(spec: dict) -> list[dict]` where `spec` has keys `roots: list[str]`, `relationships: list[{parent, child, order, preferredLabel, abstract}]`, and `facts: list[dict]` (ignored in this task). Task 3 extends the same function.

- [ ] **Step 1: Write the failing test**

Create `src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts`
Expected: FAIL — `argparse` rejects `--walk-presentation` as an unrecognized argument, so `status` is non-zero.

- [ ] **Step 3: Implement the pure walk**

Add to `scripts/xbrl/arelle_companion.py`, near `expand_table_cli`:

```python
def build_statement_nodes(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Pre-order walk of one presentation role. Pure, so it is testable without Arelle."""
    children: dict[str, list[dict[str, Any]]] = {}
    for relation in spec.get("relationships", ()):
        children.setdefault(relation["parent"], []).append(relation)
    for group in children.values():
        group.sort(key=lambda relation: (float(relation.get("order") or 0), relation["child"]))
    abstract = set(spec.get("abstractConcepts", ()))

    nodes: list[dict[str, Any]] = []

    def visit(concept: str, label: str, parent_node_id: int | None, ancestry: frozenset[str]) -> None:
        # A presentation linkbase may declare a cycle; the ancestry set bounds the walk
        # without dropping a concept that legitimately appears under two parents.
        if concept in ancestry:
            return
        node_id = len(nodes)
        nodes.append({
            "nodeId": node_id,
            "parentNodeId": parent_node_id,
            "conceptQName": concept,
            "label": label or concept,
            "abstract": concept in abstract,
            "facts": [],
            "ambiguousPeriodIds": [],
        })
        for relation in children.get(concept, ()):
            visit(relation["child"], relation.get("preferredLabel") or "", node_id, ancestry | {concept})

    for root in spec.get("roots", ()):
        visit(root, root, None, frozenset())
    return nodes


def walk_presentation_cli() -> list[dict[str, Any]]:
    """Debug CLI so §5.1 of the design is testable without Arelle."""
    return build_statement_nodes(json.load(sys.stdin))
```

Then in `main()`, before the `--expand-table` branch:

```python
        if args.walk_presentation:
            sys.stdout.write(json.dumps(walk_presentation_cli(), separators=(",", ":"), allow_nan=False) + "\n")
            return
```

and register the flag next to the others:

```python
    parser.add_argument("--walk-presentation", action="store_true", help="walk one stdin presentation spec into node JSON; debug only")
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add scripts/xbrl/arelle_companion.py src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts
git commit -m "feat(xbrl): add a pure presentation-tree walk behind a companion debug CLI"
```

---

### Task 3: Resolve facts onto nodes, including the dimensional case

**Files:**
- Modify: `scripts/xbrl/arelle_companion.py` (`build_statement_nodes`)
- Test: `src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts`

**Interfaces:**
- Consumes: `build_statement_nodes` from Task 2.
- Produces: nodes whose `facts` and `ambiguousPeriodIds` are populated. The spec gains `declaredAxisQNames: list[str]` and `facts: list[{conceptQName, periodId, value, unit, decimals, contextId, sourceAnchor, dimensions}]` where `dimensions` is `list[{axisQName, memberQName}]`.

**Resolution rule (design §4), in this order:**

1. **Collapse by context.** An XBRL fact is `(concept, context, unit)`; an inline document tags the same fact everywhere it appears, so `spec["facts"]` repeats it. Index by `(conceptQName, contextId)`. Within one context, keep the entry whose `decimals` is finer (larger number; `-6` beats `-7`) — that is the same number at higher resolution, not a competing value.
2. **A dimensionless context is the line.** If the concept has a dimensionless fact for that period, it is the value; dimensional facts are its breakdown and are not consulted.
3. **Otherwise fall back to a declared axis.** If exactly one remaining fact for that period has dimensions drawn only from `declaredAxisQNames`, it is the value.
4. **Otherwise no fact**, and if the group that won had more than one member, record the period in `ambiguousPeriodIds`.

Steps 1 and 2 are load-bearing, not polish. Measured on TSLA's FY2025 10-K: without step 1, cash, net income, and total current liabilities all have "multiple candidates" and blank out (TSLA tags cash three times); without step 2, `CostOfRevenue` competes with its five `srt:ProductOrServiceAxis` members and blanks out. With both, 232 concept-periods resolve at step 2, 4 at step 3, and none reach step 4.

- [ ] **Step 1: Write the failing test**

Append to `src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts`
Expected: FAIL — every new test reports empty `facts`, because Task 2 hard-codes `"facts": []`.

- [ ] **Step 3: Implement fact resolution**

In `scripts/xbrl/arelle_companion.py`, replace the body of `build_statement_nodes` between the `abstract = ...` line and the `nodes` declaration with the index below, and replace the node dict literal's `"facts": []` / `"ambiguousPeriodIds": []` with the resolved values:

```python
    declared_axes = set(spec.get("declaredAxisQNames", ()))

    # An XBRL fact is (concept, context, unit). An inline document tags the same fact
    # everywhere it appears, so the raw list repeats it — without this collapse a line
    # tagged three times looks like three competing candidates and blanks out.
    by_context: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in spec.get("facts", ()):
        key = (entry["conceptQName"], entry["contextId"])
        kept = by_context.get(key)
        if kept is None or finer(entry.get("decimals"), kept.get("decimals")):
            by_context[key] = entry

    by_concept: dict[str, list[dict[str, Any]]] = {}
    for entry in by_context.values():
        by_concept.setdefault(entry["conceptQName"], []).append(entry)

    def resolve(concept: str) -> tuple[list[dict[str, Any]], list[str]]:
        dimensionless: dict[str, list[dict[str, Any]]] = {}
        dimensional: dict[str, list[dict[str, Any]]] = {}
        for entry in by_concept.get(concept, ()):
            dims = entry.get("dimensions") or []
            if not dims:
                dimensionless.setdefault(entry["periodId"], []).append(entry)
            # A fact on an axis this role never declares belongs to some other disclosure;
            # putting it on a consolidated line would be a wrong number.
            elif all(dim["axisQName"] in declared_axes for dim in dims):
                dimensional.setdefault(entry["periodId"], []).append(entry)

        resolved: list[dict[str, Any]] = []
        ambiguous: list[str] = []
        for period_id in sorted(set(dimensionless) | set(dimensional)):
            # The consolidated line is the dimensionless fact; members are its breakdown and
            # are consulted only when the filer reported the line solely on a member.
            candidates = dimensionless.get(period_id) or dimensional.get(period_id, [])
            if len(candidates) == 1:
                resolved.append(candidates[0])
            else:
                ambiguous.append(period_id)
        return resolved, ambiguous
```

and, at module level next to `build_statement_nodes`:

```python
def finer(candidate: Any, kept: Any) -> bool:
    """`decimals` is precision: -6 (millions) is finer than -7 (ten millions). None is unknown."""
    if candidate is None:
        return False
    return kept is None or int(candidate) > int(kept)
```

and inside `visit`:

```python
        resolved, ambiguous = ([], []) if concept in abstract else resolve(concept)
        nodes.append({
            "nodeId": node_id,
            "parentNodeId": parent_node_id,
            "conceptQName": concept,
            "label": label or concept,
            "abstract": concept in abstract,
            "facts": resolved,
            "ambiguousPeriodIds": ambiguous,
        })
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts`
Expected: PASS, 11/11 (3 from Task 2 plus 8 here).

- [ ] **Step 5: Commit**

```bash
git add scripts/xbrl/arelle_companion.py src/infra/xbrl/__tests__/arelleCompanionPresentation.test.ts
git commit -m "feat(xbrl): resolve presentation node facts including declared-axis dimensional rows"
```

---

### Task 4: Wire the Arelle model into the statement builder

Feed real Arelle relationships and facts into `build_statement_nodes` and emit `statements` from `extract_filing`.

**Files:**
- Modify: `scripts/xbrl/arelle_companion.py` (add `presentation_spec`, `presentation_statements`; call from `extract_filing`)
- Test: manual verification against the cached TSLA filing (no automated test — this layer is the Arelle adapter and is deliberately thin)

**Interfaces:**
- Consumes: `build_statement_nodes` (Task 3), the existing `choose_statement_roles`, `qname_text`, and `iso_date`.
- Produces: `filing["statements"]` matching `PresentationStatementPayload[]` from Task 1.

- [ ] **Step 1: Implement the adapter**

Add to `scripts/xbrl/arelle_companion.py`:

```python
def presentation_spec(model_xbrl: Any, parent_child: str, role: str, periods: list[dict[str, Any]]) -> dict[str, Any]:
    """Adapt one Arelle presentation role into the pure walker's input."""
    relationship_set = model_xbrl.relationshipSet(parent_child, role)
    relationships: list[dict[str, Any]] = []
    abstract_concepts: list[str] = []
    seen: set[str] = set()

    def collect(concept: Any) -> None:
        name = qname_text(getattr(concept, "qname", None))
        if not name or name in seen:
            return
        seen.add(name)
        if getattr(concept, "isAbstract", False):
            abstract_concepts.append(name)
        for relation in sorted_relationships(relationship_set, concept):
            child = getattr(relation, "toModelObject", None)
            if child is None:
                continue
            child_name = qname_text(getattr(child, "qname", None))
            if not child_name:
                continue
            preferred = getattr(relation, "preferredLabel", None)
            relationships.append({
                "parent": name,
                "child": child_name,
                "order": float(getattr(relation, "order", 0) or 0),
                "preferredLabel": child.label(preferredLabel=preferred) if preferred else child.label(),
                "abstract": bool(getattr(child, "isAbstract", False)),
            })
            collect(child)

    roots: list[str] = []
    for root in relationship_set.rootConcepts:
        root_name = qname_text(getattr(root, "qname", None))
        if root_name:
            roots.append(root_name)
            collect(root)

    declared_axes = sorted({name for name in seen if name.endswith("Axis")})
    period_by_date = {period["end"]: period["id"] for period in periods}
    facts: list[dict[str, Any]] = []
    for fact in model_xbrl.factsInInstance:
        context = getattr(fact, "context", None)
        if context is None or getattr(fact, "isNil", False):
            continue
        value = getattr(fact, "xValue", None)
        if not isinstance(value, (int, float, Decimal)):
            continue
        moment = context.instantDatetime if context.isInstantPeriod else context.endDatetime
        period_id = period_by_date.get(iso_date(moment, subtract_day=True) or "")
        if period_id is None:
            continue
        concept_name = qname_text(getattr(fact.concept, "qname", None))
        if concept_name not in seen:
            continue
        facts.append({
            "conceptQName": concept_name,
            "periodId": period_id,
            "value": float(value),
            "unit": unit_value(fact),
            "decimals": int(fact.decimals) if str(getattr(fact, "decimals", "")).lstrip("-").isdigit() else None,
            "contextId": str(context.id),
            "sourceAnchor": f"{fact.modelDocument.uri}#{fact.id}" if getattr(fact, "id", None) else str(fact.modelDocument.uri),
            "dimensions": sorted(
                ({"axisQName": qname_text(value.dimension), "memberQName": qname_text(value.member)}
                 for value in context.qnameDims.values()),
                key=lambda dim: (dim["axisQName"], dim["memberQName"]),
            ),
        })

    return {"roots": roots, "relationships": relationships, "abstractConcepts": abstract_concepts,
            "declaredAxisQNames": declared_axes, "facts": facts}


def presentation_statements(model_xbrl: Any, parent_child: str, periods: list[dict[str, Any]]) -> list[dict[str, Any]]:
    statements: list[dict[str, Any]] = []
    for statement, role in choose_statement_roles(model_xbrl, parent_child).items():
        spec = presentation_spec(model_xbrl, parent_child, role, periods)
        statements.append({
            "statement": statement,
            "roleUri": role,
            "roleLabel": role_label(model_xbrl, role),
            "declaredAxisQNames": spec["declaredAxisQNames"],
            "nodes": build_statement_nodes(spec),
        })
    return statements
```

Add `from decimal import Decimal` to the imports. The module already has `unit_value(fact)` at line 213 —
use it, and delete the `unit_of` name from the snippet above in favour of `"unit": unit_value(fact)`.
Do not add a second unit helper.

In `extract_filing`, change the success return's `"statements": []` to:

```python
                "statements": presentation_statements(model_xbrl, parent_child, periods),
```

- [ ] **Step 2: Verify against the cached TSLA filing**

Run:

```bash
python3 - > /tmp/req3.json <<'EOF'
import json
print(json.dumps({"protocolVersion": 3,
  "filings": [{"accession": "0001628280-26-003952", "form": "10-K", "filedAt": "2026-01-28",
               "reportDate": "2025-12-31",
               "primaryDocumentUrl": "https://www.sec.gov/Archives/edgar/data/1318605/000162828026003952/tsla-20251231.htm"}],
  "periods": [{"id": f"FY{y}", "label": f"FY{y}", "start": f"{y}-01-01", "end": f"{y}-12-31", "cls": "actual"} for y in range(2021, 2026)]}))
EOF
.venv-arelle/bin/python scripts/xbrl/arelle_companion.py < /tmp/req3.json > /tmp/out3.json
python3 - <<'EOF'
import json
d = json.load(open("/tmp/out3.json"))
bs = [s for s in d["filings"][0]["statements"] if s["statement"] == "balance_sheet"][0]
for node in bs["nodes"]:
    values = {f["periodId"]: f["value"] / 1e6 for f in node["facts"]}
    print(f"{'  ' * 0}{node['label'][:44]:<46}{values.get('FY2025', ''):>12}   {node['conceptQName']}")
EOF
```

Expected: the full balance sheet, `us-gaap:Assets` at `137806.0`, and both `us-gaap:DeferredCostsLeasingNetNoncurrent` (`4912.0`) and `tsla:LeasedAssetsNet` (`4604.0`) carrying values. If either dimensional row is blank, `declaredAxisQNames` did not pick up `us-gaap:PropertyPlantAndEquipmentByTypeAxis`; check the `endswith("Axis")` heuristic against the actual concept names in `spec["declaredAxisQNames"]`.

- [ ] **Step 3: Capture the real payload as a committed fixture**

The synthetic tests in Tasks 2, 3, 5, and 6 cannot catch drift between what Arelle actually emits and
what the types assume. Capture one real response so that drift becomes a test failure:

```bash
python3 - <<'EOF'
import json
d = json.load(open("/tmp/out3.json"))
f = d["filings"][0]
# Keep the statements and identity; drop the 59 HTML tables, which this fixture is not about.
json.dump({"protocolVersion": 3, "diagnostics": [],
           "filings": [{"filing": f["filing"], "tables": [], "calculationRelations": f["calculationRelations"],
                        "negatedConcepts": f["negatedConcepts"], "diagnostics": [], "statements": f["statements"]}]},
          open("scripts/xbrl/fixtures/tsla-fy2025-statements.json", "w"), indent=2, sort_keys=True)
EOF
```

Commit the file. Nothing consumes it yet — Task 6's final step is the test that does.

Sanity-check it by eye before moving on: the balance-sheet statement should have roughly 45 nodes,
`us-gaap:Assets` should carry `137806000000` for FY2025, and `tsla:LeasedAssetsNet` should carry
`4604000000`.

- [ ] **Step 4: Run the full suite**

Run: `npm run build && npm test`
Expected: build clean, all tests pass. Task 1's `assert.deepEqual(filings[0]!["statements"], [])` still passes because it runs against `minimal-response.json`, not against Arelle.

- [ ] **Step 5: Commit**

```bash
git add scripts/xbrl/arelle_companion.py scripts/xbrl/fixtures/tsla-fy2025-statements.json
git commit -m "feat(xbrl): emit face statements from the presentation linkbase"
```

---

### Task 5: TypeScript `PresentedStatement` builder

**Files:**
- Create: `src/infra/xbrl/presentedStatement.ts`
- Test: `src/infra/xbrl/__tests__/presentedStatement.test.ts` (create)

**Interfaces:**
- Consumes: `PresentationStatementPayload`, `PresentationNodePayload`, `PresentationFactPayload`, `FilingExtraction` (Task 1).
- Produces:

```ts
export type PresentedNode = {
  nodeId: number;
  parentNodeId: number | null;
  conceptQName: string;
  label: string;
  abstract: boolean;
  valueByPeriod: Map<string, PresentationFactPayload>;
  ambiguousPeriodIds: string[];
};

export type PresentedStatement = {
  accession: string;
  statement: StatementKind;
  roleUri: string;
  roleLabel: string;
  nodes: PresentedNode[];
  periodIds: string[];
};

export function buildPresentedStatements(input: {
  filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[];
}): PresentedStatement[];
```

- [ ] **Step 1: Write the failing test**

Create `src/infra/xbrl/__tests__/presentedStatement.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Period } from "../../../financial-model/types.ts";
import { buildPresentedStatements } from "../presentedStatement.ts";
import type { FilingExtraction, PresentationNodePayload } from "../types.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
];

function node(overrides: Partial<PresentationNodePayload> & { nodeId: number; conceptQName: string }): PresentationNodePayload {
  return {
    parentNodeId: null, label: overrides.conceptQName, abstract: false,
    facts: [], ambiguousPeriodIds: [], ...overrides,
  };
}

function fact(periodId: string, value: number) {
  return { periodId, value, unit: { kind: "currency" as const, code: "USD" }, decimals: -6,
    contextId: `c-${periodId}`, sourceAnchor: "https://example.test#f", dimensions: [] };
}

function extraction(nodes: PresentationNodePayload[]): FilingExtraction {
  return {
    filing: { accession: "acc-1", form: "10-K", filedAt: "2026-02-01", reportDate: "2025-12-31",
      primaryDocumentUrl: "https://example.test/acc-1.htm" },
    tables: [], calculationRelations: [], negatedConcepts: [], diagnostics: [],
    statements: [{ statement: "balance_sheet", roleUri: "role:bs", roleLabel: "Consolidated Balance Sheets",
      declaredAxisQNames: [], nodes }],
  };
}

test("nodes keep their declared order and their parent links", () => {
  const [statement] = buildPresentedStatements({
    filings: [extraction([
      node({ nodeId: 0, conceptQName: "us-gaap:AssetsAbstract", abstract: true }),
      node({ nodeId: 1, parentNodeId: 0, conceptQName: "us-gaap:Assets", label: "Total assets", facts: [fact("FY2025", 137806)] }),
    ])],
    requestedPeriods: PERIODS,
  });

  assert.equal(statement!.accession, "acc-1");
  assert.deepEqual(statement!.nodes.map((entry) => [entry.nodeId, entry.parentNodeId, entry.label]), [
    [0, null, "us-gaap:AssetsAbstract"],
    [1, 0, "Total assets"],
  ]);
  assert.equal(statement!.nodes[1]!.valueByPeriod.get("FY2025")!.value, 137806);
});

test("facts outside the requested periods are dropped and do not widen periodIds", () => {
  const [statement] = buildPresentedStatements({
    filings: [extraction([
      node({ nodeId: 0, conceptQName: "us-gaap:Assets", facts: [fact("FY2025", 1), fact("FY2019", 2)] }),
    ])],
    requestedPeriods: PERIODS,
  });

  assert.deepEqual([...statement!.nodes[0]!.valueByPeriod.keys()], ["FY2025"]);
  assert.deepEqual(statement!.periodIds, ["FY2025"]);
});

test("periodIds follow the requested order, not the order facts arrived in", () => {
  const [statement] = buildPresentedStatements({
    filings: [extraction([
      node({ nodeId: 0, conceptQName: "us-gaap:Assets", facts: [fact("FY2025", 1), fact("FY2024", 2)] }),
    ])],
    requestedPeriods: PERIODS,
  });

  assert.deepEqual(statement!.periodIds, ["FY2024", "FY2025"]);
});

test("a filing carrying no statements produces none", () => {
  const empty: FilingExtraction = { ...extraction([]), statements: [] };
  assert.deepEqual(buildPresentedStatements({ filings: [empty], requestedPeriods: PERIODS }), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/presentedStatement.test.ts`
Expected: FAIL — cannot find module `../presentedStatement.ts`.

- [ ] **Step 3: Implement**

Create `src/infra/xbrl/presentedStatement.ts`:

```ts
import type { Period, StatementKind } from "../../financial-model/types.ts";
import type { FilingExtraction, PresentationFactPayload } from "./types.ts";

export type PresentedNode = {
  nodeId: number;
  parentNodeId: number | null;
  conceptQName: string;
  label: string;
  abstract: boolean;
  valueByPeriod: Map<string, PresentationFactPayload>;
  ambiguousPeriodIds: string[];
};

export type PresentedStatement = {
  accession: string;
  statement: StatementKind;
  roleUri: string;
  roleLabel: string;
  nodes: PresentedNode[];
  periodIds: string[];
};

/**
 * Shape the companion's presentation payload into one statement per filing, scoped to the
 * requested periods. A pure transform: the issuer's declared order and nesting are preserved
 * exactly, and nothing here infers structure.
 */
export function buildPresentedStatements(input: {
  filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[];
}): PresentedStatement[] {
  const requested = input.requestedPeriods.filter((period) => period.cls === "actual").map((period) => period.id);
  const requestedSet = new Set(requested);
  const statements: PresentedStatement[] = [];

  for (const filing of input.filings) {
    for (const payload of filing.statements) {
      const present = new Set<string>();
      const nodes = payload.nodes.map((node) => {
        const valueByPeriod = new Map<string, PresentationFactPayload>();
        for (const fact of node.facts) {
          if (!requestedSet.has(fact.periodId)) continue;
          valueByPeriod.set(fact.periodId, fact);
          present.add(fact.periodId);
        }
        return {
          nodeId: node.nodeId,
          parentNodeId: node.parentNodeId,
          conceptQName: node.conceptQName,
          label: node.label,
          abstract: node.abstract,
          valueByPeriod,
          ambiguousPeriodIds: node.ambiguousPeriodIds.filter((periodId) => requestedSet.has(periodId)),
        };
      });
      statements.push({
        accession: filing.filing.accession,
        statement: payload.statement,
        roleUri: payload.roleUri,
        roleLabel: payload.roleLabel,
        nodes,
        periodIds: requested.filter((periodId) => present.has(periodId)),
      });
    }
  }

  return statements;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/presentedStatement.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run build
git add src/infra/xbrl/presentedStatement.ts src/infra/xbrl/__tests__/presentedStatement.test.ts
git commit -m "feat(xbrl): build per-filing presented statements from the companion payload"
```

---

### Task 6: Verification — roll-up, balance, period completeness

**Files:**
- Create: `src/infra/xbrl/verifyPresentedStatement.ts`
- Test: `src/infra/xbrl/__tests__/verifyPresentedStatement.test.ts` (create)

**Interfaces:**
- Consumes: `PresentedStatement`, `PresentedNode` (Task 5), `CalculationRelation` (`src/infra/xbrl/types.ts`).
- Produces:

```ts
export type RollupBreak = {
  roleUri: string; parentConcept: string; periodId: string;
  reported: number; computed: number; difference: number; missingChildren: string[];
};
export type BalanceBreak = { periodId: string; assets: number; liabilitiesAndEquity: number; difference: number };
export type StatementVerification = {
  rollupBreaks: RollupBreak[];
  balanceBreaks: BalanceBreak[];
  reportedPeriodIds: string[];
  totalsUnavailable: boolean;
};
export function verifyPresentedStatement(
  statement: PresentedStatement,
  relations: readonly CalculationRelation[],
): StatementVerification;
```

Tolerance is not redefined here. `src/infra/xbrl/verification.ts:178` already has

```ts
function tolerance(reported: number): number {
  return Math.max(ABSOLUTE_TOLERANCE, Math.abs(reported) * RELATIVE_TOLERANCE);
}
```

Export it from that module (`export function tolerance`) and import it. There must be exactly one tolerance rule in the codebase.

- [ ] **Step 1: Write the failing test**

Create `src/infra/xbrl/__tests__/verifyPresentedStatement.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { PresentedNode, PresentedStatement } from "../presentedStatement.ts";
import type { CalculationRelation } from "../types.ts";
import { verifyPresentedStatement } from "../verifyPresentedStatement.ts";

let nextId = 0;
function node(conceptQName: string, values: Record<string, number>, abstract = false): PresentedNode {
  return {
    nodeId: nextId++, parentNodeId: null, conceptQName, label: conceptQName, abstract,
    valueByPeriod: new Map(Object.entries(values).map(([periodId, value]) => [periodId, {
      periodId, value, unit: { kind: "currency" as const, code: "USD" }, decimals: -6,
      contextId: `c-${periodId}`, sourceAnchor: "https://example.test#f", dimensions: [],
    }])),
    ambiguousPeriodIds: [],
  };
}

function statement(nodes: PresentedNode[], periodIds = ["FY2025"]): PresentedStatement {
  return { accession: "acc-1", statement: "balance_sheet", roleUri: "role:bs",
    roleLabel: "Consolidated Balance Sheets", nodes, periodIds };
}

const rollup = (parentConcept: string, children: string[]): CalculationRelation => ({
  roleUri: "role:bs", parentConcept,
  children: children.map((concept, index) => ({ concept, weight: 1, order: index })),
});

test("a roll-up whose children sum to the parent produces no break", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:AssetsCurrent", { FY2025: 30 }), node("us-gaap:Cash", { FY2025: 10 }), node("us-gaap:Inventory", { FY2025: 20 })]),
    [rollup("us-gaap:AssetsCurrent", ["us-gaap:Cash", "us-gaap:Inventory"])],
  );

  assert.deepEqual(result.rollupBreaks, []);
});

test("a missing child is reported with the difference and the absent concept", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:AssetsCurrent", { FY2025: 30 }), node("us-gaap:Cash", { FY2025: 10 })]),
    [rollup("us-gaap:AssetsCurrent", ["us-gaap:Cash", "us-gaap:Inventory"])],
  );

  assert.equal(result.rollupBreaks.length, 1);
  assert.deepEqual([result.rollupBreaks[0]!.reported, result.rollupBreaks[0]!.computed, result.rollupBreaks[0]!.difference], [30, 10, 20]);
  assert.deepEqual(result.rollupBreaks[0]!.missingChildren, ["us-gaap:Inventory"]);
});

test("a negative weight subtracts", () => {
  const relation: CalculationRelation = { roleUri: "role:bs", parentConcept: "ex:Net",
    children: [{ concept: "ex:Gross", weight: 1, order: 0 }, { concept: "ex:Allowance", weight: -1, order: 1 }] };
  const result = verifyPresentedStatement(
    statement([node("ex:Net", { FY2025: 90 }), node("ex:Gross", { FY2025: 100 }), node("ex:Allowance", { FY2025: 10 })]),
    [relation],
  );

  assert.deepEqual(result.rollupBreaks, []);
});

test("relations belonging to another role are ignored", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:InventoryNet", { FY2025: 20 })]),
    [{ roleUri: "role:inventory-note", parentConcept: "us-gaap:InventoryNet",
       children: [{ concept: "us-gaap:InventoryRawMaterialsNetOfReserves", weight: 1, order: 0 }] }],
  );

  assert.deepEqual(result.rollupBreaks, []);
});

test("assets equal to liabilities and equity passes; unequal is reported", () => {
  const ok = verifyPresentedStatement(
    statement([node("us-gaap:Assets", { FY2025: 100 }), node("us-gaap:LiabilitiesAndStockholdersEquity", { FY2025: 100 })]), []);
  assert.deepEqual(ok.balanceBreaks, []);

  const bad = verifyPresentedStatement(
    statement([node("us-gaap:Assets", { FY2025: 100 }), node("us-gaap:LiabilitiesAndStockholdersEquity", { FY2025: 97 })]), []);
  assert.equal(bad.balanceBreaks.length, 1);
  assert.equal(bad.balanceBreaks[0]!.difference, 3);
});

test("an untagged LiabilitiesAndStockholdersEquity is skipped without a break", () => {
  const result = verifyPresentedStatement(statement([node("us-gaap:Assets", { FY2025: 100 })]), []);
  assert.deepEqual(result.balanceBreaks, []);
});

test("a period in which only a non-total node carries a fact is not reported as covered", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:AssetsCurrent", { FY2025: 30 }), node("us-gaap:Cash", { FY2024: 5, FY2025: 30 })], ["FY2024", "FY2025"]),
    [rollup("us-gaap:AssetsCurrent", ["us-gaap:Cash"])],
  );

  assert.deepEqual(result.reportedPeriodIds, ["FY2025"]);
  assert.equal(result.totalsUnavailable, false);
});

test("without calculation relations there are no totals, so coverage falls back and says so", () => {
  const result = verifyPresentedStatement(
    statement([node("us-gaap:Cash", { FY2024: 5 }), node("ex:Abstract", {}, true)], ["FY2024", "FY2025"]), []);

  assert.equal(result.totalsUnavailable, true);
  assert.deepEqual(result.reportedPeriodIds, ["FY2024"]);
  assert.deepEqual(result.rollupBreaks, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/verifyPresentedStatement.test.ts`
Expected: FAIL — cannot find module `../verifyPresentedStatement.ts`.

- [ ] **Step 3: Implement**

Create `src/infra/xbrl/verifyPresentedStatement.ts`:

```ts
import type { PresentedNode, PresentedStatement } from "./presentedStatement.ts";
import type { CalculationRelation } from "./types.ts";
import { tolerance } from "./verification.ts";

export type RollupBreak = {
  roleUri: string; parentConcept: string; periodId: string;
  reported: number; computed: number; difference: number; missingChildren: string[];
};

export type BalanceBreak = { periodId: string; assets: number; liabilitiesAndEquity: number; difference: number };

export type StatementVerification = {
  rollupBreaks: RollupBreak[];
  balanceBreaks: BalanceBreak[];
  reportedPeriodIds: string[];
  totalsUnavailable: boolean;
};

const ASSETS = "us-gaap:Assets";
const LIABILITIES_AND_EQUITY = "us-gaap:LiabilitiesAndStockholdersEquity";

function valueOf(byConcept: Map<string, PresentedNode>, concept: string, periodId: string): number | undefined {
  return byConcept.get(concept)?.valueByPeriod.get(periodId)?.value;
}

export function verifyPresentedStatement(
  statement: PresentedStatement,
  relations: readonly CalculationRelation[],
): StatementVerification {
  // A concept may appear under two parents; the first node wins, because both carry the same fact.
  const byConcept = new Map<string, PresentedNode>();
  for (const node of statement.nodes) {
    if (node.abstract || byConcept.has(node.conceptQName)) continue;
    byConcept.set(node.conceptQName, node);
  }

  const own = relations.filter((relation) => relation.roleUri === statement.roleUri);
  const rollupBreaks: RollupBreak[] = [];
  for (const relation of own) {
    for (const periodId of statement.periodIds) {
      const reported = valueOf(byConcept, relation.parentConcept, periodId);
      if (reported === undefined) continue;
      const present = relation.children.filter((child) => valueOf(byConcept, child.concept, periodId) !== undefined);
      if (present.length === 0) continue;
      const computed = present.reduce((sum, child) => sum + child.weight * valueOf(byConcept, child.concept, periodId)!, 0);
      const difference = reported - computed;
      if (Math.abs(difference) <= tolerance(reported)) continue;
      rollupBreaks.push({
        roleUri: statement.roleUri, parentConcept: relation.parentConcept, periodId,
        reported, computed, difference,
        missingChildren: relation.children
          .filter((child) => valueOf(byConcept, child.concept, periodId) === undefined)
          .map((child) => child.concept),
      });
    }
  }

  const balanceBreaks: BalanceBreak[] = [];
  if (statement.statement === "balance_sheet") {
    for (const periodId of statement.periodIds) {
      const assets = valueOf(byConcept, ASSETS, periodId);
      const liabilitiesAndEquity = valueOf(byConcept, LIABILITIES_AND_EQUITY, periodId);
      // A filer that never tags LiabilitiesAndStockholdersEquity is not in breach; there is
      // simply nothing to compare, and inventing a sum here would be a different check.
      if (assets === undefined || liabilitiesAndEquity === undefined) continue;
      const difference = assets - liabilitiesAndEquity;
      if (Math.abs(difference) <= tolerance(assets)) continue;
      balanceBreaks.push({ periodId, assets, liabilitiesAndEquity, difference });
    }
  }

  const totals = new Set(own.map((relation) => relation.parentConcept));
  const totalsUnavailable = totals.size === 0;
  // Absent a calculation linkbase there are no totals to test, so coverage falls back to any
  // non-abstract fact. The flag exists so a caller never reads that fallback as a real total.
  const covered = totalsUnavailable
    ? statement.nodes.filter((node) => !node.abstract)
    : statement.nodes.filter((node) => totals.has(node.conceptQName));
  const reportedPeriodIds = statement.periodIds.filter((periodId) =>
    covered.some((node) => node.valueByPeriod.has(periodId)));

  return { rollupBreaks, balanceBreaks, reportedPeriodIds, totalsUnavailable };
}
```

This step also edits `src/infra/xbrl/verification.ts:178` to add the `export` keyword to `tolerance`. Nothing else in that file changes.

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/verifyPresentedStatement.test.ts`
Expected: PASS, 11/11 (3 from Task 2 plus 8 here).

- [ ] **Step 5: Add the real-fixture test**

Both halves now exist, so the fixture captured in Task 4 can be exercised end to end. In
`src/infra/xbrl/__tests__/presentedStatement.test.ts`, extend `PERIODS` from FY2021 through FY2025 so the
fixture's comparative periods are in scope, then append:

```ts
test("the captured TSLA FY2025 payload builds a balance sheet that balances", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { verifyPresentedStatement } = await import("../verifyPresentedStatement.ts");
  const path = fileURLToPath(new URL("../../../../scripts/xbrl/fixtures/tsla-fy2025-statements.json", import.meta.url));
  const response = JSON.parse(await readFile(path, "utf8")) as { filings: FilingExtraction[] };

  const statements = buildPresentedStatements({ filings: response.filings, requestedPeriods: PERIODS });
  const balanceSheet = statements.find((entry) => entry.statement === "balance_sheet")!;

  assert.equal(balanceSheet.nodes.find((node) => node.conceptQName === "us-gaap:Assets")!.valueByPeriod.get("FY2025")!.value, 137_806_000_000);
  assert.equal(balanceSheet.nodes.find((node) => node.conceptQName === "tsla:LeasedAssetsNet")!.valueByPeriod.get("FY2025")!.value, 4_604_000_000,
    "a line item reported only under a declared axis member must still resolve");

  const verification = verifyPresentedStatement(balanceSheet, response.filings[0]!.calculationRelations);
  assert.deepEqual(verification.balanceBreaks, []);
  assert.deepEqual(verification.rollupBreaks, []);
});
```

If `rollupBreaks` is non-empty, do not relax the assertion. Read the break: a non-zero difference here means
the dimensional resolution rule or the `endsWith("Axis")` declaration heuristic is wrong, which is exactly
what this fixture exists to catch.

- [ ] **Step 6: Run both test files, typecheck, and commit**

Run:
```bash
node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/verifyPresentedStatement.test.ts src/infra/xbrl/__tests__/presentedStatement.test.ts
npm run build && npm test
```
Expected: all pass, build clean.

```bash
git add src/infra/xbrl/verifyPresentedStatement.ts src/infra/xbrl/verification.ts \
        src/infra/xbrl/__tests__/verifyPresentedStatement.test.ts src/infra/xbrl/__tests__/presentedStatement.test.ts
git commit -m "feat(xbrl): verify presented statements by roll-up, balance, and period coverage"
```

---

### Task 7: Reconciliation harness

Run both extraction paths over the same filings and report every per-cell difference. This is the acceptance artifact for the whole plan.

**Files:**
- Create: `scripts/xbrl/compare-statement-extraction.ts`
- Test: manual — the script's output is the deliverable

**Interfaces:**
- Consumes: `buildPresentedStatements` (Task 5), `verifyPresentedStatement` (Task 6), and the existing `createArelleProcessRunner`, `selectFaceStatements`, `mergeCuratedTables`, `SqliteFilingTableStore`.
- Produces: a markdown report at `data/smoke/xbrl/<symbol>-statement-comparison-<date>.md`.

- [ ] **Step 1: Write the script**

Create `scripts/xbrl/compare-statement-extraction.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Period } from "../../src/financial-model/types.ts";
import { createArelleProcessRunner } from "../../src/infra/xbrl/arelleAdapter.ts";
import { mergeCuratedTables } from "../../src/infra/xbrl/mergeCuratedTables.ts";
import { buildPresentedStatements } from "../../src/infra/xbrl/presentedStatement.ts";
import { selectFaceStatements } from "../../src/infra/xbrl/selectFaceStatements.ts";
import { SqliteFilingTableStore } from "../../src/infra/xbrl/filingTableStore.ts";
import { verifyPresentedStatement } from "../../src/infra/xbrl/verifyPresentedStatement.ts";

// Manual, network-gated comparison of the two face-statement extraction paths:
//   old: HTML tables -> selectFaceStatements -> mergeCuratedTables
//   new: presentation linkbase -> buildPresentedStatements
// Both run over the same Arelle extraction, so any difference is downstream of it.
//
//   node --env-file=.env --experimental-strip-types --experimental-sqlite \
//     scripts/xbrl/compare-statement-extraction.ts

const companion = fileURLToPath(new URL("./arelle_companion.py", import.meta.url));
const command = process.env["ARELLE_ADAPTER_COMMAND"]?.trim() || "python3";
const args = process.env["ARELLE_ADAPTER_ARGS"] ? (JSON.parse(process.env["ARELLE_ADAPTER_ARGS"]!) as string[]) : [companion];
const symbol = (process.env["SMOKE_SYMBOL"]?.trim() || "TSLA").toUpperCase();
const filingsJson = process.env["COMPARE_FILINGS"];
if (!filingsJson) throw new Error("COMPARE_FILINGS must be a JSON array of {accession, form, filedAt, reportDate, primaryDocumentUrl}");
const filings = JSON.parse(filingsJson) as Array<{ accession: string; form: string; filedAt: string; reportDate: string; primaryDocumentUrl: string }>;
const years = [2021, 2022, 2023, 2024, 2025];
const requestedPeriods: Period[] = years.map((year) => ({
  id: `FY${year}`, label: `FY${year}`, start: `${year}-01-01`, end: `${year}-12-31`, cls: "actual",
}));

const runner = createArelleProcessRunner({ command, args, timeoutMs: 600_000 });
const extraction = await runner.extract({ protocolVersion: 3, filings, periods: requestedPeriods });

const outputDirectory = resolve(join("data", "smoke", "xbrl"));
await mkdir(outputDirectory, { recursive: true });
const store = SqliteFilingTableStore.open(join(outputDirectory, `${symbol.toLowerCase()}-comparison.sqlite`));

try {
  // --- old path ---
  const tables = extraction.filings.flatMap((filing) => filing.tables);
  const calculationRelations = Object.fromEntries(extraction.filings.map((filing) => [filing.filing.accession, filing.calculationRelations]));
  const reportDates = [...new Set(tables.map((table) => table.reportDate))].sort();
  const selection = selectFaceStatements({
    runId: "compare", store, tables, requestedPeriods, reportDates, calculationRelations,
  });
  const merged = mergeCuratedTables({
    requestedPeriods, filings: extraction.filings.map((filing) => filing.filing),
    tables, curations: selection.curations,
  });
  const oldCells = new Map<string, number>();
  for (const fact of merged.facts) {
    const row = merged.statementViews.income_statement.candidate.rows
      .concat(merged.statementViews.balance_sheet.candidate.rows, merged.statementViews.cash_flow_statement.candidate.rows)
      .find((entry) => entry.sourceLineItemId === fact.lineItemId);
    if (!row?.conceptQName) continue;
    oldCells.set(`${row.statement}|${fact.periodId}|${row.conceptQName}`, fact.value);
  }

  // --- new path ---
  const presented = buildPresentedStatements({ filings: extraction.filings, requestedPeriods });
  const newCells = new Map<string, number>();
  for (const statement of presented) {
    for (const node of statement.nodes) {
      for (const [periodId, fact] of node.valueByPeriod) {
        // Precedence matches the old path: the most recently filed statement wins a contested cell.
        newCells.set(`${statement.statement}|${periodId}|${node.conceptQName}`, fact.value);
      }
    }
  }

  const keys = [...new Set([...oldCells.keys(), ...newCells.keys()])].sort();
  const agree: string[] = [];
  const onlyNew: string[] = [];
  const onlyOld: string[] = [];
  const differ: string[] = [];
  for (const key of keys) {
    const oldValue = oldCells.get(key);
    const newValue = newCells.get(key);
    if (oldValue === undefined) onlyNew.push(`| ${key.split("|").join(" | ")} | ${newValue} |`);
    else if (newValue === undefined) onlyOld.push(`| ${key.split("|").join(" | ")} | ${oldValue} |`);
    else if (Math.abs(oldValue - newValue) <= Math.max(Math.abs(oldValue) * 1e-6, 1)) agree.push(key);
    else differ.push(`| ${key.split("|").join(" | ")} | ${oldValue} | ${newValue} | ${oldValue - newValue} |`);
  }

  const lines = [
    `# ${symbol} statement extraction comparison`, "",
    `Filings: ${filings.length}. Cells: old ${oldCells.size}, new ${newCells.size}.`, "",
    `- agree: ${agree.length}`, `- only on the new path: ${onlyNew.length}`,
    `- only on the existing path: ${onlyOld.length}`, `- disagree: ${differ.length}`, "",
    "## Disagree", "", "| statement | period | concept | old | new | difference |", "|---|---|---|---|---|---|",
    ...differ, "",
    "## Only on the new path", "", "| statement | period | concept | value |", "|---|---|---|---|", ...onlyNew, "",
    "## Only on the existing path", "", "| statement | period | concept | value |", "|---|---|---|---|", ...onlyOld, "",
    "## Verification", "",
  ];
  for (const statement of presented) {
    const relations = extraction.filings.find((filing) => filing.filing.accession === statement.accession)?.calculationRelations ?? [];
    const verification = verifyPresentedStatement(statement, relations);
    lines.push(`### ${statement.accession} ${statement.statement}`, "",
      `- reported periods: ${verification.reportedPeriodIds.join(", ") || "none"}`,
      `- totals unavailable: ${verification.totalsUnavailable}`,
      `- roll-up breaks: ${verification.rollupBreaks.length}`,
      `- balance breaks: ${verification.balanceBreaks.length}`, "");
    for (const entry of verification.rollupBreaks) {
      lines.push(`  - \`${entry.parentConcept}\` @ ${entry.periodId}: reported ${entry.reported}, computed ${entry.computed}, difference ${entry.difference}${entry.missingChildren.length > 0 ? `, missing ${entry.missingChildren.join(", ")}` : ""}`);
    }
    for (const entry of verification.balanceBreaks) {
      lines.push(`  - balance @ ${entry.periodId}: assets ${entry.assets}, L+E ${entry.liabilitiesAndEquity}, difference ${entry.difference}`);
    }
    lines.push("");
  }

  const path = join(outputDirectory, `${symbol.toLowerCase()}-statement-comparison-${new Date().toISOString().slice(0, 10)}.md`);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${path}\nagree ${agree.length} | onlyNew ${onlyNew.length} | onlyOld ${onlyOld.length} | differ ${differ.length}\n`);
} finally {
  store.close();
}
```

Before writing this, read `scripts/xbrl/smoke-premap-mapping-review.ts` and match its conventions for reading `ARELLE_ADAPTER_*` and for the output directory. Read `selectFaceStatements`'s and `mergeCuratedTables`'s current signatures and adjust the calls if they have drifted from what is written above.

- [ ] **Step 2: Run it against the cached TSLA filings**

```bash
COMPARE_FILINGS='[
 {"accession":"0000950170-22-000796","form":"10-K","filedAt":"2022-02-07","reportDate":"2021-12-31","primaryDocumentUrl":"https://www.sec.gov/Archives/edgar/data/1318605/000095017022000796/tsla-20211231.htm"},
 {"accession":"0000950170-23-001409","form":"10-K","filedAt":"2023-01-31","reportDate":"2022-12-31","primaryDocumentUrl":"https://www.sec.gov/Archives/edgar/data/1318605/000095017023001409/tsla-20221231.htm"},
 {"accession":"0001628280-24-002390","form":"10-K","filedAt":"2024-01-29","reportDate":"2023-12-31","primaryDocumentUrl":"https://www.sec.gov/Archives/edgar/data/1318605/000162828024002390/tsla-20231231.htm"},
 {"accession":"0001628280-25-003063","form":"10-K","filedAt":"2025-01-30","reportDate":"2024-12-31","primaryDocumentUrl":"https://www.sec.gov/Archives/edgar/data/1318605/000162828025003063/tsla-20241231.htm"},
 {"accession":"0001628280-26-003952","form":"10-K","filedAt":"2026-01-28","reportDate":"2025-12-31","primaryDocumentUrl":"https://www.sec.gov/Archives/edgar/data/1318605/000162828026003952/tsla-20251231.htm"}
]' ARELLE_ADAPTER_COMMAND=.venv-arelle/bin/python \
node --env-file=.env --experimental-strip-types --experimental-sqlite scripts/xbrl/compare-statement-extraction.ts
```

Expected: a report written under `data/smoke/xbrl/`. Read it. Specifically confirm:
- the balance sheet has zero balance breaks in every period;
- `us-gaap:DeferredCostsLeasingNetNoncurrent` and `tsla:LeasedAssetsNet` appear on the new path;
- rows that appear only on the existing path are caption-forked duplicates or genuine memo rows, and each one is explained in the summary you write.

Do not "fix" a difference by adjusting the comparison. Every difference is either a real defect on one side or a known and stated behaviour difference.

- [ ] **Step 3: Write the findings summary**

Create `docs/2026-08-07-tsla-statement-extraction-comparison.md` with: the four counts, an explanation for every entry in "disagree", and a categorized explanation for the "only on one path" lists. This is what the switchover decision will be made from.

- [ ] **Step 4: Run the full suite and commit**

```bash
npm run build && npm test
git add scripts/xbrl/compare-statement-extraction.ts docs/2026-08-07-tsla-statement-extraction-comparison.md
git commit -m "feat(xbrl): add a statement extraction reconciliation harness and TSLA report"
```

---

## Out of scope for this plan

Switching the pipeline to the new path, cross-year merging of per-filing statements, generalizing dimensional decomposition beyond revenue, and any change to `autoPremap`, `skeleton`, mapping, forecast, or valuation. The comparison report from Task 7 is the input to those decisions, not part of them.
