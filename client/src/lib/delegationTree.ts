import { threadOrdinal } from "./progressThreads.ts";

/**
 * Builds the per-session delegation call tree the topology panel draws.
 *
 * Nodes are the dispatches that actually happened — one per task, so the same
 * agent on two threads (or two rounds of one thread) is two nodes — hung off
 * one synthetic orchestrator root per turn. Edges come from `parentTaskId`,
 * which the backend stamps on dispatches made by a nested `delegate_to_agent`;
 * a dispatch without one was the orchestrator's own.
 *
 * Kept pure and layout-inclusive (row/depth per node) so the growth rules —
 * DFS pre-order, children directly under their caller — are pinned by tests
 * rather than living in JSX.
 */

/** The slice of ProgressTask this module reads. Rows without a threadId are
 *  orchestrator-level tool calls, not dispatches, and are dropped. */
export type TreeTask = {
    taskId: string;
    description: string;
    status: "in_progress" | "completed" | "error";
    agent?: string;
    threadId?: string;
    summary?: string;
    parentTaskId?: string;
};

export type TurnInput = {
    turnId: string;
    /** What the user asked; labels the turn's root node. */
    label?: string;
    tasks: TreeTask[];
};

export type NodeStatus = "running" | "done" | "failed";

export type DelegationNode = {
    id: string;
    kind: "root" | "task";
    /** Agent name for task nodes; undefined on turn roots. */
    agent?: string;
    label: string;
    /** `#n` when this agent ran more than one thread in the session; null otherwise. */
    badge: string | null;
    status: NodeStatus;
    summary?: string;
    /** 0-based DFS pre-order position — the vertical slot. */
    row: number;
    /** 0 at the turn root, +1 per delegation hop — the horizontal slot. */
    depth: number;
    /** Absent only on turn roots. */
    parentId?: string;
};

export type DelegationEdge = { from: string; to: string };

export type DelegationTree = {
    nodes: DelegationNode[];
    edges: DelegationEdge[];
    rowCount: number;
    maxDepth: number;
};

const statusOf = (task: TreeTask): NodeStatus =>
    task.status === "in_progress" ? "running" : task.status === "error" ? "failed" : "done";

const rollUp = (statuses: NodeStatus[]): NodeStatus =>
    statuses.includes("running") ? "running" : statuses.includes("failed") ? "failed" : "done";

export function buildDelegationTree(turns: TurnInput[]): DelegationTree {
    // Badges are session-wide: whether market_data needs "#2" depends on every
    // thread it ran, not just this turn's.
    const threadsByAgent = new Map<string, Set<string>>();
    for (const turn of turns) {
        for (const task of turn.tasks) {
            if (!task.threadId) continue;
            const key = task.agent ?? "";
            const set = threadsByAgent.get(key) ?? new Set<string>();
            set.add(task.threadId);
            threadsByAgent.set(key, set);
        }
    }

    const nodes: DelegationNode[] = [];
    const edges: DelegationEdge[] = [];
    let row = 0;
    let maxDepth = 0;

    for (const turn of turns) {
        const dispatches = turn.tasks.filter((task) => task.threadId);
        if (dispatches.length === 0) continue;

        const known = new Set(dispatches.map((task) => task.taskId));
        const rootId = `turn:${turn.turnId}`;
        const children = new Map<string, TreeTask[]>();
        for (const task of dispatches) {
            // A parent this turn never saw (compacted away, or an orchestrator
            // dispatch) roots the task at the turn instead of dropping it.
            const parentId = task.parentTaskId && known.has(task.parentTaskId) ? task.parentTaskId : rootId;
            const bucket = children.get(parentId) ?? [];
            bucket.push(task);
            children.set(parentId, bucket);
        }

        const root: DelegationNode = {
            id: rootId,
            kind: "root",
            label: turn.label ?? "",
            badge: null,
            status: rollUp(dispatches.map(statusOf)),
            row: row++,
            depth: 0,
        };
        nodes.push(root);

        const walk = (parentId: string, depth: number) => {
            maxDepth = Math.max(maxDepth, depth);
            for (const task of children.get(parentId) ?? []) {
                const ordinal = task.threadId ? threadOrdinal(task.threadId) : null;
                const multiThread = (threadsByAgent.get(task.agent ?? "")?.size ?? 0) > 1;
                nodes.push({
                    id: task.taskId,
                    kind: "task",
                    ...(task.agent !== undefined ? { agent: task.agent } : {}),
                    label: task.description,
                    badge: multiThread && ordinal ? `#${ordinal}` : null,
                    status: statusOf(task),
                    ...(task.summary !== undefined ? { summary: task.summary } : {}),
                    row: row++,
                    depth,
                    parentId,
                });
                edges.push({ from: parentId, to: task.taskId });
                walk(task.taskId, depth + 1);
            }
        };
        walk(rootId, 1);
    }

    return { nodes, edges, rowCount: row, maxDepth };
}
