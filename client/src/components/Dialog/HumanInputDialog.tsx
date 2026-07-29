import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronRight, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DatetimeCalendarField } from "../ui/datetime-calendar-field";
import type { cexParamDef } from "@/types/core";
import {
    isHumanInputFieldMissing,
    parseHumanInputValue,
    stringifyHumanInputValue,
} from "./humanInputParsing";
import { OrderConfigSummaryCard, parseOrderConfiguration } from "../cex/OrderConfigSummaryCard";
import { TradingOrderEditor } from "../cex/TradingOrderEditor";
import { useMarketSnapshot } from "@/hooks/useMarketSnapshot";
import {
    MarketSnapshotPanel,
    type CEXMarketSnapshot,
    type CEXSymbolVerification,
} from "../cex/MarketSnapshotPanel";
import type { TradingPreferences, TradingMode } from "@/hooks/useTradingPreferences";

const TRADING_PREFERENCES_QUERY_KEY = ["user", "trading-preferences"] as const;
const VALID_TRADING_MODES: ReadonlySet<TradingMode> = new Set(["paper", "shadow", "live"]);

const EMPTY_SCHEMA: Record<string, cexParamDef> = Object.freeze({}) as Record<string, cexParamDef>;

function formatLabel(key: string): string {
    return key
        .replace(/([A-Z])/g, " $1")
        .replace(/_/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase())
        .trim();
}

/**
 * Client-side preflight checks for create_order / preview_order payloads.
 * Returns a human-readable error message if a constraint fails, or null
 * when the payload looks safe to send to the server.
 *
 * These checks duplicate a handful of server-side `preflightValidateForExchange`
 * rules so the user can catch obviously-malformed fields before paying a
 * full round-trip. They do NOT replace server validation — the canonical
 * gate still lives in `packages/plugin-cex/src/spec/canonical.ts`.
 *
 * Currently checks:
 *  - `trailing_delta_bps` is an integer in [1, 2000] (Binance Spot range)
 *  - `iceberg_qty` <= `base_size` when both are present (hidden portion can't
 *    exceed total)
 *  - `margin_action != NORMAL` requires `margin_type` (Cross/Isolated)
 */
function preflightCheck(payload: Record<string, unknown>): string | null {
    const oc = payload.order_configuration as Record<string, unknown> | undefined;
    if (oc && typeof oc === "object") {
        for (const variant of Object.values(oc)) {
            if (!variant || typeof variant !== "object") continue;
            const v = variant as Record<string, unknown>;
            const td = v.trailing_delta_bps;
            if (td !== undefined && td !== null && td !== "") {
                const n = typeof td === "number" ? td : Number.parseFloat(String(td));
                if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 2000) {
                    return `trailing_delta_bps must be an integer between 1 and 2000 (got ${String(td)})`;
                }
            }
            const ice = v.iceberg_qty;
            const base = v.base_size;
            if (
                ice !== undefined && ice !== null && ice !== "" &&
                base !== undefined && base !== null && base !== ""
            ) {
                const iceN = Number.parseFloat(String(ice));
                const baseN = Number.parseFloat(String(base));
                if (Number.isFinite(iceN) && Number.isFinite(baseN) && iceN > baseN) {
                    return `iceberg_qty (${String(ice)}) cannot exceed base_size (${String(base)})`;
                }
            }
        }
    }
    const marginAction = payload.margin_action;
    const marginType = payload.margin_type;
    if (
        typeof marginAction === "string" &&
        marginAction.toUpperCase() !== "NORMAL" &&
        marginAction !== "" &&
        (typeof marginType !== "string" || marginType === "")
    ) {
        return `margin_action=${marginAction} requires margin_type (CROSS or ISOLATED)`;
    }
    return null;
}

/**
 * Resolve the order side (BUY / SELL) from the dialog payload so the action
 * button can render with venue-canonical green/red coloring. Returns null
 * when this isn't a sided action (e.g. compile_strategy, set_trading_mode).
 */
function resolveSide(fields: Record<string, unknown> | undefined, values: Record<string, string>): "BUY" | "SELL" | null {
    const candidates: unknown[] = [values?.side, fields?.side];
    for (const c of candidates) {
        if (typeof c !== "string") continue;
        const u = c.trim().toUpperCase();
        if (u === "BUY" || u === "SELL") return u;
    }
    return null;
}

function sideToButtonClass(side: "BUY" | "SELL" | null, _mode: "submit" | "step1"): string {
    if (side === "BUY") {
        return "bg-emerald-500 text-white hover:bg-emerald-400 shadow-[0_4px_20px_-4px_rgba(16,185,129,0.45)]";
    }
    if (side === "SELL") {
        return "bg-rose-500 text-white hover:bg-rose-400 shadow-[0_4px_20px_-4px_rgba(244,63,94,0.45)]";
    }
    return "bg-emerald-500 text-white hover:bg-emerald-400 shadow-[0_4px_20px_-4px_rgba(16,185,129,0.4)]";
}

