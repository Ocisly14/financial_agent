import type { Period, Unit } from "../../financial-model/types.ts";
import type { FilingTable } from "./tableTypes.ts";
import type { FilingTableFactOccurrence } from "./types.ts";
import type { BreakdownRow, UnificationDecision } from "./unifiedStatements.ts";

export type AxisCatalogEntry = {
  axisQName: string;
  axisLabel: string;
  memberCount: number;
  /** 最多 6 个，latest filing 优先。 */
  sampleMemberLabels: string[];
  /** 按 factCount 降序，最多 8 个。 */
  concepts: Array<{ conceptQName: string; conceptLabel: string; factCount: number }>;
  accessions: string[];
  /** 只含 requestedPeriods 中 cls==="actual" 的期。 */
  periodCoverage: string[];
};

export type AxisMemberSeries = {
  memberQName: string; memberLabel: string;
  values: Record<string, number | null>; accessions: string[];
  /** Latest `filedAt` among the occurrences that contributed this member's values. */
  asOfDate: string;
};

export type AxisBreakdown = {
  axisQName: string; conceptQName: string; unit: Unit | null;
  members: AxisMemberSeries[]; truncated: boolean;
  /** Offset of the next page when `truncated`; feed it back as `cursor`. */
  nextCursor?: number;
};

type Occurrence = { fact: FilingTableFactOccurrence; filedAt: string; accession: string };

function collect(tables: readonly FilingTable[]): Occurrence[] {
  return tables.flatMap((table) => table.rows.flatMap((row) => row.cells.flatMap((cell) =>
    cell.fact ? [{ fact: cell.fact, filedAt: table.filedAt, accession: table.accession }] : [])));
}

export function buildAxisCatalog(input: { tables: readonly FilingTable[]; requestedPeriods: readonly Period[] }): AxisCatalogEntry[] {
  const actual = new Set(input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => p.id));
  // 按 filedAt 降序遍历，member 样例与 axisLabel 取 latest 优先
  const occurrences = collect(input.tables).sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  const axes = new Map<string, { label: string; members: Map<string, string>;
    concepts: Map<string, { label: string; count: number }>; accessions: Set<string>; periods: Set<string> }>();
  for (const { fact, accession } of occurrences) {
    if (!actual.has(fact.periodId)) continue;
    for (const dimension of fact.dimensions) {
      const entry = axes.get(dimension.axisQName)
        ?? { label: dimension.axisLabel, members: new Map(), concepts: new Map(), accessions: new Set(), periods: new Set() };
      if (!entry.members.has(dimension.memberQName)) entry.members.set(dimension.memberQName, dimension.memberLabel);
      const concept = entry.concepts.get(fact.conceptQName) ?? { label: fact.conceptLabel, count: 0 };
      concept.count += 1; entry.concepts.set(fact.conceptQName, concept);
      entry.accessions.add(accession); entry.periods.add(fact.periodId);
      axes.set(dimension.axisQName, entry);
    }
  }
  return [...axes].map(([axisQName, e]) => ({ axisQName, axisLabel: e.label,
    memberCount: e.members.size, sampleMemberLabels: [...e.members.values()].slice(0, 6),
    concepts: [...e.concepts].sort((a, b) => b[1].count - a[1].count).slice(0, 8)
      .map(([conceptQName, c]) => ({ conceptQName, conceptLabel: c.label, factCount: c.count })),
    accessions: [...e.accessions].sort(), periodCoverage: [...e.periods].sort() }))
    .sort((a, b) => b.concepts.reduce((s, c) => s + c.factCount, 0) - a.concepts.reduce((s, c) => s + c.factCount, 0));
}

export const MAX_MEMBERS_PER_AXIS = 25;

