import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { buildSymbolChartWorkspace, type ChartWorkspaceMessage } from "@/lib/chartWorkspace";
import { mergeTopicCharts, preferencesFor, type TopicChartTab } from "@/lib/topicCharts";
import { DEFAULT_STOCK_RANGE } from "@/lib/stockChart";
import type { UUID, TopicChartPreference } from "@/types/core";

const TICKER_PATTERN = /^[A-Z][A-Z.-]{0,5}$/;

/**
 * Folds the agent's derived charts (from message history) together with the
 * user's tab preferences (from the backend) via `mergeTopicCharts`, and
 * exposes the mutations — add / hide / reorder — that write those
 * preferences back. The merge rule itself lives in lib/topicCharts.ts; this
 * hook only wires it to data sources and persists the result.
 */
export function useTopicCharts(
    agentId: UUID,
    topicId: UUID,
    messages: ChartWorkspaceMessage[],
    streamingText: string,
) {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { t } = useTranslation();

    const derived = useMemo(
        () => buildSymbolChartWorkspace(messages, streamingText),
        [messages, streamingText],
    );

    const preferencesQueryKey = useMemo(() => ["topicCharts", agentId, topicId], [agentId, topicId]);
    const { data: preferences = [] } = useQuery<TopicChartPreference[]>({
        queryKey: preferencesQueryKey,
        queryFn: async () => {
            const result = await apiClient.getTopicCharts(agentId, topicId);
            return result.charts ?? [];
        },
        refetchOnWindowFocus: false,
    });

    // Hidden symbols are not represented in `tabs` (mergeTopicCharts drops
    // them), so they have to be tracked separately to survive round-trips
    // through preferencesFor. Seeded from the fetched preferences and kept in
    // sync with every write this hook makes.
    const hiddenRef = useRef<string[]>([]);
    const hiddenInitialized = useRef(false);
    if (!hiddenInitialized.current && preferences.length > 0) {
        hiddenRef.current = preferences.filter((preference) => preference.hidden).map((preference) => preference.symbol);
        hiddenInitialized.current = true;
    }

    const tabs = useMemo<TopicChartTab[]>(
        () => mergeTopicCharts(derived.charts, preferences),
        [derived.charts, preferences],
    );

    const [activeSymbolState, setActiveSymbolState] = useState<string | undefined>(undefined);
    const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);

    const resolvedActiveSymbol = tabs.some((tab) => tab.symbol === activeSymbolState)
        ? activeSymbolState
        : derived.focusSymbol ?? tabs[0]?.symbol;

    // The agent charting a new symbol (a fresh focusSymbol/focusRevision pair)
    // should pull focus onto that tab, the same way MarketChartWorkspace did.
    const focusRevisionRef = useRef(derived.focusRevision);
    useEffect(() => {
        if (derived.focusSymbol && derived.focusRevision !== focusRevisionRef.current) {
            focusRevisionRef.current = derived.focusRevision;
            setActiveSymbolState(derived.focusSymbol);
        }
    }, [derived.focusSymbol, derived.focusRevision]);

    const setActiveSymbol = useCallback((symbol: string) => {
        setActiveSymbolState(symbol);
    }, []);

    const persist = useCallback(
        (nextTabs: TopicChartTab[]) => {
            void apiClient
                .setTopicCharts(agentId, topicId, preferencesFor(nextTabs, hiddenRef.current))
                .then(() => {
                    void queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
                });
        },
        [agentId, topicId, queryClient, preferencesQueryKey],
    );

    const addSymbol = useCallback(
        (symbol: string) => {
            const normalized = symbol.trim().toUpperCase();
            if (!TICKER_PATTERN.test(normalized)) {
                toast({
                    title: t("charts.invalidSymbolTitle"),
                    description: t("charts.invalidSymbolDescription", { symbol }),
                    variant: "destructive",
                });
                return;
            }
            hiddenRef.current = hiddenRef.current.filter((hiddenSymbol) => hiddenSymbol !== normalized);
            if (tabs.some((tab) => tab.symbol === normalized)) {
                setActiveSymbolState(normalized);
                persist(tabs);
                return;
            }
            // To the front, for the same reason a freshly charted symbol goes
            // there (see mergeTopicCharts): the symbol you just typed is the one
            // you want to look at. Appending would hide it behind everything the
            // topic has accumulated.
            const nextTabs: TopicChartTab[] = [
                {
                    symbol: normalized,
                    range: DEFAULT_STOCK_RANGE,
                    createdAt: null,
                    studies: [],
                    userAdded: true,
                },
                ...tabs,
            ];
            setActiveSymbolState(normalized);
            persist(nextTabs);
        },
        [tabs, persist, toast, t],
    );

    const hideSymbol = useCallback(
        (symbol: string) => {
            if (!hiddenRef.current.includes(symbol)) {
                hiddenRef.current = [...hiddenRef.current, symbol];
            }
            const nextTabs = tabs.filter((tab) => tab.symbol !== symbol);
            setActiveSymbolState((current) => (current === symbol ? nextTabs[0]?.symbol : current));
            persist(nextTabs);
        },
        [tabs, persist],
    );

    /** Drag-to-reorder writes the whole new tab order back as a persistent
     *  preference, same path as add / hide — the tab set belongs to the user. */
    const reorderTabs = useCallback(
        (orderedSymbols: string[]) => {
            const bySymbol = new Map(tabs.map((tab) => [tab.symbol, tab]));
            const nextTabs = orderedSymbols
                .map((symbol) => bySymbol.get(symbol))
                .filter((tab): tab is TopicChartTab => tab !== undefined);
            if (nextTabs.length !== tabs.length) return;
            persist(nextTabs);
        },
        [tabs, persist],
    );

    const toggleSelected = useCallback((symbol: string) => {
        setSelectedSymbols((current) =>
            current.includes(symbol) ? current.filter((selected) => selected !== symbol) : [...current, symbol],
        );
    }, []);

    return {
        tabs,
        activeSymbol: resolvedActiveSymbol,
        setActiveSymbol,
        addSymbol,
        hideSymbol,
        reorderTabs,
        selectedSymbols,
        toggleSelected,
    };
}
