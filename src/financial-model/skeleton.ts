import { FinancialModelError } from "./errors.ts";
import { buildGrid } from "./periodGrid.ts";
import { compatibleUnit } from "./dsl/units.ts";
import type { Formula } from "./engine.ts";
import type {
  DcfCategoryGroup,
  LineItem,
  LineItemRole,
  Period,
  PreparedStatementRow,
  StatementMappingPlan,
} from "./types.ts";

export type Skeleton = {
  /** Creation-time authoritative grid used by coverage compilers. */
  periods: Period[];
  lineItems: LineItem[];
  formulas: Formula[];
};

type CreateSkeletonInput = { currency: string; periods: readonly Period[] };
type AddRevenueStreamInput = { id: string; label: string };
type AddDcfDetailLineItemInput = { parentLineItemId: string; id: string; label: string };

export const SAFE_DCF_DETAIL_PARENTS = new Set([
  "revenue",
  "cost_of_revenue",
  "operating_expenses",
  "total_current_assets",
  "total_current_liabilities",
  "operating_working_capital",
]);

const FIXED_ROLES: readonly Exclude<LineItemRole, "revenue_stream" | "bridge_other" | "none">[] = [
  "revenue_root",
  "revenue_total",
  "operating_income",
  "tax_rate",
  "nopat",
  "depreciation_amortization",
  "ebitda",
  "capex",
  "operating_working_capital",
  "change_nwc",
  "fcff",
  "wacc",
  "terminal_growth",
  "exit_multiple",
  "cash_available_for_bridge",
  "non_operating_investments",
  "debt",
  "lease_liabilities",
  "preferred_equity",
  "non_controlling_interests",
  "diluted_shares",
];

const REVENUE_TOTAL_FORECAST =
  "LAG(revenue.total, 1) * (1 + growth.revenue.total)";
const OPERATING_NWC_FORECAST =
  "revenue.total * ratio.operating_nwc_to_revenue";

/**
 * The spine targets the model cannot be built without: every one is read by a forecast formula or an
 * accounting identity below. A mapping decision must place each of these or say in writing why the
 * issuer has none — being wrong here changes the valuation.
 *
 * The working-capital components are here for a reason worth stating: `operating_working_capital` is
 * derived from them by an identity rather than mapped directly, so what counts as working capital
 * stays declared and checkable instead of becoming an invisible judgment inside one number.
 */
export const REQUIRED_MAPPING_IDS = new Set([
  // Forecast formula inputs.
  "revenue.total",
  "operating_income",
  "pretax_income",
  "income_tax_expense",
  "depreciation_amortization",
  "capital_expenditures",
  // Operating working capital identity.
  "accounts_receivable",
  "inventory",
  "other_operating_current_assets",
  "accounts_payable",
  "deferred_revenue",
  "accrued_operating_liabilities",
  "other_operating_current_liabilities",
]);

/**
 * Every spine target a statement mapping MAY claim. Beyond REQUIRED_MAPPING_IDS these are optional:
 * useful when the issuer reports them, not worth a written justification when it does not. Anything
 * an issuer reports and this list does not name is not lost — the unified statements keep it, and a
 * material one belongs in detailRows.
 */
export const CANONICAL_MAPPING_IDS = new Set([
  "revenue.total",
  "operating_income",
  "depreciation_amortization",
  "capital_expenditures",
  "cash_available_for_bridge",
  "non_operating_investments",
  "debt",
  "lease_liabilities",
  "preferred_equity",
  "non_controlling_interests",
  "diluted_shares",
  "cost_of_revenue",
  "gross_profit",
  "research_and_development",
  "selling_and_marketing",
  "general_and_administrative",
  "other_operating_expenses",
  "operating_expenses",
  "interest_income",
  "interest_expense",
  "non_operating_income_expense",
  "pretax_income",
  "income_tax_expense",
  "net_income",
  "net_income_attributable_nci",
  "diluted_eps",
  "cash_and_equivalents",
  "restricted_cash",
  "short_term_investments",
  "accounts_receivable",
  "inventory",
  "other_operating_current_assets",
  "accounts_payable",
  "deferred_revenue",
  "accrued_operating_liabilities",
  "other_operating_current_liabilities",
  "property_plant_equipment",
  "total_current_assets",
  "total_assets",
  "total_current_liabilities",
  "shareholders_equity",
  "operating_cash_flow",
  "reported_change_operating_assets_liabilities",
  "asset_sale_proceeds",
  "acquisitions",
  "net_investing_cash_flow",
  "debt_issuance",
  "debt_repayment",
  "dividends",
  "share_repurchases",
]);