function sideToButtonLabel(
    side: "BUY" | "SELL" | null,
    actionName?: string,
    targetMode?: string | null,
): string {
    if (side === "BUY") return "Confirm BUY";
    if (side === "SELL") return "Confirm SELL";
    if (actionName === "cancel_order") return "Confirm Cancel";
    if (actionName === "compile_strategy") return "Compile Strategy";
    if (actionName === "run_backtest") return "Run Backtest";
    if (actionName === "set_trading_mode") {
        // M5 iter6 (post-PR246): include the target mode in the button
        // label so the user can verify what they're about to switch to.
        const mode = (targetMode || "").trim().toLowerCase();
        if (mode === "live" || mode === "paper" || mode === "shadow") {
            return `Switch to ${mode.toUpperCase()}`;
        }
        return "Switch Mode";
    }
    return "Submit";
}

/**
 * M5 iter6 (post-PR246): produce a title fragment for the set_trading_mode
 * modal that names the target mode prominently. Returns null when the
 * action isn't set_trading_mode or the mode is missing/invalid so the
 * caller can fall back to data.title verbatim.
 */
function modeAwareTitle(actionName: string | undefined, targetMode: string | null | undefined): string | null {
    if (actionName !== "set_trading_mode") return null;
    const mode = (targetMode || "").trim().toLowerCase();
    if (mode !== "live" && mode !== "paper" && mode !== "shadow") return null;
    return `Switch Trading Mode → ${mode.toUpperCase()}`;
}

const MODE_DESCRIPTIONS: Record<string, string> = {
    paper: "Paper mode: all orders are simulated; no real money moves.",
    live: "Live mode: orders execute on the real exchange with real funds.",
    shadow: "Shadow mode: intents are recorded for comparison; no orders are sent to the venue.",
};

/**
 * Optional account-balance snapshot the server may attach to a
 * create_order approval payload. Powers the Avbl / Max Buy / Est Fee
 * block on the `OrderConfigSummaryCard`. The server fetches this
 * best-effort from the user's resolved venue credentials; when the
 * fetch fails the field is absent and the card hides the block.
 */
export interface ApprovalAccountSnapshot {
    baseAvailable: string;
    quoteAvailable: string;
    baseAsset: string;
    quoteAsset: string;
    /** Fee tier in basis points (default 10 = 0.10%). */
    feeBps?: number;
}

export interface HumanInputDialogData {
    threadId: string;
    approvalId?: string;
    interruptType?: string;
    title: string;
    description?: string;
    confirmationLevel?: 1 | 2;
    confirmationsRequired?: number;
    fields: Record<string, unknown>;
    fieldSchema?: Record<string, cexParamDef> | null;
    summary?: Record<string, unknown>;
    actionName?: string;
    /** Server-fetched balance snapshot for create_order approvals. */
    accountSnapshot?: ApprovalAccountSnapshot | null;
    /**
     * CEX post-PR237 Commit 3 — live ticker / order-book / 24h-stats
     * snapshot rendered below the `TradingOrderEditor`. Migrated from
     * the dormant `CEXApprovalDialog`; the server-side
     * `buildMarketSnapshot()` populates this best-effort. Absent when:
     *  - the action is read-only (e.g. get_balance), or
     *  - all three modal-enrichment fetches timed out / failed.
     */
    market_snapshot?: CEXMarketSnapshot;
    /**
     * CEX post-PR237 Commit 3 — symbol-verification guard for the
     * approval modal. Drives the red mismatch banner / amber
     * quote-currency warning inside `MarketSnapshotPanel`.
     */
    symbol_verification?: CEXSymbolVerification;
    /**
     * CEX post-PR237 Commit 4 — optional plan context for multi-step
     * approval flows (modal_per_step). When present, the dialog
     * surfaces the step-of-N badge and the Approve-All-Remaining
     * shortcut. Commit 4 is the consumer of these fields; Commit 3
     * just plumbs them through so the wiring lands in one place.
     */
    plan_context?: {
        plan_id: string;
        step_index: number; // 0-based
        total_steps: number;
        step_summaries: string[];
        approve_all_supported?: boolean;
    };
}

export interface HumanInputDialogProps {
    isOpen: boolean;
    data: HumanInputDialogData;
    onApprove: (values: Record<string, unknown>) => void;
    onReject: () => void;
    /**
     * CEX post-PR237 Commit 4 — fired when the user clicks
     * "Approve All Remaining" on a multi-step plan modal. The parent
     * (`chat.tsx`) translates this into an APPROVE_BATCH continuation
     * message routed back to the plan runner. Falls through to a
     * regular `onApprove(values)` call when not provided.
     */
    onApproveAllRemaining?: () => void;
    /**
     * Optional agent id passed through to `TradingOrderEditor` so its
     * snapshot/products refresh routes can authenticate. Without it
     * the editor still functions but degrades to free-text Pair with
     * stale balance numbers — only safe in tests.
     */
    agentId?: string | null;
}

