import { useMemo, useState } from "react";
import type { StockRange } from "@/lib/stockChart";
import type { TechnicalStudy } from "@/lib/chartWorkspace";
import { CANDLE_OVERLAY_COLORS } from "./charts/CandleScope";
import { StockChartView } from "./StockChart";

// StockChartView's quote row, status text, range controls, padding, and gaps
// live outside the canvas. Reserve their height so the canvas cannot make the
// measured workspace taller and trigger a ResizeObserver growth loop.
const STOCK_CHART_CHROME_HEIGHT = 112;
const OVERLAY_LEGEND_HEIGHT = 28;
const STUDY_PANE_HEIGHT = 192; // legend + 145px plot + x-axis tick row + padding

function formatValue(value: number): string {
    if (Math.abs(value) >= 1_000_000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function pointTimestamp(timestamp: string): number {
    return new Date(timestamp.length === 10 ? `${timestamp}T00:00:00Z` : timestamp).getTime();
}

function formatStudyTimestamp(timestampMs: number, dateOnly: boolean): string {
    return new Date(timestampMs).toLocaleString(undefined, dateOnly
        ? { year: "numeric", month: "2-digit", day: "2-digit" }
        : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Compact x-axis form, matching StockChart's axis labels. */
function formatStudyAxisTimestamp(timestampMs: number, dateOnly: boolean): string {
    return new Date(timestampMs).toLocaleString(undefined, dateOnly
        ? { month: "2-digit", day: "2-digit" }
        : { hour: "2-digit", minute: "2-digit" });
}

/** Index of the sampled timestamp closest to `timestamp` (timestamps ascending). */
function nearestTimestampIndex(timestamps: number[], timestamp: number): number {
    let nearest = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < timestamps.length; index++) {
        const distance = Math.abs(timestamps[index]! - timestamp);
        if (distance > bestDistance) break;
        bestDistance = distance;
        nearest = index;
    }
    return nearest;
}

function TechnicalStudyPane({ study }: { study: TechnicalStudy }) {
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);
    const geometry = useMemo(() => {
        const seriesPoints = study.series.map((series) => series.points
            .map((point) => ({ timestamp: pointTimestamp(point.timestamp), value: point.value }))
            .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)));
        const allPoints = seriesPoints.flat();
        if (allPoints.length === 0) return null;
        const values = [...allPoints.map((point) => point.value), ...study.referenceLevels];
        const minT = Math.min(...allPoints.map((point) => point.timestamp));
        const maxT = Math.max(...allPoints.map((point) => point.timestamp));
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
        const paths = seriesPoints.map((points) => points
            .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.timestamp).toFixed(2)},${y(point.value).toFixed(2)}`)
            .join(" "));
        // Shared hover axis: every timestamp any series samples, ascending.
        const timestamps = [...new Set(allPoints.map((point) => point.timestamp))].sort((left, right) => left - right);
        const valueBySeries = seriesPoints.map((points) => new Map(points.map((point) => [point.timestamp, point.value])));
        const timestampAtViewBoxX = (viewBoxX: number) => minT + ((viewBoxX - 24) / 912) * (maxT - minT);
        return { minY, maxY, x, y, paths, timestamps, valueBySeries, timestampAtViewBoxX };
    }, [study]);

    if (!geometry) return null;
    const hoverTimestamp = hoverIndex === null ? null : geometry.timestamps[hoverIndex] ?? null;
    const dateOnly = study.timeframe === "1Day";
    // x-axis ticks, positioned in percent so they stay put under the stretched viewBox.
    const tickCount = Math.min(5, geometry.timestamps.length);
    const ticks = Array.from({ length: tickCount }, (_, tick) => {
        const index = tickCount === 1
            ? 0
            : Math.round((tick * (geometry.timestamps.length - 1)) / (tickCount - 1));
        const timestamp = geometry.timestamps[index]!;
        return { timestamp, leftPercent: (geometry.x(timestamp) / 960) * 100, first: tick === 0, last: tick === tickCount - 1 };
    });
    return (
        <section className="rounded-lg border border-border/80 bg-card/20 px-3 py-2">
            <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <strong className="text-foreground">{study.indicator}</strong>
                <span className="text-muted-foreground">{study.timeframe}</span>
                {study.series.map((series, index) => {
                    const hovered = hoverTimestamp === null
                        ? undefined
                        : geometry.valueBySeries[index]?.get(hoverTimestamp);
                    const value = hoverTimestamp === null
                        ? series.points.at(-1)?.value
                        : hovered;
                    return (
                        <span key={series.key} className="flex items-center gap-1 text-muted-foreground">
                            <span className="size-2 rounded-full" style={{ backgroundColor: CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length] }} />
                            {series.label}: <span className="tabular-nums text-foreground">{value === undefined ? "—" : formatValue(value)}</span>
                        </span>
                    );
                })}
                <span className="tabular-nums text-muted-foreground">
                    {hoverTimestamp === null ? "最新" : formatStudyTimestamp(hoverTimestamp, dateOnly)}
                </span>
            </div>
            <svg
                className="block h-[145px] w-full"
                viewBox="0 0 960 145"
                preserveAspectRatio="none"
                role="img"
                aria-label={`${study.indicator} ${study.timeframe}`}
                style={{ cursor: "crosshair" }}
                onMouseMove={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (rect.width === 0) return;
                    const viewBoxX = ((event.clientX - rect.left) / rect.width) * 960;
                    setHoverIndex(nearestTimestampIndex(geometry.timestamps, geometry.timestampAtViewBoxX(viewBoxX)));
                }}
                onMouseLeave={() => setHoverIndex(null)}
            >
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
                {hoverTimestamp !== null && (
                    <g>
                        <line
                            x1={geometry.x(hoverTimestamp)}
                            x2={geometry.x(hoverTimestamp)}
                            y1="12"
                            y2="128"
                            stroke="currentColor"
                            className="text-muted-foreground"
                            strokeDasharray="2 3"
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                        />
                        {geometry.valueBySeries.map((valueAt, index) => {
                            const value = valueAt.get(hoverTimestamp);
                            if (value === undefined) return null;
                            return (
                                <circle
                                    key={study.series[index]?.key ?? index}
                                    cx={geometry.x(hoverTimestamp)}
                                    cy={geometry.y(value)}
                                    r="3"
                                    fill={CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length]}
                                />
                            );
                        })}
                    </g>
                )}
                <text x="940" y="14" className="fill-muted-foreground text-[10px]">{formatValue(geometry.maxY)}</text>
                <text x="940" y="132" className="fill-muted-foreground text-[10px]">{formatValue(geometry.minY)}</text>
            </svg>
            <div className="relative h-4 text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">
                {ticks.map(({ timestamp, leftPercent, first, last }) => (
                    <span
                        key={timestamp}
                        className="absolute whitespace-nowrap"
                        style={{
                            left: `${leftPercent}%`,
                            transform: first ? undefined : last ? "translateX(-100%)" : "translateX(-50%)",
                        }}
                    >
                        {formatStudyAxisTimestamp(timestamp, dateOnly)}
                    </span>
                ))}
            </div>
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
