import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Layers3 } from "lucide-react";
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

const MIN_CHART_HEIGHT = 320;
/** Height a chart is given inside a floating window, below its title bar. */
const FLOATING_CHROME_HEIGHT = 60;

/** One tab's chart, in whichever container is hosting it. Branching on `kind`
 *  rather than inspecting a symbol string is the whole point of the tagged
 *  union (design §6.2): the compiler, not a convention, keeps an overlay from
 *  being handed to the single-symbol renderer. */
function ChartForTab({ tab, height }: { tab: TopicChartTab; height: number }) {
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
    return tab.kind === "symbol" ? tab.symbol : overlayTabLabel(tab.overlay.symbols);
}

/**
 * The chart column of the three-column research workspace: a tab row the
 * user owns (add / close / drag to reorder / drag out) over the shared chart
 * renderer. Evolved from MarketChartWorkspace — collapse is gone (the split
 * ratio owns width allocation now), and the header height is measured instead
 * of assumed, since the tab row can wrap onto a second line.
 *
 * Tabs dragged past the strip become floating windows (design §5). That state
 * lives in `useDetachedTabs` and is deliberately never persisted, so this pane
 * always comes back from a reload with every tab in the strip.
 */
export function ChartPane({
    agentId,
    topicId,
    messages,
    streamingText,
    onCompare,
}: {
    agentId: UUID;
    topicId: UUID;
    messages: ChartWorkspaceMessage[];
    streamingText: string;
    /** Supplied only in a plain Topic view: renders the "+ compare" affordance
     *  on the tab row (spec §7.4). A Research view omits it — inside a Research
     *  the member row is already the place membership is edited, and a second
     *  entry point on the tab row would be offering to compare a comparison. */
    onCompare?: (topicIds: string[]) => void;
}) {
    const { t } = useTranslation();
    const { tabs, activeKey, setActiveTab, addSymbol, closeTab, reorderTabs } = useTopicCharts(
        agentId,
        topicId,
        messages,
        streamingText,
    );
    const narrow = useIsNarrow();

    const containerRef = useRef<HTMLElement>(null);
    const headerRef = useRef<HTMLElement>(null);
    const [containerHeight, setContainerHeight] = useState(
        () => (typeof window === "undefined" ? 628 : window.innerHeight),
    );
    const [headerHeight, setHeaderHeight] = useState(0);

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

    useEffect(() => {
        const container = containerRef.current;
        const header = headerRef.current;
        if (!container || !header) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const height = entry.contentRect.height;
                if (entry.target === container) setContainerHeight(height);
                if (entry.target === header) setHeaderHeight(height);
            }
        });
        observer.observe(container);
        observer.observe(header);
        return () => observer.disconnect();
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

    if (tabs.length === 0) return null;

    const chartHeight = Math.max(MIN_CHART_HEIGHT, Math.floor(containerHeight - headerHeight));

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
                    <div className="flex min-w-0 items-center gap-2">
                        <BarChart3 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <h2 className="fin-label truncate text-foreground/80">{t("charts.marketWorkspace")}</h2>
                    </div>
                    <div className="fin-label flex shrink-0 items-center gap-1 text-muted-foreground">
                        <Layers3 className="size-3" />
                        {active === undefined
                            ? t("charts.studyCount", { count: 0 })
                            : active.kind === "overlay"
                              ? t("charts.overlay.symbolCount", { count: active.overlay.symbols.length })
                              : t("charts.studyCount", { count: active.studies.length })}
                    </div>
                </div>

                <div className="mt-3">
                    <ChartTabBar
                        tabs={stripTabs}
                        activeKey={active ? chartTabKey(active) : undefined}
                        onSelect={setActiveTab}
                        onClose={closeTab}
                        onReorder={reorderTabs}
                        onAdd={addSymbol}
                        onDetach={narrow ? undefined : handleDetach}
                        agentId={onCompare ? agentId : undefined}
                        currentTopicId={onCompare ? topicId : undefined}
                        onCompare={onCompare}
                    />
                </div>
            </header>

            <div className="relative h-0 min-h-0 flex-1 overflow-hidden">
                <div className="custom-scrollbar absolute inset-0 overflow-y-auto overflow-x-hidden p-3">
                    {active ? (
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
