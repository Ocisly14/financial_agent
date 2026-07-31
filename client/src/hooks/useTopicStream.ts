import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast as sonnerToast } from "sonner";
import type { UUID } from "@/types/core";
import { apiClient, StreamingApiClient, type ProcessingStep } from "@/lib/api";
import type { StrategyApprovalDialogData } from "@/components/Dialog/StrategyApprovalDialog";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import type { ContentWithUser } from "@/components/chat/types";
import type { ProgressAgent, ProgressTask } from "@/components/ChatProgressPill";

type ClientInterrupt = {
    type: "strategy_approval";
    threadId: string;
    interruptType: "strategy_activation";
    createdAtMs: number;
    payload: StrategyApprovalDialogData;
};

/**
 * Owns the SSE stream lifecycle for one agent/topic pair: message history,
 * in-flight streaming text, live per-task progress, and the strategy-approval
 * interrupt. Lifted verbatim out of chat.tsx so behaviour doesn't shift while
 * the layout work happens around it.
 *
 * `options.onDirective` is the Research layer's only addition: the two
 * layout frames (`topic_focus`, `layout_changed`) are peeled off here and
 * handed over whole, *before* the per-task aggregation below — they describe
 * the workspace, not a unit of work, and rendering them as progress rows
 * would put "the agent looked at NVDA" in the same list as "the agent ran a
 * scan". `useResearchStream` is the only caller that passes it; a Topic
 * session never receives these frames at all.
 */