function invalid(message: string): never {
  throw new FinancialModelError("invalid_formula", message);
}

function cloneSkeleton(skeleton: Skeleton): Skeleton {
  return {
    periods: skeleton.periods.map((period) => ({ ...period })),
    lineItems: skeleton.lineItems.map((item) => ({ ...item, unit: { ...item.unit } })),
    formulas: skeleton.formulas.map((formula) => ({
      ...formula,
      ...(formula.periodIds === undefined ? {} : { periodIds: [...formula.periodIds] }),
    })),
  };
}

export function createSkeleton(input: CreateSkeletonInput): Skeleton {
  buildGrid(input.periods);

  const currency = { kind: "currency" as const, code: input.currency };
  const percent = { kind: "percent" as const };
  const ratio = { kind: "ratio" as const };
  const shares = { kind: "shares" as const };
  const perShare = { kind: "per_share" as const, code: input.currency };
  const lineItems: LineItem[] = [];
  let order = 0;

  const add = (item: Omit<LineItem, "order">): void => {
    lineItems.push({ ...item, order: order++ });
  };

  add({ id: "revenue", label: "Revenue", role: "revenue_root", unit: currency, section: "revenue", historical: "none", forecast: "none" });
  add({ id: "revenue.total", label: "Total revenue", parentId: "revenue", role: "revenue_total", unit: currency, section: "revenue", historical: "actual", forecast: "formula" });
  add({ id: "growth.revenue.total", label: "Total revenue growth", parentId: "revenue.total", role: "none", unit: percent, section: "revenue", historical: "formula", forecast: "assumption" });
  add({ id: "margin.operating", label: "Operating margin", role: "none", unit: percent, section: "operations", historical: "formula", forecast: "assumption" });
  add({ id: "operating_income", label: "Operating income", role: "operating_income", unit: currency, section: "operations", historical: "actual", forecast: "formula" });
  add({ id: "tax_rate", label: "Operating tax rate", role: "tax_rate", unit: percent, section: "operations", historical: "formula", forecast: "assumption" });
  add({ id: "nopat", label: "NOPAT", role: "nopat", unit: currency, section: "operations", historical: "formula", forecast: "formula" });
  add({ id: "depreciation_amortization", label: "Depreciation and amortization", role: "depreciation_amortization", unit: currency, section: "operations", historical: "actual", forecast: "formula" });
  add({ id: "ratio.da_to_revenue", label: "D&A to revenue", role: "none", unit: ratio, section: "operations", historical: "formula", forecast: "assumption" });
  add({ id: "ebitda", label: "EBITDA", role: "ebitda", unit: currency, section: "operations", historical: "formula", forecast: "formula" });
  add({ id: "capital_expenditures", label: "Capital expenditures", role: "capex", unit: currency, section: "operations", historical: "actual", forecast: "formula" });
  add({ id: "ratio.capex_to_revenue", label: "Capital expenditures to revenue", role: "none", unit: ratio, section: "operations", historical: "formula", forecast: "assumption" });
  add({ id: "operating_working_capital", label: "Operating working capital", role: "operating_working_capital", unit: currency, section: "operations", historical: "formula", forecast: "formula" });
  add({ id: "ratio.operating_nwc_to_revenue", label: "Operating working capital to revenue", role: "none", unit: ratio, section: "operations", historical: "formula", forecast: "assumption" });
  add({ id: "change_nwc", label: "Change in operating working capital", role: "change_nwc", unit: currency, section: "operations", historical: "formula", forecast: "formula" });
  add({ id: "fcff", label: "Free cash flow to firm", role: "fcff", unit: currency, section: "dcf", historical: "formula", forecast: "formula" });
  add({ id: "wacc", label: "WACC", role: "wacc", unit: percent, section: "dcf", historical: "none", forecast: "assumption" });
  add({ id: "terminal_growth", label: "Terminal growth", role: "terminal_growth", unit: percent, section: "dcf", historical: "none", forecast: "assumption" });
  add({ id: "exit_multiple", label: "Exit multiple", role: "exit_multiple", unit: ratio, section: "dcf", historical: "none", forecast: "assumption" });

  const incomeRows: Array<[string, string, typeof currency | typeof perShare]> = [
    ["cost_of_revenue", "Cost of revenue", currency],
    ["gross_profit", "Gross profit", currency],
    ["research_and_development", "Research and development", currency],
    ["selling_and_marketing", "Selling and marketing", currency],
    ["general_and_administrative", "General and administrative", currency],
    ["other_operating_expenses", "Other operating expenses", currency],
    ["operating_expenses", "Operating expenses", currency],
    ["interest_income", "Interest income", currency],
    ["interest_expense", "Interest expense", currency],
    ["non_operating_income_expense", "Non-operating income and expense", currency],
    ["pretax_income", "Pretax income", currency],
    ["income_tax_expense", "Income tax expense", currency],
    ["net_income", "Net income", currency],
    ["net_income_attributable_nci", "Net income attributable to non-controlling interests", currency],
    ["diluted_eps", "Diluted earnings per share", perShare],
  ];
  const balanceRows: Array<[string, string]> = [
    ["cash_and_equivalents", "Cash and cash equivalents"],
    ["restricted_cash", "Restricted cash"],
    ["short_term_investments", "Short-term investments"],
    ["accounts_receivable", "Accounts receivable"],
    ["inventory", "Inventory"],
    ["other_operating_current_assets", "Other operating current assets"],
    ["accounts_payable", "Accounts payable"],
    ["deferred_revenue", "Deferred revenue"],
    ["accrued_operating_liabilities", "Accrued operating liabilities"],
    ["other_operating_current_liabilities", "Other operating current liabilities"],
    ["property_plant_equipment", "Property, plant and equipment"],
    ["total_current_assets", "Total current assets"],
    ["total_assets", "Total assets"],
    ["total_current_liabilities", "Total current liabilities"],
    ["shareholders_equity", "Shareholders' equity"],
  ];
  const cashFlowRows: Array<[string, string]> = [
    ["operating_cash_flow", "Operating cash flow"],
    ["reported_change_operating_assets_liabilities", "Reported change in operating assets and liabilities"],
    ["asset_sale_proceeds", "Asset sale proceeds"],
    ["acquisitions", "Acquisitions"],
    ["net_investing_cash_flow", "Net investing cash flow"],
    ["debt_issuance", "Debt issuance"],
    ["debt_repayment", "Debt repayment"],
    ["dividends", "Dividends"],
    ["share_repurchases", "Share repurchases"],
  ];

  for (const [id, label, unit] of incomeRows) {
    add({ id, label, role: "none", unit, section: "history", historical: "none", forecast: "none" });
  }
  for (const [id, label] of [...balanceRows, ...cashFlowRows]) {
    add({ id, label, role: "none", unit: currency, section: "history", historical: "none", forecast: "none" });
  }

  const bridgeRows: Array<[string, string, LineItemRole, typeof currency | typeof shares]> = [
    ["cash_available_for_bridge", "Cash available for equity bridge", "cash_available_for_bridge", currency],
    ["non_operating_investments", "Non-operating investments", "non_operating_investments", currency],
    ["debt", "Debt", "debt", currency],
    ["lease_liabilities", "Lease liabilities", "lease_liabilities", currency],
    ["preferred_equity", "Preferred equity", "preferred_equity", currency],
    ["non_controlling_interests", "Non-controlling interests", "non_controlling_interests", currency],
    ["diluted_shares", "Diluted shares", "diluted_shares", shares],
  ];
  for (const [id, label, role, unit] of bridgeRows) {
    add({ id, label, role, unit, section: "dcf", historical: "actual", forecast: "none" });
  }

  const actualIds = input.periods.filter((period) => period.cls === "actual").map((period) => period.id);
  const forecastIds = input.periods.filter((period) => period.cls === "forecast").map((period) => period.id);
  const formulas: Formula[] = [];
  const formula = (
    lineItemId: string,
    appliesTo: "historical" | "forecast",
    source: string,
    periodIds: readonly string[],
  ): void => {
    if (periodIds.length > 0) formulas.push({ lineItemId, appliesTo, source, periodIds: [...periodIds] });
  };

  formula("growth.revenue.total", "historical", "YOY(revenue.total)", actualIds);
  formula("margin.operating", "historical", "operating_income / revenue.total", actualIds);
  formula("tax_rate", "historical", "income_tax_expense / pretax_income", actualIds);
  formula("nopat", "historical", "operating_income * (1 - tax_rate)", actualIds);
  formula("ratio.da_to_revenue", "historical", "depreciation_amortization / revenue.total", actualIds);
  formula("ebitda", "historical", "operating_income + depreciation_amortization", actualIds);
  formula("ratio.capex_to_revenue", "historical", "capital_expenditures / revenue.total", actualIds);
  formula("ratio.operating_nwc_to_revenue", "historical", "operating_working_capital / revenue.total", actualIds);
  formula("change_nwc", "historical", "operating_working_capital - LAG(operating_working_capital, 1)", actualIds);
  formula("fcff", "historical", "nopat + depreciation_amortization - capital_expenditures - change_nwc", actualIds);

  formula("revenue.total", "forecast", REVENUE_TOTAL_FORECAST, forecastIds);
  formula("operating_income", "forecast", "revenue.total * margin.operating", forecastIds);
  formula("nopat", "forecast", "operating_income * (1 - tax_rate)", forecastIds);
  formula("depreciation_amortization", "forecast", "revenue.total * ratio.da_to_revenue", forecastIds);
  formula("ebitda", "forecast", "operating_income + depreciation_amortization", forecastIds);
  formula("capital_expenditures", "forecast", "revenue.total * ratio.capex_to_revenue", forecastIds);
  formula("operating_working_capital", "forecast", OPERATING_NWC_FORECAST, forecastIds);
  formula("change_nwc", "forecast", "operating_working_capital - LAG(operating_working_capital, 1)", forecastIds);
  formula("fcff", "forecast", "nopat + depreciation_amortization - capital_expenditures - change_nwc", forecastIds);

  const skeleton: Skeleton = {
    periods: input.periods.map((period) => ({ ...period })),
    lineItems,
    formulas,
  };
  validateRoleCardinality(skeleton.lineItems);
  return skeleton;
}

