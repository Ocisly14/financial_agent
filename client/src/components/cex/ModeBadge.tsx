import { cn } from "@/lib/utils";
import { useTradingPreferences } from "@/hooks/useTradingPreferences";
import type { TradingMode } from "@/hooks/useTradingPreferences";
import { useMemo } from "react";

interface ModeBadgeProps {
    /** Explicit mode wins over the prefs hook (useful in approval dialogs). */
    mode?: TradingMode;
    className?: string;
    showLabel?: boolean;
}

const MODE_STYLES: Record<TradingMode, { ring: string; bg: string; text: string; pulse?: boolean }> = {
    paper: {
        ring: "ring-slate-400/40",
        bg: "bg-slate-500/15",
        text: "text-slate-200",
    },
    shadow: {
        ring: "ring-amber-400/40",
        bg: "bg-amber-500/15",
        text: "text-amber-200",
    },
    live: {
        ring: "ring-emerald-400/50",
        bg: "bg-emerald-500/20",
        text: "text-emerald-200",
        pulse: true,
    },
};

const MODE_LABELS: Record<TradingMode, string> = {
    paper: "Paper",
    shadow: "Shadow",
    live: "LIVE",
};

const MODE_TOOLTIPS: Record<TradingMode, string> = {
    paper: "Paper mode — simulated orders, no real money at risk.",
    shadow: "Shadow mode — hypothetical decisions logged for analysis, no execution.",
    live: "LIVE mode — real orders are submitted to the exchange.",
};

/**
 * §7.1 — Mode badge. Renders the user's current trading mode so write
 * actions can't be confused. Designed to be visible at the chat header, in
 * the approval modal, and in the sidebar.
 */
export function ModeBadge({ mode, className, showLabel = true }: ModeBadgeProps) {
    const prefs = useTradingPreferences();
    const resolved: TradingMode = mode ?? (prefs.data?.default_mode ?? "paper");
    const styles = MODE_STYLES[resolved];

    const dotClass = useMemo(
        () =>
            cn(
                "inline-block w-1.5 h-1.5 rounded-full",
                resolved === "live"
                    ? "bg-emerald-400"
                    : resolved === "shadow"
                      ? "bg-amber-400"
                      : "bg-slate-400",
                styles.pulse && "animate-pulse",
            ),
        [resolved, styles.pulse],
    );

    return (
        <span
            title={MODE_TOOLTIPS[resolved]}
            className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md ring-1 font-mono text-[10px] uppercase tracking-wider",
                styles.bg,
                styles.text,
                styles.ring,
                className,
            )}
            data-mode={resolved}
        >
            <span className={dotClass} aria-hidden />
            {showLabel && <span>{MODE_LABELS[resolved]}</span>}
        </span>
    );
}
