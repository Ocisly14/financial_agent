import React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Order-configuration parsing
// ---------------------------------------------------------------------------

const VARIANT_LABELS: Record<string, { type: string; tif: string }> = {
    market_market_ioc: { type: "Market", tif: "IOC" },
    market_market_fok: { type: "Market", tif: "FOK" },
    limit_limit_gtc: { type: "Limit", tif: "GTC" },
    limit_limit_gtd: { type: "Limit", tif: "GTD" },
    sor_limit_ioc: { type: "Limit (SOR)", tif: "IOC" },
    limit_limit_fok: { type: "Limit", tif: "FOK" },
    stop_limit_stop_limit_gtc: { type: "Stop-Limit", tif: "GTC" },
    stop_limit_stop_limit_gtd: { type: "Stop-Limit", tif: "GTD" },
    trigger_bracket_gtc: { type: "Trigger Bracket", tif: "GTC" },
    trigger_bracket_gtd: { type: "Trigger Bracket", tif: "GTD" },
    trailing_stop_limit_gtc: { type: "Trailing Stop", tif: "GTC" },
    oco_gtc: { type: "OCO (TP+SL)", tif: "GTC" },
};

/**
 * Map an order-configuration variant key to the closest classical
 * order-type subtab (Limit / Market / Stop Limit). Used to drive the
 * Binance-style subtab strip's active underline. Exotic variants
 * (OCO, Trailing Stop, Trigger Bracket) collapse to "Stop Limit" —
 * that's the dropdown they live under in Binance's own UI — and the
 * exact variant is surfaced as an amber chip in the header so the
 * reviewer still sees what kind of order this actually is.
 */
function variantToSubtab(variantKey: string): "Limit" | "Market" | "Stop Limit" {
    if (variantKey.startsWith("market_")) return "Market";
    if (variantKey.startsWith("limit_") || variantKey === "sor_limit_ioc") {
        return "Limit";
    }
    // stop_limit_*, trigger_bracket_*, trailing_stop_*, oco_*
    return "Stop Limit";
}

function tryParseObject(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            return null;
        }
    }
    return null;
}

export function parseOrderConfiguration(raw: unknown): {
    variantKey: string;
    type: string;
    timeInForce: string;
    inner: Record<string, unknown>;
} | null {
    const parsed = tryParseObject(raw);
    if (!parsed) return null;
    const entries = Object.entries(parsed);
    if (entries.length !== 1) return null;
    const [variantKey, variantValue] = entries[0];
    const inner = tryParseObject(variantValue) ?? {};
    const meta = VARIANT_LABELS[variantKey] ?? { type: variantKey, tif: "" };
    return {
        variantKey,
        type: meta.type,
        timeInForce: meta.tif,
        inner,
    };
}

/**
 * Returns the BASE-QUOTE form for display. Heuristic split: longer
 * quote suffix wins. Pure function, no normalization vs. backend.
 */
