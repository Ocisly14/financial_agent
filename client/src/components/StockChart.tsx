import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
    parseStockChartProps,
    pollIntervalForSession,
    shouldPollCandles,
    STOCK_RANGES,
    type MarketSession,
    type StockRange,
} from "@/lib/stockChart";
import {
    CANDLE_OVERLAY_COLORS,
    CandleScope,
    type Candle,
    type CandleOverlay,
    type CandlePriceLevel,
    type CandleTheme,
} from "./charts/CandleScope";
import { MessageTimeContext, StreamingContext } from "./stockChartContext";
import type { TechnicalStudy } from "@/lib/chartWorkspace";

interface StockCandle {
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
}

interface StockQuote {
    price: number | null;
    prevClose: number | null;
    changePercent: number | null;
    bidPrice: number | null;
    askPrice: number | null;
    dayOpen: number | null;
    dayHigh: number | null;
    dayLow: number | null;
    volume: number | null;
    quoteTimestamp: string;
}

interface StockQuoteResponse {
    symbol: string;
    quote: StockQuote | null;
    session: MarketSession;
    range: StockRange | "none";
    timeframe?: "1Min" | "5Min" | "1Day";
    candles?: StockCandle[];
    staleness: { reason: string; asOf: string } | null;
    dataSource: string;
    fetchedAtMs: number;
}

const SESSION_LABEL: Record<MarketSession, string> = {
    "pre-market": "盘前",
    regular: "盘中",
    "after-hours": "盘后",
    closed: "休市",
};

const LIGHT_CANDLE_THEME: CandleTheme = {
    grid: "rgba(100,116,139,0.14)",
    gridStrong: "rgba(100,116,139,0.24)",
    axis: "#94a3b8",
    ink: "#0f172a",
    inkDim: "#64748b",
    amber: "#d97706",
    pos: "#16a34a",
    neg: "#dc2626",
    crosshair: "rgba(217,119,6,0.45)",
    hoverTag: "#e2e8f0",
    liveTagInk: "#ffffff",
};

const DARK_CANDLE_THEME: CandleTheme = {
    grid: "rgba(255,255,255,0.07)",
    gridStrong: "rgba(255,255,255,0.12)",
    axis: "#64748b",
    ink: "#e2e8f0",
    inkDim: "#94a3b8",
    amber: "#f59e0b",
    pos: "#4ade80",
    neg: "#fb7185",
    crosshair: "rgba(245,158,11,0.5)",
    hoverTag: "#1e293b",
    liveTagInk: "#0f172a",
};

async function fetchStockQuote(symbol: string, range: StockRange | "none"): Promise<StockQuoteResponse> {
    const response = await fetch(
        `${API_BASE_URL}/market/stocks/${encodeURIComponent(symbol)}?range=${range}`,
    );
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    return (await response.json()) as StockQuoteResponse;
}

