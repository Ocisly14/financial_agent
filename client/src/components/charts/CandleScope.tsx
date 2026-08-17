import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    panViewport,
    resolveViewport,
    zoomViewport,
    type CandleViewport,
} from "@/lib/candleViewport";
import { DEFAULT_CANDLE_THEME, type CandleTheme } from "./candleTheme";

export { DEFAULT_CANDLE_THEME, type CandleTheme } from "./candleTheme";

/**
 * CandleScope — a hand-drawn canvas candlestick chart. It is deliberately
 * self-contained and data-source-agnostic: feed it an ordered array of
 * {t,o,h,l,c} candles plus an optional live mark, and it renders a calibrated
 * price grid, candles, a live mark line, and a hover crosshair with an OHLC
 * readout.
 *
 * StockChart supplies ordered Alpaca OHLC bars. `liveFromTs` remains optional
 * for callers that need to distinguish seeded history from current-session data.
 */

export interface Candle {
    t: number; // bucket start, ms
    o: number;
    h: number;
    l: number;
    c: number;
}

export interface CandleOverlay {
    key: string;
    label: string;
    points: Array<{ t: number; value: number }>;
    color?: string;
}

export interface CandlePriceLevel {
    key: string;
    value: number;
    label: string;
    color?: string;
}

interface Props {
    candles: Candle[];
    lastPrice?: number;
    sessionHigh?: number;
    sessionLow?: number;
    /** Candles with t < liveFromTs are seeded (drawn slightly dimmer). */
    liveFromTs?: number;
    height?: number;
    quote?: string;
    /** Defaults to the Financial Chart Phosphor Desk color scheme. */
    theme?: CandleTheme;
    /** Optional x-axis label. */
    formatTimestamp?: (timestampMs: number) => string;
    /** Price-scale technical lines such as SMA, EMA, Bollinger Bands, and VWAP. */
    overlays?: CandleOverlay[];
    /** Horizontal price levels such as support and resistance. */
    levels?: CandlePriceLevel[];
}

export const CANDLE_OVERLAY_COLORS = ["#2563eb", "#8b5cf6", "#06b6d4", "#f97316", "#ec4899", "#84cc16"];

