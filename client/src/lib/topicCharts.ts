import type { SymbolChartWorkspace } from "./chartWorkspace.ts";
import { DEFAULT_STOCK_RANGE, parseStockRange, type StockRange } from "./stockChart.ts";
import type { OverlaySpec, TopicChartPreference } from "../types/core.ts";

export type SymbolChartTab = SymbolChartWorkspace & {
    kind: "symbol";
    /** True while the tab exists only because the user asked for it — the agent
     *  has not charted this symbol in this topic yet. */
    userAdded: boolean;
};

/** A multi-ticker comparison tab kept from a preference row. Unlike a symbol
 *  tab it has no per-agent-turn derivation to fold in — the overlay's content
 *  IS the preference, so this is a near-direct projection of the row. */
export type OverlayChartTab = {
    kind: "overlay";
    id: string;
    overlay: OverlaySpec;
};

/** A model workbook tab. Unlike the other two it is not derived from message
 *  history and never becomes a preference row — a model is an object the
 *  backend owns, not something the user arranged. */
export type ModelChartTab = {
    kind: "model";
    modelId: string;
    symbol: string;
};

export type TopicChartTab = SymbolChartTab | OverlayChartTab | ModelChartTab;

/**
 * The stable identity of a tab across the UI — tab-bar keys, the active-tab
 * selection, drag reordering, and the detached-window set all address a tab
 * through this and nothing else.
 *
 * Prefixed by kind rather than using the bare symbol / row id, because the two
 * id spaces are independent: nothing stops an overlay row id from colliding
 * with a ticker, and a collision here would silently select or detach the
 * wrong tab. The prefix makes that impossible instead of unlikely.
 */
export function chartTabKey(tab: TopicChartTab): string {
    if (tab.kind === "model") return `model:${tab.modelId}`;
    return tab.kind === "symbol" ? `symbol:${tab.symbol}` : `overlay:${tab.id}`;
}

/** A preference row is durable storage, so it may hold a value this build no
 *  longer knows. A corrupt range must degrade to the derived one, never throw. */
function storedRange(value: number | null): StockRange | undefined {
    return value === null ? undefined : parseStockRange(value);
}

/**
 * Fold what the agent charted together with what the user wants to see.
 *
 * The rule this file exists to enforce: research content comes from the agent
 * (the derived list), the tab set belongs to the user (the preference list).
 * Preferences never carry study data, so the two can never drift apart.
 *
 * Overlay preferences are a separate concern: the derivation only ever
 * produces single-symbol charts, so an overlay tab (something the user or
 * agent explicitly kept) has nothing in `derived` that corresponds to it.
 * It takes no part in the matching below — it only participates in the
 * final `sortOrder`-based ordering, same as everything else.
 */
// A model tab is never produced here (see the doc comment above) — the
// return type says so explicitly, rather than the wider `TopicChartTab[]`,
// so every caller (including this file's own `orderOf` below) keeps the
// narrower, accurate type instead of having to re-guard against a case that
// can't happen.
export function mergeTopicCharts(
    derived: SymbolChartWorkspace[],
    preferences: TopicChartPreference[],
): Exclude<TopicChartTab, { kind: "model" }>[] {
    const symbolPreferences = preferences.filter(
        (preference): preference is Extract<TopicChartPreference, { kind: "symbol" }> => preference.kind === "symbol",
    );
    const overlayPreferences = preferences.filter(
        (preference): preference is Extract<TopicChartPreference, { kind: "overlay" }> => preference.kind === "overlay",
    );
    const byPreference = new Map(symbolPreferences.map((preference) => [preference.symbol, preference]));
    const tabs: Exclude<TopicChartTab, { kind: "model" }>[] = [];
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
            kind: "symbol",
            range: storedRange(preference?.range ?? null) ?? chart.range,
            userAdded: false,
        });
    }

    // Symbols the user added that the agent has not charted yet: an empty tab
    // is the honest rendering — it says "this is on my list, nothing here yet".
    for (const preference of symbolPreferences) {
        if (preference.hidden || seen.has(preference.symbol)) continue;
        tabs.push({
            kind: "symbol",
            symbol: preference.symbol,
            range: storedRange(preference.range) ?? DEFAULT_STOCK_RANGE,
            createdAt: null,
            studies: [],
            userAdded: true,
        });
    }

    // Overlay tabs: never matched against `derived` (see the doc comment above).
    // A hidden overlay is dropped, same as a hidden symbol preference.
    for (const preference of overlayPreferences) {
        if (preference.hidden) continue;
        tabs.push({ kind: "overlay", id: preference.id, overlay: preference.overlay });
    }

    // A symbol with no stored preference is one the agent has just charted, and
    // that is the tab the user wants to look at right now — so it goes to the
    // FRONT, not the end. Appending it would bury the newest analysis behind
    // everything the topic ever accumulated. Among a batch that arrived together
    // the derived order holds, so they read in the order the answer mentioned them.
    const overlayOrderById = new Map(overlayPreferences.map((preference) => [preference.id, preference.sortOrder]));
    const orderOf = (tab: Exclude<TopicChartTab, { kind: "model" }>): number =>
        tab.kind === "symbol"
            ? byPreference.get(tab.symbol)?.sortOrder ?? Number.MIN_SAFE_INTEGER
            : overlayOrderById.get(tab.id) ?? Number.MIN_SAFE_INTEGER;
    return tabs
        .map((tab, index) => ({ tab, index }))
        .sort((left, right) => {
            const byOrder = orderOf(left.tab) - orderOf(right.tab);
            if (byOrder !== 0) return byOrder;
            return left.index - right.index;   // stable: derived order wins ties
        })
        .map(({ tab }) => tab);
}

/** Project the current tab set back into storable preferences.
 *
 * Row ids are regenerated by the server on every write (a whole-set replace
 * discards the previous rows and their ids along with them — see
 * `handleReplaceTopicCharts`), so the id sent here is a throwaway: a stable,
 * locally-unique value is enough to satisfy the type, nothing reads it back. */
export function preferencesFor(tabs: TopicChartTab[], hidden: string[] = []): TopicChartPreference[] {
    // A model tab never becomes a preference row (see ModelChartTab's doc
    // comment) — filtered here too, as a second line of defense alongside the
    // `onClose` guard that keeps it from ever reaching this function in the
    // first place.
    const visible: TopicChartPreference[] = tabs
        .filter((tab): tab is Exclude<TopicChartTab, { kind: "model" }> => tab.kind !== "model")
        .map((tab, index) =>
            tab.kind === "symbol"
                ? { id: tab.symbol, kind: "symbol", symbol: tab.symbol, range: null, hidden: false, sortOrder: index }
                : { id: tab.id, kind: "overlay", overlay: tab.overlay, range: null, hidden: false, sortOrder: index },
        );
    return [
        ...visible,
        ...hidden.map((symbol, index) => ({
            id: symbol,
            kind: "symbol" as const,
            symbol,
            range: null,
            hidden: true,
            sortOrder: visible.length + index,
        })),
    ];
}