export function addSourceStatementRows(
  skeleton: Skeleton,
  rows: readonly PreparedStatementRow[],
): Skeleton {
  const next = cloneSkeleton(skeleton);
  const existing = new Set(next.lineItems.map((item) => item.id));
  const seen = new Set<string>();
  const prefixes = {
    income_statement: "source.income_statement.",
    balance_sheet: "source.balance_sheet.",
    cash_flow_statement: "source.cash_flow_statement.",
  } as const;
  const sections = {
    income_statement: "source_income_statement",
    balance_sheet: "source_balance_sheet",
    cash_flow_statement: "source_cash_flow",
  } as const;
  const statementRank = { income_statement: 0, balance_sheet: 1, cash_flow_statement: 2 } as const;

  const ordered = [...rows].sort((left, right) =>
    statementRank[left.statement] - statementRank[right.statement]
    || left.order - right.order
    || compareText(left.sourceLineItemId, right.sourceLineItemId));
  for (const row of ordered) {
    if (seen.has(row.sourceLineItemId) || existing.has(row.sourceLineItemId)) {
      invalid(`duplicate source line item: ${row.sourceLineItemId}`);
    }
    if (!row.sourceLineItemId.startsWith(prefixes[row.statement])
      || row.sourceLineItemId.length === prefixes[row.statement].length) {
      invalid(`source line item is outside its reserved namespace: ${row.sourceLineItemId}`);
    }
    if (!Number.isFinite(row.order)) invalid(`invalid source row order: ${row.sourceLineItemId}`);
    seen.add(row.sourceLineItemId);
    existing.add(row.sourceLineItemId);
    next.lineItems.push({
      id: row.sourceLineItemId,
      label: row.label,
      role: "none",
      unit: { ...row.unit },
      section: sections[row.statement],
      order: row.order,
      historical: "actual",
      forecast: "none",
    });
  }
  return next;
}

