import { cellKey, type CellKey } from "./dsl/graph.ts";
import { sameUnit } from "./dsl/units.ts";
import { quantize } from "./engine.ts";
import type {
  AccountingIdentity,
  Cell,
  DcfCategoryGroup,
  LineItem,
  Period,
  ReconciliationResult,
  ReconciliationStatus,
} from "./types.ts";

export type { AccountingIdentity, ReconciliationResult, ReconciliationStatus } from "./types.ts";

type CalculatedValues = Omit<
  ReconciliationResult,
  "kind" | "identity" | "parentLineItemId" | "category" | "reviewDecisionId" | "ruleId" | "required"
>;

export type ReconciliationInput = {
  periods: readonly Period[];
  lineItems: readonly LineItem[];
  cells: ReadonlyMap<CellKey, Cell>;
  categoryGroups: readonly DcfCategoryGroup[];
};

type SignedTerm = { lineItemId: string; sign: 1 | -1 };

type AccountingRule = {
  ruleId: string;
  identity: AccountingIdentity;
  parentLineItemId: string;
  required: boolean;
  terms: (periodIndex: number, actualPeriods: readonly Period[]) =>
    | {
        kind: "terms";
        terms: SignedTerm[];
        calculate?: (values: readonly number[]) => number;
        requireSameUnit?: boolean;
      }
    | { kind: "not_applicable"; refs: string[]; reason: "no_prior_period" };
};

const term = (lineItemId: string, sign: 1 | -1 = 1): SignedTerm => ({ lineItemId, sign });

/** Fixed presentation order follows the canonical statements into FCFF. */
const ACCOUNTING_RULES: readonly AccountingRule[] = [
  {
    ruleId: "accounting_identity:gross_profit",
    identity: "gross_profit",
    parentLineItemId: "revenue.total",
    required: true,
    terms: () => ({ kind: "terms", terms: [term("cost_of_revenue"), term("gross_profit")] }),
  },
  {
    ruleId: "accounting_identity:operating_expenses_detail",
    identity: "operating_expenses_detail",
    parentLineItemId: "operating_expenses",
    required: true,
    terms: () => ({
      kind: "terms",
      terms: [
        term("research_and_development"),
        term("selling_and_marketing"),
        term("general_and_administrative"),
        term("other_operating_expenses"),
      ],
    }),
  },
  {
    ruleId: "accounting_identity:operating_income",
    identity: "operating_income",
    parentLineItemId: "operating_income",
    required: true,
    terms: () => ({ kind: "terms", terms: [term("gross_profit"), term("operating_expenses", -1)] }),
  },
  {
    ruleId: "accounting_identity:ebitda",
    identity: "ebitda",
    parentLineItemId: "ebitda",
    required: true,
    terms: () => ({ kind: "terms", terms: [term("operating_income"), term("depreciation_amortization")] }),
  },
  {
    ruleId: "accounting_identity:pretax_income",
    identity: "pretax_income",
    parentLineItemId: "pretax_income",
    required: true,
    terms: () => ({
      kind: "terms",
      terms: [
        term("operating_income"),
        term("interest_income"),
        term("interest_expense", -1),
        term("non_operating_income_expense"),
      ],
    }),
  },
  {
    ruleId: "accounting_identity:net_income",
    identity: "net_income",
    parentLineItemId: "net_income",
    required: true,
    terms: () => ({ kind: "terms", terms: [term("pretax_income"), term("income_tax_expense", -1)] }),
  },
  {
    ruleId: "accounting_identity:nopat",
    identity: "nopat",
    parentLineItemId: "nopat",
    required: true,
    terms: () => ({
      kind: "terms",
      terms: [term("operating_income"), term("tax_rate")],
      calculate: ([operatingIncome, taxRate]) => operatingIncome! * (1 - taxRate!),
      requireSameUnit: false,
    }),
  },
  {
    ruleId: "accounting_identity:operating_working_capital",
    identity: "operating_working_capital",
    parentLineItemId: "operating_working_capital",
    required: true,
    terms: () => ({
      kind: "terms",
      terms: [
        term("accounts_receivable"),
        term("inventory"),
        term("other_operating_current_assets"),
        term("accounts_payable", -1),
        term("deferred_revenue", -1),
        term("accrued_operating_liabilities", -1),
        term("other_operating_current_liabilities", -1),
      ],
    }),
  },
  {
    ruleId: "accounting_identity:change_nwc",
    identity: "change_nwc",
    parentLineItemId: "change_nwc",
    required: true,
    terms: (periodIndex, actualPeriods) => {
      const prior = actualPeriods[periodIndex - 1];
      if (prior === undefined) {
        return { kind: "not_applicable", refs: ["operating_working_capital"], reason: "no_prior_period" };
      }
      return {
        kind: "terms",
        terms: [
          term("operating_working_capital"),
          // The prior-period coordinate is resolved specially below.
          term(`operating_working_capital@${prior.id}`, -1),
        ],
      };
    },
  },
  {
    ruleId: "accounting_identity:fcff",
    identity: "fcff",
    parentLineItemId: "fcff",
    required: true,
    terms: () => ({
      kind: "terms",
      terms: [
        term("nopat"),
        term("depreciation_amortization"),
        term("capital_expenditures", -1),
        term("change_nwc", -1),
      ],
    }),
  },
];

