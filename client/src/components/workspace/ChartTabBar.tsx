import { useRef, useState } from "react";
import { Plus, Scale, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TopicChartTab } from "@/lib/topicCharts";
import type { UUID } from "@/types/core";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { MemberPicker } from "@/components/workspace/MemberPicker";

type DropTarget = { symbol: string; edge: "before" | "after" };

/**
 * The one chip shape the app uses for a symbol tab — also reused on the
 * strategies page. Tickers are data, so they get the figure face and a
 * square-ish chip rather than a pill.
 */
export function ChartTabBar({
    tabs,
    activeSymbol,
    onSelect,
    onHide,
    onReorder,
    onAdd,
    agentId,
    currentTopicId,
    onCompare,
}: {
    tabs: TopicChartTab[];
    activeSymbol: string | undefined;
    onSelect: (symbol: string) => void;
    onHide: (symbol: string) => void;
    /** Fired with the full symbol order after a drag-to-reorder drop. The tab
     *  set belongs to the user, so this is a persistent write, not view state. */
    onReorder: (orderedSymbols: string[]) => void;
    onAdd: (symbol: string) => void;
    /** Required together with `currentTopicId`/`onCompare` to render the "+ Compare" affordance (spec §7.4) — omit all three in contexts where spinning up a Research doesn't apply (e.g. inside a Research view's own tab bar). */
    agentId?: UUID;
    /** The Topic this tab bar belongs to — excluded from the picker's candidate list so a Topic can't be compared against itself. */
    currentTopicId?: UUID;
    /** Fired with the topic ids picked from `MemberPicker`. The caller owns turning that into a new Research (name join + `createResearch` + navigate) — this component only opens the selector. */
    onCompare?: (topicIds: string[]) => void;
}) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    // Native HTML5 drag-and-drop for tab reordering — no library, this is a
    // one-dimensional list reorder, the simplest case the browser API covers.
    const [draggedSymbol, setDraggedSymbol] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
    // A drop and the click it lands on fire in the same gesture on some
    // browsers; this suppresses the one click that immediately follows a drop
    // so a reorder never also re-selects the tab underneath the cursor.
    const suppressClickRef = useRef(false);

    const commitAdd = () => {
        const value = draft.trim();
        if (value) onAdd(value);
        setDraft("");
        setAdding(false);
    };

    const handleDragStart = (event: React.DragEvent<HTMLDivElement>, symbol: string) => {
        setDraggedSymbol(symbol);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", symbol);
    };

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>, symbol: string) => {
        if (!draggedSymbol || draggedSymbol === symbol) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        const edge: DropTarget["edge"] = event.clientX - rect.left < rect.width / 2 ? "before" : "after";
        setDropTarget((current) => (current?.symbol === symbol && current.edge === edge ? current : { symbol, edge }));
    };

    const handleDragEnd = () => {
        setDraggedSymbol(null);
        setDropTarget(null);
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>, symbol: string) => {
        event.preventDefault();
        const dragged = draggedSymbol;
        const target = dropTarget;
        setDraggedSymbol(null);
        setDropTarget(null);
        if (!dragged || dragged === symbol) return;

        const order = tabs.map((tab) => tab.symbol);
        const from = order.indexOf(dragged);
        if (from === -1) return;
        order.splice(from, 1);
        let toIndex = order.indexOf(symbol);
        if (toIndex === -1) return;
        if (target?.edge === "after") toIndex += 1;
        order.splice(toIndex, 0, dragged);

        suppressClickRef.current = true;
        onReorder(order);
    };

    return (
        <div
            className="custom-scrollbar flex flex-wrap items-center gap-1.5 overflow-x-auto pb-1"
            role="tablist"
            aria-label={t("charts.symbolTabs")}
        >
            {tabs.map((tab) => {
                const isActive = tab.symbol === activeSymbol;
                // A tab the user added but the agent has not charted yet is
                // an honest placeholder — mark it as such.
                const isPending = tab.userAdded && tab.studies.length === 0;
                const isDragging = tab.symbol === draggedSymbol;
                const isDropBefore = dropTarget?.symbol === tab.symbol && dropTarget.edge === "before";
                const isDropAfter = dropTarget?.symbol === tab.symbol && dropTarget.edge === "after";
                return (
                    <div
                        key={tab.symbol}
                        draggable
                        onDragStart={(event) => handleDragStart(event, tab.symbol)}
                        onDragOver={(event) => handleDragOver(event, tab.symbol)}
                        onDrop={(event) => handleDrop(event, tab.symbol)}
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
                                onSelect(tab.symbol);
                            }}
                            className="fin-figure flex items-center gap-1 text-xs font-semibold tracking-wide"
                        >
                            {tab.symbol}
                            {isPending && (
                                <span
                                    className="size-1 shrink-0 rounded-full bg-label-4"
                                    aria-label={t("charts.pendingHint")}
                                    title={t("charts.pendingHint")}
                                />
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={() => onHide(tab.symbol)}
                            className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-background/20 focus-visible:opacity-100 group-hover/tab:opacity-100"
                            aria-label={t("charts.hideSymbol", { symbol: tab.symbol })}
                            title={t("charts.hideSymbol", { symbol: tab.symbol })}
                        >
                            <X className="size-3" />
                        </button>
                    </div>
                );
            })}

            {adding ? (
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
            )}

            {agentId && currentTopicId && onCompare && (
                <MemberPicker
                    agentId={agentId}
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
