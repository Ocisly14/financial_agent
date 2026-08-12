import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatCellValue } from "@/lib/workbook";
import type { CurrentWorkbookView, WaccSheetRow } from "@/types/financialModel";

/** WACC is a single-column derivation, not a period grid, so it does not go
 *  through WorkbookGrid. beta lives here as one row rather than its own sheet:
 *  the provenance (window, market proxy, observation count) is what tells you
 *  whether to trust it, and that fits in a disclosure. */
export function WaccSheetView({ workbook }: { workbook: CurrentWorkbookView }) {
    const [expanded, setExpanded] = useState<string | null>(null);
    const sheet = workbook.waccSheet;
    if (!sheet) return null;

    return (
        <div className="h-full overflow-auto">
            <div className="border-b px-3 py-2 text-xs text-muted-foreground">As of {sheet.asOfDate}</div>
            <table className="w-full text-xs">
                <tbody>
                    {sheet.rows.map((row) => (
                        <WaccRow
                            key={row.rowId}
                            row={row}
                            expanded={expanded === row.rowId}
                            onToggle={() => setExpanded(expanded === row.rowId ? null : row.rowId)}
                        />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function WaccRow({ row, expanded, onToggle }: { row: WaccSheetRow; expanded: boolean; onToggle: () => void }) {
    const blocked = row.missingInputs.length > 0;
    return (
        <>
            <tr className="cursor-pointer border-b hover:bg-muted/30" onClick={onToggle}>
                <th scope="row" className={cn("px-3 py-1.5 text-left font-normal", row.rowId === "wacc" && "font-medium")}>
                    {row.label}
                </th>
                <td className={cn(
                    "px-3 py-1.5 text-right tabular-nums",
                    row.source === "agent" && "text-blue-600 dark:text-blue-400",
                    blocked && "text-muted-foreground",
                )}>
                    {formatCellValue(
                        { value: row.value, status: blocked ? "missing_input" : "ok", source: { kind: "none" }, diagnostics: [], dependencies: [] },
                        row.unit,
                    )}
                </td>
                {/* `locked_formula` is the longest value and wraps mid-word at
                    w-24, which reads as a rendering fault rather than a label. */}
                <td className="w-32 whitespace-nowrap px-3 py-1.5 text-right text-[10px] text-muted-foreground">{row.source}</td>
            </tr>
            {expanded && (
                <tr className="border-b bg-muted/20">
                    <td colSpan={3} className="space-y-1 px-3 py-2 text-[11px]">
                        {row.formulaSource && <div className="font-mono break-all">{row.formulaSource}</div>}
                        {row.provenance && (
                            <>
                                <div>{row.provenance.rationale}</div>
                                <div className="text-muted-foreground">
                                    {row.provenance.sourceType} · {row.provenance.asOfDate} · {row.provenance.sourceRefs.join(", ")}
                                </div>
                            </>
                        )}
                        {blocked && <div className="text-amber-600">Missing inputs: {row.missingInputs.join(", ")}</div>}
                    </td>
                </tr>
            )}
        </>
    );
}