function fmtPrice(v: number): string {
    if (!Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

function fmtClock(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function CandleScope({
    candles: allCandles,
    lastPrice,
    sessionHigh,
    sessionLow,
    liveFromTs,
    height = 360,
    quote = "USD",
    theme = DEFAULT_CANDLE_THEME,
    formatTimestamp,
    overlays = [],
    levels = [],
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLSpanElement>(null);
    const [width, setWidth] = useState(720);
    const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
    const [pulse, setPulse] = useState(0);
    /** null = the whole series, following the live edge. */
    const [viewport, setViewport] = useState<CandleViewport | null>(null);
    const dragRef = useRef<{ x: number; startViewport: CandleViewport | null } | null>(null);
    // Separate from dragRef: a ref mutation does not re-render, so the cursor would never change.
    const [dragging, setDragging] = useState(false);

    // Slicing here — ahead of the price domain, the overlays and the hover readout — is what
    // makes zoom a one-line concept: everything downstream already derives from `candles`.
    const candles = useMemo(() => {
        const { start, end } = resolveViewport(viewport, allCandles.length);
        return start === 0 && end === allCandles.length ? allCandles : allCandles.slice(start, end);
    }, [allCandles, viewport]);

    // gentle heartbeat so the live candle glows even when no new tick lands
    useEffect(() => {
        const id = setInterval(() => setPulse((p) => (p + 1) % 1000), 850);
        return () => clearInterval(id);
    }, []);


    useEffect(() => {
        const el = wrapRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width;
            if (w) setWidth(Math.max(320, Math.floor(w)));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Price domain padded from the visible candles and technical overlays.
    const domain = useMemo(() => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const c of candles) {
            lo = Math.min(lo, c.l);
            hi = Math.max(hi, c.h);
        }
        const firstTimestamp = candles[0]?.t ?? -Infinity;
        const lastTimestamp = candles.at(-1)?.t ?? Infinity;
        for (const overlay of overlays) {
            for (const point of overlay.points) {
                if (point.t >= firstTimestamp && point.t <= lastTimestamp && Number.isFinite(point.value)) {
                    lo = Math.min(lo, point.value);
                    hi = Math.max(hi, point.value);
                }
            }
        }
        for (const level of levels) {
            if (Number.isFinite(level.value)) {
                lo = Math.min(lo, level.value);
                hi = Math.max(hi, level.value);
            }
        }
        if (typeof lastPrice === "number") {
            lo = Math.min(lo, lastPrice);
            hi = Math.max(hi, lastPrice);
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
            const base = lastPrice ?? 100;
            return { lo: base * 0.98, hi: base * 1.02 };
        }
        if (hi === lo) {
            hi = lo * 1.001 + 1;
            lo = lo * 0.999 - 1;
        }
        const pad = (hi - lo) * 0.12;
        return { lo: lo - pad, hi: hi + pad };
    }, [candles, lastPrice, overlays, levels]);

    const layout = useMemo(() => {
        const padR = 78; // price gutter on the right (TradingView-style)
        const padL = 8;
        const padT = 16;
        const padB = formatTimestamp ? 32 : 26;
        const plotW = Math.max(40, width - padL - padR);
        const plotH = Math.max(40, height - padT - padB);
        return { padR, padL, padT, padB, plotW, plotH };
    }, [width, height, formatTimestamp]);

    /** Where the pointer sits across the plot, 0 at the left edge and 1 at the right. */
    const anchorRatioAt = useCallback((clientX: number, rect: DOMRect): number => {
        const { padL, plotW } = layout;
        return Math.min(1, Math.max(0, (clientX - rect.left - padL) / plotW));
    }, [layout]);

    /**
     * One listener covers a mouse wheel and a Mac trackpad alike: the browser reports a pinch as
     * a wheel event with `ctrlKey` set, and a two-finger swipe as horizontal delta. It is
     * registered by hand because React's onWheel is passive, and a passive listener cannot stop
     * the page from scrolling underneath the chart.
     */
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const onWheel = (event: WheelEvent): void => {
            const total = allCandles.length;
            if (total === 0) return;
            event.preventDefault();

            const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
            if (horizontal && !event.ctrlKey) {
                const { start, end } = resolveViewport(viewport, total);
                const perPixel = (end - start) / Math.max(1, layout.plotW);
                setViewport((current) => panViewport(current, total, event.deltaX * perPixel));
                return;
            }

            // Trackpad pinches arrive in far smaller increments than a wheel notch.
            const step = event.ctrlKey ? 0.01 : 0.0015;
            const factor = Math.exp(event.deltaY * step);
            const anchor = anchorRatioAt(event.clientX, canvas.getBoundingClientRect());
            setViewport((current) => zoomViewport(current, total, factor, anchor));
        };

        canvas.addEventListener("wheel", onWheel, { passive: false });
        return () => canvas.removeEventListener("wheel", onWheel);
    }, [allCandles.length, anchorRatioAt, layout.plotW, viewport]);

    const yOf = (price: number) => {
        const { padT, plotH } = layout;
        const { lo, hi } = domain;
        return padT + (1 - (price - lo) / (hi - lo)) * plotH;
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const { padL, padT, plotW, plotH } = layout;
        const xRight = padL + plotW;
        const yBottom = padT + plotH;

        const slot = viewport ? plotW / candles.length : plotW / Math.max(candles.length, 30);
        const inPlot =
            hover !== null &&
            hover.x >= padL && hover.x <= xRight &&
            hover.y >= padT && hover.y <= yBottom;
        // The candle under the cursor, needed by both the x-axis tag below and
        // the crosshair further down.
        const hoveredIndex = inPlot
            ? Math.max(0, Math.min(candles.length - 1, Math.floor((hover.x - padL) / slot)))
            : -1;

        // ── optional x-axis labels (StockChart supplies time/date formatting) ──
        if (formatTimestamp && candles.length > 0) {
            const labelCount = Math.min(5, candles.length);
            ctx.font = "10px 'Martian Mono', ui-monospace, monospace";
            ctx.textBaseline = "top";
            // While reading a specific candle the static ticks step back so the
            // hovered date is the only one competing for attention.
            ctx.globalAlpha = hoveredIndex >= 0 ? 0.35 : 1;
            ctx.fillStyle = theme.axis;
            for (let i = 0; i < labelCount; i++) {
                const index = labelCount === 1
                    ? 0
                    : Math.round((i * (candles.length - 1)) / (labelCount - 1));
                const x = padL + slot * (index + 0.5);
                ctx.textAlign = i === 0 ? "left" : i === labelCount - 1 ? "right" : "center";
                ctx.fillText(formatTimestamp(candles[index]!.t), x, yBottom + 7);
            }
            ctx.globalAlpha = 1;

            // ── hovered date, tagged on the x-axis ──
            // The right gutter already tags the price at the cursor; without the
            // matching tag down here you could read a level off the chart but
            // not the date it belongs to.
            if (hoveredIndex >= 0) {
                const candle = candles[hoveredIndex]!;
                const label = formatTimestamp(candle.t);
                const tw = ctx.measureText(label).width + 12;
                // Clamp so the tag never hangs off either end of the plot.
                const cx = Math.max(
                    padL + tw / 2,
                    Math.min(xRight - tw / 2, padL + slot * (hoveredIndex + 0.5)),
                );
                ctx.fillStyle = theme.hoverTag;
                ctx.fillRect(cx - tw / 2, yBottom + 4, tw, 15);
                ctx.fillStyle = theme.ink;
                ctx.textAlign = "center";
                ctx.fillText(label, cx, yBottom + 7);
            }
        }

        // ── horizontal price grid + right-axis ticks ──
        ctx.font = "10px 'Martian Mono', ui-monospace, monospace";
        ctx.textBaseline = "middle";
        const ticks = 6;
        for (let i = 0; i <= ticks; i++) {
            const price = domain.lo + ((domain.hi - domain.lo) * i) / ticks;
            const y = yOf(price);
            ctx.strokeStyle = theme.grid;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(xRight, y);
            ctx.stroke();
            ctx.fillStyle = theme.axis;
            ctx.textAlign = "left";
            ctx.fillText(fmtPrice(price), xRight + 8, y);
        }

        // ── market-session high / low calibration bands ──
        for (const [val, label, color] of [
            [sessionHigh, "SESSION H", theme.pos] as const,
            [sessionLow, "SESSION L", theme.neg] as const,
        ]) {
            if (typeof val !== "number") continue;
            const y = yOf(val);
            if (y < padT || y > yBottom) continue;
            ctx.strokeStyle = color + "44";
            ctx.setLineDash([2, 4]);
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(xRight, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = color + "99";
            ctx.textAlign = "left";
            ctx.fillText(label, padL + 4, y - 7);
        }

        // ── candles ──
        const n = candles.length;
        if (n > 0) {
            // The 30-candle floor keeps a nearly-empty series from drawing a few huge blocks.
            // Once the user has zoomed, it would instead cap how wide a candle can get — the
            // opposite of what they asked for — so an explicit viewport opts out of it.
            const slot = viewport ? plotW / n : plotW / Math.max(n, 30);
            const bodyW = Math.max(1.5, Math.min(slot * 0.62, 11));
            candles.forEach((c, i) => {
                const cx = padL + slot * (i + 0.5);
                const up = c.c >= c.o;
                const color = up ? theme.pos : theme.neg;
                const seeded = typeof liveFromTs === "number" && c.t < liveFromTs;
                const isLast = i === n - 1;
                ctx.globalAlpha = seeded ? 0.42 : 1;

                // wick
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(cx, yOf(c.h));
                ctx.lineTo(cx, yOf(c.l));
                ctx.stroke();

                // body
                const yO = yOf(c.o);
                const yC = yOf(c.c);
                const top = Math.min(yO, yC);
                const h = Math.max(1, Math.abs(yC - yO));
                if (isLast) {
                    const glow = 0.35 + 0.35 * Math.sin(pulse);
                    ctx.shadowColor = color;
                    ctx.shadowBlur = 10 * glow + 4;
                }
                ctx.fillStyle = color;
                ctx.fillRect(cx - bodyW / 2, top, bodyW, h);
                ctx.shadowBlur = 0;
                ctx.globalAlpha = 1;
            });
        }

        // ── technical overlays on the shared price scale ──
        const firstTimestamp = candles[0]?.t;
        const lastTimestamp = candles.at(-1)?.t;
        if (firstTimestamp !== undefined && lastTimestamp !== undefined) {
            const timestampSpan = Math.max(1, lastTimestamp - firstTimestamp);
            const xOfTimestamp = (timestamp: number) =>
                padL + ((timestamp - firstTimestamp) / timestampSpan) * plotW;
            overlays.forEach((overlay, overlayIndex) => {
                const visible = overlay.points.filter((point) =>
                    point.t >= firstTimestamp && point.t <= lastTimestamp && Number.isFinite(point.value),
                );
                if (visible.length === 0) return;
                ctx.strokeStyle = overlay.color ?? CANDLE_OVERLAY_COLORS[overlayIndex % CANDLE_OVERLAY_COLORS.length]!;
                ctx.lineWidth = 1.6;
                ctx.setLineDash([]);
                ctx.beginPath();
                visible.forEach((point, pointIndex) => {
                    const x = xOfTimestamp(point.t);
                    const y = yOf(point.value);
                    if (pointIndex === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });
                ctx.stroke();
            });

            levels.forEach((level, levelIndex) => {
                const y = yOf(level.value);
                ctx.strokeStyle = level.color ?? CANDLE_OVERLAY_COLORS[(overlays.length + levelIndex) % CANDLE_OVERLAY_COLORS.length]!;
                ctx.lineWidth = 1;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padL, y);
                ctx.lineTo(xRight, y);
                ctx.stroke();
                ctx.setLineDash([]);
            });
        }

        // ── live mark line + right-axis price tag ──
        if (typeof lastPrice === "number") {
            const y = yOf(lastPrice);
            ctx.strokeStyle = theme.amber;
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(xRight, y);
            ctx.stroke();
            ctx.setLineDash([]);

            const tag = fmtPrice(lastPrice);
            ctx.font = "600 10px 'Martian Mono', ui-monospace, monospace";
            const tw = ctx.measureText(tag).width + 14;
            ctx.fillStyle = theme.amber;
            ctx.fillRect(xRight + 2, y - 8, Math.min(tw, layout.padR - 4), 16);
            ctx.fillStyle = theme.liveTagInk;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(tag, xRight + 8, y + 0.5);
        }

        // ── crosshair ──
        if (hover && inPlot) {
            ctx.strokeStyle = theme.crosshair;
            ctx.setLineDash([2, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(hover.x, padT);
            ctx.lineTo(hover.x, yBottom);
            ctx.moveTo(padL, hover.y);
            ctx.lineTo(xRight, hover.y);
            ctx.stroke();
            ctx.setLineDash([]);

            // price at cursor on right gutter
            const price = domain.lo + (1 - (hover.y - padT) / plotH) * (domain.hi - domain.lo);
            const tag = fmtPrice(price);
            ctx.font = "10px 'Martian Mono', ui-monospace, monospace";
            const tw = ctx.measureText(tag).width + 14;
            ctx.fillStyle = theme.hoverTag;
            ctx.fillRect(xRight + 2, hover.y - 8, Math.min(tw, layout.padR - 4), 16);
            ctx.fillStyle = theme.ink;
            ctx.textAlign = "left";
            ctx.fillText(tag, xRight + 8, hover.y + 0.5);
        }
    }, [candles, width, height, domain, layout, hover, lastPrice, sessionHigh, sessionLow, liveFromTs, pulse, theme, formatTimestamp, overlays, levels]);

    // hovered candle for the OHLC readout
    const hovered = useMemo(() => {
        if (!hover || candles.length === 0) return null;
        const { padL, plotW } = layout;
        const slot = viewport ? plotW / candles.length : plotW / Math.max(candles.length, 30);
        const idx = Math.floor((hover.x - padL) / slot);
        return candles[idx] ?? candles[candles.length - 1];
    }, [hover, candles, layout]);

    const readout = hovered ?? candles[candles.length - 1];
    const up = readout ? readout.c >= readout.o : true;

    return (
        <span
            className="relative block w-full"
            ref={wrapRef}
            style={theme === DEFAULT_CANDLE_THEME ? undefined : { height }}
        >
            {readout && (
                <span
                    className="fin-figure pointer-events-none absolute left-3.5 top-2.5 z-[2] flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-label-3"
                    data-dir={up ? "up" : "down"}
                    style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: theme.inkDim }}
                >
                    <span>
                        O{" "}
                        <b
                            className={up ? "font-semibold text-up" : "font-semibold text-down"}
                            style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: up ? theme.pos : theme.neg }}
                        >
                            {fmtPrice(readout.o)}
                        </b>
                    </span>
                    <span>
                        H{" "}
                        <b
                            className={up ? "font-semibold text-up" : "font-semibold text-down"}
                            style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: up ? theme.pos : theme.neg }}
                        >
                            {fmtPrice(readout.h)}
                        </b>
                    </span>
                    <span>
                        L{" "}
                        <b
                            className={up ? "font-semibold text-up" : "font-semibold text-down"}
                            style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: up ? theme.pos : theme.neg }}
                        >
                            {fmtPrice(readout.l)}
                        </b>
                    </span>
                    <span>
                        C{" "}
                        <b
                            className={up ? "font-semibold text-up" : "font-semibold text-down"}
                            style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: up ? theme.pos : theme.neg }}
                        >
                            {fmtPrice(readout.c)}
                        </b>
                    </span>
                    {hovered && (
                        <span
                            className="text-hold"
                            style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: theme.amber }}
                        >
                            {fmtClock(hovered.t)}
                        </span>
                    )}
                    <span
                        className="text-label-3"
                        style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: theme.axis }}
                    >
                        {quote}
                    </span>
                </span>
            )}
            <canvas
                ref={canvasRef}
                className={dragging ? "block w-full cursor-grabbing" : "block w-full cursor-crosshair"}
                onPointerDown={(e) => {
                    if (e.button !== 0 || allCandles.length === 0) return;
                    dragRef.current = { x: e.clientX, startViewport: viewport };
                    setDragging(true);
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setHover(null);
                }}
                onPointerMove={(e) => {
                    const drag = dragRef.current;
                    const r = e.currentTarget.getBoundingClientRect();
                    if (!drag) {
                        setHover({ x: e.clientX - r.left, y: e.clientY - r.top });
                        return;
                    }
                    // Dragging the content right reveals older candles, so the window moves back.
                    const { start, end } = resolveViewport(drag.startViewport, allCandles.length);
                    const perPixel = (end - start) / Math.max(1, layout.plotW);
                    setViewport(panViewport(drag.startViewport, allCandles.length, -(e.clientX - drag.x) * perPixel));
                }}
                onPointerUp={(e) => {
                    dragRef.current = null;
                    setDragging(false);
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
                onDoubleClick={() => setViewport(null)}
                onMouseLeave={() => { if (!dragRef.current) setHover(null); }}
            />
        </span>
    );
}