export function addRevenueStream(
  skeleton: Skeleton,
  input: AddRevenueStreamInput,
): Skeleton {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(input.id)) {
    invalid(`invalid revenue stream slug: ${input.id}`);
  }
  if (input.label.trim().length === 0) invalid("revenue stream label must not be empty");

  const next = cloneSkeleton(skeleton);
  const valueId = `revenue.${input.id}`;
  const growthId = `growth.revenue.${input.id}`;
  const ids = new Set(next.lineItems.map((item) => item.id));
  if (ids.has(valueId) || ids.has(growthId)) invalid(`revenue stream already exists: ${input.id}`);

  const revenueRoot = next.lineItems.find((item) => item.role === "revenue_root");
  const revenueTotal = next.lineItems.find((item) => item.role === "revenue_total");
  if (!revenueRoot || !revenueTotal || revenueTotal.unit.kind !== "currency") {
    invalid("the fixed revenue spine is missing or invalid");
  }
  const maxOrder = next.lineItems.reduce((max, item) => Math.max(max, item.order), -1);
  next.lineItems.push(
    {
      id: valueId,
      label: input.label,
      parentId: revenueRoot.id,
      role: "revenue_stream",
      unit: { ...revenueTotal.unit },
      section: "revenue",
      order: maxOrder + 1,
      historical: "actual",
      forecast: "formula",
    },
    {
      id: growthId,
      label: `${input.label} growth`,
      parentId: valueId,
      role: "none",
      unit: { kind: "percent" },
      section: "revenue",
      order: maxOrder + 2,
      historical: "formula",
      forecast: "assumption",
    },
  );
  const axes = periodAxes(next);
  const actualIds = axes.historical;
  const forecastIds = axes.forecast;
  if (actualIds.length > 0) {
    next.formulas.push({ lineItemId: growthId, appliesTo: "historical", source: `YOY(${valueId})`, periodIds: actualIds });
  }
  if (forecastIds.length > 0) {
    next.formulas.push({
      lineItemId: valueId,
      appliesTo: "forecast",
      source: `LAG(${valueId}, 1) * (1 + ${growthId})`,
      periodIds: forecastIds,
    });
  }
  return next;
}

