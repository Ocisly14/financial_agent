import { TOPIC_CATEGORIES, type TopicCategory, type TopicSummary } from "../types/core.ts";

/**
 * How the rail organises the Topic list.
 *
 * `recency` stays the default on purpose. The sidebar's highest-frequency use
 * is "what was I just working on", and any grouping breaks that scan — so
 * grouping is offered, not imposed.
 */
export type GroupingMode = "recency" | "symbol" | "category";

export const GROUPING_MODES: readonly GroupingMode[] = ["recency", "symbol", "category"];

export function isGroupingMode(value: unknown): value is GroupingMode {
    return typeof value === "string" && (GROUPING_MODES as readonly string[]).includes(value);
}

export type TopicGroup = {
    /** Stable react key. Also the ticker or category slug, per `kind`. */
    key: string;
    kind: "symbol" | "category" | "none";
    /** Set when `kind` is "category" and the group is the unclassified bucket. */
    uncategorized?: boolean;
    topics: TopicSummary[];
};

/** Most recent activity on a topic, falling back to when it was created. */
function activityOf(topic: TopicSummary): number {
    return topic.lastMessage?.createdAt ?? topic.createdAt;
}

function byRecency(a: TopicSummary, b: TopicSummary): number {
    return activityOf(b) - activityOf(a);
}

/** The newest activity anywhere in a group — how groups are ranked against
 *  each other in symbol mode. */
function groupActivity(group: TopicGroup): number {
    return group.topics.reduce((max, topic) => Math.max(max, activityOf(topic)), 0);
}

/**
 * Splits the rail's Topic list into printed groups.
 *
 * Symbol mode is "symbol first, category as fallback" rather than symbol-only:
 * grouping purely by `leadSymbol` would dump every macro, strategy and
 * portfolio Topic — the ones that never carry a ticker — into a single "other"
 * bucket, which is precisely the undifferentiated pile grouping was meant to
 * break up. So a Topic without a symbol falls back to its category, and only a
 * Topic with neither ends up unclassified.
 *
 * Group ORDER differs by mode, deliberately. Symbol groups are ranked by their
 * own latest activity, so the tickers being worked on stay near the top and the
 * list does not degrade into an alphabet. Category groups use the fixed
 * `TOPIC_CATEGORIES` order instead — those six are a taxonomy the user learns
 * the shape of, and a taxonomy that reshuffles itself is not one.
 *
 * Input is never mutated; every group holds its own array.
 */
export function groupTopics(topics: readonly TopicSummary[], mode: GroupingMode): TopicGroup[] {
    const sorted = [...topics].sort(byRecency);

    if (mode === "recency" || sorted.length === 0) {
        return sorted.length === 0 ? [] : [{ key: "all", kind: "none", topics: sorted }];
    }

    if (mode === "category") {
        return collectCategories(sorted, (topic) => topic.category);
    }

    const bySymbol = new Map<string, TopicSummary[]>();
    const symbolless: TopicSummary[] = [];
    for (const topic of sorted) {
        if (topic.leadSymbol) {
            const bucket = bySymbol.get(topic.leadSymbol);
            if (bucket) bucket.push(topic);
            else bySymbol.set(topic.leadSymbol, [topic]);
        } else {
            symbolless.push(topic);
        }
    }

    const symbolGroups: TopicGroup[] = [...bySymbol.entries()]
        .map(([symbol, group]) => ({ key: symbol, kind: "symbol" as const, topics: group }))
        .sort((a, b) => groupActivity(b) - groupActivity(a));

    // Category groups always follow the symbol groups: a ticker is a more
    // specific answer to "what is this about" than a category is.
    return [...symbolGroups, ...collectCategories(symbolless, (topic) => topic.category)];
}

/** Buckets topics by category, in `TOPIC_CATEGORIES` order, unclassified last. */
function collectCategories(
    topics: readonly TopicSummary[],
    categoryOf: (topic: TopicSummary) => TopicCategory | null,
): TopicGroup[] {
    const buckets = new Map<TopicCategory, TopicSummary[]>();
    const unclassified: TopicSummary[] = [];
    for (const topic of topics) {
        const category = categoryOf(topic);
        if (category === null) {
            unclassified.push(topic);
            continue;
        }
        const bucket = buckets.get(category);
        if (bucket) bucket.push(topic);
        else buckets.set(category, [topic]);
    }

    const groups: TopicGroup[] = [];
    for (const category of TOPIC_CATEGORIES) {
        const bucket = buckets.get(category);
        if (bucket) groups.push({ key: category, kind: "category", topics: bucket });
    }
    if (unclassified.length > 0) {
        groups.push({ key: "uncategorized", kind: "category", uncategorized: true, topics: unclassified });
    }
    return groups;
}
