import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

/**
 * F10.3 — live market snapshot polling hook.
 *
 * Backs `MarketSnapshotPanel` in both the compose dialog
 * (`ManualComposeDialog`) and the approval modal (`HumanInputDialog`).
 * Polls `/agents/:agentId/cex/market-snapshot` every 5 s while
 * `enabled` is true — matches the upstream Binance/Coinbase per-process
 * 5 s cache TTL so polling faster yields no fresher data.
 *
 * Returns the same `{ market_snapshot?, symbol_verification }` shape
 * the SSE `human_input_required` payload carries, so the panel
 * consumer can render the new live data through the exact same props.
 *
 * Gated on `agentId` + `symbol` to avoid firing requests that would
 * hit `null` placeholders in the URL. Re-fetches on window focus so a
 * user who tabbed away and back sees fresh data immediately.
 */
export interface UseMarketSnapshotArgs {
    agentId: string | null;
    symbol: string;
    venue?: string;
    side?: "BUY" | "SELL";
    limit_price?: string;
    action_name?: string;
    enabled: boolean;
}

export function useMarketSnapshot(args: UseMarketSnapshotArgs) {
    const { agentId, symbol, venue, side, limit_price, action_name, enabled } = args;
    return useQuery({
        queryKey: ["market-snapshot", agentId, symbol, venue, side, limit_price, action_name],
        queryFn: async () => {
            if (!agentId || !symbol) return null;
            return apiClient.getMarketSnapshot(agentId, {
                symbol,
                venue,
                side,
                limit_price,
                action_name,
            });
        },
        enabled: enabled && !!agentId && !!symbol,
        refetchInterval: 5_000,
        staleTime: 2_000,
        refetchOnWindowFocus: true,
        // F10.9 — keep the previous query's data on screen while the
        // new venue / symbol / side combination is in flight. Without
        // this, switching the venue toggle (Binance ↔ Coinbase)
        // collapses the panel to blank for 500-1000 ms because the
        // queryKey change drops `data` to undefined until the new
        // fetch resolves. With `placeholderData: prev => prev`,
        // React Query keeps the last successful payload visible
        // throughout the transition — the bid/ask ticker just smoothly
        // updates when the new venue's data arrives.
        placeholderData: (previousData) => previousData,
    });
}
