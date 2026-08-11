import { createHash } from "node:crypto";
import type { Fact, Period, PreparedStatementRow, StatementKind, Unit } from "../../financial-model/types.ts";
import type { FilingTable, TableCuration } from "./tableTypes.ts";
import type {
  DimensionalDisclosureView,
  FilingIdentity,
  FilingPresentationView,
  FilingTableFactOccurrence,
  PreparedFilingStatements,
  PreparedStatementRowView,
  StatementCoverageView,
  XbrlDimension,
} from "./types.ts";

const STATEMENTS: readonly StatementKind[] = ["income_statement", "balance_sheet", "cash_flow_statement"];

export type MergeCuratedTablesInput = {
  requestedPeriods: readonly Period[];
  filings: readonly FilingIdentity[];
  tables: readonly FilingTable[];
  curations: readonly TableCuration[];
  /** Concepts whose presentation `preferredLabel` is a negated role. Omit to leave `negated` off the rows entirely. */
  negatedConcepts?: readonly string[];
  diagnostics?: readonly string[];
};

export class IncompleteFinancialStatementsError extends Error {
  readonly code = "incomplete_financial_statements";
  readonly missingStatements: StatementKind[];
  readonly attemptedAccessions: string[];
  readonly diagnostics: string[];

  constructor(missingStatements: StatementKind[], filings: readonly FilingIdentity[], diagnostics: string[]) {
    super(`Missing or unusable curated face tables: ${missingStatements.join(", ")}`);
    this.name = "IncompleteFinancialStatementsError";
    this.missingStatements = missingStatements;
    this.attemptedAccessions = filings.map((filing) => filing.accession);
    this.diagnostics = diagnostics;
  }
}

/** Copied rather than imported from `mergeFilings.ts`, which this module retires. */
export function dimensionSignature(dimensions: readonly XbrlDimension[]): string {
  return [...dimensions]
    .map((dimension) => `${dimension.axisQName}=${dimension.memberQName}:${dimension.typedMemberValue ?? ""}`)
    .sort(compareText)
    .join("|");
}

/**
 * Lowercase, strip punctuation, collapse whitespace. Issuers re-punctuate and
 * re-capitalize statement captions between filings; a cosmetic edit must not
 * fork the line item identity.
 */
export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/**
 * A curated row is a table row, not a concept: across filings the same row can
 * carry different concepts when the issuer re-tags, so identity is the
 * normalized label plus the dimension signature.
 */
function sourceId(statement: StatementKind, normalizedLabel: string, signature: string): string {
  const readable = normalizedLabel.replace(/ /g, "_").slice(0, 72) || "row";
  const suffix = createHash("sha256").update(`${statement}|${normalizedLabel}|${signature}`).digest("hex").slice(0, 12);
  return `source.${statement}.${readable}.${suffix}`;
}

function unitKey(unit: Unit): string {
  return JSON.stringify(unit);
}

/** One filing's curated contribution to one statement: its face tables, each followed by its continuations. */
type CuratedGroup = { accession: string; filedAt: string; tables: FilingTable[] };

function curatedGroups(
  statement: StatementKind,
  input: MergeCuratedTablesInput,
  byId: Map<string, FilingTable>,
): CuratedGroup[] {
  const groups = new Map<string, CuratedGroup>();
  const faces = input.curations
    .filter((curation) => curation.kind === "face" && curation.statement === statement)
    .flatMap((curation) => { const table = byId.get(curation.sourceTableId); return table ? [table] : []; })
    .sort((left, right) => left.htmlOrder - right.htmlOrder || compareText(left.sourceTableId, right.sourceTableId));

  for (const face of faces) {
    const continuations = input.curations
      .filter((curation) => curation.kind === "continuation" && curation.statement === statement
        && curation.relatedTableId === face.sourceTableId)
      .flatMap((curation) => { const table = byId.get(curation.sourceTableId); return table ? [table] : []; })
      .sort((left, right) => left.htmlOrder - right.htmlOrder || compareText(left.sourceTableId, right.sourceTableId));
    const group = groups.get(face.accession) ?? { accession: face.accession, filedAt: face.filedAt, tables: [] };
    group.tables.push(face, ...continuations);
    groups.set(face.accession, group);
  }

  return [...groups.values()].sort((left, right) =>
    right.filedAt.localeCompare(left.filedAt) || right.accession.localeCompare(left.accession));
}

