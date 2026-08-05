import { FinancialModelError } from "./errors.ts";
import type { Formula } from "./engine.ts";
import type { LineItem, Period, Unit } from "./types.ts";
import type { Skeleton } from "./skeleton.ts";

export type RegisteredMetricId =
  | "revenue_growth" | "operating_margin" | "effective_tax_rate"
  | "da_to_revenue" | "capex_to_revenue" | "operating_nwc_to_revenue"
  | "free_cash_flow" | "operating_income_yoy" | "net_income_yoy" | "diluted_eps_yoy"
  | "ocf_yoy" | "fcf_yoy" | "gross_margin" | "ebitda_margin" | "net_margin"
  | "ocf_margin" | "fcf_margin" | "ocf_conversion" | "current_ratio" | "debt_to_equity"
  | "net_debt" | "invested_capital" | "roa" | "roe" | "roic"
  | "net_income_per_share" | "ocf_per_share" | "fcf_per_share"
  | "revenue_cagr_3p" | "revenue_cagr_5p";

export type MetricRequest = {
  registryId: "cagr";
  targetLineItemId: string;
  lookbackPeriods: number;
};

export type MetricDefinition = {
  registryId: RegisteredMetricId;
  id: string;
  label: string;
  unit: "currency" | "percent" | "ratio" | "per_share";
  source: string;
  /** The fixed DCF spine owns this row and formula; registry install validates
   * the binding instead of creating a duplicate metric row. */
  installedBySkeleton?: true;
};

