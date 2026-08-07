import type { Fact, Period, StatementKind, Unit } from "../../financial-model/types.ts";
import type { InventoryRow } from "./conceptInventory.ts";
import { buildSignOrientation } from "./conceptOrientation.ts";
import { dimensionSignature } from "./mergeCuratedTables.ts";
import type { PresentationExtract } from "./types.ts";

/** An older name for the same line. `sign: -1` when that name carried the opposite polarity — an
 *  issuer that renamed "Digital assets gain" to "Digital assets loss (gain)" flipped what positive
 *  means, so the same event appears as +27 under one tag and -27 under the other. */
export type UnifiedAlternateTag = { conceptQName: string; sign?: 1 | -1 };
/**
 * One economic line item of a row. An issuer may have tagged that same item under different concepts
 * over the years; `alsoTaggedAs` lists the superseded names, newest-preferred order. The component is
 * ONE thing regardless of how many names it has: code reads whichever name a period actually carries,
 * so an overlap year — where the old and the new tag are both present, carrying the same number — is
 * read once rather than summed twice.
 */
export type UnifiedComponent = { conceptQName: string; alsoTaggedAs?: UnifiedAlternateTag[];
  dimensionSignature?: string;
  /** Read the rollforward's opening-balance row rather than the closing one. */
  openingBalance?: boolean;
  weight: 1 | -1 };

/** Facts and inventory rows are addressed by concept AND rollforward side; a cash rollforward states
 *  the same concept for its opening and closing balance and they are different numbers. */
export const cellRef = (conceptQName: string, signature: string, openingBalance = false) =>
  `${conceptQName}|${signature}|${openingBalance ? "opening" : ""}`;
/** Replaces the row's shared components in one period. `components: []` means the row has no value that year. */
export type UnifiedRowOverride = { periodId: string; components: UnifiedComponent[]; reason: string };
export type UnifiedRowDecision = { rowId: string; statement: StatementKind; label: string;
  components: UnifiedComponent[]; perYearOverrides?: UnifiedRowOverride[]; rationale: string };
/** A concept carrying no information for the statements — dropped outright, reason on the record. */
export type UnificationExclusion = { conceptQName: string; dimensionSignature?: string;
  openingBalance?: boolean; reason: string };
/** A concept worth keeping but not part of the face-statement structure: code still resolves its
 *  values, into `supplementalRows` rather than `rows`, so downstream can use it without it
 *  distorting the issuer's statement shape. */
export type UnificationSupplemental = { conceptQName: string; dimensionSignature?: string;
  openingBalance?: boolean; label: string; reason: string };
export type UnificationDecision = { rows: UnifiedRowDecision[];
  excluded?: UnificationExclusion[]; supplemental?: UnificationSupplemental[] };

/**
 * A correction to an existing decision. Findings normally touch a handful of rows out of a hundred,
 * and re-emitting the whole decision costs far more to generate than it does to describe the change —
 * so a re-run patches instead. `rows` is patched by rowId because it is the bulk; the held-out lists
 * are small enough to restate wholesale, and omitting one leaves it untouched.
 */
export type UnificationPatch = {
  upsertRows?: UnifiedRowDecision[];
  deleteRowIds?: string[];
  excluded?: UnificationExclusion[];
  supplemental?: UnificationSupplemental[];
};

/** Applies a patch, preserving row order: replaced rows stay put, new ones append. */
export function applyUnificationPatch(base: UnificationDecision, patch: UnificationPatch): UnificationDecision {
  const deleted = new Set(patch.deleteRowIds ?? []);
  const upserts = new Map((patch.upsertRows ?? []).map((row) => [row.rowId, row]));
  const rows = base.rows
    .filter((row) => !deleted.has(row.rowId))
    .map((row) => upserts.get(row.rowId) ?? row);
  const existing = new Set(rows.map((row) => row.rowId));
  for (const row of patch.upsertRows ?? []) if (!existing.has(row.rowId) && !deleted.has(row.rowId)) rows.push(row);
  return {
    rows,
    ...(patch.excluded ?? base.excluded ? { excluded: patch.excluded ?? base.excluded } : {}),
    ...(patch.supplemental ?? base.supplemental ? { supplemental: patch.supplemental ?? base.supplemental } : {}),
  };
}

