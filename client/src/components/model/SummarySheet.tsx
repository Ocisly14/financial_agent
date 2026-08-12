import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildSummaryRows } from "@/lib/workbook";
import type { CurrentWorkbookView } from "@/types/financialModel";
import { WorkbookGrid } from "./WorkbookGrid";

/** Key Financials up top, then the full history and metrics sections behind
 *  disclosures. Those two sections belong to no other sheet — the summary is
 *  their only home, so the fold is an entrance, not a trim. */
export function SummarySheet({
    workbook,
    isCellChanged,
    scrollToLineItemId,
}: {
    workbook: CurrentWorkbookView;
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
    scrollToLineItemId?: string;
}) {
    return (
        <div className="flex h-full flex-col overflow-auto">
            <Section title="Key Financials" defaultOpen>
                <WorkbookGrid
                    rows={buildSummaryRows(workbook)}
                    periods={workbook.periods}
                    isCellChanged={isCellChanged}
                    scrollToLineItemId={scrollToLineItemId}
                />
            </Section>
            <Section title="历史报表科目">
                <WorkbookGrid
                    rows={workbook.sections.history}
                    periods={workbook.periods}
                    isCellChanged={isCellChanged}
                    scrollToLineItemId={scrollToLineItemId}
                />
            </Section>
            <Section title="全部指标">
                <WorkbookGrid
                    rows={workbook.sections.metrics}
                    periods={workbook.periods}
                    isCellChanged={isCellChanged}
                    scrollToLineItemId={scrollToLineItemId}
                />
            </Section>
        </div>
    );
}

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        // `shrink-0` is load-bearing. These sections are flex items, and their
        // content is a WorkbookGrid — a scroll container, whose automatic
        // minimum size is therefore zero. Without this, opening a second fold
        // while another is open crushes it to no height at all: the toggle
        // flips, the chevron turns, and nothing appears. The parent scrolls
        // instead, which is what a stack of folds should do anyway.
        <div className="shrink-0 border-b">
            <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium hover:bg-muted/40"
                onClick={() => setOpen((value) => !value)}
            >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
                {title}
            </button>
            {open && children}
        </div>
    );
}
