import test from "node:test";
import assert from "node:assert/strict";
import { threadGroups, threadOrdinal } from "../progressThreads.ts";

const task = (taskId: string, threadId?: string) => ({ taskId, ...(threadId ? { threadId } : {}) });

test("one thread renders as a plain list, with nothing to distinguish it from", () => {
    const groups = threadGroups([
        task("ev_1", "room_1:financial_modeling:1"),
        task("ev_2", "room_1:financial_modeling:1"),
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.badge, null, "a lone conversation needs no marker");
    assert.deepEqual(groups[0]!.tasks.map((t) => t.taskId), ["ev_1", "ev_2"]);
});

test("two conversations are split and badged by their own counters", () => {
    const groups = threadGroups([
        task("ev_1", "room_1:financial_modeling:1"),
        task("ev_2", "room_1:financial_modeling:2"),
        task("ev_3", "room_1:financial_modeling:1"),
    ]);

    assert.deepEqual(groups.map((g) => g.badge), ["#1", "#2"]);
    // Grouping is by conversation, not by arrival: round 2 of thread 1 rejoins
    // round 1 even though another thread's row landed between them.
    assert.deepEqual(groups[0]!.tasks.map((t) => t.taskId), ["ev_1", "ev_3"]);
    assert.deepEqual(groups[1]!.tasks.map((t) => t.taskId), ["ev_2"]);
});

test("groups keep the order their conversations first appeared", () => {
    const groups = threadGroups([
        task("ev_1", "room_1:market_data:3"),
        task("ev_2", "room_1:market_data:1"),
    ]);

    assert.deepEqual(groups.map((g) => g.badge), ["#3", "#1"]);
});

test("history recorded before threads existed still renders, unbadged", () => {
    const groups = threadGroups([task("ev_1"), task("ev_2")]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.badge, null);
    assert.deepEqual(groups[0]!.tasks.map((t) => t.taskId), ["ev_1", "ev_2"]);
});

test("a threadless row mixed with real threads claims no label of its own", () => {
    const groups = threadGroups([
        task("ev_old"),
        task("ev_1", "room_1:market_data:1"),
    ]);

    assert.deepEqual(groups.map((g) => g.badge), [null, "#1"]);
});

test("threadOrdinal reads the counter, and refuses ids that are not threads", () => {
    assert.equal(threadOrdinal("room_1a2b:financial_modeling:12"), "12");
    // Old traces are keyed by a dispatch event id, which has no counter.
    assert.equal(threadOrdinal("ev_0f1e2d3c"), null);
    assert.equal(threadOrdinal("room_1:market_data:abc"), null);
});
