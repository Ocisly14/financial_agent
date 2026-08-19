import test from "node:test";
import assert from "node:assert/strict";
import { buildDelegationTree, type TreeTask } from "../delegationTree.ts";

const task = (overrides: Partial<TreeTask> & { taskId: string }): TreeTask => ({
    description: "do the thing",
    status: "completed",
    threadId: `topic-1:market_data:1`,
    agent: "market_data",
    ...overrides,
});

test("orchestrator dispatches hang off one synthetic root per turn", () => {
    const { nodes, edges } = buildDelegationTree([
        { turnId: "t1", label: "Chart AAPL", tasks: [
            task({ taskId: "a", agent: "market_data", threadId: "s:market_data:1" }),
            task({ taskId: "b", agent: "market_research", threadId: "s:market_research:1" }),
        ] },
    ]);

    const root = nodes.find((n) => n.kind === "root");
    assert.ok(root, "each turn gets a synthetic orchestrator root");
    assert.equal(root.label, "Chart AAPL");
    assert.deepEqual(
        edges.map((e) => [e.from, e.to]),
        [[root.id, "a"], [root.id, "b"]],
    );
});

test("a task naming a parentTaskId nests under it instead of the turn root", () => {
    const { nodes } = buildDelegationTree([
        { turnId: "t1", tasks: [
            task({ taskId: "caller", agent: "financial_modeling", threadId: "s:financial_modeling:1" }),
            task({ taskId: "callee", agent: "statement_unification", threadId: "s:statement_unification:1", parentTaskId: "caller" }),
        ] },
    ]);

    const callee = nodes.find((n) => n.id === "callee")!;
    const caller = nodes.find((n) => n.id === "caller")!;
    assert.equal(callee.parentId, "caller");
    assert.equal(callee.depth, caller.depth + 1);
});

test("rows are DFS pre-order so a child renders directly under its caller", () => {
    const { nodes } = buildDelegationTree([
        { turnId: "t1", tasks: [
            task({ taskId: "caller", agent: "financial_modeling", threadId: "s:financial_modeling:1" }),
            task({ taskId: "sibling", agent: "market_data", threadId: "s:market_data:1" }),
            task({ taskId: "callee", agent: "spine_mapping", threadId: "s:spine_mapping:1", parentTaskId: "caller" }),
        ] },
    ]);

    const rowOf = (id: string) => nodes.find((n) => n.id === id)!.row;
    assert.equal(rowOf("callee"), rowOf("caller") + 1, "child follows its caller");
    assert.ok(rowOf("sibling") > rowOf("callee"), "the later sibling comes after the whole subtree");
    assert.deepEqual([...nodes].map((n) => n.row).sort((a, b) => a - b), nodes.map((_, i) => i), "rows are dense");
});

test("the same agent on two threads is two nodes, badged apart", () => {
    const { nodes } = buildDelegationTree([
        { turnId: "t1", tasks: [
            task({ taskId: "a", threadId: "s:market_data:1" }),
            task({ taskId: "b", threadId: "s:market_data:2" }),
        ] },
    ]);

    const badges = nodes.filter((n) => n.kind === "task").map((n) => n.badge);
    assert.deepEqual(badges, ["#1", "#2"]);
});

test("an agent on a single thread carries no badge", () => {
    const { nodes } = buildDelegationTree([
        { turnId: "t1", tasks: [task({ taskId: "a" })] },
    ]);
    assert.equal(nodes.find((n) => n.id === "a")!.badge, null);
});

test("statuses map to running/done/failed and roll up into the turn root", () => {
    const { nodes } = buildDelegationTree([
        { turnId: "t1", tasks: [
            task({ taskId: "a", status: "completed" }),
            task({ taskId: "b", status: "error", threadId: "s:market_research:1", agent: "market_research" }),
            task({ taskId: "c", status: "in_progress", threadId: "s:spine_mapping:1", agent: "spine_mapping" }),
        ] },
    ]);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    assert.equal(byId.get("a")!.status, "done");
    assert.equal(byId.get("b")!.status, "failed");
    assert.equal(byId.get("c")!.status, "running");
    assert.equal(nodes.find((n) => n.kind === "root")!.status, "running", "anything running keeps the turn running");
});

test("rows without a threadId are orchestrator tool calls, not dispatches, and are dropped", () => {
    const { nodes } = buildDelegationTree([
        { turnId: "t1", tasks: [
            task({ taskId: "a" }),
            { taskId: "tool-row", description: "financial_search", status: "in_progress" },
        ] },
    ]);
    assert.equal(nodes.filter((n) => n.kind === "task").length, 1);
});

test("a missing parent falls back to the turn root instead of vanishing", () => {
    const { nodes, edges } = buildDelegationTree([
        { turnId: "t1", tasks: [
            task({ taskId: "orphan", parentTaskId: "compacted-away" }),
        ] },
    ]);
    const root = nodes.find((n) => n.kind === "root")!;
    assert.deepEqual(edges.map((e) => [e.from, e.to]), [[root.id, "orphan"]]);
});

test("several turns stack in order, each under its own root", () => {
    const { nodes } = buildDelegationTree([
        { turnId: "t1", tasks: [task({ taskId: "a" })] },
        { turnId: "t2", tasks: [task({ taskId: "b", threadId: "s:market_data:2" })] },
    ]);

    const roots = nodes.filter((n) => n.kind === "root");
    assert.equal(roots.length, 2);
    const rowOf = (id: string) => nodes.find((n) => n.id === id)!.row;
    assert.ok(rowOf("a") < rowOf(roots[1]!.id), "turn two starts after turn one's subtree");
    assert.ok(rowOf(roots[1]!.id) < rowOf("b"));
});

test("a turn with no dispatches contributes nothing", () => {
    const { nodes } = buildDelegationTree([
        { turnId: "t1", tasks: [] },
        { turnId: "t2", tasks: [task({ taskId: "a" })] },
    ]);
    assert.equal(nodes.filter((n) => n.kind === "root").length, 1);
});
