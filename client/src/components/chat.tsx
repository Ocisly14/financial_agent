import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast as sonnerToast } from "sonner";
import { ChatComposer } from "@/components/ChatComposer";
import type { UUID } from "@/types/core";
import { apiClient, StreamingApiClient } from "@/lib/api";
import {
    StrategyApprovalDialog,
    type StrategyApprovalDialogData,
} from "@/components/Dialog/StrategyApprovalDialog";
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
import type { MessageSource } from "./marks/citationContext";
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

type ClientInterrupt = {
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

    // Strategy approval state populated by the backend approval event.
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

                        if (step?.name === "strategy_approval_required" && step?.data) {
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
                    undefined, // selectedFiles
                    undefined, // messageClassification
                    undefined, // language
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
        // Retrieved search hits ride along the message so inline citations can
        // show a source card without another round trip.
        const metadata = (m as { content?: { metadata?: Record<string, unknown> }; metadata?: Record<string, unknown> })
            .content?.metadata ?? (m as { metadata?: Record<string, unknown> }).metadata;
        const sources = Array.isArray(metadata?.sources) ? (metadata.sources as MessageSource[]) : [];
        return <MarkdownRenderer streaming={streaming} sources={sources}>{m.text ?? ""}</MarkdownRenderer>;
    };

    const renderAssistantBubble = (
        m: ContentWithUser,
        opts: { isLoading?: boolean; tasks?: ProgressTask[]; tasksComplete?: boolean; streaming?: boolean } = {}
    ) => (
        <div className="flex flex-col gap-3 max-w-full min-w-0">
            <div className="max-w-full min-w-0">
                <div className="py-2 max-w-full min-w-0">
                    {/* items-start, not items-center: on a long answer the
                        avatar was floating halfway down the message. */}
                    <ChatBubble variant="received" className="flex flex-row items-start gap-2">
                        <Avatar className="mt-1 hidden md:flex size-8 border rounded-full select-none shrink-0">
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
                    // The answer is the product; the charts support it. At
                    // 440px the prose ran ~30 characters a line and wrapped
                    // every sentence four times, which is what made a research
                    // note read as a cramped chat log. 520–680px is a real
                    // reading measure; the workspace takes whatever is left.
                    : "xl:grid-cols-[minmax(0,1fr)_minmax(520px,600px)] 2xl:grid-cols-[minmax(0,1fr)_minmax(560px,680px)]"
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
                />
            </div>
        </div>

        {pendingInterrupt?.type === "strategy_approval" && (
            <StrategyApprovalDialog
                isOpen
                data={pendingInterrupt.payload}
                onApprove={handleStrategyApprove}
                onReject={handleStrategyReject}
            />
        )}
        </>
    );
}