/** Every concept name this component has answered to, preferred first. `sign` converts a value read
 *  under that name into the component's own polarity, so the primary name is always +1. */
export function componentTags(component: UnifiedComponent): Array<{ conceptQName: string; sign: 1 | -1 }> {
  return [{ conceptQName: component.conceptQName, sign: 1 },
    ...(component.alsoTaggedAs ?? []).map((alt) => ({ conceptQName: alt.conceptQName, sign: alt.sign ?? 1 as 1 | -1 }))];
}

/**
 * The components a row contributes in one period. An override wins outright; otherwise the shared
 * components, filtered to those with at least one tag the inventory carries that period.
 */
export function resolveRowComponents(row: UnifiedRowDecision, periodId: string,
  covered: (component: UnifiedComponent) => boolean): { components: UnifiedComponent[]; override: boolean } {
  const override = row.perYearOverrides?.find((o) => o.periodId === periodId);
  if (override) return { components: override.components, override: true };
  return { components: row.components.filter(covered), override: false };
}

const refOf = (conceptQName: string, signature: string, openingBalance = false) =>
  `${conceptQName}${signature === "" ? "" : `[${signature}]`}${openingBalance ? " (opening balance)" : ""}`;

/** Concepts the decision routes away from the face statements, by `concept|signature`. */
export function heldOutConcepts(decision: UnificationDecision): Map<string, "excluded" | "supplemental"> {
  const heldOut = new Map<string, "excluded" | "supplemental">();
  for (const [kind, entries] of [["excluded", decision.excluded ?? []],
    ["supplemental", decision.supplemental ?? []]] as const) {
    for (const entry of entries) heldOut.set(cellRef(entry.conceptQName, entry.dimensionSignature ?? "", entry.openingBalance), kind);
  }
  return heldOut;
}

/** XBRL values are rounded to `decimals`; two filings agreeing to that precision are the same number. */
export function valueTolerance(reported: number, decimals?: number): number {
  const base = Math.max(1, Math.abs(reported) * 1e-6);
  return decimals === undefined ? base : Math.max(base, 0.5 * 10 ** -decimals);
}

export type RestatementDifference = { conceptQName: string; dimensionSignature: string; periodId: string;
  chosenAccession: string; chosenValue: number;
  candidates: Array<{ accession: string; value: number; contextId: string; sourceAnchor: string }> };

export type UnifiedBackfillFinding = { code: "missing_fact" | "unit_mismatch" | "alternate_tag_disagreement";
  rowId: string; periodId: string; conceptQName: string; message: string };

/** Comparable identity for a unit: currency and per-share amounts differ by their currency code too. */
export function unitKey(unit: Unit): string {
  return "code" in unit ? `${unit.kind}:${unit.code}` : unit.kind;
}

export type UnifiedStatementsArtifact = {
  periods: string[];
  rows: Array<{ rowId: string; statement: StatementKind; label: string; rationale: string;
    values: Record<string, number | null> }>;
  /** Concepts the agent kept but held out of the face statements, with values resolved the same way. */
  supplementalRows: Array<{ conceptQName: string; dimensionSignature: string; statement: StatementKind;
    label: string; reason: string; values: Record<string, number | null> }>;
  /** Concepts deliberately dropped, so a later stage can see the choice instead of a silent gap. */
  excluded: Array<{ conceptQName: string; dimensionSignature: string; reason: string }>;
  facts: Fact[];
  restatements: RestatementDifference[];
  /** `material: false` means the residual is within the materiality ratio — recorded for inspection,
   *  but not raised as a finding and so not worth another agent run. */
  rollupBreaks: Array<{ roleUri: string; parentConcept: string; periodId: string;
    reported: number; computed: number; difference: number; missingChildren: string[]; material: boolean }>;
  findings: string[];
  unresolvedFindings: string[];
};