function PillSelect({
    value,
    options,
    onChange,
}: {
    value: string;
    options: string[];
    onChange: (v: string) => void;
}) {
    return (
        <div className="flex gap-1 flex-wrap flex-1">
            {options.map((opt) => (
                <button
                    key={opt}
                    type="button"
                    onClick={() => onChange(opt)}
                    className={cn(
                        "px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150",
                        value === opt
                            ? "bg-amber-400/20 text-amber-300 border border-amber-400/40"
                            : "bg-white/4 text-white/40 border border-white/8 hover:border-white/20 hover:text-white/70"
                    )}
                >
                    {opt.replace(/_/g, " ")}
                </button>
            ))}
        </div>
    );
}

function TextInput({
    value,
    type,
    placeholder,
    onChange,
}: {
    value: string;
    type?: string;
    placeholder?: string;
    onChange: (v: string) => void;
}) {
    return (
        <input
            type={type === "number" ? "number" : "text"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={cn(
                "flex-1 px-3 py-2 rounded-lg text-sm font-mono",
                "bg-white/5 border border-white/10 text-white/85 placeholder:text-white/20",
                "focus:outline-none focus:border-amber-400/40 transition-colors"
            )}
        />
    );
}

/**
 * Chip-style input for `type: "array"` of `itemsType: "string"` params.
 * Renders each entry as a removable amber chip with an `×` button and
 * appends a free-text input at the end of the row for new entries.
 *
 * Persistence layer: the dialog still stores the field as a comma-joined
 * string (the existing `parseHumanInputValue("array")` already splits on
 * commas — see `humanInputParsing.ts`). This means a) no other call site
 * has to change, b) Enter / comma / tab / blur all "commit" the draft
 * into a chip without losing in-flight typing.
 */
function ArrayChipsField({
    value,
    placeholder,
    onChange,
}: {
    value: string;
    placeholder?: string;
    onChange: (next: string) => void;
}) {
    const [draft, setDraft] = useState("");
    const chips = useMemo(
        () => value.split(",").map((s) => s.trim()).filter(Boolean),
        [value],
    );
    const setChips = (next: string[]) => onChange(next.join(", "));

    const commitDraft = () => {
        const t = draft.trim();
        if (!t) return;
        // Allow pasting "id1, id2, id3" into the draft and committing
        // the whole batch in one go.
        const seen = new Set(chips);
        const additions = t
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter((s) => {
                if (!s) return false;
                if (seen.has(s)) return false;
                seen.add(s);
                return true;
            });
        if (additions.length > 0) setChips([...chips, ...additions]);
        setDraft("");
    };

    const removeAt = (index: number) => {
        setChips(chips.filter((_, i) => i !== index));
    };

    return (
        <div
            className={cn(
                "flex flex-wrap gap-1.5 items-center min-h-10 px-2 py-1.5 rounded-lg",
                "bg-white/5 border border-white/10 focus-within:border-amber-400/40 transition-colors",
            )}
        >
            {chips.map((chip, i) => (
                <span
                    key={`${chip}-${i}`}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-amber-400/15 border border-amber-400/30 text-amber-200 text-xs font-mono"
                    data-testid="array-chip"
                >
                    <span className="select-all">{chip}</span>
                    <button
                        type="button"
                        onClick={() => removeAt(i)}
                        className="rounded p-0.5 text-amber-300/70 hover:text-amber-100 hover:bg-amber-400/20 transition-colors"
                        aria-label={`Remove ${chip}`}
                        title={`Remove ${chip}`}
                    >
                        <X className="size-3" strokeWidth={2.5} />
                    </button>
                </span>
            ))}
            <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
                        if (draft.trim()) {
                            e.preventDefault();
                            commitDraft();
                        }
                    } else if (e.key === "Backspace" && draft.length === 0 && chips.length > 0) {
                        // Quick-delete the last chip when the input is empty
                        e.preventDefault();
                        removeAt(chips.length - 1);
                    }
                }}
                onBlur={commitDraft}
                placeholder={chips.length === 0 ? (placeholder ?? "Add an id and press Enter") : "Add another…"}
                className="flex-1 min-w-[120px] bg-transparent text-xs font-mono text-white/85 placeholder:text-white/25 focus:outline-none px-1 py-1"
            />
        </div>
    );
}

function StyledSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
    return (
        <div className="relative flex-1">
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className={cn(
                    "w-full appearance-none px-3 py-2 rounded-lg text-sm font-mono",
                    "bg-white/5 border border-white/10 text-white/85",
                    "focus:outline-none focus:border-amber-400/40 transition-colors cursor-pointer"
                )}
            >
                {options.map((opt) => (
                    <option key={opt} value={opt}>
                        {opt}
                    </option>
                ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-white/30 pointer-events-none" />
        </div>
    );
}

function renderInputControl(
    key: string,
    value: string,
    schema: cexParamDef | undefined,
    onChange: (next: string) => void
) {
    if (schema?.uiControl === "datetime" || schema?.format === "iso8601") {
        return <DatetimeCalendarField valueStr={value} onChange={onChange} minNow={schema.uiConstraints?.minNow} />;
    }
    if (schema?.type === "boolean") {
        return (
            <label className="flex items-center gap-2 text-xs text-white/80">
                <input
                    type="checkbox"
                    checked={value === "true"}
                    onChange={(e) => onChange(e.target.checked ? "true" : "false")}
                    className="size-4 rounded border border-white/20 bg-white/5"
                />
                {schema.description ?? formatLabel(key)}
            </label>
        );
    }
    if (schema?.type === "enum" && schema.enum && schema.enum.length > 0) {
        return schema.enum.length <= 6 ? (
            <PillSelect value={value} options={[...schema.enum]} onChange={onChange} />
        ) : (
            <StyledSelect value={value} options={[...schema.enum]} onChange={onChange} />
        );
    }
    if (schema?.type === "array") {
        return (
            <ArrayChipsField
                value={value}
                placeholder={schema?.example ? `e.g. ${schema.example}` : undefined}
                onChange={onChange}
            />
        );
    }
    return (
        <TextInput
            value={value}
            type={schema?.type}
            placeholder={schema?.example ? `e.g. ${schema.example}` : undefined}
            onChange={onChange}
        />
    );
}

export const HumanInputDialog: React.FC<HumanInputDialogProps> = ({
    isOpen,
    data,
    onApprove,
    onReject,
    onApproveAllRemaining,
    agentId,
}) => {
    const [values, setValues] = useState<Record<string, string>>({});
    const [uiLevel, setUiLevel] = useState<1 | 2>(data.confirmationLevel ?? 1);
    const [agreed, setAgreed] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);
    const queryClient = useQueryClient();

    // §7.4 — single canonical surface for trading approvals. This dialog
    // renders both generic and CEX interrupts: when `data.actionName` is
    // `create_order` / `preview_order`, the body switches to the
    // polished Binance-style `TradingOrderEditor` below; other actions
    // fall back to the generic per-field renderer. The
    // `detectApprovalSurface` classifier still exists for telemetry
    // callers but is no longer used to gate this surface.

    // Stable empty-schema sentinel so referential-equality dep checks don't fire on every render
    // when `data.fieldSchema` is null. Using `data.fieldSchema ?? {}` inline would mint a fresh
    // object each render and re-run the init effect / defeat the entries memo.
    const schema = useMemo(() => data.fieldSchema ?? EMPTY_SCHEMA, [data.fieldSchema]);

    useEffect(() => {
        if (!isOpen) return;
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(data.fields ?? {})) next[k] = stringifyHumanInputValue(v);
        for (const k of Object.keys(schema)) {
            if (next[k] === undefined) next[k] = "";
        }
        setValues(next);
        setUiLevel(data.confirmationLevel ?? 1);
        setAgreed(false);
        setValidationError(null);
    }, [isOpen, data, schema]);

    const UI_HIDDEN_FIELDS = useMemo(
        () => new Set([
            "userId", "user_id", "exchange", "client_order_id",
            // Hidden marker that `TradingOrderEditor` sets when its inline
            // validators flag a blocking error. Used to disable the
            // Confirm button but never submitted to the server.
            "__editor_blocking",
            // Server-side `expandCancelAllWithFallback` populates
            // `order_ids` for cancel_order with `all_open=true` before
            // the modal opens, so the checkbox is redundant — the user
            // can already add/remove ids in the field. We keep the flag
            // submittable (server falls back to fan-out when memory +
            // venue both miss) but stop rendering the checkbox.
            "all_open",
        ]),
        [],
    );

    // Resolve the trade side once per render so the action button can
    // render in venue-canonical BUY/SELL colors (green / red).
    const resolvedSide = useMemo(
        () => resolveSide(data.fields as Record<string, unknown> | undefined, values),
        [data.fields, values],
    );

    // F10.3 — live market-snapshot polling for the approval modal.
    // Before this, the panel data was frozen at modal-open time (the
    // server's enrichment block ran once inside `requestParameterReview`
    // and the SSE payload carried a single immutable `market_snapshot`).
    // The hook polls `/agents/:agentId/cex/market-snapshot` every 5 s
    // while the modal is open AND the action is a write order, so bid /
    // ask / spread / 24 h stats / depth visibly track the market. The
    // SSE-delivered snapshot is still used as the immediate first-paint
    // value via the `??` fallback at the render site, so there's no
    // flicker before the first poll resolves.
    const liveSnapshotInputs = useMemo(() => {
        const symbol =
            (typeof values.product_id === "string" && values.product_id) ||
            (typeof values.symbol === "string" && values.symbol) ||
            (typeof data.fields?.product_id === "string" ? data.fields.product_id : "") ||
            (typeof data.fields?.symbol === "string" ? data.fields.symbol : "") ||
            "";
        const venue =
            (typeof data.fields?.exchange === "string" && data.fields.exchange) ||
            "binance";
        // Pull the limit_price out of the live values' order_configuration
        // when the active variant is a limit shape, so slippage/est-fill
        // get computed for the freshest user input rather than the
        // approval-time snapshot.
        let limit_price: string | undefined;
        const parsed = parseOrderConfiguration(values.order_configuration);
        const inner = (parsed?.inner ?? {}) as Record<string, unknown>;
        if (typeof inner.limit_price === "string" && inner.limit_price.trim()) {
            limit_price = inner.limit_price.trim();
        }
        return { symbol, venue, limit_price };
    }, [values.product_id, values.symbol, values.order_configuration, data.fields]);

    const isLiveSnapshotAction =
        data.actionName === "create_order" ||
        data.actionName === "amend_order" ||
        data.actionName === "preview_order";

    const liveSnapshotQuery = useMarketSnapshot({
        agentId: agentId ?? null,
        symbol: liveSnapshotInputs.symbol,
        venue: liveSnapshotInputs.venue,
        side: resolvedSide ?? undefined,
        limit_price: liveSnapshotInputs.limit_price,
        action_name: data.actionName ?? "create_order",
        enabled: isOpen && isLiveSnapshotAction && !!liveSnapshotInputs.symbol,
    });

    const entries = useMemo(() => {
        const schemaKeys = Object.keys(schema);
        if (schemaKeys.length > 0) {
            return schemaKeys
                .filter((k) => schema[k]?.injected !== true && !UI_HIDDEN_FIELDS.has(k))
                .map((k) => [k, values[k] ?? ""] as const);
        }
        return Object.entries(values).filter(([k]) => !UI_HIDDEN_FIELDS.has(k));
    }, [schema, values, UI_HIDDEN_FIELDS]);

    if (!isOpen) return null;

    // Validate types/required-ness for every field. Used both as the gate for the
    // step 1 → 2 transition and as the final pre-submit check. Returns the parsed
    // payload on success, or null on validation failure (which sets validationError).
    const validateEntries = (): Record<string, unknown> | null => {
        try {
            const parsed: Record<string, unknown> = {};
            // M4c iter7 (post-PR247): when cancel_order has `all_open=true`,
            // the venue layer fans out across the user's open orders and
            // does NOT need `order_ids`. Suppress the "order_ids is required"
            // gate so Confirm Cancel can fire. The backend validator
            // (validateCancelOrderParams) and the canonical schema preflight
            // both accept order_ids=[] when all_open=true (iter6 + iter7).
            const allOpenActive =
                data.actionName === "cancel_order" &&
                (values.all_open === "true" || values.all_open === true as unknown as string);
            for (const [k, v] of entries) {
                if (allOpenActive && k === "order_ids") {
                    // Skip the required gate for order_ids when all_open is set.
                    const value = parseHumanInputValue(v, schema[k]?.type);
                    if (value !== undefined) parsed[k] = value;
                    continue;
                }
                if (isHumanInputFieldMissing(v, schema[k])) {
                    setValidationError(`${formatLabel(k)} is required`);
                    return null;
                }
                const value = parseHumanInputValue(v, schema[k]?.type);
                if (value !== undefined) {
                    parsed[k] = value;
                }
            }
            const preflight = preflightCheck(parsed);
            if (preflight) {
                setValidationError(preflight);
                return null;
            }
            return parsed;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setValidationError(`Invalid field value: ${message}`);
            return null;
        }
    };

    // Single-confirm flow: when the backend sets confirmationsRequired === 1,
    // the step-1 view includes the agreement checkbox + Submit; there is no
    // step 2. This collapses the prior "Review → Submit-twice" pattern to
    // one click while preserving the explicit-consent gate.
    const singleConfirmMode = (data.confirmationsRequired ?? 2) === 1;

    // post-iter10 auto-refresh: when the user confirms a `set_trading_mode`
    // modal from the chat, the React Query cache that powers <ModeBadge>
    // (sidebar pill, approval modal, etc.) would otherwise stay stale until
    // the 30 s staleTime expires or the window refocuses, so the badge keeps
    // showing the OLD mode for half a minute after the chat says "switched".
    // Optimistically write the new mode into the cache. We deliberately do
    // NOT call invalidateQueries here: the chat-side backend update happens
    // after `onApprove`, so an eager refetch can race that update and clobber
    // the optimistic value with the stale pre-switch mode for 30 seconds.
    // The optimistic write is enough for instant UX; the next legitimate
    // refetch (window focus or staleTime expiry) reconciles with the server.
    const primeTradingModeCacheAfterConfirm = (parsed: Record<string, unknown>) => {
        if (data.actionName !== "set_trading_mode") return;
        const candidate = (parsed.mode ?? parsed.default_mode);
        if (typeof candidate !== "string") return;
        const newMode = candidate.toLowerCase() as TradingMode;
        if (!VALID_TRADING_MODES.has(newMode)) return;
        queryClient.setQueryData<TradingPreferences | null>(
            TRADING_PREFERENCES_QUERY_KEY,
            (old) => (old ? { ...old, default_mode: newMode } : ({ default_mode: newMode } as TradingPreferences)),
        );
    };

    const handleConfirm = () => {
        if (singleConfirmMode) {
            if (!agreed) return;
            const parsed = validateEntries();
            if (parsed === null) return;
            primeTradingModeCacheAfterConfirm(parsed);
            onApprove(parsed);
            return;
        }
        if (uiLevel === 1) {
            // Block the step transition until the entered values parse and required
            // fields are populated. Otherwise the user reaches step 2, sees
            // "Not provided" for required fields, and only learns of the failure
            // after clicking Submit.
            if (validateEntries() === null) return;
            setUiLevel(2);
            setAgreed(false);
            return;
        }
        const parsed = validateEntries();
        if (parsed === null) return;
        primeTradingModeCacheAfterConfirm(parsed);
        onApprove(parsed);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4" data-testid="human-input-dialog">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-none" />
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
                    <div className="flex items-center gap-3">
                        {singleConfirmMode ? (
                            <span className="text-[11px] text-amber-300/85 font-medium tracking-wide">
                                CONFIRM
                            </span>
                        ) : (
                            <>
                                <div className="flex items-center gap-1">
                                    <div className={cn("h-1.5 rounded-full transition-all duration-300", uiLevel === 1 ? "w-6 bg-amber-400" : "w-3 bg-amber-400/40")} />
                                    <div className={cn("h-1.5 rounded-full transition-all duration-300", uiLevel === 2 ? "w-6 bg-amber-400" : "w-3 bg-white/15")} />
                                </div>
                                <span className="text-[11px] text-white/35 font-medium tracking-wide">
                                    STEP {uiLevel} OF {data.confirmationsRequired ?? 2}
                                </span>
                            </>
                        )}
                    </div>
                    <button onClick={onReject} className="w-7 h-7 rounded-full flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/8 transition-colors">
                        <X className="size-4" />
                    </button>
                </div>

                <div className="px-5 pb-3">
                    {/* M5 iter6 (post-PR246): for set_trading_mode, render
                        the target mode in the title and add a one-line
                        explanation so the user knows exactly which mode
                        they are about to switch to before confirming. */}
                    {(() => {
                        const targetMode = (values?.mode ?? (data.fields as Record<string, unknown> | undefined)?.mode) as string | undefined;
                        const customTitle = modeAwareTitle(data.actionName, targetMode);
                        const modeLower = (targetMode || "").trim().toLowerCase();
                        const isLive = modeLower === "live";
                        const isPaper = modeLower === "paper";
                        const isShadow = modeLower === "shadow";
                        const accent = isLive
                            ? "text-emerald-300"
                            : isPaper
                              ? "text-amber-300"
                              : isShadow
                                ? "text-slate-300"
                                : "text-white";
                        return (
                            <>
                                <h2 className={cn("text-base font-semibold tracking-tight", customTitle ? accent : "text-white")}>
                                    {customTitle ?? data.title}
                                </h2>
                                {data.description ? (
                                    <p className="text-xs text-white/35 mt-0.5">{data.description}</p>
                                ) : null}
                                {data.actionName === "set_trading_mode" && MODE_DESCRIPTIONS[modeLower] ? (
                                    <p className="text-xs text-white/55 mt-1.5">{MODE_DESCRIPTIONS[modeLower]}</p>
                                ) : null}
                            </>
                        );
                    })()}
                </div>

                {/* CEX post-PR237 Commit 4 — Multi-step plan badge.
                    Shown when the backend plan runner emits this modal
                    as part of a multi-write plan, so the user can see
                    which order they're confirming and that more
                    confirmations are pending. */}
                {data.plan_context && data.plan_context.total_steps > 1 ? (
                    <div className="mx-5 mb-3 rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium text-amber-300/85">
                                Plan step {data.plan_context.step_index + 1} of{" "}
                                {data.plan_context.total_steps}
                            </span>
                            {data.plan_context.step_summaries?.[
                                data.plan_context.step_index
                            ] ? (
                                <span className="text-[10px] text-white/40 font-mono truncate ml-2 max-w-[60%]">
                                    {
                                        data.plan_context.step_summaries[
                                            data.plan_context.step_index
                                        ]
                                    }
                                </span>
                            ) : null}
                        </div>
                        {data.plan_context.total_steps -
                            data.plan_context.step_index -
                            1 >
                        0 ? (
                            <p className="text-[10px] text-white/35 mt-1">
                                {data.plan_context.total_steps -
                                    data.plan_context.step_index -
                                    1}{" "}
                                more order(s) will follow after this one.
                            </p>
                        ) : null}
                    </div>
                ) : null}

                {(() => {
                    const exchangeBadge =
                        typeof data.fields?.exchange === "string" ? data.fields.exchange.trim() : "";
                    const actionLabel = data.actionName
                        ? data.actionName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
                        : "";
                    if (!exchangeBadge && !actionLabel) return null;
                    return (
                        <div className="px-5 pb-3 flex items-center gap-2 flex-wrap">
                            {actionLabel && (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-300">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                    {actionLabel}
                                </span>
                            )}
                            {exchangeBadge && (
                                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-white/5 border border-white/10 text-white/50 capitalize">
                                    {exchangeBadge}
                                </span>
                            )}
                        </div>
                    );
                })()}

                <div className="h-px bg-white/5 mx-5" />

                <div className="px-5 py-3">
                    {uiLevel === 1 ? (
                        data.actionName === "create_order" || data.actionName === "preview_order" ? (
                            /* Binance-style editable form for create_order /
                               preview_order. Replaces the generic
                               label/value entries loop AND the redundant
                               "Preview" card. The editor IS the review:
                               every field is editable in-place and the
                               user can see Pair, Price, Amount, Total,
                               Margin, Avbl / Max / Est Fee at a glance. */
                            <div className="max-h-[60vh] overflow-y-auto pr-1">
                                <TradingOrderEditor
                                    values={values}
                                    setValues={(updater) => {
                                        setValidationError(null);
                                        setValues(updater);
                                    }}
                                    onAnyChange={() => setValidationError(null)}
                                    venue={typeof data.fields?.exchange === "string" ? data.fields.exchange : null}
                                    accountSnapshot={data.accountSnapshot ?? null}
                                    agentId={agentId ?? null}
                                />
                                {/* CEX post-PR237 Commit 3 — Live ticker /
                                    order-book / 24h-stats snapshot panel,
                                    migrated from the dormant
                                    CEXApprovalDialog. Renders nothing
                                    when the server's modal-enrichment
                                    block was skipped / all fetches
                                    timed out — defensively, no extra
                                    chrome when there's no data.

                                    F10.3 — the snapshot is now live.
                                    `useMarketSnapshot` polls every 5 s
                                    while the modal is open, and the
                                    `??` fallbacks below give the
                                    SSE-delivered values the first
                                    paint so there's no flicker before
                                    the first poll resolves. The
                                    `symbol_verification` banner keeps
                                    the LLM-mismatch-banner semantics
                                    from the SSE payload (free-text
                                    intents still need it). */}
                                <MarketSnapshotPanel
                                    snapshot={
                                        liveSnapshotQuery.data?.market_snapshot
                                        ?? data.market_snapshot
                                    }
                                    verification={
                                        data.symbol_verification
                                        ?? liveSnapshotQuery.data?.symbol_verification
                                    }
                                    venue={
                                        typeof data.fields?.exchange === "string"
                                            ? data.fields.exchange
                                            : undefined
                                    }
                                />
                            </div>
                        ) : (
                            <div className="space-y-3 max-h-[52vh] overflow-y-auto pr-1">
                                {entries.map(([key, value]) => (
                                    <div key={key}>
                                        <div className="flex items-center justify-between mb-1.5">
                                            <label className="text-xs text-white/45 font-medium">
                                                {formatLabel(key)}
                                                {schema[key]?.required === true ? <span className="text-amber-400/90 ml-1">*</span> : null}
                                            </label>
                                        </div>
                                        {renderInputControl(key, value, schema[key], (next) => {
                                            setValidationError(null);
                                            setValues((prev) => ({ ...prev, [key]: next }));
                                        })}
                                    </div>
                                ))}
                            </div>
                        )
                    ) : data.actionName === "create_order" || data.actionName === "preview_order" ? (
                        /* Polished create-order summary card — Pair, Side chip,
                           Order Type + TIF chips, Quantity, Limit Price,
                           Estimated Total, Stop/Post-Only/End-Time when set. */
                        <OrderConfigSummaryCard
                            orderConfig={(() => {
                                const e = entries.find(([k]) => k === "order_configuration");
                                return e ? e[1] : undefined;
                            })()}
                            pair={(() => {
                                const p = entries.find(([k]) => k === "product_id" || k === "symbol");
                                return p ? p[1] : null;
                            })()}
                            side={(() => {
                                const s = entries.find(([k]) => k === "side");
                                return s ? s[1] : null;
                            })()}
                            venue={typeof data.fields?.exchange === "string" ? data.fields.exchange : null}
                            previewId={(() => {
                                const p = entries.find(([k]) => k === "preview_id");
                                return p ? p[1] || null : null;
                            })()}
                            retailPortfolioId={(() => {
                                const r = entries.find(([k]) => k === "retail_portfolio_id");
                                return r ? r[1] || null : null;
                            })()}
                            accountSnapshot={data.accountSnapshot ?? null}
                        />
                    ) : (
                        <div className="rounded-xl border border-white/8 overflow-hidden">
                            {entries.map(([key, value], i) => (
                                <div key={key} className={cn("flex items-center gap-3 px-4 py-3", i < entries.length - 1 && "border-b border-white/5")}>
                                    <span className="text-xs text-white/40 w-36 flex-shrink-0">{formatLabel(key)}</span>
                                    <span className="text-sm font-mono flex-1 text-white/80">{value || "Not provided"}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {uiLevel === 2 || singleConfirmMode ? (
                    <div className="mx-5 mt-2 mb-1">
                        <label className="flex items-start gap-3 cursor-pointer select-none p-3 rounded-xl hover:bg-white/3 transition-colors">
                            <div
                                className={cn(
                                    "mt-0.5 rounded-md border-2 flex-shrink-0 flex items-center justify-center transition-all duration-150",
                                    agreed ? "bg-amber-400 border-amber-400" : "border-white/20 hover:border-white/40"
                                )}
                                style={{ width: 18, height: 18 }}
                                onClick={() => setAgreed((v) => !v)}
                            >
                                {agreed ? <Check className="size-2.5 text-black" strokeWidth={3} /> : null}
                            </div>
                            <span className="text-[12px] text-white/45 leading-relaxed">
                                I confirm these inputs are correct and authorize this action.
                            </span>
                        </label>
                    </div>
                ) : null}

                <div className="h-px bg-white/5 mx-5 mt-2" />

                <div className="px-5 py-4 flex gap-3 flex-wrap">
                    <button
                        onClick={singleConfirmMode || uiLevel === 1 ? onReject : () => setUiLevel(1)}
                        className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl flex-1 text-sm font-medium text-white/40 bg-white/5 border border-white/8 hover:bg-white/8 hover:text-white/60 transition-all duration-150"
                    >
                        {singleConfirmMode || uiLevel === 1 ? (
                            <>
                                <X className="size-3.5" />
                                Cancel
                            </>
                        ) : (
                            <>
                                <ArrowLeft className="size-3.5" />
                                Back
                            </>
                        )}
                    </button>
                    {/* CEX post-PR237 Commit 4 — Approve All Remaining
                        button for multi-step plans. Calls the parent's
                        onApproveAllRemaining hook which translates to
                        an APPROVE_BATCH plan continuation. Only shown
                        when the backend has flagged the plan as safe
                        for batch approval AND there's at least one
                        remaining step after this one. */}
                    {onApproveAllRemaining &&
                    data.plan_context?.approve_all_supported &&
                    data.plan_context.total_steps -
                        data.plan_context.step_index -
                        1 >
                        0 ? (
                        <button
                            onClick={onApproveAllRemaining}
                            disabled={
                                values.__editor_blocking === "1" ||
                                data.symbol_verification?.matches === false
                            }
                            className={cn(
                                "flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-all duration-150",
                                "bg-amber-500/15 text-amber-200 border border-amber-400/30 hover:bg-amber-500/25",
                                "disabled:opacity-40 disabled:cursor-not-allowed",
                            )}
                            data-testid="approve-all-remaining"
                        >
                            Approve All Remaining (
                            {data.plan_context.total_steps -
                                data.plan_context.step_index}
                            )
                        </button>
                    ) : null}
                    <button
                        onClick={handleConfirm}
                        disabled={
                            ((singleConfirmMode || uiLevel === 2) && !agreed) ||
                            // `TradingOrderEditor` sets this hidden marker when
                            // any of its inline validators flag a blocking
                            // problem (missing Price, sub-min notional, bad
                            // trailing bps, missing OCO legs, GTD without
                            // expiry, etc.). Mirrored here so the submit
                            // button can't fire requests the canonical-intent
                            // validator will just reject.
                            values.__editor_blocking === "1" ||
                            // CEX post-PR237 Commit 3 — symbol verification
                            // failed. The MarketSnapshotPanel renders a red
                            // banner; we also block Confirm so the user
                            // can't accidentally BTC->ETH bait-and-switch.
                            data.symbol_verification?.matches === false
                        }
                        className={cn(
                            "flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl flex-[2] text-sm font-semibold transition-all duration-150",
                            singleConfirmMode
                                ? agreed
                                    ? sideToButtonClass(resolvedSide, "submit")
                                    : "bg-white/5 text-white/20 cursor-not-allowed"
                                : uiLevel === 1
                                    ? "bg-amber-400 text-black hover:bg-amber-300 shadow-[0_4px_20px_-4px_rgba(251,191,36,0.4)]"
                                    : agreed
                                      ? sideToButtonClass(resolvedSide, "submit")
                                      : "bg-white/5 text-white/20 cursor-not-allowed"
                        )}
                    >
                        {(singleConfirmMode || uiLevel === 2) ? (
                            <>
                                <CheckCircle2 className="size-4" />
                                <span>{sideToButtonLabel(resolvedSide, data.actionName, (values?.mode ?? (data.fields as Record<string, unknown> | undefined)?.mode) as string | null | undefined)}</span>
                            </>
                        ) : (
                            <>
                                <span>Confirm</span>
                                <ChevronRight className="size-4" />
                            </>
                        )}
                    </button>
                </div>
                {validationError ? (
                    <div className="px-5 pb-4 -mt-2">
                        <div className="text-[12px] text-rose-300/90 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                            {validationError}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
};
