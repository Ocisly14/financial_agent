import { useEffect, useMemo, useState } from "react";
import { BarChart3, Layers3 } from "lucide-react";
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
}: {
    charts: SymbolChartWorkspace[];
    focusSymbol?: string;
    focusRevision: number;
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

    return (
        <section className="flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden border-r border-border/80 bg-background" aria-label={t("charts.marketWorkspace")}>
            <header className="shrink-0 border-b border-border/80 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <BarChart3 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <h2 className="truncate text-sm font-semibold">{t("charts.marketWorkspace")}</h2>
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Layers3 className="size-3.5" />
                        {t("charts.studyCount", { count: active.studies.length })}
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
                            className={cn(
                                "shrink-0 rounded-md border px-3 py-1 text-xs font-semibold transition-colors",
                                active.symbol === chart.symbol
                                    ? "border-foreground/20 bg-foreground text-background"
                                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground",
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