/** Adds one DCF-table detail row without importing a raw source-statement row. */
export function addDcfDetailLineItem(
  skeleton: Skeleton,
  input: AddDcfDetailLineItemInput,
): Skeleton {
  if (input.parentLineItemId === "revenue") invalid(`line items cannot be added under: ${input.parentLineItemId}`);
  const parent = skeleton.lineItems.find((item) => item.id === input.parentLineItemId);
  if (!parent || isSourceRow(parent)) invalid(`unknown DCF detail parent: ${input.parentLineItemId}`);
  // A revenue stream may carry its own pieces (revenue.product.iphone): the stream tree mirrors the
  // issuer's member tree. Everything else stays restricted to the safe parents.
  if (!SAFE_DCF_DETAIL_PARENTS.has(input.parentLineItemId) && parent.role !== "revenue_stream") {
    invalid(`line items cannot be added under: ${input.parentLineItemId}`);
  }
  const prefix = `${parent.id}.`;
  const slug = input.id.startsWith(prefix) ? input.id.slice(prefix.length) : input.id;
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(slug)) invalid(`invalid DCF detail slug: ${slug}`);
  if (input.label.trim().length === 0) invalid("DCF detail label must not be empty");
  const id = `${parent.id}.${slug}`;
  if (skeleton.lineItems.some((item) => item.id === id)) invalid(`line item already exists: ${id}`);

  const next = cloneSkeleton(skeleton);
  const order = Math.max(...next.lineItems.map((item) => item.order), -1) + 1;
  next.lineItems.push({
    id,
    label: input.label,
    parentId: parent.id,
    role: "none",
    unit: structuredClone(parent.unit),
    section: parent.section,
    order,
    historical: "actual",
    forecast: "none",
  });
  return next;
}