const DEFAULT_METRIC_DEFINITION_VALUES: MetricDefinition[] = [
  { registryId: "revenue_growth", id: "growth.revenue.total", label: "Total revenue growth", unit: "percent", source: "YOY(revenue.total)", installedBySkeleton: true },
  { registryId: "operating_margin", id: "margin.operating", label: "Operating margin", unit: "percent", source: "operating_income / revenue.total", installedBySkeleton: true },
  { registryId: "effective_tax_rate", id: "tax_rate", label: "Effective tax rate", unit: "percent", source: "income_tax_expense / pretax_income", installedBySkeleton: true },
  { registryId: "da_to_revenue", id: "ratio.da_to_revenue", label: "D&A to revenue", unit: "ratio", source: "depreciation_amortization / revenue.total", installedBySkeleton: true },
  { registryId: "capex_to_revenue", id: "ratio.capex_to_revenue", label: "Capital expenditures to revenue", unit: "ratio", source: "capital_expenditures / revenue.total", installedBySkeleton: true },
  { registryId: "operating_nwc_to_revenue", id: "ratio.operating_nwc_to_revenue", label: "Operating working capital to revenue", unit: "ratio", source: "operating_working_capital / revenue.total", installedBySkeleton: true },
  { registryId: "free_cash_flow", id: "metric.free_cash_flow", label: "Free cash flow", unit: "currency", source: "operating_cash_flow - capital_expenditures" },
  { registryId: "operating_income_yoy", id: "metric.operating_income_yoy", label: "Operating income growth", unit: "percent", source: "YOY(operating_income)" },
  { registryId: "net_income_yoy", id: "metric.net_income_yoy", label: "Net income growth", unit: "percent", source: "YOY(net_income)" },
  { registryId: "diluted_eps_yoy", id: "metric.diluted_eps_yoy", label: "Diluted EPS growth", unit: "percent", source: "YOY(diluted_eps)" },
  { registryId: "ocf_yoy", id: "metric.ocf_yoy", label: "Operating cash flow growth", unit: "percent", source: "YOY(operating_cash_flow)" },
  { registryId: "fcf_yoy", id: "metric.fcf_yoy", label: "Free cash flow growth", unit: "percent", source: "YOY(metric.free_cash_flow)" },
  { registryId: "gross_margin", id: "metric.gross_margin", label: "Gross margin", unit: "ratio", source: "gross_profit / revenue.total" },
  { registryId: "ebitda_margin", id: "metric.ebitda_margin", label: "EBITDA margin", unit: "ratio", source: "ebitda / revenue.total" },
  { registryId: "net_margin", id: "metric.net_margin", label: "Net margin", unit: "ratio", source: "net_income / revenue.total" },
  { registryId: "ocf_margin", id: "metric.ocf_margin", label: "Operating cash flow margin", unit: "ratio", source: "operating_cash_flow / revenue.total" },
  { registryId: "fcf_margin", id: "metric.fcf_margin", label: "Free cash flow margin", unit: "ratio", source: "metric.free_cash_flow / revenue.total" },
  { registryId: "ocf_conversion", id: "metric.ocf_conversion", label: "Operating cash flow conversion", unit: "ratio", source: "operating_cash_flow / net_income" },
  { registryId: "current_ratio", id: "metric.current_ratio", label: "Current ratio", unit: "ratio", source: "total_current_assets / total_current_liabilities" },
  { registryId: "debt_to_equity", id: "metric.debt_to_equity", label: "Debt to equity", unit: "ratio", source: "debt / shareholders_equity" },
  { registryId: "net_debt", id: "metric.net_debt", label: "Net debt", unit: "currency", source: "debt - cash_and_equivalents - short_term_investments" },
  { registryId: "invested_capital", id: "metric.invested_capital", label: "Invested capital", unit: "currency", source: "debt + shareholders_equity - cash_and_equivalents - short_term_investments" },
  { registryId: "roa", id: "metric.roa", label: "Return on assets", unit: "ratio", source: "net_income / AVERAGE(total_assets, -1, 0)" },
  { registryId: "roe", id: "metric.roe", label: "Return on equity", unit: "ratio", source: "net_income / AVERAGE(shareholders_equity, -1, 0)" },
  { registryId: "roic", id: "metric.roic", label: "Return on invested capital", unit: "ratio", source: "nopat / AVERAGE(metric.invested_capital, -1, 0)" },
  { registryId: "net_income_per_share", id: "metric.net_income_per_share", label: "Net income per share", unit: "per_share", source: "net_income / diluted_shares" },
  { registryId: "ocf_per_share", id: "metric.ocf_per_share", label: "Operating cash flow per share", unit: "per_share", source: "operating_cash_flow / diluted_shares" },
  { registryId: "fcf_per_share", id: "metric.fcf_per_share", label: "Free cash flow per share", unit: "per_share", source: "metric.free_cash_flow / diluted_shares" },
  { registryId: "revenue_cagr_3p", id: "metric.revenue_cagr_3p", label: "Revenue CAGR (3 periods)", unit: "percent", source: "CAGR(revenue.total, 3)" },
  { registryId: "revenue_cagr_5p", id: "metric.revenue_cagr_5p", label: "Revenue CAGR (5 periods)", unit: "percent", source: "CAGR(revenue.total, 5)" },
];

/** Stable registry metadata is deeply frozen; callers can select definitions,
 * but cannot alter the formulas subsequently installed into new models. */
export const DEFAULT_METRIC_DEFINITIONS: readonly Readonly<MetricDefinition>[] =
  Object.freeze(DEFAULT_METRIC_DEFINITION_VALUES.map((definition) => Object.freeze(definition)));

function actualPeriodIds(periods: readonly Period[]): string[] {
  return periods.filter((period) => period.cls === "actual").map((period) => period.id);
}

function reportingCurrency(skeleton: Skeleton): string {
  const row = skeleton.lineItems.find((item) => item.unit.kind === "currency");
  if (!row || row.unit.kind !== "currency") throw new FinancialModelError("invalid_formula", "metric registry requires a reporting currency");
  return row.unit.code;
}

function metricUnit(kind: MetricDefinition["unit"], currency: string): Unit {
  if (kind === "currency") return { kind: "currency", code: currency };
  if (kind === "per_share") return { kind: "per_share", code: currency };
  return { kind };
}

