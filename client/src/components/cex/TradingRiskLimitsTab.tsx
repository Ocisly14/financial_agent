import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { toast } from "sonner";
import {
    useTradingPreferences,
    useUpdateTradingPreferences,
} from "@/hooks/useTradingPreferences";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api";
import { ModeBadge } from "./ModeBadge";
import { cn } from "@/lib/utils";
import {
    LIVE_TRADING_CONSENT_ACCEPTED_EVENT,
    LIVE_TRADING_CONSENT_OPEN_EVENT,
} from "./LiveTradingConsentModal";

const HARD_CAP_NOTIONAL_USD = 10_000_000;
const HARD_CAP_LEVERAGE = 10;
// 2026-05-25 hardening (QA H-3): when the server returns no allowlist
// configured (a fresh account, or one created before the default was
// added), show this conservative starter set so the placeholder reflects
// reality and the user has to opt-in to widen it.
const DEFAULT_ALLOWLIST = ["BTC", "ETH", "SOL", "USDT", "USDC"];

/**
 * §7.3 — Trading Risk Limits panel inside SettingsDialog. Source of truth:
 * `user_trading_preferences` collection. Server-side hard cap is enforced
 * regardless of UI values.
 */
export function TradingRiskLimitsTab() {
    const prefs = useTradingPreferences();
    const update = useUpdateTradingPreferences();

    const [maxOrder, setMaxOrder] = useState<string>("");
    const [dailyLoss, setDailyLoss] = useState<string>("");
    const [slippage, setSlippage] = useState<number>(50);
    const [allowlist, setAllowlist] = useState<string>("");
    const [blocklist, setBlocklist] = useState<string>("");
    const [cooldown, setCooldown] = useState<string>("60");
    const [mode, setMode] = useState<"paper" | "shadow" | "live">("paper");
    const [maxLeverage, setMaxLeverage] = useState<string>("5");
    const [hasConsent, setHasConsent] = useState<boolean | null>(null);

    useEffect(() => {
        if (!prefs.data) return;
        setMaxOrder(String(prefs.data.max_order_notional_usd ?? 1000));
        setDailyLoss(String(prefs.data.daily_loss_limit_usd ?? 200));
        setSlippage(Number(prefs.data.slippage_bps_max ?? 50));
        const storedAllowlist = prefs.data.asset_allowlist;
        setAllowlist(
            Array.isArray(storedAllowlist) && storedAllowlist.length > 0
                ? storedAllowlist.join(", ")
                : DEFAULT_ALLOWLIST.join(", "),
        );
        setBlocklist((prefs.data.asset_blocklist ?? []).join(", "));
        setCooldown(String(prefs.data.cooldown_seconds_after_fail ?? 60));
        setMode((prefs.data.default_mode as never) ?? "paper");
        setMaxLeverage(String(prefs.data.max_leverage ?? 5));
    }, [prefs.data]);

    useEffect(() => {
        let cancelled = false;
        const refresh = () => {
            apiClient.getConsent("live_trading_tos", "v1").then(
                (r) => {
                    if (!cancelled) setHasConsent(!!r.consent);
                },
                () => {
                    if (!cancelled) setHasConsent(false);
                },
            );
        };
        refresh();
        // §7.8 — re-check consent after the global modal records it so the
        // live toggle becomes enabled without a full page reload.
        const onAccepted = () => refresh();
        window.addEventListener(LIVE_TRADING_CONSENT_ACCEPTED_EVENT, onAccepted);
        return () => {
            cancelled = true;
            window.removeEventListener(LIVE_TRADING_CONSENT_ACCEPTED_EVENT, onAccepted);
        };
    }, []);

    const liveDisabled = !hasConsent;
    const openConsentModal = () =>
        window.dispatchEvent(new CustomEvent(LIVE_TRADING_CONSENT_OPEN_EVENT));

    const parseAssets = (s: string): string[] =>
        s
            .split(/[,\s]+/)
            .map((x) => x.trim().toUpperCase())
            .filter((x) => x.length > 0);

    const save = () => {
        const maxOrderNum = Number(maxOrder);
        const dailyLossNum = Number(dailyLoss);
        const cooldownNum = Number(cooldown);
        const maxLeverageNum = Number(maxLeverage);
        if (Number.isNaN(maxOrderNum) || maxOrderNum <= 0) {
            toast.error("max order notional must be a positive number");
            return;
        }
        if (maxOrderNum > HARD_CAP_NOTIONAL_USD) {
            toast.error(`max order notional exceeds platform hard cap ($${HARD_CAP_NOTIONAL_USD.toLocaleString()})`);
            return;
        }
        if (
            Number.isNaN(maxLeverageNum) ||
            maxLeverageNum < 1 ||
            maxLeverageNum > HARD_CAP_LEVERAGE
        ) {
            toast.error(`max leverage must be between 1 and ${HARD_CAP_LEVERAGE}`);
            return;
        }
        update.mutate(
            {
                max_order_notional_usd: maxOrderNum,
                daily_loss_limit_usd: dailyLossNum,
                slippage_bps_max: slippage,
                asset_allowlist: parseAssets(allowlist),
                asset_blocklist: parseAssets(blocklist),
                cooldown_seconds_after_fail: cooldownNum,
                default_mode: mode,
                max_leverage: maxLeverageNum,
            },
            {
                onSuccess: (res) => {
                    if (!res.success) {
                        toast.error(res.message ?? "Failed to update preferences");
                        return;
                    }
                    toast.success("Risk limits updated");
                },
                onError: (err: unknown) => {
                    const msg =
                        err && typeof err === "object" && "message" in err
                            ? String((err as { message: unknown }).message)
                            : String(err);
                    toast.error(msg);
                },
            },
        );
    };

    if (prefs.isLoading) {
        return <div className="text-sm text-white/50">Loading risk limits…</div>;
    }

    return (
        <div className="space-y-5">
            <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">Trading Risk Limits</h2>
                <ModeBadge mode={mode} />
            </div>

            <div className="space-y-1">
                <Label htmlFor="max-order">Max order notional (USD)</Label>
                <Input
                    id="max-order"
                    type="number"
                    step={10}
                    value={maxOrder}
                    onChange={(e) => setMaxOrder(e.target.value)}
                />
                <p className="text-xs text-white/40">
                    Refuses any submit larger than this. Hard platform cap: $
                    {HARD_CAP_NOTIONAL_USD.toLocaleString()}.
                </p>
            </div>

            <div className="space-y-1">
                <Label htmlFor="daily-loss">Daily loss limit (USD)</Label>
                <Input
                    id="daily-loss"
                    type="number"
                    step={10}
                    value={dailyLoss}
                    onChange={(e) => setDailyLoss(e.target.value)}
                />
                <p className="text-xs text-white/40">
                    Refuses new orders after cumulative realized loss exceeds this in a 24-hour window.
                </p>
            </div>

            <div className="space-y-1">
                <Label htmlFor="slippage">Max slippage (bps): {slippage}</Label>
                <input
                    id="slippage"
                    type="range"
                    min={1}
                    max={500}
                    value={slippage}
                    onChange={(e) => setSlippage(Number(e.target.value))}
                    className="w-full"
                />
            </div>

            <div className="space-y-1">
                <Label htmlFor="max-leverage">Max leverage (1–{HARD_CAP_LEVERAGE}x)</Label>
                <Input
                    id="max-leverage"
                    type="number"
                    min={1}
                    max={HARD_CAP_LEVERAGE}
                    step={1}
                    value={maxLeverage}
                    onChange={(e) => setMaxLeverage(e.target.value)}
                />
                <p className="text-xs text-white/40">
                    Refuses any order whose leverage exceeds this. Platform hard cap: {HARD_CAP_LEVERAGE}x.
                </p>
            </div>

            <div className="space-y-1">
                <Label htmlFor="allow">Asset allowlist (comma-separated)</Label>
                <Input
                    id="allow"
                    value={allowlist}
                    onChange={(e) => setAllowlist(e.target.value)}
                    placeholder="BTC, ETH, SOL, USDT, USDC"
                />
                <p className="text-xs text-white/40">
                    Only these base assets can be traded. Restricted assets (LUNA, FTT, …) are blocked by the platform regardless of this list.
                </p>
            </div>

            <div className="space-y-1">
                <Label htmlFor="block">Asset blocklist</Label>
                <Input
                    id="block"
                    value={blocklist}
                    onChange={(e) => setBlocklist(e.target.value)}
                    placeholder="USDT-only assets, etc."
                />
            </div>

            <div className="space-y-1">
                <Label htmlFor="cooldown">Cooldown after failure (seconds)</Label>
                <Input
                    id="cooldown"
                    type="number"
                    step={10}
                    min={10}
                    max={3600}
                    value={cooldown}
                    onChange={(e) => setCooldown(e.target.value)}
                />
            </div>

            <div className="space-y-2">
                <Label>Default mode</Label>
                <div className="inline-flex rounded-lg ring-1 ring-white/10 p-0.5 bg-white/5">
                    {(["paper", "shadow", "live"] as const).map((m) => {
                        const liveLocked = m === "live" && liveDisabled;
                        return (
                            <button
                                key={m}
                                type="button"
                                onClick={() => {
                                    if (liveLocked) {
                                        openConsentModal();
                                        return;
                                    }
                                    setMode(m);
                                }}
                                className={cn(
                                    "px-3 py-1 text-xs uppercase tracking-wider rounded-md transition-colors",
                                    mode === m
                                        ? m === "live"
                                            ? "bg-emerald-500/30 text-emerald-100"
                                            : m === "shadow"
                                              ? "bg-amber-500/30 text-amber-100"
                                              : "bg-slate-500/30 text-slate-100"
                                        : "text-white/60 hover:text-white",
                                    liveLocked && "opacity-60",
                                )}
                            >
                                {m}
                            </button>
                        );
                    })}
                </div>
                {liveDisabled && (
                    <p className="flex items-center gap-1 text-xs text-amber-300/80">
                        <Info className="size-3.5" />
                        Live mode is locked until you accept the live-trading TOS.{" "}
                        <button
                            type="button"
                            className="underline underline-offset-2 hover:text-amber-100"
                            onClick={openConsentModal}
                        >
                            Open consent
                        </button>
                    </p>
                )}
            </div>

            <div className="pt-2 flex justify-end gap-2">
                <Button onClick={save} disabled={update.isPending}>
                    {update.isPending ? "Saving…" : "Save"}
                </Button>
            </div>
        </div>
    );
}