export function validateRoleCardinality(lineItems: readonly LineItem[]): void {
  const knownRoles = new Set<LineItemRole>([
    ...FIXED_ROLES,
    "revenue_stream",
    "bridge_other",
    "none",
  ]);
  for (const item of lineItems) {
    if (!knownRoles.has(item.role)) invalid(`unknown line-item role: ${String(item.role)}`);
  }
  for (const role of FIXED_ROLES) {
    const count = lineItems.filter((item) => item.role === role).length;
    if (count !== 1) invalid(`role ${role} must occur exactly once, received ${count}`);
  }
}

export function applyStatementMappingPlans(
  skeleton: Skeleton,
  plans: readonly StatementMappingPlan[],
): Skeleton {
  const ordered = normalizePlanOrder(skeleton, plans, (plan) => plan.targetLineItemId);
  validatePlanOutputCoverage(ordered, (plan) => plan.targetLineItemId);
  let next = cloneSkeleton(skeleton);

  for (const plan of ordered) {
    const periodIds = validatePeriodIds(next, plan.periodIds, "actual");
    const target = requireLineItem(next, plan.targetLineItemId);
    const agentDetailTarget = target.parentId !== undefined
      && SAFE_DCF_DETAIL_PARENTS.has(target.parentId)
      && (target.role === "none"
        || (target.parentId === "revenue" && target.role === "revenue_stream"));
    if ((!CANONICAL_MAPPING_IDS.has(target.id) && !agentDetailTarget) || isSourceRow(target)) {
      invalid(`invalid statement mapping target: ${target.id}`);
    }
    const members = validateMembers(
      next,
      plan.members,
      (member) => member.sourceLineItemId,
      (item) => isSourceRow(item),
      "statement mapping",
    );
    const included = members.filter((member) => member.treatment !== "exclude");
    if (included.length === 0) invalid(`statement mapping for ${target.id} has no included members`);
    const source = signedFormula(next, included.map((member) => ({
      id: member.sourceLineItemId,
      sign: member.treatment === "add" ? "add" as const : "subtract" as const,
    })));
    next = replaceFormulaCoverage(next, target.id, "historical", periodIds, source, new Set());
    next.lineItems = next.lineItems.map((item) => item.id === target.id ? { ...item, historical: "formula" } : item);
  }
  return next;
}

/**
 * Validates arbitrary reviewed DCF category groups. Historical coverage remains
 * an independent reconciliation view; forecast coverage owns the parent formula.
 */
