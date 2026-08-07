import type { Period, StatementKind } from "../../financial-model/types.ts";
import type { FilingExtraction, PresentationFactPayload } from "./types.ts";

export type PresentedNode = {
  nodeId: number;
  parentNodeId: number | null;
  conceptQName: string;
  label: string;
  abstract: boolean;
  valueByPeriod: Map<string, PresentationFactPayload>;
  ambiguousPeriodIds: string[];
};

export type PresentedStatement = {
  accession: string;
  statement: StatementKind;
  roleUri: string;
  roleLabel: string;
  nodes: PresentedNode[];
  periodIds: string[];
};

/**
 * Shape the companion's presentation payload into one statement per filing, scoped to the
 * requested periods. A pure transform: the issuer's declared order and nesting are preserved
 * exactly, and nothing here infers structure.
 */
export function buildPresentedStatements(input: {
  filings: readonly FilingExtraction[];
  requestedPeriods: readonly Period[];
}): PresentedStatement[] {
  const requested = input.requestedPeriods.filter((period) => period.cls === "actual").map((period) => period.id);
  const requestedSet = new Set(requested);
  const statements: PresentedStatement[] = [];

  for (const filing of input.filings) {
    for (const payload of filing.statements) {
      const present = new Set<string>();
      const nodes = payload.nodes.map((node) => {
        const valueByPeriod = new Map<string, PresentationFactPayload>();
        for (const fact of node.facts) {
          if (!requestedSet.has(fact.periodId)) continue;
          valueByPeriod.set(fact.periodId, fact);
          present.add(fact.periodId);
        }
        return {
          nodeId: node.nodeId,
          parentNodeId: node.parentNodeId,
          conceptQName: node.conceptQName,
          label: node.label,
          abstract: node.abstract,
          valueByPeriod,
          ambiguousPeriodIds: node.ambiguousPeriodIds.filter((periodId) => requestedSet.has(periodId)),
        };
      });
      statements.push({
        accession: filing.filing.accession,
        statement: payload.statement,
        roleUri: payload.roleUri,
        roleLabel: payload.roleLabel,
        nodes,
        periodIds: requested.filter((periodId) => present.has(periodId)),
      });
    }
  }

  return statements;
}
