import { test } from "node:test";
import assert from "node:assert/strict";
import { FinancialModelError } from "../errors.ts";
import { applyFactReview, resolveActiveFacts, stageFacts } from "../factLifecycle.ts";
import type { Fact, FactReviewDecision, LineItem, Period, Unit } from "../types.ts";

const USD: Unit = { kind: "currency", code: "USD" };
const EUR: Unit = { kind: "currency", code: "EUR" };
const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "actual" },
];
const ITEMS: LineItem[] = [
  {
    id: "cost_of_revenue",
    label: "Cost of revenue",
    role: "none",
    unit: USD,
    section: "history",
    order: 1,
    historical: "actual",
    forecast: "none",
  },
  {
    id: "revenue.total",
    label: "Revenue",
    role: "revenue_total",
    unit: USD,
    section: "revenue",
    order: 2,
    historical: "actual",
    forecast: "formula",
  },
];
const PROVENANCE = {
  sourceType: "filing",
  sourceRefs: ["accession-1"],
  asOfDate: "2026-08-04",
};

const STAGED_REVENUE: Fact = {
  factId: "revenue-new",
  status: "staged",
  lineItemId: "revenue.total",
  periodId: "FY2025",
  value: 120,
  unit: USD,
  provenance: PROVENANCE,
};
const COMMITTED_REVENUE: Fact = {
  factId: "revenue-old",
  status: "committed",
  lineItemId: "revenue.total",
  periodId: "FY2025",
  value: 100,
  unit: USD,
  provenance: PROVENANCE,
};
const STAGED_RESTATEMENT: Fact = {
  ...STAGED_REVENUE,
  factId: "revenue-restatement",
  supersedesFactId: COMMITTED_REVENUE.factId,
};
const REJECTED_CANDIDATE: Fact = {
  ...STAGED_REVENUE,
  factId: "revenue-rejected",
  status: "rejected",
  value: 115,
};
const WRONG_PERIOD_REPLACEMENT: Fact = {
  ...STAGED_RESTATEMENT,
  factId: "wrong-period-replacement",
  periodId: "FY2024",
};

let decisionSequence = 0;
function decision(
  factId: string,
  action: FactReviewDecision["action"],
  fields: Pick<FactReviewDecision, "mappedLineItemId" | "replacementFactId"> = {},
): FactReviewDecision {
  decisionSequence += 1;
  return {
    decisionId: `decision-${decisionSequence}`,
    factId,
    action,
    ...fields,
    rationale: "Reviewed against the filing",
    reviewedBy: "analyst-1",
    reviewedAt: "2026-08-04T12:00:00.000Z",
  };
}

const commitDecision = (factId: string, mappedLineItemId = "revenue.total") =>
  decision(factId, "commit", { mappedLineItemId });
const rejectDecision = (factId: string) => decision(factId, "reject");
const supersedeDecision = (factId: string, replacementFactId: string) =>
  decision(factId, "supersede", { replacementFactId });
const byId = (facts: readonly Fact[], factId: string): Fact => {
  const fact = facts.find((candidate) => candidate.factId === factId);
  assert.ok(fact);
  return fact;
};
const isConflict = (error: unknown): boolean =>
  error instanceof FinancialModelError && error.code === "fact_conflict";

test("committing a staged fact makes it the unique active fact", () => {
  const next = applyFactReview([STAGED_REVENUE], [commitDecision(STAGED_REVENUE.factId)]);
  assert.equal(next[0]?.status, "committed");
  assert.deepEqual(
    resolveActiveFacts(next, ITEMS, PERIODS).map((fact) => fact.factId),
    [STAGED_REVENUE.factId],
  );
  assert.equal(STAGED_REVENUE.status, "staged", "the parent fact is not mutated");
});

test("staging accepts only new staged facts and clones both parent and candidates", () => {
  const candidate = { ...STAGED_REVENUE, factId: "another-candidate" };
  const next = stageFacts([COMMITTED_REVENUE], [candidate]);
  assert.deepEqual(next.map((fact) => fact.factId), [COMMITTED_REVENUE.factId, candidate.factId]);
  assert.notEqual(next[0], COMMITTED_REVENUE);
  assert.notEqual(next[1], candidate);
  assert.throws(
    () => stageFacts([], [{ ...candidate, status: "committed" }]),
    isConflict,
  );
});

test("staging rejects reused fact ids and payload mutation", () => {
  const changed = { ...COMMITTED_REVENUE, status: "staged" as const, value: 999 };
  assert.throws(() => stageFacts([COMMITTED_REVENUE], [changed]), isConflict);
  assert.throws(
    () => stageFacts([], [STAGED_REVENUE, { ...STAGED_REVENUE, value: 999 }]),
    isConflict,
  );
});

test("rejected and staged candidates never enter active facts", () => {
  const facts = [COMMITTED_REVENUE, STAGED_RESTATEMENT, REJECTED_CANDIDATE];
  assert.deepEqual(
    resolveActiveFacts(facts, ITEMS, PERIODS).map((fact) => fact.factId),
    [COMMITTED_REVENUE.factId],
  );
});

test("a replacement atomically commits the new fact and supersedes the old fact", () => {
  const next = applyFactReview(
    [COMMITTED_REVENUE, STAGED_RESTATEMENT],
    [
      commitDecision(STAGED_RESTATEMENT.factId),
      supersedeDecision(COMMITTED_REVENUE.factId, STAGED_RESTATEMENT.factId),
    ],
  );
  assert.equal(byId(next, COMMITTED_REVENUE.factId).status, "superseded");
  assert.equal(byId(next, STAGED_RESTATEMENT.factId).status, "committed");
  assert.deepEqual(
    resolveActiveFacts(next, ITEMS, PERIODS).map((fact) => fact.factId),
    [STAGED_RESTATEMENT.factId],
  );
});

