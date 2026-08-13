import test from "node:test";
import assert from "node:assert/strict";
import { groupTopics, isGroupingMode } from "../topicGrouping.ts";
import type { TopicCategory, TopicSummary } from "../../types/core.ts";

function topic(
    id: string,
    over: { symbol?: string | null; category?: TopicCategory | null; at?: number } = {},
): TopicSummary {
    return {
        id,
        name: id,
        leadSymbol: over.symbol ?? null,
        subjectSymbols: over.symbol ? [over.symbol] : [],
        createdAt: over.at ?? 0,
        lastMessage: { text: "x", createdAt: over.at ?? 0 },
        messageCount: 2,
        summary: null,
        category: over.category ?? null,
        categoryLocked: false,
    };
}

const shape = (groups: ReturnType<typeof groupTopics>) =>
    groups.map((group) => [group.key, group.topics.map((t) => t.id)]);

test("recency mode is one flat group, newest first", () => {
    const groups = groupTopics([topic("a", { at: 1 }), topic("c", { at: 3 }), topic("b", { at: 2 })], "recency");
    assert.deepEqual(shape(groups), [["all", ["c", "b", "a"]]]);
});

test("an empty list produces no groups in any mode", () => {
    for (const mode of ["recency", "symbol", "category"] as const) {
        assert.deepEqual(groupTopics([], mode), [], mode);
    }
});

test("symbol mode ranks groups by their own latest activity, not the alphabet", () => {
    const groups = groupTopics([
        topic("aapl-old", { symbol: "AAPL", at: 1 }),
        topic("nvda-new", { symbol: "NVDA", at: 9 }),
        topic("aapl-mid", { symbol: "AAPL", at: 5 }),
    ], "symbol");

    assert.deepEqual(shape(groups), [["NVDA", ["nvda-new"]], ["AAPL", ["aapl-mid", "aapl-old"]]],
        "the ticker being worked on stays at the top; groups must not degrade into an alphabet");
});

test("symbol mode falls back to category for topics with no ticker", () => {
    const groups = groupTopics([
        topic("nvda", { symbol: "NVDA", at: 5 }),
        topic("fed", { category: "macro", at: 4 }),
        topic("backtest", { category: "strategy", at: 3 }),
    ], "symbol");

    assert.deepEqual(shape(groups), [["NVDA", ["nvda"]], ["macro", ["fed"]], ["strategy", ["backtest"]]],
        "grouping on leadSymbol alone would pile every macro and strategy topic into one 'other' bucket");
    assert.deepEqual(groups.map((g) => g.kind), ["symbol", "category", "category"]);
});

test("a topic with neither symbol nor category lands in the unclassified group, last", () => {
    const groups = groupTopics([
        topic("blank", { at: 9 }),
        topic("fed", { category: "macro", at: 1 }),
    ], "symbol");

    assert.deepEqual(shape(groups), [["macro", ["fed"]], ["uncategorized", ["blank"]]],
        "unclassified sinks to the bottom even when it is the most recent");
    assert.equal(groups[1]?.uncategorized, true);
});

test("symbol groups always precede category groups", () => {
    const groups = groupTopics([
        topic("fed", { category: "macro", at: 100 }),
        topic("nvda", { symbol: "NVDA", at: 1 }),
    ], "symbol");

    assert.deepEqual(groups.map((g) => g.key), ["NVDA", "macro"],
        "a ticker is a more specific answer to 'what is this about' than a category");
});

test("category mode uses the fixed taxonomy order, not activity", () => {
    const groups = groupTopics([
        topic("book", { category: "portfolio", at: 100 }),
        topic("fed", { category: "macro", at: 90 }),
        topic("nvda", { symbol: "NVDA", category: "single_name", at: 80 }),
    ], "category");

    assert.deepEqual(groups.map((g) => g.key), ["single_name", "macro", "portfolio"],
        "a taxonomy the user learns the shape of must not reshuffle itself between renders");
});

test("category mode ignores leadSymbol entirely", () => {
    const groups = groupTopics([
        topic("nvda", { symbol: "NVDA", category: "single_name", at: 2 }),
        topic("aapl", { symbol: "AAPL", category: "single_name", at: 1 }),
    ], "category");

    assert.deepEqual(shape(groups), [["single_name", ["nvda", "aapl"]]]);
});

test("grouping never mutates the input array", () => {
    const input = [topic("a", { at: 1 }), topic("b", { at: 9 })];
    groupTopics(input, "symbol");
    assert.deepEqual(input.map((t) => t.id), ["a", "b"]);
});

test("isGroupingMode rejects a stale value from localStorage", () => {
    assert.equal(isGroupingMode("symbol"), true);
    assert.equal(isGroupingMode("byTicker"), false);
    assert.equal(isGroupingMode(null), false);
});
