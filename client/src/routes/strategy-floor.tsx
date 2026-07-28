import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/lib/api";
import { useTradingPreferences } from "@/hooks/useTradingPreferences";
import type { StoredStrategy, StrategyLifecycle } from "@/types/core";
import { CandleScope, type Candle } from "@/components/cex/CandleScope";
import "./strategy-dashboard.css";

/* ── timeframes ──────────────────────────────────────────────────────────── */
const TF: Array<{ key: string; ms: number; label: string }> = [
    { key: "1m", ms: 60_000, label: "1M" },
    { key: "5m", ms: 300_000, label: "5M" },
    { key: "15m", ms: 900_000, label: "15M" },
];
const MAX_CANDLES = 240;
const HISTORY_LIMIT = 200;
const POLL_MS = 6_000;

/** Strip the quote currency → bare base, for the USDT-only market-snapshot endpoint. */
const baseOf = (symbol: string) => symbol.replace(/(USDT|USDC|USD|BTC|ETH|EUR|GBP|JPY)$/i, "") || symbol;

const STATUS_TONE: Record<StrategyLifecycle, string> = {
    draft: "dead",
    pending_approval: "wait",
    active: "live",
    running: "live",
    paused: "hold",
    completed: "done",
    cancelled: "dead",
    failed: "fail",
};

interface Snap {
    mid: number;
    bid?: number;
    ask?: number;
    spreadBps?: number;
    changePct?: number;
    high?: number;
    low?: number;
    vol?: number;
    at: number;
}

interface Tape {
    candles: Candle[];
    liveFromTs: number;
    snap: Snap | null;
}

const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);

/**
 * Tape = real historical candles (from the public Binance klines endpoint, via
 * `getKlines`) extended forward in real time: each poll of `getMarketSnapshot`
 * folds the live mid mark into the forming candle and drives the readout strip.
 * History is genuine; the live edge is aggregated from real marks bucketed by
 * the active timeframe.
 */
function useLiveTapes(agentId: string | undefined, symbols: string[], tf: { key: string; ms: number }) {
    const store = useRef<Map<string, Tape>>(new Map());
    const [, bump] = useState(0);
    const symRef = useRef(symbols);
    const tfRef = useRef(tf);
    symRef.current = symbols;
    tfRef.current = tf;

    const symKey = symbols.join(",");

    // ── load real historical candles on symbol-set / timeframe change ──
    useEffect(() => {
        if (!agentId || symbols.length === 0) return;
        let alive = true;
        store.current.clear(); // new interval → new buckets, start clean
        bump((n) => n + 1);
        (async () => {
            await Promise.all(
                symbols.map(async (sym) => {
                    const candles = await apiClient.getKlines(agentId, sym, tf.key, HISTORY_LIMIT);
                    if (!alive || candles.length === 0) return;
                    const prev = store.current.get(sym);
                    store.current.set(sym, {
                        candles: candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
                        liveFromTs: candles[candles.length - 1]?.t ?? 0,
                        snap: prev?.snap ?? null,
                    });
                }),
            );
            if (alive) bump((n) => n + 1);
        })();
        return () => {
            alive = false;
        };
    }, [agentId, symKey, tf.key]);

    // ── live edge: poll snapshots, fold mid into the forming candle ──
    useEffect(() => {
        if (!agentId || symbols.length === 0) return;
        let alive = true;

        const ingest = (sym: string, snap: Snap) => {
            const tfMs = tfRef.current.ms;
            const prev = store.current.get(sym);
            const bucket = Math.floor(snap.at / tfMs) * tfMs;
            const candles = prev ? prev.candles.slice() : [];
            const last = candles[candles.length - 1];
            if (last && last.t === bucket) {
                last.h = Math.max(last.h, snap.mid);
                last.l = Math.min(last.l, snap.mid);
                last.c = snap.mid;
            } else {
                candles.push({ t: bucket, o: last?.c ?? snap.mid, h: snap.mid, l: snap.mid, c: snap.mid });
                if (candles.length > MAX_CANDLES) candles.shift();
            }
            store.current.set(sym, { candles, liveFromTs: prev?.liveFromTs ?? bucket, snap });
        };

        const tick = async () => {
            const syms = symRef.current;
            const results = await Promise.all(
                syms.map(async (sym) => {
                    const res = await apiClient.getMarketSnapshot(agentId, { symbol: baseOf(sym) });
                    const ms = res?.market_snapshot;
                    if (!ms) return null;
                    const bid = num(ms.bid);
                    const ask = num(ms.ask);
                    const mid =
                        bid != null && ask != null ? (bid + ask) / 2 : (ms.est_fill_price ?? bid ?? ask);
                    if (mid == null || !Number.isFinite(mid)) return null;
                    const snap: Snap = {
                        mid,
                        bid,
                        ask,
                        spreadBps: ms.spread_bps,
                        changePct: num(ms.price_change_pct),
                        high: num(ms.high_24h),
                        low: num(ms.low_24h),
                        vol: num(ms.quote_volume_24h) ?? num(ms.volume_24h),
                        at: ms.fetched_at_ms ?? Date.now(),
                    };
                    return [sym, snap] as const;
                }),
            );
            if (!alive) return;
            let changed = false;
            for (const r of results) {
                if (!r) continue;
                ingest(r[0], r[1]);
                changed = true;
            }
            if (changed) bump((n) => n + 1);
        };

        tick();
        const id = setInterval(tick, POLL_MS);
        return () => {
            alive = false;
            clearInterval(id);
        };
    }, [agentId, symKey, tf.ms]);

    return store.current;
}

