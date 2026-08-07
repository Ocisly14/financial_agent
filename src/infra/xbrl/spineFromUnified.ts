import type { Fact } from "../../financial-model/types.ts";
import type { UnifiedStatementsArtifact } from "./unifiedStatements.ts";

export type SpineDecision = {
  mappings: Array<{ targetId: string; rowIds: string[]; rationale: string }>;
  detailRows: Array<{ parentTargetId: string; rowId: string; rationale: string }>;
  excluded: Array<{ rowId: string; reason: string }>;
  spineGaps: Array<{ targetId: string; reason: string }>;
};

/** Spec §4: every unified row in exactly one of mappings/excluded (detailRows are additive);
 * every spine id mapped XOR gap-declared; no unknown rowIds or targetIds. */
export function checkSpineCompleteness(input: { unified: UnifiedStatementsArtifact;
  decision: SpineDecision; spineIds: ReadonlySet<string> }): string[] {
  const findings: string[] = [];
  const { decision, spineIds } = input;
  const knownRows = new Set(input.unified.rows.map((r) => r.rowId));
  const requireKnownRow = (rowId: string, where: string) => {
    if (!knownRows.has(rowId)) findings.push(`unknown rowId "${rowId}" referenced in ${where}`);
  };

  // rowId -> placements in mappings/excluded (detailRows tracked separately, they are additive).
  const placements = new Map<string, string[]>();
  const place = (rowId: string, where: string) => {
    const list = placements.get(rowId) ?? [];
    list.push(where);
    placements.set(rowId, list);
  };
  for (const mapping of decision.mappings) {
    if (!spineIds.has(mapping.targetId)) findings.push(`mapping targets unknown spine id "${mapping.targetId}"`);
    if (mapping.rowIds.length === 0) findings.push(`mapping for "${mapping.targetId}" has no rowIds`);
    for (const rowId of mapping.rowIds) {
      requireKnownRow(rowId, `mapping "${mapping.targetId}"`);
      place(rowId, `mapping "${mapping.targetId}"`);
    }
  }
  for (const exclusion of decision.excluded) {
    requireKnownRow(exclusion.rowId, "excluded");
    place(exclusion.rowId, "excluded");
  }
  for (const detail of decision.detailRows) {
    if (!spineIds.has(detail.parentTargetId)) findings.push(`detail row "${detail.rowId}" has unknown parentTargetId "${detail.parentTargetId}"`);
    requireKnownRow(detail.rowId, `detail row under "${detail.parentTargetId}"`);
  }
  for (const rowId of knownRows) {
    const uses = placements.get(rowId) ?? [];
    if (uses.length === 0) findings.push(`dangling: unified row "${rowId}" is in neither mappings nor excluded`);
    if (uses.length > 1) findings.push(`double-placement: unified row "${rowId}" appears in ${uses.join(" and ")}`);
  }

  const mapped = new Set(decision.mappings.map((m) => m.targetId));
  const gapDeclared = new Set<string>();
  for (const gap of decision.spineGaps) {
    if (!spineIds.has(gap.targetId)) findings.push(`spineGaps declares unknown spine id "${gap.targetId}"`);
    gapDeclared.add(gap.targetId);
  }
  for (const targetId of spineIds) {
    const isMapped = mapped.has(targetId);
    const isGap = gapDeclared.has(targetId);
    if (isMapped && isGap) findings.push(`spine id "${targetId}" is both mapped and declared a gap`);
    if (!isMapped && !isGap) findings.push(`spine id "${targetId}" is neither mapped nor declared a gap`);
  }
  return findings;
}

export type SpineFromUnifiedResult = {
  facts: Fact[];
  coverageGaps: Array<{ targetId: string; periodId: string }>;
  /** Coverage gap + partial-sum messages; empty = pass. */
  findings: string[];
};

/** Spec §5: pure re-labelling/summation of unified row values — no filing lookup. */
export function buildSpineFromUnified(input: { decision: SpineDecision;
  unified: UnifiedStatementsArtifact; spineIds: ReadonlySet<string> }): SpineFromUnifiedResult {
  const { decision, unified, spineIds } = input;
  const rowsById = new Map(unified.rows.map((r) => [r.rowId, r]));
  const unifiedFacts = new Map(unified.facts.map((f) => [`${f.lineItemId}|${f.periodId}`, f]));
  const facts: Fact[] = [];
  const findings: string[] = [];
  const covered = new Set<string>(); // `${targetId}|${periodId}` with a materialized fact

  const materialize = (rowIds: readonly string[], periodId: string, lineItemId: string, factId: string, label: string): Fact | null => {
    const contributing: Array<{ rowId: string; value: number; fact: Fact | undefined }> = [];
    const nullRows: string[] = [];
    for (const rowId of rowIds) {
      const row = rowsById.get(rowId);
      const value = row?.values[periodId] ?? null;
      if (value === null) { nullRows.push(rowId); continue; }
      contributing.push({ rowId, value,
        fact: row ? unifiedFacts.get(`unified.${row.statement}.${rowId}|${periodId}`) : undefined });
    }
    if (contributing.length === 0) return null;
    if (nullRows.length > 0) {
      findings.push(`partial_sum: ${label} in ${periodId} sums only ${contributing.map((c) => c.rowId).join("+")}; null rows: ${nullRows.join(", ")}`);
    }
    const sourceFacts = contributing.map((c) => c.fact).filter((f): f is Fact => f !== undefined);
    const asOfDate = sourceFacts.map((f) => f.provenance.asOfDate).reduce((a, b) => (b > a ? b : a), "");
    return { factId, status: "staged", lineItemId, periodId,
      value: contributing.reduce((acc, c) => acc + c.value, 0),
      unit: sourceFacts[0]?.unit ?? { kind: "number" },
      provenance: { sourceType: "unified_statements", sourceRefs: sourceFacts.map((f) => f.factId),
        asOfDate, concept: rowIds.join("+") } };
  };

  for (const mapping of decision.mappings) {
    for (const periodId of unified.periods) {
      const built = materialize(mapping.rowIds, periodId,
        mapping.targetId, `spine.${mapping.targetId}.${periodId}`, mapping.targetId);
      if (built) { facts.push(built); covered.add(`${mapping.targetId}|${periodId}`); }
    }
  }
  for (const detail of decision.detailRows) {
    for (const periodId of unified.periods) {
      const lineItemId = `detail.${detail.parentTargetId}.${detail.rowId}`;
      const built = materialize([detail.rowId], periodId, lineItemId, `spine.${lineItemId}.${periodId}`, lineItemId);
      if (built) facts.push(built); // supplementary: no coverage-gap tracking
    }
  }

  const gapDeclared = new Set(decision.spineGaps.map((g) => g.targetId));
  const coverageGaps: SpineFromUnifiedResult["coverageGaps"] = [];
  for (const targetId of spineIds) {
    if (gapDeclared.has(targetId)) continue;
    for (const periodId of unified.periods) {
      if (covered.has(`${targetId}|${periodId}`)) continue;
      coverageGaps.push({ targetId, periodId });
      findings.push(`coverage_gap: ${targetId} has no value in ${periodId} and is not declared a spine gap`);
    }
  }
  return { facts, coverageGaps, findings };
}
