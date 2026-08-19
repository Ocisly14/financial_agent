import { useEffect, useRef, useState } from "react";
import { Layers, Plus, Scale, Table2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { chartTabKey, type TopicChartTab } from "@/lib/topicCharts";
import { overlayTabLabel } from "@/lib/overlayChart";
import type { UUID } from "@/types/core";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { MemberPicker } from "@/components/workspace/MemberPicker";

type DropTarget = { key: string; edge: "before" | "after" };

/** How far past the strip's edge the pointer must be released before a drag
 *  counts as a tear-off rather than a sloppy reorder. Without slack, releasing
 *  a pixel below the strip while shuffling tabs would fling the tab into a
 *  window the user never asked for. */
const DETACH_SLACK_PX = 24;

/**
 * The one chip shape the app uses for a chart tab — also reused on the
 * strategies page. Tickers are data, so they get the figure face and a
 * square-ish chip rather than a pill.
 *
 * A tab is either a single symbol or an overlay comparison, and the strip
 * branches on `kind` rather than parsing a label: an overlay reads
 * `AAPL+NVDA` behind a layers mark, so a derived comparison is never mistaken
 * for a ticker that happens to contain a `+`.
 *
 * ## One gesture, two outcomes
 *
 * Dragging *within* the strip reorders. Releasing *beyond* the strip detaches
 * the tab into a floating window (design §5). These are the same native HTML5
 * drag — there is no second drag mechanism to learn, and no mode to enter.
 * The two are told apart at `dragend`, which is the only event that reports
 * where the pointer was actually released: a drop that landed on another tab
 * sets `handledRef`, so anything else outside the strip's bounds is a
 * tear-off.
 */
export function ChartTabBar({
    tabs,
    activeKey,
    onSelect,
    onClose,
    onReorder,
    onAdd,
    onDetach,
    tenantId,
    currentTopicId,
    onCompare,
    readOnly = false,
}: {
    tabs: TopicChartTab[];
    activeKey: string | undefined;
    onSelect: (key: string) => void;
    /** The `×`. This is the ONE path that removes a tab (design §5 rule 2) —
     *  closing a floating window must never reach this. */
    onClose: (key: string) => void;
    /** Fired with the full tab-key order after a drag-to-reorder drop. The tab
     *  set belongs to the user, so this is a persistent write, not view state. */
    onReorder: (orderedKeys: string[]) => void;
    onAdd: (symbol: string) => void;
    /** Tears a tab out into a floating window. Omitted below 1024px, where
     *  there is no room to place two charts side by side — which is the only
     *  reason the feature exists — so narrow drags reorder and nothing else
     *  (§5 rule 6). */
    onDetach?: (
        key: string,
        releasePoint: { x: number; y: number },
        /** The tab's box, read while it is still on screen — the window opens
         *  out of it. `dragend` is the last moment this exists. */
        originRect: { left: number; top: number; width: number; height: number },
    ) => void;
    /** Required together with `currentTopicId`/`onCompare` to render the "+ Compare" affordance (spec §7.4) — omit all three in contexts where spinning up a Research doesn't apply (e.g. inside a Research view's own tab bar). */
    tenantId?: UUID;
    /** The Topic this tab bar belongs to — excluded from the picker's candidate list so a Topic can't be compared against itself. */
    currentTopicId?: UUID;
    /** Fired with the topic ids picked from `MemberPicker`. The caller owns turning that into a new Research (name join + `createResearch` + navigate) — this component only opens the selector. */
    onCompare?: (topicIds: string[]) => void;
    /** A model replay can change sheets but never persist chart preferences. */
    readOnly?: boolean;
}) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const stripRef = useRef<HTMLDivElement>(null);

    // Native HTML5 drag-and-drop for tab reordering — no library, this is a
    // one-dimensional list reorder, the simplest case the browser API covers.
    const [draggedKey, setDraggedKey] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
    // A drop and the click it lands on fire in the same gesture on some
    // browsers; this suppresses the one click that immediately follows a drop
    // so a reorder never also re-selects the tab underneath the cursor.
    const suppressClickRef = useRef(false);
    // Set by a drop on another tab, so the dragend that follows knows the
    // gesture was already resolved as a reorder.
    const handledRef = useRef(false);

    /**
     * While one of our tabs is in flight, every drop target on the page accepts
     * it.
     *
     * This exists for one reason: a drag that ends with `dropEffect: none` makes
     * the browser fly its drag image back to where the drag started, and only
     * then fire `dragend`. A tear-off releases the tab *outside* any drop
     * target, so the browser calls it a failed drop and plays that return —
     * after which the window appears somewhere else entirely. Nothing in
     * `dragend` can cancel an animation the browser has already committed to,
     * so the fix has to be upstream: accept the drop, and there is nothing to
     * return from.
     *
     * Scoped to the life of one drag, so the app is not a drop target at rest.
     */
    useEffect(() => {
        if (draggedKey === null) return;
        const accept = (event: DragEvent) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        };
        document.addEventListener("dragover", accept);
        document.addEventListener("drop", accept);
        return () => {
            document.removeEventListener("dragover", accept);
            document.removeEventListener("drop", accept);
        };
    }, [draggedKey]);

    const commitAdd = () => {
        if (readOnly) return;
        const value = draft.trim();
        if (value) onAdd(value);
        setDraft("");
        setAdding(false);
    };

    const handleDragStart = (event: React.DragEvent<HTMLDivElement>, key: string) => {
        if (readOnly) return;
        setDraggedKey(key);
        handledRef.current = false;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", key);
    };

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>, key: string) => {
        if (readOnly) return;
        if (!draggedKey || draggedKey === key) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        const edge: DropTarget["edge"] = event.clientX - rect.left < rect.width / 2 ? "before" : "after";
        setDropTarget((current) => (current?.key === key && current.edge === edge ? current : { key, edge }));
    };

    /**
     * The fork. `dragend` fires on the source tab wherever the pointer was
     * released, including outside any valid drop target, which is exactly the
     * case a tear-off is.
     */
    const handleDragEnd = (event: React.DragEvent<HTMLDivElement>) => {
        if (readOnly) return;
        const dragged = draggedKey;
        const handled = handledRef.current;
        setDraggedKey(null);
        setDropTarget(null);
        handledRef.current = false;
        if (handled || !dragged || !onDetach) return;
        // Some browsers report (0,0) for a cancelled drag (Escape, drag off the
        // window chrome). Treating that as a release point would place a
        // detach at the top-left corner of the screen on every cancel.
        if (event.clientX === 0 && event.clientY === 0) return;
        const rect = stripRef.current?.getBoundingClientRect();
        if (!rect) return;
        const outside =
            event.clientX < rect.left - DETACH_SLACK_PX
            || event.clientX > rect.right + DETACH_SLACK_PX
            || event.clientY < rect.top - DETACH_SLACK_PX
            || event.clientY > rect.bottom + DETACH_SLACK_PX;
        // The release point travels with the call: `dragend` is the only event
        // that knows it, and by the time the window is built the pointer is
        // long gone.
        if (!outside) return;
        const tab = event.currentTarget.getBoundingClientRect();
        onDetach(
            dragged,
            { x: event.clientX, y: event.clientY },
            { left: tab.left, top: tab.top, width: tab.width, height: tab.height },
        );
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>, key: string) => {
        if (readOnly) return;
        event.preventDefault();
        const dragged = draggedKey;
        const target = dropTarget;
        handledRef.current = true;
        setDraggedKey(null);
        setDropTarget(null);
        if (!dragged || dragged === key) return;

        // Model tabs are excluded from the order handed to `onReorder`: they
        // are not draggable (see the `draggable` prop below), so `dragged` is
        // never one, but `tabs` may still contain one interspersed in the
        // strip. Leaving it in would make `reorderTabs`'s own tab list (which
        // never contains a model tab) come back shorter than `orderedKeys`,
        // and its length-mismatch guard would silently drop the whole reorder.
        const order = tabs.filter((tab) => tab.kind !== "model").map(chartTabKey);
        const from = order.indexOf(dragged);
        if (from === -1) return;
        order.splice(from, 1);
        let toIndex = order.indexOf(key);
        if (toIndex === -1) return;
        if (target?.edge === "after") toIndex += 1;
        order.splice(toIndex, 0, dragged);

        suppressClickRef.current = true;
        onReorder(order);
    };

    return (
        <div
            ref={stripRef}
            className="custom-scrollbar flex flex-wrap items-center gap-1.5 overflow-x-auto pb-1"
            role="tablist"
            aria-label={t("charts.symbolTabs")}
        >
            {tabs.map((tab) => {
                const key = chartTabKey(tab);
                const isActive = key === activeKey;
                // A tab the user added but the agent has not charted yet is
                // an honest placeholder — mark it as such.
                const isPending = tab.kind === "symbol" && tab.userAdded && tab.studies.length === 0;
                const isDragging = key === draggedKey;
                const isDropBefore = dropTarget?.key === key && dropTarget.edge === "before";
                const isDropAfter = dropTarget?.key === key && dropTarget.edge === "after";
                const label = tab.kind === "symbol" || tab.kind === "model" ? tab.symbol : overlayTabLabel(tab.overlay.symbols);
                return (
                    <div
                        key={key}
                        // A model tab comes straight from the backend's model list, not
                        // from a preference row (see ModelChartTab's doc comment), so it
                        // cannot be torn into a floating window — that path (`onDetach`)
                        // ends in `useDetachedTabs`/`preferencesFor`, neither of which
                        // knows what to do with one. Blocking the drag at its start is
                        // simpler and safer than trying to catch it further down.
                        draggable={!readOnly && tab.kind !== "model"}
                        onDragStart={(event) => handleDragStart(event, key)}
                        onDragOver={(event) => handleDragOver(event, key)}
                        onDrop={(event) => handleDrop(event, key)}
                        onDragEnd={handleDragEnd}
                        className={cn(
                            "group/tab relative flex shrink-0 cursor-grab items-center gap-1 rounded-[5px] border pl-2.5 pr-1.5 py-1 transition-colors active:cursor-grabbing",
                            isActive
                                ? "border-foreground/20 bg-foreground text-background"
                                : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/25 hover:bg-muted hover:text-foreground",
                            isDragging && "opacity-40",
                            isDropBefore && "border-l-2 border-l-foreground",
                            isDropAfter && "border-r-2 border-r-foreground",
                        )}
                    >
                        <button
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            onClick={() => {
                                if (suppressClickRef.current) {
                                    suppressClickRef.current = false;
                                    return;
                                }
                                onSelect(key);
                            }}
                            className="fin-figure flex items-center gap-1 text-xs font-semibold tracking-wide"
                        >
                            {/* The derived mark. An overlay is a piece of analysis,
                                not a ticker, and the strip has to say which it is
                                before the label is read. */}
                            {tab.kind === "overlay" && (
                                <Layers
                                    className="size-3 shrink-0"
                                    aria-label={t("charts.overlay.derivedHint")}
                                />
                            )}
                            {/* The workbook mark: a model tab is a DCF workbook, not a
                                ticker chart, and reads that way before the symbol does. */}
                            {tab.kind === "model" && <Table2 className="h-3 w-3 shrink-0" />}
                            {label}
                            {isPending && (
                                <span
                                    className="size-1 shrink-0 rounded-full bg-label-4"
                                    aria-label={t("charts.pendingHint")}
                                    title={t("charts.pendingHint")}
                                />
                            )}
                        </button>
                        {!readOnly && <button
                            type="button"
                            onClick={() => onClose(key)}
                            className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-background/20 focus-visible:opacity-100 group-hover/tab:opacity-100"
                            aria-label={t("charts.hideSymbol", { symbol: label })}
                            title={t("charts.hideSymbol", { symbol: label })}
                        >
                            <X className="size-3" />
                        </button>}
                    </div>
                );
            })}

            {!readOnly && (adding ? (
                <Input
                    ref={inputRef}
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value.toUpperCase())}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") commitAdd();
                        if (event.key === "Escape") {
                            setDraft("");
                            setAdding(false);
                        }
                    }}
                    onBlur={() => {
                        if (draft.trim()) commitAdd();
                        else setAdding(false);
                    }}
                    placeholder={t("charts.addSymbolPlaceholder")}
                    className="fin-figure h-[26px] w-20 shrink-0 rounded-[5px] border-border bg-muted/30 px-2 py-0 text-xs"
                />
            ) : (
                <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="flex size-[26px] shrink-0 items-center justify-center rounded-[5px] border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-muted hover:text-foreground"
                    aria-label={t("charts.addSymbol")}
                    title={t("charts.addSymbol")}
                >
                    <Plus className="size-3.5" />
                </button>
            ))}

            {!readOnly && tenantId && currentTopicId && onCompare && (
                <MemberPicker
                    tenantId={tenantId}
                    excludeTopicIds={[currentTopicId]}
                    onConfirm={onCompare}
                    trigger={
                        <button
                            type="button"
                            className="flex h-[26px] shrink-0 items-center gap-1 rounded-[5px] border border-dashed border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-muted hover:text-foreground"
                            aria-label={t("charts.compare")}
                            title={t("charts.compare")}
                        >
                            <Scale className="size-3.5" />
                            {t("charts.compare")}
                        </button>
                    }
                />
            )}
        </div>
    );
}
