import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast as sonnerToast } from "sonner";
import { ChatComposer } from "@/components/ChatComposer";
import type { UUID, cexParamDef } from "@/types/core";
import { apiClient, StreamingApiClient } from "@/lib/api";
import { Dialog } from "@/components/Dialog/Dialog";
import { type HumanInputDialogData } from "@/components/Dialog/HumanInputDialog";
import { type StrategyApprovalDialogData } from "@/components/Dialog/StrategyApprovalDialog";
import { detectApprovalSurface } from "@/hooks/useApprovalRouter";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import {
    ChatBubble,
    ChatBubbleMessage,
    ChatBubbleTimestamp,
} from "@/components/ui/chat/chat-bubble";
import { ChatMessageList } from "@/components/ui/chat/chat-message-list";
import { useAutoScroll } from "@/components/ui/chat/hooks/useAutoScroll";
import { Avatar, AvatarFallback } from "./ui/avatar";
import CopyButton from "./copy-button";
import ChatTtsButton from "./ui/chat/chat-tts-button";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageTimeContext } from "./stockChartContext";
import { MarketChartWorkspace } from "./MarketChartWorkspace";
import type { ContentWithUser } from "./chat/types";
import { ChatProgressPill, type ProgressAgent, type ProgressTask } from "./ChatProgressPill";
import { cn, moment } from "@/lib/utils";
import {
    buildSymbolChartWorkspace,
} from "@/lib/chartWorkspace";

interface ChatProps {
    agentId: UUID;
    roomId: UUID;
}

// CEX post-PR237 — unified client-side interrupt type. The `trading_approval`
// variant was retired; all approvals now route through `human_input` +
// `HumanInputDialog`. The union is kept so future surfaces can register
// their own interrupt types.
type ClientInterrupt = {
    type: "human_input";
    threadId: string;
    interruptType: string;
    createdAtMs: number;
    payload: HumanInputDialogData;
} | {
    type: "strategy_approval";
    threadId: string;
    interruptType: "strategy_activation";
    createdAtMs: number;
    payload: StrategyApprovalDialogData;
};

/**
 * MVP chat: send a message to the agent backend (POST /api/chat, SSE), stream
 * the reply, and render markdown plus declarative stock charts. Messages are
 * restored from the backend's local SQLite event log into the react-query cache.
 */
