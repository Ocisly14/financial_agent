/**
 * F10.2 + F10.3 — Manual Trade Compose dialog.
 *
 * Wears the same approval-modal chrome as `HumanInputDialog`'s
 * "Review & Authorize Order" view AND embeds the same
 * `TradingOrderEditor` + `MarketSnapshotPanel` block 1:1 so the user
 * can fill in side / pair / size / price / TIF / post-only / margin
 * AND see live bid / ask / spread / 24 h stats / depth / est-fill /
 * slippage before placing the order in a single click — no second
 * approval modal.
 *
 * F10.3 (this revision) closes three gaps from F10.2:
 *   1. `venue` was never threaded in, so `TradingOrderEditor`'s
 *      snapshot-refresh effect short-circuited and the percent slider
 *      was inert. We now derive `venue` from the user's trading prefs
 *      (`preferred_exchange`) when the prop is absent.
 *   2. `MarketSnapshotPanel` is now rendered inside the same scroll
 *      container as the editor, fed by the live `useMarketSnapshot`
 *      hook (5 s polling matched to the upstream cache TTL).
 *   3. `onAnyChange` + a `validationError` slot now match the
 *      `HumanInputDialog` invocation 1:1 — strict mirror so the trade
 *      editor surface looks and behaves the same in both places.
 *
 * When the user clicks the colored CTA, the dialog stages a structured
 * `{ action: "create_order", parameters, preApproved: true }` payload on
 * the chat composer's ref and triggers the standard send path with the
 * deterministic NL preview as the transcript message. The server's CEX
 * workflow handler honors the `preApproved` flag inside
 * `requestParameterReview`, skipping the `human_input_required` emit
 * while still running risk gating, dep-health, idempotency, per-symbol
 * lock, and quote-freshness recheck.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    TradingOrderEditor,
    type TradingOrderAccountSnapshot,
} from "./TradingOrderEditor";
import { MarketSnapshotPanel } from "./MarketSnapshotPanel";
import { parseOrderConfiguration } from "./OrderConfigSummaryCard";
import { useTradingPreferences } from "@/hooks/useTradingPreferences";
import { useMarketSnapshot } from "@/hooks/useMarketSnapshot";

// TradingOrderEditor stores variant + nested fields inside the
// `order_configuration` JSON-string. Defaults seed an empty
// limit_limit_gtc shape so the editor renders the Limit subtab + BUY
// side; values typed into Price/Amount mutate the JSON in place.
const DEFAULT_VALUES: Record<string, string> = {
    side: "BUY",
    product_id: "BTC-USDT",
    order_configuration: JSON.stringify({
        limit_limit_gtc: { base_size: "", limit_price: "" },
    }),
};

function asStr(v: unknown): string {
    return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

interface ResolvedConfig {
    variant: string;
    base: string;
    quote: string;
    limit: string;
    stop: string;
    stopDirection: string;
    endTime: string;
    postOnly: boolean;
}

function resolveConfig(values: Record<string, string>): ResolvedConfig {
    const parsed = parseOrderConfiguration(values.order_configuration);
    const inner = (parsed?.inner ?? {}) as Record<string, unknown>;
    return {
        variant: parsed?.variantKey ?? "limit_limit_gtc",
        base: asStr(inner.base_size).trim(),
        quote: asStr(inner.quote_size).trim(),
        limit: asStr(inner.limit_price).trim(),
        stop: asStr(inner.stop_price).trim(),
        stopDirection: asStr(inner.stop_direction).trim(),
        endTime: asStr(inner.end_time).trim(),
        postOnly: inner.post_only === true || inner.post_only === "true",
    };
}

/**
 * Translate the form values into the canonical `create_order` params
 * the server expects. Mirrors the structure of the create-order action
 * input (order_configuration variant key → nested field bag). The
 * server still passes this through the canonical-intent validators
 * (stop_limit price pair, GTD end_time, post_only / limit invariant,
 * margin_action with margin_type), so any malformed combo is caught
 * before risk runs.
 */
