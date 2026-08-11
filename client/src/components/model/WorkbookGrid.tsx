import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { buildRowTree, columnScaleLabel } from "@/lib/workbook";
import type { Period, WorkbookRowView } from "@/types/financialModel";
import { CellInspector } from "./CellInspector";
import { WorkbookCell } from "./WorkbookCell";

/** Popover width, matching CellInspector's `w-80`. Kept as a plain constant
 *  here (rather than imported) because it's a layout fact this file needs to
 *  clamp against, not something CellInspector exposes as an API. */
const POPOVER_WIDTH = 320;

/** A conservative ceiling on the popover's rendered height, used only to
 *  decide whether to flip it above the clicked cell instead of below.
 *  CellInspector also carries its own `max-h-[70vh]` + `overflow-y-auto` as a
 *  hard safety net for the rare row with many diagnostics that blows past
 *  this estimate — the estimate only needs to be roughly right, not exact. */
const POPOVER_EST_HEIGHT = 260;

/** Where the popover should sit, expressed in the scrolling container's own
 *  *content* coordinate space (its scrollLeft/scrollTop origin) rather than
 *  the viewport. Positioning it that way means the popover scrolls along
 *  with the cell it is anchored to for free: for an absolutely positioned
 *  element inside a `position: relative; overflow: auto` ancestor, offsets
 *  are resolved against the ancestor's content, not its visible window, so
 *  CSS itself keeps the two glued together as the grid scrolls — no scroll
 *  listener needed. */
function anchorFor(cellRect: DOMRect, container: HTMLElement): { top: number; left: number } {
    const containerRect = container.getBoundingClientRect();
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;
    const visibleLeft = scrollLeft;
    const visibleRight = scrollLeft + container.clientWidth;
    const visibleTop = scrollTop;
    const visibleBottom = scrollTop + container.clientHeight;

    const cellLeft = cellRect.left - containerRect.left + scrollLeft;
    const cellRight = cellRect.right - containerRect.left + scrollLeft;
    const cellTop = cellRect.top - containerRect.top + scrollTop;
    const cellBottom = cellRect.bottom - containerRect.top + scrollTop;

    // Horizontal: hang off the cell's left edge by default; flip to the
    // cell's right edge when the default would push the popover past the
    // visible right edge (the far-right-column case), then clamp absolutely
    // so a viewport narrower than the popover still keeps it fully visible.
    let left = cellLeft;
    if (left + POPOVER_WIDTH > visibleRight) left = cellRight - POPOVER_WIDTH;
    left = Math.max(visibleLeft + 4, Math.min(left, visibleRight - POPOVER_WIDTH - 4));

    // Vertical: open below the cell by default; flip above when there is not
    // enough room below in the visible viewport but there is more room above
    // (the last-row case).
    let top = cellBottom + 4;
    const roomBelow = visibleBottom - cellBottom;
    const roomAbove = cellTop - visibleTop;
    if (roomBelow < POPOVER_EST_HEIGHT && roomAbove > roomBelow) {
        top = cellTop - POPOVER_EST_HEIGHT - 4;
    }
    top = Math.max(visibleTop + 4, top);

    return { top, left };
}

/** The one grid every sheet renders through. Row labels stick to the left and
 *  the period header sticks to the top, because a DCF is read by scanning a
 *  row across years — losing either axis makes the number meaningless.
 *
 *  No virtualisation and no table library: a workbook is tens to a few hundred
 *  rows by a dozen columns. */
export function WorkbookGrid({
    rows,
    periods,
    isCellChanged,
    scrollToLineItemId,
}: {
    rows: WorkbookRowView[];
    periods: Period[];
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
    /** When set, the row is scrolled into view — used by auto-locate. */
    scrollToLineItemId?: string;
}) {
    const [inspecting, setInspecting] = useState<
        { lineItemId: string; periodId: string; anchor: { top: number; left: number } } | null
    >(null);
    const containerRef = useRef<HTMLDivElement>(null);
    // Guards the auto-locate effect against firing again on a re-render this
    // component causes itself (e.g. opening/closing the inspector): only a
    // genuinely new target id should trigger `scrollIntoView`, otherwise a
    // click that opens the inspector would smooth-scroll the view back to a
    // previously-located row out from under the user.
    const lastScrolledRef = useRef<string | undefined>(undefined);

    const nodes = buildRowTree(rows);
    const firstForecastId = periods.find((period) => period.cls === "forecast")?.id;
    const inspectedRow = inspecting && rows.find((row) => row.lineItemId === inspecting.lineItemId);

    useEffect(() => {
        if (!scrollToLineItemId || lastScrolledRef.current === scrollToLineItemId) return;
        const target = containerRef.current?.querySelector<HTMLElement>(
            `tr[data-line-item-id="${CSS.escape(scrollToLineItemId)}"]`,
        );
        if (!target) return;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        lastScrolledRef.current = scrollToLineItemId;
    }, [scrollToLineItemId]);

    if (nodes.length === 0) {
        return <div className="p-6 text-sm text-muted-foreground">这张表还没有内容。</div>;
    }

    return (
        <div ref={containerRef} className="relative h-full overflow-auto">
            {/* `min-w-full` rather than `w-full`: a workbook is wider than the
                pane it lives in, and `w-full` lets the auto table layout crush
                the label column to fit instead of overflowing into the
                container's horizontal scroll, which is what should happen. */}
            <table className="min-w-full border-separate border-spacing-0 text-xs">
                <thead>
                    <tr>
                        <th className="sticky left-0 top-0 z-20 w-[240px] min-w-[240px] border-b bg-background px-3 py-2 text-left font-medium">
                            科目
                        </th>
                        {periods.map((period) => (
                            <th
                                key={period.id}
                                className={cn(
                                    "sticky top-0 z-10 whitespace-nowrap border-b bg-background px-3 py-2 text-right font-medium",
                                    period.cls === "forecast" && "bg-muted/40",
                                    period.id === firstForecastId && "border-l-2",
                                )}
                            >
                                {period.label}
                                {period.cls === "ttm" && <span className="ml-1 text-muted-foreground">TTM</span>}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {nodes.map(({ row, depth }) => (
                        <tr key={row.lineItemId} data-line-item-id={row.lineItemId} className="hover:bg-muted/30">
                            <th
                                scope="row"
                                className={cn(
                                    "sticky left-0 z-10 w-[240px] min-w-[240px] border-b bg-background px-3 py-1 text-left font-normal",
                                    depth === 0 && "font-medium",
                                )}
                                style={{ paddingLeft: 12 + depth * 12 }}
                            >
                                {row.label}
                                <span className="ml-2 text-[10px] text-muted-foreground">
                                    {columnScaleLabel(row.unit)}
                                </span>
                            </th>
                            {periods.map((period) => {
                                const cell = row.cells[period.id];
                                if (!cell) return <td key={period.id} className="border-b px-3 py-1" />;
                                return (
                                    <WorkbookCell
                                        key={period.id}
                                        cell={cell}
                                        unit={row.unit}
                                        changed={isCellChanged(row.lineItemId, period.id)}
                                        onInspect={(anchorRect) => {
                                            const container = containerRef.current;
                                            if (!container) return;
                                            setInspecting({
                                                lineItemId: row.lineItemId,
                                                periodId: period.id,
                                                anchor: anchorFor(anchorRect, container),
                                            });
                                        }}
                                    />
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>

            {inspecting && inspectedRow && (
                <CellInspector
                    row={inspectedRow}
                    periodId={inspecting.periodId}
                    anchor={inspecting.anchor}
                    onClose={() => setInspecting(null)}
                />
            )}
        </div>
    );
}