export function applyDcfCategoryGroups(
  skeleton: Skeleton,
  groups: readonly DcfCategoryGroup[],
): Skeleton {
  const ordered = normalizePlanOrder(
    skeleton,
    groups,
    (group) => `${group.parentLineItemId}\u0000${group.category}`,
  );
  validatePlanOutputCoverage(
    ordered,
    (group) => `${group.parentLineItemId}\u0000${group.category}`,
  );
  const forecastOwners = new Set<string>();
  let next = cloneSkeleton(skeleton);

  for (const group of ordered) {
    if (group.category.trim().length === 0) invalid("DCF category must not be empty");
    if (group.reviewDecisionId.trim().length === 0) invalid("DCF category group requires reviewDecisionId");
    const periodIds = validatePeriodIds(next, group.periodIds);
    const parent = requireLineItem(next, group.parentLineItemId);
    if (isSourceRow(parent)) invalid(`DCF category parent cannot be a source row: ${parent.id}`);
    const members = validateMembers(
      next,
      group.members,
      (member) => member.lineItemId,
      (item) => !isSourceRow(item),
      "DCF category",
    );
    const included = members.filter((member) => member.treatment !== "exclude");
    if (included.length === 0) invalid(`DCF category ${group.category} has no included members`);
    for (const member of members) {
      const item = requireLineItem(next, member.lineItemId);
      if (item.id === parent.id) invalid(`DCF category ${group.category} cannot contain its parent`);
      if (!compatibleUnit(item.unit, parent.unit)) {
        invalid(`DCF category member has incompatible units: ${item.id}`);
      }
    }
    const source = signedFormula(next, included.map((member) => ({
      id: member.lineItemId,
      sign: member.treatment === "add" ? "add" as const : "subtract" as const,
    })));
    const historicalIds = periodIds.filter((periodId) =>
      next.periods.find((period) => period.id === periodId)?.cls !== "forecast");
    const uncoveredHistoricalIds = parent.historical === "formula"
      ? historicalIds.filter((periodId) => !next.formulas.some((formula) =>
          formula.lineItemId === parent.id
          && formula.appliesTo === "historical"
          && (formula.periodIds ?? periodAxes(next).historical).includes(periodId)))
      : [];
    if (uncoveredHistoricalIds.length > 0) {
      next = replaceFormulaCoverage(
        next,
        parent.id,
        "historical",
        uncoveredHistoricalIds,
        source,
        new Set(),
      );
    }
    const forecastIds = periodIds.filter((periodId) =>
      next.periods.find((period) => period.id === periodId)?.cls === "forecast");
    for (const periodId of forecastIds) {
      const owner = `${parent.id}\u0000${periodId}`;
      if (forecastOwners.has(owner)) invalid(`ambiguous forecast DCF category coverage: ${parent.id} ${periodId}`);
      forecastOwners.add(owner);
    }
    if (forecastIds.length > 0) {
      next = replaceFormulaCoverage(
        next,
        parent.id,
        "forecast",
        forecastIds,
        source,
        new Set([REVENUE_TOTAL_FORECAST, OPERATING_NWC_FORECAST]),
      );
      next.lineItems = next.lineItems.map((item) => item.id === parent.id
        ? { ...item, forecast: "formula" }
        : item);
    }
  }
  return next;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireLineItem(skeleton: Skeleton, id: string): LineItem {
  const item = skeleton.lineItems.find((candidate) => candidate.id === id);
  if (!item) invalid(`unknown line item: ${id}`);
  return item;
}

function isSourceRow(item: LineItem): boolean {
  return item.section === "source_income_statement"
    || item.section === "source_balance_sheet"
    || item.section === "source_cash_flow";
}

function normalizePlanOrder<T>(
  skeleton: Skeleton,
  plans: readonly T[],
  identity: (plan: T) => string,
): T[] {
  const axes = periodAxes(skeleton);
  const position = new Map(axes.ordered.map((periodId, index) => [periodId, index]));
  return [...plans].sort((left, right) => {
    const leftPeriods = [...periodIdentity(left)].sort((a, b) =>
      (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER));
    const rightPeriods = [...periodIdentity(right)].sort((a, b) =>
      (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER));
    const first = (position.get(leftPeriods[0] ?? "") ?? Number.MAX_SAFE_INTEGER)
      - (position.get(rightPeriods[0] ?? "") ?? Number.MAX_SAFE_INTEGER);
    if (first !== 0) return first;
    const semantic = compareText(identity(left), identity(right));
    if (semantic !== 0) return semantic;
    return compareText(leftPeriods.join("\u0000"), rightPeriods.join("\u0000"));
  });
}

function periodIdentity(plan: unknown): string[] {
  return (plan as { periodIds: string[] }).periodIds;
}

function validatePlanOutputCoverage<T>(plans: readonly T[], target: (plan: T) => string): void {
  const covered = new Set<string>();
  for (const plan of plans) {
    for (const periodId of periodIdentity(plan)) {
      const key = `${target(plan)}\u0000${periodId}`;
      if (covered.has(key)) invalid(`overlapping plan output coverage: ${target(plan)} ${periodId}`);
      covered.add(key);
    }
  }
}

function validatePeriodIds(
  skeleton: Skeleton,
  ids: readonly string[],
  requiredClass?: "actual" | "forecast",
): string[] {
  if (ids.length === 0) invalid("plan period coverage must not be empty");
  const axes = periodAxes(skeleton);
  const actual = new Set(axes.historical);
  const forecast = new Set(axes.forecast);
  const byId = new Map(axes.ordered.map((periodId, index) => [periodId, index]));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) invalid(`duplicate period in plan: ${id}`);
    if (!byId.has(id)) invalid(`unknown period in plan: ${id}`);
    const matchesClass = requiredClass === undefined
      || (requiredClass === "actual" ? actual.has(id) : forecast.has(id));
    if (!matchesClass) {
      invalid(`incompatible period for plan: ${id}`);
    }
    seen.add(id);
  }
  return [...ids].sort((left, right) => byId.get(left)! - byId.get(right)!);
}

