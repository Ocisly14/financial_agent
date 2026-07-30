import { useEffect, useMemo, useState } from "react";
import { BarChart3, Layers3, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SymbolChartWorkspace } from "@/lib/chartWorkspace";
import { cn } from "@/lib/utils";
import { FinancialChartRenderer } from "./FinancialChartRenderer";
import { MessageTimeContext } from "./stockChartContext";

const WORKSPACE_HEADER_HEIGHT = 92;

function viewportChartAreaHeight(): number {
    if (typeof window === "undefined") return 628;
    return Math.max(320, Math.floor(window.innerHeight - WORKSPACE_HEADER_HEIGHT));
}

/** Symbol tabs around the shared frontend chart renderer. */
export function MarketChartWorkspace({
    charts,
    focusSymbol,
    focusRevision,
    collapsed,
    onCollapsedChange,
}: {
    charts: SymbolChartWorkspace[];
    focusSymbol?: string;
    focusRevision: number;
    collapsed: boolean;
    onCollapsedChange: (collapsed: boolean) => void;
}) {
    const { t } = useTranslation();
    const [activeSymbol, setActiveSymbol] = useState(focusSymbol ?? charts[0]?.symbol);
    const [chartHeight, setChartHeight] = useState(viewportChartAreaHeight);

    useEffect(() => {
        if (focusSymbol) setActiveSymbol(focusSymbol);
    }, [focusSymbol, focusRevision]);

    useEffect(() => {
        const update = () => setChartHeight(viewportChartAreaHeight());
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, []);

    const active = useMemo(
        () => charts.find((chart) => chart.symbol === activeSymbol) ?? charts[0],
        [activeSymbol, charts],
    );
    if (!active) return null;

    if (collapsed) {
        return (
            <aside
                className="flex h-dvh max-h-dvh items-start justify-center overflow-hidden border-r border-sep bg-background py-3"
                aria-label={t("charts.marketWorkspace")}
            >
                <button
                    type="button"
                    onClick={() => onCollapsedChange(false)}
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t("charts.expandWorkspace")}
                    title={t("charts.expandWorkspace")}
                >
                    <PanelLeftOpen className="size-4" />
                </button>
            </aside>
        );
    }

    return (
        <section className="tech-grid flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden border-r border-sep bg-background" aria-label={t("charts.marketWorkspace")}>
            <header className="material shrink-0 border-b border-sep px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <BarChart3 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <h2 className="fin-label truncate text-foreground/80">{t("charts.marketWorkspace")}</h2>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <div className="fin-label flex items-center gap-1 text-muted-foreground">
                            <Layers3 className="size-3" />
                            {t("charts.studyCount", { count: active.studies.length })}
                        </div>
                        <button
                            type="button"
                            onClick={() => onCollapsedChange(true)}
                            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t("charts.collapseWorkspace")}
                            title={t("charts.collapseWorkspace")}
                        >
                            <PanelLeftClose className="size-4" />
                        </button>
                    </div>
                </div>

                <div className="custom-scrollbar mt-3 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label={t("charts.symbolTabs")}>
                    {charts.map((chart) => (
                        <button
                            key={chart.symbol}
                            type="button"
                            role="tab"
                            aria-selected={active.symbol === chart.symbol}
                            onClick={() => setActiveSymbol(chart.symbol)}
                            // Tickers are data, so they get the figure face and a
                            // square-ish chip rather than a pill.
                            className={cn(
                                "fin-figure shrink-0 rounded-[5px] border px-2.5 py-1 text-xs font-semibold tracking-wide transition-colors",
                                active.symbol === chart.symbol
                                    ? "border-foreground/20 bg-foreground text-background"
                                    : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/25 hover:bg-muted hover:text-foreground",
                            )}
                        >
                            {chart.symbol}
                        </button>
                    ))}
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
