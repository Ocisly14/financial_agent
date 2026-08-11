import test from "node:test";
import assert from "node:assert/strict";
import {
    applyDirective,
    clearPendingUndo,
    initialResearchLayoutState,
    invertDirective,
    resolveUndo,
    type LayoutChangedDirective,
    type ResearchLayoutState,
} from "../researchLayout.ts";

const layoutChanged = (
    overrides: Partial<LayoutChangedDirective> = {},
): LayoutChangedDirective => ({
    kind: "layout_changed",
    scope: "tabs",
    researchId: "research-1",
    topicId: "topic-1",
    source: "agent",
    previous: { charts: ["AAPL"] },
    next: { charts: ["AAPL", "NVDA"] },
    ...overrides,
});

test("a transient directive (focus) has no inverse", () => {
    const inverse = invertDirective({ kind: "focus", topicId: "topic-1", symbol: "AAPL" });
    assert.equal(inverse, undefined);
});

test("a persistent directive (layout_changed) has an inverse that swaps previous/next", () => {
    const directive = layoutChanged();
    const inverse = invertDirective(directive);
    assert.ok(inverse);
    assert.deepEqual(inverse?.previous, directive.next);
    assert.deepEqual(inverse?.next, directive.previous);
    assert.equal(inverse?.scope, directive.scope);
    assert.equal(inverse?.researchId, directive.researchId);
    assert.equal(inverse?.topicId, directive.topicId);
});

test("applying focus updates state.focus and leaves pendingUndo untouched", () => {
    const seeded: ResearchLayoutState = { focus: null, pendingUndo: layoutChanged() };
    const next = applyDirective(seeded, { kind: "focus", topicId: "topic-2", symbol: "SPY" });
    assert.deepEqual(next.focus, { topicId: "topic-2", symbol: "SPY" });
    assert.equal(next.pendingUndo, seeded.pendingUndo, "focus must not disturb a pending undo");
});

test("an agent layout_changed sets pendingUndo to its inverse", () => {
    const directive = layoutChanged();
    const next = applyDirective(initialResearchLayoutState, directive);
    assert.ok(next.pendingUndo);
    assert.deepEqual(next.pendingUndo?.previous, directive.next);
    assert.deepEqual(next.pendingUndo?.next, directive.previous);
});

test("a user-sourced layout_changed does not create or disturb a pending undo", () => {
    const agentChange = layoutChanged();
    const afterAgent = applyDirective(initialResearchLayoutState, agentChange);
    assert.ok(afterAgent.pendingUndo);

    const userChange = layoutChanged({ source: "user", previous: { charts: [] }, next: { charts: ["MSFT"] } });
    const afterUser = applyDirective(afterAgent, userChange);
    assert.equal(afterUser.pendingUndo, afterAgent.pendingUndo, "a user change must not touch the agent's undo slot");
});

test("two consecutive agent layout_changed directives leave only the most recent undoable (single level, no stack)", () => {
    const first = layoutChanged({ topicId: "topic-1", previous: { charts: [] }, next: { charts: ["AAPL"] } });
    const second = layoutChanged({ topicId: "topic-2", previous: { charts: ["X"] }, next: { charts: ["X", "NVDA"] } });

    const afterFirst = applyDirective(initialResearchLayoutState, first);
    const afterSecond = applyDirective(afterFirst, second);

    assert.deepEqual(afterSecond.pendingUndo?.topicId, "topic-2");
    assert.deepEqual(afterSecond.pendingUndo?.previous, second.next);
    assert.deepEqual(afterSecond.pendingUndo?.next, second.previous);
    // The first directive's inverse is gone entirely — not queued behind it.
    assert.notEqual(afterSecond.pendingUndo, afterFirst.pendingUndo);
});

test("clearPendingUndo drops the slot without side effects on focus", () => {
    const seeded: ResearchLayoutState = { focus: { topicId: "topic-1" }, pendingUndo: layoutChanged() };
    const cleared = clearPendingUndo(seeded);
    assert.equal(cleared.pendingUndo, null);
    assert.deepEqual(cleared.focus, seeded.focus);
});

test("clearPendingUndo on an already-empty slot is a no-op (same reference)", () => {
    const cleared = clearPendingUndo(initialResearchLayoutState);
    assert.equal(cleared, initialResearchLayoutState);
});

test("resolveUndo returns undefined and unchanged state when there is nothing to undo", () => {
    const { state, directive } = resolveUndo(initialResearchLayoutState);
    assert.equal(directive, undefined);
    assert.equal(state, initialResearchLayoutState);
});

test("resolveUndo returns the pending inverse and clears the slot", () => {
    const directive = layoutChanged();
    const seeded = applyDirective(initialResearchLayoutState, directive);
    const { state, directive: resolved } = resolveUndo(seeded);
    assert.ok(resolved);
    assert.deepEqual(resolved?.previous, directive.next);
    assert.equal(state.pendingUndo, null);
});
