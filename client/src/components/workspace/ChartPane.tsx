import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Layers3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UUID } from "@/types/core";
import type { ChartWorkspaceMessage } from "@/lib/chartWorkspace";
import { useTopicCharts } from "@/hooks/useTopicCharts";
import { FinancialChartRenderer } from "@/components/FinancialChartRenderer";
import { MessageTimeContext } from "@/components/stockChartContext";
import { ChartTabBar } from "./ChartTabBar";

const MIN_CHART_HEIGHT = 320;

/**
 * The chart column of the three-column research workspace: a tab row the
 * user owns (add / hide / drag to reorder) over the shared chart renderer. Evolved from
 * MarketChartWorkspace — collapse is gone (the split ratio owns width
 * allocation now), and the header height is measured instead of assumed,
 * since the tab row can wrap onto a second line.
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
    const { tabs, activeSymbol, setActiveSymbol, addSymbol, hideSymbol, reorderTabs } = useTopicCharts(
        agentId,
        topicId,
        messages,
        streamingText,
    );

    const containerRef = useRef<HTMLElement>(null);
    const headerRef = useRef<HTMLElement>(null);
    const [containerHeight, setContainerHeight] = useState(
        () => (typeof window === "undefined" ? 628 : window.innerHeight),
    );
    const [headerHeight, setHeaderHeight] = useState(0);

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

    const active = useMemo(
        () => tabs.find((tab) => tab.symbol === activeSymbol) ?? tabs[0],
        [activeSymbol, tabs],
    );

    if (tabs.length === 0) return null;
    if (!active) return null;

    const chartHeight = Math.max(MIN_CHART_HEIGHT, Math.floor(containerHeight - headerHeight));

    return (
        <section
            ref={containerRef}
            className="tech-grid flex h-full max-h-full min-h-0 flex-col overflow-hidden border-r border-sep bg-background"
            aria-label={t("charts.marketWorkspace")}
        >
            <header ref={headerRef} className="material shrink-0 border-b border-sep px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <BarChart3 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <h2 className="fin-label truncate text-foreground/80">{t("charts.marketWorkspace")}</h2>
                    </div>
                    <div className="fin-label flex shrink-0 items-center gap-1 text-muted-foreground">
                        <Layers3 className="size-3" />
                        {t("charts.studyCount", { count: active.studies.length })}
                    </div>
                </div>

                <div className="mt-3">
                    <ChartTabBar
                        tabs={tabs}
                        activeSymbol={active.symbol}
                        onSelect={setActiveSymbol}
                        onHide={hideSymbol}
                        onReorder={reorderTabs}
                        onAdd={addSymbol}
                        agentId={onCompare ? agentId : undefined}
                        currentTopicId={onCompare ? topicId : undefined}
                        onCompare={onCompare}
                    />
                </div>
            </header>

            <div className="relative h-0 min-h-0 flex-1 overflow-hidden">
                <div className="custom-scrollbar absolute inset-0 overflow-y-auto overflow-x-hidden p-3">
                    <MessageTimeContext.Provider value={active.createdAt}>
                        <FinancialChartRenderer
                            key={active.symbol}
                            symbol={active.symbol}
                            range={active.range}
                            studies={active.studies}
                            height={chartHeight}
                        />
                    </MessageTimeContext.Provider>
                </div>
            </div>
        </section>
    );
}