/**
 * Reconcile reviewed category groups and canonical accounting identities.
 *
 * Comparison uses max(1e-6 absolute, 1e-9 of the larger magnitude). This is
 * intentionally independent of input order and host locale: it absorbs only
 * floating-point/engine quantization noise, not financially meaningful gaps.
 * Results are ordered by authoritative actual-period order, then category
 * groups (canonical parent order/category/review id), then fixed rule order.
 */
export function reconcileDcf(input: ReconciliationInput): ReconciliationResult[] {
  const actualPeriods = input.periods.filter((period) => period.cls === "actual");
  const itemById = new Map(input.lineItems.map((item) => [item.id, item]));
  const itemOrder = new Map(input.lineItems.map((item) => [item.id, item.order]));
  const groups = [...input.categoryGroups].sort((left, right) =>
    (itemOrder.get(left.parentLineItemId) ?? Number.MAX_SAFE_INTEGER)
      - (itemOrder.get(right.parentLineItemId) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.parentLineItemId, right.parentLineItemId)
    || compareText(left.category, right.category)
    || compareText(left.reviewDecisionId, right.reviewDecisionId)
    || compareText(groupSignature(left), groupSignature(right)));

  const results: ReconciliationResult[] = [];
  actualPeriods.forEach((period, periodIndex) => {
    for (const group of groups) {
      if (!group.periodIds.includes(period.id)) continue;
      const included = group.members
        .filter((member) => member.treatment !== "exclude")
        .map((member) => term(member.lineItemId, member.treatment === "add" ? 1 : -1))
        .sort((left, right) => compareTerms(left, right, itemOrder));
      const common = reconcileTerms(
        period.id,
        group.parentLineItemId,
        included,
        input.cells,
        itemById,
      );
      results.push({
        kind: "category",
        ruleId: categoryRuleId(group),
        required: true,
        parentLineItemId: group.parentLineItemId,
        category: group.category,
        reviewDecisionId: group.reviewDecisionId,
        ...common,
      });
    }

    for (const rule of ACCOUNTING_RULES) {
      const resolved = rule.terms(periodIndex, actualPeriods);
      const common = resolved.kind === "not_applicable"
        ? {
            ...notApplicable(
              period.id,
              rule.parentLineItemId,
              [
                cellKey(rule.parentLineItemId, period.id),
                ...resolved.refs.map((ref) => coordinate(ref, period.id)),
              ],
              input.cells,
            ),
            skipReason: { kind: resolved.reason, refs: [cellKey(rule.parentLineItemId, period.id)] },
          }
        : reconcileTerms(
            period.id,
            rule.parentLineItemId,
            resolved.terms,
            input.cells,
            itemById,
            resolved.calculate,
            resolved.requireSameUnit,
          );
      results.push({
        kind: "accounting_identity",
        ruleId: rule.ruleId,
        required: rule.required,
        identity: rule.identity,
        parentLineItemId: rule.parentLineItemId,
        ...common,
      });
    }
  });
  return results;
}

