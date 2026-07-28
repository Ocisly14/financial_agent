import { useEffect, useMemo, useRef, useState } from "react";

/**
 * CandleScope — a hand-drawn canvas candlestick chart in the "Phosphor Desk"
 * aesthetic (see strategy-dashboard.css). It is deliberately self-contained and
 * data-source-agnostic: feed it an ordered array of {t,o,h,l,c} candles plus an
 * optional live mark, and it renders a calibrated price grid, candles, a live
 * mark line, and a hover crosshair with an OHLC readout.
 *
 * NOTE ON DATA: this codebase has no historical klines endpoint. The Strategy
 * Floor builds candles forward-in-time by bucketing real mid marks polled from
 * `getMarketSnapshot`, seeded once from the real 24h session range so the scope
 * is not empty on first paint. The seed boundary is passed as `liveFromTs` so we
 * can mark where the genuine live tape begins.
 */

export interface Candle {
    t: number; // bucket start, ms
    o: number;
    h: number;
    l: number;
    c: number;
}

const COL = {
    grid: "rgba(255,255,255,0.05)",
    gridStrong: "rgba(255,255,255,0.09)",
    axis: "#545a67",
    ink: "#edeff3",
    inkDim: "#8b909c",
    amber: "#ffb648",
    pos: "#4ade80",
    neg: "#fb5d7a",
};

interface Props {
    candles: Candle[];
    lastPrice?: number;
    high24h?: number;
    low24h?: number;
    /** Candles with t < liveFromTs are seeded (drawn slightly dimmer). */
    liveFromTs?: number;
    height?: number;
    quote?: string;
}

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
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
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
    }, [candles, lastPrice]);

    const layout = useMemo(() => {
        const padR = 78; // price gutter on the right (TradingView-style)
        const padL = 8;
        const padT = 16;
        const padB = 26;
        const plotW = Math.max(40, width - padL - padR);
        const plotH = Math.max(40, height - padT - padB);
        return { padR, padL, padT, padB, plotW, plotH };
    }, [width, height]);

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

        // ── horizontal price grid + right-axis ticks ──
        ctx.font = "10px 'Martian Mono', ui-monospace, monospace";
        ctx.textBaseline = "middle";
        const ticks = 6;
        for (let i = 0; i <= ticks; i++) {
            const price = domain.lo + ((domain.hi - domain.lo) * i) / ticks;
            const y = yOf(price);
            ctx.strokeStyle = COL.grid;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(xRight, y);
            ctx.stroke();
            ctx.fillStyle = COL.axis;
            ctx.textAlign = "left";
            ctx.fillText(fmtPrice(price), xRight + 8, y);
        }

        // ── 24h high / low calibration bands (real session bounds) ──
        for (const [val, label, color] of [
            [high24h, "24H H", COL.pos] as const,
            [low24h, "24H L", COL.neg] as const,
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
                const color = up ? COL.pos : COL.neg;
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

        // ── live mark line + right-axis price tag ──
        if (typeof lastPrice === "number") {
            const y = yOf(lastPrice);
            ctx.strokeStyle = COL.amber;
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
            ctx.fillStyle = COL.amber;
            ctx.fillRect(xRight + 2, y - 8, Math.min(tw, layout.padR - 4), 16);
            ctx.fillStyle = "#0a0a0a";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(tag, xRight + 8, y + 0.5);
        }

        // ── crosshair ──
        if (hover && hover.x >= padL && hover.x <= xRight && hover.y >= padT && hover.y <= yBottom) {
            ctx.strokeStyle = "rgba(255,182,72,0.5)";
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
            ctx.fillStyle = "#1a1d26";
            ctx.fillRect(xRight + 2, hover.y - 8, Math.min(tw, layout.padR - 4), 16);
            ctx.fillStyle = COL.ink;
            ctx.textAlign = "left";
            ctx.fillText(tag, xRight + 8, hover.y + 0.5);
        }
    }, [candles, width, height, domain, layout, hover, lastPrice, high24h, low24h, liveFromTs, pulse]);

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
        <div className="sq-scope-canvas" ref={wrapRef}>
            {readout && (
                <div className="sq-ohlc" data-dir={up ? "up" : "down"}>
                    <span>O <b>{fmtPrice(readout.o)}</b></span>
                    <span>H <b>{fmtPrice(readout.h)}</b></span>
                    <span>L <b>{fmtPrice(readout.l)}</b></span>
                    <span>C <b>{fmtPrice(readout.c)}</b></span>
                    {hovered && <span className="sq-ohlc-t">{fmtClock(hovered.t)}</span>}
                    <span className="sq-ohlc-q">{quote}</span>
                </div>
            )}
            <canvas
                ref={canvasRef}
                className="sq-scope-c"
                onMouseMove={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setHover({ x: e.clientX - r.left, y: e.clientY - r.top });
                }}
                onMouseLeave={() => setHover(null)}
            />
        </div>
    );
}
