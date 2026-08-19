import { useEffect, useState } from "react";
import { Loader2, CheckCircle, Circle, XCircle, ChevronDown, ChevronRight, Database, Newspaper, ChartNoAxesCombined, Calculator, Layers, GitBranch, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { threadGroups } from "@/lib/progressThreads";
import { useAgentRoster } from "@/hooks/useAgentRoster";
import { agentLabel, agentsInOrder, isProgressAgent } from "@/lib/agentGroups";

/** An agent name. Any name the server declares is one — deliberately not a closed union; grouping
 *  and labelling live in lib/agentGroups (pure, tested), presentation lives here. */
export type ProgressAgent = string;
export { isProgressAgent } from "@/lib/agentGroups";

export interface ProgressTask {
    taskId: string;
    description: string;
    /** The dispatched agent's bare name. Only the four ProgressAgents get their
     *  own pill tab; nested delegates (statement_unification, …) land in "Other". */
    agent?: string;
    /** The subagent conversation this task is a round of. Several tasks sharing
     *  one id are one continuing piece of work, not unrelated siblings. Absent
     *  on history recorded before threads existed. */
    threadId?: string;
    tool?: string;
    /** The agent's own line about what this step is doing, from its
     *  `subagent_note`. On a long delegate it is the only thing that moves
     *  between one dispatch and its result, so it outranks `tool` on the
     *  detail line: "Balance sheet rows added (50 so far)" over
     *  "patch_unification_decision". */
    note?: string;
    status: "in_progress" | "completed" | "error";
    summary?: string;
    /** The caller's task when a nested delegate_to_agent made this dispatch;
     *  absent on orchestrator dispatches. The topology panel draws edges from it. */
    parentTaskId?: string;
}

function statusIcon(status: ProgressTask["status"]) {
    switch (status) {
        case "completed":
            return <CheckCircle className="size-3.5 text-green-500" />;
        case "error":
            return <XCircle className="size-3.5 text-red-500" />;
        case "in_progress":
            return <Loader2 className="size-3.5 text-blue-500 animate-spin" />;
        default:
            return <Circle className="size-3.5 text-label-4" />;
    }
}

/** Icon + colour, curated for the agents worth telling apart at a glance. Deliberately partial:
 *  an agent with no entry gets a generic icon and its humanized label — never "Other". */
const agentIcons: Record<string, { icon: typeof Database; iconClassName: string }> = {
    market_data: { icon: Database, iconClassName: "text-blue-600 dark:text-blue-300" },
    market_research: { icon: Newspaper, iconClassName: "text-violet-600 dark:text-violet-300" },
    trading_operations: { icon: ChartNoAxesCombined, iconClassName: "text-amber-600 dark:text-amber-300" },
    financial_modeling: { icon: Calculator, iconClassName: "text-emerald-600 dark:text-emerald-300" },
    statement_unification: { icon: Layers, iconClassName: "text-cyan-600 dark:text-cyan-300" },
    spine_mapping: { icon: GitBranch, iconClassName: "text-teal-600 dark:text-teal-300" },
};

/** Label + icon + colour for any agent name. Exported so the topology panel matches the pill. */
export function agentPresentation(agent: string): { label: string; icon: typeof Database; iconClassName: string } {
    return { label: agentLabel(agent), ...(agentIcons[agent] ?? { icon: Bot, iconClassName: "text-label-3" }) };
}

const uniqueAgents = agentsInOrder;

function taskGroups(tasks: ProgressTask[], agents: ProgressAgent[]): Array<ProgressAgent | "uncategorized"> {
    // "Other" now means exactly one thing: rows with no agent, which are the orchestrator's own
    // direct tool calls. It used to also swallow every agent missing from a hard-coded list.
    const hasUncategorized = tasks.some((task) => !isProgressAgent(task.agent));
    return hasUncategorized ? [...agents, "uncategorized"] : agents;
}

function groupLabel(group: ProgressAgent | "uncategorized") {
    return group === "uncategorized" ? "Other" : agentPresentation(group).label;
}

function groupIcon(group: ProgressAgent | "uncategorized") {
    return group === "uncategorized" ? Circle : agentPresentation(group).icon;
}

function groupIconClassName(group: ProgressAgent | "uncategorized") {
    return group === "uncategorized" ? "text-label-4" : agentPresentation(group).iconClassName;
}

function groupStatus(tasks: ProgressTask[]) {
    if (tasks.some((task) => task.status === "in_progress")) return "in_progress";
    if (tasks.some((task) => task.status === "error")) return "error";
    return "completed";
}

/**
 * Collapsed one-line progress pill that sits atop an assistant reply. Shows the
 * current task (or "Done") + a step count; click to expand the per-task list
 * (status icon + task description + a muted "tool · summary" sub-line).
 */
export function ChatProgressPill({ tasks, isComplete }: { tasks: ProgressTask[]; isComplete: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const [activeGroup, setActiveGroup] = useState<ProgressAgent | "uncategorized" | null>(null);

    const doneCount = tasks.filter((t) => t.status === "completed" || t.status === "error").length;
    const running = tasks.find((t) => t.status === "in_progress");
    const label = isComplete ? "Done" : running?.description || "Working…";
    const count = isComplete ? `${tasks.length} steps` : `${doneCount}/${tasks.length}`;
    const agents = uniqueAgents(tasks);
    const groups = taskGroups(tasks, agents);
    const displayedGroups: Array<ProgressAgent | "uncategorized"> = groups.length > 0 ? groups : ["uncategorized"];
    const selectedGroup = activeGroup && displayedGroups.includes(activeGroup) ? activeGroup : displayedGroups[0];
    const selectedTasks = selectedGroup === "uncategorized"
        ? tasks.filter((task) => !isProgressAgent(task.agent))
        : tasks.filter((task) => task.agent === selectedGroup);

    useEffect(() => {
        if (!activeGroup || !displayedGroups.includes(activeGroup)) {
            setActiveGroup(displayedGroups[0] ?? null);
        }
    }, [activeGroup, displayedGroups]);

    if (tasks.length === 0) return null;

    return (
        <div className="mb-2 max-w-full min-w-0">
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-sep px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
            >
                {isComplete ? (
                    <CheckCircle className="size-3.5 text-green-500" />
                ) : (
                    <Loader2 className="size-3.5 text-blue-500 animate-spin" />
                )}
                {agents.length > 0 && (
                    <span className="hidden max-w-[18ch] truncate text-muted-foreground/90 sm:inline">
                        {agents.map((agent) => agentMeta[agent].label.replace(" agent", "")).join(", ")}
                    </span>
                )}
                <span className="text-foreground/80 truncate max-w-[40ch]">{label}</span>
                <span>· {count}</span>
                {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>

            {expanded && (
                <div className="mt-1.5 rounded-lg border border-sep bg-muted/30 p-2 text-xs">
                    <div className="mb-2 flex max-w-full gap-1 overflow-x-auto rounded-md bg-background/60 p-1">
                        {displayedGroups.map((group) => {
                            const GroupIcon = groupIcon(group);
                            const groupTasks = group === "uncategorized"
                                ? tasks.filter((task) => !isProgressAgent(task.agent))
                                : tasks.filter((task) => task.agent === group);
                            const isActive = selectedGroup === group;

                            return (
                                <button
                                    key={group}
                                    type="button"
                                    onClick={() => setActiveGroup(group)}
                                    className={cn(
                                        "inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded px-2 text-[11px] font-medium transition-colors",
                                        isActive
                                            ? "bg-raised text-label-1 shadow-e1"
                                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                    )}
                                >
                                    <GroupIcon className={cn("size-3", groupIconClassName(group))} />
                                    <span title={group === "uncategorized" ? undefined : describeAgent(group)}>{groupLabel(group)}</span>
                                    <span className="text-muted-foreground">{groupTasks.length}</span>
                                    {statusIcon(groupStatus(groupTasks))}
                                </button>
                            );
                        })}
                    </div>

                    <div className="space-y-1">
                        {threadGroups(selectedTasks).map((group) => (
                            <div
                                key={group.key}
                                // The rule is the grouping: it says "these rounds
                                // are one conversation" without spending a line
                                // on a header when there is only one.
                                className={cn(group.badge && "border-l border-sep pl-2")}
                            >
                                {group.badge && (
                                    <div className="pb-0.5 pt-1 text-[10px] font-medium tabular-nums text-muted-foreground/70">
                                        {group.badge}
                                    </div>
                                )}
                                <div className="space-y-1">
                                    {group.tasks.map((t) => (
                                        <div key={t.taskId} className="flex items-start gap-2 py-1">
                                            <span className="mt-0.5 flex-shrink-0">{statusIcon(t.status)}</span>
                                            <div className="min-w-0">
                                                <div className="text-foreground/90">{t.description || t.taskId}</div>
                                                {/* The task names the row; the tool and the
                                                    result are detail under it. Kept on one
                                                    truncating line so a long tool argument
                                                    can't push the next task off the list. */}
                                                {(t.note || t.tool || t.summary) && (
                                                    <div className="truncate text-[11px] text-muted-foreground">
                                                        {[t.note || t.tool, t.summary].filter(Boolean).join(" · ")}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
