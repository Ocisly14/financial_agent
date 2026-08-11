import { FinancialModelError } from "./errors.ts";
import type {
  ActiveFact,
  Fact,
  FactReviewDecision,
  LineItem,
  Period,
  Unit,
} from "./types.ts";

function conflict(message: string): never {
  throw new FinancialModelError("fact_conflict", message);
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function sameUnit(left: Unit, right: Unit): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "currency" && right.kind === "currency") {
    return left.code === right.code;
  }
  if (left.kind === "per_share" && right.kind === "per_share") {
    return left.code === right.code;
  }
  return true;
}

function assertUniqueFactIds(facts: readonly Fact[]): void {
  const ids = new Set<string>();
  for (const fact of facts) {
    if (!nonEmpty(fact.factId)) conflict("factId must be non-empty");
    if (ids.has(fact.factId)) conflict(`duplicate fact id: ${fact.factId}`);
    ids.add(fact.factId);
  }
}

/**
 * Adds immutable fact candidates to a working snapshot. Existing fact IDs are
 * never an update mechanism: corrections are new facts linked through
 * `supersedesFactId` and reviewed separately.
 */
export function stageFacts(parentFacts: readonly Fact[], candidates: readonly Fact[]): Fact[] {
  assertUniqueFactIds(parentFacts);

  const seen = new Set(parentFacts.map((fact) => fact.factId));
  for (const candidate of candidates) {
    if (!nonEmpty(candidate.factId)) conflict("factId must be non-empty");
    if (candidate.status !== "staged") {
      conflict(`new fact ${candidate.factId} must have staged status`);
    }
    if (seen.has(candidate.factId)) {
      conflict(`fact id already exists: ${candidate.factId}`);
    }
    seen.add(candidate.factId);
  }

  return structuredClone([...parentFacts, ...candidates]);
}

function validateDecisionAudit(
  decision: FactReviewDecision,
  decisionIds: Set<string>,
): void {
  if (!nonEmpty(decision.decisionId)) conflict("decisionId must be non-empty");
  if (decisionIds.has(decision.decisionId)) {
    conflict(`duplicate decision id: ${decision.decisionId}`);
  }
  decisionIds.add(decision.decisionId);

  if (!nonEmpty(decision.rationale)) conflict(`decision ${decision.decisionId} requires rationale`);
  if (!nonEmpty(decision.reviewedBy)) conflict(`decision ${decision.decisionId} requires reviewedBy`);
  if (!isIsoDateTime(decision.reviewedAt)) {
    conflict(`decision ${decision.decisionId} has invalid reviewedAt`);
  }
}

function isIsoDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return calendarDate.getUTCFullYear() === year
    && calendarDate.getUTCMonth() === month - 1
    && calendarDate.getUTCDate() === day;
}

/**
 * Applies a complete reviewed transition set atomically to a cloned fact list.
 * Validation finishes before any status is changed, so a thrown transition can
 * neither mutate the parent nor expose a half-committed replacement.
 */
