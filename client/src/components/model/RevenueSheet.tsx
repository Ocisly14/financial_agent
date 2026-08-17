import type { CurrentWorkbookView } from "@/types/financialModel";
import type { SheetDescriptor } from "@/lib/workbook";
import { WorkbookGrid } from "./WorkbookGrid";

/** Either one category group's members, or — with no group, or for rows no
 *  group claimed — the whole revenue section. */
export function RevenueSheet({
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
    const group = sheet.categoryName
        ? workbook.categoryGroups.find((candidate) => candidate.category === sheet.categoryName)
        : undefined;

    const treatmentOf = new Map(group?.members.map((member) => [member.lineItemId, member.treatment]) ?? []);
    const rows = group
        ? workbook.sections.revenue
            .filter((row) => treatmentOf.has(row.lineItemId))
            // Treatment has to be visible: a member marked `exclude` is why the
            // parts stop adding up to the total, and that is not guessable.
            .map((row) => ({ ...row, label: `${row.label} [${treatmentOf.get(row.lineItemId)}]` }))
        : workbook.sections.revenue;

    return (
        <div className="h-full">
            <WorkbookGrid
                rows={rows}
                periods={workbook.periods}
                isCellChanged={isCellChanged}
                scrollToLineItemId={scrollToLineItemId}
            />
        </div>
    );
}
