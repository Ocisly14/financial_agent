import { normalizeLabel } from "../infra/xbrl/mergeCuratedTables.ts";
import { isRevenueFamilyConcept, shortHash } from "../infra/xbrl/decompositionAnalysis.ts";
import type { PreparedStatementMappingView, PreparedStatementRowView } from "../infra/xbrl/types.ts";
import type { SourceReviewArtifact } from "../infra/xbrl/sourceReviewStore.ts";
import type { DecompositionSummary } from "../infra/xbrl/decompositionTypes.ts";
import { CANONICAL_MAPPING_IDS } from "./skeleton.ts";
import type { Fact, StatementKind, StatementMappingPlan } from "./types.ts";

export type PremapSummary = {
  version: "auto-premap-v1";
  mapped: Array<{
    targetLineItemId: string;
    targetLabel: string;
    sourceRows: Array<{ sourceLineItemId: string; label: string; conceptQName: string }>;
    periodIds: string[];
    basis: "concept_vocab" | "face_child" | "decomposition_scheme";
    reconciliation: "ok" | "gap";
    gapDetail?: string;
  }>;
  unmapped: {
    spineTargets: string[];
    sourceRows: Array<{ sourceLineItemId: string; label: string; conceptQName: string }>;
  };
  demoted: Array<{ targetLineItemId: string; reason: string }>;
};

/**
 * Spine id -> us-gaap local concept names (no `us-gaap:` prefix). Reused directly to build the
 * reverse lookup used at match time; see `assertInjectiveVocabulary`.
 *
 * `SellingGeneralAndAdministrativeExpense` is deliberately absent: spec §3 footnote routes it to
 * `selling_and_marketing` only when no row separately maps to `general_and_administrative`, which
 * is a conditional (post-pass) rule, not a static concept->target fact, and including it here would
 * make the table non-injective against `SellingAndMarketingExpense`/`GeneralAndAdministrativeExpense`.
 */
export const CONCEPT_SPINE_MAP: Record<string, string[]> = {
  "revenue.total": [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ],
  cost_of_revenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
  gross_profit: ["GrossProfit"],
  research_and_development: ["ResearchAndDevelopmentExpense"],
  selling_and_marketing: ["SellingAndMarketingExpense"],
  general_and_administrative: ["GeneralAndAdministrativeExpense"],
  operating_expenses: ["OperatingExpenses", "CostsAndExpenses"],
  operating_income: ["OperatingIncomeLoss"],
  interest_income: ["InvestmentIncomeInterest"],
  interest_expense: ["InterestExpense", "InterestExpenseNonoperating"],
  pretax_income: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  income_tax_expense: ["IncomeTaxExpenseBenefit"],
  net_income: ["NetIncomeLoss", "ProfitLoss"],
  net_income_attributable_nci: ["NetIncomeLossAttributableToNoncontrollingInterest"],
  non_operating_income_expense: ["OtherNonoperatingIncomeExpense"],
  depreciation_amortization: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet"],
  capital_expenditures: ["PaymentsToAcquirePropertyPlantAndEquipment"],
  diluted_eps: ["EarningsPerShareDiluted"],
  // The equity bridge's share count. Weighted-average diluted, matching the `diluted_shares` row's
  // own definition; period-end counts are not on the face statements.
  diluted_shares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],

  cash_and_equivalents: ["CashAndCashEquivalentsAtCarryingValue"],
  restricted_cash: ["RestrictedCashAndCashEquivalents", "RestrictedCashCurrent"],
  short_term_investments: ["ShortTermInvestments", "OtherShortTermInvestments"],
  accounts_receivable: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"],
  inventory: ["InventoryNet"],
  other_operating_current_assets: ["OtherAssetsCurrent"],
  accounts_payable: ["AccountsPayableCurrent"],
  deferred_revenue: ["ContractWithCustomerLiabilityCurrent", "DeferredRevenueCurrent"],
  accrued_operating_liabilities: ["AccruedLiabilitiesCurrent"],
  other_operating_current_liabilities: ["OtherLiabilitiesCurrent"],
  property_plant_equipment: ["PropertyPlantAndEquipmentNet"],
  total_current_assets: ["AssetsCurrent"],
  total_assets: ["Assets"],
  total_current_liabilities: ["LiabilitiesCurrent"],
  shareholders_equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  // Balance-sheet carrying amount of NCI — the equity bridge's deduction, distinct from the income
  // statement's `net_income_attributable_nci`. `PreferredStockValue` has no counterpart entry on
  // purpose: it is par value, not the redemption value the bridge needs, so it stays with the agent.
  non_controlling_interests: ["MinorityInterest"],

  operating_cash_flow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  reported_change_operating_assets_liabilities: ["IncreaseDecreaseInOperatingCapital"],
  asset_sale_proceeds: ["ProceedsFromSaleOfPropertyPlantAndEquipment"],
  acquisitions: ["PaymentsToAcquireBusinessesNetOfCashAcquired"],
  net_investing_cash_flow: ["NetCashProvidedByUsedInInvestingActivities"],
  debt_issuance: ["ProceedsFromIssuanceOfLongTermDebt"],
  debt_repayment: ["RepaymentsOfLongTermDebt"],
  dividends: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
  share_repurchases: ["PaymentsForRepurchaseOfCommonStock"],
};

