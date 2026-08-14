import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { StockRange } from "@/lib/stockChart";
import type { TechnicalStudy } from "@/lib/chartWorkspace";
import { CANDLE_OVERLAY_COLORS } from "./charts/CandleScope";
import { StockChartView } from "./StockChart";

// StockChartView's quote row, status text, range controls, padding, and gaps
// live outside the canvas. Reserve their height so the canvas cannot make the
// measured workspace taller and trigger a ResizeObserver growth loop.
// Includes the surrounding card's own p-4 padding: leaving those 32px out made the
// card taller than its scroll container, which is what put the x-axis below the fold.
const STOCK_CHART_CHROME_HEIGHT = 144;
const OVERLAY_LEGEND_HEIGHT = 28;
const STUDY_PANE_HEIGHT = 204; // legend row + 145px plot + x-axis tick row + padding + border
/** Below this a candlestick plot stops being readable; above it the pane simply follows its container. */
const MIN_PRICE_PANE_HEIGHT = 160;

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

/** Calibrated gridline values: round numbers stepping through the domain. */
function valueTicks(minY: number, maxY: number, target = 4): Array<{ value: number; label: string }> {
    const span = maxY - minY;
    if (!(span > 0)) return [];
    const rough = span / target;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const multiple = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= rough) ?? 10;
    const step = multiple * magnitude;
    // Enough decimals to print the step exactly: the 2.5 step needs one more
    // than its magnitude, the 10 step one fewer.
    const decimals = Math.min(6, Math.max(
        0,
        -Math.floor(Math.log10(magnitude)) + (multiple === 2.5 ? 1 : multiple === 10 ? -1 : 0),
    ));
    const ticks: Array<{ value: number; label: string }> = [];
    for (let index = Math.ceil(minY / step); index * step <= maxY; index++) {
        const value = Number((index * step).toPrecision(12));
        ticks.push({ value, label: value.toFixed(decimals) });
    }
    return ticks;
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

// Pane plot band inside the stretched viewBox. The right gutter carries the
// value ticks, mirroring the price chart's right-hand price scale.
const PANE_VIEW = { width: 960, height: 145 };
const PANE_PLOT = { left: 10, right: 876, top: 14, bottom: 126 };

