import { useEffect, useState } from "react";
import { Loader2, CheckCircle, Circle, XCircle, ChevronDown, ChevronRight, Database, Newspaper, ChartNoAxesCombined } from "lucide-react";
import { cn } from "@/lib/utils";

export type ProgressAgent = "market_data" | "market_research" | "trading_operations";

export interface ProgressTask {
    taskId: string;
    description: string;
    agent?: ProgressAgent;
    tool?: string;
    status: "in_progress" | "completed" | "error";
    summary?: string;
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

const agentMeta: Record<ProgressAgent, { label: string; icon: typeof Database; iconClassName: string }> = {
    market_data: {
        label: "Market data agent",
        icon: Database,
        iconClassName: "text-blue-600 dark:text-blue-300",
    },
    market_research: {
        label: "Market research agent",
        icon: Newspaper,
        iconClassName: "text-violet-600 dark:text-violet-300",
    },
    trading_operations: {
        label: "Stock strategy agent",
        icon: ChartNoAxesCombined,
        iconClassName: "text-amber-600 dark:text-amber-300",
    },
};

function uniqueAgents(tasks: ProgressTask[]) {
    return (["market_data", "market_research", "trading_operations"] as const).filter((agent) => tasks.some((task) => task.agent === agent));
}

function taskGroups(tasks: ProgressTask[], agents: ProgressAgent[]): Array<ProgressAgent | "uncategorized"> {
    const hasUncategorized = tasks.some((task) => !task.agent);
    return hasUncategorized ? [...agents, "uncategorized"] : agents;
}

function groupLabel(group: ProgressAgent | "uncategorized") {
    return group === "uncategorized" ? "Other" : agentMeta[group].label;
}

function groupIcon(group: ProgressAgent | "uncategorized") {
    return group === "uncategorized" ? Circle : agentMeta[group].icon;
}

function groupIconClassName(group: ProgressAgent | "uncategorized") {
    return group === "uncategorized" ? "text-label-4" : agentMeta[group].iconClassName;
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
        ? tasks.filter((task) => !task.agent)
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
                                ? tasks.filter((task) => !task.agent)
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
                                    <span>{groupLabel(group)}</span>
                                    <span className="text-muted-foreground">{groupTasks.length}</span>
                                    {statusIcon(groupStatus(groupTasks))}
                                </button>
                            );
                        })}
                    </div>

                    <div className="space-y-1">
                        {selectedTasks.map((t) => (
                            <div key={t.taskId} className="flex items-start gap-2 py-1">
                                <span className="mt-0.5 flex-shrink-0">{statusIcon(t.status)}</span>
                                <div className="min-w-0">
                                    <div className="text-foreground/90">{t.description || t.taskId}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
