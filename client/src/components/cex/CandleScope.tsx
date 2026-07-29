import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CANDLE_THEME, type CandleTheme } from "./candleTheme";

export { DEFAULT_CANDLE_THEME, type CandleTheme } from "./candleTheme";

/**
 * CandleScope — a hand-drawn canvas candlestick chart in the "Phosphor Desk"
 * aesthetic (see strategy-dashboard.css). It is deliberately self-contained and
 * data-source-agnostic: feed it an ordered array of {t,o,h,l,c} candles plus an
 * optional live mark, and it renders a calibrated price grid, candles, a live
 * mark line, and a hover crosshair with an OHLC readout.
 *
 * NOTE ON DATA: the component is shared. Strategy Floor builds crypto candles
 * from Binance history plus live marks; StockChart supplies Alpaca OHLC bars.
 * `liveFromTs` remains optional so Strategy Floor can distinguish seeded data.
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
    high24h?: number;
    low24h?: number;
    /** Candles with t < liveFromTs are seeded (drawn slightly dimmer). */
    liveFromTs?: number;
    height?: number;
    quote?: string;
    /** 缺省保持 Strategy Floor 的 Phosphor Desk 配色。 */
    theme?: CandleTheme;
    /** 可选 x 轴标签；不传时保持 Strategy Floor 当前像素输出不变。 */
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
    candles,
    lastPrice,
    high24h,
    low24h,
    liveFromTs,
    height = 360,
    quote = "USDT",
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

    // price domain — pad the candle range, then widen to include the real
    // 24h high/low so the y-axis reads as a calibrated session scope.
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

        // ── optional x-axis labels (StockChart supplies time/date formatting) ──
        if (formatTimestamp && candles.length > 0) {
            const slot = plotW / Math.max(candles.length, 30);
            const labelCount = Math.min(5, candles.length);
            ctx.font = "10px 'Martian Mono', ui-monospace, monospace";
            ctx.fillStyle = theme.axis;
            ctx.textBaseline = "top";
            for (let i = 0; i < labelCount; i++) {
                const index = labelCount === 1
                    ? 0
                    : Math.round((i * (candles.length - 1)) / (labelCount - 1));
                const x = padL + slot * (index + 0.5);
                ctx.textAlign = i === 0 ? "left" : i === labelCount - 1 ? "right" : "center";
                ctx.fillText(formatTimestamp(candles[index]!.t), x, yBottom + 7);
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

        // ── 24h high / low calibration bands (real session bounds) ──
        for (const [val, label, color] of [
            [high24h, "24H H", theme.pos] as const,
            [low24h, "24H L", theme.neg] as const,
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
            const slot = plotW / Math.max(n, 30);
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
        if (hover && hover.x >= padL && hover.x <= xRight && hover.y >= padT && hover.y <= yBottom) {
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
    }, [candles, width, height, domain, layout, hover, lastPrice, high24h, low24h, liveFromTs, pulse, theme, formatTimestamp, overlays, levels]);

    // hovered candle for the OHLC readout
    const hovered = useMemo(() => {
        if (!hover || candles.length === 0) return null;
        const { padL, plotW } = layout;
        const slot = plotW / Math.max(candles.length, 30);
        const idx = Math.floor((hover.x - padL) / slot);
        return candles[idx] ?? candles[candles.length - 1];
    }, [hover, candles, layout]);

    const readout = hovered ?? candles[candles.length - 1];
    const up = readout ? readout.c >= readout.o : true;

    return (
        <span
            className="sq-scope-canvas block"
            ref={wrapRef}
            style={theme === DEFAULT_CANDLE_THEME ? undefined : {
                position: "relative",
                width: "100%",
                height,
            }}
        >
            {readout && (
                <span
                    className="sq-ohlc"
                    data-dir={up ? "up" : "down"}
                    style={theme === DEFAULT_CANDLE_THEME ? undefined : {
                        position: "absolute",
                        top: 10,
                        left: 14,
                        zIndex: 2,
                        color: theme.inkDim,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "4px 12px",
                        fontSize: 11,
                        fontVariantNumeric: "tabular-nums",
                        pointerEvents: "none",
                    }}
                >
                    <span>O <b style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: up ? theme.pos : theme.neg }}>{fmtPrice(readout.o)}</b></span>
                    <span>H <b style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: up ? theme.pos : theme.neg }}>{fmtPrice(readout.h)}</b></span>
                    <span>L <b style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: up ? theme.pos : theme.neg }}>{fmtPrice(readout.l)}</b></span>
                    <span>C <b style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: up ? theme.pos : theme.neg }}>{fmtPrice(readout.c)}</b></span>
                    {hovered && <span className="sq-ohlc-t" style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: theme.amber }}>{fmtClock(hovered.t)}</span>}
                    <span className="sq-ohlc-q" style={theme === DEFAULT_CANDLE_THEME ? undefined : { color: theme.axis }}>{quote}</span>
                </span>
            )}
            <canvas
                ref={canvasRef}
                className="sq-scope-c"
                style={theme === DEFAULT_CANDLE_THEME ? undefined : {
                    display: "block",
                    width: "100%",
                    cursor: "crosshair",
                }}
                onMouseMove={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setHover({ x: e.clientX - r.left, y: e.clientY - r.top });
                }}
                onMouseLeave={() => setHover(null)}
            />
        </span>
    );
}