export function displayPair(symbol: string | null | undefined): string {
    if (!symbol) return "—";
    const s = String(symbol).trim().toUpperCase();
    if (!s) return "—";
    if (s.includes("-") || s.includes("/")) {
        return s.replace(/\//g, "-").replace(/_/g, "-");
    }
    const QUOTES = [
        "USDC", "USDT", "FDUSD", "TUSD", "BUSD", "USDP", "USDD", "DAI", "PYUSD",
        "USDE", "USD", "EUR", "GBP", "JPY", "TRY", "BRL", "AUD", "CAD",
    ];
    for (const q of QUOTES) {
        if (s.endsWith(q) && s.length > q.length) {
            const base = s.slice(0, -q.length);
            if (base.length >= 1 && /^[A-Z0-9]+$/.test(base)) {
                return `${base}-${q}`;
            }
        }
    }
    return s;
}

function splitPair(pair: string): { base: string; quote: string } | null {
    const idx = pair.indexOf("-");
    if (idx <= 0) return null;
    return { base: pair.slice(0, idx), quote: pair.slice(idx + 1) };
}

function asString(v: unknown): string {
    if (v === null || v === undefined) return "";
    return typeof v === "string" ? v : String(v);
}

function formatNumber(value: string): string {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return value || "—";
    return n.toLocaleString("en-US", {
        maximumFractionDigits: 8,
        minimumFractionDigits: 0,
    });
}

// ---------------------------------------------------------------------------
// Atom components
// ---------------------------------------------------------------------------

type ChipTone = "neutral" | "amber" | "emerald" | "rose" | "blue";

const CHIP_TONE_CLASS: Record<ChipTone, string> = {
    neutral: "bg-white/5 text-white/70 ring-white/15",
    amber: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
    emerald: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
    rose: "bg-rose-500/10 text-rose-300 ring-rose-400/30",
    blue: "bg-blue-500/10 text-blue-300 ring-blue-400/30",
};

const SmallChip: React.FC<{
    children: React.ReactNode;
    tone?: ChipTone;
}> = ({ children, tone = "neutral" }) => (
    <span
        className={cn(
            "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ring-1",
            CHIP_TONE_CLASS[tone],
        )}
    >
        {children}
    </span>
);

/**
 * Binance-style horizontal tab row with an amber underline on the
 * active tab. Inactive tabs render at 35% opacity; this card is a
 * REVIEW (not an entry form), so the inactive tabs are intentionally
 * not interactive — they exist only to establish trading-context.
 */
const TabStrip: React.FC<{
    tabs: ReadonlyArray<string>;
    active: string;
    size?: "lg" | "sm";
}> = ({ tabs, active, size = "lg" }) => (
    <div
        className={cn(
            "flex items-center border-b border-white/5",
            size === "lg" ? "px-5 pt-3 gap-5" : "px-5 pt-2 gap-4",
        )}
    >
        {tabs.map((label) => {
            const isActive = label === active;
            return (
                <div
                    key={label}
                    className={cn(
                        "relative pb-2 transition-colors duration-150",
                        size === "lg" ? "text-[13px]" : "text-[12px]",
                        isActive
                            ? "text-white font-semibold"
                            : "text-white/35",
                    )}
                >
                    {label}
                    {isActive ? (
                        <span className="absolute -bottom-px left-0 right-0 h-[2px] bg-amber-400 rounded-full" />
                    ) : null}
                </div>
            );
        })}
    </div>
);

/**
 * Binance-style margin-action selector (Normal / Borrow / Repay) for
 * Cross / Isolated margin orders. The active option gets a filled
 * dark background; inactive ones are flat gray text. Hidden on Spot.
 */
const MarginActionRow: React.FC<{ marginAction: string | null }> = ({
    marginAction,
}) => {
    const normalized =
        marginAction === "AUTO_BORROW"
            ? "Borrow"
            : marginAction === "AUTO_REPAY"
              ? "Repay"
              : "Normal";
    const options: ReadonlyArray<"Normal" | "Borrow" | "Repay"> = [
        "Normal",
        "Borrow",
        "Repay",
    ];
    return (
        <div className="px-5 py-2 flex items-center gap-2 border-b border-white/5 bg-black/20">
            {options.map((opt) => {
                const isActive = opt === normalized;
                return (
                    <span
                        key={opt}
                        className={cn(
                            "px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors",
                            isActive
                                ? opt === "Borrow"
                                    ? "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30"
                                    : opt === "Repay"
                                      ? "bg-blue-500/15 text-blue-200 ring-1 ring-blue-400/30"
                                      : "bg-white/10 text-white/85 ring-1 ring-white/15"
                                : "text-white/30",
                        )}
                    >
                        {opt}
                    </span>
                );
            })}
        </div>
    );
};

/**
 * Binance-style "field block" — a rounded, faintly-bordered container
 * that mimics an input field. Label sits on the left, value is
 * right-aligned (monospaced), unit lives on the far right in muted
 * text. Optional footer (e.g. "Minimum 5 USDT") renders in micro-type.
 */
const FieldBlock: React.FC<{
    label: string;
    value: React.ReactNode;
    unit?: string | null;
    footer?: React.ReactNode;
    /** Visual tint for take-profit / stop-loss legs. */
    accent?: "emerald" | "rose";
}> = ({ label, value, unit, footer, accent }) => {
    const accentBorder =
        accent === "emerald"
            ? "border-emerald-400/20"
            : accent === "rose"
              ? "border-rose-400/20"
              : "border-white/10";
    return (
        <div
            className={cn(
                "rounded-lg border bg-[#161a1f] px-3 py-2.5",
                accentBorder,
            )}
        >
            <div className="flex items-baseline gap-2">
                <span className="text-[11px] text-white/45 font-medium uppercase tracking-wide flex-shrink-0">
                    {label}
                </span>
                <span
                    className={cn(
                        "ml-auto text-right font-mono text-[14px] tabular-nums",
                        accent === "emerald" ? "text-emerald-300" : accent === "rose" ? "text-rose-300" : "text-white/95",
                    )}
                >
                    {value}
                </span>
                {unit ? (
                    <span className="text-[11px] text-white/40 font-medium flex-shrink-0 w-12 text-right">
                        {unit}
                    </span>
                ) : null}
            </div>
            {footer ? (
                <div className="mt-1 text-[10px] text-white/30">{footer}</div>
            ) : null}
        </div>
    );
};

const DetailRow: React.FC<{
    label: string;
    value: React.ReactNode;
}> = ({ label, value }) => (
    <div className="flex items-center justify-between py-1">
        <span className="text-[11px] text-white/45">{label}</span>
        <span className="text-[12px] text-white/85 font-medium">{value}</span>
    </div>
);

function safeNum(s: string): number | null {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function formatBalance(value: number): string {
    return value.toLocaleString("en-US", {
        maximumFractionDigits: 8,
        minimumFractionDigits: 0,
    });
}

/**
 * Binance-style Avbl / Max Buy or Sell / Est Fee strip.
 *
 * Reads the server-supplied `snapshot` plus the form's price / size
 * fields to compute:
 *   - **Avbl** — quote-currency balance for BUY, base-currency for SELL
 *   - **Max** — `avbl × (1 - fee) / price` (BUY) or `avbl × price × (1 - fee)` (SELL)
 *   - **Est Fee** — `notional × feeBps / 10000` (defaults to 10 bps when feeBps is absent)
 *
 * If `limitPrice` is missing (market order), Max can't be computed
 * precisely and is shown as "—". The block always renders Avbl + Est
 * Fee when a snapshot is available.
 */
const AvblMaxFeeBlock: React.FC<{
    snapshot: OrderConfigAccountSnapshot;
    isBuy: boolean;
    isSell: boolean;
    limitPrice: string;
    baseSize: string;
    quoteSize: string;
    /** Pair-derived asset labels — render from these, not snapshot. */
    currentBaseAsset?: string | null;
    currentQuoteAsset?: string | null;
}> = ({
    snapshot,
    isBuy,
    isSell,
    limitPrice,
    baseSize,
    quoteSize,
    currentBaseAsset,
    currentQuoteAsset,
}) => {
    const feeBps = snapshot.feeBps ?? 10;
    const feeRate = feeBps / 10_000;

    const priceN = safeNum(limitPrice);
    const baseSizeN = safeNum(baseSize);
    const quoteSizeN = safeNum(quoteSize);

    const baseLabel = currentBaseAsset || snapshot.baseAsset;
    const quoteLabel = currentQuoteAsset || snapshot.quoteAsset;
    const snapshotMatchesPair =
        (!currentBaseAsset || snapshot.baseAsset === currentBaseAsset) &&
        (!currentQuoteAsset || snapshot.quoteAsset === currentQuoteAsset);

    const avblValue = isBuy
        ? snapshot.quoteAvailable
        : isSell
          ? snapshot.baseAvailable
          : snapshot.quoteAvailable;
    const avblAsset = isBuy ? quoteLabel : isSell ? baseLabel : quoteLabel;
    const avblN = snapshotMatchesPair ? safeNum(avblValue) : null;

    // Max buy/sell, fee-discounted. Null when we don't have enough
    // signal (market order without a price, or zero balance).
    const maxValue = (() => {
        if (avblN === null || avblN <= 0) return null;
        if (isBuy) {
            if (priceN === null || priceN <= 0) return null;
            return (avblN * (1 - feeRate)) / priceN; // in base units
        }
        if (isSell) {
            if (priceN === null || priceN <= 0) return null;
            return avblN * priceN * (1 - feeRate); // in quote units
        }
        return null;
    })();
    const maxLabel = isBuy ? "Max Buy" : isSell ? "Max Sell" : "Max";
    const maxAsset = isBuy ? baseLabel : quoteLabel;

    // Estimated fee: notional × feeBps. Notional is the size in QUOTE units.
    const estFeeValue = (() => {
        if (priceN === null && quoteSizeN === null) return null;
        // quote_size already in quote units
        if (quoteSizeN !== null && quoteSizeN > 0) return quoteSizeN * feeRate;
        if (baseSizeN !== null && baseSizeN > 0 && priceN !== null && priceN > 0) {
            return baseSizeN * priceN * feeRate;
        }
        return null;
    })();

    const feePct = (feeBps / 100).toLocaleString("en-US", {
        maximumFractionDigits: 2,
    });

    return (
        <div className="px-5 py-3 border-t border-white/5 bg-black/10 space-y-1.5">
            <DetailRow
                label="Avbl"
                value={
                    avblN !== null ? (
                        <span className="font-mono text-white/90 tabular-nums">
                            {formatBalance(avblN)}
                            <span className="text-white/45 ml-1.5">{avblAsset}</span>
                        </span>
                    ) : (
                        <span className="text-white/35">—</span>
                    )
                }
            />
            <DetailRow
                label={maxLabel}
                value={
                    maxValue !== null ? (
                        <span className="font-mono text-white/90 tabular-nums">
                            {formatBalance(maxValue)}
                            <span className="text-white/45 ml-1.5">{maxAsset}</span>
                        </span>
                    ) : (
                        <span className="text-white/35">—</span>
                    )
                }
            />
            <DetailRow
                label={`Est. Fee (${feePct}%)`}
                value={
                    estFeeValue !== null ? (
                        <span className="font-mono text-white/90 tabular-nums">
                            ≈ {formatBalance(estFeeValue)}
                            <span className="text-white/45 ml-1.5">{quoteLabel}</span>
                        </span>
                    ) : (
                        <span className="text-white/35">—</span>
                    )
                }
            />
        </div>
    );
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Optional account-balance snapshot the server attaches to the
 * approval payload for `create_order`. Drives the Avbl / Max
 * Buy / Est Fee block at the bottom of the card. Hidden when null.
 */
export interface OrderConfigAccountSnapshot {
    baseAvailable: string;
    quoteAvailable: string;
    baseAsset: string;
    quoteAsset: string;
    /** Fee tier in basis points (default 10 = 0.10%). */
    feeBps?: number;
}

export interface OrderConfigSummaryCardProps {
    /** Raw `order_configuration` value — JSON string OR an object. */
    orderConfig: unknown;
    /** Canonical pair, e.g., "BTC-USDT". */
    pair: string | null | undefined;
    /** "BUY" / "SELL". */
    side: string | null | undefined;
    /** Venue, e.g., "binance" / "coinbase". */
    venue?: string | null;
    /** Preview ID (Coinbase-specific). */
    previewId?: string | null;
    /** Retail portfolio ID (Coinbase-specific). */
    retailPortfolioId?: string | null;
    /** Available-balance snapshot — server-fetched at approval time. */
    accountSnapshot?: OrderConfigAccountSnapshot | null;
}

export const OrderConfigSummaryCard: React.FC<OrderConfigSummaryCardProps> = ({
    orderConfig,
    pair,
    side,
    venue,
    previewId,
    retailPortfolioId,
    accountSnapshot,
}) => {
    const parsed = parseOrderConfiguration(orderConfig);
    const displayedPair = displayPair(pair);
    const split = splitPair(displayedPair);
    const sideUpper = (side ?? "").toString().toUpperCase();
    const isBuy = sideUpper === "BUY";
    const isSell = sideUpper === "SELL";

    const inner = parsed?.inner ?? {};
    const baseSize = asString(inner.base_size);
    const quoteSize = asString(inner.quote_size);
    const limitPrice = asString(inner.limit_price);
    const stopPrice = asString(inner.stop_price);
    const stopTrigger = asString(inner.stop_trigger_price);
    const stopDirection = asString(inner.stop_direction);
    const endTime = asString(inner.end_time);
    const postOnly = inner.post_only;

    const icebergQty = asString(inner.iceberg_qty);
    const trailingDeltaBps = inner.trailing_delta_bps;
    const trailingActivation = asString(inner.activation_price);
    const ocoAboveLimit = asString(inner.above_limit_price);
    const ocoBelowStop = asString(inner.below_stop_price);
    const ocoBelowLimit = asString(inner.below_limit_price);
    const ocoBelowTif = asString(inner.below_time_in_force);

    const rawParsed = tryParseObject(orderConfig);
    const leverage = rawParsed?.leverage ? String(rawParsed.leverage) : null;
    const marginType = rawParsed?.margin_type ? String(rawParsed.margin_type) : null;
    const marginAction = rawParsed?.margin_action ? String(rawParsed.margin_action) : null;

    const baseAsset = split?.base;
    const quoteAsset = split?.quote;

    const estimatedTotal = (() => {
        if (!limitPrice) return null;
        const sizeStr = baseSize || quoteSize;
        if (!sizeStr) return null;
        const b = Number.parseFloat(sizeStr);
        const p = Number.parseFloat(limitPrice);
        if (!Number.isFinite(b) || !Number.isFinite(p)) return null;
        // If we have quote_size, the total IS quote_size (no multiplication needed).
        const total = baseSize ? b * p : b;
        return total.toLocaleString("en-US", {
            maximumFractionDigits: 4,
            minimumFractionDigits: 2,
        });
    })();

    // ----- Trading-mode tab strip data -----
    const marginTypeUpper = marginType ? marginType.toUpperCase() : null;
    const activeMode: "Spot" | "Cross" | "Isolated" =
        marginTypeUpper === "CROSS"
            ? "Cross"
            : marginTypeUpper === "ISOLATED"
              ? "Isolated"
              : "Spot";
    const modeTabs: ReadonlyArray<"Spot" | "Cross" | "Isolated"> = [
        "Spot",
        "Cross",
        "Isolated",
    ];

    // ----- Order-type subtab data -----
    const orderTypeSubtab = parsed
        ? variantToSubtab(parsed.variantKey)
        : "Limit";
    const orderTypeSubtabs: ReadonlyArray<"Limit" | "Market" | "Stop Limit"> = [
        "Limit",
        "Market",
        "Stop Limit",
    ];
    // Exotic variants that don't fit the three classical subtabs get
    // their exact name surfaced as a chip in the header.
    const exoticVariant =
        parsed &&
        ["oco_gtc", "trailing_stop_limit_gtc", "trigger_bracket_gtc", "trigger_bracket_gtd"].includes(
            parsed.variantKey,
        );

    const sideAccentBg =
        isBuy
            ? "bg-emerald-500/8"
            : isSell
              ? "bg-rose-500/8"
              : "bg-white/5";

    return (
        <div className="rounded-xl border border-white/10 bg-[#1e2329] overflow-hidden shadow-lg">
            {/* Tier 1: trading mode tabs */}
            <TabStrip tabs={modeTabs} active={activeMode} size="lg" />

            {/* Tier 2: order-type subtabs */}
            <TabStrip tabs={orderTypeSubtabs} active={orderTypeSubtab} size="sm" />

            {/* Header: side + pair + variant chip */}
            <div
                className={cn(
                    "px-5 py-3.5 border-b border-white/5 flex items-center justify-between",
                    sideAccentBg,
                )}
            >
                <div className="flex items-baseline gap-3">
                    {sideUpper ? (
                        <span
                            className={cn(
                                "text-base font-bold tracking-wide",
                                isBuy ? "text-emerald-400" : "text-rose-400",
                            )}
                        >
                            {sideUpper}
                        </span>
                    ) : null}
                    <span className="text-base font-bold text-white/95 font-mono">
                        {displayedPair}
                    </span>
                </div>
                <div className="flex items-center gap-1.5">
                    {parsed && exoticVariant ? (
                        <SmallChip tone="amber">{parsed.type}</SmallChip>
                    ) : null}
                    {parsed?.timeInForce ? (
                        <SmallChip tone="blue">{parsed.timeInForce}</SmallChip>
                    ) : null}
                </div>
            </div>

            {/* Margin action sub-row — only when this is a margin order */}
            {marginType ? <MarginActionRow marginAction={marginAction} /> : null}

            {/* Body: field blocks */}
            <div className="px-5 py-4 space-y-2.5">
                {limitPrice ? (
                    <FieldBlock
                        label="Price"
                        value={formatNumber(limitPrice)}
                        unit={quoteAsset ?? null}
                    />
                ) : null}

                {baseSize ? (
                    <FieldBlock
                        label="Amount"
                        value={formatNumber(baseSize)}
                        unit={baseAsset ?? null}
                    />
                ) : null}

                {quoteSize && !baseSize ? (
                    <FieldBlock
                        label="Spend"
                        value={formatNumber(quoteSize)}
                        unit={quoteAsset ?? null}
                    />
                ) : null}

                {stopPrice ? (
                    <FieldBlock
                        label="Stop Price"
                        value={formatNumber(stopPrice)}
                        unit={quoteAsset ?? null}
                    />
                ) : null}

                {stopTrigger ? (
                    <FieldBlock
                        label="Stop Trigger"
                        value={formatNumber(stopTrigger)}
                        unit={quoteAsset ?? null}
                    />
                ) : null}

                {estimatedTotal !== null ? (
                    <FieldBlock
                        label="Total"
                        value={`≈ ${estimatedTotal}`}
                        unit={quoteAsset ?? null}
                        footer={
                            <span className="text-white/30">Minimum 5 {quoteAsset ?? ""}</span>
                        }
                    />
                ) : null}

                {/* OCO legs — colored to mirror Binance's TP green / SL red */}
                {ocoAboveLimit ? (
                    <FieldBlock
                        label="Take-Profit"
                        value={formatNumber(ocoAboveLimit)}
                        unit={quoteAsset ?? null}
                        accent="emerald"
                        footer="Limit-maker leg (above market)"
                    />
                ) : null}
                {ocoBelowStop ? (
                    <FieldBlock
                        label="Stop Trigger"
                        value={formatNumber(ocoBelowStop)}
                        unit={quoteAsset ?? null}
                        accent="rose"
                        footer="OCO stop-loss trigger (below market)"
                    />
                ) : null}
                {ocoBelowLimit ? (
                    <FieldBlock
                        label="Stop Limit"
                        value={formatNumber(ocoBelowLimit)}
                        unit={quoteAsset ?? null}
                        accent="rose"
                        footer={
                            ocoBelowTif && parsed?.variantKey === "oco_gtc"
                                ? `Stop-leg TIF: ${ocoBelowTif}`
                                : "OCO stop-loss limit price"
                        }
                    />
                ) : null}

                {/* Trailing-stop activation/delta */}
                {typeof trailingDeltaBps === "number" && Number.isFinite(trailingDeltaBps) ? (
                    <FieldBlock
                        label="Trail Δ"
                        value={`${trailingDeltaBps} bps (${(trailingDeltaBps / 100).toLocaleString("en-US", {
                            maximumFractionDigits: 2,
                        })}%)`}
                        unit={null}
                    />
                ) : null}
                {trailingActivation ? (
                    <FieldBlock
                        label="Activation"
                        value={formatNumber(trailingActivation)}
                        unit={quoteAsset ?? null}
                    />
                ) : null}

                {/* Iceberg quantity (Binance hidden-order). */}
                {icebergQty ? (
                    <FieldBlock
                        label="Iceberg Qty"
                        value={formatNumber(icebergQty)}
                        unit={baseAsset ?? null}
                        footer="Visible portion of a hidden limit order"
                    />
                ) : null}
            </div>

            {/* TP/SL + post-only + GTD strip — compact toggles, not full blocks */}
            {(postOnly !== undefined && postOnly !== null && postOnly !== "") ||
            endTime ||
            stopDirection ? (
                <div className="px-5 py-2.5 border-t border-white/5 flex items-center gap-3 flex-wrap text-[11px] text-white/55">
                    {postOnly !== undefined && postOnly !== null && postOnly !== "" ? (
                        <span className="inline-flex items-center gap-1.5">
                            <span
                                className={cn(
                                    "w-3 h-3 rounded-[3px] ring-1 ring-white/20",
                                    postOnly === true || postOnly === "true" || postOnly === 1 || postOnly === "1"
                                        ? "bg-amber-400"
                                        : "bg-transparent",
                                )}
                            />
                            Post Only
                        </span>
                    ) : null}
                    {endTime ? (
                        <span className="inline-flex items-center gap-1.5">
                            <span className="text-white/40">Expires (GTD):</span>
                            <span className="font-mono text-white/85">{endTime}</span>
                        </span>
                    ) : null}
                    {stopDirection ? (
                        <span className="inline-flex items-center gap-1.5">
                            <span className="text-white/40">Stop:</span>
                            <SmallChip tone="neutral">
                                {/UP/i.test(stopDirection)
                                    ? "Up"
                                    : /DOWN/i.test(stopDirection)
                                      ? "Down"
                                      : stopDirection}
                            </SmallChip>
                        </span>
                    ) : null}
                </div>
            ) : null}

            {/* Avbl / Max Buy or Sell / Est Fee — server-supplied
                balance snapshot. Hidden when the server couldn't
                fetch (no creds, rate-limited, paper mode). */}
            {accountSnapshot ? (
                <AvblMaxFeeBlock
                    snapshot={accountSnapshot}
                    isBuy={isBuy}
                    isSell={isSell}
                    limitPrice={limitPrice}
                    baseSize={baseSize}
                    quoteSize={quoteSize}
                    currentBaseAsset={split?.base ?? null}
                    currentQuoteAsset={split?.quote ?? null}
                />
            ) : null}

            {/* Bottom summary — Avbl/Max/Est Fee placeholder + meta */}
            <div className="px-5 py-3 border-t border-white/5 bg-black/15 space-y-1">
                {leverage ? (
                    <DetailRow
                        label="Leverage"
                        value={<SmallChip tone="blue">{leverage}x</SmallChip>}
                    />
                ) : null}
                {marginType ? (
                    <DetailRow
                        label="Margin Mode"
                        value={<SmallChip tone="neutral">{marginType}</SmallChip>}
                    />
                ) : null}
                {marginAction ? (
                    <DetailRow
                        label="Margin Action"
                        value={
                            <SmallChip
                                tone={
                                    marginAction === "AUTO_BORROW"
                                        ? "amber"
                                        : marginAction === "AUTO_REPAY"
                                          ? "blue"
                                          : "neutral"
                                }
                            >
                                {marginAction === "AUTO_BORROW"
                                    ? "Borrow"
                                    : marginAction === "AUTO_REPAY"
                                      ? "Repay"
                                      : "Normal"}
                            </SmallChip>
                        }
                    />
                ) : null}
                {venue ? (
                    <DetailRow
                        label="Venue"
                        value={<SmallChip tone="neutral">{String(venue)}</SmallChip>}
                    />
                ) : null}
                {previewId ? (
                    <DetailRow
                        label="Preview ID"
                        value={
                            <span className="font-mono text-[11px] text-white/70">
                                {previewId}
                            </span>
                        }
                    />
                ) : null}
                {retailPortfolioId ? (
                    <DetailRow
                        label="Retail Portfolio"
                        value={
                            <span className="font-mono text-[11px] text-white/70">
                                {retailPortfolioId}
                            </span>
                        }
                    />
                ) : null}
            </div>
        </div>
    );
};
