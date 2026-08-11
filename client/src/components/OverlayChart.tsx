import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { OverlaySpec } from "@/types/core";
import { normalizeOverlay, type SeriesInput } from "@/lib/overlayNormalize";
import {
    brushToWindow,
    formatBaseDate,
    formatOverlayValue,
    overlayTabLabel,
    overlayValueTicks,
    resolveOverlayRange,
    seriesColor,
} from "@/lib/overlayChart";
import { fetchStockQuote } from "./StockChart";

/** Plot insets in CSS pixels. The right gutter carries the value scale, matching
 *  the price chart's right-hand scale; the bottom strip carries date ticks. */
const PLOT = { left: 8, right: 56, top: 12, bottom: 22 };
const MIN_PLOT_WIDTH = 120;
/** Below this drag width the gesture is a click, not a zoom. */
const MIN_BRUSH_PX = 12;

type ZoomWindow = { from: string; to: string };

/** Live pixel size of an element, so the plot can be drawn in real coordinates
 *  instead of a stretched viewBox — a stretched viewBox distorts every label.
 *
 *  The height must be measured, not taken from the caller's prop: the plot is a
 *  flex item sharing the column with a header and a legend, so its real height
 *  is always less than the height the pane budgeted for the whole chart. An SVG
 *  drawn at the budgeted height inside a shorter box has no viewBox to scale it,
 *  so the surplus is simply cut off the bottom — which is where the low end of
 *  the value scale, and with it every line under 0%, would have been. */
function useElementSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const read = (box: { width: number; height: number }) =>
            setSize((current) =>
                current.width === box.width && current.height === box.height
                    ? current
                    : { width: box.width, height: box.height },
            );
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) read(entry.contentRect);
        });
        observer.observe(element);
        read(element.getBoundingClientRect());
        return () => observer.disconnect();
    }, [ref]);
    return size;
}

/**
 * One normalized chart carrying several tickers.
 *
 * Two things about this component are load-bearing rather than decorative:
 *
 * 1. **The basis label is permanent** (design §3.3). The agent chooses the
 *    normalization mode per question, so the same question asked twice can
 *    produce charts on different scales. A reader who can see `% change ·
 *    from 2026-06-30` cannot misread the chart; a reader who cannot see it
 *    has no way to know the scale changed. That makes the label the thing
 *    that keeps "let the agent choose" from being a trap, not a caption.
 *
 * 2. **Dropped symbols are named** (design §3.4). A symbol that had no
 *    overlapping data is listed in the legend as unavailable rather than
 *    quietly omitted — a comparison silently missing one of its subjects is
 *    a wrong answer that looks like a right one.
 *
 * All alignment and rebasing maths lives in `lib/overlayNormalize.ts`; this
 * component only chooses the visible window and draws the result.
 */
