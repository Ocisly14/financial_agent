/**
 * Grouping rules for the progress pill's task rows.
 *
 * A subagent thread is a conversation that spans several dispatches, so two
 * rows carrying the same thread id are rounds of one continuing piece of work
 * rather than unrelated siblings. Kept out of the component so the edge cases —
 * one thread, no thread, a mix — can be pinned by tests.
 */

/** The minimum a row needs for grouping; the component's ProgressTask is wider. */
export type ThreadedTask = { threadId?: string };

export type ThreadGroup<T> = {
    key: string;
    /** A short marker distinguishing this conversation from its neighbours, or
     *  null when there is nothing to distinguish it from. */
    badge: string | null;
    tasks: T[];
};

/**
 * The trailing counter in a thread id (`<topicId>:<agent>:<n>`). The full id is
 * unwieldy in a narrow column, and its first two parts are already implied —
 * the topic is the window you are in and the agent is the tab you are on.
 */
export function threadOrdinal(threadId: string): string | null {
    const n = threadId.split(":").at(-1);
    return n && /^\d+$/.test(n) ? n : null;
}

/**
 * Split one agent's tasks into its separate conversations, in the order they
 * first appear.
 *
 * A single group means the agent worked one continuous thread here, which is
 * the ordinary case — it comes back with no badge and renders as a plain list,
 * exactly as it did before threads existed. Badges appear only when there is
 * genuinely more than one conversation to tell apart.
 */
export function threadGroups<T extends ThreadedTask>(tasks: T[]): ThreadGroup<T>[] {
    const byThread = new Map<string, T[]>();
    for (const task of tasks) {
        const key = task.threadId ?? "";
        const bucket = byThread.get(key);
        if (bucket) bucket.push(task);
        else byThread.set(key, [task]);
    }
    const single = byThread.size <= 1;
    return [...byThread.entries()].map(([key, groupTasks], index) => ({
        key,
        // Rows with no thread id are history from before threads existed. They
        // get no badge: inventing a label for "unknown conversation" would
        // claim more than the data supports.
        badge: single || !key ? null : `#${threadOrdinal(key) ?? index + 1}`,
        tasks: groupTasks,
    }));
}