export function applyFactReview(
  parentFacts: readonly Fact[],
  decisions: readonly FactReviewDecision[],
): Fact[] {
  assertUniqueFactIds(parentFacts);
  const next = structuredClone([...parentFacts]);
  const factsById = new Map(next.map((fact) => [fact.factId, fact]));
  const decisionIds = new Set<string>();
  const targetedFacts = new Set<string>();
  const commits = new Map<string, FactReviewDecision>();
  const supersedes = new Map<string, FactReviewDecision>();

  for (const decision of decisions) {
    validateDecisionAudit(decision, decisionIds);
    if (targetedFacts.has(decision.factId)) {
      conflict(`fact ${decision.factId} is targeted by more than one decision`);
    }
    targetedFacts.add(decision.factId);

    const fact = factsById.get(decision.factId);
    if (!fact) conflict(`unknown fact: ${decision.factId}`);

    switch (decision.action) {
      case "commit":
        if (fact.status !== "staged") {
          conflict(`commit requires a staged fact: ${fact.factId}`);
        }
        if (!nonEmpty(decision.mappedLineItemId)) {
          conflict(`commit requires mappedLineItemId: ${fact.factId}`);
        }
        if (decision.replacementFactId !== undefined) {
          conflict(`commit decision cannot carry replacementFactId: ${fact.factId}`);
        }
        commits.set(fact.factId, decision);
        break;
      case "reject":
        if (fact.status !== "staged") {
          conflict(`reject requires a staged fact: ${fact.factId}`);
        }
        if (
          decision.mappedLineItemId !== undefined ||
          decision.replacementFactId !== undefined
        ) {
          conflict(`reject decision has invalid transition fields: ${fact.factId}`);
        }
        break;
      case "supersede":
        if (fact.status !== "committed") {
          conflict(`supersede requires a committed fact: ${fact.factId}`);
        }
        if (!nonEmpty(decision.replacementFactId)) {
          conflict(`supersede requires replacementFactId: ${fact.factId}`);
        }
        if (decision.mappedLineItemId !== undefined) {
          conflict(`supersede decision cannot carry mappedLineItemId: ${fact.factId}`);
        }
        supersedes.set(fact.factId, decision);
        break;
    }
  }

  // Validate both sides of every replacement before applying either side.
  for (const [replacementId, commit] of commits) {
    const replacement = factsById.get(replacementId)!;
    if (replacement.supersedesFactId === undefined) continue;

    const predecessor = factsById.get(replacement.supersedesFactId);
    const supersede = supersedes.get(replacement.supersedesFactId);
    if (
      !predecessor ||
      predecessor.status !== "committed" ||
      supersede?.replacementFactId !== replacementId
    ) {
      conflict(`replacement ${replacementId} is missing its paired supersede decision`);
    }
    validateReplacement(predecessor, replacement, commit.mappedLineItemId!);
  }

  for (const [predecessorId, supersede] of supersedes) {
    const replacement = factsById.get(supersede.replacementFactId!);
    const commit = commits.get(supersede.replacementFactId!);
    if (
      !replacement ||
      replacement.status !== "staged" ||
      replacement.supersedesFactId !== predecessorId ||
      !commit
    ) {
      conflict(`supersede of ${predecessorId} is missing its paired replacement commit`);
    }
    validateReplacement(factsById.get(predecessorId)!, replacement, commit.mappedLineItemId!);
  }

  // A normal commit cannot silently replace an already-active cell. Such a
  // correction must use the paired replacement transition above.
  const activeCells = new Map<string, string>();
  for (const fact of next) {
    if (fact.status !== "committed" || supersedes.has(fact.factId)) continue;
    if (!nonEmpty(fact.lineItemId)) conflict(`committed fact is unmapped: ${fact.factId}`);
    const key = `${fact.lineItemId}\u0000${fact.periodId}`;
    const prior = activeCells.get(key);
    if (prior !== undefined) conflict(`multiple active facts for ${fact.lineItemId}@${fact.periodId}`);
    activeCells.set(key, fact.factId);
  }
  for (const [factId, decision] of commits) {
    const fact = factsById.get(factId)!;
    const key = `${decision.mappedLineItemId!}\u0000${fact.periodId}`;
    const prior = activeCells.get(key);
    if (prior !== undefined) {
      conflict(`commit ${factId} conflicts with active fact ${prior}`);
    }
    activeCells.set(key, factId);
  }

  for (const decision of decisions) {
    const fact = factsById.get(decision.factId)!;
    if (decision.action === "commit") {
      fact.status = "committed";
      fact.lineItemId = decision.mappedLineItemId!;
    } else if (decision.action === "reject") {
      fact.status = "rejected";
    } else {
      fact.status = "superseded";
    }
  }

  validateAcceptedChains(next);
  return next;
}

function validateReplacement(
  predecessor: Fact,
  replacement: Fact,
  mappedLineItemId: string,
): void {
  if (!nonEmpty(predecessor.lineItemId)) {
    conflict(`replacement predecessor is unmapped: ${predecessor.factId}`);
  }
  if (
    mappedLineItemId !== predecessor.lineItemId ||
    replacement.periodId !== predecessor.periodId ||
    !sameUnit(replacement.unit, predecessor.unit)
  ) {
    conflict(`replacement ${replacement.factId} does not match predecessor ${predecessor.factId}`);
  }
}

/**
 * Narrows a mixed lifecycle collection to the one active fact per historical
 * cell and gives the engine a deterministic, authoritative order.
 */
