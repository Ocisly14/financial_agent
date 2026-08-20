import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { buildSymbolChartWorkspace, type ChartWorkspaceMessage } from "@/lib/chartWorkspace";
import { chartTabKey, mergeTopicCharts, preferencesFor, type TopicChartTab } from "@/lib/topicCharts";
import { DEFAULT_STOCK_RANGE } from "@/lib/stockChart";
import type { UUID, TopicChartPreference } from "@/types/core";

const TICKER_PATTERN = /^[A-Z][A-Z.-]{0,5}$/;

/** What this hook deals in. A model tab is not a chart preference — it comes
 *  from the backend's model list and lives in ChartPane's model view — so it
 *  can never appear here, and the type says so. */
type ChartTab = Exclude<TopicChartTab, { kind: "model" }>;

/**
 * Folds the agent's derived charts (from message history) together with the
 * user's tab preferences (from the backend) via `mergeTopicCharts`, and
 * exposes the mutations — add / hide / reorder — that write those
 * preferences back. The merge rule itself lives in lib/topicCharts.ts; this
 * hook only wires it to data sources and persists the result.
 */
export function useTopicCharts(
    tenantId: UUID,
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

    const preferencesQueryKey = useMemo(() => ["topicCharts", tenantId, topicId], [tenantId, topicId]);
    const { data: preferences = [] } = useQuery<TopicChartPreference[]>({
        queryKey: preferencesQueryKey,
        queryFn: async () => {
            const result = await apiClient.getTopicCharts(tenantId, topicId);
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
        hiddenRef.current = preferences
            .filter((preference): preference is Extract<TopicChartPreference, { kind: "symbol" }> => preference.kind === "symbol" && preference.hidden)
            .map((preference) => preference.symbol);
        hiddenInitialized.current = true;
    }

    const tabs = useMemo<ChartTab[]>(
        () => mergeTopicCharts(derived.charts, preferences),
        [derived.charts, preferences],
    );

    // Both kinds are first-class here: the strip renders them side by side and
    // every operation below addresses a tab through `chartTabKey`, never
    // through a bare ticker — an overlay has no single symbol to be keyed by.
    const symbolTabs = useMemo(
        () => tabs.filter((tab): tab is Extract<TopicChartTab, { kind: "symbol" }> => tab.kind === "symbol"),
        [tabs],
    );

    const [activeKeyState, setActiveKeyState] = useState<string | undefined>(undefined);
    const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);

    const tabKeys = useMemo(() => tabs.map(chartTabKey), [tabs]);
    const activeKey = tabKeys.includes(activeKeyState ?? "")
        ? activeKeyState
        : (derived.focusSymbol && tabKeys.includes(`symbol:${derived.focusSymbol}`)
            ? `symbol:${derived.focusSymbol}`
            : tabKeys[0]);

    // The agent charting a new symbol (a fresh focusSymbol/focusRevision pair)
    // should pull focus onto that tab, the same way MarketChartWorkspace did.
    const focusRevisionRef = useRef(derived.focusRevision);
    useEffect(() => {
        if (derived.focusSymbol && derived.focusRevision !== focusRevisionRef.current) {
            focusRevisionRef.current = derived.focusRevision;
            setActiveKeyState(`symbol:${derived.focusSymbol}`);
        }
    }, [derived.focusSymbol, derived.focusRevision]);

    // A newly generated overlay is selected on arrival (spec §6). It is a piece
    // of analysis the user just asked for, so leaving it unselected behind the
    // tab they were already on would hide the answer to their question. Only
    // ids never seen before qualify — a re-fetch of the same set must not yank
    // focus off whatever the user has since clicked.
    const knownOverlayIds = useRef<Set<string> | null>(null);
    useEffect(() => {
        const ids = tabs.filter((tab) => tab.kind === "overlay").map((tab) => tab.id);
        if (knownOverlayIds.current === null) {
            knownOverlayIds.current = new Set(ids);
            return;
        }
        const fresh = ids.find((id) => !knownOverlayIds.current!.has(id));
        knownOverlayIds.current = new Set(ids);
        if (fresh) setActiveKeyState(`overlay:${fresh}`);
    }, [tabs]);

    const setActiveTab = useCallback((key: string) => {
        setActiveKeyState(key);
    }, []);

    const persist = useCallback(
        (nextTabs: ChartTab[]) => {
            void apiClient
                .setTopicCharts(tenantId, topicId, preferencesFor(nextTabs, hiddenRef.current))
                .then(() => {
                    void queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
                });
        },
        [tenantId, topicId, queryClient, preferencesQueryKey],
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
            if (symbolTabs.some((tab) => tab.symbol === normalized)) {
                setActiveKeyState(`symbol:${normalized}`);
                persist(tabs);
                return;
            }
            // To the front, for the same reason a freshly charted symbol goes
            // there (see mergeTopicCharts): the symbol you just typed is the one
            // you want to look at. Appending would hide it behind everything the
            // topic has accumulated.
            const nextTabs: ChartTab[] = [
                {
                    kind: "symbol",
                    symbol: normalized,
                    range: DEFAULT_STOCK_RANGE,
                    createdAt: null,
                    studies: [],
                    userAdded: true,
                },
                ...tabs,
            ];
            setActiveKeyState(`symbol:${normalized}`);
            persist(nextTabs);
        },
        [tabs, symbolTabs, persist, toast, t],
    );

    /**
     * Removes a tab. This is the `×` on the tab and nothing else — closing a
     * floating window must not reach here (design §5 rule 2), because a tab is
     * a persisted preference and dismissing a temporary window is not consent
     * to destroy one.
     *
     * A symbol also goes onto the hidden list so the agent's derivation cannot
     * immediately resurrect it; an overlay needs no such marker — it exists
     * only as a preference row, so dropping it from the written set IS the
     * deletion.
     */
    const closeTab = useCallback(
        (key: string) => {
            const target = tabs.find((tab) => chartTabKey(tab) === key);
            if (!target) return;
            if (target.kind === "symbol" && !hiddenRef.current.includes(target.symbol)) {
                hiddenRef.current = [...hiddenRef.current, target.symbol];
            }
            const nextTabs = tabs.filter((tab) => chartTabKey(tab) !== key);
            setActiveKeyState((current) => (current === key ? nextTabs[0] && chartTabKey(nextTabs[0]) : current));
            persist(nextTabs);
        },
        [tabs, persist],
    );

    /**
     * Drag-to-reorder writes the whole new tab order back as a persistent
     * preference, same path as add / close — the tab set belongs to the user.
     * Keyed by `chartTabKey` so overlay and symbol tabs reorder against each
     * other in one sequence, which is the only thing `sort_order` can mean.
     *
     * The caller only knows about the tabs in the strip, and tabs torn off into
     * floating windows are not in it. Those are re-inserted at the index they
     * held before, so reordering while something is detached neither drops it
     * nor quietly sends it to the back of the strip it will return to.
     */
    const reorderTabs = useCallback(
        (orderedKeys: string[]) => {
            const byKey = new Map(tabs.map((tab) => [chartTabKey(tab), tab]));
            const reordered = orderedKeys
                .map((key) => byKey.get(key))
                .filter((tab): tab is ChartTab => tab !== undefined);
            if (reordered.length !== orderedKeys.length) return;
            const mentioned = new Set(orderedKeys);
            const next = [...reordered];
            tabs.forEach((tab, index) => {
                if (mentioned.has(chartTabKey(tab))) return;
                next.splice(Math.min(index, next.length), 0, tab);
            });
            persist(next);
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
        activeKey,
        setActiveTab,
        addSymbol,
        closeTab,
        reorderTabs,
        selectedSymbols,
        toggleSelected,
    };
}
