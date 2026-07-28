import { useState } from "react";
import { AlertOctagon, X } from "lucide-react";
import { toast } from "sonner";
import { useToggleKillSwitch, useTradingPreferences } from "@/hooks/useTradingPreferences";
import { cn } from "@/lib/utils";

/**
 * §7.2 DoD — sticky full-width banner that surfaces the kill-switch state
 * everywhere in the app, not just inside the trading-prefs tab. Without this,
 * the only on-state indicator is the small red toggle in the Risk Limits tab
 * (or the title attribute on the sidebar pill) — easy to miss.
 *
 * Behavior:
 *  - Hidden when `kill_switch_active === false` (no padding, no DOM space).
 *  - Slides in at the top with a non-dismissible "Resume trading" button.
 *  - The "Hide for now" X is per-session (sessionStorage) so a user who has
 *    consciously read the banner can declutter without losing the safety
 *    invariant that any new chat session sees it again.
 */
export function KillSwitchBanner() {
    const prefs = useTradingPreferences();
    const toggle = useToggleKillSwitch();
    const [hiddenForSession, setHiddenForSession] = useState(() => {
        if (typeof window === "undefined") return false;
        return window.sessionStorage.getItem("kill-switch-banner-hidden") === "1";
    });

    const active = prefs.data?.kill_switch_active ?? false;
    if (!active || hiddenForSession) return null;

    const resume = () => {
        toggle.mutate(
            { active: false },
            {
                onSuccess: () => {
                    toast.success("Kill switch OFF — trading resumed");
                },
                onError: (err) => {
                    toast.error(
                        `Failed to toggle kill switch: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                },
            },
        );
    };

    const dismiss = () => {
        window.sessionStorage.setItem("kill-switch-banner-hidden", "1");
        setHiddenForSession(true);
    };

    return (
        <div
            role="alert"
            aria-live="polite"
            data-testid="kill-switch-banner"
            className={cn(
                "fixed top-0 inset-x-0 z-[80]",
                "bg-rose-700 text-white",
                "px-4 py-2",
                "flex items-center gap-3",
                "shadow-md",
            )}
        >
            <AlertOctagon className="size-5 shrink-0 animate-pulse" />
            <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold">
                    Trading paused — kill switch is ON.
                </span>
                <span className="ml-2 text-sm text-rose-100/90 hidden sm:inline">
                    All new orders are refused until you turn it off.
                </span>
            </div>
            <button
                type="button"
                onClick={resume}
                disabled={toggle.isPending}
                className={cn(
                    "px-3 py-1 rounded-md text-xs font-medium",
                    "bg-white/15 hover:bg-white/25 transition-colors",
                    "ring-1 ring-white/30",
                    "disabled:opacity-60",
                )}
            >
                {toggle.isPending ? "Resuming…" : "Resume trading"}
            </button>
            <button
                type="button"
                onClick={dismiss}
                aria-label="Hide banner for this session"
                className="p-1 rounded hover:bg-white/15 transition-colors"
            >
                <X className="size-4" />
            </button>
        </div>
    );
}