function validateMembers<T>(
  skeleton: Skeleton,
  members: readonly T[],
  idOf: (member: T) => string,
  permitted: (item: LineItem) => boolean,
  kind: string,
): T[] {
  const seen = new Set<string>();
  for (const member of members) {
    const id = idOf(member);
    if (seen.has(id)) invalid(`duplicate ${kind} member: ${id}`);
    const item = skeleton.lineItems.find((candidate) => candidate.id === id);
    if (!item) invalid(`unknown ${kind} member: ${id}`);
    if (!permitted(item)) invalid(`invalid ${kind} member: ${id}`);
    seen.add(id);
  }
  return [...members];
}

function signedFormula(
  skeleton: Skeleton,
  terms: readonly { id: string; sign: "add" | "subtract" }[],
): string {
  const order = new Map(skeleton.lineItems.map((item) => [item.id, item.order]));
  const sorted = [...terms].sort((left, right) =>
    (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.id, right.id));
  return sorted.map((term, index) => {
    if (index === 0) return term.sign === "add" ? term.id : `-${term.id}`;
    return term.sign === "add" ? ` + ${term.id}` : ` - ${term.id}`;
  }).join("");
}

function replaceFormulaCoverage(
  skeleton: Skeleton,
  lineItemId: string,
  appliesTo: "historical" | "forecast",
  periodIds: readonly string[],
  source: string,
  splittableSources: ReadonlySet<string>,
): Skeleton {
  const next = cloneSkeleton(skeleton);
  const replacement = new Set(periodIds);
  const axes = periodAxes(next);
  const classIds = appliesTo === "historical" ? axes.historical : axes.forecast;
  const formulas: Formula[] = [];

  for (const formula of next.formulas) {
    if (formula.lineItemId !== lineItemId || formula.appliesTo !== appliesTo) {
      formulas.push(formula);
      continue;
    }
    const coverage = formula.periodIds === undefined ? classIds : [...formula.periodIds];
    const overlap = coverage.filter((id) => replacement.has(id));
    if (overlap.length === 0) {
      formulas.push(formula);
      continue;
    }
    const exact = coverage.length === periodIds.length && coverage.every((id) => replacement.has(id));
    if (!exact && !splittableSources.has(formula.source)) {
      invalid(`formula coverage partially overlaps ${lineItemId}: ${overlap.join(", ")}`);
    }
    const remaining = coverage.filter((id) => !replacement.has(id));
    if (remaining.length > 0) formulas.push({ ...formula, periodIds: remaining });
  }

  formulas.push({ lineItemId, appliesTo, source, periodIds: [...periodIds] });
  next.formulas = formulas;
  return next;
}

function periodAxes(skeleton: Skeleton): {
  historical: string[];
  forecast: string[];
  ordered: string[];
} {
  const historical = skeleton.periods
    .filter((period) => period.cls === "actual")
    .map((period) => period.id);
  const forecast = skeleton.periods
    .filter((period) => period.cls === "forecast")
    .map((period) => period.id);
  return { historical, forecast, ordered: [...historical, ...forecast] };
}
