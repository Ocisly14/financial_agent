import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

export type TradingMode = "paper" | "shadow" | "live";

export interface TradingPreferences {
    default_mode: TradingMode;
    kill_switch_active: boolean;
    max_order_notional_usd?: number;
    daily_loss_limit_usd?: number;
    slippage_bps_max?: number;
    asset_allowlist?: string[];
    asset_blocklist?: string[];
    cooldown_seconds_after_fail?: number;
    market_data_freshness_max_ms?: number;
    preferred_exchange?: string | null;
    preferred_language?: "en" | "zh-CN" | null;
    /** 2026-05-25 hardening (QA H-1) — refuses orders above this leverage. Hard-capped at 10x server-side. */
    max_leverage?: number;
}

const QUERY_KEY = ["user", "trading-preferences"] as const;

/**
 * §7.1 — read-side hook for the global trading-prefs cache. React Query
 * with a 30s stale-time so the mode badge / kill-switch indicator stay
 * close to truth without spamming the API.
 */
export function useTradingPreferences() {
    return useQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => {
            const res = await apiClient.getTradingPreferences();
            return res.preferences as TradingPreferences | null;
        },
        staleTime: 30_000,
        refetchOnWindowFocus: true,
    });
}

/**
 * §7.3 — write hook with optimistic update. Reverts on server error
 * (e.g. 451 geo-restricted, 412 consent-required).
 */
export function useUpdateTradingPreferences() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (patch: Partial<TradingPreferences>) => {
            const res = await apiClient.setTradingPreferences(patch);
            return res;
        },
        onMutate: async (patch) => {
            await qc.cancelQueries({ queryKey: QUERY_KEY });
            const prev = qc.getQueryData<TradingPreferences | null>(QUERY_KEY);
            qc.setQueryData<TradingPreferences | null>(QUERY_KEY, (old) =>
                old ? { ...old, ...patch } : (patch as TradingPreferences),
            );
            return { prev };
        },
        onError: (_err, _patch, ctx) => {
            if (ctx?.prev !== undefined) {
                qc.setQueryData(QUERY_KEY, ctx.prev);
            }
        },
        onSettled: () => {
            qc.invalidateQueries({ queryKey: QUERY_KEY });
        },
    });
}

/**
 * §7.2 — kill-switch toggle with optimistic flip. Distinct from the
 * generic prefs mutation so it can target the dedicated endpoint which
 * also writes a `kill_switch_events` audit row.
 */
export function useToggleKillSwitch() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (args: { active: boolean; reason?: string }) => {
            const res = await apiClient.setKillSwitch(args.active, args.reason);
            return res;
        },
        onMutate: async ({ active }) => {
            await qc.cancelQueries({ queryKey: QUERY_KEY });
            const prev = qc.getQueryData<TradingPreferences | null>(QUERY_KEY);
            qc.setQueryData<TradingPreferences | null>(QUERY_KEY, (old) =>
                old ? { ...old, kill_switch_active: active } : null,
            );
            return { prev };
        },
        onError: (_err, _v, ctx) => {
            if (ctx?.prev !== undefined) qc.setQueryData(QUERY_KEY, ctx.prev);
        },
        onSettled: () => {
            qc.invalidateQueries({ queryKey: QUERY_KEY });
        },
    });
}