/**
 * Cells of one row bucketed by dimensions and unit, in cell order. A single
 * balance-sheet caption can contain a per-share par value, share counts, and a
 * currency balance; treating those as one source row creates invalid facts.
 */
function factBuckets(cells: FilingTable["rows"][number]["cells"], keep: (fact: FilingTableFactOccurrence) => boolean) {
  const buckets = new Map<string, FilingTableFactOccurrence[]>();
  for (const cell of cells) {
    if (!cell.fact || !keep(cell.fact)) continue;
    const signature = `${dimensionSignature(cell.fact.dimensions)}\u001f${unitKey(cell.fact.unit)}`;
    const bucket = buckets.get(signature) ?? [];
    bucket.push(cell.fact);
    buckets.set(signature, bucket);
  }
  return buckets;
}

export function mergeCuratedTables(input: MergeCuratedTablesInput): PreparedFilingStatements {
  const byId = new Map(input.tables.map((table) => [table.sourceTableId, table]));
  const diagnostics = [...(input.diagnostics ?? [])];
  const groupsByStatement = new Map(STATEMENTS.map((statement) => [statement, curatedGroups(statement, input, byId)]));
  const usable = (table: FilingTable) => table.rows.some((row) => row.cells.some((cell) => cell.fact && Number.isFinite(cell.fact.value)));
  const missing = STATEMENTS.filter((statement) => !groupsByStatement.get(statement)!.some((group) => group.tables.some(usable)));
  if (missing.length > 0) throw new IncompleteFinancialStatementsError(missing, input.filings, diagnostics);

  const filingByAccession = new Map(input.filings.map((filing) => [filing.accession, filing]));
  const requestedIds = input.requestedPeriods.filter((period) => period.cls === "actual").map((period) => period.id);
  const requested = new Set(requestedIds);
  const negatedConcepts = input.negatedConcepts === undefined ? undefined : new Set(input.negatedConcepts);

  const rows: PreparedStatementRow[] = [];
  const rowViews: PreparedStatementRowView[] = [];
  const facts: Fact[] = [];
  const dimensions: DimensionalDisclosureView[] = [];
  const conflicts: StatementCoverageView["issues"] = [];
  const rowById = new Map<string, PreparedStatementRowView>();
  const staged = new Set<string>();

  for (const statement of STATEMENTS) {
    // Precedence is by statement and period, not by row: mixing a restated
    // period's rows with the original filing's would silently blend two
    // presentations of the same year.
    const claimed = new Set<string>();
    for (const group of groupsByStatement.get(statement)!) {
      // What a filing *reports* is what its columns declare. A cash-flow
      // rollforward's "beginning of period" instant is dated the year before
      // the earliest duration column, so its fact lands outside that window;
      // letting it claim the period would lock every older filing out of a
      // year this one never actually presented.
      const declared = new Set(group.tables.flatMap((table) =>
        table.columns.flatMap((column) => column.periodId === undefined ? [] : [column.periodId])));
      const contributed = new Set<string>();
      for (const table of group.tables) {
        const columnPeriods = new Map(table.columns.flatMap((column) =>
          column.periodId === undefined ? [] : [[column.index, column.periodId] as const]));
        const ancestry: Array<{ indentLevel: number; sourceLineItemId: string }> = [];
        for (const row of [...table.rows].sort((left, right) => left.order - right.order)) {
          for (const cell of row.cells) {
            const columnPeriodId = columnPeriods.get(cell.columnIndex);
            if (!cell.fact || columnPeriodId === undefined || cell.fact.periodId === columnPeriodId) continue;
            conflicts.push({ code: "incompatible_context", severity: "review_required", statement,
              periodIds: [columnPeriodId, cell.fact.periodId].sort(compareText), sourceRefs: [table.sourceTableId] });
          }
          while (ancestry.length > 0 && ancestry.at(-1)!.indentLevel >= row.indentLevel) ancestry.pop();
          const normalized = normalizeLabel(row.labelText);
          let rowIdentity: string | undefined;
          for (const [_bucket, occurrences] of factBuckets(row.cells, (fact) =>
            requested.has(fact.periodId) && Number.isFinite(fact.value))) {
            const signature = dimensionSignature(occurrences[0]!.dimensions);
            const identitySignature = `${signature}|unit=${unitKey(occurrences[0]!.unit)}`;
            for (const fact of occurrences) recordDisclosure(dimensions, table, row.labelText, signature, fact);
            const sourceLineItemId = sourceId(statement, normalized, identitySignature);
            const stageable = occurrences.filter((fact) => !claimed.has(fact.periodId));
            let prepared = rowById.get(sourceLineItemId);
            if (!prepared && stageable.length === 0) continue;
            if (!prepared) {
              const first = occurrences[0]!;
              prepared = {
                sourceLineItemId, statement, label: row.labelText, unit: structuredClone(first.unit),
                order: rows.length + 1, conceptQName: first.conceptQName, dimensionSignature: signature,
                dimensions: structuredClone(first.dimensions), depth: row.indentLevel,
                presentationAccessions: [], sourceTableId: table.sourceTableId,
                ...(negatedConcepts === undefined ? {} : { negated: occurrences.some((fact) => negatedConcepts.has(fact.conceptQName)) }),
              };
              const parent = ancestry.at(-1);
              if (parent) prepared.parentSourceLineItemId = parent.sourceLineItemId;
              rowById.set(sourceLineItemId, prepared);
              rowViews.push(prepared);
              rows.push({ sourceLineItemId, statement, label: row.labelText, unit: structuredClone(first.unit), order: prepared.order });
            }
            rowIdentity ??= sourceLineItemId;
            if (!prepared.presentationAccessions.includes(table.accession)) prepared.presentationAccessions.push(table.accession);
            for (const fact of stageable) {
              const coordinate = `${sourceLineItemId}|${fact.periodId}`;
              if (staged.has(coordinate)) continue;
              staged.add(coordinate);
              contributed.add(fact.periodId);
              facts.push({
                factId: `xbrl-${createHash("sha256").update(`${table.accession}|${coordinate}|${fact.contextId}`).digest("hex").slice(0, 24)}`,
                status: "staged",
                lineItemId: sourceLineItemId,
                periodId: fact.periodId,
                value: fact.value,
                unit: structuredClone(fact.unit),
                provenance: {
                  sourceType: "filing_xbrl",
                  sourceRefs: [fact.sourceAnchor],
                  asOfDate: table.filedAt,
                  ...(fact.decimals === undefined ? {} : { decimals: fact.decimals }),
                  accession: table.accession,
                  concept: fact.conceptQName,
                  filingUrl: filingByAccession.get(table.accession)?.primaryDocumentUrl ?? "",
                },
              });
            }
          }
          if (rowIdentity !== undefined) ancestry.push({ indentLevel: row.indentLevel, sourceLineItemId: rowIdentity });
        }
      }
      for (const periodId of contributed) if (declared.has(periodId)) claimed.add(periodId);
    }
  }

  const statementViews = Object.fromEntries(STATEMENTS.map((statement) => {
    const groups = groupsByStatement.get(statement)!;
    return [statement, {
      candidate: { periods: structuredClone(input.requestedPeriods) as Period[], rows: rowViews.filter((row) => row.statement === statement) },
      filingPresentations: groups.flatMap((group) => group.tables.map((table) => presentationView(statement, table, group, groups[0]!, input.requestedPeriods))),
    }];
  })) as PreparedFilingStatements["statementViews"];

  const coverageStatements = STATEMENTS.map((statement) => {
    const available = requestedIds.filter((periodId) => facts.some((fact) => fact.periodId === periodId
      && rowById.get(fact.lineItemId!)?.statement === statement));
    return { statement, availablePeriodIds: available,
      missingPeriodIds: requestedIds.filter((periodId) => !available.includes(periodId)) };
  });

  return {
    filings: [...structuredClone(input.filings)].sort((left, right) =>
      right.filedAt.localeCompare(left.filedAt) || right.accession.localeCompare(left.accession)),
    periods: structuredClone(input.requestedPeriods) as Period[],
    rows,
    facts,
    statementViews,
    dimensionalDisclosures: dimensions,
    coverage: {
      requestedPeriodIds: requestedIds,
      statements: coverageStatements,
      issues: [
        ...coverageStatements.flatMap((entry) => entry.missingPeriodIds.length === 0 ? [] : [{
          code: "missing_period" as const, severity: "review_required" as const, statement: entry.statement,
          periodIds: entry.missingPeriodIds, sourceRefs: input.filings.map((filing) => filing.accession),
        }]),
        ...conflicts,
      ],
    },
    diagnostics,
  };
}

