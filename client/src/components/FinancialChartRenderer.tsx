import { useMemo } from "react";
import type { StockRange } from "@/lib/stockChart";
import type { TechnicalStudy } from "@/lib/chartWorkspace";
import { CANDLE_OVERLAY_COLORS } from "./cex/CandleScope";
import { StockChartView } from "./StockChart";

// StockChartView's quote row, status text, range controls, padding, and gaps
// live outside the canvas. Reserve their height so the canvas cannot make the
// measured workspace taller and trigger a ResizeObserver growth loop.
const STOCK_CHART_CHROME_HEIGHT = 112;
const OVERLAY_LEGEND_HEIGHT = 28;
const STUDY_PANE_HEIGHT = 175;

function formatValue(value: number): string {
    if (Math.abs(value) >= 1_000_000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function TechnicalStudyPane({ study }: { study: TechnicalStudy }) {
    const geometry = useMemo(() => {
        const allPoints = study.series.flatMap((series) => series.points.map((point) => ({
            timestamp: new Date(point.timestamp.length === 10 ? `${point.timestamp}T00:00:00Z` : point.timestamp).getTime(),
            value: point.value,
        })).filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)));
        if (allPoints.length === 0) return null;
        const timestamps = allPoints.map((point) => point.timestamp);
        const values = [...allPoints.map((point) => point.value), ...study.referenceLevels];
        const minT = Math.min(...timestamps);
        const maxT = Math.max(...timestamps);
        let minY = Math.min(...values);
        let maxY = Math.max(...values);
        if (minY === maxY) {
            minY -= 1;
            maxY += 1;
        }
        const padding = (maxY - minY) * 0.08;
        minY -= padding;
        maxY += padding;
        const x = (timestamp: number) => 24 + ((timestamp - minT) / Math.max(1, maxT - minT)) * 912;
        const y = (value: number) => 12 + (1 - (value - minY) / (maxY - minY)) * 116;
        const paths = study.series.map((series) => {
            const valid = series.points.map((point) => ({
                timestamp: new Date(point.timestamp.length === 10 ? `${point.timestamp}T00:00:00Z` : point.timestamp).getTime(),
                value: point.value,
            })).filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value));
            return valid.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.timestamp).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
        });
        return { minY, maxY, y, paths };
    }, [study]);

    if (!geometry) return null;
    return (
        <section className="rounded-lg border border-border/80 bg-card/20 px-3 py-2">
            <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <strong className="text-foreground">{study.indicator}</strong>
                <span className="text-muted-foreground">{study.timeframe}</span>
                {study.series.map((series, index) => (
                    <span key={series.key} className="flex items-center gap-1 text-muted-foreground">
                        <span className="size-2 rounded-full" style={{ backgroundColor: CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length] }} />
                        {series.label}: {formatValue(series.points.at(-1)?.value ?? 0)}
                    </span>
                ))}
            </div>
            <svg className="block h-[145px] w-full" viewBox="0 0 960 145" preserveAspectRatio="none" role="img" aria-label={`${study.indicator} ${study.timeframe}`}>
                {[0, 1, 2, 3].map((line) => (
                    <line key={line} x1="24" x2="936" y1={12 + line * 38.67} y2={12 + line * 38.67} stroke="currentColor" className="text-border" strokeWidth="1" />
                ))}
                {study.referenceLevels.map((level) => (
                    <line key={level} x1="24" x2="936" y1={geometry.y(level)} y2={geometry.y(level)} stroke="currentColor" className="text-muted-foreground" strokeDasharray="5 5" strokeWidth="1" />
                ))}
                {geometry.paths.map((path, index) => (
                    <path
                        key={study.series[index]?.key ?? index}
                        d={path}
                        fill="none"
                        stroke={CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length]}
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
                <text x="940" y="14" className="fill-muted-foreground text-[10px]">{formatValue(geometry.maxY)}</text>
                <text x="940" y="132" className="fill-muted-foreground text-[10px]">{formatValue(geometry.minY)}</text>
            </svg>
        </section>
    );
}

/** Unified frontend renderer for a symbol's price source and technical studies. */
export function FinancialChartRenderer({
    symbol,
    range,
    studies,
    height,
}: {
    symbol: string;
    range: StockRange;
    studies: TechnicalStudy[];
    height: number;
}) {
    const overlayStudies = studies.filter((study) => study.placement === "overlay");
    const paneStudies = studies.filter((study) => study.placement === "pane");
    const reservedHeight =
        STOCK_CHART_CHROME_HEIGHT
        + (overlayStudies.length > 0 ? OVERLAY_LEGEND_HEIGHT : 0)
        + Math.min(paneStudies.length, 1) * STUDY_PANE_HEIGHT;
    const priceHeight = Math.max(280, height - reservedHeight);

    return (
        <div className="space-y-2">
            {overlayStudies.length > 0 && (
                <div className="flex flex-wrap gap-2 px-1 text-[11px] text-muted-foreground">
                    {overlayStudies.flatMap((study) => study.series.map((series, index) => (
                        <span key={`${study.id}:${series.key}`} className="flex items-center gap-1">
                            <span className="size-2 rounded-full" style={{ backgroundColor: CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length] }} />
                            {series.label}
                        </span>
                    )))}
                    {overlayStudies.flatMap((study) => study.levels).map((level, index) => (
                        <span key={`${level.kind}:${level.value}:${index}`}>{level.label} {formatValue(level.value)}</span>
                    ))}
                </div>
            )}
            <StockChartView symbol={symbol} range={range} height={priceHeight} workspace studies={studies} />
            {paneStudies.map((study) => <TechnicalStudyPane key={study.id} study={study} />)}
        </div>
    );
}