export function buildAxisBreakdown(input: { tables: readonly FilingTable[]; requestedPeriods: readonly Period[];
  axisQName: string; conceptQName: string; maxMembers?: number;
  /** Case-insensitive substring over member label and QName; for large axes. */
  memberFilter?: string;
  /** 0-based offset into the (filtered) member list; page size stays maxMembers. */
  cursor?: number }): AxisBreakdown {
  const actualIds = input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => p.id).sort();
  const actual = new Set(actualIds);
  const candidates = collect(input.tables).filter(({ fact }) => fact.conceptQName === input.conceptQName
    && actual.has(fact.periodId) && fact.dimensions.some((d) => d.axisQName === input.axisQName));
  // (member, period) 择一：维度最少 → filedAt 最新 → htmlOrder 最小
  candidates.sort((a, b) => a.fact.dimensions.length - b.fact.dimensions.length
    || b.filedAt.localeCompare(a.filedAt) || a.fact.htmlOrder - b.fact.htmlOrder);
  const byMember = new Map<string, { label: string; values: Map<string, number>; accessions: Set<string>;
    order: number; asOfDate: string }>();
  let order = 0;
  for (const { fact, accession, filedAt } of candidates) {
    const dimension = fact.dimensions.find((d) => d.axisQName === input.axisQName)!;
    const member = byMember.get(dimension.memberQName)
      ?? { label: dimension.memberLabel, values: new Map(), accessions: new Set(), order: order++, asOfDate: filedAt };
    if (!member.values.has(fact.periodId)) { member.values.set(fact.periodId, fact.value); member.accessions.add(accession); }
    if (filedAt > member.asOfDate) member.asOfDate = filedAt;
    byMember.set(dimension.memberQName, member);
  }
  const maxMembers = input.maxMembers ?? MAX_MEMBERS_PER_AXIS;
  const needle = input.memberFilter?.trim().toLowerCase();
  const all = [...byMember].sort((a, b) => a[1].order - b[1].order)
    .filter(([memberQName, m]) => !needle
      || memberQName.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle));
  const start = input.cursor ?? 0;
  const end = start + maxMembers;
  return { axisQName: input.axisQName, conceptQName: input.conceptQName,
    unit: candidates[0]?.fact.unit ?? null,
    members: all.slice(start, end).map(([memberQName, m]) => ({ memberQName, memberLabel: m.label,
      values: Object.fromEntries(actualIds.map((id) => [id, m.values.get(id) ?? null])),
      accessions: [...m.accessions].sort(), asOfDate: m.asOfDate })),
    truncated: all.length > end, ...(all.length > end ? { nextCursor: end } : {}) };
}

export const MAX_AXES_PER_ROW = 3;
export const MAX_BREAKDOWN_ROWS = 150;
/** How far a partition may miss its total before it stops counting as one: eliminations and
 *  corporate/other reconciling items routinely cost a few percent, a mixed hierarchy costs ~100%. */
export const BREAKDOWN_PARTITION_TOLERANCE = 0.10;

type DeclaredMember = { memberQName: string; parentMemberQName?: string };