export function resolveActiveFacts(
  facts: readonly Fact[],
  lineItems: readonly LineItem[],
  periods: readonly Period[],
): ActiveFact[] {
  assertUniqueFactIds(facts);

  const itemsById = uniqueById(lineItems, (item) => item.id, "line item");
  const periodIndex = new Map<string, number>();
  periods.forEach((period, index) => {
    if (periodIndex.has(period.id)) conflict(`duplicate period id: ${period.id}`);
    periodIndex.set(period.id, index);
  });

  const factsById = new Map(facts.map((fact) => [fact.factId, fact]));

  for (const fact of facts) {
    if (!periodIndex.has(fact.periodId)) {
      conflict(`fact ${fact.factId} references unknown period ${fact.periodId}`);
    }
    if (fact.lineItemId !== undefined && !itemsById.has(fact.lineItemId)) {
      conflict(`fact ${fact.factId} references unknown line item ${fact.lineItemId}`);
    }

    if (fact.status === "committed" || fact.status === "superseded") {
      if (!nonEmpty(fact.lineItemId)) conflict(`${fact.status} fact is unmapped: ${fact.factId}`);
      const item = itemsById.get(fact.lineItemId);
      if (!item || !sameUnit(fact.unit, item.unit)) {
        conflict(`fact ${fact.factId} unit does not match line item ${fact.lineItemId}`);
      }
    }

  }

  validateAcceptedChains(facts, factsById);

  const activeByCell = new Map<string, ActiveFact>();
  for (const fact of facts) {
    if (fact.status !== "committed") continue;
    const active = structuredClone(fact) as ActiveFact;
    const key = `${active.lineItemId}\u0000${active.periodId}`;
    if (activeByCell.has(key)) {
      conflict(`multiple active facts for ${active.lineItemId}@${active.periodId}`);
    }
    activeByCell.set(key, active);
  }

  const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return [...activeByCell.values()].sort((left, right) => {
    const period = periodIndex.get(left.periodId)! - periodIndex.get(right.periodId)!;
    if (period !== 0) return period;
    const leftItem = itemsById.get(left.lineItemId)!;
    const rightItem = itemsById.get(right.lineItemId)!;
    const order = leftItem.order - rightItem.order;
    if (order !== 0) return order;
    const lineItem = compareText(left.lineItemId, right.lineItemId);
    return lineItem !== 0 ? lineItem : compareText(left.factId, right.factId);
  });
}

function validateAcceptedChains(
  facts: readonly Fact[],
  suppliedById?: ReadonlyMap<string, Fact>,
): void {
  const factsById = suppliedById ?? new Map(facts.map((fact) => [fact.factId, fact]));
  const acceptedSuccessor = new Map<string, string>();

  for (const fact of facts) {
    if (
      (fact.status !== "committed" && fact.status !== "superseded") ||
      fact.supersedesFactId === undefined
    ) {
      continue;
    }
    const predecessor = factsById.get(fact.supersedesFactId);
    if (!predecessor) {
      conflict(`fact ${fact.factId} has missing predecessor ${fact.supersedesFactId}`);
    }
    if (predecessor.status !== "superseded") {
      conflict(`fact ${fact.factId} predecessor is not superseded`);
    }
    if (
      !nonEmpty(fact.lineItemId) ||
      !nonEmpty(predecessor.lineItemId) ||
      predecessor.lineItemId !== fact.lineItemId ||
      predecessor.periodId !== fact.periodId ||
      !sameUnit(predecessor.unit, fact.unit)
    ) {
      conflict(`fact ${fact.factId} has a cross-cell or cross-unit predecessor`);
    }
    if (acceptedSuccessor.has(predecessor.factId)) {
      conflict(`supersede chain forks at ${predecessor.factId}`);
    }
    acceptedSuccessor.set(predecessor.factId, fact.factId);
  }

  for (const fact of facts) {
    if (fact.status === "superseded" && !acceptedSuccessor.has(fact.factId)) {
      conflict(`superseded fact ${fact.factId} has no accepted replacement`);
    }
  }

  for (const fact of facts) {
    if (fact.status !== "committed" && fact.status !== "superseded") continue;
    const seen = new Set<string>();
    let current: Fact | undefined = fact;
    while (current !== undefined) {
      if (seen.has(current.factId)) conflict(`supersede chain contains a cycle at ${current.factId}`);
      seen.add(current.factId);
      current = current.supersedesFactId === undefined
        ? undefined
        : factsById.get(current.supersedesFactId);
    }
  }
}

function uniqueById<T>(
  values: readonly T[],
  idOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const value of values) {
    const id = idOf(value);
    if (out.has(id)) conflict(`duplicate ${label} id: ${id}`);
    out.set(id, value);
  }
  return out;
}