function useIsVisible(ref: React.RefObject<HTMLElement | null>): boolean {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const element = ref.current;
        if (!element || typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
            { rootMargin: "200px" },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return visible;
}

function useCandleTheme(): CandleTheme {
    const [dark, setDark] = useState(() =>
        typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
    );
    useEffect(() => {
        const root = document.documentElement;
        const update = () => setDark(root.classList.contains("dark"));
        const observer = new MutationObserver(update);
        observer.observe(root, { attributes: true, attributeFilter: ["class"] });
        return () => observer.disconnect();
    }, []);
    return dark ? DARK_CANDLE_THEME : LIGHT_CANDLE_THEME;
}

function formatPrice(value: number | null): string {
    return value === null ? "—" : `$${value.toFixed(2)}`;
}

function formatChange(percent: number | null): string {
    if (percent === null) return "—";
    return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function formatClock(iso: string | undefined): string {
    if (!iso) return "";
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatMessageAge(sentAtMs: number, nowMs: number): string | null {
    const minutes = Math.floor((nowMs - sentAtMs) / 60_000);
    if (minutes < 10) return null;
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days >= 1) return `消息发于 ${days} 天前`;
    if (hours >= 1) return `消息发于 ${hours} 小时前`;
    return `消息发于 ${minutes} 分钟前`;
}

function StockChartSkeleton({
    symbol,
    note,
    height = 210,
    workspace = false,
}: {
    symbol: string;
    note: string;
    height?: number;
    workspace?: boolean;
}) {
    return (
        <span className={cn(
            "block rounded-lg border border-sep bg-raised p-4",
            workspace ? "h-full border-0 bg-transparent dark:bg-transparent" : "my-3",
        )}>
            <span className="block text-sm font-medium text-label-1">{symbol}</span>
            <span className="mt-1 block text-xs text-label-2">{note}</span>
            <span
                className="mt-3 block animate-pulse rounded-md bg-fill-1"
                style={{ height }}
            />
        </span>
    );
}

function StockChartLive({
    symbol,
    initialRange,
    height = 210,
    workspace = false,
    studies = [],
}: {
    symbol: string;
    initialRange: StockRange;
    height?: number;
    workspace?: boolean;
    studies?: TechnicalStudy[];
}) {
    const [range, setRange] = useState<StockRange>(initialRange);
    const containerRef = useRef<HTMLSpanElement | null>(null);
    const isVisible = useIsVisible(containerRef);
    const sentAtMs = useContext(MessageTimeContext);
    const theme = useCandleTheme();

    const priceOverlays = useMemo<CandleOverlay[]>(() => {
        let colorIndex = 0;
        return studies.filter((study) => study.placement === "overlay").flatMap((study) =>
            study.series.map((series) => ({
                key: `${study.id}:${series.key}`,
                label: series.label,
                color: CANDLE_OVERLAY_COLORS[colorIndex++ % CANDLE_OVERLAY_COLORS.length],
                points: series.points.map((point) => ({
                    t: new Date(point.timestamp.length === 10 ? `${point.timestamp}T00:00:00Z` : point.timestamp).getTime(),
                    value: point.value,
                })).filter((point) => Number.isFinite(point.t)),
            })),
        );
    }, [studies]);
    const priceLevels = useMemo<CandlePriceLevel[]>(() => {
        let colorIndex = priceOverlays.length;
        return studies.filter((study) => study.placement === "overlay").flatMap((study) =>
            study.levels.map((level, index) => ({
                key: `${study.id}:${level.kind}:${index}`,
                label: level.label,
                value: level.value,
                color: CANDLE_OVERLAY_COLORS[colorIndex++ % CANDLE_OVERLAY_COLORS.length],
            })),
        );
    }, [priceOverlays.length, studies]);

    useEffect(() => setRange(initialRange), [initialRange, symbol]);

    const quoteQuery = useQuery({
        queryKey: ["stock-quote", symbol],
        queryFn: () => fetchStockQuote(symbol, "none"),
        enabled: isVisible,
        refetchInterval: (query) => {
            const session = query.state.data?.session;
            return session ? pollIntervalForSession(session) : false;
        },
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        staleTime: 2_000,
        placeholderData: (previous) => previous,
    });

    const candlesQuery = useQuery({
        queryKey: ["stock-candles", symbol, range],
        queryFn: () => fetchStockQuote(symbol, range),
        enabled: isVisible,
        refetchInterval: (query) => {
            if (!shouldPollCandles(range)) return false;
            const session = query.state.data?.session;
            return session ? pollIntervalForSession(session) : false;
        },
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        staleTime: shouldPollCandles(range) ? 0 : 5 * 60_000,
        placeholderData: (previous) => previous,
    });

    const headerData = quoteQuery.data ?? candlesQuery.data;
    const quote = quoteQuery.data?.quote ?? candlesQuery.data?.quote ?? null;
    const rawCandles = candlesQuery.data?.candles ?? [];
    const candles = useMemo<Candle[]>(() => rawCandles.map((item) => ({
        t: new Date(item.t.length === 10 ? `${item.t}T00:00:00Z` : item.t).getTime(),
        o: item.o,
        h: item.h,
        l: item.l,
        c: item.c,
    })).filter((item) => Number.isFinite(item.t)), [rawCandles]);
    const session = headerData?.session ?? "closed";
    const prevClose = quote?.prevClose ?? null;
    const price = quote?.price ?? rawCandles.at(-1)?.c ?? null;
    const rising = price !== null && prevClose !== null ? price >= prevClose : true;
    const messageAge = useMemo(
        () => (sentAtMs === null ? null : formatMessageAge(sentAtMs, Date.now())),
        [sentAtMs],
    );
    const loading = quoteQuery.isPending && candlesQuery.isPending;
    const disconnected = quoteQuery.isError && quoteQuery.data !== undefined;
    const failed = quoteQuery.isError && candlesQuery.isError && !quoteQuery.data && !candlesQuery.data;
    const formatTimestamp = useMemo(() => {
        const dateOnly = candlesQuery.data?.timeframe === "1Day";
        return (timestampMs: number) => new Date(timestampMs).toLocaleString(undefined, dateOnly
            ? { month: "2-digit", day: "2-digit" }
            : { hour: "2-digit", minute: "2-digit" });
    }, [candlesQuery.data?.timeframe]);

    if (loading) {
        return (
            <span ref={containerRef} className="block h-full">
                <StockChartSkeleton symbol={symbol} note="加载行情…" height={height} workspace={workspace} />
            </span>
        );
    }
    if (failed) {
        return (
            <span ref={containerRef} className={cn(
                "block rounded-lg border border-sep bg-raised p-4 text-sm text-label-2",
                workspace ? "h-full border-0 bg-transparent dark:bg-transparent" : "my-3",
            )}>
                {symbol} 行情暂时不可用。
            </span>
        );
    }

    const candleStaleness = candlesQuery.data?.staleness;
    return (
        <span ref={containerRef} className={cn(
            "block rounded-lg border border-sep bg-raised p-4",
            workspace ? "h-full border-0 bg-transparent dark:bg-transparent" : "my-3",
        )}>
            <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-label-1">{symbol}</span>
                <span className="fin-figure text-lg font-semibold text-label-1">{formatPrice(price)}</span>
                <span className={cn("text-sm font-medium tabular-nums", rising ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
                    {formatChange(quote?.changePercent ?? null)}
                </span>
                <span className="rounded-full bg-fill-1 px-2 py-0.5 text-[11px] text-label-2">{SESSION_LABEL[session]}</span>
                <span className="ml-auto text-[11px] text-label-3">Alpaca (IEX)</span>
            </span>

            <span className="mt-1 block text-[11px] text-label-2">
                {disconnected
                    ? `连接中断 · 数据截至 ${formatClock(quote?.quoteTimestamp)}`
                    : candleStaleness?.reason === "previous_session"
                      ? `上一交易日 · ${candleStaleness.asOf}`
                      : quoteQuery.data?.staleness
                        ? `实时报价不可用 · 数据截至 ${quoteQuery.data.staleness.asOf}`
                        : "实时数据"}
                {messageAge ? ` · ${messageAge}` : ""}
            </span>

            <span className="mt-3 flex gap-1" role="group" aria-label="图表区间">
                {STOCK_RANGES.map((item) => (
                    <button
                        key={item}
                        type="button"
                        onClick={() => setRange(item)}
                        aria-pressed={range === item}
                        className={cn(
                            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                            range === item
                                ? "bg-primary text-primary-foreground"
                                : "text-label-2 hover:bg-fill-1",
                        )}
                    >
                        {item}
                    </button>
                ))}
            </span>

            <span className="mt-2 block overflow-hidden" style={{ height }}>
                {candles.length > 0 ? (
                    <CandleScope
                        candles={candles}
                        lastPrice={quote?.price ?? undefined}
                        height={height}
                        quote="USD"
                        theme={theme}
                        formatTimestamp={formatTimestamp}
                        overlays={priceOverlays}
                        levels={priceLevels}
                    />
                ) : (
                    <span className="flex h-full items-center justify-center text-xs text-label-3">暂无 K 线数据</span>
                )}
            </span>
        </span>
    );
}

export function StockChartView({
    symbol,
    range,
    height = 520,
    workspace = false,
    studies = [],
}: {
    symbol: unknown;
    range?: unknown;
    height?: number;
    workspace?: boolean;
    studies?: TechnicalStudy[];
}) {
    const parsed = parseStockChartProps({ symbol, range });
    if ("error" in parsed) {
        return <span className="text-sm text-red-600 dark:text-red-400">无效的股票代码：{parsed.error}</span>;
    }
    return (
        <StockChartLive
            symbol={parsed.symbol}
            initialRange={parsed.range}
            height={height}
            workspace={workspace}
            studies={studies}
        />
    );
}

export default function StockChartBlock(props: { symbol?: unknown; range?: unknown }) {
    const streaming = useContext(StreamingContext);
    const parsed = parseStockChartProps(props);
    if ("error" in parsed) {
        return <span className="text-sm text-red-600 dark:text-red-400">无效的股票代码：{parsed.error}</span>;
    }
    if (streaming) {
        return <StockChartSkeleton symbol={parsed.symbol} note="图表将在回答完成后显示" />;
    }
    return <StockChartLive symbol={parsed.symbol} initialRange={parsed.range} />;
}
