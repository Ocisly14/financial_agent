import type { Period, Unit } from "../../../financial-model/types.ts";
import type { FilingExtraction, PresentationFactPayload, PresentationNodePayload, PresentationStatementPayload } from "../types.ts";

export const USD: Unit = { kind: "currency", code: "USD" };

export function period(id: string, year: number): Period {
  return { id, label: id, start: `${year}-01-01`, end: `${year}-12-31`, cls: "actual" };
}

export function fact(periodId: string, value: number, over: Partial<PresentationFactPayload> = {}): PresentationFactPayload {
  return { periodId, value, unit: USD, decimals: -6, contextId: `c-${periodId}`, sourceAnchor: `#${periodId}`, dimensions: [], ...over };
}

export function node(nodeId: number, parentNodeId: number | null, conceptQName: string, label: string,
  facts: PresentationFactPayload[], abstract = false): PresentationNodePayload {
  return { nodeId, parentNodeId, conceptQName, label, abstract, facts, ambiguousPeriodIds: [] };
}

export function statement(kind: PresentationStatementPayload["statement"], nodes: PresentationNodePayload[]): PresentationStatementPayload {
  return { statement: kind, roleUri: `http://x/role/${kind}`, roleLabel: kind, declaredAxisQNames: [], nodes };
}

export function filing(accession: string, filedAt: string, statements: PresentationStatementPayload[],
  calculationRelations: FilingExtraction["calculationRelations"] = []): FilingExtraction {
  return { filing: { accession, form: "10-K", filedAt, reportDate: filedAt, primaryDocumentUrl: `https://sec.gov/${accession}` },
    tables: [], calculationRelations, negatedConcepts: [], diagnostics: [], statements };
}
