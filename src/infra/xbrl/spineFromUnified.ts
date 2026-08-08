import type { Fact, StatementKind, Unit } from "../../financial-model/types.ts";
import type { UnifiedStatementsArtifact } from "./unifiedStatements.ts";

export type SpineDecision = {
  mappings: Array<{ targetId: string; rowIds: string[]; rationale: string }>;
  detailRows: Array<{ parentTargetId: string; rowId: string; rationale: string }>;
  excluded: Array<{ rowId: string; reason: string }>;
  spineGaps: Array<{ targetId: string; reason: string }>;
  /** The agent's prose account of the mapping. Not consumed here; reported to the DCF orchestrator. */
  notes?: string;
};

/**
 * A correction to an existing spine decision. Findings touch a few targets out of fifty, and stating
 * the change is far cheaper to generate than restating the whole mapping. Lists are patched by their
 * natural key — targetId, or rowId for the row-scoped ones — and anything not mentioned is kept.
 */
export type SpinePatch = {
  upsertMappings?: SpineDecision["mappings"];
  deleteMappingTargetIds?: string[];
  upsertDetailRows?: SpineDecision["detailRows"];
  deleteDetailRowIds?: string[];
  upsertExcluded?: SpineDecision["excluded"];
  deleteExcludedRowIds?: string[];
  upsertSpineGaps?: SpineDecision["spineGaps"];
  deleteSpineGapTargetIds?: string[];
  /** Replaces the notes wholesale: a corrected decision needs a corrected account of itself. */
  notes?: string;
};

function patchList<T>(base: readonly T[], upserts: readonly T[] | undefined,
  deletes: readonly string[] | undefined, key: (item: T) => string): T[] {
  const deleted = new Set(deletes ?? []);
  const byKey = new Map((upserts ?? []).map((item) => [key(item), item]));
  const kept = base.filter((item) => !deleted.has(key(item))).map((item) => byKey.get(key(item)) ?? item);
  const present = new Set(kept.map(key));
  for (const item of upserts ?? []) if (!present.has(key(item)) && !deleted.has(key(item))) kept.push(item);
  return kept;
}

/** Applies a patch, preserving order: replaced entries stay put, new ones append. */
export function applySpinePatch(base: SpineDecision, patch: SpinePatch): SpineDecision {
  return {
    mappings: patchList(base.mappings, patch.upsertMappings, patch.deleteMappingTargetIds, (m) => m.targetId),
    detailRows: patchList(base.detailRows, patch.upsertDetailRows, patch.deleteDetailRowIds, (d) => d.rowId),
    excluded: patchList(base.excluded, patch.upsertExcluded, patch.deleteExcludedRowIds, (e) => e.rowId),
    spineGaps: patchList(base.spineGaps, patch.upsertSpineGaps, patch.deleteSpineGapTargetIds, (g) => g.targetId),
    ...(patch.notes === undefined ? (base.notes === undefined ? {} : { notes: base.notes }) : { notes: patch.notes }),
  };
}

/** Spec §4: every unified row in exactly one of mappings/excluded (detailRows are additive);
 * every REQUIRED spine id mapped XOR gap-declared; no unknown rowIds or targetIds.
 * Optional targets need no declaration either way — demanding a written reason for a line the model
 * never reads spends the agent's attention on ceremony. */
