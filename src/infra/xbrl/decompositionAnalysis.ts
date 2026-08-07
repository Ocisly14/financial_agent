import { createHash } from "node:crypto";
import { normalizeLabel } from "./mergeCuratedTables.ts";
import type { CalculationRelation } from "./types.ts";
import type { CandidateChild, CandidateScheme, ChildMergeRecord, FilingDecompositionProposal, FilingDecompositionScheme, MintedTableFact } from "./decompositionTypes.ts";

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

export const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

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
      // Dimension-backed schemes group on target|axis so the same axis groups across filings.
      // "presentation-only" carries no axis identity, so a by-product and a by-geography table on the
      // same target would otherwise pool into one garbage candidate: add the normalized label.
      const identityKey = scheme.axisHint === "presentation-only"
        ? `${scheme.targetSourceLineItemId}|${scheme.axisHint}|${normalizeLabel(scheme.label)}`
        : `${scheme.targetSourceLineItemId}|${scheme.axisHint}`;
      const candidateSchemeId = `cs-${shortHash(identityKey)}`;
      const group = groups.get(candidateSchemeId)
        ?? { label: scheme.label, axisHint: scheme.axisHint, target: scheme.targetSourceLineItemId, children: new Map() };
      groups.set(candidateSchemeId, group);
      for (const child of scheme.children) {
        const identity = child.memberHint ?? normalizeLabel(child.label);
        const childId = `ch-${shortHash(`${scheme.axisHint}|${identity}`)}`;
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
    const derived = deriveSchemeFields({ children, periodIds, targetSourceLineItemId: group.target, faceValues: input.faceValues });
    return { candidateSchemeId, label: group.label, axisHint: group.axisHint, targetSourceLineItemId: group.target,
      children, periodIds, coverage: derived.coverage, residualRatioByPeriod: derived.residualRatioByPeriod ?? {},
      flags: derived.flags, openQuestions: derived.openQuestions };
  });
  return input.merges?.length ? applyChildMerges(candidates, input.merges, input.faceValues) : candidates;
}

/**
 * Per-scheme derivations (spec §4.3): coverage matrix, residual ratios against the face row,
 * the high-residual flag and the ambiguous-children open questions. Shared by initial candidate
 * construction and by post-merge recomputation so a merge can never leave stale derivations behind.
 * `residualRatioByPeriod` is only produced when face values are supplied; callers without them keep
 * whatever they had (a merge only moves cells between children, so the per-scheme sum is unchanged
 * except where two children both covered a period — see applyChildMerges).
 */
function deriveSchemeFields(input: {
  children: readonly CandidateChild[];
  periodIds: readonly string[];
  targetSourceLineItemId: string;
  faceValues?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}): { coverage: Record<string, string[]>; residualRatioByPeriod?: Record<string, number | null>; flags: string[]; openQuestions: string[] } {
  const { children, periodIds } = input;
  const coverage = Object.fromEntries(children.map((child) => [child.childId,
    periodIds.filter((periodId) => child.cells[periodId] !== undefined)]));
  const openQuestions = ambiguousPairs(children).map(([left, right]) =>
    `children ${left.childId} ("${left.label}") and ${right.childId} ("${right.label}") may be the same line; merge_children if so`);
  if (!input.faceValues) return { coverage, flags: [], openQuestions };
  const faceByPeriod = input.faceValues.get(input.targetSourceLineItemId);
  const residualRatioByPeriod = Object.fromEntries(periodIds.map((periodId) => {
    const face = faceByPeriod?.get(periodId);
    if (face === undefined || face === 0) return [periodId, null];
    const sum = children.reduce((total, child) => total + (child.cells[periodId]?.value ?? 0), 0);
    return [periodId, Math.abs(face - sum) / Math.abs(face)];
  })) as Record<string, number | null>;
  const flags = Object.values(residualRatioByPeriod).some((ratio) => ratio !== null && ratio > 0.3)
    ? ["residual_ratio_above_30pct"] : [];
  return { coverage, residualRatioByPeriod, flags, openQuestions };
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

/**
 * Fold merged children into their keeper. When both sides cover a period the newest `filedAt`
 * wins (spec §4.2), matching the same rule buildCandidateSchemes applies across filings.
 * `faceValues` is optional because the merge_children tool runs inside the reduce loop; without it
 * coverage/openQuestions are still recomputed and now-stale flags dropped, but residual ratios are
 * left untouched rather than silently recomputed against absent face values.
 */
export function applyChildMerges(
  candidates: readonly CandidateScheme[],
  merges: readonly ChildMergeRecord[],
  faceValues?: ReadonlyMap<string, ReadonlyMap<string, number>>,
): CandidateScheme[] {
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
        for (const [periodId, cell] of Object.entries(removed!.cells)) {
          const current = keep.cells[periodId];
          if (current === undefined || cell.filedAt > current.filedAt) keep.cells[periodId] = cell;
        }
      }
    }
    const derived = deriveSchemeFields({ children: next.children, periodIds: next.periodIds,
      targetSourceLineItemId: next.targetSourceLineItemId, ...(faceValues ? { faceValues } : {}) });
    next.coverage = derived.coverage;
    next.flags = derived.flags;
    next.openQuestions = derived.openQuestions;
    if (derived.residualRatioByPeriod) next.residualRatioByPeriod = derived.residualRatioByPeriod;
    return next;
  });
}