export function useTopicStream(
    agentId: UUID,
    topicId: UUID,
    options?: { onDirective?: (step: ProcessingStep) => void },
) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { toast } = useToast();
    const { t } = useTranslation();
    const streaming = useMemo(() => new StreamingApiClient(), []);
    const [isProcessing, setIsProcessing] = useState(false);
    const [streamingText, setStreamingText] = useState("");
    const [liveTasks, setLiveTasks] = useState<ProgressTask[]>([]);
    const tasksRef = useRef<Map<string, ProgressTask>>(new Map());
    const [isConnected, setIsConnected] = useState(true);

    // Held in a ref so a caller passing an inline closure doesn't re-create
    // `sendMessage` (and with it the whole stream identity) on every render.
    const onDirectiveRef = useRef(options?.onDirective);
    onDirectiveRef.current = options?.onDirective;

    // Strategy approval state populated by the backend approval event.
    const [pendingInterrupt, setPendingInterrupt] = useState<ClientInterrupt | null>(null);

    const queryKey = useMemo(() => ["messages", agentId, topicId], [agentId, topicId]);
    const { data: messages = [], isLoading: isHistoryLoading } = useQuery<ContentWithUser[]>({
        queryKey,
        queryFn: async () => {
            const result = await apiClient.getMessages(agentId, topicId, { limit: 500 });
            return (result.messages ?? []) as ContentWithUser[];
        },
        refetchOnWindowFocus: false,
    });

    const appendMessages = useCallback(
        (msgs: ContentWithUser[]) => {
            queryClient.setQueryData<ContentWithUser[]>(queryKey, (prev) => [...(prev ?? []), ...msgs]);
        },
        [queryClient, queryKey]
    );

    const sendMessage = useCallback(
        async (text: string) => {
            const trimmed = text.trim();
            if (!trimmed || isProcessing || isHistoryLoading) return;
            const now = Date.now();
            appendMessages([
                { id: `user-${now}`, user: "user", text: trimmed, createdAt: now } as unknown as ContentWithUser,
            ]);
            setIsProcessing(true);
            setStreamingText("");
            tasksRef.current = new Map();
            setLiveTasks([]);
            try {
                await streaming.sendMessageStream(
                    agentId,
                    trimmed,
                    topicId,
                    (step) => {
                        setIsConnected(true);
                        // Research layout frames: not work, not progress.
                        if (step.name === "topic_focus" || step.name === "layout_changed") {
                            onDirectiveRef.current?.(step);
                            return;
                        }
                        if (step.name === "strategy_created") {
                            const data = step.data as { strategy_id?: string; summary?: string } | undefined;
                            const strategyId = data?.strategy_id || step.id;
                            void queryClient.invalidateQueries({ queryKey: ["user", "strategies"] });
                            if (strategyId) {
                                void queryClient.invalidateQueries({ queryKey: ["user", "strategy", strategyId] });
                            }
                            sonnerToast.success("Strategy draft created", {
                                description: data?.summary || step.message,
                                duration: 10_000,
                                action: {
                                    label: "Open",
                                    onClick: () => {
                                        navigate(strategyId ? `/strategies/${agentId}/${strategyId}` : `/strategies/${agentId}`);
                                    },
                                },
                            });
                            return;
                        }

                        // Aggregate the backend's per-task SSE frames (all keyed by
                        // task_id) into one record per subagent task.
                        const id = String(step.id ?? "");
                        if (id) {
                            const map = tasksRef.current;
                            const rec: ProgressTask = { ...(map.get(id) ?? { taskId: id, description: "", status: "in_progress" }) };
                            if (step.name === "dispatch") {
                                const data = step.data as { agent?: string; task?: string } | undefined;
                                const task = data?.task;
                                rec.description = task || rec.description || step.message || "";
                                if (data?.agent === "market_data" || data?.agent === "market_research" || data?.agent === "trading_operations") {
                                    rec.agent = data.agent as ProgressAgent;
                                }
                                if (rec.status !== "completed" && rec.status !== "error") rec.status = "in_progress";
                            } else if (step.name === "tool_call") {
                                rec.description = step.message || rec.description;
                                if (rec.status !== "completed" && rec.status !== "error") rec.status = "in_progress";
                            } else if (step.name === "task_done") {
                                rec.status = step.status === "error" ? "error" : "completed";
                                rec.summary = step.message || rec.summary;
                            } else if (rec.status !== "completed" && rec.status !== "error") {
                                rec.status = "in_progress";
                            }
                            map.set(id, rec);
                            setLiveTasks(Array.from(map.values()));
                        }

                        if (step?.name === "strategy_approval_required" && step?.data) {
                            const d = step.data as StrategyApprovalDialogData & {
                                threadId?: string;
                                approvalId?: string;
                            };
                            const strategyId = d.strategy_id || d.approvalId;
                            if (!strategyId || !d.approvalId) return;
                            setPendingInterrupt({
                                type: "strategy_approval",
                                threadId: d.threadId ?? topicId,
                                interruptType: "strategy_activation",
                                createdAtMs: Date.now(),
                                payload: {
                                    ...d,
                                    threadId: d.threadId ?? topicId,
                                    approvalId: d.approvalId,
                                    strategy_id: strategyId,
                                },
                            });
                        }
                    },
                    () => {}, // onActionResponse
                    (response) => { appendMessages([response as unknown as ContentWithUser]); setStreamingText(""); }, // onIntermediateResponse
                    (responses) => {
                        const tasks = Array.from(tasksRef.current.values());
                        const withTasks = (responses as unknown[]).map((r, i) =>
                            i === 0 ? { ...(r as object), progressTasks: tasks } : r
                        );
                        appendMessages(withTasks as ContentWithUser[]);
                        setLiveTasks([]);
                        setStreamingText("");
                    },
                    undefined, // onTopicUpdate
                    (err) => {
                        setIsConnected(false);
                        const message = typeof err === "string" ? err : err?.message ?? "Error";
                        appendMessages([
                            { id: `err-${Date.now()}`, user: "system", text: `⚠️ ${message}`, createdAt: Date.now() } as unknown as ContentWithUser,
                        ]);
                        setStreamingText("");
                    },
                    () => {
                        setIsProcessing(false);
                        setStreamingText("");
                    },
                    ({ text: streamed }) => setStreamingText(streamed),
                    undefined, // selectedFiles
                    undefined, // messageClassification
                    undefined, // language
                );
            } catch {
                setIsProcessing(false);
                setStreamingText("");
            }
        },
        [agentId, topicId, isProcessing, isHistoryLoading, appendMessages, streaming, queryClient, navigate]
    );

    const stop = useCallback(() => {
        streaming.cancelStreamForAgent(agentId);
        setIsProcessing(false);
        setStreamingText("");
    }, [streaming, agentId]);

    const resolveApproval = useCallback(
        async (decision: "approve" | "reject") => {
            if (!pendingInterrupt || pendingInterrupt.type !== "strategy_approval") return;
            const submitted = pendingInterrupt.payload;
            try {
                await apiClient.activateStrategy(submitted.strategy_id, decision, {
                    threadId: submitted.threadId,
                    approvalId: submitted.approvalId,
                });
                void queryClient.invalidateQueries({ queryKey: ["user", "strategies"] });
                void queryClient.invalidateQueries({ queryKey: ["user", "strategy", submitted.strategy_id] });
                setPendingInterrupt((current) =>
                    current?.type === "strategy_approval" &&
                    current.payload.approvalId === submitted.approvalId
                        ? null
                        : current,
                );
            } catch (error: unknown) {
                if (decision === "approve") {
                    toast({
                        title: "Approval Failed",
                        description: (error as Error)?.message || "Failed to activate strategy",
                        variant: "destructive",
                    });
                } else {
                    toast({
                        title: t("chat.approvalFailedTitle"),
                        description: (error as Error)?.message || "Failed to reject strategy activation",
                        variant: "destructive",
                    });
                }
                throw error;
            }
        },
        [pendingInterrupt, queryClient, toast, t]
    );

    return {
        messages,
        isHistoryLoading,
        isProcessing,
        streamingText,
        liveTasks,
        pendingApproval: pendingInterrupt?.payload ?? null,
        isConnected,
        sendMessage,
        stop,
        resolveApproval,
    };
}