export function checkSpineCompleteness(input: { unified: UnifiedStatementsArtifact;
  decision: SpineDecision; spineIds: ReadonlySet<string>; requiredIds?: ReadonlySet<string> }): string[] {
  const findings: string[] = [];
  const { decision, spineIds } = input;
  const unifiedRowIds = new Set(input.unified.rows.map((r) => r.rowId));
  const breakdownRows = input.unified.breakdownRows ?? [];
  const breakdownRowIds = new Set(breakdownRows.map((r) => r.rowId));
  const knownRows = new Set([...unifiedRowIds, ...breakdownRowIds]);
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
      // A breakdown row's total is already supplied by its parent's dimensionless fact — mapping the
      // slice too would count the same money twice.
      if (breakdownRowIds.has(rowId)) {
        findings.push(`breakdown row "${rowId}" may only be used as a detailRow, never in a spine mapping`);
      }
    }
  }
  for (const exclusion of decision.excluded) {
    requireKnownRow(exclusion.rowId, "excluded");
    place(exclusion.rowId, "excluded");
  }
  const breakdownById = new Map(breakdownRows.map((r) => [r.rowId, r]));
  // Every revenue-ish parent collapses onto the single `revenue` node at materialization time
  // (detailLineItemId below), so the single-axis guard must group them the same way — otherwise
  // "revenue" and "revenue.total" each pass their own check while jointly violating it.
  const revenueAxes = new Set<string>();
  const revenueBreakdowns: Array<(typeof breakdownRows)[number]> = [];
  for (const detail of decision.detailRows) {
    if (!spineIds.has(detail.parentTargetId)) findings.push(`detail row "${detail.rowId}" has unknown parentTargetId "${detail.parentTargetId}"`);
    requireKnownRow(detail.rowId, `detail row under "${detail.parentTargetId}"`);
    // Revenue detail rows become summable streams; two axes at once would double-count. Detail rows
    // under any other parent are pure supplements, so mixed axes there are fine.
    const isRevenue = detail.parentTargetId === "revenue" || detail.parentTargetId.startsWith("revenue.");
    const breakdown = breakdownById.get(detail.rowId);
    if (isRevenue && breakdown) { revenueAxes.add(breakdown.axisQName); revenueBreakdowns.push(breakdown); }
  }
  if (revenueAxes.size > 1) {
    findings.push(`revenue streams must come from a single axis; found ${[...revenueAxes].sort().join(" and ")}`);
  }
  // Within the one axis, the agent-declared member tree still allows nesting: an aggregate and its
  // own pieces chosen together sum the same money twice, so streams must be an antichain of the tree.
  const memberByQName = new Map(breakdownRows.map((r) => [`${r.parentRowId}|${r.axisQName}|${r.memberQName}`, r]));
  const ancestors = (row: (typeof breakdownRows)[number]): Set<string> => {
    const seen = new Set<string>();
    let parent = row.parentMemberQName;
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent);
      parent = memberByQName.get(`${row.parentRowId}|${row.axisQName}|${parent}`)?.parentMemberQName;
    }
    return seen;
  };
  const chosenMembers = new Set(revenueBreakdowns.map((r) => r.memberQName));
  for (const row of revenueBreakdowns) {
    for (const ancestor of ancestors(row)) {
      if (chosenMembers.has(ancestor)) {
        findings.push(`revenue streams must not nest: ${ancestor} already contains ${row.memberQName}`);
      }
    }
  }
  for (const rowId of unifiedRowIds) {
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
  const required = input.requiredIds ?? spineIds;
  for (const targetId of spineIds) {
    const isMapped = mapped.has(targetId);
    const isGap = gapDeclared.has(targetId);
    if (isMapped && isGap) findings.push(`spine id "${targetId}" is both mapped and declared a gap`);
    if (!isMapped && !isGap && required.has(targetId)) {
      findings.push(`required spine id "${targetId}" is neither mapped nor declared a gap`);
    }
  }
  return findings;
}

/**
 * Line item id for a supplementary detail row.
 *
 * The workbook installs these as real line items, so the id has to be one the skeleton accepts:
 * `<parent>.<slug>` with a lower-snake slug. Every revenue target hangs off the single `revenue`
 * parent — `revenue.total`'s children are revenue streams, not children of a `revenue.total` node —
 * so revenue details collapse to `revenue.<slug>`; everything else keeps its own parent target.
 */
export function detailLineItemId(parentTargetId: string, rowId: string): string {
  const parent = parentTargetId === "revenue" || parentTargetId.startsWith("revenue.") ? "revenue" : parentTargetId;
  const slug = rowId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "d$1");
  return `${parent}.${slug || "detail"}`;
}

export type SpineFromUnifiedResult = {
  facts: Fact[];
  coverageGaps: Array<{ targetId: string; periodId: string }>;
  /** Coverage gap + partial-sum messages; empty = pass. */
  findings: string[];
};