const SLUG_PATTERN = /^[a-z0-9_]+$/;

/**
 * A roll-up residual this small relative to the reported parent is noise — a presentation detail or a
 * line the issuer restructured between years — not a mapping error the agent could fix by re-running.
 * Breaks below it are still recorded on the artifact; they just stop gating the loop.
 */
export const DEFAULT_ROLLUP_MATERIALITY = 0.01;

/** Lossless coverage in both directions (spec §2): every inventory cell consumed exactly once, every component backed by the inventory. */
export function checkUnificationCompleteness(input: { inventory: readonly InventoryRow[];
  decision: UnificationDecision; requestedPeriods: readonly Period[] }): string[] {
  const findings: string[] = [];
  const requested = new Set(input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => p.id));
  const inventoryByRef = new Map<string, InventoryRow[]>();
  for (const row of input.inventory) {
    const key = cellRef(row.conceptQName, row.dimensionSignature, row.openingBalance);
    const list = inventoryByRef.get(key) ?? [];
    list.push(row);
    inventoryByRef.set(key, list);
  }

  const coveringOf = (conceptQName: string, signature: string, opening: boolean, periodId: string) =>
    (inventoryByRef.get(cellRef(conceptQName, signature, opening)) ?? []).filter((inv) => inv.periodCoverage.includes(periodId));

  // Concepts routed away from the face statements. Both kinds answer `dangling`; only `excluded`
  // forfeits its values, so they stay separate rather than one bucket with a flag.
  const heldOut = heldOutConcepts(input.decision);
  const kindsSeen = new Map<string, Set<string>>();
  for (const [kind, entries] of [["excluded", input.decision.excluded ?? []],
    ["supplemental", input.decision.supplemental ?? []]] as const) {
    for (const entry of entries) {
      const signature = entry.dimensionSignature ?? "";
      const key = cellRef(entry.conceptQName, signature, entry.openingBalance);
      if (!inventoryByRef.has(key)) {
        findings.push(`${kind} ${refOf(entry.conceptQName, signature, entry.openingBalance)} is not in the inventory`);
        continue;
      }
      const kinds = kindsSeen.get(key) ?? new Set<string>();
      kinds.add(kind);
      if (kinds.size > 1) findings.push(`${refOf(entry.conceptQName, signature, entry.openingBalance)} is listed as both excluded and supplemental`);
      kindsSeen.set(key, kinds);
    }
  }

  const seenRowIds = new Set<string>();
  // statement|concept|signature|period -> consuming rowIds.
  const uses = new Map<string, string[]>();
  for (const row of input.decision.rows) {
    if (!SLUG_PATTERN.test(row.rowId)) findings.push(`rowId "${row.rowId}" is not a slug (expected /^[a-z0-9_]+$/)`);
    if (seenRowIds.has(row.rowId)) findings.push(`duplicate rowId "${row.rowId}"`);
    seenRowIds.add(row.rowId);
    for (const override of row.perYearOverrides ?? []) {
      if (!requested.has(override.periodId)) findings.push(`row "${row.rowId}" overrides ${override.periodId}, which is not a requested period`);
    }
    for (const periodId of requested) {
      const coveredTags = (component: UnifiedComponent) => componentTags(component)
        .filter((tag) => coveringOf(tag.conceptQName, component.dimensionSignature ?? "",
          component.openingBalance === true, periodId).length > 0);
      const { components } = resolveRowComponents(row, periodId, (c) => coveredTags(c).length > 0);
      for (const component of components) {
        const signature = component.dimensionSignature ?? "";
        const opening = component.openingBalance === true;
        const tags = coveredTags(component);
        // Unreachable for shared components — they were filtered on coverage — so this is an override
        // naming a concept that period does not carry.
        if (tags.length === 0) {
          findings.push(`row "${row.rowId}" overrides ${periodId} with ${refOf(component.conceptQName, signature, opening)}, which is not in the inventory for that period`);
          continue;
        }
        // One component, but every name it answers to in this period is consumed by it — that is what
        // lets a re-tag overlap satisfy coverage without being counted twice.
        for (const { conceptQName: tag } of tags) {
          const ref = refOf(tag, signature, opening);
          const covering = coveringOf(tag, signature, opening, periodId);
          if (!covering.some((inv) => inv.statement === row.statement)) {
            findings.push(`row "${row.rowId}" is ${row.statement} but the inventory places ${ref} under ${covering[0]!.statement}`);
          }
          const held = heldOut.get(cellRef(tag, signature, opening));
          if (held) findings.push(`row "${row.rowId}" consumes ${ref} in ${periodId}, but it is also listed as ${held}`);
          const useKey = `${row.statement}|${cellRef(tag, signature, opening)}|${periodId}`;
          const list = uses.get(useKey) ?? [];
          list.push(row.rowId);
          uses.set(useKey, list);
        }
      }
    }
  }
  for (const [useKey, rowIds] of uses) {
    if (rowIds.length > 1) findings.push(`double-count: ${useKey} consumed ${rowIds.length} times (rows ${rowIds.join(", ")})`);
  }
  for (const inv of input.inventory) {
    const ref = cellRef(inv.conceptQName, inv.dimensionSignature, inv.openingBalance);
    if (heldOut.has(ref)) continue;
    for (const periodId of inv.periodCoverage) {
      if (!requested.has(periodId)) continue;
      if (!uses.has(`${inv.statement}|${ref}|${periodId}`)) {
        findings.push(`dangling: inventory row ${refOf(inv.conceptQName, inv.dimensionSignature, inv.openingBalance)} (${inv.statement}) is not consumed by any unified row in ${periodId}, and is not listed as excluded or supplemental`);
      }
    }
  }
  return findings;
}

