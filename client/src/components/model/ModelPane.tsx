import { useState } from "react";
import { cn } from "@/lib/utils";
import type { SheetDescriptor } from "@/lib/workbook";
import type { ModelContextView } from "@/types/financialModel";
import { DcfSheet } from "./DcfSheet";
import { RevenueSheet } from "./RevenueSheet";
import { RevisionDrawer } from "./RevisionDrawer";
import { SourceStatementSheet } from "./SourceStatementSheet";
import { SummarySheet } from "./SummarySheet";
import { WaccSheetView } from "./WaccSheetView";

export function ModelPane({
    context,
    sheets,
    activeSheetId,
    onSelectSheet,
    markedSheetIds,
    isCellChanged,
    scrollToLineItemId,
}: {
    context: ModelContextView;
    sheets: SheetDescriptor[];
    activeSheetId: string | undefined;
    onSelectSheet: (sheetId: string) => void;
    /** Sheets that changed but are not on screen — they get a dot. */
    markedSheetIds: string[];
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
    /** Set only while Task 11's auto-locate is actively steering the view — a
     *  manual sheet pick passes undefined, since WorkbookGrid's scroll effect
     *  fires once per new (truthy) target id and must not fight a user who
     *  has already scrolled somewhere else on their own. WaccSheetView has no
     *  grid, so it never receives this. */
    scrollToLineItemId?: string;
}) {
    const [historyOpen, setHistoryOpen] = useState(false);
    const active = sheets.find((sheet) => sheet.id === activeSheetId) ?? sheets[0];
    const workbook = context.currentWorkbook;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="relative flex items-center gap-2 border-b px-3 py-2 text-xs">
                <span className="font-medium">{context.model.symbol}</span>
                <button
                    type="button"
                    className="rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70"
                    onClick={() => setHistoryOpen((value) => !value)}
                >
                    rev {workbook.revision}
                </button>
                <span className="text-muted-foreground">{workbook.lifecycleStage}</span>
                {historyOpen && (
                    <div className="absolute left-3 top-8 z-30">
                        <RevisionDrawer history={context.revisionHistory} />
                    </div>
                )}
            </div>

            <div className="min-h-0 flex-1">
                {active?.kind === "summary" && (
                    <SummarySheet workbook={workbook} isCellChanged={isCellChanged} scrollToLineItemId={scrollToLineItemId} />
                )}
                {active?.kind === "source" && (
                    <SourceStatementSheet
                        workbook={workbook}
                        sheet={active}
                        isCellChanged={isCellChanged}
                        scrollToLineItemId={scrollToLineItemId}
                    />
                )}
                {active?.kind === "revenue" && (
                    <RevenueSheet
                        workbook={workbook}
                        sheet={active}
                        isCellChanged={isCellChanged}
                        scrollToLineItemId={scrollToLineItemId}
                    />
                )}
                {active?.kind === "wacc" && <WaccSheetView workbook={workbook} />}
                {active?.kind === "dcf" && (
                    <DcfSheet workbook={workbook} isCellChanged={isCellChanged} scrollToLineItemId={scrollToLineItemId} />
                )}
            </div>

            {/* Sheet strip along the bottom — the position a spreadsheet reader
                already looks for. Thin separators between the three groups make
                the model / source / derived layering visible in the strip itself. */}
            <div className="flex items-center gap-0.5 overflow-x-auto border-t bg-muted/30 px-2 py-1">
                {sheets.map((sheet, index) => (
                    <div key={sheet.id} className="flex items-center">
                        {index > 0 && sheets[index - 1]!.group !== sheet.group && (
                            <span className="mx-1 h-4 w-px bg-border" />
                        )}
                        <button
                            type="button"
                            onClick={() => onSelectSheet(sheet.id)}
                            className={cn(
                                "relative whitespace-nowrap rounded-t px-2.5 py-1 text-xs",
                                sheet.id === active?.id ? "bg-background font-medium shadow-sm" : "hover:bg-background/60",
                            )}
                        >
                            {sheet.label}
                            {markedSheetIds.includes(sheet.id) && sheet.id !== active?.id && (
                                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
                            )}
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
