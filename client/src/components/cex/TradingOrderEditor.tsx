import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Percent } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    displayPair,
    parseOrderConfiguration,
} from "./OrderConfigSummaryCard";
import { apiClient } from "@/lib/api";
import { DatetimeCalendarField } from "../ui/datetime-calendar-field";

/**
 * Price-bearing fields inside `order_configuration` that are tied to a
 * specific pair's market. When the user changes Pair we drop these so
 * a BTC-price (e.g. 62000) can never survive a switch to ETH-USDT.
 * Sizes too — base_size + quote_size were computed against the old
 * pair's price and don't carry meaning post-switch.
 */
const PAIR_DEPENDENT_INNER_KEYS = [
    "limit_price",
    "stop_price",
    "above_limit_price",
    "below_stop_price",
    "below_limit_price",
    "take_profit_price",
    "stop_loss_price",
    "base_size",
    "quote_size",
] as const;

// ---------------------------------------------------------------------------
// Variant <-> subtab mapping
// ---------------------------------------------------------------------------

type Subtab = "Limit" | "Market" | "Stop Limit";

/** Three classical subtabs match Binance's own dropdown. Exotic variants
 *  (OCO, Trailing, Trigger Bracket) collapse to "Stop Limit". */
function variantToSubtab(variantKey: string): Subtab {
    if (variantKey.startsWith("market_")) return "Market";
    if (variantKey.startsWith("limit_") || variantKey === "sor_limit_ioc") {
        return "Limit";
    }
    return "Stop Limit";
}

/**
 * Stop Limit subtab nested variants (Binance's "Stop Limit ▾" dropdown).
 * Each maps to a canonical order-configuration variant key.
 */
type StopVariant = "Stop Limit" | "Trailing Stop" | "OCO";

const STOP_VARIANT_TO_KEY: Record<StopVariant, string> = {
    "Stop Limit": "stop_limit_stop_limit_gtc",
    "Trailing Stop": "trailing_stop_limit_gtc",
    OCO: "oco_gtc",
};

function variantKeyToStopVariant(variantKey: string): StopVariant {
    if (variantKey === "trailing_stop_limit_gtc") return "Trailing Stop";
    if (variantKey === "oco_gtc") return "OCO";
    return "Stop Limit";
}

const VARIANT_TEMPLATES: Record<string, Record<string, string>> = {
    limit_limit_gtc: { base_size: "", limit_price: "" },
    limit_limit_gtd: { base_size: "", limit_price: "", end_time: "" },
    sor_limit_ioc: { base_size: "", limit_price: "" },
    limit_limit_fok: { base_size: "", limit_price: "" },
    market_market_ioc: { quote_size: "" },
    market_market_fok: { quote_size: "" },
    stop_limit_stop_limit_gtc: {
        base_size: "",
        limit_price: "",
        stop_price: "",
        // stop_direction is filled in dynamically from `values.side` so a
        // BUY stop-limit gets STOP_UP (breakout) and a SELL gets STOP_DOWN
        // (stop-loss). See `inferStopDirectionFromSide`.
    },
    trailing_stop_limit_gtc: {
        base_size: "",
        trailing_delta_bps: "100",
        limit_price: "",
    },
    oco_gtc: {
        base_size: "",
        above_limit_price: "",
        below_stop_price: "",
        below_limit_price: "",
        below_time_in_force: "GTC",
    },
    trigger_bracket_gtc: {
        base_size: "",
        limit_price: "",
        // TP/SL legs are part of the bracket; we store them in inner too.
        // Custom keys our schema understands: take_profit_price + stop_loss_price.
        take_profit_price: "",
        stop_loss_price: "",
    },
};

/**
 * Per-variant allow-list of inner keys. Used by `swapVariant` to STRIP
 * keys that belong to the OLD variant but aren't valid on the new one
 * (e.g. `post_only` on Market, `iceberg_qty` on bracket, `quote_size`
 * on Limit). Without this, the carry-over preserves the previous
 * variant's fields and ships them to the venue — Binance then rejects
 * with cryptic errors like "post_only is only valid with limit /
 * stop_limit".
 */
const VARIANT_ALLOWED_KEYS: Record<string, ReadonlySet<string>> = {
    limit_limit_gtc: new Set([
        "base_size", "limit_price", "post_only", "iceberg_qty",
    ]),
    limit_limit_gtd: new Set([
        "base_size", "limit_price", "end_time", "post_only", "iceberg_qty",
    ]),
    sor_limit_ioc: new Set(["base_size", "limit_price"]),
    limit_limit_fok: new Set(["base_size", "limit_price"]),
    market_market_ioc: new Set(["quote_size", "base_size"]),
    market_market_fok: new Set(["quote_size", "base_size"]),
    stop_limit_stop_limit_gtc: new Set([
        "base_size", "limit_price", "stop_price", "stop_direction",
    ]),
    trailing_stop_limit_gtc: new Set([
        "base_size", "limit_price", "trailing_delta_bps", "trailing_activation_price",
    ]),
    oco_gtc: new Set([
        "base_size", "above_limit_price",
        "below_stop_price", "below_limit_price", "below_time_in_force",
    ]),
    trigger_bracket_gtc: new Set([
        "base_size", "limit_price", "take_profit_price", "stop_loss_price",
    ]),
};

/**
 * Initial stop_direction for stop-limit orders, derived from the side.
 * BUY stop-limit is a breakout — trigger when price RISES above
 * stop_price (STOP_UP). SELL stop-limit is a stop-loss — trigger when
 * price FALLS below stop_price (STOP_DOWN).
 *
 * The user can still override via the editor's stop-direction toggle;
 * this only sets the default when entering Stop Limit / when side flips.
 */
function inferStopDirectionFromSide(side: string): "STOP_DIRECTION_STOP_UP" | "STOP_DIRECTION_STOP_DOWN" {
    return side?.toUpperCase() === "BUY"
        ? "STOP_DIRECTION_STOP_UP"
        : "STOP_DIRECTION_STOP_DOWN";
}