function reconcileTerms(
  periodId: string,
  parentLineItemId: string,
  terms: readonly SignedTerm[],
  cells: ReadonlyMap<CellKey, Cell>,
  itemById: ReadonlyMap<string, LineItem>,
  calculate?: (values: readonly number[]) => number,
  requireSameUnit = true,
): CalculatedValues {
  const parentRef = cellKey(parentLineItemId, periodId);
  const termRefs = terms.map((candidate) => coordinate(candidate.lineItemId, periodId));
  const refs = [parentRef, ...termRefs];
  const parentItem = usableItem(itemById.get(parentLineItemId));
  const memberItems = terms.map((candidate) => usableItem(itemById.get(baseLineItemId(candidate.lineItemId))));
  if (parentItem === undefined || terms.length === 0 || memberItems.some((item) => item === undefined)) {
    const absent = [
      ...(parentItem === undefined ? [parentRef as string] : []),
      ...termRefs.filter((_, index) => memberItems[index] === undefined),
    ];
    return { ...notApplicable(periodId, parentLineItemId, refs, cells),
      ...(absent.length > 0 ? { skipReason: { kind: "missing_line_item" as const, refs: absent } } : {}) };
  }
  if (requireSameUnit) {
    const mismatched = terms.flatMap((candidate, index) =>
      sameUnit(parentItem.unit, memberItems[index]!.unit) ? [] : [termRefs[index]!]);
    if (mismatched.length > 0) {
      return { ...notApplicable(periodId, parentLineItemId, refs, cells),
        skipReason: { kind: "unit_mismatch", refs: mismatched } };
    }
  }

  const actual = finiteValue(cells.get(parentRef));
  const values = termRefs.map((ref) => finiteValue(cells.get(ref)));
  if (actual === null || values.some((value) => value === null)) {
    return {
      periodId,
      status: "insufficient_data",
      actual,
      calculated: null,
      residual: null,
      difference: null,
      tolerance: comparisonTolerance(actual, null),
      refs,
      skipReason: { kind: "missing_values", refs: [
        ...(actual === null ? [parentRef as string] : []),
        ...termRefs.filter((_, index) => values[index] === null),
      ] },
    };
  }

  const numericValues = values as number[];
  const calculated = quantize(calculate === undefined
    ? numericValues.reduce((sum, value, index) => sum + value * terms[index]!.sign, 0)
    : calculate(numericValues));
  const residual = canonical(quantize(actual - calculated));
  const tolerance = comparisonTolerance(actual, calculated);
  return {
    periodId,
    status: Math.abs(residual) <= tolerance ? "passed" : "failed",
    actual,
    calculated,
    residual,
    difference: residual,
    tolerance,
    refs,
  };
}

function notApplicable(
  periodId: string,
  parentLineItemId: string,
  refs: string[],
  cells: ReadonlyMap<CellKey, Cell>,
): CalculatedValues {
  const actual = finiteValue(cells.get(cellKey(parentLineItemId, periodId)));
  return {
    periodId,
    status: "not_applicable",
    actual,
    calculated: null,
    residual: null,
    difference: null,
    tolerance: comparisonTolerance(actual, null),
    refs,
  };
}

function usableItem(item: LineItem | undefined): LineItem | undefined {
  return item === undefined || item.section.startsWith("source_") ? undefined : item;
}

function finiteValue(cell: Cell | undefined): number | null {
  return cell?.value !== null && cell?.value !== undefined && Number.isFinite(cell.value)
    ? canonical(cell.value)
    : null;
}