type Candidate = { accession: string; filedAt: string; value: number; unit: Fact["unit"]; decimals?: number | undefined;
  contextId: string; sourceAnchor: string; filingUrl: string };

export function buildUnifiedStatements(input: { decision: UnificationDecision;
  filings: readonly PresentationExtract[]; requestedPeriods: readonly Period[];
  inventory: readonly InventoryRow[];
  /** Share of the reported parent below which a roll-up residual is recorded but not raised. */
  rollupMateriality?: number }): UnifiedStatementsArtifact {
  const periods = input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => p.id).sort();
  const requested = new Set(periods);
  const filings = [...input.filings].sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt));
  const orientation = buildSignOrientation(input.filings);

  // cellRef|period -> candidates, newest filing first. The rollforward side is part of the key: a
  // cash statement carries its opening and closing balance under one concept, and merging them here
  // would let a closing-balance row resolve to the opening number.
  const index = new Map<string, Candidate[]>();
  for (const extraction of filings) {
    for (const stmt of extraction.statements) for (const node of stmt.nodes) for (const payload of node.facts) {
      if (!requested.has(payload.periodId)) continue;
      const key = `${cellRef(node.conceptQName, dimensionSignature(payload.dimensions), node.openingBalance)}|${payload.periodId}`;
      const list = index.get(key) ?? [];
      list.push({ accession: extraction.filing.accession, filedAt: extraction.filing.filedAt, value: payload.value,
        unit: payload.unit, decimals: payload.decimals, contextId: payload.contextId, sourceAnchor: payload.sourceAnchor,
        filingUrl: extraction.filing.primaryDocumentUrl });
      index.set(key, list);
    }
  }
  const normalize = (concept: string, accession: string, value: number) =>
    orientation.flips.get(accession)?.has(concept) ? -value : value;

  const facts: Fact[] = [];
  const restatements: RestatementDifference[] = [];
  const reportedRestatements = new Set<string>();
  const backfillFindings: UnifiedBackfillFinding[] = [];
  const rows: UnifiedStatementsArtifact["rows"] = [];
  // concept -> period -> normalized resolved value; only concepts referenced by the decision (roll-up input).
  const conceptValues = new Map<string, Map<string, { value: number; decimals?: number | undefined }>>();

  const inventoryByRef = new Map<string, InventoryRow[]>();
  for (const inv of input.inventory) {
    const key = cellRef(inv.conceptQName, inv.dimensionSignature, inv.openingBalance);
    inventoryByRef.set(key, [...(inventoryByRef.get(key) ?? []), inv]);
  }
  const heldOut = heldOutConcepts(input.decision);
  const refOfComponent = (component: UnifiedComponent, tag: string) =>
    cellRef(tag, component.dimensionSignature ?? "", component.openingBalance);
  const coveredTags = (component: UnifiedComponent, periodId: string) => componentTags(component)
    .filter((tag) => (inventoryByRef.get(refOfComponent(component, tag.conceptQName)) ?? [])
      .some((inv) => inv.periodCoverage.includes(periodId))
      && !heldOut.has(refOfComponent(component, tag.conceptQName)));

  for (const row of input.decision.rows) {
    const values: Record<string, number | null> = {};
    for (const periodId of periods) {
      const resolved = resolveRowComponents(row, periodId, (c) => coveredTags(c, periodId).length > 0);
      if (resolved.components.length === 0) { values[periodId] = null; continue; }
      let sum = 0;
      let missing = false;
      let anyFlipped = false;
      const chosenComponents: Array<{ concept: string; component: UnifiedComponent; chosen: Candidate }> = [];
      for (const component of resolved.components) {
        const signature = component.dimensionSignature ?? "";
        // The component's own preference order decides which tag is read; the others are the same
        // number under an older name, so reading one of them is reading all of them.
        const tags = resolved.override ? componentTags(component) : coveredTags(component, periodId);
        const read = tags.find((tag) => (index.get(`${refOfComponent(component, tag.conceptQName)}|${periodId}`) ?? []).length > 0);
        if (read === undefined) {
          missing = true;
          backfillFindings.push({ code: "missing_fact", rowId: row.rowId, periodId, conceptQName: component.conceptQName,
            message: `row ${row.rowId} points at ${tags.map((t) => t.conceptQName).join(" / ")} in ${periodId}, but no filing carries that fact` });
          continue;
        }
        const concept = read.conceptQName;
        const key = `${refOfComponent(component, concept)}|${periodId}`;
        const candidates = index.get(key)!;
        const chosen = candidates[0]!;
        const flipped = orientation.flips.get(chosen.accession)?.has(concept) ?? false;
        // `read.sign` carries the value out of the tag's own polarity into the component's.
        const normalized = (flipped ? -chosen.value : chosen.value) * read.sign;
        if (flipped) anyFlipped = true;
        sum += component.weight * normalized;
        chosenComponents.push({ concept, component, chosen });

        // Alternate tags present in the same period must carry the same number once their polarity is
        // accounted for; if they disagree the two names are not the same line after all, and merging
        // them silently would hide it.
        for (const other of tags) {
          if (other.conceptQName === concept) continue;
          const alt = index.get(`${refOfComponent(component, other.conceptQName)}|${periodId}`)?.[0];
          if (!alt) continue;
          const altNormalized = normalize(other.conceptQName, alt.accession, alt.value) * other.sign;
          if (Math.abs(altNormalized - normalized) > valueTolerance(normalized, chosen.decimals)) {
            backfillFindings.push({ code: "alternate_tag_disagreement", rowId: row.rowId, periodId, conceptQName: other.conceptQName,
              message: `row ${row.rowId} treats ${other.conceptQName} as an alternate tag of ${concept} in ${periodId}, but they report ${altNormalized} vs ${normalized}` });
          }
        }

        // Register the value under every name this component answers to, each in that name's own
        // polarity. A calculation relation from the newest filing names the newest tag, but an early
        // period resolves to the superseded one; keying only by the tag actually read would make the
        // child look absent and break the roll-up.
        for (const tag of componentTags(component)) {
          const byPeriod = conceptValues.get(tag.conceptQName) ?? new Map<string, { value: number; decimals?: number | undefined }>();
          if (!byPeriod.has(periodId)) {
            byPeriod.set(periodId, { value: normalized * tag.sign, ...(chosen.decimals === undefined ? {} : { decimals: chosen.decimals }) });
          }
          conceptValues.set(tag.conceptQName, byPeriod);
        }

        if (!reportedRestatements.has(key)) {
          const normalizedCandidates = candidates.map((c) =>
            ({ accession: c.accession, value: normalize(concept, c.accession, c.value),
              contextId: c.contextId, sourceAnchor: c.sourceAnchor }));
          if (normalizedCandidates.some((c) => Math.abs(c.value - normalized) > valueTolerance(normalized, chosen.decimals))) {
            reportedRestatements.add(key);
            restatements.push({ conceptQName: concept, dimensionSignature: signature, periodId,
              chosenAccession: chosen.accession, chosenValue: normalized, candidates: normalizedCandidates });
          }
        }
      }
      if (missing) { values[periodId] = null; continue; }
      // Currency, share counts and per-share amounts all coexist in a face statement. Adding across
      // them yields a number with no meaning, and the fact would carry whichever unit came first.
      const units = new Set(chosenComponents.map((c) => unitKey(c.chosen.unit)));
      if (units.size > 1) {
        backfillFindings.push({ code: "unit_mismatch", rowId: row.rowId, periodId,
          conceptQName: chosenComponents[0]!.concept,
          message: `row ${row.rowId} sums components with different units in ${periodId} (${[...units].join(", ")}); refusing to add them` });
        values[periodId] = null;
        continue;
      }
      values[periodId] = sum;
      const newest = chosenComponents.reduce((a, b) => (b.chosen.filedAt > a.chosen.filedAt ? b : a));
      const decimalsList = chosenComponents.map((c) => c.chosen.decimals).filter((d): d is number => d !== undefined);
      facts.push({ factId: `unified.${row.statement}.${row.rowId}.${periodId}`, status: "staged",
        lineItemId: `unified.${row.statement}.${row.rowId}`, periodId, value: sum, unit: chosenComponents[0]!.chosen.unit,
        provenance: { sourceType: "xbrl_presentation",
          sourceRefs: chosenComponents.map((c) => c.chosen.sourceAnchor),
          asOfDate: newest.chosen.filedAt, accession: newest.chosen.accession,
          concept: chosenComponents.map((c) => c.concept).join("+"),
          filingUrl: newest.chosen.filingUrl,
          ...(decimalsList.length === 0 ? {} : { decimals: Math.min(...decimalsList) }),
          ...(anyFlipped ? { signFlipped: true } : {}) } });
    }
    rows.push({ rowId: row.rowId, statement: row.statement, label: row.label, rationale: row.rationale, values });
  }

  // Held-out concepts: values resolved exactly like a single-component row, but kept out of `rows`
  // so the issuer's statement shape stays what the agent declared it to be.
  const supplementalRows: UnifiedStatementsArtifact["supplementalRows"] = [];
  for (const entry of input.decision.supplemental ?? []) {
    const signature = entry.dimensionSignature ?? "";
    const inv = inventoryByRef.get(cellRef(entry.conceptQName, signature, entry.openingBalance))?.[0];
    if (!inv) continue;
    const values: Record<string, number | null> = {};
    for (const periodId of periods) {
      const chosen = index.get(`${cellRef(entry.conceptQName, signature, entry.openingBalance)}|${periodId}`)?.[0];
      if (!chosen) { values[periodId] = null; continue; }
      const normalized = normalize(entry.conceptQName, chosen.accession, chosen.value);
      values[periodId] = normalized;
      const byPeriod = conceptValues.get(entry.conceptQName) ?? new Map<string, { value: number; decimals?: number | undefined }>();
      if (!byPeriod.has(periodId)) byPeriod.set(periodId, { value: normalized, ...(chosen.decimals === undefined ? {} : { decimals: chosen.decimals }) });
      conceptValues.set(entry.conceptQName, byPeriod);
    }
    supplementalRows.push({ conceptQName: entry.conceptQName, dimensionSignature: signature,
      statement: inv.statement, label: entry.label, reason: entry.reason, values });
  }

  // A dimensional breakdown is the pieces of the dimensionless total, not extra lines beside it —
  // XBRL US DQC_0117 checks exactly this. Consuming both the total and its members double-counts the
  // money, and nothing else in this file would notice: each is a legitimate inventory cell.
  // Currency is assumed, never verified, upstream: `reportingCurrency` defaults to USD. A foreign
  // private issuer, or a filer tagging a second currency, would otherwise be summed as if one.
  const currencies = new Set<string>();
  for (const fact of facts) if (fact.unit.kind === "currency") currencies.add(fact.unit.code);
  const currencyFindings = currencies.size > 1
    ? [`mixed reporting currencies across the unified statements: ${[...currencies].sort().join(", ")}`] : [];

  // Deliberately no within-series sign check. A line whose sign changes across years is normally a
  // real event (a tax benefit year, a restructuring credit, a loss attributable to minority holders),
  // and the tagging errors it was meant to catch are already covered: orientation normalizes
  // conventions, restatement detection compares the same cell across filings, an alternate tag whose
  // polarity disagrees is reported, and a wrong sign breaks its roll-up equation.

  const dimensionalBreaks: string[] = [];
  const consumedCells = new Set<string>();
  for (const row of input.decision.rows) for (const component of row.components) {
    for (const tag of componentTags(component)) {
      consumedCells.add(cellRef(tag.conceptQName, component.dimensionSignature ?? "", component.openingBalance));
    }
  }
  const membersByConcept = new Map<string, InventoryRow[]>();
  for (const inv of input.inventory) {
    if (inv.dimensionSignature === "") continue;
    membersByConcept.set(inv.conceptQName, [...(membersByConcept.get(inv.conceptQName) ?? []), inv]);
  }
  for (const [conceptQName, members] of membersByConcept) {
    const totalRef = cellRef(conceptQName, "", false);
    if (!consumedCells.has(totalRef)) continue;
    const consumedMembers = members.filter((m) => consumedCells.has(cellRef(m.conceptQName, m.dimensionSignature, m.openingBalance)));
    if (consumedMembers.length === 0) continue;
    dimensionalBreaks.push(`double-count risk: ${conceptQName} is consumed both as the dimensionless total and as ${consumedMembers.length} dimensional member(s) (${consumedMembers.map((m) => m.dimensionSignature).join("; ")}); the members are the pieces of that total`);
  }

  // Roll-up verification, per filing rather than once over the newest one. A period's value comes
  // from the newest filing that still reports it, so its calculation structure has to come from that
  // same filing: an issuer that restructures its statements drops lines the older years genuinely
  // had, and checking FY2021 against the FY2025 structure reports the vanished lines as a break.
  // (Tesla's FY2021 current liabilities are short by exactly its "Customer deposits" line, which was
  // separate in FY2021-22 and later folded into accrued liabilities.)
  // Within a filing, only the roles its face statements came from: a filing also carries calc
  // relations for footnote details (EPS computation, segment tables, lease maturities) that decompose
  // the same parents differently, and those would break every time.
  const rollupBreaks: UnifiedStatementsArtifact["rollupBreaks"] = [];
  const materiality = input.rollupMateriality ?? DEFAULT_ROLLUP_MATERIALITY;
  // The values verified are the orientation-normalized ones — the ones the unified statements
  // actually carry, and the only ones that are comparable at all: an older filing can tag a repayment
  // negative AND weight it -1, so its own raw figures do not satisfy its own equation.
  //
  // The STRUCTURE, though, must come from a filing that really reported that period. A role URI is
  // stable across years while its children are not: Tesla's cash flow role lists ten children in the
  // FY2023 10-K and five in the FY2025 one as digital-asset and solar lines come and go, so checking
  // FY2021 against the FY2025 structure reports the vanished lines as a break. Authority is per
  // statement, not per filing, because the statements of one filing reach back different distances —
  // and a rollforward's opening balance does not count as reporting a period, or the filing that
  // merely carries FY2021's closing cash would be treated as an FY2021 source.
  // "Reports the period" has to mean a comparative column, not a stray fact. A closing-balance node
  // dated at a year end doubles as the next year's opening instant, so the FY2024 10-K carries one
  // FY2021 cash fact and would otherwise pass for an FY2021 source. A real comparative column fills
  // most of the statement's lines, so the bar is set against the statement's own best-covered period.
  const reportsPeriod = (stmt: PresentationExtract["statements"][number], periodId: string) => {
    const counts = new Map<string, number>();
    for (const node of stmt.nodes) {
      if (node.openingBalance === true) continue;
      for (const f of node.facts) if (f.dimensions.length === 0) counts.set(f.periodId, (counts.get(f.periodId) ?? 0) + 1);
    }
    const fullColumn = Math.max(0, ...counts.values());
    return (counts.get(periodId) ?? 0) * 2 >= fullColumn;
  };
  const authority = new Map<string, string>();
  for (const extraction of filings) {
    for (const stmt of extraction.statements) for (const periodId of periods) {
      const key = `${stmt.statement}|${periodId}`;
      if (!authority.has(key) && reportsPeriod(stmt, periodId)) authority.set(key, extraction.filing.accession);
    }
  }

  for (const extraction of filings) {
    const statementOfRole = new Map(extraction.statements.map((s) => [s.roleUri, s.statement]));
    for (const relation of extraction.calculationRelations) {
      const statement = statementOfRole.get(relation.roleUri);
      if (statement === undefined) continue; // a footnote role decomposes the same parent differently
      for (const periodId of periods) {
        if (authority.get(`${statement}|${periodId}`) !== extraction.filing.accession) continue;
        const parent = conceptValues.get(relation.parentConcept)?.get(periodId);
        if (parent === undefined) continue;
        const present = relation.children.filter((child) => conceptValues.get(child.concept)?.has(periodId));
        if (present.length === 0) continue;
        const computed = present.reduce((acc, child) => acc + child.weight * conceptValues.get(child.concept)!.get(periodId)!.value, 0);
        const difference = parent.value - computed;
        if (Math.abs(difference) <= valueTolerance(parent.value, parent.decimals)) continue;
        rollupBreaks.push({ roleUri: relation.roleUri, parentConcept: relation.parentConcept, periodId,
          reported: parent.value, computed, difference,
          missingChildren: relation.children.filter((c) => !conceptValues.get(c.concept)?.has(periodId)).map((c) => c.concept),
          material: Math.abs(difference) > Math.abs(parent.value) * materiality });
      }
    }
  }

  const findings = [
    ...backfillFindings.map((f) => f.message),
    ...currencyFindings,
    ...dimensionalBreaks,
    ...rollupBreaks.filter((b) => b.material).map((b) => `roll-up break: ${b.parentConcept} in ${b.periodId} reports ${b.reported} but children compute ${b.computed} (diff ${b.difference}); absent children: ${b.missingChildren.join(", ") || "none"}`),
  ];
  const excluded = (input.decision.excluded ?? []).map((e) =>
    ({ conceptQName: e.conceptQName, dimensionSignature: e.dimensionSignature ?? "", reason: e.reason }));
  return { periods, rows, supplementalRows, excluded, facts, restatements, rollupBreaks, findings, unresolvedFindings: [] };
}