function TechnicalStudyPane({ study }: { study: TechnicalStudy }) {
    const { t } = useTranslation();
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
        const { left, right, top, bottom } = PANE_PLOT;
        const x = (timestamp: number) => left + ((timestamp - minT) / Math.max(1, maxT - minT)) * (right - left);
        const y = (value: number) => top + (1 - (value - minY) / (maxY - minY)) * (bottom - top);
        const paths = seriesPoints.map((points) => points
            .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.timestamp).toFixed(2)},${y(point.value).toFixed(2)}`)
            .join(" "));
        // Shared hover axis: every timestamp any series samples, ascending.
        const timestamps = [...new Set(allPoints.map((point) => point.timestamp))].sort((left, right) => left - right);
        const valueBySeries = seriesPoints.map((points) => new Map(points.map((point) => [point.timestamp, point.value])));
        const timestampAtViewBoxX = (viewBoxX: number) =>
            minT + ((viewBoxX - left) / (right - left)) * (maxT - minT);
        const lastBySeries = seriesPoints.map((points) => points.at(-1) ?? null);
        return {
            minY,
            maxY,
            x,
            y,
            paths,
            timestamps,
            valueBySeries,
            lastBySeries,
            timestampAtViewBoxX,
            ticks: valueTicks(minY, maxY),
            zeroCrossing: minY < 0 && maxY > 0,
        };
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
        return {
            timestamp,
            leftPercent: (geometry.x(timestamp) / PANE_VIEW.width) * 100,
            first: tick === 0,
            last: tick === tickCount - 1,
        };
    });
    const hovering = hoverTimestamp !== null;
    // RSI-style panes ship a pair of reference levels; shade the band between
    // them so the neutral zone reads without extra chrome.
    const band = study.referenceLevels.length === 2
        ? [Math.min(...study.referenceLevels), Math.max(...study.referenceLevels)] as const
        : null;
    return (
        <section className="animate-in fade-in slide-in-from-bottom-1 rounded-lg border border-sep bg-gradient-to-b from-muted/25 to-transparent px-3 pb-1.5 pt-2 duration-500">
            <header className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <strong className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground">
                    {study.indicator}
                </strong>
                <span className="rounded border border-sep px-1 py-px font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    {study.timeframe}
                </span>
                {study.series.map((series, index) => {
                    const color = CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length];
                    const value = hoverTimestamp === null
                        ? geometry.lastBySeries[index]?.value
                        : geometry.valueBySeries[index]?.get(hoverTimestamp);
                    return (
                        <span key={series.key} className="flex items-center gap-1.5 text-muted-foreground">
                            <span className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                            <span>{series.label}</span>
                            <span className="font-mono tabular-nums text-foreground">
                                {value === undefined ? "—" : formatValue(value)}
                            </span>
                        </span>
                    );
                })}
                <span className={cn(
                    "ml-auto font-mono text-[9px] uppercase tracking-wider transition-colors",
                    hovering ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/70",
                )}>
                    {hoverTimestamp === null ? t("charts.latest") : formatStudyTimestamp(hoverTimestamp, dateOnly)}
                </span>
            </header>
            <svg
                className="block h-[145px] w-full cursor-crosshair"
                viewBox={`0 0 ${PANE_VIEW.width} ${PANE_VIEW.height}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`${study.indicator} ${study.timeframe}`}
                onMouseMove={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (rect.width === 0) return;
                    const viewBoxX = ((event.clientX - rect.left) / rect.width) * PANE_VIEW.width;
                    setHoverIndex(nearestTimestampIndex(geometry.timestamps, geometry.timestampAtViewBoxX(viewBoxX)));
                }}
                onMouseLeave={() => setHoverIndex(null)}
            >
                {band && (
                    <rect
                        x={PANE_PLOT.left}
                        width={PANE_PLOT.right - PANE_PLOT.left}
                        y={geometry.y(band[1])}
                        height={Math.max(0, geometry.y(band[0]) - geometry.y(band[1]))}
                        className="fill-muted-foreground/[0.06]"
                    />
                )}

                {/* calibrated grid: round values, labelled in the right gutter */}
                {geometry.ticks.map(({ value, label }) => (
                    <g key={value}>
                        <line
                            x1={PANE_PLOT.left}
                            x2={PANE_PLOT.right}
                            y1={geometry.y(value)}
                            y2={geometry.y(value)}
                            stroke="currentColor"
                            className={value === 0 && geometry.zeroCrossing ? "text-border" : "text-border/60"}
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                        />
                        <text
                            x={PANE_PLOT.right + 8}
                            y={geometry.y(value) + 3.5}
                            className="fill-muted-foreground/80 font-mono text-[10px] tabular-nums"
                        >
                            {label}
                        </text>
                    </g>
                ))}

                {study.referenceLevels.map((level) => (
                    <g key={level}>
                        <line
                            x1={PANE_PLOT.left}
                            x2={PANE_PLOT.right}
                            y1={geometry.y(level)}
                            y2={geometry.y(level)}
                            stroke="currentColor"
                            className="text-muted-foreground/60"
                            strokeDasharray="5 5"
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                        />
                        <text
                            x={PANE_PLOT.left + 4}
                            y={geometry.y(level) - 4}
                            className="fill-muted-foreground/70 font-mono text-[9px] tabular-nums"
                        >
                            {formatValue(level)}
                        </text>
                    </g>
                ))}

                {geometry.paths.map((path, index) => (
                    <path
                        key={study.series[index]?.key ?? index}
                        d={path}
                        fill="none"
                        stroke={CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length]}
                        strokeWidth="1.75"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                    />
                ))}

                {/* latest sample of each series, so the pane always shows "now" */}
                {!hovering && geometry.lastBySeries.map((last, index) => last && (
                    <circle
                        key={study.series[index]?.key ?? index}
                        cx={geometry.x(last.timestamp)}
                        cy={geometry.y(last.value)}
                        r="2.4"
                        fill={CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length]}
                    />
                ))}

                {hoverTimestamp !== null && (
                    <g>
                        <line
                            x1={geometry.x(hoverTimestamp)}
                            x2={geometry.x(hoverTimestamp)}
                            y1={PANE_PLOT.top}
                            y2={PANE_PLOT.bottom}
                            stroke="currentColor"
                            className="text-amber-500/70"
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
                                    r="3.2"
                                    fill={CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length]}
                                    stroke="currentColor"
                                    className="text-background"
                                    strokeWidth="1.5"
                                    vectorEffect="non-scaling-stroke"
                                />
                            );
                        })}
                    </g>
                )}
            </svg>
            <div className="relative h-4 font-mono text-[10px] tabular-nums" aria-hidden="true">
                {ticks.map(({ timestamp, leftPercent, first, last }) => (
                    <span
                        key={timestamp}
                        className={cn(
                            "absolute whitespace-nowrap transition-opacity",
                            hovering ? "text-muted-foreground/40" : "text-muted-foreground/80",
                        )}
                        style={{
                            left: `${leftPercent}%`,
                            transform: first ? undefined : last ? "translateX(-100%)" : "translateX(-50%)",
                        }}
                    >
                        {formatStudyAxisTimestamp(timestamp, dateOnly)}
                    </span>
                ))}
                {hoverTimestamp !== null && (
                    <span
                        className="absolute -translate-x-1/2 whitespace-nowrap rounded bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400"
                        style={{ left: `${(geometry.x(hoverTimestamp) / PANE_VIEW.width) * 100}%` }}
                    >
                        {formatStudyAxisTimestamp(hoverTimestamp, dateOnly)}
                    </span>
                )}
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
    const priceHeight = Math.max(MIN_PRICE_PANE_HEIGHT, height - reservedHeight);

    return (
        <div className="space-y-2">
            {overlayStudies.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
                    {overlayStudies.flatMap((study) => study.series.map((series, index) => (
                        <span key={`${study.id}:${series.key}`} className="flex items-center gap-1.5">
                            <span className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: CANDLE_OVERLAY_COLORS[index % CANDLE_OVERLAY_COLORS.length] }} />
                            {series.label}
                        </span>
                    )))}
                    {overlayStudies.flatMap((study) => study.levels).map((level, index) => (
                        <span key={`${level.kind}:${level.value}:${index}`} className="flex items-center gap-1.5">
                            <span className="inline-block h-px w-3 shrink-0 bg-muted-foreground/60" />
                            {level.label}
                            <span className="font-mono tabular-nums text-foreground">{formatValue(level.value)}</span>
                        </span>
                    ))}
                </div>
            )}
            <StockChartView symbol={symbol} range={range} height={priceHeight} workspace studies={studies} />
            {paneStudies.map((study) => <TechnicalStudyPane key={study.id} study={study} />)}
        </div>
    );
}
