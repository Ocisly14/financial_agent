import type { Period, StatementKind, Unit } from "../../financial-model/types.ts";
import { buildSignOrientation } from "./conceptOrientation.ts";
import { dimensionSignature } from "./mergeCuratedTables.ts";
import type { PresentationExtract, PresentationNodePayload, XbrlDimension } from "./types.ts";

export type InventoryRow = {
  statement: StatementKind;
  conceptQName: string;
  /** "" for dimensionless rows. */
  dimensionSignature: string;
  /** A rollforward's opening-balance row. Same concept as the closing row, different number, so it
   *  is a separate inventory row and a component must ask for it explicitly. */
  openingBalance: boolean;
  dimensions: XbrlDimension[];
  /** Distinct display labels, latest filing's first. */
  labels: string[];
  /** Tree position in the newest filing that CARRIED this row — not the newest filing overall.
   *
   *  A line the issuer retired is still a line of the statement it was retired from: MSFT's "Cash
   *  premium on debt exchange" sits under Financing beside repayments and dividends, and reading
   *  that is what separates a retired face line (needs its own row) from the superseded half of a
   *  re-tag (merges into the live row via alsoTaggedAs). Nulling the position because the newest
   *  filing dropped the concept flattened both cases into identical orphans at depth 0, leaving the
   *  label as the only evidence — and the retired line lost its year's money to supplemental.
   *
   *  Whether the issuer still reports the line is not a separate flag: the newest period missing
   *  from `values` says it, and says which year it stopped. */
  parentLabel: string | null;
  depth: number;
  /** Present ONLY when filings disagree about where the row sits, keyed by every covered period and
   *  resolved from the same filing that supplied that period's value. Issuers rarely move a line, so
   *  the common case spends nothing; when one does move, the move is what the reader needs to see. */
  parentByPeriod?: Record<string, { label: string | null; depth: number }>;
  /** Latest-filing-wins value per period, AFTER deterministic orientation, keyed in ascending period
   *  order. The key set IS the row's period coverage. Never backfilled from here.
   *
   *  Whole values rather than a sample plus per-year signs, because scale is what the reader needs
   *  and no single sample carries it: MSFT's commercial paper is 0 in its newest tagged year and
   *  $6.693B the year before, so a most-recent sample reads as a dead legacy line. A sign alone says
   *  the older year is non-zero without saying it is billions. At two to five periods a row this is
   *  also the cheaper encoding — the sign objects it replaces cost more bytes than the numbers do. */
  values: Record<string, number>;
  /** Unit of the row's most recent value. */
  unit: Unit | null;
};

type Accumulator = InventoryRow & { unitPeriodEnd: string; order: number };

export function buildConceptInventory(input: {
  filings: readonly PresentationExtract[];
  requestedPeriods: readonly Period[];
}): InventoryRow[] {
  const requested = new Map(input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => [p.id, p.end]));
  // Newest first: index 0 defines labels[0], tree position, and row order.
  const filings = [...input.filings].sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt));
  const rows = new Map<string, Accumulator>();
  const coverage = new Map<string, Set<string>>();
  // key -> periodId -> latest-filing-wins raw value (first write wins: filings iterate newest-first).
  const resolved = new Map<string, Map<string, { value: number; accession: string }>>();
  // key -> accession -> where that filing put the row. Kept per filing rather than collapsed, so a
  // row an issuer moved between sections can be reported per period instead of silently taking the
  // newest position for years that were reported under the old one.
  const positions = new Map<string, Map<string, { label: string | null; depth: number }>>();
  let appendOrder = 1_000_000; // rows absent from the latest filing sort after its declared order

  filings.forEach((extraction, filingIndex) => {
    for (const stmt of extraction.statements) {
      const byNodeId = new Map(stmt.nodes.map((n) => [n.nodeId, n]));
      stmt.nodes.forEach((node, nodeOrder) => {
        if (node.abstract) return;
        for (const factPayload of node.facts) {
          const end = requested.get(factPayload.periodId);
          if (end === undefined) continue;
          const signature = dimensionSignature(factPayload.dimensions);
          const opening = node.openingBalance === true;
          const key = `${stmt.statement}|${node.conceptQName}|${signature}|${opening ? "opening" : ""}`;
          const position = treePosition(node, byNodeId);
          let row = rows.get(key);
          if (!row) {
            // Filings iterate newest-first, so the filing creating the row is the newest one that
            // carries it — its position is the row's, whether or not the very latest filing has it.
            row = { statement: stmt.statement, conceptQName: node.conceptQName, dimensionSignature: signature,
              openingBalance: opening,
              dimensions: [...factPayload.dimensions], labels: [],
              parentLabel: position.parentLabel, depth: position.depth, values: {}, unit: null,
              unitPeriodEnd: "", order: filingIndex === 0 ? nodeOrder : appendOrder++ };
            rows.set(key, row);
            coverage.set(key, new Set());
            resolved.set(key, new Map());
            positions.set(key, new Map());
          }
          positions.get(key)!.set(extraction.filing.accession, { label: position.parentLabel, depth: position.depth });
          if (!row.labels.includes(node.label)) row.labels.push(node.label);
          coverage.get(key)!.add(factPayload.periodId);
          const byPeriod = resolved.get(key)!;
          if (!byPeriod.has(factPayload.periodId)) {
            byPeriod.set(factPayload.periodId, { value: factPayload.value, accession: extraction.filing.accession });
          }
          if (end > row.unitPeriodEnd) { row.unitPeriodEnd = end; row.unit = factPayload.unit; }
        }
      });
    }
  });

  const orientation = buildSignOrientation(input.filings);
  return [...rows.entries()]
    .sort(([, a], [, b]) => statementOrder(a.statement) - statementOrder(b.statement) || a.order - b.order)
    .map(([key, { unitPeriodEnd: _end, order: _order, ...row }]) => {
      const byPeriod = resolved.get(key)!;
      const byAccession = positions.get(key)!;
      const values: Record<string, number> = {};
      const parentByPeriod: Record<string, { label: string | null; depth: number }> = {};
      let moved = false;
      for (const periodId of [...coverage.get(key)!].sort()) {
        const chosen = byPeriod.get(periodId)!;
        const flipped = orientation.flips.get(chosen.accession)?.has(row.conceptQName) ?? false;
        values[periodId] = flipped ? -chosen.value : chosen.value;
        // The position that goes with a period is the one held by the filing that supplied its
        // value, so the two can never describe different filings' versions of the row.
        const at = byAccession.get(chosen.accession) ?? { label: row.parentLabel, depth: row.depth };
        parentByPeriod[periodId] = at;
        if (at.label !== row.parentLabel || at.depth !== row.depth) moved = true;
      }
      return { ...row, values, ...(moved ? { parentByPeriod } : {}) };
    });
}

function treePosition(node: PresentationNodePayload, byNodeId: Map<number, PresentationNodePayload>): { parentLabel: string | null; depth: number } {
  let depth = 0;
  let parent = node.parentNodeId === null ? undefined : byNodeId.get(node.parentNodeId);
  const parentLabel = parent?.label ?? null;
  while (parent) { depth += 1; parent = parent.parentNodeId === null ? undefined : byNodeId.get(parent.parentNodeId); }
  return { parentLabel, depth };
}

const STATEMENT_ORDER: readonly StatementKind[] = ["income_statement", "balance_sheet", "cash_flow_statement"];
function statementOrder(statement: StatementKind): number { return STATEMENT_ORDER.indexOf(statement); }
