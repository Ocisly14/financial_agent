import type { PresentedNode, PresentedStatement } from "./presentedStatement.ts";
import type { CalculationRelation } from "./types.ts";
import { tolerance } from "./verification.ts";

export type RollupBreak = {
  roleUri: string; parentConcept: string; periodId: string;
  reported: number; computed: number; difference: number; missingChildren: string[];
};

export type BalanceBreak = { periodId: string; assets: number; liabilitiesAndEquity: number; difference: number };

export type StatementVerification = {
  rollupBreaks: RollupBreak[];
  balanceBreaks: BalanceBreak[];
  reportedPeriodIds: string[];
  totalsUnavailable: boolean;
};

const ASSETS = "us-gaap:Assets";
const LIABILITIES_AND_EQUITY = "us-gaap:LiabilitiesAndStockholdersEquity";

function valueOf(byConcept: Map<string, PresentedNode>, concept: string, periodId: string): number | undefined {
  return byConcept.get(concept)?.valueByPeriod.get(periodId)?.value;
}

export function verifyPresentedStatement(
  statement: PresentedStatement,
  relations: readonly CalculationRelation[],
): StatementVerification {
  // A concept may appear under two parents; the first node wins, because both carry the same fact.
  const byConcept = new Map<string, PresentedNode>();
  for (const node of statement.nodes) {
    if (node.abstract || byConcept.has(node.conceptQName)) continue;
    byConcept.set(node.conceptQName, node);
  }

  const own = relations.filter((relation) => relation.roleUri === statement.roleUri);
  const rollupBreaks: RollupBreak[] = [];
  for (const relation of own) {
    for (const periodId of statement.periodIds) {
      const reported = valueOf(byConcept, relation.parentConcept, periodId);
      if (reported === undefined) continue;
      const present = relation.children.filter((child) => valueOf(byConcept, child.concept, periodId) !== undefined);
      if (present.length === 0) continue;
      const computed = present.reduce((sum, child) => sum + child.weight * valueOf(byConcept, child.concept, periodId)!, 0);
      const difference = reported - computed;
      if (Math.abs(difference) <= tolerance(reported)) continue;
      rollupBreaks.push({
        roleUri: statement.roleUri, parentConcept: relation.parentConcept, periodId,
        reported, computed, difference,
        missingChildren: relation.children
          .filter((child) => valueOf(byConcept, child.concept, periodId) === undefined)
          .map((child) => child.concept),
      });
    }
  }

  const balanceBreaks: BalanceBreak[] = [];
  if (statement.statement === "balance_sheet") {
    for (const periodId of statement.periodIds) {
      const assets = valueOf(byConcept, ASSETS, periodId);
      const liabilitiesAndEquity = valueOf(byConcept, LIABILITIES_AND_EQUITY, periodId);
      // A filer that never tags LiabilitiesAndStockholdersEquity is not in breach; there is
      // simply nothing to compare, and inventing a sum here would be a different check.
      if (assets === undefined || liabilitiesAndEquity === undefined) continue;
      const difference = assets - liabilitiesAndEquity;
      if (Math.abs(difference) <= tolerance(assets)) continue;
      balanceBreaks.push({ periodId, assets, liabilitiesAndEquity, difference });
    }
  }

  const totals = new Set(own.map((relation) => relation.parentConcept));
  const totalsUnavailable = totals.size === 0;
  // Absent a calculation linkbase there are no totals to test, so coverage falls back to any
  // non-abstract fact. The flag exists so a caller never reads that fallback as a real total.
  const covered = totalsUnavailable
    ? statement.nodes.filter((node) => !node.abstract)
    : statement.nodes.filter((node) => totals.has(node.conceptQName));
  const reportedPeriodIds = statement.periodIds.filter((periodId) =>
    covered.some((node) => node.valueByPeriod.has(periodId)));

  return { rollupBreaks, balanceBreaks, reportedPeriodIds, totalsUnavailable };
}
