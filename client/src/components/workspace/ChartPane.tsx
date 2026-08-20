import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BarChart3, Layers3, Table2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UUID } from "@/types/core";
import type { ChartWorkspaceMessage } from "@/lib/chartWorkspace";
import { useTopicCharts } from "@/hooks/useTopicCharts";
import { useDetachedTabs } from "@/hooks/useDetachedTabs";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { cn } from "@/lib/utils";
import { chartTabKey, type TopicChartTab } from "@/lib/topicCharts";
import { overlayTabLabel } from "@/lib/overlayChart";
import { FinancialChartRenderer } from "@/components/FinancialChartRenderer";
import { OverlayChart } from "@/components/OverlayChart";
import { MessageTimeContext } from "@/components/stockChartContext";
import { ChartTabBar } from "./ChartTabBar";
import { FloatingChart } from "./FloatingChart";

/** Low enough that a short window still fits the chart's x-axis without scrolling. */
const MIN_CHART_HEIGHT = 200;
/** Height a chart is given inside a floating window, below its title bar. */
const FLOATING_CHROME_HEIGHT = 60;

/** The two same-level views this column can show. Charts and the DCF model
 *  are siblings, not parent and child: the model is a workbook, not another
 *  chart, so it gets its own view with its own icon rather than a tab hiding
 *  inside the market-chart strip. */
type PaneView = "charts" | "model";

/** One tab's chart, in whichever container is hosting it. Branching on `kind`
 *  rather than inspecting a symbol string is the whole point of the tagged
 *  union (design §6.2): the compiler, not a convention, keeps an overlay from
 *  being handed to the single-symbol renderer.
 *
 *  A model tab never reaches here — it renders in the model view instead —
 *  so its kind is excluded from the prop type rather than given a dead
 *  branch below. */
function ChartForTab({ tab, height }: { tab: Exclude<TopicChartTab, { kind: "model" }>; height: number }) {
    if (tab.kind === "overlay") {
        return <OverlayChart overlay={tab.overlay} height={height} />;
    }
    return (
        <MessageTimeContext.Provider value={tab.createdAt}>
            <FinancialChartRenderer
                symbol={tab.symbol}
                range={tab.range}
                studies={tab.studies}
                height={height}
            />
        </MessageTimeContext.Provider>
    );
}

function tabTitle(tab: TopicChartTab): string {
    if (tab.kind === "overlay") return overlayTabLabel(tab.overlay.symbols);
    return tab.symbol;
}

/** One of the two view buttons in the pane header. Same-level by construction:
 *  both views render through this one shape, so neither can quietly become a
 *  child of the other again. */