function comparisonTolerance(actual: number | null, calculated: number | null): number {
  const scale = Math.max(Math.abs(actual ?? 0), Math.abs(calculated ?? 0));
  return quantize(Math.max(1e-6, scale * 1e-9));
}

function coordinate(lineItemId: string, currentPeriodId: string): string {
  return lineItemId.includes("@") ? lineItemId : cellKey(lineItemId, currentPeriodId);
}

function baseLineItemId(lineItemId: string): string {
  const at = lineItemId.lastIndexOf("@");
  return at === -1 ? lineItemId : lineItemId.slice(0, at);
}

function canonical(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function compareTerms(
  left: SignedTerm,
  right: SignedTerm,
  itemOrder: ReadonlyMap<string, number>,
): number {
  return (itemOrder.get(baseLineItemId(left.lineItemId)) ?? Number.MAX_SAFE_INTEGER)
    - (itemOrder.get(baseLineItemId(right.lineItemId)) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.lineItemId, right.lineItemId)
    || left.sign - right.sign;
}

function groupSignature(group: DcfCategoryGroup): string {
  return group.members
    .map((member) => `${member.lineItemId}:${member.treatment}`)
    .sort(compareText)
    .join("\u0000");
}

function categoryRuleId(group: DcfCategoryGroup): string {
  return `category:${group.parentLineItemId}:${group.category}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Why a required identity failed, in the terms the fix is made in.
 *
 * A failed check reports that a parent and the sum of its components disagree. That is enough to
 * know something is wrong and nothing about WHICH component is wrong, so an agent goes reading the
 * workbook component by component to find out — ten consecutive reads in one AMZN run, and it never
 * got there, because the values it needed sat behind a section filter it kept getting wrong.
 *
 * The diagnosis is already computable here. A component stored under the opposite polarity to its
 * siblings — an income-positive XBRL concept like `OtherOperatingIncomeExpenseNet` landing among
 * expense-positive rows — does not merely perturb the sum: it moves it by exactly TWICE its own
 * value, because the term is added where it should have been subtracted. So a residual that equals
 * 2x a component names that component, and the fix is a sign, not a search.
 *
 * This accuses rather than corrects, deliberately. "Other operating expense (income), net" is
 * genuinely income in some years, so flipping on the sign of the value would corrupt those years;
 * only the author of the mapping knows which convention the row was meant to carry.
 */
/**
 * Each canonical row's accounting identities, rendered as the equation the engine will check.
 *
 * Derived from ACCOUNTING_RULES rather than written out again, because the whole point is that the
 * mapper is judged by these exact rules: a hand-copied list would drift from them silently, which is
 * the failure this is meant to prevent one level up. Only the fixed-term identities render — the
 * period-relative ones say nothing useful about a single row.
 */
export function identitiesByLineItem(): Map<string, string[]> {
  const byItem = new Map<string, string[]>();
  for (const rule of ACCOUNTING_RULES) {
    const built = rule.terms(1, []);
    if (built.kind !== "terms") continue;
    const equation = `${rule.parentLineItemId} = ` + built.terms
      .map((entry, index) => index === 0
        ? (entry.sign === 1 ? entry.lineItemId : `-${entry.lineItemId}`)
        : `${entry.sign === 1 ? "+" : "-"} ${entry.lineItemId}`)
      .join(" ");
    for (const id of [rule.parentLineItemId, ...built.terms.map((entry) => entry.lineItemId)]) {
      byItem.set(id, [...(byItem.get(id) ?? []), equation]);
    }
  }
  return byItem;
}

export function explainFailedIdentity(
  failure: { residual: number; tolerance: number },
  components: readonly { lineItemId: string; value: number }[],
): { components: readonly { lineItemId: string; value: number }[]; polaritySuspects: string[] } {
  const polaritySuspects = components
    .filter((component) => Math.abs(failure.residual - 2 * component.value) <= failure.tolerance)
    .map((component) => component.lineItemId);
  return { components, polaritySuspects };
}
