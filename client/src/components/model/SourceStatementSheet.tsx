import { AlertTriangle } from "lucide-react";
import type { CurrentWorkbookView, SourceStatementRowView, WorkbookRowView } from "@/types/financialModel";
import type { SheetDescriptor } from "@/lib/workbook";
import { WorkbookGrid } from "./WorkbookGrid";

/** Source rows carry no hierarchy, role, or formulas — they are the filing as
 *  filed. Adapting them to the workbook row shape keeps one grid for the whole
 *  app rather than a near-copy that drifts. */
function asWorkbookRow(row: SourceStatementRowView, order: number): WorkbookRowView {
    return {
        lineItemId: row.sourceLineItemId,
        label: row.label,
        section: "history",
        role: "none",
        unit: row.unit,
        order,
        sources: { historical: "actual", forecast: "none" },
        formulas: [],
        assumptions: [],
        cells: row.cells,
    };
}

export function SourceStatementSheet({
    workbook,
    sheet,
    isCellChanged,
    scrollToLineItemId,
}: {
    workbook: CurrentWorkbookView;
    sheet: SheetDescriptor;
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
    scrollToLineItemId?: string;
}) {
    const review = workbook.sourceStatementReview;
    if (!review || !sheet.statement) return null;

    const rows = review.sheets[sheet.statement].map((row, index) => asWorkbookRow(row, index));
    const failed = review.reconciliations.filter((result) => result.status === "failed");

    return (
        <div className="flex h-full flex-col">
            {failed.length > 0 && (
                <div className="flex items-center gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>
                        {failed.length} reconciliation check(s) failed:
                        {failed.slice(0, 3).map((result) =>
                            // `identity` exists only on the accounting_identity arm;
                            // a category reconciliation is labelled by its category.
                            `${result.kind === "accounting_identity" ? result.identity : result.category}@${result.periodId}`,
                        ).join(", ")}
                        {failed.length > 3 && " …"}
                    </span>
                </div>
            )}
            <div className="min-h-0 flex-1">
                <WorkbookGrid
                    rows={rows}
                    periods={workbook.periods.filter((period) => review.selectedPeriodIds.includes(period.id))}
                    isCellChanged={isCellChanged}
                    scrollToLineItemId={scrollToLineItemId}
                />
            </div>
        </div>
    );
}