export default function Chat({ agentId, roomId }: ChatProps) {
    const queryClient = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();
    const { toast } = useToast();
    const { t } = useTranslation();
    const streaming = useMemo(() => new StreamingApiClient(), []);
    const [input, setInput] = useState("");
    const [isProcessing, setIsProcessing] = useState(false);
    const [streamingText, setStreamingText] = useState("");
    const [showDesktopChartWorkspace, setShowDesktopChartWorkspace] = useState(() =>
        typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
    );
    const [chartWorkspaceCollapsed, setChartWorkspaceCollapsed] = useState(false);
    const [liveTasks, setLiveTasks] = useState<ProgressTask[]>([]);
    const tasksRef = useRef<Map<string, ProgressTask>>(new Map());
    const initialHandledRef = useRef(false);
    const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll } = useAutoScroll();

    // F10 — manual Trade compose dialog. When a composed payload is staged on
    // this ref it rides alongside the NL summary message so the server can
    // short-circuit the LLM and skip the redundant human_input_required modal.
    const composedPayloadRef = useRef<{
        action: string;
        parameters: Record<string, unknown>;
        preApproved?: boolean;
    } | null>(null);

    // Trading approval state — populated when the SSE stream emits
    // `human_input_required` or `human_input_confirm_required`.
    const [pendingInterrupt, setPendingInterrupt] = useState<ClientInterrupt | null>(null);

    const queryKey = useMemo(() => ["messages", agentId, roomId], [agentId, roomId]);
    const { data: messages = [], isLoading: isHistoryLoading } = useQuery<ContentWithUser[]>({
        queryKey,
        queryFn: async () => {
            const result = await apiClient.getMessages(agentId, roomId, { limit: 500 });
            return (result.messages ?? []) as ContentWithUser[];
        },
        refetchOnWindowFocus: false,
    });

    useEffect(() => {
        const media = window.matchMedia("(min-width: 1280px)");
        const update = () => setShowDesktopChartWorkspace(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    const chartWorkspace = useMemo(() => buildSymbolChartWorkspace(
        messages.map((message) => {
            const metadata = (message as { content?: { metadata?: Record<string, unknown> }; metadata?: Record<string, unknown> }).content?.metadata
                ?? (message as { metadata?: Record<string, unknown> }).metadata;
            return {
                user: message.user,
                text: message.text,
                createdAt: message.createdAt,
                visualizations: Array.isArray(metadata?.visualizations) ? metadata.visualizations : [],
            };
        }),
        streamingText,
    ), [messages, streamingText]);

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
            setInput("");
            setIsProcessing(true);
            setStreamingText("");
            tasksRef.current = new Map();
            setLiveTasks([]);
            // F10 — drain the composed payload ref so it rides with this request.
            const composed = composedPayloadRef.current ?? undefined;
            composedPayloadRef.current = null;
            try {
                await streaming.sendMessageStream(
                    agentId,
                    trimmed,
                    roomId,
                    (step) => {
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

                        // Handle generic human-input review / final confirm
                        if (
                            (step?.name === "human_input_required" || step?.name === "human_input_confirm_required") &&
                            step?.data
                        ) {
                            const d = step.data as {
                                type: string;
                                threadId: string;
                                approvalId?: string;
                                interruptType?: string;
                                title: string;
                                description?: string;
                                confirmationsRequired?: number;
                                confirmationLevel?: 1 | 2;
                                fields: Record<string, unknown>;
                                fieldSchema?: Record<string, cexParamDef> | null;
                                summary?: Record<string, unknown>;
                                actionName?: string;
                                accountSnapshot?: {
                                    baseAvailable: string;
                                    quoteAvailable: string;
                                    baseAsset: string;
                                    quoteAsset: string;
                                    feeBps?: number;
                                } | null;
                                // CEX post-PR237 Commit 3 — modal-enrichment
                                market_snapshot?: HumanInputDialogData["market_snapshot"];
                                symbol_verification?: HumanInputDialogData["symbol_verification"];
                                // CEX post-PR237 Commit 4 — multi-step plan context
                                plan_context?: HumanInputDialogData["plan_context"];
                            };
                            const interruptTypeForRouting = d.interruptType ?? d.type;
                            // Classify the interrupt — the §7.4 detection function
                            // distinguishes trading vs generic approvals for observability.
                            detectApprovalSurface({
                                interruptType: interruptTypeForRouting,
                                actionName: d.actionName,
                            });
                            const humanInputData: HumanInputDialogData = {
                                threadId: d.threadId ?? roomId,
                                approvalId: d.approvalId,
                                interruptType: interruptTypeForRouting,
                                title: d.title ?? "Review required",
                                description: d.description,
                                confirmationsRequired: d.confirmationsRequired ?? 2,
                                confirmationLevel: d.confirmationLevel ?? 1,
                                fields: d.fields ?? {},
                                fieldSchema: d.fieldSchema ?? null,
                                summary: d.summary,
                                actionName: d.actionName,
                                accountSnapshot: d.accountSnapshot ?? null,
                                market_snapshot: d.market_snapshot,
                                symbol_verification: d.symbol_verification,
                                plan_context: d.plan_context,
                            };
                            setPendingInterrupt({
                                type: "human_input",
                                threadId: humanInputData.threadId,
                                interruptType: interruptTypeForRouting,
                                createdAtMs: Date.now(),
                                payload: humanInputData,
                            });
                        } else if (step?.name === "strategy_approval_required" && step?.data) {
                            const d = step.data as StrategyApprovalDialogData & {
                                threadId?: string;
                                approvalId?: string;
                            };
                            const strategyId = d.strategy_id || d.approvalId;
                            if (!strategyId || !d.approvalId) return;
                            setPendingInterrupt({
                                type: "strategy_approval",
                                threadId: d.threadId ?? roomId,
                                interruptType: "strategy_activation",
                                createdAtMs: Date.now(),
                                payload: {
                                    ...d,
                                    threadId: d.threadId ?? roomId,
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
                    undefined, // onRoomUpdate
                    (err) => {
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
                    undefined, // favoriteTaskChain
                    undefined, // selectedFiles
                    undefined, // messageClassification
                    undefined, // language
                    composed,  // F10 — structured manual-compose payload
                );
            } catch {
                setIsProcessing(false);
                setStreamingText("");
            }
        },
        [agentId, roomId, isProcessing, isHistoryLoading, appendMessages, streaming, queryClient, navigate]
    );

    // Send an optional message passed by another route via navigation state.
    useEffect(() => {
        const state = location.state as { initialMessage?: string } | null;
        if (state?.initialMessage && !initialHandledRef.current && !isProcessing && !isHistoryLoading) {
            initialHandledRef.current = true;
            void sendMessage(state.initialMessage);
        }
    }, [location.state, isProcessing, isHistoryLoading, sendMessage]);

    const handleStop = () => {
        streaming.cancelStreamForAgent(agentId);
        setIsProcessing(false);
        setStreamingText("");
    };

    // F10 — called from ChatComposer when the user confirms a composed trade.
    // Stages the structured payload on the ref so sendMessage can attach it.
    const handleComposedSend = useCallback(
        (
            prompt: string,
            composed: { action: string; parameters: Record<string, unknown>; preApproved: true }
        ) => {
            composedPayloadRef.current = composed;
            const synthetic = {
                preventDefault: () => {},
            } as unknown as React.FormEvent<HTMLFormElement>;
            void sendMessage(prompt);
            void synthetic; // satisfy linter (unused but mirrors source pattern)
        },
        [sendMessage]
    );

    // §7.4 — Human-input approval handlers. Called from HumanInputDialog via
    // the Dialog router. Both paths use `submitHumanInputApproval` which maps
    // to POST /agents/:id/human-input/approval.

    const handleHumanInputApprove = async (parameters: Record<string, unknown>) => {
        if (!pendingInterrupt || pendingInterrupt.type !== "human_input") return;
        const submitted = pendingInterrupt.payload;

        // CEX post-PR237 Commit 4 — multi-step plan modal. The backend plan
        // runner emits this modal as a visual affordance; it does NOT block on
        // `submitHumanInputApproval` because the plan continuation flows
        // through the chat input pipeline. Routing the Confirm click through a
        // continuation message ("yes") keeps the existing plan-runner contract
        // intact and avoids duplicating idempotency / risk-engine machinery.
        if (submitted.plan_context) {
            setPendingInterrupt((current) =>
                current?.type === "human_input" &&
                current.payload.threadId === submitted.threadId
                    ? null
                    : current,
            );
            window.dispatchEvent(
                new CustomEvent("financial-agent:chat-send", {
                    detail: { text: "yes" },
                }),
            );
            return;
        }

        try {
            await apiClient.submitHumanInputApproval(
                agentId,
                submitted.threadId,
                "approved",
                submitted.confirmationLevel ?? 1,
                parameters,
                submitted.approvalId
            );
            setPendingInterrupt((current) => {
                if (!current || current.type !== "human_input") return current;
                const payload = current.payload;
                const approvalIdMatch =
                    !payload.approvalId || !submitted.approvalId
                        ? true
                        : payload.approvalId === submitted.approvalId;
                const isSameInterrupt =
                    payload.threadId === submitted.threadId &&
                    (payload.confirmationLevel ?? 1) === (submitted.confirmationLevel ?? 1) &&
                    approvalIdMatch;
                return isSameInterrupt ? null : current;
            });
        } catch (error: unknown) {
            toast({
                title: "Approval Failed",
                description: (error as Error)?.message || "Failed to submit human input approval",
                variant: "destructive",
            });
        }
    };

    /**
     * CEX post-PR237 Commit 4 — Approve All Remaining handler for multi-step
     * plan modals. Dismisses the interrupt and sends an APPROVE_BATCH
     * continuation message so the plan runner flips its approval_mode flag and
     * runs all remaining writes without further prompts.
     */
    const handleHumanInputApproveAllRemaining = () => {
        if (!pendingInterrupt || pendingInterrupt.type !== "human_input") return;
        const submitted = pendingInterrupt.payload;
        if (!submitted.plan_context) return;
        setPendingInterrupt((current) =>
            current?.type === "human_input" &&
            current.payload.threadId === submitted.threadId
                ? null
                : current,
        );
        window.dispatchEvent(
            new CustomEvent("financial-agent:chat-send", {
                detail: { text: "approve all remaining steps" },
            }),
        );
    };

    const handleHumanInputReject = async () => {
        if (!pendingInterrupt || pendingInterrupt.type !== "human_input") return;
        const submitted = pendingInterrupt.payload;
        try {
            await apiClient.submitHumanInputApproval(
                agentId,
                submitted.threadId,
                "rejected",
                submitted.confirmationLevel ?? 1,
                undefined,
                submitted.approvalId
            );
        } catch (err) {
            console.error("[handleHumanInputReject] rejection failed", err);
            toast({
                title: t("chat.approvalFailedTitle"),
                description: (err as Error)?.message || t("chat.approvalFailedFallback"),
                variant: "destructive",
            });
        } finally {
            setPendingInterrupt((current) => {
                if (!current || current.type !== "human_input") return current;
                const payload = current.payload;
                const approvalIdMatch =
                    !payload.approvalId || !submitted.approvalId
                        ? true
                        : payload.approvalId === submitted.approvalId;
                const isSameInterrupt =
                    payload.threadId === submitted.threadId &&
                    (payload.confirmationLevel ?? 1) === (submitted.confirmationLevel ?? 1) &&
                    approvalIdMatch;
                return isSameInterrupt ? null : current;
            });
        }
    };

    const handleStrategyApprove = async () => {
        if (!pendingInterrupt || pendingInterrupt.type !== "strategy_approval") return;
        const submitted = pendingInterrupt.payload;
        try {
            await apiClient.activateStrategy(submitted.strategy_id, "approve", {
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
            toast({
                title: "Approval Failed",
                description: (error as Error)?.message || "Failed to activate strategy",
                variant: "destructive",
            });
            throw error;
        }
    };

    const handleStrategyReject = async () => {
        if (!pendingInterrupt || pendingInterrupt.type !== "strategy_approval") return;
        const submitted = pendingInterrupt.payload;
        try {
            await apiClient.activateStrategy(submitted.strategy_id, "reject", {
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
            toast({
                title: t("chat.approvalFailedTitle"),
                description: (error as Error)?.message || "Failed to reject strategy activation",
                variant: "destructive",
            });
            throw error;
        }
    };

    const renderAssistantContent = (m: ContentWithUser, streaming: boolean) => {
        return <MarkdownRenderer streaming={streaming}>{m.text ?? ""}</MarkdownRenderer>;
    };

    const renderAssistantBubble = (
        m: ContentWithUser,
        opts: { isLoading?: boolean; tasks?: ProgressTask[]; tasksComplete?: boolean; streaming?: boolean } = {}
    ) => (
        <div className="flex flex-col gap-3 max-w-full min-w-0">
            <div className="max-w-full min-w-0">
                <div className="py-2 max-w-full min-w-0">
                    <ChatBubble variant="received" className="flex flex-row items-center gap-2">
                        <Avatar className="hidden md:flex size-8 border rounded-full select-none">
                            <AvatarFallback className="rounded-full text-[10px] font-bold">FA</AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col max-w-full min-w-0">
                            {opts.tasks && opts.tasks.length > 0 && (
                                <ChatProgressPill tasks={opts.tasks} isComplete={opts.tasksComplete ?? true} />
                            )}
                            <ChatBubbleMessage isLoading={opts.isLoading}>
                                {/* 图表画的是当下行情，而聊天记录是持久的。把消息的发送
                                    时间传下去，StockChart 才能标注"消息发于 N 天前"。 */}
                                <MessageTimeContext.Provider value={m.createdAt ?? null}>
                                    {renderAssistantContent(m, opts.streaming ?? false)}
                                </MessageTimeContext.Provider>
                            </ChatBubbleMessage>
                            <div className="flex items-center gap-4 justify-between w-full mt-1">
                                {m.text && !opts.isLoading ? (
                                    <div className="flex items-center gap-1">
                                        <CopyButton text={m.text} />
                                        <ChatTtsButton agentId={agentId} text={m.text} />
                                    </div>
                                ) : null}
                                <div className="flex items-center justify-between gap-4 select-none">
                                    {m.createdAt ? (
                                        <ChatBubbleTimestamp timestamp={moment(m.createdAt).format("LT")} />
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </ChatBubble>
                </div>
            </div>
        </div>
    );

    const renderUserBubble = (m: ContentWithUser) => (
        <div className="flex flex-col gap-2 py-2 md:p-4 md:bg-muted/10 md:rounded-lg mb-4 mt-6 max-w-full min-w-0">
            <ChatBubble variant="sent" className="flex flex-row items-center gap-2">
                <div className="flex flex-col">
                    <ChatBubbleMessage>{m.text}</ChatBubbleMessage>
                    <div className="flex items-center gap-4 justify-between w-full mt-1">
                        <div className="flex items-center gap-1">
                            <CopyButton text={m.text} />
                        </div>
                        <div className="flex items-center justify-between gap-4 select-none">
                            {m.createdAt ? (
                                <ChatBubbleTimestamp timestamp={moment(m.createdAt).format("LT")} />
                            ) : null}
                        </div>
                    </div>
                </div>
            </ChatBubble>
        </div>
    );

    return (
        <>
        <div className={cn(
            "grid h-dvh max-h-dvh w-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-200",
            showDesktopChartWorkspace && chartWorkspace.charts.length > 0
                ? chartWorkspaceCollapsed
                    ? "xl:grid-cols-[48px_minmax(0,1fr)]"
                    : "xl:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]"
                : "",
        )}>
            {showDesktopChartWorkspace && chartWorkspace.charts.length > 0 && (
                <div className="h-dvh max-h-dvh min-h-0 min-w-0 overflow-hidden">
                    <MarketChartWorkspace
                        charts={chartWorkspace.charts}
                        focusSymbol={chartWorkspace.focusSymbol}
                        focusRevision={chartWorkspace.focusRevision}
                        collapsed={chartWorkspaceCollapsed}
                        onCollapsedChange={setChartWorkspaceCollapsed}
                    />
                </div>
            )}

            <div className="flex h-dvh max-h-dvh min-h-0 min-w-0 flex-col overflow-hidden">
                <div className="flex-1 min-h-0">
                    <ChatMessageList
                        scrollRef={scrollRef}
                        isAtBottom={isAtBottom}
                        scrollToBottom={scrollToBottom}
                        disableAutoScroll={disableAutoScroll}
                    >
                        {messages.map((m) => (
                            <div key={String(m.id)} className="max-w-full min-w-0">
                                {m.user === "user"
                                    ? renderUserBubble(m)
                                    : renderAssistantBubble(m, {
                                          tasks: (m as { progressTasks?: ProgressTask[] }).progressTasks,
                                          tasksComplete: true,
                                      })}
                            </div>
                        ))}
                        {isProcessing &&
                            renderAssistantBubble(
                                { text: streamingText, createdAt: Date.now() } as unknown as ContentWithUser,
                                { isLoading: !streamingText, streaming: true, tasks: liveTasks, tasksComplete: liveTasks.length > 0 && liveTasks.every((t) => t.status === "completed" || t.status === "error") }
                            )}
                    </ChatMessageList>
                </div>

                <ChatComposer
                    agentId={agentId}
                    input={input}
                    isProcessing={isProcessing}
                    isDisabled={isHistoryLoading}
                    isAtBottom={isAtBottom}
                    onInputChange={setInput}
                    onSend={() => void sendMessage(input)}
                    onStop={handleStop}
                    onScrollToBottom={scrollToBottom}
                    onComposedSend={handleComposedSend}
                />
            </div>
        </div>

        {/* CEX post-PR237 cleanup — `trading_approval` was retired.
            All trading approvals now route through `human_input` +
            `HumanInputDialog`, which embeds `TradingOrderEditor` and
            `MarketSnapshotPanel`. */}
        {pendingInterrupt?.type === "human_input" && (
            <Dialog
                id="human_input"
                props={{
                    isOpen: true,
                    data: pendingInterrupt.payload,
                    onApprove: handleHumanInputApprove,
                    onReject: handleHumanInputReject,
                    onApproveAllRemaining: handleHumanInputApproveAllRemaining,
                    agentId,
                }}
            />
        )}
        {pendingInterrupt?.type === "strategy_approval" && (
            <Dialog
                id="strategy_approval"
                props={{
                    isOpen: true,
                    data: pendingInterrupt.payload,
                    onApprove: handleStrategyApprove,
                    onReject: handleStrategyReject,
                }}
            />
        )}
        </>
    );
}
