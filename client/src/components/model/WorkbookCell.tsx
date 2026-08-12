import { cn } from "@/lib/utils";
import { formatCellValue } from "@/lib/workbook";
import type { Unit, WorkbookCellView } from "@/types/financialModel";

/** One cell. Source is encoded in the *text colour*, not a background wash:
 *  blue means a human-entered assumption, which is the convention every reader
 *  of a banker's model already has in their eyes. Stacking backgrounds for
 *  source on top of the highlight wash would make the two unreadable together.
 *
 *  The clickable surface is a real nested `<button>`, not the `<td>` itself:
 *  a table cell has no native keyboard affordance, and this codebase's own
 *  precedent for "clickable non-form element" (ChartTabBar's tab strip,
 *  CellInspector's own close button) is always a focusable control, never an
 *  onClick on a bare div/td. The `<td>` stays a plain layout box — it carries
 *  the change-flash background and the diagnostics dot, both of which need to
 *  sit outside the button's own padding box. */
export function WorkbookCell({
    cell,
    unit,
    changed,
    highlighted = false,
    onInspect,
    onHover,
    onLeave,
}: {
    cell: WorkbookCellView;
    unit: Unit;
    changed: boolean;
    /** True when the active formula reads this exact line-item / period cell. */
    highlighted?: boolean;
    /** Passed the clicked button's own geometry so the caller can anchor the
     *  inspector popover next to it. */
    onInspect: (anchor: DOMRect) => void;
    /** Hover opens the provenance inspector without pinning it. */
    onHover?: (anchor: DOMRect) => void;
    onLeave?: () => void;
}) {
    const isAssumption = cell.source.kind === "assumption";
    const hasDiagnostics = cell.diagnostics.length > 0;

    return (
        <td
            className={cn(
                "relative whitespace-nowrap p-0 text-right tabular-nums",
                changed && "animate-workbook-flash",
                highlighted && "bg-amber-200/60 dark:bg-amber-500/20",
            )}
        >
            <button
                type="button"
                onClick={(event) => onInspect(event.currentTarget.getBoundingClientRect())}
                onMouseEnter={(event) => onHover?.(event.currentTarget.getBoundingClientRect())}
                onMouseLeave={onLeave}
                className={cn(
                    "block w-full whitespace-nowrap px-3 py-1 text-right tabular-nums",
                    "cursor-pointer hover:bg-muted/50",
                    highlighted && "bg-amber-100/60 dark:bg-amber-500/10",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    isAssumption && "text-blue-600 dark:text-blue-400",
                    cell.status === "not_modeled" && "text-muted-foreground/40",
                    cell.status === "missing_input" && "text-muted-foreground",
                    cell.status === "divide_by_zero" && "text-destructive",
                )}
            >
                {formatCellValue(cell, unit)}
            </button>
            {hasDiagnostics && (
                <span className="pointer-events-none absolute right-0.5 top-0.5 h-[2px] w-[2px] rounded-full bg-amber-500" />
            )}
        </td>
    );
}