function subtabToDefaultVariantKey(subtab: Subtab, currentTif: string): string {
    if (subtab === "Market") return currentTif === "FOK" ? "market_market_fok" : "market_market_ioc";
    if (subtab === "Stop Limit") return "stop_limit_stop_limit_gtc";
    if (currentTif === "GTD") return "limit_limit_gtd";
    if (currentTif === "IOC") return "sor_limit_ioc";
    if (currentTif === "FOK") return "limit_limit_fok";
    return "limit_limit_gtc";
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function readConfig(raw: string): { variantKey: string; inner: Record<string, unknown> } | null {
    try {
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
        const entries = Object.entries(parsed ?? {});
        if (entries.length !== 1) return null;
        const [variantKey, inner] = entries[0];
        return { variantKey, inner: inner ?? {} };
    } catch {
        return null;
    }
}

function stringifyConfig(variantKey: string, inner: Record<string, unknown>): string {
    return JSON.stringify({ [variantKey]: inner });
}

function patchInnerJson(currentRaw: string, key: string, value: string | boolean | undefined): string {
    const cur = readConfig(currentRaw);
    if (!cur) {
        const seed: Record<string, unknown> = value === undefined ? {} : { [key]: value };
        return stringifyConfig("limit_limit_gtc", seed);
    }
    const nextInner = { ...cur.inner };
    if (value === undefined) {
        delete nextInner[key];
    } else {
        nextInner[key] = value;
    }
    return stringifyConfig(cur.variantKey, nextInner);
}

function swapVariant(
    currentRaw: string,
    newVariantKey: string,
    /** Side ("BUY"/"SELL") drives stop_direction default for stop-limit. */
    side?: string,
): string {
    const cur = readConfig(currentRaw);
    const template: Record<string, unknown> = { ...(VARIANT_TEMPLATES[newVariantKey] ?? {}) };
    // Inject side-aware stop_direction default when entering a stop-limit
    // variant (covers both subtab-default + Stop-Limit nested swaps).
    if (newVariantKey === "stop_limit_stop_limit_gtc") {
        template.stop_direction = inferStopDirectionFromSide(side ?? "");
    }
    const allowed = VARIANT_ALLOWED_KEYS[newVariantKey];
    const preserved: Record<string, unknown> = {};
    if (cur && allowed) {
        const keysToCarry = [
            "base_size",
            "quote_size",
            "limit_price",
            "stop_price",
            "stop_direction",
            "iceberg_qty",
            "post_only",
            "end_time",
            "above_limit_price",
            "below_stop_price",
            "below_limit_price",
            "trailing_delta_bps",
            "trailing_activation_price",
            "take_profit_price",
            "stop_loss_price",
        ];
        for (const k of keysToCarry) {
            if (!allowed.has(k)) continue;
            const v = cur.inner[k];
            if (v !== undefined && v !== "" && v !== null) {
                preserved[k] = v;
            }
        }
    }
    return stringifyConfig(newVariantKey, { ...template, ...preserved });
}

function asString(v: unknown): string {
    if (v === null || v === undefined) return "";
    return typeof v === "string" ? v : String(v);
}

function safeNum(s: string): number | null {
    // F10.8 — defensively strip thousands separators before parseFloat.
    // formatBalance below no longer emits commas, but the input fields
    // are free-text so a user can paste "1,000.50" or type a comma by
    // habit. Without this strip, parseFloat("1,000.50") returns 1 (it
    // halts at the first comma), silently misreading every downstream
    // computation (Amount ↔ Total bidirectional sync, derivedPct, etc).
    const cleaned = typeof s === "string" ? s.replace(/,/g, "") : s;
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
}

function formatBalance(value: number, frac = 8): string {
    // F10.8 — useGrouping: false → DO NOT emit thousands separators.
    // The returned string is written into `order_configuration` JSON
    // via `patchOrderConfig` AND displayed in form inputs. Commas
    // anywhere along that path cause two breakages:
    //   1. The next-render parse via `safeNum` (Number.parseFloat)
    //      truncates at the first comma — `parseFloat("53,072,084.69")
    //      === 5` — silently corrupting Amount→Total derivation and
    //      the slider's derivedPct.
    //   2. The API payload (composed `create_order` parameters) leaks
    //      commas to the server's canonical-intent validator, which
    //      rejects non-numeric characters in size/price fields.
    // We trade visible thousands-separators for correctness; very
    // large numbers are now displayed as plain decimals (e.g.
    // "53072084.6892009"). Acceptable since the typical Amount on
    // crypto orders is < 100, and only edge cases (sub-penny tokens
    // like SHIB) produce values where commas would have been useful.
    return value.toLocaleString("en-US", {
        maximumFractionDigits: frac,
        minimumFractionDigits: 0,
        useGrouping: false,
    });
}

/**
 * Derive the canonical TIF from the variant key suffix.
 * - *_gtc → GTC
 * - *_gtd → GTD
 * - *_ioc → IOC
 * - *_fok → FOK
 */
function variantKeyToTif(variantKey: string): string {
    if (variantKey.endsWith("_gtd")) return "GTD";
    if (variantKey.endsWith("_ioc")) return "IOC";
    if (variantKey.endsWith("_fok")) return "FOK";
    return "GTC";
}

/**
 * For a given subtab + new TIF, produce the matching variant key.
 * Subtabs only support a subset of TIFs each.
 */
function applyTifToVariant(variantKey: string, newTif: string): string {
    const sub = variantToSubtab(variantKey);
    if (sub === "Limit") {
        if (newTif === "GTD") return "limit_limit_gtd";
        if (newTif === "IOC") return "sor_limit_ioc";
        if (newTif === "FOK") return "limit_limit_fok";
        return "limit_limit_gtc";
    }
    if (sub === "Market") {
        if (newTif === "FOK") return "market_market_fok";
        return "market_market_ioc";
    }
    // Stop Limit (and its nested variants) — only GTC supported in our schema today.
    return variantKey;
}

/**
 * TIFs offered per subtab + venue. Binance Spot Limit supports IOC/FOK but
 * not GTD; Coinbase Advanced Trade Limit supports GTD but not IOC/FOK.
 */
function tifsForSubtab(sub: Subtab, venue?: string | null): string[] {
    if (sub === "Limit") {
        const v = (venue ?? "").toLowerCase();
        if (v === "coinbase") return ["GTC", "GTD"];
        // Binance + unknown venue: Binance-style triplet.
        return ["GTC", "IOC", "FOK"];
    }
    if (sub === "Market") return ["IOC", "FOK"];
    return ["GTC"];
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

const TabStrip: React.FC<{
    tabs: ReadonlyArray<string>;
    active: string;
    onChange: (tab: string) => void;
    size?: "lg" | "sm";
    rightSlot?: React.ReactNode;
}> = ({ tabs, active, onChange, size = "lg", rightSlot }) => (
    <div
        className={cn(
            "flex items-center justify-between border-b border-white/5",
            size === "lg" ? "px-5 pt-3" : "px-5 pt-2",
        )}
    >
        <div className={cn("flex items-center", size === "lg" ? "gap-5" : "gap-4")}>
            {tabs.map((label) => {
                const isActive = label === active;
                return (
                    <button
                        key={label}
                        type="button"
                        onClick={() => onChange(label)}
                        className={cn(
                            "relative pb-2 transition-colors duration-150 outline-none",
                            size === "lg" ? "text-[13px]" : "text-[12px]",
                            isActive
                                ? "text-white font-semibold"
                                : "text-white/40 hover:text-white/70 cursor-pointer",
                        )}
                    >
                        {label}
                        {isActive ? (
                            <span className="absolute -bottom-px left-0 right-0 h-[2px] bg-amber-400 rounded-full" />
                        ) : null}
                    </button>
                );
            })}
        </div>
        {rightSlot ? <div className="pb-2">{rightSlot}</div> : null}
    </div>
);

const SideToggle: React.FC<{ side: string; onChange: (s: "BUY" | "SELL") => void }> = ({
    side,
    onChange,
}) => {
    const upper = side?.toUpperCase();
    const isBuy = upper === "BUY";
    const isSell = upper === "SELL";
    return (
        <div className="grid grid-cols-2 gap-2 px-5 pt-3">
            <button
                type="button"
                onClick={() => onChange("BUY")}
                className={cn(
                    "py-2 rounded-md text-[13px] font-semibold transition-colors",
                    isBuy
                        ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40"
                        : "bg-white/5 text-white/50 hover:bg-white/8",
                )}
            >
                BUY
            </button>
            <button
                type="button"
                onClick={() => onChange("SELL")}
                className={cn(
                    "py-2 rounded-md text-[13px] font-semibold transition-colors",
                    isSell
                        ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/40"
                        : "bg-white/5 text-white/50 hover:bg-white/8",
                )}
            >
                SELL
            </button>
        </div>
    );
};

const MarginActionRow: React.FC<{
    marginAction: string;
    onChange: (a: "NORMAL" | "AUTO_BORROW" | "AUTO_REPAY") => void;
}> = ({ marginAction, onChange }) => {
    const options = [
        { label: "Normal", value: "NORMAL" as const },
        { label: "Borrow", value: "AUTO_BORROW" as const },
        { label: "Repay", value: "AUTO_REPAY" as const },
    ];
    return (
        <div className="px-5 pt-3 flex items-center gap-2">
            {options.map((opt) => {
                const isActive =
                    opt.value === marginAction ||
                    (opt.value === "NORMAL" && !marginAction);
                return (
                    <button
                        key={opt.value}
                        type="button"
                        onClick={() => onChange(opt.value)}
                        className={cn(
                            "px-3 py-1 rounded text-[11px] font-medium transition-colors",
                            isActive
                                ? opt.value === "AUTO_BORROW"
                                    ? "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30"
                                    : opt.value === "AUTO_REPAY"
                                      ? "bg-blue-500/15 text-blue-200 ring-1 ring-blue-400/30"
                                      : "bg-white/10 text-white/85 ring-1 ring-white/15"
                                : "text-white/35 hover:text-white/55",
                        )}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
};

/**
 * Field block — label-left, value-right input, unit-far-right. Used for
 * Pair / Price / Amount / Stop / Total / Iceberg / TP / SL fields.
 *
 * `inputMode` defaults to `"decimal"` for the numeric fields. Callers
 * that render a non-numeric value (e.g. Pair = "ETH-USDT") must pass
 * `inputMode="text"` so iOS/Android show the alphanumeric keypad
 * instead of the numeric one — otherwise mobile users literally cannot
 * type letters or `-` to change the pair.
 */
const FieldBlock: React.FC<{
    label: string;
    value: string;
    unit?: string | null;
    placeholder?: string;
    readOnly?: boolean;
    onChange?: (next: string) => void;
    onFocus?: () => void;
    footer?: React.ReactNode;
    accent?: "emerald" | "rose";
    required?: boolean;
    inputMode?: "decimal" | "text";
    align?: "left" | "right";
    /** Inline error message — when present, the field gets a rose border. */
    error?: string | null;
}> = ({
    label,
    value,
    unit,
    placeholder,
    readOnly,
    onChange,
    onFocus,
    footer,
    accent,
    required,
    inputMode = "decimal",
    align = "right",
    error,
}) => {
    const accentBorder = error
        ? "border-rose-400/50"
        : accent === "emerald"
            ? "border-emerald-400/25"
            : accent === "rose"
              ? "border-rose-400/25"
              : "border-white/10";
    return (
        <div className={cn("rounded-lg border bg-[#161a1f] px-3 py-2", accentBorder)}>
            <div className="flex items-center gap-2">
                <span className="text-[11px] text-white/45 font-medium uppercase tracking-wide flex-shrink-0">
                    {label}
                    {required ? <span className="text-amber-400/90 ml-0.5">*</span> : null}
                </span>
                <input
                    type="text"
                    inputMode={inputMode}
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => onChange?.(e.target.value)}
                    onFocus={onFocus}
                    readOnly={readOnly}
                    autoCapitalize={inputMode === "text" ? "characters" : undefined}
                    autoCorrect={inputMode === "text" ? "off" : undefined}
                    spellCheck={inputMode === "text" ? false : undefined}
                    className={cn(
                        "flex-1 min-w-0 bg-transparent border-0 outline-none tabular-nums",
                        align === "right" ? "text-right" : "text-left",
                        "text-[14px] font-mono",
                        accent === "emerald"
                            ? "text-emerald-300"
                            : accent === "rose"
                              ? "text-rose-300"
                              : "text-white/95",
                        readOnly ? "cursor-default" : "focus:text-white",
                    )}
                />
                {unit ? (
                    <span className="text-[11px] text-white/40 font-medium flex-shrink-0 w-12 text-right">
                        {unit}
                    </span>
                ) : null}
            </div>
            {error ? (
                <div className="mt-1 text-[10px] text-rose-300/90">{error}</div>
            ) : footer ? (
                <div className="mt-1 text-[10px] text-white/30">{footer}</div>
            ) : null}
        </div>
    );
};

/**
 * Stop-direction picker. Toggle between STOP_UP (trigger when price
 * rises above stop_price — breakout BUY, sell-into-rebound) and
 * STOP_DOWN (trigger when price falls below — stop-loss SELL,
 * buy-the-dip). Auto-defaults to side-aware direction, but the user
 * can override.
 */
const StopDirectionToggle: React.FC<{
    value: "STOP_DIRECTION_STOP_UP" | "STOP_DIRECTION_STOP_DOWN" | "";
    onChange: (next: "STOP_DIRECTION_STOP_UP" | "STOP_DIRECTION_STOP_DOWN") => void;
}> = ({ value, onChange }) => {
    const opts: Array<{
        v: "STOP_DIRECTION_STOP_UP" | "STOP_DIRECTION_STOP_DOWN";
        label: string;
        hint: string;
    }> = [
        { v: "STOP_DIRECTION_STOP_UP", label: "Trigger on rise", hint: "↑ market crosses stop" },
        { v: "STOP_DIRECTION_STOP_DOWN", label: "Trigger on drop", hint: "↓ market crosses stop" },
    ];
    return (
        <div className="rounded-lg border border-white/10 bg-[#161a1f] px-3 py-2">
            <div className="text-[11px] text-white/45 font-medium uppercase tracking-wide mb-1">
                Stop Direction
            </div>
            <div className="grid grid-cols-2 gap-1.5">
                {opts.map((o) => {
                    const active = value === o.v;
                    return (
                        <button
                            key={o.v}
                            type="button"
                            onClick={() => onChange(o.v)}
                            className={cn(
                                "px-2 py-1.5 rounded text-[11px] font-medium transition-colors text-left",
                                active
                                    ? "bg-amber-400/15 text-amber-200 ring-1 ring-amber-400/40"
                                    : "bg-white/5 text-white/55 hover:bg-white/10 hover:text-white/80",
                            )}
                        >
                            <div>{o.label}</div>
                            <div className="text-[9px] text-white/35 mt-0.5">{o.hint}</div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

const Checkbox: React.FC<{
    checked: boolean;
    label: string;
    onChange: (next: boolean) => void;
}> = ({ checked, label, onChange }) => (
    <button
        type="button"
        onClick={() => onChange(!checked)}
        className="flex items-center gap-2 text-[12px] text-white/65 hover:text-white/85 transition-colors"
    >
        <span
            className={cn(
                "w-3.5 h-3.5 rounded-[3px] ring-1 transition-colors flex items-center justify-center",
                checked ? "bg-amber-400 ring-amber-400" : "bg-transparent ring-white/25",
            )}
        >
            {checked ? <span className="block w-1.5 h-1.5 bg-black/70 rounded-sm" /> : null}
        </span>
        {label}
    </button>
);

const DetailRow: React.FC<{ label: React.ReactNode; value: React.ReactNode }> = ({ label, value }) => (
    <div className="flex items-center justify-between py-1">
        <span className="text-[11px] text-white/45">{label}</span>
        <span className="text-[12px] text-white/85 font-medium">{value}</span>
    </div>
);

/**
 * Compact dropdown (Binance-style). Anchored to its trigger button; opens
 * downward; clicks outside dismiss. Used for the Stop variant picker + TIF.
 */
const Dropdown: React.FC<{
    label: React.ReactNode;
    options: Array<{ label: string; value: string; disabled?: boolean }>;
    value: string;
    onChange: (next: string) => void;
    align?: "left" | "right";
    /** Trigger size: chevron-only ("inline") or pill ("standalone"). */
    style?: "inline" | "standalone";
    /**
     * Open direction. Default `"auto"` measures the trigger's position
     * inside the nearest scrollable ancestor and flips upward when the
     * panel would clip below the viewport / scroll container. Explicit
     * `"up"` / `"down"` overrides for layout-stable callers.
     */
    direction?: "auto" | "up" | "down";
}> = ({
    label,
    options,
    value,
    onChange,
    align = "left",
    style = "standalone",
    direction = "auto",
}) => {
    const [open, setOpen] = useState(false);
    const [resolvedDir, setResolvedDir] = useState<"up" | "down">("down");
    const ref = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [open]);

    // Auto-direction: when opening, measure the trigger's bounding box
    // against the nearest scrollable ancestor and the viewport. Flip
    // upward whenever the panel would overflow the bottom — that is the
    // exact case for the TIF dropdown at the foot of a `max-h-[60vh]
    // overflow-y-auto` modal body, where a downward-opening menu is
    // either clipped or hidden behind the confirm/submit row.
    useEffect(() => {
        if (!open) return;
        if (direction !== "auto") {
            setResolvedDir(direction);
            return;
        }
        const trigger = triggerRef.current;
        if (!trigger) {
            setResolvedDir("down");
            return;
        }
        const triggerRect = trigger.getBoundingClientRect();
        const PANEL_PX = Math.min(8 + options.length * 28, 240);
        const viewportBottom = window.innerHeight;
        let containerBottom = viewportBottom;
        for (
            let el: HTMLElement | null = trigger.parentElement;
            el !== null;
            el = el.parentElement
        ) {
            const style = window.getComputedStyle(el);
            const oy = style.overflowY;
            if (oy === "auto" || oy === "scroll" || oy === "hidden") {
                containerBottom = Math.min(
                    containerBottom,
                    el.getBoundingClientRect().bottom,
                );
                if (oy !== "hidden") break;
            }
        }
        const spaceBelow = containerBottom - triggerRect.bottom;
        const spaceAbove = triggerRect.top;
        setResolvedDir(spaceBelow < PANEL_PX && spaceAbove > spaceBelow ? "up" : "down");
    }, [open, direction, options.length]);

    return (
        <div ref={ref} className="relative inline-block">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    "inline-flex items-center gap-1 text-[12px] outline-none transition-colors",
                    style === "standalone"
                        ? "px-2 py-1 rounded-md bg-white/5 ring-1 ring-white/10 hover:bg-white/10 text-white/80"
                        : "text-white/70 hover:text-white",
                )}
            >
                {label}
                {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
            {open ? (
                <div
                    className={cn(
                        "absolute z-50 min-w-[140px] py-1 rounded-md border border-white/10 bg-[#181a23] shadow-xl",
                        resolvedDir === "up" ? "bottom-full mb-1" : "top-full mt-1",
                        align === "right" ? "right-0" : "left-0",
                    )}
                >
                    {options.map((opt) => (
                        <button
                            key={opt.value}
                            type="button"
                            disabled={opt.disabled}
                            onClick={() => {
                                if (opt.disabled) return;
                                onChange(opt.value);
                                setOpen(false);
                            }}
                            className={cn(
                                "block w-full text-left px-3 py-1.5 text-[12px] transition-colors",
                                opt.disabled
                                    ? "text-white/25 cursor-not-allowed"
                                    : opt.value === value
                                      ? "text-white font-medium"
                                      : "text-white/65 hover:bg-white/5 hover:text-white",
                            )}
                        >
                            {opt.label}
                            {opt.value === value && !opt.disabled ? (
                                <span className="float-right text-white/90">✓</span>
                            ) : null}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
};

/**
 * Trading-fee tier popover. Click the "Fee Level" header button to surface
 * the effective taker / maker rate for the active pair. The panel is
 * portaled to document.body and positioned with fixed coordinates derived
 * from the trigger's bounding rect — this is required because the order
 * editor's outer container uses `overflow-hidden` to clip rounded
 * corners, which otherwise truncates an in-tree absolute popover.
 */
const FEE_POPOVER_WIDTH = 280;

const FeeLevelPopover: React.FC<{
    feeBps: number;
    pair: string;
}> = ({ feeBps, pair }) => {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const updatePos = () => {
            const r = triggerRef.current?.getBoundingClientRect();
            if (!r) return;
            // Right-align the panel under the trigger, but clamp to the
            // viewport so a narrow chat panel doesn't push the panel off
            // the left edge.
            const right = r.right;
            const naturalLeft = right - FEE_POPOVER_WIDTH;
            const left = Math.max(8, Math.min(naturalLeft, window.innerWidth - FEE_POPOVER_WIDTH - 8));
            setPos({ top: r.bottom + 8, left });
        };
        updatePos();
        const onDoc = (e: MouseEvent) => {
            const t = e.target as Node;
            if (triggerRef.current?.contains(t)) return;
            if (panelRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onResize = () => updatePos();
        document.addEventListener("mousedown", onDoc);
        window.addEventListener("resize", onResize);
        window.addEventListener("scroll", onResize, true);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("scroll", onResize, true);
        };
    }, [open]);

    const feePct = (feeBps / 100).toLocaleString("en-US", { maximumFractionDigits: 3 });
    const displaySymbol = pair ? pair.replace("-", "/") : "—";

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white/65 transition-colors"
            >
                <Percent className="size-3" />
                Fee Level
            </button>
            {open && pos
                ? createPortal(
                      <div
                          ref={panelRef}
                          style={{
                              position: "fixed",
                              top: pos.top,
                              left: pos.left,
                              width: FEE_POPOVER_WIDTH,
                              zIndex: 100,
                          }}
                          className="rounded-md border border-white/10 bg-[#181a23] shadow-xl"
                      >
                          <div className="px-4 py-3 border-b border-white/5">
                              <div className="flex items-center justify-between gap-3">
                                  <span className="text-[12px] text-white/55 whitespace-nowrap">
                                      Your Trading Fee Level
                                  </span>
                                  <span className="text-[12px] text-amber-300 font-medium whitespace-nowrap">
                                      Regular User
                                  </span>
                              </div>
                          </div>
                          <div className="px-4 py-3 space-y-2">
                              <div className="text-[13px] text-white font-medium">{displaySymbol}</div>
                              <div className="flex items-center gap-8 pt-1">
                                  <div>
                                      <div className="text-[15px] text-white font-medium tabular-nums">
                                          {feePct}%
                                      </div>
                                      <div className="text-[10px] text-white/45 mt-0.5">Taker</div>
                                  </div>
                                  <div>
                                      <div className="text-[15px] text-white font-medium tabular-nums">
                                          {feePct}%
                                      </div>
                                      <div className="text-[10px] text-white/45 mt-0.5">Maker</div>
                                  </div>
                              </div>
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
};

/**
 * Binance-style percent slider. Continuous drag (0–100) with 25/50/75/100
 * notches as visual references; the thumb reflects the *current* size as
 * a fraction of available balance, so editing Amount or Total directly
 * also moves the thumb. The `value` is the derived percentage — pass null
 * when there's no balance / no input yet (thumb sits at 0%).
 */
const PercentSlider: React.FC<{
    value: number | null;
    onChange: (pct: number) => void;
    /**
     * When set, the slider renders read-only and shows the reason in a
     * subtitle below the track. Used to surface "set Price first" or
     * "refreshing balance" instead of dragging silently with no effect.
     */
    disabledReason?: string | null;
}> = ({ value, onChange, disabledReason }) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);
    const clamped = value === null ? 0 : Math.max(0, Math.min(100, value));
    const disabled = !!disabledReason;

    // F10.7 — Keep a ref pointing at the LATEST onChange (=applyPercent
    // from the parent). The mousemove listener below is installed in a
    // useEffect that only re-runs when `disabled` changes, NOT on every
    // re-render. Without this ref, the listener captures the
    // applyPercent from the render in which the slider became enabled
    // and reuses it for every subsequent drag — including drags that
    // happen AFTER the user has typed a new Price into the field. The
    // stale applyPercent reads stale `orderConfigRaw` (with the old
    // limit_price baked in), and the `patch` call rewrites the whole
    // `order_configuration` JSON, clobbering the user's freshly-typed
    // Price. The ref dance pulls the latest applyPercent on every
    // mousemove without re-binding the global listener.
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    const pctFromClientX = (clientX: number): number => {
        const track = trackRef.current;
        if (!track) return 0;
        const r = track.getBoundingClientRect();
        if (r.width <= 0) return 0;
        const raw = ((clientX - r.left) / r.width) * 100;
        return Math.max(0, Math.min(100, Math.round(raw)));
    };

    useEffect(() => {
        if (disabled) return;
        const onMove = (e: MouseEvent) => {
            if (!draggingRef.current) return;
            onChangeRef.current(pctFromClientX(e.clientX));
        };
        const onUp = () => {
            draggingRef.current = false;
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [disabled]);

    const notches = [0, 25, 50, 75, 100] as const;

    return (
        <div className="px-1 pt-3 pb-4 select-none">
            <div
                ref={trackRef}
                role="slider"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(clamped)}
                aria-disabled={disabled || undefined}
                className={cn(
                    "relative h-6 flex items-center",
                    disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
                )}
                onMouseDown={(e) => {
                    if (disabled) return;
                    draggingRef.current = true;
                    // F10.7 — use the ref so the initial mousedown also
                    // sees the latest applyPercent (the JSX-bound
                    // onChange is fresh per render, but the ref is the
                    // single source of truth across mousedown +
                    // mousemove + future code paths).
                    onChangeRef.current(pctFromClientX(e.clientX));
                }}
            >
                {/* full-width track */}
                <div className="absolute left-0 right-0 h-px bg-white/15" />
                {/* filled portion (0 → thumb) */}
                <div
                    className="absolute left-0 h-px bg-amber-400/70"
                    style={{ width: `${clamped}%` }}
                />
                {/* notches */}
                {notches.map((s) => {
                    const reached = clamped >= s;
                    return (
                        <span
                            key={s}
                            className="absolute -translate-x-1/2 pointer-events-none"
                            style={{ left: `${s}%` }}
                        >
                            <span
                                className={cn(
                                    "block w-2 h-2 rotate-45 transition-colors",
                                    reached ? "bg-amber-400/60" : "bg-white/20",
                                )}
                            />
                            <span className="absolute top-3 left-1/2 -translate-x-1/2 text-[9px] text-white/30">
                                {s}%
                            </span>
                        </span>
                    );
                })}
                {/* draggable thumb (sits on top of notch when aligned) */}
                <span
                    className="absolute -translate-x-1/2 pointer-events-none"
                    style={{ left: `${clamped}%` }}
                >
                    <span className="block w-3 h-3 rotate-45 bg-amber-400 ring-2 ring-amber-400/40" />
                </span>
            </div>
            {disabledReason ? (
                <div className="mt-2 text-[10px] text-amber-300/60 text-center">
                    {disabledReason}
                </div>
            ) : null}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Pair combobox — typed input with venue-product suggestions
// ---------------------------------------------------------------------------

/**
 * Pair input with optional dropdown of tradable products. When `products`
 * is populated, the user gets an autocomplete list filtered to matches.
 * When `products` is null / empty (no venue, products endpoint down,
 * Coinbase Advanced not configured) the input degrades to free-text —
 * the user can still type any pair, the snapshot refetch still fires.
 *
 * Uses `inputMode="text"` so iOS/Android show an alphanumeric keypad —
 * the previous `inputMode="decimal"` on the generic FieldBlock literally
 * prevented mobile users from typing letters or `-`.
 */
const PairFieldBlock: React.FC<{
    value: string;
    onChange: (next: string) => void;
    onFocus?: () => void;
    products: Array<{ product_id: string; base_asset: string; quote_asset: string }> | null;
    error?: string | null;
}> = ({ value, onChange, onFocus, products, error }) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, []);

    // Fix-NEW7 iter4 (post-PR244): when the input has no in-progress
    // user edit (query === null), normalize displayed value to dash
    // form. Backend paths sometimes emit "BTCUSDT" concat form
    // (decomposer/plan path) and sometimes "BTC-USDT" dash form
    // (single-order path); UI consistency requires a single display
    // shape. While the user is typing (query !== null), show their
    // literal keystrokes — don't fight them.
    const displayed = query ?? displayPair(value);
    const filtered = useMemo(() => {
        if (!products) return [];
        const q = displayed.trim().toUpperCase();
        if (!q) return products.slice(0, 25);
        return products.filter((p) => p.product_id.includes(q)).slice(0, 25);
    }, [products, displayed]);

    const commit = (next: string) => {
        const trimmed = next.trim().toUpperCase();
        setQuery(null);
        setOpen(false);
        onChange(trimmed);
    };

    return (
        <div
            ref={rootRef}
            className={cn(
                "relative rounded-lg border bg-[#161a1f] px-3 py-2",
                error ? "border-rose-400/50" : "border-white/10",
            )}
        >
            <div className="flex items-center gap-2">
                <span className="text-[11px] text-white/45 font-medium uppercase tracking-wide flex-shrink-0">
                    Pair<span className="text-amber-400/90 ml-0.5">*</span>
                </span>
                <input
                    ref={inputRef}
                    type="text"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    value={displayed}
                    placeholder="BTC-USDT"
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setOpen(true);
                    }}
                    onFocus={() => {
                        onFocus?.();
                        setOpen(true);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            commit(displayed);
                            inputRef.current?.blur();
                        } else if (e.key === "Escape") {
                            setQuery(null);
                            setOpen(false);
                        }
                    }}
                    onBlur={() => {
                        // Commit on blur even if the user didn't click a suggestion —
                        // matches the old free-text behavior. Slight delay so a click
                        // on a suggestion lands before the commit.
                        setTimeout(() => {
                            if (query !== null) commit(query);
                        }, 100);
                    }}
                    className="flex-1 min-w-0 bg-transparent border-0 outline-none text-right tabular-nums text-[14px] font-mono text-white/95 focus:text-white"
                />
            </div>
            {open && filtered.length > 0 ? (
                <div className="absolute z-30 left-3 right-3 top-full mt-1 max-h-56 overflow-y-auto rounded-md border border-white/10 bg-[#181a23] shadow-xl">
                    {filtered.map((p) => (
                        <button
                            key={p.product_id}
                            type="button"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                commit(p.product_id);
                            }}
                            className={cn(
                                "block w-full text-left px-3 py-1.5 text-[12px] font-mono transition-colors",
                                p.product_id === value.toUpperCase()
                                    ? "text-amber-300"
                                    : "text-white/75 hover:bg-white/5 hover:text-white",
                            )}
                        >
                            {p.product_id}
                        </button>
                    ))}
                </div>
            ) : null}
            {error ? (
                <div className="mt-1 text-[10px] text-rose-300/90">{error}</div>
            ) : null}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface TradingOrderAccountSnapshot {
    baseAvailable: string;
    quoteAvailable: string;
    baseAsset: string;
    quoteAsset: string;
    feeBps?: number;
}

export interface TradingOrderEditorProps {
    values: Record<string, string>;
    setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    onAnyChange?: () => void;
    venue?: string | null;
    /**
     * Server-supplied snapshot for the initial pair. Treated as a seed
     * only — the editor refetches via `/cex/account-snapshot` whenever
     * Pair changes so balance/asset labels never trail behind the
     * user's edit. Pass `null` to disable the Avbl/Max/Fee strip.
     */
    accountSnapshot?: TradingOrderAccountSnapshot | null;
    /**
     * Agent id used to authenticate the snapshot/products refresh
     * calls. Optional — omit it (e.g. in Storybook) and refetch is
     * disabled, in which case the editor still uses the seed snapshot
     * but flags it stale once the user changes Pair.
     */
    agentId?: string | null;
}

export const TradingOrderEditor: React.FC<TradingOrderEditorProps> = ({
    values,
    setValues,
    onAnyChange,
    venue,
    accountSnapshot,
    agentId,
}) => {
    const pair = values.product_id ?? values.symbol ?? "";
    const side = values.side ?? "";
    const sideUpper = side?.toUpperCase();
    const isBuy = sideUpper === "BUY";
    const isSell = sideUpper === "SELL";
    const marginType = values.margin_type ?? "";
    const marginAction = values.margin_action ?? "NORMAL";
    const leverage = values.leverage ?? "";
    const orderConfigRaw = values.order_configuration ?? "";
    const previewId = values.preview_id ?? "";
    const retailPortfolioId = values.retail_portfolio_id ?? "";

    const parsed = useMemo(
        () => parseOrderConfiguration(orderConfigRaw),
        [orderConfigRaw],
    );
    const inner = parsed?.inner ?? {};
    const variantKey = parsed?.variantKey ?? "limit_limit_gtc";
    const limitPrice = asString(inner.limit_price);
    const baseSize = asString(inner.base_size);
    const quoteSize = asString(inner.quote_size);
    const stopPrice = asString(inner.stop_price);
    const endTime = asString(inner.end_time);
    const postOnly = inner.post_only === true || inner.post_only === "true";
    const icebergQty = asString(inner.iceberg_qty);
    const trailingBps = asString(inner.trailing_delta_bps);
    const ocoTpPrice = asString(inner.above_limit_price);
    const ocoSlStop = asString(inner.below_stop_price);
    const ocoSlLimit = asString(inner.below_limit_price);
    const tpPrice = asString(inner.take_profit_price);
    const slPrice = asString(inner.stop_loss_price);

    const displayedPair = displayPair(pair);
    const split = useMemo(() => {
        const idx = displayedPair.indexOf("-");
        if (idx <= 0) return null;
        return {
            base: displayedPair.slice(0, idx),
            quote: displayedPair.slice(idx + 1),
        };
    }, [displayedPair]);

    const activeMode: "Spot" | "Cross" | "Isolated" =
        marginType?.toUpperCase() === "CROSS"
            ? "Cross"
            : marginType?.toUpperCase() === "ISOLATED"
              ? "Isolated"
              : "Spot";
    const activeSubtab: Subtab = variantToSubtab(variantKey);
    const activeStopVariant = variantKeyToStopVariant(variantKey);
    const currentTif = variantKeyToTif(variantKey);
    const isOco = variantKey === "oco_gtc";
    const isTrailing = variantKey === "trailing_stop_limit_gtc";
    const isBracket = variantKey === "trigger_bracket_gtc";

    // Which field the user last typed in — drives bidirectional Amount↔Total.
    const [lastEdit, setLastEdit] = useState<"amount" | "total">("amount");
    // Preserved raw Total input. We can't round-trip Total → base_size → Total
    // without losing precision, so when the user types in Total we keep their
    // literal string here and show it back exactly. Cleared whenever Amount,
    // Price, or the percent slider take over.
    const [rawTotalInput, setRawTotalInput] = useState<string | null>(null);

    // Locally-managed snapshot. We seed from the server-supplied prop and
    // refetch via `/cex/account-snapshot` whenever Pair changes — without
    // this, Avbl / Max Buy / Est Fee silently stay on the LLM's original
    // pair after the user edits Pair in-modal.
    const [liveSnapshot, setLiveSnapshot] = useState<TradingOrderAccountSnapshot | null>(
        accountSnapshot ?? null,
    );
    const [snapshotLoading, setSnapshotLoading] = useState(false);
    useEffect(() => {
        // Resync when the parent re-emits a fresh seed (new approval event).
        setLiveSnapshot(accountSnapshot ?? null);
    }, [accountSnapshot]);

    // Tradable-products cache for the Pair combobox. Lazily populated on
    // first focus so the editor's initial render isn't gated on the
    // exchangeInfo round-trip. Cache is keyed by margin mode — switching
    // Spot ↔ Cross refetches because the symbol universe is different
    // (Binance margin requires `permissions` contains `MARGIN`).
    const [products, setProducts] = useState<Array<{
        product_id: string;
        base_asset: string;
        quote_asset: string;
    }> | null>(null);
    const productsModeRef = useRef<string | null>(null);
    const marginTypeForProducts: "cross" | "isolated" | undefined =
        (values.margin_type ?? "").toUpperCase() === "CROSS"
            ? "cross"
            : (values.margin_type ?? "").toUpperCase() === "ISOLATED"
              ? "isolated"
              : undefined;
    const productsCacheKey = `${venue ?? ""}|${marginTypeForProducts ?? "spot"}`;
    const ensureProductsLoaded = useCallback(() => {
        if (!agentId || !venue) return;
        if (productsModeRef.current === productsCacheKey) return;
        productsModeRef.current = productsCacheKey;
        setProducts(null);
        void apiClient
            .getCexTradableProducts(agentId, venue, marginTypeForProducts)
            .then((res) => {
                if (productsModeRef.current !== productsCacheKey) return;
                if (res && Array.isArray(res.products)) setProducts(res.products);
            })
            .catch(() => {
                /* fall back to free-text */
            });
    }, [agentId, venue, productsCacheKey, marginTypeForProducts]);
    // Eagerly refresh when activeMode flips Spot ↔ Cross/Isolated so the
    // user picking Cross sees only margin-eligible pairs even before
    // re-focusing the Pair input.
    useEffect(() => {
        ensureProductsLoaded();
    }, [ensureProductsLoaded]);

    const patch = (next: Record<string, string>) => {
        setValues((prev) => ({ ...prev, ...next }) as Record<string, string>);
        onAnyChange?.();
    };

    const patchOrderConfig = (key: string, value: string | boolean | undefined) => {
        const next = patchInnerJson(orderConfigRaw, key, value);
        patch({ order_configuration: next });
    };

    /**
     * Pair-aware change handler: replaces `product_id` / `symbol` AND
     * clears every price-bearing field inside `order_configuration`
     * (limit / stop / OCO legs / TP-SL / base_size / quote_size). The
     * cleared fields' old values were tied to the previous pair's
     * market — keeping them produces "62000 USDT for ETH" pilot-error
     * shapes which the priceDeviation risk gate now blocks but the
     * UI should never offer in the first place.
     */
    const handlePairChange = (next: string) => {
        const trimmed = next.trim().toUpperCase();
        const parsedCfg = readConfig(orderConfigRaw);
        if (parsedCfg) {
            const cleanedInner: Record<string, unknown> = { ...parsedCfg.inner };
            for (const k of PAIR_DEPENDENT_INNER_KEYS) {
                delete cleanedInner[k];
            }
            patch({
                product_id: trimmed,
                symbol: trimmed,
                order_configuration: stringifyConfig(parsedCfg.variantKey, cleanedInner),
            });
        } else {
            patch({ product_id: trimmed, symbol: trimmed });
        }
        setRawTotalInput(null);
        setLastEdit("amount");
    };

    // Refresh accountSnapshot whenever the canonical pair changes. The
    // server re-derives baseAsset/quoteAsset from the query so the
    // returned snapshot matches the typed pair, not the LLM's original.
    // Debounced ~250ms so rapid typing in the Pair combobox doesn't fan
    // out a request per keystroke.
    const liveSnapshotKey = liveSnapshot
        ? `${liveSnapshot.baseAsset}|${liveSnapshot.quoteAsset}`
        : "";
    useEffect(() => {
        if (!agentId || !venue) return;
        if (!split) return;
        const wantKey = `${split.base}|${split.quote}`;
        if (liveSnapshotKey === wantKey && !snapshotLoading) return;
        let cancelled = false;
        setSnapshotLoading(true);
        const t = setTimeout(() => {
            apiClient
                .getCexAccountSnapshot(agentId, {
                    venue,
                    base: split.base,
                    quote: split.quote,
                })
                .then((snap) => {
                    if (cancelled) return;
                    setLiveSnapshot(snap);
                })
                .catch(() => {
                    if (cancelled) return;
                    setLiveSnapshot(null);
                })
                .finally(() => {
                    if (!cancelled) setSnapshotLoading(false);
                });
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentId, venue, split?.base, split?.quote]);

    const setMode = (mode: "Spot" | "Cross" | "Isolated") => {
        if (mode === "Spot") {
            // Leaving margin trading: clear ALL margin context so nothing
            // stale ships to a Spot order. The previous code only cleared
            // margin_type; leverage and margin_action survived and either
            // got rejected by the canonical-intent validator or silently
            // ignored by the venue.
            patch({
                margin_type: "",
                margin_action: "",
                leverage: "",
            });
            return;
        }
        const next = mode === "Cross" ? "CROSS" : "ISOLATED";
        patch({ margin_type: next });
    };

    const setSubtab = (tab: Subtab) => {
        const newKey = subtabToDefaultVariantKey(tab, currentTif);
        const nextConfig = swapVariant(orderConfigRaw, newKey, side);
        patch({ order_configuration: nextConfig });
    };

    const setStopVariant = (v: StopVariant) => {
        const nextConfig = swapVariant(orderConfigRaw, STOP_VARIANT_TO_KEY[v], side);
        patch({ order_configuration: nextConfig });
    };

    const setTif = (newTif: string) => {
        const nextKey = applyTifToVariant(variantKey, newTif);
        if (nextKey === variantKey) return;
        const nextConfig = swapVariant(orderConfigRaw, nextKey, side);
        patch({ order_configuration: nextConfig });
    };

    /**
     * Side flip: when entering stop-limit, the default direction depends
     * on side (BUY → STOP_UP, SELL → STOP_DOWN). Re-derive on every flip
     * AS LONG AS the user hasn't manually overridden the direction.
     */
    const setSide = (s: "BUY" | "SELL") => {
        const next: Record<string, string> = { side: s };
        if (variantKey === "stop_limit_stop_limit_gtc") {
            const cur = readConfig(orderConfigRaw);
            const userDirection = cur?.inner.stop_direction;
            // Only re-derive when the field is missing OR matches the
            // previous side's auto-default; explicit user overrides
            // (typed by the new selector below) survive the side flip.
            const oldAuto = inferStopDirectionFromSide(side);
            if (!userDirection || userDirection === oldAuto) {
                next.order_configuration = patchInnerJson(
                    orderConfigRaw,
                    "stop_direction",
                    inferStopDirectionFromSide(s),
                );
            }
        }
        patch(next);
    };

    // Editable size derivations.
    const priceN = safeNum(limitPrice);
    const baseSizeN = safeNum(baseSize);
    const quoteSizeN = safeNum(quoteSize);
    const totalShown = useMemo(() => {
        // When the user is actively editing Total, show their literal input
        // — we can't round-trip via base_size without rounding.
        if (lastEdit === "total" && rawTotalInput !== null) return rawTotalInput;
        if (lastEdit === "total" && quoteSizeN !== null) {
            return formatBalance(quoteSizeN, 4);
        }
        if (baseSizeN !== null && priceN !== null) {
            return formatBalance(baseSizeN * priceN, 4);
        }
        if (quoteSizeN !== null) return formatBalance(quoteSizeN, 4);
        return "";
    }, [lastEdit, baseSizeN, quoteSizeN, priceN, rawTotalInput]);

    // Derive the current percent of available balance directly from the
    // active size fields. This drives the slider thumb so it tracks Amount/
    // Total edits, instead of staying glued to the last clicked notch.
    // Gated on the live snapshot matching the *current* pair — otherwise
    // the slider position is computed against the WRONG asset's balance
    // (e.g. snapshot still says BTC while the editor shows ETH-USDT).
    // The snapshot is considered "matching" only when:
    //   - it's present,
    //   - we have a complete pair (split !== null),
    //   - AND both assets line up.
    // The previous (lenient) form treated `split === null` as "matches",
    // which left the Avbl/Max strip showing the OLD pair's data while
    // the user was mid-typing the new one (no `-` yet).
    const snapshotPairMatch =
        liveSnapshot != null &&
        split != null &&
        split.base === liveSnapshot.baseAsset &&
        split.quote === liveSnapshot.quoteAsset;
    const derivedPct = useMemo<number | null>(() => {
        if (!liveSnapshot || !snapshotPairMatch) return null;
        const feeRate = (liveSnapshot.feeBps ?? 10) / 10_000;
        const buyDenom = 1 - feeRate;
        const baseAvbl = safeNum(liveSnapshot.baseAvailable);
        const quoteAvbl = safeNum(liveSnapshot.quoteAvailable);
        const rawTotalN = rawTotalInput !== null ? safeNum(rawTotalInput) : null;
        if (isBuy) {
            if (quoteAvbl === null || quoteAvbl <= 0) return null;
            let usedQuote: number | null = null;
            if (activeSubtab === "Market") {
                usedQuote = quoteSizeN;
            } else if (lastEdit === "total" && rawTotalN !== null) {
                usedQuote = rawTotalN;
            } else if (baseSizeN !== null && priceN !== null && priceN > 0) {
                // Pre-fee notional. `applyPercent` for Limit BUY computes
                // `amount = avbl*pct*(1-feeRate)/price`, so the slider thumb
                // would otherwise drift to ~99.9% on a 100% click (10bps
                // fee). Divide out (1-feeRate) here so the round-trip stays
                // aligned with the user's click position.
                usedQuote = buyDenom > 0 ? (baseSizeN * priceN) / buyDenom : baseSizeN * priceN;
            } else if (quoteSizeN !== null) {
                usedQuote = quoteSizeN;
            }
            if (usedQuote === null) return null;
            return Math.max(0, Math.min(100, (usedQuote / quoteAvbl) * 100));
        }
        if (isSell) {
            if (baseAvbl === null || baseAvbl <= 0) return null;
            if (baseSizeN === null) return null;
            return Math.max(0, Math.min(100, (baseSizeN / baseAvbl) * 100));
        }
        return null;
    }, [
        liveSnapshot,
        snapshotPairMatch,
        isBuy,
        isSell,
        baseSizeN,
        quoteSizeN,
        priceN,
        activeSubtab,
        lastEdit,
        rawTotalInput,
    ]);

    // Apply a percent of available balance (slider drag or notch click).
    const applyPercent = (pct: number) => {
        setRawTotalInput(null);
        if (!liveSnapshot || !snapshotPairMatch) return;
        const feeRate = (liveSnapshot.feeBps ?? 10) / 10_000;
        const baseAvbl = safeNum(liveSnapshot.baseAvailable);
        const quoteAvbl = safeNum(liveSnapshot.quoteAvailable);

        if (activeSubtab === "Market") {
            if (isBuy && quoteAvbl !== null) {
                const total = quoteAvbl * (pct / 100);
                patchOrderConfig("quote_size", formatBalance(total, 4));
                setLastEdit("total");
            } else if (isSell && baseAvbl !== null) {
                const amount = baseAvbl * (pct / 100);
                patchOrderConfig("base_size", formatBalance(amount, 8));
                setLastEdit("amount");
            }
            return;
        }
        // Limit / Stop Limit: need a price to compute base from quote.
        if (isBuy && quoteAvbl !== null && priceN !== null && priceN > 0) {
            const amount = (quoteAvbl * (pct / 100) * (1 - feeRate)) / priceN;
            patchOrderConfig("base_size", formatBalance(amount, 8));
            setLastEdit("amount");
        } else if (isSell && baseAvbl !== null) {
            const amount = baseAvbl * (pct / 100);
            patchOrderConfig("base_size", formatBalance(amount, 8));
            setLastEdit("amount");
        }
    };

    // Bidirectional Amount/Total editing.
    const onAmountChange = (v: string) => {
        setLastEdit("amount");
        setRawTotalInput(null);
        patchOrderConfig("base_size", v);
    };
    const onTotalChange = (v: string) => {
        setLastEdit("total");
        setRawTotalInput(v);
        const totalN = safeNum(v);
        if (activeSubtab === "Market") {
            // Market: total IS quote_size — no precision loss either way.
            patchOrderConfig("quote_size", v);
            return;
        }
        // Limit / Stop Limit: convert total → base_size for submission.
        // We deliberately do NOT recompute the displayed Total from
        // base_size — the rounding round-trip loses precision (e.g. typing
        // "5" against price 60000 becomes 4.9998 on read-back).
        if (totalN !== null && priceN !== null && priceN > 0) {
            const amount = totalN / priceN;
            patchOrderConfig("base_size", formatBalance(amount, 8));
            return;
        }
        // No price yet — DO NOT stash as quote_size. Binance Limit
        // rejects quote_size, and Total without Price has no canonical
        // submit shape. We keep the user's literal input alive in
        // `rawTotalInput` (set above) so they can see what they typed
        // while the inline "set Price first" hint nudges them.
    };

    // Iceberg toggle — controls visibility of the iceberg_qty field.
    const icebergOn = !!icebergQty;
    const setIcebergOn = (on: boolean) => {
        if (on) patchOrderConfig("iceberg_qty", "");
        else patchOrderConfig("iceberg_qty", undefined);
    };

    // TP/SL toggle — flips between limit_limit_gtc ↔ trigger_bracket_gtc.
    // When TP/SL is ON, the user can fill in take_profit_price and stop_loss_price.
    // When TP/SL turns ON we also force-strip iceberg_qty since the bracket
    // variant doesn't support iceberg (the checkbox is hidden in that mode,
    // but the JSON field would otherwise leak through swapVariant).
    const tpSlOn = isBracket;
    const setTpSlOn = (on: boolean) => {
        if (on && !isBracket) {
            const cleared = patchInnerJson(orderConfigRaw, "iceberg_qty", undefined);
            const nextConfig = swapVariant(cleared, "trigger_bracket_gtc", side);
            patch({ order_configuration: nextConfig });
        } else if (!on && isBracket) {
            const nextConfig = swapVariant(orderConfigRaw, "limit_limit_gtc", side);
            patch({ order_configuration: nextConfig });
        }
    };

    // -----------------------------------------------------------------
    // Validation / disabled-state surface (Fix #4, #13, #16, #4-slider)
    // -----------------------------------------------------------------

    // Coinbase doesn't support margin trading; CLAUDE.md spells this out
    // ("Margin remains Binance-only"). Hide Cross/Isolated tabs entirely
    // so the user can't construct a margin order against a non-margin venue.
    const venueLower = (venue ?? "").toLowerCase();
    const marginTabsVisible = venueLower !== "coinbase";

    // Required-fields check — drives the inline `*` errors and the
    // "Confirm" enable state. Mirrors the canonical-intent zod validator
    // (stop_limit needs both prices, GTD needs end_time, bracket needs
    // both TP and SL, OCO needs all three legs).
    const sizeMissing = !baseSize && !quoteSize;
    const requiredErrors: Record<string, string> = {};
    // Fix-NEW1 (post-PR243 iter3): accept either dash form (BTC-USDT)
    // or concat form (BTCUSDT) — displayPair normalizes both into
    // displayedPair which always has a dash when the symbol resolves
    // to a known base/quote split. Backend decomposer + plan paths
    // emit concat form; rejecting it as "Pick a trading pair." with
    // the input populated confused users (PR242 iter2 NEW1 report).
    if (!pair || !/-/.test(displayedPair)) requiredErrors.pair = "Pick a trading pair.";
    if (activeSubtab !== "Market" && !limitPrice) requiredErrors.limit_price = "Set a limit price.";
    if (activeSubtab === "Stop Limit" && !isOco && !isTrailing && !stopPrice) {
        requiredErrors.stop_price = "Set a stop price.";
    }
    if (currentTif === "GTD" && !endTime) requiredErrors.end_time = "Pick an expiry.";
    if (isOco) {
        if (!ocoTpPrice) requiredErrors.above_limit_price = "Set take-profit price.";
        if (!ocoSlStop) requiredErrors.below_stop_price = "Set stop trigger price.";
        if (!ocoSlLimit) requiredErrors.below_limit_price = "Set stop-limit price.";
    }
    if (isBracket) {
        if (!tpPrice) requiredErrors.take_profit_price = "Set take-profit price.";
        if (!slPrice) requiredErrors.stop_loss_price = "Set stop-loss price.";
    }
    if (sizeMissing) requiredErrors.size = "Set Amount or Total.";

    // OCO leg sanity: TP above market, stop-loss below — matches Binance's
    // ordering invariant. We only have access to the user-typed limit price
    // as a market proxy in the order editor; soft-warn instead of block.
    const ocoTpN = safeNum(ocoTpPrice);
    const ocoSlStopN = safeNum(ocoSlStop);
    const ocoSlLimitN = safeNum(ocoSlLimit);
    const ocoWarnings: Record<string, string> = {};
    if (isOco) {
        if (ocoTpN !== null && ocoSlStopN !== null && ocoTpN <= ocoSlStopN) {
            ocoWarnings.above_limit_price = "Take-profit must be above the stop trigger.";
        }
        if (ocoSlStopN !== null && ocoSlLimitN !== null) {
            if (isBuy && ocoSlLimitN > ocoSlStopN) {
                ocoWarnings.below_limit_price = "BUY stop-limit should sit at or below the stop trigger.";
            }
            if (isSell && ocoSlLimitN < ocoSlStopN) {
                ocoWarnings.below_limit_price = "SELL stop-limit should sit at or above the stop trigger.";
            }
        }
    }

    // Min notional gate (Spot default: 5 USDT). Computed against the
    // user-visible quote so cross-asset pairs (BTC, ETH-quoted) at least
    // get a reasonable heuristic. Surfaces inline on Total.
    const quoteMinNotional = ((q: string) => {
        const up = q.toUpperCase();
        if (up === "USDT" || up === "USDC" || up === "USD") return 5;
        if (up === "BTC") return 0.0001;
        if (up === "ETH") return 0.001;
        return 0;
    })(split?.quote ?? "");
    const submittedNotional = (() => {
        if (activeSubtab === "Market" && quoteSizeN !== null) return quoteSizeN;
        if (priceN !== null && baseSizeN !== null) return baseSizeN * priceN;
        return null;
    })();
    const minNotionalError =
        submittedNotional !== null && quoteMinNotional > 0 && submittedNotional > 0 && submittedNotional < quoteMinNotional
            ? `Minimum ${quoteMinNotional} ${split?.quote ?? ""} — currently ${formatBalance(submittedNotional, 4)}.`
            : null;

    // Slider disable reasons — surface ONE message at a time so the
    // hint is unambiguous.
    const sliderDisabledReason = (() => {
        if (!liveSnapshot) return null;
        if (!snapshotPairMatch) return "Loading balance for this pair…";
        if (activeSubtab !== "Market" && (priceN === null || priceN <= 0)) {
            return isBuy ? "Set a Price first." : "Set a Price first.";
        }
        return null;
    })();

    // Composite "can submit" — surface to the parent dialog so the
    // Confirm button can disable. Mirrors the inline errors above plus
    // OCO leg warnings (warnings remain non-blocking).
    const hasBlockingErrors =
        Object.keys(requiredErrors).length > 0 ||
        !!minNotionalError ||
        !!(trailingBps && (() => {
            const n = Number.parseInt(trailingBps, 10);
            return !Number.isFinite(n) || n < 1 || n > 2000;
        })());

    // Propagate to the parent on every render so the dialog's submit gate
    // (HumanInputDialog / ManualComposeDialog) can read it. Uses a hidden
    // values[] field so the existing setValues conduit carries it without
    // a new prop. Server-side validation still runs — this is UX only.
    useEffect(() => {
        const blocking = hasBlockingErrors ? "1" : "";
        if ((values.__editor_blocking ?? "") !== blocking) {
            setValues((prev) => ({ ...prev, __editor_blocking: blocking }));
        }
    }, [hasBlockingErrors, values.__editor_blocking, setValues]);

    return (
        <div
            data-testid="trading-order-editor"
            className="rounded-xl border border-white/10 bg-[#1e2329] overflow-hidden"
        >
            {/* Tier 1: Spot/Cross/Isolated tabs + Fee Level on the right.
                Hidden when venue=Coinbase (margin remains Binance-only per
                CLAUDE.md) so a Coinbase user can't construct an unsupported
                margin order in this dialog. */}
            <TabStrip
                tabs={marginTabsVisible ? ["Spot", "Cross", "Isolated"] : ["Spot"]}
                active={activeMode}
                onChange={(t) => setMode(t as "Spot" | "Cross" | "Isolated")}
                size="lg"
                rightSlot={
                    <FeeLevelPopover
                        feeBps={liveSnapshot?.feeBps ?? 10}
                        pair={pair}
                    />
                }
            />

            {/* Tier 2: Limit / Market / Stop Limit (with nested variant dropdown when active) */}
            <TabStrip
                tabs={["Limit", "Market", "Stop Limit"]}
                active={activeSubtab}
                onChange={(t) => setSubtab(t as Subtab)}
                size="sm"
                rightSlot={
                    activeSubtab === "Stop Limit" ? (
                        <Dropdown
                            label={
                                <span className="text-amber-300 font-medium">
                                    {activeStopVariant}
                                </span>
                            }
                            options={[
                                { label: "Stop Limit", value: "Stop Limit" },
                                {
                                    label: "Stop Market (not supported)",
                                    value: "Stop Market",
                                    disabled: true,
                                },
                                { label: "Trailing Stop", value: "Trailing Stop" },
                                { label: "OCO", value: "OCO" },
                                {
                                    label: "TWAP (not supported)",
                                    value: "TWAP",
                                    disabled: true,
                                },
                            ]}
                            value={activeStopVariant}
                            onChange={(v) => setStopVariant(v as StopVariant)}
                            align="right"
                            style="inline"
                        />
                    ) : null
                }
            />

            {/* Side toggle */}
            <SideToggle
                side={side}
                onChange={setSide}
            />

            {/* Margin action row (margin-only) */}
            {marginType ? (
                <MarginActionRow
                    marginAction={marginAction}
                    onChange={(a) => patch({ margin_action: a })}
                />
            ) : null}

            {/* Field blocks */}
            <div className="px-5 py-3 space-y-2.5">
                <PairFieldBlock
                    value={pair}
                    onChange={handlePairChange}
                    onFocus={ensureProductsLoaded}
                    products={products}
                    error={requiredErrors.pair ?? null}
                />

                {/* Snapshot loading hint — surfaces the 200–800 ms refetch
                    so users don't see stale "Max Buy BTC" after editing
                    the pair to ETH-USDT. */}
                {snapshotLoading ? (
                    <div className="px-1 -mt-1 text-[10px] text-amber-300/60">
                        Refreshing balance for {split?.base ?? pair}…
                    </div>
                ) : null}

                {activeSubtab !== "Market" ? (
                    <FieldBlock
                        label="Price"
                        value={limitPrice}
                        unit={split?.quote ?? null}
                        placeholder="0.00"
                        onChange={(v) => patchOrderConfig("limit_price", v)}
                        required
                        error={requiredErrors.limit_price ?? null}
                    />
                ) : null}

                {/* Trailing-stop fields */}
                {isTrailing ? (
                    <FieldBlock
                        label="Trail Δ"
                        value={trailingBps}
                        unit="bps"
                        placeholder="100"
                        onChange={(v) => {
                            // Trailing bps must be an INTEGER 1..2000 on
                            // Binance Spot. Strip the decimal portion as
                            // the user types so the canonical validator
                            // (which rejects floats) can't fail downstream.
                            const cleaned = v.replace(/[^0-9]/g, "");
                            patchOrderConfig("trailing_delta_bps", cleaned);
                        }}
                        error={(() => {
                            const n = Number.parseInt(trailingBps, 10);
                            if (trailingBps && (!Number.isFinite(n) || n < 1 || n > 2000)) {
                                return "Must be an integer between 1 and 2000.";
                            }
                            return null;
                        })()}
                        footer={
                            <span className="text-white/30">
                                1–2000 bps (Binance range; 100 bps = 1%)
                            </span>
                        }
                    />
                ) : null}

                {/* Stop trigger fields */}
                {activeSubtab === "Stop Limit" && !isOco && !isTrailing ? (
                    <>
                        <FieldBlock
                            label="Stop Price"
                            value={stopPrice}
                            unit={split?.quote ?? null}
                            placeholder="0.00"
                            onChange={(v) => patchOrderConfig("stop_price", v)}
                            required
                        />
                        <StopDirectionToggle
                            value={
                                (asString(inner.stop_direction) as
                                    "STOP_DIRECTION_STOP_UP"
                                    | "STOP_DIRECTION_STOP_DOWN"
                                    | "")
                                    || inferStopDirectionFromSide(side)
                            }
                            onChange={(dir) => patchOrderConfig("stop_direction", dir)}
                        />
                    </>
                ) : null}

                {/* OCO legs */}
                {isOco ? (
                    <>
                        <FieldBlock
                            label="Take-Profit"
                            value={ocoTpPrice}
                            unit={split?.quote ?? null}
                            placeholder="0.00"
                            accent="emerald"
                            onChange={(v) => patchOrderConfig("above_limit_price", v)}
                            error={requiredErrors.above_limit_price ?? ocoWarnings.above_limit_price ?? null}
                            footer={<span className="text-white/30">Limit-maker leg (above market)</span>}
                            required
                        />
                        <FieldBlock
                            label="Stop Trigger"
                            value={ocoSlStop}
                            unit={split?.quote ?? null}
                            placeholder="0.00"
                            accent="rose"
                            onChange={(v) => patchOrderConfig("below_stop_price", v)}
                            error={requiredErrors.below_stop_price ?? null}
                            required
                        />
                        <FieldBlock
                            label="Stop Limit"
                            value={ocoSlLimit}
                            unit={split?.quote ?? null}
                            placeholder="0.00"
                            accent="rose"
                            onChange={(v) => patchOrderConfig("below_limit_price", v)}
                            error={requiredErrors.below_limit_price ?? ocoWarnings.below_limit_price ?? null}
                            footer={<span className="text-white/30">OCO stop-loss limit price</span>}
                            required
                        />
                    </>
                ) : null}

                {/* Amount (base) — hidden on Market BUY (Market uses
                    quote_size; Total IS the field). Always shown on Sell
                    + Limit + Stop-Limit. OCO doesn't have a per-leg
                    Total, so Amount carries the order size. */}
                {!(activeSubtab === "Market" && isBuy) ? (
                    <FieldBlock
                        label="Amount"
                        value={baseSize}
                        unit={split?.base ?? null}
                        placeholder="0.00"
                        onChange={onAmountChange}
                        onFocus={() => setLastEdit("amount")}
                        required={sizeMissing && !(activeSubtab === "Market" && isBuy)}
                        error={
                            sizeMissing && !(activeSubtab === "Market" && isBuy)
                                ? requiredErrors.size ?? null
                                : null
                        }
                    />
                ) : null}

                {/* Percent slider — continuous drag; thumb reflects the
                    current size as a fraction of available balance, so it
                    tracks Amount/Total edits too. Disabled with an inline
                    hint when Price is empty (Limit/Stop-Limit) or while the
                    snapshot is being refetched for a new pair. */}
                <PercentSlider
                    value={derivedPct}
                    onChange={applyPercent}
                    disabledReason={sliderDisabledReason}
                />

                {/* Total — editable bidirectional. Hidden on OCO (each leg
                    has its own price; a single Total has no meaning) and on
                    Market SELL (Market SELL uses base_size; Amount IS the
                    field). */}
                {!isOco && !(activeSubtab === "Market" && isSell) ? (
                    <FieldBlock
                        label="Total"
                        value={totalShown}
                        unit={split?.quote ?? null}
                        placeholder="0.00"
                        onChange={onTotalChange}
                        onFocus={() => setLastEdit("total")}
                        required={activeSubtab === "Market" && isBuy && sizeMissing}
                        error={
                            (activeSubtab === "Market" && isBuy && sizeMissing
                                ? requiredErrors.size
                                : null) ??
                            minNotionalError
                        }
                        footer={
                            <span className="text-white/30">
                                Minimum {quoteMinNotional > 0
                                    ? `${quoteMinNotional} ${split?.quote ?? ""}`
                                    : `set by venue`}
                            </span>
                        }
                    />
                ) : null}

                {/* Iceberg field (only when iceberg toggle is on) */}
                {icebergOn ? (
                    <FieldBlock
                        label="Iceberg Qty"
                        value={icebergQty}
                        unit={split?.base ?? null}
                        placeholder="0.00"
                        onChange={(v) => patchOrderConfig("iceberg_qty", v)}
                        footer={<span className="text-white/30">Visible portion of hidden limit</span>}
                    />
                ) : null}

                {/* TP/SL fields (only when bracket variant) */}
                {tpSlOn ? (
                    <>
                        <FieldBlock
                            label="Take-Profit"
                            value={tpPrice}
                            unit={split?.quote ?? null}
                            placeholder="0.00"
                            accent="emerald"
                            onChange={(v) => patchOrderConfig("take_profit_price", v)}
                            required
                            error={requiredErrors.take_profit_price ?? null}
                        />
                        <FieldBlock
                            label="Stop-Loss"
                            value={slPrice}
                            unit={split?.quote ?? null}
                            placeholder="0.00"
                            accent="rose"
                            onChange={(v) => patchOrderConfig("stop_loss_price", v)}
                            required
                            error={requiredErrors.stop_loss_price ?? null}
                        />
                    </>
                ) : null}

                {/* GTD expiry picker — required when TIF=GTD. Without this
                    block the canonical validator rejects the order with
                    "time_in_force=GTD requires end_time". */}
                {currentTif === "GTD" ? (
                    <div className={cn(
                        "rounded-lg border bg-[#161a1f] px-3 py-2",
                        requiredErrors.end_time ? "border-rose-400/50" : "border-white/10",
                    )}>
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[11px] text-white/45 font-medium uppercase tracking-wide">
                                Expires
                                <span className="text-amber-400/90 ml-0.5">*</span>
                            </span>
                            <span className="text-[10px] text-white/30">Order auto-cancels at this time</span>
                        </div>
                        <DatetimeCalendarField
                            valueStr={endTime}
                            onChange={(iso) => patchOrderConfig("end_time", iso)}
                            minNow
                        />
                        {requiredErrors.end_time ? (
                            <div className="mt-1 text-[10px] text-rose-300/90">
                                {requiredErrors.end_time}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {/* Toggles row: TP/SL, Post Only, Iceberg + TIF dropdown right-aligned */}
                <div className="flex items-center gap-4 flex-wrap pt-1">
                    {/* TP/SL only meaningful for Limit subtab (extends to trigger_bracket) */}
                    {activeSubtab === "Limit" ? (
                        <Checkbox
                            checked={tpSlOn}
                            label="TP/SL"
                            onChange={setTpSlOn}
                        />
                    ) : null}
                    {/* Post Only is only valid on GTC limit per Binance —
                        hide on GTD / IOC / FOK and on Stop-Limit. */}
                    {activeSubtab === "Limit" && currentTif === "GTC" ? (
                        <Checkbox
                            checked={postOnly}
                            label="Post Only"
                            onChange={(c) => patchOrderConfig("post_only", c)}
                        />
                    ) : null}
                    {/* Iceberg supported on limit_limit_gtc / limit_limit_gtd */}
                    {activeSubtab === "Limit" && !tpSlOn ? (
                        <Checkbox
                            checked={icebergOn}
                            label="Iceberg"
                            onChange={setIcebergOn}
                        />
                    ) : null}
                    <div className="ml-auto inline-flex items-center gap-1.5">
                        <span className="text-[10px] text-white/40 uppercase tracking-wide">TIF</span>
                        <Dropdown
                            label={
                                <span className="text-white/85 font-medium">{currentTif}</span>
                            }
                            options={tifsForSubtab(activeSubtab, venue).map((t) => ({
                                label: t,
                                value: t,
                            }))}
                            value={currentTif}
                            onChange={setTif}
                            align="right"
                            style="inline"
                        />
                    </div>
                </div>

                {/* Margin leverage */}
                {marginType ? (
                    <FieldBlock
                        label="Leverage"
                        value={leverage}
                        unit="x"
                        placeholder="1"
                        onChange={(v) => patch({ leverage: v })}
                    />
                ) : null}
            </div>

            {/* Avbl / Max / Est Fee strip — uses the locally-refreshed
                snapshot so values track the current Pair, not the
                server's seed at approval time. */}
            {liveSnapshot ? (
                <AvblMaxFeeStrip
                    snapshot={liveSnapshot}
                    isBuy={isBuy}
                    isSell={isSell}
                    limitPrice={limitPrice}
                    baseSize={baseSize}
                    quoteSize={quoteSize}
                    currentBaseAsset={split?.base ?? null}
                    currentQuoteAsset={split?.quote ?? null}
                />
            ) : null}

            {/* Footer (Venue + Preview ID / Retail Portfolio for Coinbase) */}
            {(venue || previewId || retailPortfolioId) ? (
                <div className="px-5 py-2.5 border-t border-white/5 bg-black/15 space-y-0.5">
                    {venue ? (
                        <DetailRow
                            label="Venue"
                            value={
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-white/5 text-white/70 ring-1 ring-white/15 capitalize">
                                    {venue}
                                </span>
                            }
                        />
                    ) : null}
                    {previewId ? (
                        <DetailRow
                            label="Preview ID"
                            value={
                                <input
                                    type="text"
                                    value={previewId}
                                    onChange={(e) => patch({ preview_id: e.target.value })}
                                    className="bg-transparent text-right font-mono text-[11px] text-white/70 outline-none"
                                />
                            }
                        />
                    ) : null}
                    {retailPortfolioId ? (
                        <DetailRow
                            label="Retail Portfolio"
                            value={
                                <input
                                    type="text"
                                    value={retailPortfolioId}
                                    onChange={(e) => patch({ retail_portfolio_id: e.target.value })}
                                    className="bg-transparent text-right font-mono text-[11px] text-white/70 outline-none"
                                />
                            }
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Avbl / Max / Est Fee strip — Binance-style summary with Avbl chevron
// ---------------------------------------------------------------------------

const AvblMaxFeeStrip: React.FC<{
    snapshot: TradingOrderAccountSnapshot;
    isBuy: boolean;
    isSell: boolean;
    limitPrice: string;
    baseSize: string;
    quoteSize: string;
    /**
     * Current pair's base/quote, derived from `values.product_id` in
     * `TradingOrderEditor`. Asset *labels* render from these so a stale
     * snapshot (mid-refetch) can't show "Max Buy 0.00981831 BTC" while
     * the user is staring at ETH-USDT. Balance *numbers* still come
     * from the snapshot — once the refetch lands, the snapshot's
     * `baseAsset` matches the pair and the labels go back to being a
     * sanity check on the server's response.
     */
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

    // Asset labels always reflect the current pair — never the snapshot's
    // (possibly stale) baseAsset/quoteAsset. The values themselves still
    // come from the snapshot; if the snapshot is in-flight or stale, the
    // strip momentarily reads the *previous* numeric value under the new
    // label, which is fine for the second-or-two it takes the refetch.
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

    const maxValue = (() => {
        if (avblN === null || avblN <= 0) return null;
        if (isBuy) {
            if (priceN === null || priceN <= 0) return null;
            return (avblN * (1 - feeRate)) / priceN;
        }
        if (isSell) {
            if (priceN === null || priceN <= 0) return null;
            return avblN * priceN * (1 - feeRate);
        }
        return null;
    })();
    const maxLabel = isBuy ? "Max Buy" : isSell ? "Max Sell" : "Max";
    const maxAsset = isBuy ? baseLabel : quoteLabel;

    const estFeeValue = (() => {
        if (priceN === null && quoteSizeN === null) return null;
        if (quoteSizeN !== null && quoteSizeN > 0) return quoteSizeN * feeRate;
        if (baseSizeN !== null && baseSizeN > 0 && priceN !== null && priceN > 0) {
            return baseSizeN * priceN * feeRate;
        }
        return null;
    })();

    const feePct = (feeBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

    return (
        <div className="px-5 py-3 border-t border-white/5 bg-black/10 space-y-1">
            <DetailRow
                label={
                    <span className="inline-flex items-center gap-0.5">
                        Avbl <ChevronDown className="size-3 text-white/30" />
                    </span>
                }
                value={
                    avblN !== null ? (
                        <span className="font-mono text-white/90 tabular-nums">
                            {formatBalance(avblN, 1)}
                            <span className="text-white/45 ml-1.5">{avblAsset}</span>
                        </span>
                    ) : (
                        <span className="text-white/35">—</span>
                    )
                }
            />
            <DetailRow
                label={<span className="underline decoration-dotted decoration-white/20 underline-offset-2">{maxLabel}</span>}
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
                label={
                    <span className="underline decoration-dotted decoration-white/20 underline-offset-2">
                        Est. Fee ({feePct}%)
                    </span>
                }
                value={
                    estFeeValue !== null ? (
                        <span className="font-mono text-white/90 tabular-nums">
                            ≈ {formatBalance(estFeeValue, 2)}
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