function Spark({ candles, dir }: { candles: Candle[]; dir: number }) {
    const pts = useMemo(() => {
        const closes = candles.slice(-24).map((c) => c.c);
        if (closes.length < 2) return "";
        const lo = Math.min(...closes);
        const hi = Math.max(...closes);
        const span = hi - lo || 1;
        return closes
            .map((c, i) => {
                const x = (i / (closes.length - 1)) * 100;
                const y = 22 - ((c - lo) / span) * 20 - 1;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
    }, [candles]);
    const color = dir >= 0 ? "var(--sq-pos)" : "var(--sq-neg)";
    return (
        <svg className="sq-spark" viewBox="0 0 100 22" preserveAspectRatio="none">
            {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />}
        </svg>
    );
}

function fmtNum(v?: number, dp = 2): string {
    if (v == null || !Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    const d = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
    return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: Math.max(dp, d) });
}
function fmtCompact(v?: number): string {
    if (v == null || !Number.isFinite(v)) return "—";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(0);
}

export default function StrategyFloorPage() {
    const { t } = useTranslation();
    const { agentId } = useParams<{ agentId: string }>();
    const navigate = useNavigate();
    const prefs = useTradingPreferences();
    const [tf, setTf] = useState(TF[0]);
    const [selected, setSelected] = useState<string | null>(null);

    const query = useQuery({
        queryKey: ["user", "strategies"],
        queryFn: async () => (await apiClient.listStrategies()).strategies,
        refetchInterval: 15_000,
    });

    const active = useMemo(
        () => (query.data ?? []).filter((s) => s.status === "active" || s.status === "running"),
        [query.data],
    );

    const symbols = useMemo(() => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const s of active) {
            if (!seen.has(s.symbol)) {
                seen.add(s.symbol);
                out.push(s.symbol);
            }
        }
        return out;
    }, [active]);

    // keep a valid selection as the active set changes
    useEffect(() => {
        if (symbols.length === 0) {
            setSelected(null);
        } else if (!selected || !symbols.includes(selected)) {
            setSelected(symbols[0]);
        }
    }, [symbols, selected]);

    const tapes = useLiveTapes(agentId, symbols, tf);
    const sel = selected ? tapes.get(selected) : undefined;
    const selSnap = sel?.snap;
    const selChange = selSnap?.changePct ?? 0;
    const quote = useMemo(() => {
        if (!selected) return "USDT";
        const m = selected.match(/(USDT|USDC|USD|BTC|ETH|EUR)$/i);
        return m ? m[1].toUpperCase() : "USDT";
    }, [selected]);
    const base = selected ? selected.replace(/(USDT|USDC|USD|BTC|ETH|EUR)$/i, "") : "—";

    return (
        <div className="sq-root">
            <div className="sq-shell sq-shell-wide">
                <header className="sq-masthead sq-rise">
                    <div>
                        <span className="sq-kicker">Auto-Trading · Floor</span>
                        <h1 className="sq-title">
                            THE<em>FLOOR</em>
                        </h1>
                    </div>
                    <div className="sq-masthead-meta">
                        <span className="sq-mode" data-mode={prefs.data?.default_mode ?? "paper"}>
                            <span className="dot" />
                            {prefs.data?.default_mode ?? "paper"}
                        </span>
                        <div style={{ marginTop: 10 }}>
                            {symbols.length} MARKETS · {active.length} LIVE
                        </div>
                    </div>
                </header>

                <nav className="sq-tabs sq-rise" style={{ animationDelay: "60ms" }}>
                    <NavLink to={`/orders/${agentId}`} className="sq-tab">
                        {t("strategies.tabs.orders")}
                    </NavLink>
                    <NavLink to={`/floor/${agentId}`} className="sq-tab" data-active="true">
                        Floor
                    </NavLink>
                    <NavLink to={`/strategies/${agentId}`} className="sq-tab">
                        {t("strategies.tabs.strategies")}
                    </NavLink>
                </nav>

                {/* ── watchlist tape ── */}
                {symbols.length > 0 && (
                    <div className="sq-watch sq-rise" style={{ animationDelay: "110ms" }}>
                        {symbols.map((sym) => {
                            const tp = tapes.get(sym);
                            const chg = tp?.snap?.changePct ?? 0;
                            return (
                                <button
                                    key={sym}
                                    type="button"
                                    className="sq-watch-item"
                                    data-active={sym === selected}
                                    onClick={() => setSelected(sym)}
                                >
                                    <span className="sq-watch-sym">{sym}</span>
                                    <span className="sq-watch-px">
                                        {tp?.snap ? fmtNum(tp.snap.mid) : "···"}
                                    </span>
                                    <span className="sq-watch-chg" data-dir={chg >= 0 ? "up" : "down"}>
                                        {chg >= 0 ? "▲" : "▼"} {Math.abs(chg).toFixed(2)}%
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {query.isLoading ? (
                    <p className="sq-note">{t("strategies.loading")}</p>
                ) : active.length === 0 ? (
                    <p className="sq-note">No active strategies. Approve or resume a strategy to light up the floor.</p>
                ) : (
                    <div className="sq-floor sq-rise" style={{ animationDelay: "160ms" }}>
                        {/* ── main scope ── */}
                        <main className="sq-floor-main">
                            <div className="sq-scope-head">
                                <div className="sq-scope-id">
                                    <h2 className="sq-scope-base">{base}</h2>
                                    <span className="sq-scope-quote">/ {quote}</span>
                                    <span className="sq-live-badge">
                                        <span className="led" /> LIVE TAPE
                                    </span>
                                </div>
                                <div className="sq-scope-px">
                                    <span className="sq-scope-last" data-dir={selChange >= 0 ? "up" : "down"}>
                                        {selSnap ? fmtNum(selSnap.mid) : "···"}
                                    </span>
                                    <span className="sq-scope-chg" data-dir={selChange >= 0 ? "up" : "down"}>
                                        {selChange >= 0 ? "+" : ""}
                                        {selChange.toFixed(2)}% · 24h
                                    </span>
                                </div>
                                <div className="sq-tf">
                                    {TF.map((f) => (
                                        <button
                                            key={f.key}
                                            type="button"
                                            className="sq-tf-btn"
                                            data-active={f.key === tf.key}
                                            onClick={() => setTf(f)}
                                        >
                                            {f.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="sq-scope-frame">
                                <CandleScope
                                    candles={sel?.candles ?? []}
                                    lastPrice={selSnap?.mid}
                                    high24h={selSnap?.high}
                                    low24h={selSnap?.low}
                                    quote={quote}
                                    height={384}
                                />
                            </div>

                            <div className="sq-tape">
                                <Readout k="BID" v={fmtNum(selSnap?.bid)} dir="up" />
                                <Readout k="ASK" v={fmtNum(selSnap?.ask)} dir="down" />
                                <Readout k="SPREAD" v={selSnap?.spreadBps != null ? `${selSnap.spreadBps.toFixed(1)} bps` : "—"} />
                                <Readout k="24H HIGH" v={fmtNum(selSnap?.high)} />
                                <Readout k="24H LOW" v={fmtNum(selSnap?.low)} />
                                <Readout k="QUOTE VOL" v={fmtCompact(selSnap?.vol)} />
                            </div>
                            <p className="sq-disclaimer">
                                › Real Binance klines ({tf.label}) extended live — the forming candle folds in mid marks
                                polled every {POLL_MS / 1000}s.
                            </p>
                        </main>

                        {/* ── active strategies sidebar ── */}
                        <aside className="sq-aside">
                            <h3 className="sq-section-label">Active Strategies</h3>
                            <div className="sq-strat-list">
                                {active.map((s, i) => {
                                    const tp = tapes.get(s.symbol);
                                    const chg = tp?.snap?.changePct ?? 0;
                                    return (
                                        <StrategyCard
                                            key={s.id}
                                            s={s}
                                            chg={chg}
                                            price={tp?.snap?.mid}
                                            candles={tp?.candles ?? []}
                                            selected={s.symbol === selected}
                                            delayMs={200 + i * 50}
                                            onFocus={() => setSelected(s.symbol)}
                                            onOpen={() => navigate(`/strategies/${agentId}/${s.id}`)}
                                        />
                                    );
                                })}
                            </div>
                        </aside>
                    </div>
                )}

                {/* faint duplicate-symbol hint */}
                {active.length > symbols.length && (
                    <p className="sq-floor-hint">
                        {active.length} strategies across {symbols.length} markets — select a market to focus its scope.
                    </p>
                )}
            </div>
        </div>
    );
}

function Readout({ k, v, dir }: { k: string; v: string; dir?: "up" | "down" }) {
    return (
        <div className="sq-tape-cell">
            <span className="sq-tape-k">{k}</span>
            <span className="sq-tape-v" data-dir={dir}>
                {v}
            </span>
        </div>
    );
}

function StrategyCard({
    s,
    chg,
    price,
    candles,
    selected,
    delayMs,
    onFocus,
    onOpen,
}: {
    s: StoredStrategy;
    chg: number;
    price?: number;
    candles: Candle[];
    selected: boolean;
    delayMs: number;
    onFocus: () => void;
    onOpen: () => void;
}) {
    const { t } = useTranslation();
    const phases = s.dsl?.phases ?? [];
    const done = phases.filter((p) => p.status === "completed").length;
    const total = phases.length || 1;
    const pct = Math.round((done / total) * 100);
    const tone = STATUS_TONE[s.status] ?? "dead";

    return (
        <article
            className="sq-strat-card sq-rise"
            data-selected={selected}
            style={{ animationDelay: `${delayMs}ms` }}
            onClick={onFocus}
        >
            <div className="sq-strat-top">
                <div className="sq-strat-id">
                    <span className="sq-status" data-tone={tone}>
                        <span className="led" />
                        {t(`strategies.status.${s.status}`)}
                    </span>
                    <span className="sq-strat-sym">{s.symbol}</span>
                </div>
                <span className="sq-mode" data-mode={s.dsl.mode}>
                    <span className="dot" />
                    {s.dsl.mode}
                </span>
            </div>

            <div className="sq-strat-name">{s.dsl?.name ?? "Untitled strategy"}</div>

            <div className="sq-strat-mid">
                <Spark candles={candles} dir={chg} />
                <div className="sq-strat-px">
                    <span className="sq-strat-last">{price != null ? fmtNum(price) : "···"}</span>
                    <span className="sq-strat-chg" data-dir={chg >= 0 ? "up" : "down"}>
                        {chg >= 0 ? "+" : ""}
                        {chg.toFixed(2)}%
                    </span>
                </div>
            </div>

            <div className="sq-strat-prog">
                <div className="sq-strat-prog-bar">
                    <span style={{ width: `${pct}%` }} />
                </div>
                <span className="sq-strat-prog-t">
                    {done}/{phases.length} phases
                </span>
            </div>

            <button
                type="button"
                className="sq-strat-open"
                onClick={(e) => {
                    e.stopPropagation();
                    onOpen();
                }}
            >
                Open cockpit →
            </button>
        </article>
    );
}
