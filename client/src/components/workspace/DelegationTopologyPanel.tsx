import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentMeta, isProgressAgent, type ProgressTask } from "@/components/ChatProgressPill";
import { buildDelegationTree, type DelegationNode, type TurnInput } from "@/lib/delegationTree";
import type { ContentWithUser } from "@/components/chat/types";

/**
 * The session's delegation call tree, floating over the workspace's bottom-right
 * corner and growing live as dispatches stream in.
 *
 * It draws what actually happened — every dispatch is a node, `parentTaskId`
 * is the edge — not the static agent topology, so an idle agent never appears
 * and the same agent dispatched twice appears twice. History turns come from
 * the messages' persisted `progressTasks`; the in-flight turn from `liveTasks`.
 *
 * Anchored top-right — clear of the message input in the bottom-right — so the
 * resize handle lives at the BOTTOM-LEFT corner, the one that moves when the
 * panel grows.
 */

const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;
const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 320;
const STORAGE_KEY = "delegation-topology-panel";

// SVG layout: rows stack vertically in DFS order, depth indents to the right.
const ROW_H = 30;
const INDENT = 18;
const NODE_H = 22;
const NODE_W = 220;
const PAD = 10;

type PanelPrefs = { collapsed: boolean; width: number; height: number };

function loadPrefs(): PanelPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<PanelPrefs>;
            return {
                collapsed: parsed.collapsed === true,
                width: Math.max(MIN_WIDTH, Number(parsed.width) || DEFAULT_WIDTH),
                height: Math.max(MIN_HEIGHT, Number(parsed.height) || DEFAULT_HEIGHT),
            };
        }
    } catch {
        // Corrupt or unavailable storage falls back to the defaults below.
    }
    return { collapsed: false, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const agentColor = (agent: string | undefined) =>
    isProgressAgent(agent) ? agentMeta[agent].iconClassName : "text-label-3";

function StatusGlyph({ status, cx, cy }: { status: DelegationNode["status"]; cx: number; cy: number }) {
    if (status === "running") {
        return <circle cx={cx} cy={cy} r={3.5} className="animate-pulse text-blue-500" fill="currentColor" />;
    }
    if (status === "failed") {
        return (
            <g className="text-red-500" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                <line x1={cx - 3} y1={cy - 3} x2={cx + 3} y2={cy + 3} />
                <line x1={cx + 3} y1={cy - 3} x2={cx - 3} y2={cy + 3} />
            </g>
        );
    }
    return (
        <path
            d={`M ${cx - 3.5} ${cy} l 2.5 2.5 l 4.5 -5`}
            className="text-green-500"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
        />
    );
}

export function DelegationTopologyPanel({
    messages,
    liveTasks,
}: {
    messages: ContentWithUser[];
    liveTasks: ProgressTask[];
}) {
    const { t } = useTranslation();
    const [prefs, setPrefs] = useState<PanelPrefs>(loadPrefs);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
        } catch {
            // Storage may be unavailable; the panel still works, it just forgets.
        }
    }, [prefs]);

    // One turn per assistant reply that carried dispatches, labelled by the user
    // message that opened it; the in-flight turn rides on top from liveTasks.
    const turns = useMemo<TurnInput[]>(() => {
        const result: TurnInput[] = [];
        let label = "";
        for (const message of messages) {
            if (message.user === "user") {
                label = String((message as { text?: string }).text ?? "");
                continue;
            }
            const tasks = (message as { progressTasks?: ProgressTask[] }).progressTasks;
            if (tasks && tasks.length > 0) {
                result.push({ turnId: String((message as { id?: string }).id ?? result.length), label, tasks });
            }
        }
        if (liveTasks.length > 0) result.push({ turnId: "live", label, tasks: liveTasks });
        return result;
    }, [messages, liveTasks]);

    const tree = useMemo(() => buildDelegationTree(turns), [turns]);
    const running = tree.nodes.some((node) => node.status === "running");
    const taskCount = tree.nodes.filter((node) => node.kind === "task").length;

    // Follow growth while work is streaming in, so the newest dispatch is on
    // screen without the user chasing it.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && running) el.scrollTop = el.scrollHeight;
    }, [tree.rowCount, running]);

    const startResize = useCallback(
        (event: React.PointerEvent) => {
            event.preventDefault();
            const origin = { x: event.clientX, y: event.clientY, width: prefs.width, height: prefs.height };
            const move = (moveEvent: PointerEvent) => {
                // Anchored top-right: dragging the bottom-left corner left/down grows the panel.
                setPrefs((current) => ({
                    ...current,
                    width: Math.max(MIN_WIDTH, origin.width + (origin.x - moveEvent.clientX)),
                    height: Math.max(MIN_HEIGHT, origin.height + (moveEvent.clientY - origin.y)),
                }));
            };
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        },
        [prefs.width, prefs.height],
    );

    // Nothing dispatched yet: no pill, no window. The panel exists to show
    // delegation, and announcing its absence would just be chrome.
    if (tree.nodes.length === 0) return null;

    if (prefs.collapsed) {
        return (
            <button
                type="button"
                onClick={() => setPrefs((current) => ({ ...current, collapsed: false }))}
                aria-label={t("workspace.topology.expand")}
                className="fixed right-4 top-14 z-40 inline-flex items-center gap-2 rounded-full border border-sep bg-raised px-3 py-1.5 text-xs text-label-2 shadow-e2-rim transition-colors hover:bg-fill-2"
            >
                {running ? <Loader2 className="size-3.5 animate-spin text-blue-500" /> : <Waypoints className="size-3.5" />}
                <span>{t("workspace.topology.steps", { count: taskCount })}</span>
            </button>
        );
    }

    const svgWidth = PAD * 2 + tree.maxDepth * INDENT + NODE_W;
    const svgHeight = tree.rowCount * ROW_H + PAD;
    const nodeX = (depth: number) => PAD + depth * INDENT;
    const rowTop = (row: number) => 4 + row * ROW_H;
    const byId = new Map(tree.nodes.map((node) => [node.id, node]));

    return (
        <section
            aria-label={t("workspace.topology.title")}
            className="fixed right-4 top-14 z-40 flex flex-col overflow-hidden rounded-lg border border-sep bg-raised shadow-e2-rim"
            style={{ width: prefs.width, height: prefs.height }}
        >
            <header className="flex shrink-0 items-center gap-2 border-b border-sep px-3 py-1.5">
                {running ? (
                    <Loader2 className="size-3.5 animate-spin text-blue-500" />
                ) : (
                    <Waypoints className="size-3.5 text-label-2" />
                )}
                <span className="truncate text-xs font-semibold text-label-1">{t("workspace.topology.title")}</span>
                <span className="text-[11px] text-label-3">{t("workspace.topology.steps", { count: taskCount })}</span>
                <button
                    type="button"
                    onClick={() => setPrefs((current) => ({ ...current, collapsed: true }))}
                    aria-label={t("workspace.topology.collapse")}
                    title={t("workspace.topology.collapse")}
                    className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-xs text-label-2 transition-colors hover:bg-fill-2 hover:text-label-1"
                >
                    <ChevronDown className="size-3.5" />
                </button>
            </header>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
                <svg width={svgWidth} height={svgHeight} role="img" aria-label={t("workspace.topology.title")}>
                    {tree.edges.map((edge) => {
                        const parent = byId.get(edge.from);
                        const child = byId.get(edge.to);
                        if (!parent || !child) return null;
                        const sx = nodeX(parent.depth) + 7;
                        const sy = rowTop(parent.row) + NODE_H;
                        const cy = rowTop(child.row) + NODE_H / 2;
                        const cx = nodeX(child.depth);
                        return (
                            <path
                                key={`${edge.from}-${edge.to}`}
                                d={`M ${sx} ${sy} V ${cy - 5} Q ${sx} ${cy} ${sx + 5} ${cy} H ${cx}`}
                                className="text-label-4/60"
                                stroke="currentColor"
                                strokeWidth={1}
                                fill="none"
                            />
                        );
                    })}

                    {tree.nodes.map((node) => {
                        const x = nodeX(node.depth);
                        const y = rowTop(node.row);
                        if (node.kind === "root") {
                            return (
                                <g key={node.id} className="text-label-2">
                                    <circle cx={x + 7} cy={y + NODE_H / 2} r={3} fill="currentColor" />
                                    <text
                                        x={x + 16}
                                        y={y + NODE_H / 2 + 3.5}
                                        fontSize={11}
                                        fontWeight={600}
                                        fill="currentColor"
                                    >
                                        {truncate(node.label || "…", 34)}
                                        <title>{node.label}</title>
                                    </text>
                                </g>
                            );
                        }
                        return (
                            <g key={node.id} className={agentColor(node.agent)}>
                                <rect
                                    x={x}
                                    y={y}
                                    width={NODE_W}
                                    height={NODE_H}
                                    rx={5}
                                    className={cn(node.status === "running" && "animate-pulse")}
                                    stroke="currentColor"
                                    strokeOpacity={0.55}
                                    fill="currentColor"
                                    fillOpacity={0.08}
                                />
                                <StatusGlyph status={node.status} cx={x + 11} cy={y + NODE_H / 2} />
                                <text x={x + 21} y={y + NODE_H / 2 + 3.5} fontSize={11} fill="currentColor">
                                    {truncate(node.agent ?? "", 20)}
                                    {node.badge ? ` ${node.badge}` : ""}
                                </text>
                                <title>
                                    {[node.agent, node.badge, node.label, node.summary].filter(Boolean).join(" · ")}
                                </title>
                            </g>
                        );
                    })}
                </svg>
            </div>

            <span
                onPointerDown={startResize}
                role="separator"
                aria-label={t("workspace.topology.resize")}
                className="absolute bottom-0 left-0 size-4 cursor-nesw-resize bg-fill-2"
                style={{ clipPath: "polygon(0 0, 0 100%, 100% 100%)" }}
            />
        </section>
    );
}
