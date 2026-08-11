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
  /** Tree position in the latest filing carrying this row; null when onlyInOlderFilings. */
  parentLabel: string | null;
  depth: number;
  onlyInOlderFilings: boolean;
  /** Sorted periodIds with at least one fact across filings. */
  periodCoverage: string[];
  /** Most recent value, for sign/scale judgment only — never backfilled from here. */
  sampleValue: number | null;
  sampleUnit: Unit | null;
  /** Per covered period: sign of the latest-filing-wins value AFTER deterministic orientation. */
  perYearSigns: Array<{ periodId: string; sign: -1 | 0 | 1 }>;
};

type Accumulator = InventoryRow & { samplePeriodEnd: string; order: number };

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
          let row = rows.get(key);
          if (!row) {
            row = { statement: stmt.statement, conceptQName: node.conceptQName, dimensionSignature: signature,
              openingBalance: opening,
              dimensions: [...factPayload.dimensions], labels: [], parentLabel: null, depth: 0,
              onlyInOlderFilings: filingIndex > 0, periodCoverage: [], sampleValue: null, sampleUnit: null,
              perYearSigns: [], samplePeriodEnd: "", order: filingIndex === 0 ? nodeOrder : appendOrder++ };
            if (filingIndex === 0) { const pos = treePosition(node, byNodeId); row.parentLabel = pos.parentLabel; row.depth = pos.depth; }
            rows.set(key, row);
            coverage.set(key, new Set());
            resolved.set(key, new Map());
          }
          if (!row.labels.includes(node.label)) row.labels.push(node.label);
          coverage.get(key)!.add(factPayload.periodId);
          const byPeriod = resolved.get(key)!;
          if (!byPeriod.has(factPayload.periodId)) {
            byPeriod.set(factPayload.periodId, { value: factPayload.value, accession: extraction.filing.accession });
          }
          if (end > row.samplePeriodEnd) { row.samplePeriodEnd = end; row.sampleValue = factPayload.value; row.sampleUnit = factPayload.unit; }
        }
      });
    }
  });

  const orientation = buildSignOrientation(input.filings);
  return [...rows.entries()]
    .sort(([, a], [, b]) => statementOrder(a.statement) - statementOrder(b.statement) || a.order - b.order)
    .map(([key, { samplePeriodEnd: _end, order: _order, ...row }]) => {
      const periodCoverage = [...coverage.get(key)!].sort();
      const byPeriod = resolved.get(key)!;
      const perYearSigns = periodCoverage.map((periodId) => {
        const chosen = byPeriod.get(periodId)!;
        const flipped = orientation.flips.get(chosen.accession)?.has(row.conceptQName) ?? false;
        return { periodId, sign: Math.sign(flipped ? -chosen.value : chosen.value) as -1 | 0 | 1 };
      });
      return { ...row, periodCoverage, perYearSigns };
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