function valuesToComposedParams(
    values: Record<string, string>,
    venue: string | null | undefined,
    mode: string | undefined,
): Record<string, unknown> {
    const cfg = resolveConfig(values);
    const variantFields: Record<string, unknown> = {};
    if (cfg.base) variantFields.base_size = cfg.base;
    if (cfg.quote && !cfg.base) variantFields.quote_size = cfg.quote;
    if (cfg.limit && !cfg.variant.startsWith("market_")) variantFields.limit_price = cfg.limit;
    if (cfg.stop && cfg.variant.includes("stop_limit")) variantFields.stop_price = cfg.stop;
    if (cfg.stopDirection && cfg.variant.includes("stop_limit")) {
        variantFields.stop_direction = cfg.stopDirection;
    }
    if (cfg.endTime && cfg.variant.endsWith("_gtd")) variantFields.end_time = cfg.endTime;
    if (cfg.postOnly && cfg.variant === "limit_limit_gtc") variantFields.post_only = true;

    const params: Record<string, unknown> = {
        exchange: venue || "binance",
        product_id: values.product_id || "BTC-USDT",
        side: (values.side || "BUY").toUpperCase(),
        order_configuration: { [cfg.variant]: variantFields },
        client_order_id: `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    if (mode && mode !== "live") params.mode = mode;
    if (values.margin_type) {
        params.margin_type = values.margin_type;
        if (values.margin_action) params.margin_action = values.margin_action;
        if (values.leverage) params.leverage = values.leverage;
    }
    return params;
}

/**
 * Build the deterministic NL message that lands in the chat transcript
 * as the user's "send" — the structured composed payload bypasses the
 * LLM on the server, but the NL string is still useful in the
 * transcript for human review and replay.
 */
function valuesToPrompt(
    values: Record<string, string>,
    venue: string | null | undefined,
    mode: string | undefined,
): string {
    const side = (values.side || "BUY").toLowerCase();
    const pair = values.product_id || "BTC-USDT";
    const sym = pair.replace("-", "/");
    const venueLabel = venue || "binance";
    const cfg = resolveConfig(values);

    const parts: string[] = [];
    if (mode && mode !== "live") parts.push(`${mode} mode:`);

    if (cfg.variant.startsWith("market_")) {
        parts.push(`${side} market`);
    } else if (cfg.variant.includes("stop_limit")) {
        parts.push(`stop-limit ${side}`);
    } else {
        parts.push(`limit ${side}`);
    }

    if (cfg.base) parts.push(`${cfg.base} ${pair.split("-")[0]}`);
    else if (cfg.quote) parts.push(`${cfg.quote} ${pair.split("-")[1]}`);

    parts.push(`on ${venueLabel}`);
    parts.push(`(${sym})`);

    if (cfg.stop) parts.push(`stop ${cfg.stop}`);
    if (cfg.limit) parts.push(`at ${cfg.limit}`);

    const tif = cfg.variant.endsWith("_gtc") ? "GTC"
        : cfg.variant.endsWith("_ioc") ? "IOC"
        : cfg.variant.endsWith("_fok") ? "FOK"
        : cfg.variant.endsWith("_gtd") ? "GTD" : null;
    if (tif) parts.push(tif);
    if (cfg.endTime && tif === "GTD") parts.push(`end_time=${cfg.endTime}`);
    if (cfg.postOnly && cfg.variant === "limit_limit_gtc") parts.push("post-only");

    if (values.margin_type) {
        parts.push(`${values.margin_type.toLowerCase()} margin`);
        if (values.leverage) parts.push(`${values.leverage}x leverage`);
        if (values.margin_action && values.margin_action !== "NORMAL") {
            parts.push(values.margin_action.replace(/_/g, " ").toLowerCase());
        }
    }

    return parts.join(" ");
}

// Side-colored CTA styling, mirrored from HumanInputDialog so the
// compose dialog and the legacy approval modal stay visually identical.
function sideToButtonClass(side: "BUY" | "SELL" | null): string {
    if (side === "SELL") {
        return "bg-rose-500 text-white hover:bg-rose-400 shadow-[0_4px_20px_-4px_rgba(244,63,94,0.45)]";
    }
    return "bg-emerald-500 text-white hover:bg-emerald-400 shadow-[0_4px_20px_-4px_rgba(16,185,129,0.45)]";
}

export interface ManualComposeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Default exchange to render the order against. */
    venue?: string | null;
    /** Pre-fetched balance + base/quote asset for the active pair. */
    accountSnapshot?: TradingOrderAccountSnapshot | null;
    /**
     * Agent id forwarded to `TradingOrderEditor` so the snapshot +
     * products refresh routes can authenticate. Without it the editor
     * still functions but the Pair combobox stays empty and balances
     * are only as fresh as the seed `accountSnapshot`.
     */
    agentId?: string | null;
    /**
     * Called when the user ticks "I confirm…" and clicks Confirm
     * BUY / Confirm SELL. Receives the NL summary (rendered in the
     * chat transcript) and the structured payload (with
     * `preApproved: true`) that the chat composer stages on its ref
     * and submits via the standard send path.
     */
    onConfirm: (
        prompt: string,
        composed: {
            action: string;
            parameters: Record<string, unknown>;
            preApproved: true;
        },
    ) => void;
}

export function ManualComposeDialog({
    open,
    onOpenChange,
    venue,
    accountSnapshot,
    agentId,
    onConfirm,
}: ManualComposeDialogProps) {
    const [values, setValues] = useState<Record<string, string>>(DEFAULT_VALUES);
    const [agreed, setAgreed] = useState(false);
    // F10.3 — validationError state mirrors HumanInputDialog's
    // `setValidationError(null)` wiring on every editor change. Today
    // no compose-side validator surfaces a string, but the wiring
    // keeps the editor invocation strictly identical to the approval
    // modal so future cross-modal validation lands in one spot.
    const [validationError, setValidationError] = useState<string | null>(null);
    // F10.5 — per-dialog venue override. Lets the user flip between
    // Binance and Coinbase without leaving Settings; reset on dialog
    // open. The full resolution chain is:
    //   1. user's in-dialog selection (`venueOverride`)
    //   2. caller's `venue` prop
    //   3. user's `preferred_exchange` from trading prefs
    //   4. hard fallback "binance"
    const [venueOverride, setVenueOverride] = useState<string | null>(null);
    const prefs = useTradingPreferences();
    const mode = prefs.data?.default_mode;
    // F10.3 — derive venue from prefs when the call site omits the
    // prop. This is the load-bearing fix for the percent slider:
    // without a venue, `TradingOrderEditor`'s snapshot-refresh effect
    // short-circuits on `if (!agentId || !venue) return`, the
    // `liveSnapshot` never matches the current pair, `derivedPct`
    // returns `null`, and `applyPercent` returns early so drag is
    // inert.
    const venueResolved =
        venueOverride ?? venue ?? prefs.data?.preferred_exchange ?? "binance";

    useEffect(() => {
        if (open) {
            // Reset to defaults each time the dialog opens.
            setValues({ ...DEFAULT_VALUES });
            setAgreed(false);
            setValidationError(null);
            setVenueOverride(null);
        }
    }, [open]);

    const canSubmit = useMemo(() => {
        if (!values.product_id || !values.side) return false;
        // `TradingOrderEditor` exposes a hidden marker for blocking
        // validation errors (missing Price, sub-min notional, etc.); honor
        // it so the user can't bypass the inline errors via this dialog.
        if (values.__editor_blocking === "1") return false;
        const cfg = resolveConfig(values);
        return Boolean(cfg.base) || Boolean(cfg.quote);
    }, [values]);

    const resolvedSide: "BUY" | "SELL" | null = useMemo(() => {
        const s = (values.side || "").trim().toUpperCase();
        return s === "BUY" || s === "SELL" ? s : null;
    }, [values.side]);

    // F10.3 — live market snapshot polling. Mirrors the approval-modal
    // panel 1:1; the same hook feeds both surfaces with a 5 s cadence
    // matched to the upstream Binance/Coinbase per-process cache TTL.
    const cfgForSnapshot = useMemo(() => resolveConfig(values), [values]);
    const snapshotQuery = useMarketSnapshot({
        agentId: agentId ?? null,
        symbol: values.product_id ?? "",
        venue: venueResolved,
        side: resolvedSide ?? undefined,
        limit_price: cfgForSnapshot.limit || undefined,
        action_name: "create_order",
        enabled: open,
    });

    // F10.3 + F10.5 — strict mirror with HumanInputDialog's safety gate
    // at [:968-969], BUT with the same "no user assets to verify
    // against" exception we apply to the visual banner. The compose
    // dialog ALWAYS passes promptText: "" to the market-snapshot
    // endpoint, so the server's `buildSymbolVerification` returns
    // `matches: false` with `reason: "no_user_assets_mentioned"` —
    // that's not a real mismatch, it's just "nothing to compare
    // against." Without this exception, every compose-dialog session
    // would have a permanently-disabled Confirm BUY/SELL button. The
    // load-bearing case (LLM extracted a symbol that disagrees with
    // user-mentioned assets — `reason ===
    // "extractor_symbol_missing_user_assets"`) still blocks here.
    const symbolVerification = snapshotQuery.data?.symbol_verification;
    const symbolMismatch =
        symbolVerification?.matches === false &&
        symbolVerification.reason !== "no_user_assets_mentioned";

    if (!open) return null;

    const ctaLabel = resolvedSide === "SELL" ? "Confirm SELL" : "Confirm BUY";

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
            data-testid="manual-compose-dialog"
        >
            <button
                type="button"
                aria-label="Close compose trade dialog"
                onClick={() => onOpenChange(false)}
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <div
                className="relative z-10 w-full sm:max-w-3xl flex flex-col pointer-events-auto sm:rounded-2xl rounded-t-2xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200 ease-out"
                style={{
                    background: "linear-gradient(180deg,#181a23 0%,#12141c 100%)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    boxShadow: "0 -4px 40px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.04)",
                }}
            >
                <div className="sm:hidden flex justify-center pt-3 pb-1">
                    <div className="w-10 h-1 rounded-full bg-white/15" />
                </div>
                <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <span className="text-[11px] text-amber-300/85 font-medium tracking-wide">
                        CONFIRM
                    </span>
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        className="w-7 h-7 rounded-full flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/8 transition-colors"
                        aria-label="Close"
                    >
                        <X className="size-4" />
                    </button>
                </div>

                <div className="px-5 pb-3">
                    <h2 className="text-base font-semibold tracking-tight text-white">
                        Compose &amp; Authorize Order
                    </h2>
                    <p className="text-xs text-white/35 mt-0.5">
                        Edit any parameter, check the box, and submit to execute.
                    </p>
                </div>

                <div className="px-5 pb-3 flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-300">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        Create Order
                    </span>
                    {/* F10.5 — venue selector. Two-chip toggle (Binance
                        / Coinbase) because the EXCHANGE_REGISTRY only
                        registers those two venues today. Mirrors the
                        SideToggle pattern from `TradingOrderEditor`.
                        Switching here updates `venueResolved` which is
                        threaded into `TradingOrderEditor`, the live
                        market snapshot hook, and the composed-payload
                        builder, so the editor's balance row + snapshot
                        panel both re-fetch automatically. */}
                    <div
                        className="inline-flex rounded-md overflow-hidden border border-white/10"
                        data-testid="compose-venue-toggle"
                    >
                        {(["binance", "coinbase"] as const).map((v) => {
                            const active = venueResolved === v;
                            return (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => setVenueOverride(v)}
                                    data-testid={`compose-venue-${v}`}
                                    aria-pressed={active}
                                    className={cn(
                                        "px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                                        active
                                            ? v === "binance"
                                                ? "bg-yellow-500/15 text-yellow-300"
                                                : "bg-blue-500/15 text-blue-300"
                                            : "bg-white/5 text-white/50 hover:bg-white/8",
                                    )}
                                >
                                    {v}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="h-px bg-white/5 mx-5" />

                <div className="px-5 py-3">
                    <div className="max-h-[60vh] overflow-y-auto pr-1">
                        <TradingOrderEditor
                            values={values}
                            setValues={(updater) => {
                                // F10.5 — diagnostic gate. When the
                                // localStorage flag is set, log every
                                // state transition that mutates
                                // `limit_price` so we can pinpoint the
                                // slider→Price-bug's actual write site
                                // (static analysis ruled out the
                                // obvious suspects). No-op when the
                                // flag is absent. Remove in a
                                // follow-up once root cause is known.
                                if (
                                    typeof window !== "undefined" &&
                                    window.localStorage?.getItem("SENTI_DEBUG_TRADE_EDITOR")
                                ) {
                                    const prevInner = (parseOrderConfiguration(
                                        values.order_configuration,
                                    )?.inner ?? {}) as Record<string, unknown>;
                                    const nextValues =
                                        typeof updater === "function"
                                            ? (updater as (
                                                  v: Record<string, string>,
                                              ) => Record<string, string>)(values)
                                            : updater;
                                    const nextInner = (parseOrderConfiguration(
                                        nextValues.order_configuration,
                                    )?.inner ?? {}) as Record<string, unknown>;
                                    if (prevInner.limit_price !== nextInner.limit_price) {
                                        // eslint-disable-next-line no-console
                                        console.error(
                                            "[compose] limit_price changed",
                                            {
                                                from: prevInner.limit_price,
                                                to: nextInner.limit_price,
                                                changedKeys: Object.keys({
                                                    ...prevInner,
                                                    ...nextInner,
                                                }).filter(
                                                    (k) =>
                                                        prevInner[k] !== nextInner[k],
                                                ),
                                                trace: new Error(
                                                    "limit_price-mutation",
                                                ).stack,
                                            },
                                        );
                                    }
                                }
                                setValidationError(null);
                                setValues(updater);
                            }}
                            onAnyChange={() => setValidationError(null)}
                            venue={venueResolved}
                            accountSnapshot={accountSnapshot}
                            agentId={agentId ?? null}
                        />
                        {/* F10.3 — live MARKET SNAPSHOT panel, strict
                            1:1 mirror of the HumanInputDialog
                            invocation at [:808-816]. Polls every 5 s
                            via `useMarketSnapshot` so bid / ask /
                            spread / 24 h stats / depth / est-fill /
                            slippage stay live while the user is
                            composing. The panel itself renders
                            nothing when `snapshot` is undefined, so
                            no flicker before the first poll resolves. */}
                        <MarketSnapshotPanel
                            snapshot={snapshotQuery.data?.market_snapshot}
                            verification={snapshotQuery.data?.symbol_verification}
                            venue={venueResolved}
                        />
                    </div>
                </div>
                {validationError ? (
                    <div className="px-5 pb-2 -mt-2">
                        <div className="text-[12px] text-rose-300/90 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                            {validationError}
                        </div>
                    </div>
                ) : null}

                <div className="mx-5 mt-2 mb-1">
                    <button
                        type="button"
                        onClick={() => setAgreed((v) => !v)}
                        aria-pressed={agreed}
                        className="w-full flex items-start gap-3 cursor-pointer select-none p-3 rounded-xl hover:bg-white/3 transition-colors text-left"
                    >
                        <span
                            aria-hidden="true"
                            className={cn(
                                "mt-0.5 rounded-md border-2 flex-shrink-0 flex items-center justify-center transition-all duration-150",
                                agreed ? "bg-amber-400 border-amber-400" : "border-white/20 hover:border-white/40",
                            )}
                            style={{ width: 18, height: 18 }}
                            data-testid="compose-confirm-checkbox"
                        >
                            {agreed ? <Check className="size-2.5 text-black" strokeWidth={3} /> : null}
                        </span>
                        <span className="text-[12px] text-white/45 leading-relaxed">
                            I confirm these inputs are correct and authorize this action.
                        </span>
                    </button>
                </div>

                <div className="h-px bg-white/5 mx-5 mt-2" />

                <div className="px-5 py-4 flex gap-3 flex-wrap">
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl flex-1 text-sm font-medium text-white/40 bg-white/5 border border-white/8 hover:bg-white/8 hover:text-white/60 transition-all duration-150"
                    >
                        <X className="size-3.5" />
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!agreed || !canSubmit || symbolMismatch}
                        data-testid="compose-confirm-submit"
                        onClick={() => {
                            const composed = {
                                action: "create_order" as const,
                                parameters: valuesToComposedParams(values, venueResolved, mode),
                                preApproved: true as const,
                            };
                            const prompt = valuesToPrompt(values, venueResolved, mode);
                            onConfirm(prompt, composed);
                            onOpenChange(false);
                        }}
                        className={cn(
                            "flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl flex-[2] text-sm font-semibold transition-all duration-150",
                            agreed && canSubmit && !symbolMismatch
                                ? sideToButtonClass(resolvedSide)
                                : "bg-white/5 text-white/20 cursor-not-allowed",
                        )}
                    >
                        <CheckCircle2 className="size-4" />
                        <span>{ctaLabel}</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
