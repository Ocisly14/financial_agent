import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;

type Drag =
    | { mode: "move"; pointerX: number; pointerY: number; originX: number; originY: number }
    | { mode: "resize"; pointerX: number; pointerY: number; originWidth: number; originHeight: number };

/**
 * A chart tab that has been pulled out of the strip, in a window that floats
 * over the workspace.
 *
 * **Non-modal on purpose** (design §5 rule 5): the entire reason to tear a tab
 * out is to look at it *beside* something else, so there is no backdrop, no
 * focus trap, and nothing underneath is disabled. It is rendered through a
 * portal to `document.body` so the chart column's `overflow: hidden` cannot
 * clip a window dragged past its edge.
 *
 * **The close button returns the tab to the strip** — it is not a delete, and
 * its label says so, because a `×` in a title bar reads as "destroy this"
 * everywhere else. Deleting a tab remains the `×` on the tab itself (§5
 * rule 2).
 *
 * **Dragging the title bar back onto the strip re-docks it.** Tearing out is a
 * drag, so putting back has to be one too — a gesture with no inverse leaves
 * the user hunting for a button to undo something they did by dragging. This
 * component only reports where the pointer is; whether that counts as the strip
 * is the parent's question, since only the parent knows where the strip is.
 */
/** Long enough to read as one continuous object growing, short enough that it
 *  never delays the chart the user is waiting to see. */
const OPEN_DURATION_MS = 200;
/** Decelerating: fast off the tab, settling into place. The standard
 *  container-transform curve — a symmetric ease would look mechanical. */