/** Spec §5: pure re-labelling/summation of unified row values — no filing lookup. */
export function buildSpineFromUnified(input: { decision: SpineDecision;
  unified: UnifiedStatementsArtifact; spineIds: ReadonlySet<string>;
  requiredIds?: ReadonlySet<string> }): SpineFromUnifiedResult {
  const { decision, unified, spineIds } = input;
  const required = input.requiredIds ?? spineIds;
  type SpineRow = { statement?: StatementKind; unit?: Unit | null; values: Record<string, number | null>; asOfDate?: string };
  const rowsById = new Map<string, SpineRow>(unified.rows.map((r) => [r.rowId, r]));
  const breakdownRowIds = new Set((unified.breakdownRows ?? []).map((r) => r.rowId));
  for (const row of unified.breakdownRows ?? []) {
    // Breakdown rows have no home statement — they never went through step ③'s fact provenance —
    // so `materialize` below must skip the unified-fact lookup for them, and fall back to the row's
    // own `asOfDate` (there is no source fact to draw one from).
    rowsById.set(row.rowId, { unit: row.unit, values: row.values, asOfDate: row.asOfDate });
  }
  const unifiedFacts = new Map(unified.facts.map((f) => [`${f.lineItemId}|${f.periodId}`, f]));
  const facts: Fact[] = [];
  const findings: string[] = [];
  const covered = new Set<string>(); // `${targetId}|${periodId}` with a materialized fact

  const materialize = (rowIds: readonly string[], periodId: string, lineItemId: string, factId: string): Fact | null => {
    const contributing: Array<{ rowId: string; value: number; fact: Fact | undefined;
      unit: Unit | null | undefined; asOfDate: string | undefined }> = [];
    const nullRows: string[] = [];
    for (const rowId of rowIds) {
      const row = rowsById.get(rowId);
      const value = row?.values[periodId] ?? null;
      if (value === null) { nullRows.push(rowId); continue; }
      contributing.push({ rowId, value,
        fact: row?.statement ? unifiedFacts.get(`unified.${row.statement}.${rowId}|${periodId}`) : undefined,
        unit: row?.unit, asOfDate: row?.asOfDate });
    }
    if (contributing.length === 0) return null;
    // A null contributing row is a line the issuer stopped reporting, not a resolution failure —
    // step 2 already raises a finding for anything it could not resolve, so what is still null here
    // is structurally absent. Its figure has normally been folded into a sibling line, which means
    // the shorter sum is the comparable one; warning about it every year is noise.
    const sourceFacts = contributing.map((c) => c.fact).filter((f): f is Fact => f !== undefined);
    const rowUnit = contributing.find((c) => c.unit)?.unit;
    // Prefer the latest of the contributing unified facts' own provenance; a breakdown row has none,
    // so fall back to its own asOfDate (the winning occurrence's filedAt) — never the empty string.
    const asOfDate = [...sourceFacts.map((f) => f.provenance.asOfDate),
      ...contributing.map((c) => c.asOfDate).filter((d): d is string => d !== undefined)]
      .reduce((a, b) => (b > a ? b : a), "");
    return { factId, status: "staged", lineItemId, periodId,
      value: contributing.reduce((acc, c) => acc + c.value, 0),
      unit: sourceFacts[0]?.unit ?? rowUnit ?? { kind: "number" },
      provenance: { sourceType: "unified_statements", sourceRefs: sourceFacts.map((f) => f.factId),
        asOfDate, concept: rowIds.join("+") } };
  };

  for (const mapping of decision.mappings) {
    // A breakdown row's total is already inside its parent's dimensionless fact — summing it into
    // the mapping too would double-count. checkSpineCompleteness raises a finding for this, but a
    // dirty decision still ships after maxRuns, so the exclusion has to be mechanical here as well.
    const rowIds = mapping.rowIds.filter((rowId) => !breakdownRowIds.has(rowId));
    for (const periodId of unified.periods) {
      const built = materialize(rowIds, periodId,
        mapping.targetId, `spine.${mapping.targetId}.${periodId}`);
      if (built) { facts.push(built); covered.add(`${mapping.targetId}|${periodId}`); }
    }
  }
  for (const detail of decision.detailRows) {
    for (const periodId of unified.periods) {
      const lineItemId = detailLineItemId(detail.parentTargetId, detail.rowId);
      const built = materialize([detail.rowId], periodId, lineItemId, `spine.${lineItemId}.${periodId}`);
      if (built) facts.push(built); // supplementary: no coverage-gap tracking
    }
  }

  // A gap is a target the decision claims but cannot fill in some year. An optional target nobody
  // mapped is not a gap — it is simply unused, and listing every period of every unused target buries
  // the few real ones.
  const gapDeclared = new Set(decision.spineGaps.map((g) => g.targetId));
  const claimed = new Set(decision.mappings.map((m) => m.targetId));
  const coverageGaps: SpineFromUnifiedResult["coverageGaps"] = [];
  for (const targetId of spineIds) {
    if (gapDeclared.has(targetId)) continue;
    if (!claimed.has(targetId) && !required.has(targetId)) continue;
    for (const periodId of unified.periods) {
      if (covered.has(`${targetId}|${periodId}`)) continue;
      coverageGaps.push({ targetId, periodId });
      // Only a required target's absence is worth an agent round: the rest are not read by any
      // formula or identity, so a missing year costs the model nothing.
      if (required.has(targetId)) {
        findings.push(`coverage_gap: required ${targetId} has no value in ${periodId} and is not declared a spine gap`);
      }
    }
  }
  return { facts, coverageGaps, findings };
}
