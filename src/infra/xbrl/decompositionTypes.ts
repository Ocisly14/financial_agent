import { createHash } from "node:crypto";
import type { Unit } from "../../financial-model/types.ts";
import type { XbrlDimension } from "./types.ts";
import type { FilingTable } from "./tableTypes.ts";

/** Agent-side shapes: references only, never values. */
export type SchemeFactRef = { factId: string; periodId: string };
export type FilingSchemeChild = { label: string; memberHint?: string; factRefs: SchemeFactRef[] };
export type FilingDecompositionScheme = {
  schemeId: string;
  label: string;
  /** Dimension axis qname, or the literal "presentation-only". */
  axisHint: string;
  targetSourceLineItemId: string;
  children: FilingSchemeChild[];
};
export type FilingDecompositionProposal = {
  accession: string;
  rationale: string;
  schemes: FilingDecompositionScheme[];
  sourceRefs: string[];
};

/** Host-minted identity for a non-face table fact (spec §3.2). */
export type MintedTableFact = {
  factId: string;
  accession: string;
  filedAt: string;
  sourceTableId: string;
  rowOrder: number;
  periodId: string;
  contextId: string;
  value: number;
  unit: Unit;
  dimensions: XbrlDimension[];
  conceptQName: string;
  sourceAnchor: string;
};

/** Host-side cross-filing shapes produced by the deterministic middle layer. */
export type CandidateChildCell = { factId: string; value: number; accession: string; filedAt: string; sourceAnchor: string };
export type CandidateChild = {
  childId: string;
  label: string;
  memberHint?: string;
  /** periodId -> adjudicated cell; gaps are simply absent, never fabricated. */
  cells: Record<string, CandidateChildCell>;
};
export type CandidateScheme = {
  candidateSchemeId: string;
  label: string;
  axisHint: string;
  targetSourceLineItemId: string;
  children: CandidateChild[];
  periodIds: string[];
  /** childId -> periodIds with data (coverage matrix, spec §4.3). */
  coverage: Record<string, string[]>;
  /** periodId -> |face - Σchildren| / face; null when the face value is unavailable. */
  residualRatioByPeriod: Record<string, number | null>;
  flags: string[];
  openQuestions: string[];
};
export type ChildMergeRecord = { candidateSchemeId: string; keepChildId: string; mergeChildIds: string[] };
export type ReduceDecision = { ranked: string[]; driverSchemeId: string | null; rationale: string };
export type FinalDecompositionDecision = { acceptedSchemeIds: string[]; driverSchemeId: string | null; decidedBy: string; rationale: string };
export type DecompositionSummary = {
  schemes: Array<{
    candidateSchemeId: string;
    label: string;
    axisHint: string;
    targetSourceLineItemId: string;
    driver: boolean;
    children: Array<{ childRowId: string; label: string; residual?: true }>;
  }>;
};

export function mintTableFactId(accession: string, sourceTableId: string, rowOrder: number, periodId: string, contextId: string): string {
  return `xbrl-${createHash("sha256").update(`${accession}|${sourceTableId}:${rowOrder}|${periodId}|${contextId}`).digest("hex").slice(0, 24)}`;
}

export function mintTableFacts(table: FilingTable): MintedTableFact[] {
  return table.rows.flatMap((row) => row.cells.flatMap((cell) => {
    const fact = cell.fact;
    if (!fact) return [];
    return [{
      factId: mintTableFactId(table.accession, table.sourceTableId, row.order, fact.periodId, fact.contextId),
      accession: table.accession, filedAt: table.filedAt, sourceTableId: table.sourceTableId, rowOrder: row.order,
      periodId: fact.periodId, contextId: fact.contextId, value: fact.value, unit: structuredClone(fact.unit),
      dimensions: structuredClone(fact.dimensions), conceptQName: fact.conceptQName, sourceAnchor: fact.sourceAnchor,
    }];
  }));
}
