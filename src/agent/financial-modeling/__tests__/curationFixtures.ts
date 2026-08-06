import type { Period, StatementKind } from "../../../financial-model/types.ts";
import type { FilingTable } from "../../../infra/xbrl/tableTypes.ts";

/** Two fiscal years of minimal but structurally complete v2 tables. */
export const REPORT_DATES = ["2024-09-28", "2025-09-27"];
export const PERIODS: Period[] = REPORT_DATES.map((end) => ({
  id: `FY${end.slice(0, 4)}`, label: `FY${end.slice(0, 4)}`, start: `${Number(end.slice(0, 4)) - 1}-09-29`, end, cls: "actual",
}));

export function filingTable(options: {
  sourceTableId: string;
  reportDate?: string;
  periodId?: string;
  tier?: "strong" | "weak";
  heading?: string;
  rowLabels?: string[];
  accession?: string;
  statement?: StatementKind;
}): FilingTable {
  const reportDate = options.reportDate ?? REPORT_DATES[1]!;
  const periodId = options.periodId ?? `FY${reportDate.slice(0, 4)}`;
  const labels = options.rowLabels ?? ["Total revenue", "Cost of sales"];
  return {
    sourceTableId: options.sourceTableId,
    accession: options.accession ?? `acc-${reportDate}`,
    form: "10-K",
    filedAt: reportDate,
    reportDate,
    heading: options.heading ?? headingFor(options.statement ?? "income_statement"),
    htmlOrder: 1,
    sourceAnchor: `#${options.sourceTableId}`,
    prescreen: { tier: options.tier ?? "strong", presentationOverlap: 0.9, dimensionlessRatio: 1, periodSpan: 1, factCount: labels.length },
    suggestedStatements: [options.statement ?? "income_statement"],
    columns: [
      { index: 0, headerText: "", isLabelColumn: true },
      { index: 1, headerText: periodId, periodId, isLabelColumn: false },
    ],
    rows: labels.map((labelText, index) => ({
      order: index + 1,
      labelText,
      indentLevel: 0,
      cells: [
        { columnIndex: 0, text: labelText },
        { columnIndex: 1, text: String(100 + index), fact: {
          contextId: `c-${periodId}`, periodId, value: 100 + index, unit: { kind: "currency", code: "USD" },
          dimensions: [], sourceAnchor: `#${options.sourceTableId}-${index + 1}`,
          occurrenceId: `${options.sourceTableId}-${index + 1}`, conceptQName: `us-gaap:Row${index + 1}`,
          conceptLabel: labelText, htmlOrder: index + 1,
        } },
      ],
    })),
  };
}

function headingFor(statement: StatementKind): string {
  if (statement === "balance_sheet") return "CONSOLIDATED BALANCE SHEETS";
  if (statement === "cash_flow_statement") return "CONSOLIDATED STATEMENTS OF CASH FLOWS";
  return "CONSOLIDATED STATEMENTS OF OPERATIONS";
}
