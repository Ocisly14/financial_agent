/**
 * CEX post-PR237 Commit 3 — `MarketSnapshotPanel` migrated out of the
 * dormant `CEXApprovalDialog.tsx` into a standalone component so the
 * production `HumanInputDialog` can render it alongside
 * `TradingOrderEditor`.
 *
 * Behavior (preserved from the original Fix 14d implementation):
 *  - Renders a red mismatch banner when
 *    `symbol_verification.matches === false` and an amber quote-
 *    currency warning when only the quote differs.
 *  - Shows live bid/ask + spread, 24h stats, top-N depth ladder, and
 *    est-fill / slippage rows when a snapshot was successfully fetched
 *    by the server-side modal-enrichment pipeline.
 *  - Renders nothing when both the snapshot and verification are
 *    absent (e.g. read-only actions, or all three fetches timed out).
 *
 * Commit 11 — the snapshot is now venue-aware on the server side, so
 * the venue label in the heading reflects whatever exchange's API
 * actually served the data.
 */
import React from "react";
import { cn } from "@/lib/utils";

const SLIPPAGE_WARN_BPS = 100;

export interface CEXMarketDepthRow {
    price: string;
    qty: string;
}

export interface CEXMarketSnapshot {
    symbol: string;
    bid?: string;
    bid_qty?: string;
    ask?: string;
    ask_qty?: string;
    spread_bps?: number;
    price_change_pct?: string;
    high_24h?: string;
    low_24h?: string;
    volume_24h?: string;
    quote_volume_24h?: string;
    depth_bids?: CEXMarketDepthRow[];
    depth_asks?: CEXMarketDepthRow[];
    est_fill_price?: number;
    slippage_vs_limit_bps?: number;
    fetched_at_ms: number;
}

export interface CEXSymbolVerification {
    matches: boolean;
    extracted_symbol: string;
    user_text_asset_mentions: string[];
    quote_currency_mismatch?: boolean;
    reason?: string;
}

function formatPrice(value: number | null): string {
    if (value === null || value === undefined) return "--";
    const abs = Math.abs(value);
    if (abs >= 1000) return value.toFixed(2);
    if (abs >= 1) return value.toFixed(4);
    return value.toFixed(6);
}

function formatPriceString(raw: string | undefined): string {
    if (raw === undefined) return "--";
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return raw;
    return formatPrice(n);
}

function formatSpreadBps(bps: number | undefined): string {
    if (bps === undefined || !Number.isFinite(bps)) return "--";
    if (Math.abs(bps) < 1) return `${bps.toFixed(2)} bps`;
    return `${bps.toFixed(1)} bps`;
}

function formatPctSigned(raw: string | undefined): {
    text: string;
    positive: boolean;
} {
    if (!raw) return { text: "--", positive: true };
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return { text: raw, positive: true };
    const sign = n > 0 ? "+" : "";
    return { text: `${sign}${n.toFixed(2)}%`, positive: n >= 0 };
}

function formatQty(raw: string | undefined): string {
    if (raw === undefined) return "--";
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return raw;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
}

export interface MarketSnapshotPanelProps {
    snapshot?: CEXMarketSnapshot;
    verification?: CEXSymbolVerification;
    /**
     * Optional venue label (`Binance` / `Coinbase`) shown in the panel
     * header — surfaces which exchange's API served the live data,
     * helping users debug venue-routing issues.
     */
    venue?: string;
}

