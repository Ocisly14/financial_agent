import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The real trading mode, derived from strategy data rather than declared.
 * `PriceStrategyDSL.mode`'s TS union only names "paper" | "shadow", but the
 * backend does write "live" onto the record — `src/trading/strategyMonitor.ts`
 * immediately pauses any strategy found in that mode, since no live broker is
 * wired up. Checking for it here, not assuming PAPER, is what makes this a
 * fact instead of a guess.
 *
 * Shared by the status bar and the strategies page masthead so there is one
 * source of truth instead of a hardcoded string on each.
 */
export function useTradingMode(): "paper" | "live" {
    const { data } = useQuery({
        queryKey: ["user", "strategies"],
        queryFn: async () => (await apiClient.listStrategies()).strategies,
        refetchInterval: 15_000,
    });
    const isLive = (data ?? []).some(
        (s) => (s.status === "active" || s.status === "running") && (s.dsl.mode as string) === "live",
    );
    return isLive ? "live" : "paper";
}

/**
 * `mode` covers two different things by design, not by accident:
 *  - "paper" | "live" — the app-wide trading mode from `useTradingMode`,
 *    shown in the status bar and the strategies masthead.
 *  - "shadow" — a per-strategy value straight from `PriceStrategyDSL.mode`
 *    (see `types/core.ts`), which the app-wide mode never takes. The
 *    strategies table renders one of these per row, so the prop has to
 *    accept it rather than forcing shadow through the paper/live pair.
 */
export function ModeChip({ mode }: { mode: "paper" | "shadow" | "live" }) {
    const { t } = useTranslation();
    const tone = mode === "live" ? "up" : mode === "shadow" ? "hold" : "neutral";
    const label =
        mode === "live"
            ? t("workspace.statusBar.modeLive")
            : mode === "shadow"
              ? t("workspace.statusBar.modeShadow")
              : t("workspace.statusBar.modePaper");
    return (
        <span
            className={cn(
                "fin-label inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[4px] border px-1.5",
                tone === "up" ? "border-up/40 text-up" : tone === "hold" ? "border-hold/40 text-hold" : "border-sep text-label-3",
            )}
        >
            <span
                className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    tone === "up" ? "bg-up" : tone === "hold" ? "bg-hold" : "bg-fill-3",
                )}
                aria-hidden="true"
            />
            {label}
        </span>
    );
}
