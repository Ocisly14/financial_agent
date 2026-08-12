import type { RevisionSummary } from "@/types/financialModel";

/** Revision history is a property of the model, not a table of its own, so it
 *  lives behind the header chip rather than taking a sheet tab. */
export function RevisionDrawer({ history }: { history: RevisionSummary[] }) {
    return (
        <div className="max-h-80 w-96 overflow-auto rounded-md border bg-popover p-2 text-xs shadow-lg">
            {[...history].reverse().map((summary) => (
                <div key={summary.revision} className="border-b px-2 py-1.5 last:border-0">
                    <div className="flex justify-between gap-2">
                        <span className="font-medium">rev {summary.revision}</span>
                        <span className="text-muted-foreground">{summary.lifecycleStage}</span>
                    </div>
                    <div className="text-muted-foreground">
                        {summary.changes.map((change) => change.kind).join("、") || "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{summary.createdAt}</div>
                </div>
            ))}
        </div>
    );
}