function appendMetric(skeleton: Skeleton, row: LineItem, formula: Formula): Skeleton {
  if (skeleton.lineItems.some((item) => item.id === row.id)) {
    throw new FinancialModelError("invalid_model_operation", `metric already installed: ${row.id}`);
  }
  return {
    periods: skeleton.periods.map((period) => ({ ...period })),
    lineItems: [...skeleton.lineItems.map((item) => structuredClone(item)), row],
    formulas: [...skeleton.formulas.map((entry) => structuredClone(entry)), formula],
  };
}

export function installDefaultMetrics(skeleton: Skeleton, periods: readonly Period[] = skeleton.periods): Skeleton {
  if (skeleton.lineItems.some((item) => item.id === "metric.free_cash_flow")) {
    throw new FinancialModelError("invalid_model_operation", "default metrics are already installed");
  }
  const ids = actualPeriodIds(periods);
  const currency = reportingCurrency(skeleton);
  let next: Skeleton = {
    periods: skeleton.periods.map((period) => ({ ...period })),
    lineItems: skeleton.lineItems.map((item) => structuredClone(item)),
    formulas: skeleton.formulas.map((formula) => structuredClone(formula)),
  };
  let order = Math.max(499, ...next.lineItems.map((item) => item.order)) + 1;
  for (const definition of DEFAULT_METRIC_DEFINITIONS) {
    if (definition.installedBySkeleton) {
      const row = next.lineItems.find((item) => item.id === definition.id);
      const formula = next.formulas.find((entry) =>
        entry.lineItemId === definition.id
        && entry.appliesTo === "historical"
        && entry.source === definition.source);
      if (row?.historical !== "formula" || formula === undefined) {
        throw new FinancialModelError(
          "invalid_formula",
          `missing registry-owned skeleton driver: ${definition.id}`,
        );
      }
      continue;
    }
    next = appendMetric(next, {
      id: definition.id, label: definition.label, role: "none", unit: metricUnit(definition.unit, currency),
      section: "metrics", order, historical: "formula", forecast: "none",
    }, { lineItemId: definition.id, appliesTo: "historical", periodIds: [...ids], source: definition.source });
    order += 1;
  }
  return next;
}

function cagrTargetAllowed(id: string, lineItems: readonly LineItem[]): boolean {
  const row = lineItems.find((item) => item.id === id);
  if (row === undefined) return false;
  if (id === "revenue.total" || id === "operating_income" || id === "net_income"
      || id === "diluted_eps" || id === "operating_cash_flow" || id === "metric.free_cash_flow") return true;
  return id.startsWith("revenue.") && row.role === "revenue_stream";
}

export function installRegisteredMetric(
  skeleton: Skeleton, periods: readonly Period[], request: MetricRequest,
): Skeleton {
  const n = request.lookbackPeriods;
  if (request.registryId !== "cagr" || !Number.isInteger(n) || n < 2 || n > 10) {
    throw new FinancialModelError("invalid_model_operation", "CAGR lookback must be an integer from 2 through 10");
  }
  if (!cagrTargetAllowed(request.targetLineItemId, skeleton.lineItems)) {
    throw new FinancialModelError("invalid_model_operation", `CAGR target is not registry-allowlisted: ${request.targetLineItemId}`);
  }
  const id = `metric.cagr.${request.targetLineItemId}.${n}p`;
  const order = Math.max(599, ...skeleton.lineItems.map((item) => item.order)) + 1;
  return appendMetric(skeleton, {
    id, label: `${request.targetLineItemId} CAGR (${n} periods)`, role: "none", unit: { kind: "percent" },
    section: "metrics", order, historical: "formula", forecast: "none",
  }, {
    lineItemId: id, appliesTo: "historical", periodIds: actualPeriodIds(periods),
    source: `CAGR(${request.targetLineItemId}, ${n})`,
  });
}