/** Worst per-period deviation of `sum(parts) / whole`, checked only in periods where every value is present. */
function worstDeviation(periodIds: readonly string[], whole: (p: string) => number | null | undefined,
  parts: readonly Record<string, number | null>[]): { periodId: string; ratio: number } | undefined {
  let worst: { periodId: string; ratio: number } | undefined;
  for (const periodId of periodIds) {
    const total = whole(periodId);
    if (total === null || total === undefined || total === 0) continue;
    const values = parts.map((part) => part[periodId]);
    if (values.some((value) => value === null || value === undefined)) continue;
    const ratio = values.reduce<number>((sum, value) => sum + (value as number), 0) / total;
    if (!worst || Math.abs(ratio - 1) > Math.abs(worst.ratio - 1)) worst = { periodId, ratio };
  }
  return worst && Math.abs(worst.ratio - 1) > BREAKDOWN_PARTITION_TOLERANCE ? worst : undefined;
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

const slug = (qname: string, strip: RegExp): string =>
  (qname.split(":").pop() ?? qname).replace(strip, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x";

export function materializeBreakdowns(input: { decision: UnificationDecision;
  tables: readonly FilingTable[]; requestedPeriods: readonly Period[];
  /** Statement-row values (rowId → periodId → value) enabling the partition checks; absent skips them. */
  parentValues?: Record<string, Record<string, number | null>>;
}): { breakdownRows: BreakdownRow[]; findings: string[] } {
  const actualIds = input.requestedPeriods.filter((period) => period.cls === "actual").map((period) => period.id).sort();
  const breakdownRows: BreakdownRow[] = [];
  const findings: string[] = [];
  // The ≤3-axes cap counts declared entries, not distinct axes: a row can legally declare the same
  // axis under two different concepts, which would otherwise mint the same `parent.axis.member` rowId
  // twice. Members can also slug-collide independently (two QNames stripping to the same slug).
  // Either way a duplicate rowId is unusable — the spine agent cannot address either occurrence — so
  // the first writer wins and the rest are dropped with a finding rather than silently overwritten.
  const seenRowIds = new Set<string>();
  for (const row of input.decision.rows) {
    const declared = row.breakdowns ?? [];
    if (declared.length > MAX_AXES_PER_ROW) {
      findings.push(`row "${row.rowId}" declares more than ${MAX_AXES_PER_ROW} axes; keeping the first ${MAX_AXES_PER_ROW}`);
    }
    for (const breakdown of declared.slice(0, MAX_AXES_PER_ROW)) {
      const where = `breakdown "${row.rowId}"/${breakdown.axisQName}`;
      // A declared tree may legitimately reach past the flat page cap: it names its members, so the
      // cap's context-protection job is already done by the declaration itself.
      const resolved = buildAxisBreakdown({ tables: input.tables, requestedPeriods: input.requestedPeriods,
        axisQName: breakdown.axisQName, conceptQName: breakdown.conceptQName,
        maxMembers: breakdown.members ? MAX_BREAKDOWN_ROWS : MAX_MEMBERS_PER_AXIS });
      if (resolved.members.length === 0) {
        findings.push(`breakdown for row "${row.rowId}" found no facts for ${breakdown.axisQName}/${breakdown.conceptQName}`);
        continue;
      }
      // The agent's structural claim, resolved against the store: declared members keep their declared
      // order and parent links; an undeclared tree takes every member, flat.
      let chosen: Array<{ series: AxisMemberSeries; parent?: string }>;
      if (breakdown.members) {
        const seriesByQName = new Map(resolved.members.map((member) => [member.memberQName, member]));
        const declaredQNames = new Set(breakdown.members.map((member) => member.memberQName));
        chosen = [];
        for (const declaredMember of breakdown.members) {
          const series = seriesByQName.get(declaredMember.memberQName);
          if (!series) { findings.push(`${where}: declared member ${declaredMember.memberQName} has no facts`); continue; }
          let parent = declaredMember.parentMemberQName;
          if (parent !== undefined && !declaredQNames.has(parent)) {
            findings.push(`${where}: declared parent ${parent} is not among the declared members; treating ${declaredMember.memberQName} as a root`);
            parent = undefined;
          }
          chosen.push({ series, ...(parent !== undefined ? { parent } : {}) });
        }
      } else {
        chosen = resolved.members.map((series) => ({ series }));
      }
      // Bottom-up partition checks: every node with children must be their sum, and the roots must be
      // the parent row's, each within the tolerance reconciling items are allowed to cost.
      for (const node of chosen) {
        const children = chosen.filter((other) => other.parent === node.series.memberQName);
        if (children.length === 0) continue;
        const worst = worstDeviation(actualIds, (periodId) => node.series.values[periodId], children.map((child) => child.series.values));
        if (worst) findings.push(`${where}: children of ${node.series.memberQName} sum to ${percent(worst.ratio)} of it in ${worst.periodId} (tolerance ±10%)`);
      }
      const parentSeries = input.parentValues?.[row.rowId];
      const roots = chosen.filter((node) => node.parent === undefined);
      if (chosen.length > 0 && roots.length === 0) {
        findings.push(`${where}: the declared member tree has no root — parent links form a cycle`);
      } else if (parentSeries) {
        const worst = worstDeviation(actualIds, (periodId) => parentSeries[periodId], roots.map((root) => root.series.values));
        if (worst) findings.push(breakdown.members
          ? `${where}: root members sum to ${percent(worst.ratio)} of the parent row in ${worst.periodId} (tolerance ±10%)`
          : `${where}: members sum to ${percent(worst.ratio)} of the parent row in ${worst.periodId} (tolerance ±10%) — `
            + `if the axis mixes hierarchy levels, declare "members" with parentMemberQName links`);
      }
      const axisSlug = slug(breakdown.axisQName, /axis$/i);
      for (const { series, parent } of chosen) {
        const rowId = `${row.rowId}.${axisSlug}.${slug(series.memberQName, /member$/i)}`;
        if (seenRowIds.has(rowId)) {
          findings.push(`duplicate breakdown rowId "${rowId}"; keeping the first occurrence`);
          continue;
        }
        seenRowIds.add(rowId);
        breakdownRows.push({ rowId, parentRowId: row.rowId, axisQName: breakdown.axisQName, memberQName: series.memberQName,
          label: series.memberLabel, unit: resolved.unit, values: series.values, rationale: breakdown.rationale,
          ...(parent !== undefined ? { parentMemberQName: parent } : {}), asOfDate: series.asOfDate });
      }
    }
  }
  if (breakdownRows.length > MAX_BREAKDOWN_ROWS) {
    findings.push(`breakdown rows exceed ${MAX_BREAKDOWN_ROWS}; truncated`);
    breakdownRows.length = MAX_BREAKDOWN_ROWS;
  }
  return { breakdownRows, findings };
}