const OPEN_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export function FloatingChart({
    title,
    openFrom,
    x,
    y,
    width,
    height,
    onMove,
    onResize,
    onClose,
    onFocus,
    onDragPoint,
    onDropPoint,
    isTop,
    children,
}: {
    title: string;
    /** The tab's box at tear-off. The window grows out of it on mount; omitted,
     *  it simply appears. */
    openFrom?: { left: number; top: number; width: number; height: number };
    x: number;
    y: number;
    width: number;
    height: number;
    onMove: (x: number, y: number) => void;
    onResize: (width: number, height: number) => void;
    /** Pointer position while the title bar is being dragged, and `null` the
     *  moment the drag ends. The parent uses it to light a drop target. */
    onDragPoint?: (point: { x: number; y: number } | null) => void;
    /** Where the window was released. The parent decides whether that lands on
     *  the tab strip, and re-docks if it does. */
    onDropPoint?: (point: { x: number; y: number }) => void;
    /** Dismisses the window and puts the tab back on the strip. Never deletes. */
    onClose: () => void;
    onFocus: () => void;
    /** Frontmost window. Only that one answers Escape — several windows all
     *  vanishing on one keypress would undo an arrangement the user built
     *  deliberately, and rebuilding it means dragging every tab out again. */
    isTop: boolean;
    children: React.ReactNode;
}) {
    const { t } = useTranslation();
    const [drag, setDrag] = useState<Drag | null>(null);
    // Read inside the pointer handlers without re-subscribing them on every
    // pixel of movement.
    const geometry = useRef({ x, y, width, height });
    geometry.current = { x, y, width, height };

    const startMove = useCallback((event: React.PointerEvent) => {
        // Ignore the close button and anything else interactive in the bar.
        if ((event.target as HTMLElement).closest("button")) return;
        event.preventDefault();
        onFocus();
        setDrag({
            mode: "move",
            pointerX: event.clientX,
            pointerY: event.clientY,
            originX: geometry.current.x,
            originY: geometry.current.y,
        });
    }, [onFocus]);

    const startResize = useCallback((event: React.PointerEvent) => {
        event.preventDefault();
        onFocus();
        setDrag({
            mode: "resize",
            pointerX: event.clientX,
            pointerY: event.clientY,
            originWidth: geometry.current.width,
            originHeight: geometry.current.height,
        });
    }, [onFocus]);

    useEffect(() => {
        if (!drag) return;
        const handleMove = (event: PointerEvent) => {
            const deltaX = event.clientX - drag.pointerX;
            const deltaY = event.clientY - drag.pointerY;
            if (drag.mode === "move") {
                // Clamped to the viewport: a window dragged off-screen would be
                // unreachable, and nothing in this feature can restore it but a
                // reload, which would also discard the arrangement.
                onMove(
                    Math.max(0, Math.min(drag.originX + deltaX, window.innerWidth - geometry.current.width)),
                    Math.max(0, Math.min(drag.originY + deltaY, window.innerHeight - 40)),
                );
                // The *pointer*, not the window's corner: the drop target is
                // wherever the user is pointing, the same way the tear-off that
                // created this window read the gesture.
                onDragPoint?.({ x: event.clientX, y: event.clientY });
            } else {
                onResize(
                    Math.max(MIN_WIDTH, drag.originWidth + deltaX),
                    Math.max(MIN_HEIGHT, drag.originHeight + deltaY),
                );
            }
        };
        const drop = (event: PointerEvent) => {
            if (drag.mode === "move") onDropPoint?.({ x: event.clientX, y: event.clientY });
            onDragPoint?.(null);
            setDrag(null);
        };
        // A cancelled drag is not a drop: the hint clears and the window stays.
        const cancel = () => {
            onDragPoint?.(null);
            setDrag(null);
        };
        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", drop);
        window.addEventListener("pointercancel", cancel);
        return () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", drop);
            window.removeEventListener("pointercancel", cancel);
        };
    }, [drag, onMove, onResize, onDragPoint, onDropPoint]);

    /**
     * The opening move: the tab unfolds into the window, in place.
     *
     * It starts as the tab — tab-sized, where the pointer let go — and grows to
     * the window's full box. Scaled per axis rather than uniformly, so the
     * unfolding happens in both directions at once and the chip's own
     * proportions are what the eye follows out to the window's.
     *
     * Runs once, on mount, against the geometry this window was born with; a
     * later move must not replay it.
     */
    const shell = useRef<HTMLElement>(null);
    useEffect(() => {
        const node = shell.current;
        const from = openFrom;
        if (!node || !from) return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        const { x: left, y: top, width: shellWidth, height: shellHeight } = geometry.current;
        const scaleX = from.width / shellWidth;
        const scaleY = from.height / shellHeight;
        const deltaX = from.left + from.width / 2 - (left + shellWidth / 2);
        const deltaY = from.top + from.height / 2 - (top + shellHeight / 2);
        node.animate(
            [
                {
                    transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
                    opacity: 0.4,
                },
                { transform: "none", opacity: 1 },
            ],
            { duration: OPEN_DURATION_MS, easing: OPEN_EASING },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only: this is the opening, not a response to movement
    }, []);

    // Escape dismisses — which, here, means "back to the strip", never a delete.
    useEffect(() => {
        if (!isTop) return;
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [isTop, onClose]);

    if (typeof document === "undefined") return null;

    return createPortal(
        <section
            ref={shell}
            role="dialog"
            aria-modal="false"
            aria-label={t("charts.floating.windowLabel", { title })}
            // `fin-window-open` is the fallback for a detach with no source tab
            // to grow from; with one, the effect above drives the opening.
            className={cn(
                "fixed z-50 flex flex-col overflow-hidden rounded-lg border border-sep bg-raised shadow-e2-rim",
                openFrom === undefined && "fin-window-open",
            )}
            style={{ left: x, top: y, width, height }}
            onPointerDown={onFocus}
        >
            <header
                onPointerDown={startMove}
                title={t("charts.floating.dragToDock")}
                className={cn(
                    "material flex shrink-0 items-center gap-2 border-b border-sep px-3 py-2",
                    drag?.mode === "move" ? "cursor-grabbing" : "cursor-grab",
                )}
            >
                <span className="fin-figure truncate text-xs font-semibold text-label-1">{title}</span>
                <button
                    type="button"
                    onClick={onClose}
                    className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-xs text-label-2 transition-colors hover:bg-fill-2 hover:text-label-1"
                    aria-label={t("charts.floating.returnToTabs")}
                    title={t("charts.floating.returnToTabs")}
                >
                    <X className="size-3.5" />
                </button>
            </header>

            <div className="min-h-0 flex-1 overflow-auto p-2">{children}</div>

            <span
                onPointerDown={startResize}
                role="separator"
                aria-label={t("charts.floating.resize")}
                className="absolute bottom-0 right-0 size-4 cursor-nwse-resize bg-fill-2"
                style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
            />
        </section>,
        document.body,
    );
}