/**
 * A dimensional cell is disclosure evidence, never a consolidated line: it is
 * recorded even when cross-filing precedence keeps its value out of `facts`.
 */
function recordDisclosure(
  dimensions: DimensionalDisclosureView[],
  table: FilingTable,
  label: string,
  signature: string,
  fact: FilingTableFactOccurrence,
): void {
  if (fact.dimensions.length === 0) return;
  const key = `${roleUri(table)}|${fact.conceptQName}|${unitKey(fact.unit)}|${signature}`;
  let view = dimensions.find((candidate) =>
    `${candidate.statementOrNoteRole}|${candidate.concept.qname}|${unitKey(candidate.concept.unit)}|${candidate.dimensionSignature}` === key);
  if (!view) {
    view = {
      statementOrNoteRole: roleUri(table),
      concept: { qname: fact.conceptQName, label, unit: structuredClone(fact.unit) },
      dimensions: structuredClone(fact.dimensions),
      dimensionSignature: signature,
      periods: [],
    };
    dimensions.push(view);
  }
  view.periods.push({ periodId: fact.periodId, value: fact.value, accession: table.accession,
    contextId: fact.contextId, sourceAnchor: fact.sourceAnchor });
}

/** Curated tables have no presentation role; the table itself is the role. */
function roleUri(table: FilingTable): string {
  return `table://${table.sourceTableId}`;
}

function presentationView(
  statement: StatementKind,
  table: FilingTable,
  group: CuratedGroup,
  latest: CuratedGroup,
  requestedPeriods: readonly Period[],
): FilingPresentationView {
  const periodIds = new Set(table.rows.flatMap((row) => row.cells.flatMap((cell) => cell.fact ? [cell.fact.periodId] : [])));
  return {
    accession: group.accession,
    form: table.form,
    filedAt: table.filedAt,
    isLatest: group.accession === latest.accession,
    roleUri: roleUri(table),
    periodColumns: structuredClone(requestedPeriods.filter((period) => periodIds.has(period.id))) as Period[],
    rows: table.rows.flatMap((row) => [...factBuckets(row.cells, () => true)].map(([_bucket, occurrences]) => {
      const signature = dimensionSignature(occurrences[0]!.dimensions);
      const identitySignature = `${signature}|unit=${unitKey(occurrences[0]!.unit)}`;
      return ({
      conceptQName: occurrences[0]!.conceptQName,
      label: row.labelText,
      order: row.order,
      depth: row.indentLevel,
      facts: structuredClone(occurrences),
      sourceLineItemId: sourceId(statement, normalizeLabel(row.labelText), identitySignature),
      dimensionSignature: signature,
    }); })),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