function ViewSwitchButton({
    icon,
    label,
    active,
    onClick,
}: {
    icon: ReactNode;
    label: string;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            onClick={onClick}
            className={cn(
                "fin-label flex min-w-0 items-center gap-2 rounded-[5px] px-2 py-1 transition-colors",
                active
                    ? "bg-muted text-foreground/80"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
        >
            {icon}
            <span className="truncate">{label}</span>
        </button>
    );
}

/**
 * The chart column of the three-column research workspace, with two
 * same-level views: the market charts (a tab row the user owns — add / close
 * / drag to reorder / drag out — over the shared chart renderer) and the DCF
 * model workbook. Each view has its own icon and title in the header
 * switcher; the model is NOT a tab inside the market-chart strip.
 *
 * Chart tabs dragged past the strip become floating windows (design §5). That
 * state lives in `useDetachedTabs` and is deliberately never persisted, so
 * this pane always comes back from a reload with every tab in the strip.
 */
export function ChartPane({
    tenantId,
    topicId,
    messages,
    streamingText,
    onCompare,
    modelTabs = [],
    modelPane = null,
    modelFocusRequest = null,
    activeModelId = null,
    onSelectModel,
    readOnly = false,
}: {
    tenantId: UUID;
    topicId: UUID;
    messages: ChartWorkspaceMessage[];
    streamingText: string;
    /** Supplied only in a plain Topic view: renders the "+ compare" affordance
     *  on the tab row (spec §7.4). A Research view omits it — inside a Research
     *  the member row is already the place membership is edited, and a second
     *  entry point on the tab row would be offering to compare a comparison. */
    onCompare?: (topicIds: string[]) => void;
    /** The model workbook(s) — handed in rather than fetched here, same
     *  reason ChartPane doesn't fetch chart data itself: a model is a backend
     *  object TopicWorkspace already reads via `useFinancialModel`, not
     *  something derived from `messages`/`streamingText` the way chart tabs
     *  are. Rendered as the model view's own workbook row, never folded into
     *  the market-chart strip. */
    modelTabs?: Extract<TopicChartTab, { kind: "model" }>[];
    /** Rendered content for the currently active model. Passed whole rather
     *  than assembled here, for the same reason as `modelTabs`. */
    modelPane?: ReactNode;
    /** The backend asking for a model to be brought on screen — raised once,
     *  when a model first appears, unless its producing tool opted out. The
     *  token makes a repeat request for the same model still register. This is
     *  the model-side twin of `useTopicCharts`' focusRevision pull, so an agent
     *  that builds something the user asked for shows it without being asked. */
    modelFocusRequest?: { modelId: string; token: number } | null;
    /** Which model `modelPane` is showing (useFinancialModel's effective id).
     *  Needed to mark the active chip on the model view's workbook row. */
    activeModelId?: string | null;
    /** Fired when the user picks a workbook on the model view's row — wired to
     *  `useFinancialModel`'s `setActiveModelId`, so picking actually swaps the
     *  workbook on screen. */
    onSelectModel?: (modelId: string) => void;
    /** Local replay mode: preserve viewing but prohibit chart preference writes. */
    readOnly?: boolean;
}) {
    const { t } = useTranslation();
    const { tabs, activeKey, setActiveTab, addSymbol, closeTab, reorderTabs } = useTopicCharts(
        tenantId,
        topicId,
        messages,
        streamingText,
    );
    const narrow = useIsNarrow();

    const hasModels = modelTabs.length > 0;
    // The user's explicit pick; the effective view falls back to whichever
    // side has content, so a topic whose only content is a model opens on it.
    const [pickedView, setPickedView] = useState<PaneView | null>(null);
    const view: PaneView = !hasModels ? "charts" : (pickedView ?? (tabs.length > 0 ? "charts" : "model"));

    // Keyed on the token, not the model id: the effect must fire again if the
    // backend asks for the same model twice, and must NOT fire on unrelated
    // re-renders in between.
    const focusTokenRef = useRef(modelFocusRequest?.token ?? 0);
    useEffect(() => {
        if (!modelFocusRequest || modelFocusRequest.token === focusTokenRef.current) return;
        focusTokenRef.current = modelFocusRequest.token;
        setPickedView("model");
        onSelectModel?.(modelFocusRequest.modelId);
    }, [modelFocusRequest, onSelectModel]);

    const containerRef = useRef<HTMLElement>(null);
    const headerRef = useRef<HTMLElement>(null);
    const scrollerObserverRef = useRef<ResizeObserver | null>(null);
    /** Content-box height of the scrolling area — the space a chart actually has. */
    const [paneHeight, setPaneHeight] = useState(
        () => (typeof window === "undefined" ? 628 : window.innerHeight),
    );

    const tabKeys = useMemo(() => tabs.map(chartTabKey), [tabs]);
    const { windows, detach, reattach, moveWindow, resizeWindow, raiseWindow } = useDetachedTabs(tabKeys);
    const detachedKeys = useMemo(() => new Set(windows.map((entry) => entry.key)), [windows]);

    // Below 1024px there is no room to place two charts side by side, which is
    // the only reason tear-off exists — so the gesture reorders and nothing
    // more (§5 rule 6). Passing `undefined` disables it at the source rather
    // than opening a window the layout cannot use.
    const handleDetach = useCallback(
        (
            key: string,
            releasePoint: { x: number; y: number },
            originRect: { left: number; top: number; width: number; height: number },
        ) => detach(key, containerRef.current?.getBoundingClientRect() ?? null, releasePoint, originRect),
        [detach],
    );

    // Re-docking. The drop target is the whole header band, not the tab strip's
    // exact bounds: the strip wraps, shrinks and shifts as tabs come and go, and
    // a target that moves under the user is a target they miss. Everything in
    // that band means the same thing anyway — "this is where tabs live".
    const [dockKey, setDockKey] = useState<string | null>(null);
    const overStrip = useCallback((point: { x: number; y: number }) => {
        const rect = headerRef.current?.getBoundingClientRect();
        return rect !== undefined
            && point.x >= rect.left && point.x <= rect.right
            && point.y >= rect.top && point.y <= rect.bottom;
    }, []);

    /**
     * Measure the scrolling area directly instead of deriving it as container minus header.
     *
     * That subtraction had to know the header's border box and the scroller's own padding, and
     * got both wrong — the chart came out ~50px taller than the space it had, which is why its
     * x-axis sat below the fold. The scroller is positioned `absolute inset-0`, so its height
     * comes from its parent and never from its content: measuring it cannot feed back into
     * itself, and its content box already excludes the padding a chart cannot draw into.
     */
    const attachScroller = useCallback((node: HTMLDivElement | null) => {
        scrollerObserverRef.current?.disconnect();
        scrollerObserverRef.current = null;
        if (!node) return;
        // A callback ref rather than an effect: this pane returns null before it has any tabs, so
        // an effect with empty deps would run once against a ref that was never attached and
        // never retry — leaving the height stuck at its initial guess.
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) setPaneHeight(entry.contentRect.height);
        });
        observer.observe(node);
        scrollerObserverRef.current = observer;
    }, []);

    // A detached tab leaves the strip (§5 rule 1).
    const stripTabs = useMemo(
        () => tabs.filter((tab) => !detachedKeys.has(chartTabKey(tab))),
        [tabs, detachedKeys],
    );
    const active = useMemo(
        () => stripTabs.find((tab) => chartTabKey(tab) === activeKey) ?? stripTabs[0],
        [activeKey, stripTabs],
    );
    const byKey = useMemo(() => new Map(tabs.map((tab) => [chartTabKey(tab), tab])), [tabs]);

    if (tabs.length === 0 && !hasModels) return null;

    const chartHeight = Math.max(MIN_CHART_HEIGHT, Math.floor(paneHeight));
    const effectiveModelId = activeModelId ?? modelTabs[0]?.modelId ?? null;

    return (
        <section
            ref={containerRef}
            className="tech-grid flex h-full max-h-full min-h-0 flex-col overflow-hidden border-r border-sep bg-background"
            aria-label={t("charts.marketWorkspace")}
        >
            <header
                ref={headerRef}
                className={cn(
                    "material shrink-0 border-b border-sep px-4 py-3 transition-colors",
                    dockKey !== null && "bg-brand-sub ring-1 ring-inset ring-brand",
                )}
            >
                <div className="flex items-center justify-between gap-3">
                    {hasModels ? (
                        // The same-level switcher: charts and the DCF model are
                        // siblings, each with its own icon and title.
                        <div role="tablist" className="flex min-w-0 items-center gap-1">
                            <ViewSwitchButton
                                icon={<BarChart3 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                                label={t("charts.marketWorkspace")}
                                active={view === "charts"}
                                onClick={() => setPickedView("charts")}
                            />
                            <ViewSwitchButton
                                icon={<Table2 className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />}
                                label={t("charts.modelWorkspace")}
                                active={view === "model"}
                                onClick={() => setPickedView("model")}
                            />
                        </div>
                    ) : (
                        <div className="flex min-w-0 items-center gap-2">
                            <BarChart3 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                            <h2 className="fin-label truncate text-foreground/80">{t("charts.marketWorkspace")}</h2>
                        </div>
                    )}
                    {view === "charts" && (
                        <div className="fin-label flex shrink-0 items-center gap-1 text-muted-foreground">
                            <Layers3 className="size-3" />
                            {active === undefined
                                ? t("charts.studyCount", { count: 0 })
                                : active.kind === "overlay"
                                  ? t("charts.overlay.symbolCount", { count: active.overlay.symbols.length })
                                  : t("charts.studyCount", { count: active.studies.length })}
                        </div>
                    )}
                </div>

                <div className="mt-3">
                    {view === "charts" ? (
                        <ChartTabBar
                            tabs={stripTabs}
                            activeKey={active ? chartTabKey(active) : undefined}
                            onSelect={setActiveTab}
                            onClose={closeTab}
                            onReorder={reorderTabs}
                            onAdd={addSymbol}
                            onDetach={narrow || readOnly ? undefined : handleDetach}
                            tenantId={onCompare ? tenantId : undefined}
                            currentTopicId={onCompare ? topicId : undefined}
                            onCompare={onCompare}
                            readOnly={readOnly}
                        />
                    ) : (
                        // The model view's own workbook row. Chips echo the chart
                        // tab shape so the two views read as one family, but a
                        // workbook can't be closed, reordered, or torn off — the
                        // backend's model list, not a preference row, owns it.
                        <div
                            role="tablist"
                            aria-label={t("charts.modelTabs")}
                            className="flex flex-wrap items-center gap-1.5"
                        >
                            {modelTabs.map((tab) => {
                                const isActive = tab.modelId === effectiveModelId;
                                return (
                                    <button
                                        key={tab.modelId}
                                        type="button"
                                        role="tab"
                                        aria-selected={isActive}
                                        onClick={() => onSelectModel?.(tab.modelId)}
                                        className={cn(
                                            "fin-figure flex shrink-0 items-center gap-1 rounded-[5px] border px-2.5 py-1 text-xs font-semibold tracking-wide transition-colors",
                                            isActive
                                                ? "border-foreground/20 bg-foreground text-background"
                                                : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/25 hover:bg-muted hover:text-foreground",
                                        )}
                                    >
                                        <Table2 className="h-3 w-3 shrink-0" />
                                        {tab.symbol}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </header>

            <div className="relative h-0 min-h-0 flex-1 overflow-hidden">
                <div ref={attachScroller} className="custom-scrollbar absolute inset-0 overflow-y-auto overflow-x-hidden p-3">
                    {view === "model" ? (
                        modelPane
                    ) : active ? (
                        <ChartForTab key={chartTabKey(active)} tab={active} height={chartHeight} />
                    ) : (
                        // Every tab is out in a window. Say so, rather than
                        // rendering a blank column that reads as a failure.
                        <p className="flex h-full items-center justify-center px-6 text-center text-xs text-label-3">
                            {t("charts.floating.allDetached")}
                        </p>
                    )}
                </div>
            </div>

            {/* Array order is z-order: the last entry is frontmost. */}
            {windows.map((entry, index) => {
                const tab = byKey.get(entry.key);
                if (!tab) return null;
                return (
                    <FloatingChart
                        key={entry.key}
                        title={tabTitle(tab)}
                        openFrom={entry.origin}
                        x={entry.x}
                        y={entry.y}
                        width={entry.width}
                        height={entry.height}
                        onMove={(x, y) => moveWindow(entry.key, x, y)}
                        onResize={(width, height) => resizeWindow(entry.key, width, height)}
                        onDragPoint={(point) =>
                            setDockKey(point !== null && overStrip(point) ? entry.key : null)}
                        onDropPoint={(point) => {
                            setDockKey(null);
                            if (overStrip(point)) {
                                reattach(entry.key);
                                setActiveTab(entry.key);
                            }
                        }}
                        // Back to the strip. NOT closeTab — deletion is the `×`
                        // on the tab and only that (§5 rule 2).
                        onClose={() => reattach(entry.key)}
                        onFocus={() => raiseWindow(entry.key)}
                        isTop={index === windows.length - 1}
                    >
                        <ChartForTab tab={tab} height={Math.max(160, entry.height - FLOATING_CHROME_HEIGHT)} />
                    </FloatingChart>
                );
            })}
        </section>
    );
}
