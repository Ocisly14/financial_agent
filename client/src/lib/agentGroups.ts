/**
 * Which agents a progress pill shows, and what to call them.
 *
 * This used to be a hard-coded list of four inside the pill: any name missing from it — every
 * nested delegate — was swallowed by a group called "Other", so the user watching a DCF saw
 * unlabelled work and no way to tell which agent was doing it. Adding an agent on the server
 * silently created another one of those.
 *
 * So identity is never decided here. Groups come from the tasks that actually ran, and a name with
 * no curated label is humanized rather than hidden. The client owns presentation (icon, colour);
 * the server's topology owns who exists.
 */

/** Curated display names. Absent entries fall back to `humanizeAgent`; nothing falls back to "Other". */
const AGENT_LABELS: Record<string, string> = {
    market_data: "Market data agent",
    market_research: "Market research agent",
    trading_operations: "Stock strategy agent",
    financial_modeling: "DCF modeling agent",
    statement_unification: "Statement unification agent",
    spine_mapping: "Spine mapping agent",
};

/** "statement_unification" → "Statement unification agent". */
export function humanizeAgent(agent: string): string {
    const words = agent.replace(/_/g, " ").trim();
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} agent`;
}

export function agentLabel(agent: string): string {
    return AGENT_LABELS[agent] ?? humanizeAgent(agent);
}

/** True for anything naming an agent. Rows without one are the orchestrator's own tool calls. */
export function isProgressAgent(agent: string | undefined): agent is string {
    return typeof agent === "string" && agent.length > 0;
}

/** Every agent that ran, in first-appearance order — no list to keep in sync. */
export function agentsInOrder(tasks: ReadonlyArray<{ agent?: string }>): string[] {
    const seen: string[] = [];
    for (const task of tasks) {
        if (isProgressAgent(task.agent) && !seen.includes(task.agent)) seen.push(task.agent);
    }
    return seen;
}