const SGA_CONCEPT = "SellingGeneralAndAdministrativeExpense";

/**
 * Spec §3: every engine-authored plan carries this prefix. It is the ownership marker the lifecycle
 * relies on — engine plans are replaced as a set on every premap run, are individually replaceable
 * through `set_statement_mapping_plan`, and never close the one-shot initial-mapping window.
 */
export const AUTO_PREMAP_PLAN_PREFIX = "auto-premap-v1-";

export function isAutoPremapPlan(plan: Pick<StatementMappingPlan, "reviewDecisionId">): boolean {
  return plan.reviewDecisionId.startsWith(AUTO_PREMAP_PLAN_PREFIX);
}

/** Same target labels createSkeleton uses for these ids; a test asserts the two never drift apart. */
export const TARGET_LABELS: Record<string, string> = {
  "revenue.total": "Total revenue",
  cost_of_revenue: "Cost of revenue",
  gross_profit: "Gross profit",
  research_and_development: "Research and development",
  selling_and_marketing: "Selling and marketing",
  general_and_administrative: "General and administrative",
  operating_expenses: "Operating expenses",
  operating_income: "Operating income",
  interest_income: "Interest income",
  interest_expense: "Interest expense",
  pretax_income: "Pretax income",
  income_tax_expense: "Income tax expense",
  net_income: "Net income",
  net_income_attributable_nci: "Net income attributable to non-controlling interests",
  non_operating_income_expense: "Non-operating income and expense",
  depreciation_amortization: "Depreciation and amortization",
  capital_expenditures: "Capital expenditures",
  diluted_eps: "Diluted earnings per share",
  diluted_shares: "Diluted shares",
  cash_and_equivalents: "Cash and cash equivalents",
  restricted_cash: "Restricted cash",
  short_term_investments: "Short-term investments",
  accounts_receivable: "Accounts receivable",
  inventory: "Inventory",
  other_operating_current_assets: "Other operating current assets",
  accounts_payable: "Accounts payable",
  deferred_revenue: "Deferred revenue",
  accrued_operating_liabilities: "Accrued operating liabilities",
  other_operating_current_liabilities: "Other operating current liabilities",
  property_plant_equipment: "Property, plant and equipment",
  total_current_assets: "Total current assets",
  total_assets: "Total assets",
  total_current_liabilities: "Total current liabilities",
  shareholders_equity: "Shareholders' equity",
  non_controlling_interests: "Non-controlling interests",
  operating_cash_flow: "Operating cash flow",
  reported_change_operating_assets_liabilities: "Reported change in operating assets and liabilities",
  asset_sale_proceeds: "Asset sale proceeds",
  acquisitions: "Acquisitions",
  net_investing_cash_flow: "Net investing cash flow",
  debt_issuance: "Debt issuance",
  debt_repayment: "Debt repayment",
  dividends: "Dividends",
  share_repurchases: "Share repurchases",
};

const reverseVocab = new Map<string, string>();

/** Spec §7 row 1: the vocabulary is checked at build/import time to be injective. */
export function assertInjectiveVocabulary(): void {
  reverseVocab.clear();
  for (const [spineId, concepts] of Object.entries(CONCEPT_SPINE_MAP)) {
    for (const concept of concepts) {
      const existing = reverseVocab.get(concept);
      if (existing !== undefined && existing !== spineId) {
        throw new Error(`CONCEPT_SPINE_MAP is not injective: ${concept} maps to both ${existing} and ${spineId}`);
      }
      reverseVocab.set(concept, spineId);
    }
  }
}
assertInjectiveVocabulary();

function stripUsGaap(conceptQName: string): string | undefined {
  return conceptQName.startsWith("us-gaap:") ? conceptQName.slice("us-gaap:".length) : undefined;
}

