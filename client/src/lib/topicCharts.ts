import type { SymbolChartWorkspace } from "./chartWorkspace.ts";
import { DEFAULT_STOCK_RANGE, STOCK_RANGES, type StockRange } from "./stockChart.ts";
import type { TopicChartPreference } from "../types/core.ts";

export type TopicChartTab = SymbolChartWorkspace & {
    /** True while the tab exists only because the user asked for it — the agent
     *  has not charted this symbol in this topic yet. */
    userAdded: boolean;
};

/** A preference row is durable storage, so it may hold a value this build no
 *  longer knows. A corrupt range must degrade to the derived one, never throw. */
function storedRange(value: string | null): StockRange | undefined {
    return value !== null && (STOCK_RANGES as readonly string[]).includes(value)
        ? value as StockRange
        : undefined;
}

/**
 * Fold what the agent charted together with what the user wants to see.
 *
 * The rule this file exists to enforce: research content comes from the agent
 * (the derived list), the tab set belongs to the user (the preference list).
 * Preferences never carry study data, so the two can never drift apart.
 */
export function mergeTopicCharts(
    derived: SymbolChartWorkspace[],
    preferences: TopicChartPreference[],
): TopicChartTab[] {
    const byPreference = new Map(preferences.map((preference) => [preference.symbol, preference]));
    const tabs: TopicChartTab[] = [];
    const seen = new Set<string>();

    for (const chart of derived) {
        const preference = byPreference.get(chart.symbol);
        // Spec §6 (research layer, 2026-07-30) deliberately overturns the phase-1 rule that
        // used to live here ("a hidden symbol stays hidden however many times the agent
        // charts it again"). The decision is now "agent has full authority, user can undo":
        // the controller may revive a symbol the user hid, and `hidden` is no longer a veto
        // over it — it only matters for symbols the agent has NOT (re-)charted, where it
        // means "stay gone" (see the second loop below). Do not restore the old skip here.
        seen.add(chart.symbol);
        tabs.push({
            ...chart,
            range: storedRange(preference?.range ?? null) ?? chart.range,
            userAdded: false,
        });
    }

    // Symbols the user added that the agent has not charted yet: an empty tab
    // is the honest rendering — it says "this is on my list, nothing here yet".
    for (const preference of preferences) {
        if (preference.hidden || seen.has(preference.symbol)) continue;
        tabs.push({
            symbol: preference.symbol,
            range: storedRange(preference.range) ?? DEFAULT_STOCK_RANGE,
            createdAt: null,
            studies: [],
            userAdded: true,
        });
    }

    // A symbol with no stored preference is one the agent has just charted, and
    // that is the tab the user wants to look at right now — so it goes to the
    // FRONT, not the end. Appending it would bury the newest analysis behind
    // everything the topic ever accumulated. Among a batch that arrived together
    // the derived order holds, so they read in the order the answer mentioned them.
    const orderOf = (symbol: string): number => byPreference.get(symbol)?.sortOrder ?? Number.MIN_SAFE_INTEGER;
    return tabs
        .map((tab, index) => ({ tab, index }))
        .sort((left, right) => {
            const byOrder = orderOf(left.tab.symbol) - orderOf(right.tab.symbol);
            if (byOrder !== 0) return byOrder;
            return left.index - right.index;   // stable: derived order wins ties
        })
        .map(({ tab }) => tab);
}

/** Project the current tab set back into storable preferences. */
export function preferencesFor(tabs: TopicChartTab[], hidden: string[] = []): TopicChartPreference[] {
    const visible = tabs.map((tab, index) => ({
        symbol: tab.symbol,
        range: null,
        hidden: false,
        sortOrder: index,
    }));
    return [
        ...visible,
        ...hidden.map((symbol, index) => ({
            symbol,
            range: null,
            hidden: true,
            sortOrder: visible.length + index,
        })),
    ];
}