export function MarketSnapshotPanel({
    snapshot,
    verification,
    venue,
}: MarketSnapshotPanelProps): React.ReactElement | null {
    if (!snapshot && !verification) return null;
    const slippage = snapshot?.slippage_vs_limit_bps;
    const slipWarn =
        slippage !== undefined &&
        Number.isFinite(slippage) &&
        Math.abs(slippage) > SLIPPAGE_WARN_BPS;
    const pct = formatPctSigned(snapshot?.price_change_pct);

    return (
        <div className="px-5 pb-4" data-testid="cex-market-snapshot-panel">
            {verification &&
                !verification.matches &&
                // F10.5 — suppress the hard-stop banner when the
                // verification reason is `no_user_assets_mentioned`. That
                // reason fires in two structurally-clean cases:
                //   • the compose dialog passes `promptText: ""` because
                //     the user picked the pair from a combobox (not free
                //     text), so there is no NL extraction to disagree
                //     with;
                //   • the free-text approval modal received a prompt
                //     that contained no extractable asset mention (e.g.
                //     "buy a bit" or a zh-CN paraphrase), so the
                //     extractor's symbol can't be cross-checked.
                // In both cases the banner is a false-positive — a
                // mismatch requires at least one mention to disagree
                // with. The load-bearing
                // `extractor_symbol_missing_user_assets` case (user said
                // BTC but extractor returned ETH) still triggers.
                verification.reason !== "no_user_assets_mentioned" && (
                <div
                    className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200"
                    data-testid="cex-symbol-mismatch-banner"
                >
                    The extracted symbol (
                    <span className="font-mono">
                        {verification.extracted_symbol || "—"}
                    </span>
                    ) doesn&apos;t match what you typed (
                    <span className="font-mono">
                        {verification.user_text_asset_mentions.length > 0
                            ? verification.user_text_asset_mentions.join(", ")
                            : "—"}
                    </span>
                    ). Cancel and retry.
                </div>
            )}
            {verification?.matches && verification.quote_currency_mismatch && (
                <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
                    Quote currency differs from what you typed — the system is
                    fetching{" "}
                    <span className="font-mono">
                        {verification.extracted_symbol}
                    </span>
                    . Review and confirm if intended.
                </div>
            )}

            {/* F10.9 — explicit empty-state row when the venue does not
                publish data for this pair (e.g. switching from Binance
                BTC-USDT, where Coinbase doesn't list MATIC-USDT). The
                panel previously rendered nothing, which looked
                identical to "still loading" and led users to think the
                switch had silently failed. Surface the reason. */}
            {!snapshot && venue && (
                <div className="rounded-xl border border-white/8 bg-white/3 p-3">
                    <div className="flex items-center justify-between mb-1">
                        <div className="text-[11px] uppercase tracking-wider text-white/45 font-medium">
                            Market snapshot
                            <span className="ml-2 text-[10px] text-white/35 normal-case tracking-normal">
                                via {venue}
                            </span>
                        </div>
                    </div>
                    <div className="text-[12px] text-white/45">
                        No live data for this pair on{" "}
                        <span className="capitalize">{venue}</span>.
                        Try a different pair, or switch venues.
                    </div>
                </div>
            )}

            {snapshot && (
                <div className="rounded-xl border border-white/8 bg-white/3 p-3">
                    <div className="flex items-center justify-between mb-3">
                        <div className="text-[11px] uppercase tracking-wider text-white/45 font-medium">
                            Market snapshot
                            {venue && (
                                <span className="ml-2 text-[10px] text-white/35 normal-case tracking-normal">
                                    via {venue}
                                </span>
                            )}
                        </div>
                        <div className="text-[10px] text-white/35 font-mono">
                            {snapshot.symbol}
                        </div>
                    </div>

                    {/* Bid / Ask / Spread */}
                    <div className="grid grid-cols-3 gap-2 mb-3">
                        <div className="rounded-lg bg-white/4 border border-white/8 p-2">
                            <div className="text-[10px] text-white/35">Bid</div>
                            <div className="text-xs font-mono text-emerald-300">
                                {formatPriceString(snapshot.bid)}
                            </div>
                            <div className="text-[10px] font-mono text-white/45">
                                qty {formatQty(snapshot.bid_qty)}
                            </div>
                        </div>
                        <div className="rounded-lg bg-white/4 border border-white/8 p-2">
                            <div className="text-[10px] text-white/35">Ask</div>
                            <div className="text-xs font-mono text-rose-300">
                                {formatPriceString(snapshot.ask)}
                            </div>
                            <div className="text-[10px] font-mono text-white/45">
                                qty {formatQty(snapshot.ask_qty)}
                            </div>
                        </div>
                        <div className="rounded-lg bg-white/4 border border-white/8 p-2">
                            <div className="text-[10px] text-white/35">Spread</div>
                            <div className="text-xs font-mono text-white/85">
                                {formatSpreadBps(snapshot.spread_bps)}
                            </div>
                        </div>
                    </div>

                    {/* 24h stats row */}
                    {(snapshot.price_change_pct ||
                        snapshot.high_24h ||
                        snapshot.quote_volume_24h) && (
                        <div className="grid grid-cols-4 gap-2 mb-3 text-[11px]">
                            <div>
                                <div className="text-[10px] text-white/35">24h Δ</div>
                                <div
                                    className={cn(
                                        "font-mono",
                                        pct.positive
                                            ? "text-emerald-300"
                                            : "text-rose-300",
                                    )}
                                >
                                    {pct.text}
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] text-white/35">24h High</div>
                                <div className="font-mono text-white/75">
                                    {formatPriceString(snapshot.high_24h)}
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] text-white/35">24h Low</div>
                                <div className="font-mono text-white/75">
                                    {formatPriceString(snapshot.low_24h)}
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] text-white/35">24h Vol (Q)</div>
                                <div className="font-mono text-white/75">
                                    {formatQty(snapshot.quote_volume_24h)}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Depth ladder */}
                    {(snapshot.depth_bids?.length || snapshot.depth_asks?.length) && (
                        <div className="mb-3">
                            <div className="text-[10px] text-white/35 mb-1">
                                Top depth
                            </div>
                            <div className="grid grid-cols-2 gap-3 text-[11px] font-mono">
                                <div>
                                    <div className="text-[10px] text-emerald-300/70 mb-0.5">
                                        Bids
                                    </div>
                                    {(snapshot.depth_bids ?? [])
                                        .slice(0, 5)
                                        .map((row, i) => (
                                            <div
                                                key={`b-${i}`}
                                                className="flex justify-between text-white/70"
                                            >
                                                <span>
                                                    {formatPriceString(row.price)}
                                                </span>
                                                <span className="text-white/45">
                                                    {formatQty(row.qty)}
                                                </span>
                                            </div>
                                        ))}
                                </div>
                                <div>
                                    <div className="text-[10px] text-rose-300/70 mb-0.5">
                                        Asks
                                    </div>
                                    {(snapshot.depth_asks ?? [])
                                        .slice(0, 5)
                                        .map((row, i) => (
                                            <div
                                                key={`a-${i}`}
                                                className="flex justify-between text-white/70"
                                            >
                                                <span>
                                                    {formatPriceString(row.price)}
                                                </span>
                                                <span className="text-white/45">
                                                    {formatQty(row.qty)}
                                                </span>
                                            </div>
                                        ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Est fill / slippage row */}
                    {snapshot.est_fill_price !== undefined && (
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                            <div>
                                <div className="text-[10px] text-white/35">
                                    Est fill price
                                </div>
                                <div className="font-mono text-white/85">
                                    {formatPrice(snapshot.est_fill_price)}
                                </div>
                            </div>
                            {slippage !== undefined && Number.isFinite(slippage) && (
                                <div>
                                    <div className="text-[10px] text-white/35">
                                        Slippage vs limit
                                    </div>
                                    <div
                                        className={cn(
                                            "font-mono",
                                            slipWarn
                                                ? "text-amber-300 font-semibold"
                                                : "text-white/75",
                                        )}
                                    >
                                        {`${slippage > 0 ? "+" : ""}${slippage.toFixed(1)} bps`}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