test("rejecting a restatement leaves the existing committed fact active", () => {
  const next = applyFactReview(
    [COMMITTED_REVENUE, STAGED_RESTATEMENT],
    [rejectDecision(STAGED_RESTATEMENT.factId)],
  );
  assert.equal(byId(next, COMMITTED_REVENUE.factId).status, "committed");
  assert.equal(byId(next, STAGED_RESTATEMENT.factId).status, "rejected");
});

test("invalid replacement rolls back the pure transition", () => {
  const before = structuredClone([COMMITTED_REVENUE, WRONG_PERIOD_REPLACEMENT]);
  const original = structuredClone(before);
  assert.throws(
    () =>
      applyFactReview(before, [
        commitDecision(WRONG_PERIOD_REPLACEMENT.factId),
        supersedeDecision(COMMITTED_REVENUE.factId, WRONG_PERIOD_REPLACEMENT.factId),
      ]),
    isConflict,
  );
  assert.deepEqual(before, original);
});

test("duplicate active cells and commits without an audited replacement are rejected", () => {
  const duplicate = { ...COMMITTED_REVENUE, factId: "duplicate-active", value: 101 };
  assert.throws(
    () => resolveActiveFacts([COMMITTED_REVENUE, duplicate], ITEMS, PERIODS),
    isConflict,
  );
  assert.throws(
    () => applyFactReview([COMMITTED_REVENUE, STAGED_REVENUE], [commitDecision(STAGED_REVENUE.factId)]),
    isConflict,
  );
  assert.throws(
    () => applyFactReview([COMMITTED_REVENUE, STAGED_RESTATEMENT], [commitDecision(STAGED_RESTATEMENT.factId)]),
    isConflict,
  );
});

test("forked, cyclic, missing, and cross-cell supersede chains are rejected", () => {
  const old = { ...COMMITTED_REVENUE, status: "superseded" as const };
  const replacement = { ...STAGED_RESTATEMENT, status: "committed" as const };
  const fork = { ...replacement, factId: "forked-replacement", value: 121 };
  assert.throws(() => resolveActiveFacts([old, replacement, fork], ITEMS, PERIODS), isConflict);

  const cyclicA: Fact = {
    ...old,
    factId: "cycle-a",
    supersedesFactId: "cycle-b",
  };
  const cyclicB: Fact = {
    ...old,
    factId: "cycle-b",
    supersedesFactId: "cycle-a",
  };
  assert.throws(() => resolveActiveFacts([cyclicA, cyclicB], ITEMS, PERIODS), isConflict);

  assert.throws(
    () => resolveActiveFacts([{ ...replacement, supersedesFactId: "missing" }], ITEMS, PERIODS),
    isConflict,
  );
  assert.throws(
    () =>
      resolveActiveFacts(
        [old, { ...replacement, periodId: "FY2024" }],
        ITEMS,
        PERIODS,
      ),
    isConflict,
  );
});

test("review decisions require unique audit ids, complete audit fields, and one target each", () => {
  const first = commitDecision(STAGED_REVENUE.factId);
  const other = { ...STAGED_REVENUE, factId: "other-staged", periodId: "FY2024" };
  assert.throws(
    () => applyFactReview([STAGED_REVENUE, other], [first, { ...commitDecision(other.factId), decisionId: first.decisionId }]),
    isConflict,
  );
  for (const invalid of [
    { ...commitDecision(STAGED_REVENUE.factId), decisionId: "" },
    { ...commitDecision(STAGED_REVENUE.factId), rationale: "" },
    { ...commitDecision(STAGED_REVENUE.factId), reviewedBy: "" },
    { ...commitDecision(STAGED_REVENUE.factId), reviewedAt: "not-an-iso-date" },
  ]) {
    assert.throws(() => applyFactReview([STAGED_REVENUE], [invalid]), isConflict);
  }
  assert.throws(
    () => applyFactReview([STAGED_REVENUE], [commitDecision(STAGED_REVENUE.factId), rejectDecision(STAGED_REVENUE.factId)]),
    isConflict,
  );
});

test("active resolution validates references and exact semantic units", () => {
  assert.throws(
    () => resolveActiveFacts([{ ...COMMITTED_REVENUE, periodId: "FY2099" }], ITEMS, PERIODS),
    isConflict,
  );
  assert.throws(
    () => resolveActiveFacts([{ ...COMMITTED_REVENUE, lineItemId: "unknown" }], ITEMS, PERIODS),
    isConflict,
  );
  assert.throws(
    () => resolveActiveFacts([{ ...COMMITTED_REVENUE, unit: EUR }], ITEMS, PERIODS),
    isConflict,
  );
});

test("active facts are sorted by period, numeric line-item order, id, and fact id", () => {
  const revenue2024: Fact = {
    ...COMMITTED_REVENUE,
    factId: "revenue-2024",
    periodId: "FY2024",
  };
  const cost2024: Fact = {
    ...COMMITTED_REVENUE,
    factId: "cost-2024",
    lineItemId: "cost_of_revenue",
    periodId: "FY2024",
    value: 40,
  };
  const ordered = resolveActiveFacts(
    [COMMITTED_REVENUE, revenue2024, cost2024],
    [...ITEMS].reverse(),
    PERIODS,
  );
  assert.deepEqual(ordered.map((fact) => fact.factId), ["cost-2024", "revenue-2024", "revenue-old"]);
});