function slugify(text: string): string {
  const normalized = normalizeLabel(text);
  let slug = normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (slug.length === 0) slug = "stream";
  if (/^[0-9]/.test(slug)) slug = `s_${slug}`;
  return slug;
}

function uniqueSlug(text: string, used: Set<string>): string {
  const base = slugify(text);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Materialized decomposition rows (materializeDecomposition.ts) share this id prefix + have a parent. */
function isDecompositionRow(row: PreparedStatementRowView): boolean {
  return row.statement === "income_statement"
    && row.sourceLineItemId.startsWith("source.income_statement.revenue.")
    && row.parentSourceLineItemId !== undefined;
}

function reachesTarget(rowId: string, targetId: string, parentOf: ReadonlyMap<string, string | undefined>): boolean {
  const seen = new Set<string>();
  let current = parentOf.get(rowId);
  while (current !== undefined) {
    if (current === targetId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = parentOf.get(current);
  }
  return false;
}

type BuildPremapInput = {
  statementViews: SourceReviewArtifact["statementViews"];
  facts: SourceReviewArtifact["facts"];
  decomposition?: DecompositionSummary;
  historicalPeriodIds: string[];
};

type BuildPremapOutput = {
  summary: PremapSummary;
  plans: StatementMappingPlan[];
  streams: Array<{ id: string; label: string }>;
};

type SourceRowRef = { sourceLineItemId: string; label: string; conceptQName: string };

export function buildPremap(input: BuildPremapInput): BuildPremapOutput {
  const historicalOrder = new Map(input.historicalPeriodIds.map((id, index) => [id, index]));
  const historicalSet = new Set(input.historicalPeriodIds);
  const periodComparator = (left: string, right: string): number =>
    (historicalOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (historicalOrder.get(right) ?? Number.MAX_SAFE_INTEGER);

  const factsByLine = new Map<string, Set<string>>();
  const factValue = new Map<string, number>();
  for (const fact of input.facts as readonly Fact[]) {
    if (fact.status !== "staged" || fact.lineItemId === undefined || !historicalSet.has(fact.periodId)) continue;
    const set = factsByLine.get(fact.lineItemId) ?? new Set<string>();
    set.add(fact.periodId);
    factsByLine.set(fact.lineItemId, set);
    factValue.set(`${fact.lineItemId}|${fact.periodId}`, fact.value);
  }
  const periodsFor = (sourceLineItemId: string): string[] =>
    [...(factsByLine.get(sourceLineItemId) ?? [])].sort(periodComparator);

  const entries = Object.entries(input.statementViews) as Array<[StatementKind, PreparedStatementMappingView]>;
  const allRows = entries.flatMap(([, view]) => view.candidate.rows);
  const faceRows = allRows.filter((row) => row.dimensionSignature === "" && !isDecompositionRow(row));

  const mapped: PremapSummary["mapped"] = [];
  const plans: StatementMappingPlan[] = [];
  const demoted: PremapSummary["demoted"] = [];
  const consumed = new Set<string>();

  // --- Layer 1: concept vocabulary -> spine rows -------------------------------------------------
  const groups = new Map<string, PreparedStatementRowView[]>();
  const sgaRows: PreparedStatementRowView[] = [];
  for (const row of faceRows) {
    const local = stripUsGaap(row.conceptQName);
    if (local === undefined) continue;
    if (local === SGA_CONCEPT) { sgaRows.push(row); continue; }
    const target = reverseVocab.get(local);
    if (target === undefined) continue;
    const list = groups.get(target) ?? [];
    list.push(row);
    groups.set(target, list);
  }
  // Spec §3 footnote: combined SG&A only fills selling_and_marketing when no separate G&A row exists.
  if (sgaRows.length > 0 && !groups.has("general_and_administrative")) {
    const list = groups.get("selling_and_marketing") ?? [];
    list.push(...sgaRows);
    groups.set("selling_and_marketing", list);
  }

  for (const [target, rows] of groups) {
    const withPeriods = rows
      .map((row) => ({ row, periods: periodsFor(row.sourceLineItemId) }))
      .filter((entry) => entry.periods.length > 0);
    if (withPeriods.length === 0) continue;
    let conflict = false;
    for (let i = 0; i < withPeriods.length && !conflict; i += 1) {
      for (let j = i + 1; j < withPeriods.length; j += 1) {
        if (withPeriods[i]!.periods.some((period) => withPeriods[j]!.periods.includes(period))) { conflict = true; break; }
      }
    }
    if (conflict) {
      demoted.push({
        targetLineItemId: target,
        reason: `overlapping periods across source rows: ${withPeriods.map((entry) => entry.row.sourceLineItemId).join(", ")}`,
      });
      continue;
    }
    for (const entry of withPeriods) {
      consumed.add(entry.row.sourceLineItemId);
      plans.push({
        targetLineItemId: target,
        periodIds: entry.periods,
        members: [{ sourceLineItemId: entry.row.sourceLineItemId, treatment: "add" }],
        reviewDecisionId: `${AUTO_PREMAP_PLAN_PREFIX}${shortHash(`${target}|${entry.periods.join(",")}`)}`,
      });
    }
    mapped.push({
      targetLineItemId: target,
      targetLabel: TARGET_LABELS[target] ?? target,
      sourceRows: withPeriods.map((entry): SourceRowRef => ({
        sourceLineItemId: entry.row.sourceLineItemId, label: entry.row.label, conceptQName: entry.row.conceptQName,
      })),
      periodIds: [...new Set(withPeriods.flatMap((entry) => entry.periods))].sort(periodComparator),
      basis: "concept_vocab",
      reconciliation: "ok",
    });
  }

  // --- Layer 2: revenue streams --------------------------------------------------------------------
  const revenueTotalMapped = mapped.find((entry) => entry.targetLineItemId === "revenue.total");
  const revenueTotalRowId = revenueTotalMapped && revenueTotalMapped.sourceRows.length === 1
    ? revenueTotalMapped.sourceRows[0]!.sourceLineItemId
    : undefined;

  const usedSlugs = new Set<string>();
  let streams: Array<{ id: string; label: string }> = [];
  let streamPlans: StatementMappingPlan[] = [];
  let streamMapped: PremapSummary["mapped"] = [];
  let streamConsumed: string[] = [];

  if (revenueTotalRowId !== undefined) {
    const incomeStatementRows = input.statementViews.income_statement.candidate.rows;
    const revenueRow = incomeStatementRows.find((row) => row.sourceLineItemId === revenueTotalRowId);
    const parentOf = new Map(incomeStatementRows.map((row) => [row.sourceLineItemId, row.parentSourceLineItemId]));
    if (revenueRow !== undefined) {
      const candidates = faceRows.filter((row) =>
        row.statement === "income_statement"
        && row.sourceLineItemId !== revenueTotalRowId
        && reachesTarget(row.sourceLineItemId, revenueTotalRowId, parentOf)
        && isRevenueFamilyConcept(row.conceptQName, revenueRow.conceptQName, []));
      for (const row of candidates) {
        const periods = periodsFor(row.sourceLineItemId);
        if (periods.length === 0) continue;
        const slug = uniqueSlug(row.label, usedSlugs);
        const targetId = `revenue.${slug}`;
        streams.push({ id: slug, label: row.label });
        streamPlans.push({
          targetLineItemId: targetId,
          periodIds: periods,
          members: [{ sourceLineItemId: row.sourceLineItemId, treatment: "add" }],
          reviewDecisionId: `${AUTO_PREMAP_PLAN_PREFIX}${shortHash(`${targetId}|${periods.join(",")}`)}`,
        });
        streamMapped.push({
          targetLineItemId: targetId,
          targetLabel: row.label,
          sourceRows: [{ sourceLineItemId: row.sourceLineItemId, label: row.label, conceptQName: row.conceptQName }],
          periodIds: periods,
          basis: "face_child",
          reconciliation: "ok",
        });
        streamConsumed.push(row.sourceLineItemId);
      }
    }
  }

  const faceChildrenFound = streams.length > 0;

  if (input.decomposition && input.decomposition.schemes.length > 0) {
    if (!faceChildrenFound) {
      // No face children: the driver scheme (if any) is the sole partition of revenue.total into
      // streams; non-driver accepted schemes are category-group material, out of scope here (spec §8).
      const driver = input.decomposition.schemes.find((scheme) => scheme.driver);
      if (driver !== undefined) {
        for (const child of driver.children) {
          const periods = periodsFor(child.childRowId);
          if (periods.length === 0) continue;
          const base = child.residual ? `other_${slugify(driver.axisHint === "presentation-only" ? driver.label : (driver.axisHint.split(":").pop() ?? driver.axisHint))}` : child.label;
          const slug = uniqueSlug(base, usedSlugs);
          const targetId = `revenue.${slug}`;
          streams.push({ id: slug, label: child.label });
          streamPlans.push({
            targetLineItemId: targetId,
            periodIds: periods,
            members: [{ sourceLineItemId: child.childRowId, treatment: "add" }],
            reviewDecisionId: `${AUTO_PREMAP_PLAN_PREFIX}${shortHash(`${targetId}|${periods.join(",")}`)}`,
          });
          streamMapped.push({
            targetLineItemId: targetId,
            targetLabel: child.label,
            sourceRows: [{ sourceLineItemId: child.childRowId, label: child.label, conceptQName: revenueTotalMapped?.sourceRows[0]?.conceptQName ?? "" }],
            periodIds: periods,
            basis: "decomposition_scheme",
            reconciliation: "ok",
          });
          streamConsumed.push(child.childRowId);
        }
      }
    } else {
      // Face children already partition revenue: same-axis schemes are redundant (demoted, logged);
      // different-axis schemes are category-group material and are not injected (spec §4, "record nothing").
      const faceStreamLabels = new Set(streamMapped.map((entry) => normalizeLabel(entry.sourceRows[0]!.label)));
      for (const scheme of input.decomposition.schemes) {
        const nonResidual = scheme.children.filter((child) => !child.residual);
        if (nonResidual.length === 0) continue;
        const matches = nonResidual.filter((child) => faceStreamLabels.has(normalizeLabel(child.label))).length;
        if (matches / nonResidual.length >= 0.5) {
          demoted.push({ targetLineItemId: scheme.targetSourceLineItemId, reason: "axis_already_covered_by_face_children" });
        }
      }
    }
  }

  // Identity guard (spec §4): Σ streams (+ residual) vs revenue.total per historical period.
  if (streamPlans.length > 0) {
    const streamRowIds = streamPlans.flatMap((plan) => plan.members.map((member) => member.sourceLineItemId));
    let gapDetail: string | undefined;
    if (revenueTotalRowId !== undefined) {
      for (const periodId of input.historicalPeriodIds) {
        const totalValue = factValue.get(`${revenueTotalRowId}|${periodId}`);
        if (totalValue === undefined) continue;
        const sum = streamRowIds.reduce((total, id) => total + (factValue.get(`${id}|${periodId}`) ?? 0), 0);
        const gap = Math.abs(totalValue - sum);
        const denom = Math.abs(totalValue);
        const ratio = denom > 0 ? gap / denom : (gap > 0 ? Number.POSITIVE_INFINITY : 0);
        if (ratio > 0.005) {
          gapDetail = `period ${periodId}: streams sum ${sum} vs revenue.total ${totalValue} (gap ${(ratio * 100).toFixed(2)}%)`;
          break;
        }
      }
    }
    if (gapDetail !== undefined) {
      demoted.push({ targetLineItemId: "revenue.total", reason: `stream set demoted: ${gapDetail}` });
      streams = [];
      streamPlans = [];
      streamMapped = [];
      streamConsumed = [];
    }
  }

  for (const id of streamConsumed) consumed.add(id);
  plans.push(...streamPlans);
  mapped.push(...streamMapped);

  // --- Unmapped bookkeeping ------------------------------------------------------------------------
  const mappedTargets = new Set(mapped.map((entry) => entry.targetLineItemId));
  // The whole spine, not just the part the concept vocabulary covers: a target with no vocabulary
  // entry is exactly the one the engine can never place, so it is the one the agent most needs to see.
  const spineTargets = [...CANONICAL_MAPPING_IDS].filter((target) => !mappedTargets.has(target)).sort();
  const unmappedSourceRows: SourceRowRef[] = faceRows
    .filter((row) => !consumed.has(row.sourceLineItemId))
    .map((row) => ({ sourceLineItemId: row.sourceLineItemId, label: row.label, conceptQName: row.conceptQName }))
    .sort((left, right) => left.sourceLineItemId < right.sourceLineItemId ? -1 : left.sourceLineItemId > right.sourceLineItemId ? 1 : 0);

  mapped.sort((left, right) => left.targetLineItemId < right.targetLineItemId ? -1 : left.targetLineItemId > right.targetLineItemId ? 1 : 0);
  plans.sort((left, right) => {
    if (left.targetLineItemId !== right.targetLineItemId) return left.targetLineItemId < right.targetLineItemId ? -1 : 1;
    const leftKey = left.periodIds.join(",");
    const rightKey = right.periodIds.join(",");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  return {
    summary: {
      version: "auto-premap-v1",
      mapped,
      unmapped: { spineTargets, sourceRows: unmappedSourceRows },
      demoted,
    },
    plans,
    streams,
  };
}