export function OverlayChart({ overlay, height }: { overlay: OverlaySpec; height: number }) {
    const { t } = useTranslation();
    const range = resolveOverlayRange(overlay.range);
    const plotRef = useRef<HTMLDivElement>(null);
    const size = useElementSize(plotRef);
    const width = size.width;
    // `height` is what the pane budgeted for the whole chart, header and legend
    // included; it is only a stand-in for the first frame, before the observer
    // has reported the box the plot actually got.
    const plotBoxHeight = size.height > 0 ? size.height : height;

    // Zoom window. Only `from` reaches the normalizer — that is the design's
    // whole point: the base follows the left edge of what you are looking at
    // (§3.2). `to` never touches the maths, it only clips which already
    // normalized points get drawn.
    const [zoom, setZoom] = useState<ZoomWindow | null>(null);
    const [brush, setBrush] = useState<{ from: number; to: number } | null>(null);
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);

    // One query per symbol, sharing `StockChart`'s key and fetcher, so a symbol
    // the user already has open in its own tab resolves from cache. `useQueries`
    // rather than a mapped `useQuery` because the symbol count varies (2–6) and
    // a variable number of hooks is not a thing React allows.
    const results = useQueries({
        queries: overlay.symbols.map((symbol) => ({
            queryKey: ["stock-candles", symbol, range],
            queryFn: () => fetchStockQuote(symbol, range),
            staleTime: 5 * 60_000,
            refetchOnWindowFocus: false,
        })),
    });

    const pending = results.some((result) => result.isPending);
    // Deliberately not `results` itself: react-query hands back a new result
    // array identity on every render, which would defeat every memo below.
    const dataKey = results.map((result) => result.data?.fetchedAtMs ?? 0).join(",");
    const inputs = useMemo<SeriesInput[]>(
        () => overlay.symbols.map((symbol, index) => ({
            symbol,
            bars: (results[index]?.data?.candles ?? []).map((candle) => ({ t: candle.t, c: candle.c })),
        })),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dataKey stands in for the unstable results array
        [overlay.symbols, dataKey],
    );

    const normalized = useMemo(
        () => normalizeOverlay(inputs, overlay.normalize, zoom?.from),
        [inputs, overlay.normalize, zoom?.from],
    );

    // Clip to the window's right edge. If clipping would leave fewer than two
    // points — the axis can shift under a refetch — the window is treated as
    // stale and the full result is shown rather than an empty chart.
    const view = useMemo(() => {
        if (!zoom) return normalized;
        const axis = normalized.axis.filter((timestamp) => timestamp <= zoom.to);
        if (axis.length < 2) return normalized;
        return {
            axis,
            dropped: normalized.dropped,
            series: normalized.series.map((series) => ({
                ...series,
                points: series.points.filter((point) => point.t <= zoom.to),
            })),
        };
    }, [normalized, zoom]);

    const geometry = useMemo(() => {
        const plotWidth = Math.max(MIN_PLOT_WIDTH, width - PLOT.left - PLOT.right);
        const plotHeight = Math.max(60, plotBoxHeight - PLOT.top - PLOT.bottom);
        const values = view.series.flatMap((series) => series.points.map((point) => point.v));
        if (view.axis.length < 2 || values.length === 0) return null;
        let minValue = Math.min(...values);
        let maxValue = Math.max(...values);
        if (minValue === maxValue) {
            minValue -= 1;
            maxValue += 1;
        }
        const pad = (maxValue - minValue) * 0.08;
        minValue -= pad;
        maxValue += pad;
        const indexOf = new Map(view.axis.map((timestamp, index) => [timestamp, index]));
        const lastIndex = view.axis.length - 1;
        const x = (index: number) => PLOT.left + (index / lastIndex) * plotWidth;
        const y = (value: number) => PLOT.top + (1 - (value - minValue) / (maxValue - minValue)) * plotHeight;
        const paths = view.series.map((series) => series.points
            .map((point, order) => {
                const index = indexOf.get(point.t);
                if (index === undefined) return null;
                return `${order === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(point.v).toFixed(2)}`;
            })
            .filter((command): command is string => command !== null)
            .join(" "));
        const valueAt = view.series.map((series) => new Map(series.points.map((point) => [point.t, point.v])));
        return {
            plotWidth,
            plotHeight,
            minValue,
            maxValue,
            x,
            y,
            paths,
            valueAt,
            lastIndex,
            ticks: overlayValueTicks(minValue, maxValue),
            baseline: minValue < (overlay.normalize === "pct" ? 0 : 100)
                && maxValue > (overlay.normalize === "pct" ? 0 : 100),
        };
    }, [view, width, height, overlay.normalize]);

    const title = overlayTabLabel(overlay.symbols);
    const modeLabel = overlay.normalize === "pct" ? t("charts.overlay.modePct") : t("charts.overlay.modeIndex100");
    // The shared base is the first axis point; a symbol that listed later
    // carries its own and says so in the legend rather than borrowing this one.
    const baseDate = view.axis[0] ? formatBaseDate(view.axis[0]) : null;

    const fractionOf = (event: React.MouseEvent<HTMLDivElement>): number => {
        const rect = event.currentTarget.getBoundingClientRect();
        const plotWidth = Math.max(MIN_PLOT_WIDTH, rect.width - PLOT.left - PLOT.right);
        return Math.max(0, Math.min(1, (event.clientX - rect.left - PLOT.left) / plotWidth));
    };

    const hoverTimestamp = hoverIndex === null ? null : view.axis[hoverIndex] ?? null;
    /** A drag wide enough to be a zoom selection rather than a stray press —
     *  while one is in progress the readout would sit on top of the band the
     *  user is sizing. */
    const brushing = brush !== null && Math.abs(brush.to - brush.from) > 0.001;

    return (
        <section
            className="flex h-full flex-col rounded-lg border border-sep bg-raised p-4"
            aria-label={t("charts.overlay.chartLabel", { symbols: overlay.symbols.join(", ") })}
        >
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="fin-figure text-sm font-semibold text-label-1">{title}</h3>
                {/*
                  * The basis line. Permanent by design (§3.3) — it is never
                  * hidden behind a hover, a tooltip, or a settings panel,
                  * because a reader who has to ask what scale they are on has
                  * already been misled.
                  */}
                <p className="fin-figure text-[11px] text-label-2" aria-label={t("charts.overlay.basisLabel")}>
                    {baseDate === null
                        ? modeLabel
                        : t("charts.overlay.basis", { mode: modeLabel, date: baseDate })}
                </p>
                <span className="ml-auto flex items-center gap-2">
                    {zoom && (
                        <button
                            type="button"
                            onClick={() => setZoom(null)}
                            className="rounded-xs bg-fill-1 px-2 py-0.5 text-[11px] text-label-2 transition-colors hover:bg-fill-2 hover:text-label-1"
                        >
                            {t("charts.overlay.resetZoom")}
                        </button>
                    )}
                    <span className="fin-figure text-[11px] text-label-3">
                        {hoverTimestamp === null ? t("charts.latest") : formatBaseDate(hoverTimestamp)}
                    </span>
                </span>
            </header>

            <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                {view.series.map((series, index) => {
                    const value = hoverTimestamp === null
                        ? series.points.at(-1)?.v
                        : geometry?.valueAt[index]?.get(hoverTimestamp);
                    const ownBase = formatBaseDate(series.baseDate);
                    return (
                        <li key={series.symbol} className="flex items-center gap-1.5 text-label-2">
                            <span
                                className="inline-block h-0.5 w-3 shrink-0 rounded-full"
                                style={{ backgroundColor: seriesColor(index) }}
                            />
                            <span className="fin-figure font-semibold text-label-1">{series.symbol}</span>
                            <span className="fin-figure text-label-1">
                                {value === undefined ? "—" : formatOverlayValue(value, overlay.normalize)}
                            </span>
                            {/* A late lister keeps its own base; saying so is the
                                difference between an honest line and a fabricated gain. */}
                            {ownBase !== baseDate && (
                                <span className="fin-figure text-label-3">
                                    {t("charts.overlay.rebasedFrom", { date: ownBase })}
                                </span>
                            )}
                        </li>
                    );
                })}
                {view.dropped.map((symbol) => (
                    <li key={symbol} className="flex items-center gap-1.5 text-label-3">
                        <span className="inline-block h-0.5 w-3 shrink-0 rounded-full bg-label-4" />
                        <span className="fin-figure font-semibold line-through">{symbol}</span>
                        <span>{t("charts.overlay.unavailable")}</span>
                    </li>
                ))}
            </ul>

            <div
                ref={plotRef}
                className="relative mt-2 min-h-0 flex-1 select-none"
                onMouseDown={(event) => {
                    const fraction = fractionOf(event);
                    setBrush({ from: fraction, to: fraction });
                }}
                onMouseMove={(event) => {
                    const fraction = fractionOf(event);
                    if (brush) setBrush({ from: brush.from, to: fraction });
                    if (geometry) setHoverIndex(Math.round(fraction * geometry.lastIndex));
                }}
                onMouseUp={(event) => {
                    const current = brush;
                    setBrush(null);
                    if (!current) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const plotWidth = Math.max(MIN_PLOT_WIDTH, rect.width - PLOT.left - PLOT.right);
                    if (Math.abs(current.to - current.from) * plotWidth < MIN_BRUSH_PX) return;
                    const next = brushToWindow(view.axis, current.from, current.to);
                    if (next) setZoom(next);
                }}
                onMouseLeave={() => {
                    setBrush(null);
                    setHoverIndex(null);
                }}
                onDoubleClick={() => setZoom(null)}
            >
                {pending && view.axis.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-xs text-label-3">
                        {t("charts.overlay.loading")}
                    </div>
                ) : geometry === null ? (
                    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-label-3">
                        {t("charts.overlay.noOverlap")}
                    </div>
                ) : (
                    <svg
                        className="block cursor-crosshair"
                        width={width}
                        height={plotBoxHeight}
                        role="img"
                        aria-label={t("charts.overlay.chartLabel", { symbols: overlay.symbols.join(", ") })}
                    >
                        {geometry.ticks.map((tick) => (
                            <g key={tick}>
                                <line
                                    x1={PLOT.left}
                                    x2={PLOT.left + geometry.plotWidth}
                                    y1={geometry.y(tick)}
                                    y2={geometry.y(tick)}
                                    stroke="var(--sep)"
                                    strokeWidth="1"
                                />
                                <text
                                    x={PLOT.left + geometry.plotWidth + 8}
                                    y={geometry.y(tick) + 3.5}
                                    className="fin-figure text-[10px]"
                                    fill="var(--label-3)"
                                >
                                    {formatOverlayValue(tick, overlay.normalize)}
                                </text>
                            </g>
                        ))}

                        {/* The zero (or 100) line: the "everyone starts here" mark
                            that makes an overlay readable at a glance. */}
                        {geometry.baseline && (
                            <line
                                x1={PLOT.left}
                                x2={PLOT.left + geometry.plotWidth}
                                y1={geometry.y(overlay.normalize === "pct" ? 0 : 100)}
                                y2={geometry.y(overlay.normalize === "pct" ? 0 : 100)}
                                stroke="var(--sep-strong)"
                                strokeWidth="1"
                            />
                        )}

                        {/* Date ticks. First and last are anchored inward so the
                            axis never prints past the plot edge. */}
                        {Array.from({ length: Math.min(5, view.axis.length) }, (_, tick) => tick).map((tick, _, all) => {
                            const index = all.length === 1
                                ? 0
                                : Math.round((tick * geometry.lastIndex) / (all.length - 1));
                            const first = tick === 0;
                            const last = tick === all.length - 1;
                            return (
                                <text
                                    key={view.axis[index]}
                                    x={geometry.x(index)}
                                    y={PLOT.top + geometry.plotHeight + 14}
                                    textAnchor={first ? "start" : last ? "end" : "middle"}
                                    className="fin-figure text-[10px]"
                                    fill="var(--label-3)"
                                >
                                    {formatBaseDate(view.axis[index]!)}
                                </text>
                            );
                        })}

                        {brushing && brush && (
                            <rect
                                x={PLOT.left + Math.min(brush.from, brush.to) * geometry.plotWidth}
                                width={Math.abs(brush.to - brush.from) * geometry.plotWidth}
                                y={PLOT.top}
                                height={geometry.plotHeight}
                                fill="var(--fill-2)"
                            />
                        )}

                        {geometry.paths.map((path, index) => (
                            <path
                                key={view.series[index]?.symbol ?? index}
                                d={path}
                                fill="none"
                                stroke={seriesColor(index)}
                                strokeWidth="1.75"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                        ))}

                        {hoverTimestamp !== null && (
                            <g>
                                <line
                                    x1={geometry.x(hoverIndex!)}
                                    x2={geometry.x(hoverIndex!)}
                                    y1={PLOT.top}
                                    y2={PLOT.top + geometry.plotHeight}
                                    stroke="var(--sep-strong)"
                                    strokeDasharray="2 3"
                                    strokeWidth="1"
                                />
                                {geometry.valueAt.map((valueAt, index) => {
                                    const value = valueAt.get(hoverTimestamp);
                                    if (value === undefined) return null;
                                    return (
                                        <circle
                                            key={view.series[index]?.symbol ?? index}
                                            cx={geometry.x(hoverIndex!)}
                                            cy={geometry.y(value)}
                                            r="3.2"
                                            fill={seriesColor(index)}
                                            stroke="var(--raised)"
                                            strokeWidth="1.5"
                                        />
                                    );
                                })}
                            </g>
                        )}
                    </svg>
                )}

                {/*
                  * The hover readout. The date belongs *at the cursor*: on a
                  * normalized chart every line is a distance from a base, so
                  * "how far apart were they" is only answerable once you know
                  * which day you are standing on — and a date parked in the
                  * header is a glance away from the crosshair the eye is
                  * tracking. It flips to the left of the crosshair past the
                  * midpoint so it never runs off the plot.
                  */}
                {geometry !== null && hoverTimestamp !== null && !brushing && (
                    <div
                        className="pointer-events-none absolute z-10 min-w-[9rem] rounded-md border border-sep bg-raised/95 px-2.5 py-1.5 shadow-md backdrop-blur-sm"
                        style={{
                            left: geometry.x(hoverIndex!),
                            top: PLOT.top,
                            transform: hoverIndex! > geometry.lastIndex / 2
                                ? "translateX(calc(-100% - 10px))"
                                : "translateX(10px)",
                        }}
                    >
                        <p className="fin-figure text-[11px] font-semibold text-label-1">
                            {formatBaseDate(hoverTimestamp)}
                        </p>
                        <ul className="mt-1 space-y-0.5">
                            {view.series.map((series, index) => {
                                const value = geometry.valueAt[index]?.get(hoverTimestamp);
                                return (
                                    <li key={series.symbol} className="flex items-center gap-1.5 text-[11px]">
                                        <span
                                            className="inline-block size-1.5 shrink-0 rounded-full"
                                            style={{ backgroundColor: seriesColor(index) }}
                                        />
                                        <span className="fin-figure text-label-2">{series.symbol}</span>
                                        <span className="fin-figure ml-auto pl-3 font-semibold text-label-1">
                                            {value === undefined ? "—" : formatOverlayValue(value, overlay.normalize)}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                )}
            </div>

            <p className={cn("fin-figure mt-1 text-[10px] text-label-4", geometry === null && "invisible")}>
                {t("charts.overlay.zoomHint")}
            </p>
        </section>
    );
}
