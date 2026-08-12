import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast as sonnerToast } from "sonner";
import type { MemberInputCard } from "@/lib/memberInput";
import { answerText, shouldContinueResearch } from "@/lib/memberInput";
import type { MemberInputRequestFrame, UUID, UserInputAnswer, UserInputRequestView, UserInputSubmission } from "@/types/core";
import type { ModelRevisionFrame } from "@/types/financialModel";
import { apiClient, StreamingApiClient, type ProcessingStep } from "@/lib/api";
import type { StrategyApprovalDialogData } from "@/components/Dialog/StrategyApprovalDialog";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import type { ContentWithUser } from "@/components/chat/types";
import { isProgressAgent } from "@/components/ChatProgressPill";
import type { ProgressTask } from "@/components/ChatProgressPill";

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
    options?: {
        onDirective?: (step: ProcessingStep) => void;
        onModelRevision?: (frame: ModelRevisionFrame) => void;
        /** Model currently visible in this workspace, if any. */
        activeModelId?: string | null;
    },
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

    // Same rationale as onDirectiveRef: keeps an inline closure from a caller
    // from re-creating `sendMessage` (and the whole stream identity) every render.
    const onModelRevisionRef = useRef(options?.onModelRevision);
    onModelRevisionRef.current = options?.onModelRevision;

    const activeModelIdRef = useRef(options?.activeModelId);
    activeModelIdRef.current = options?.activeModelId;

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

    const updateInputRequests = useCallback(
        (update: (request: UserInputRequestView) => UserInputRequestView) => {
            queryClient.setQueryData<ContentWithUser[]>(queryKey, (previous) =>
                (previous ?? []).map((message) => {
                    const content = (message as { content?: { metadata?: Record<string, unknown> } }).content;
                    const request = content?.metadata?.inputRequest as UserInputRequestView | undefined;
                    if (!request) return message;
                    return {
                        ...message,
                        content: {
                            ...content,
                            metadata: { ...content?.metadata, inputRequest: update(request) },
                        },
                    } as ContentWithUser;
                }),
            );
        },
        [queryClient, queryKey],
    );

    const runTurn = useCallback(
        async (text: string, inputResponse?: UserInputSubmission): Promise<boolean> => {
            const trimmed = text.trim();
            if (!trimmed || isProcessing || isHistoryLoading) return false;
            const now = Date.now();
            appendMessages([
                { id: `user-${now}`, user: "user", text: trimmed, createdAt: now } as unknown as ContentWithUser,
            ]);
            setIsProcessing(true);
            setStreamingText("");
            tasksRef.current = new Map();
            setLiveTasks([]);
            let failed = false;
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
                        if (step.name === "member_input_request") {
                            const data = step.data as MemberInputRequestFrame | undefined;
                            if (data?.request) {
                                // Its own message, so N simultaneous questions render as N cards.
                                appendMessages([{
                                    id: `member-input-${data.request.request_id}`,
                                    user: "assistant",
                                    text: "",
                                    createdAt: Date.now(),
                                    content: {
                                        metadata: {
                                            inputRequest: data.request,
                                            memberTopicId: data.topicId,
                                            memberTopicName: data.topicName,
                                        },
                                    },
                                } as unknown as ContentWithUser]);
                            }
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
                                const data = step.data as { agent?: string; task?: string; thread_id?: string } | undefined;
                                const task = data?.task;
                                rec.description = task || rec.description || step.message || "";
                                if (isProgressAgent(data?.agent)) rec.agent = data.agent;
                                // Only the dispatch frame carries the thread —
                                // the later progress/task_done frames for this
                                // same row do not, so it must stick.
                                if (data?.thread_id) rec.threadId = data.thread_id;
                                if (rec.status !== "completed" && rec.status !== "error") rec.status = "in_progress";
                            } else if (step.name === "tool_call") {
                                // A row's identity is the TASK it was dispatched
                                // to do; the tool is just what it reached for on
                                // this step. Overwriting `description` here made
                                // the pill read "list_financial_models" instead
                                // of "build the DCF model" — the row would then
                                // rename itself on every tool call.
                                rec.tool = step.message || rec.tool;
                                // Orchestrator-level tool calls arrive with no
                                // preceding dispatch, so there is no task to
                                // show; the tool name is the best label there.
                                rec.description = rec.description || step.message || "";
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
                        failed = true;
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
                    0,
                    inputResponse,
                    (frame) => onModelRevisionRef.current?.(frame),
                    activeModelIdRef.current ?? undefined,
                );
            } catch {
                failed = true;
            } finally {
                setIsProcessing(false);
                setStreamingText("");
            }
            return !failed;
        },
        [agentId, topicId, isProcessing, isHistoryLoading, appendMessages, streaming, queryClient, navigate]
    );

    const sendMessage = useCallback(
        async (text: string) => {
            updateInputRequests((request) =>
                request.status === "pending" ? { ...request, status: "skipped" } : request,
            );
            await runTurn(text);
        },
        [runTurn, updateInputRequests],
    );

    const submitUserInput = useCallback(
        async (request: UserInputRequestView, answers: UserInputAnswer[]) => {
            if (request.status !== "pending" || isProcessing || isHistoryLoading) return;
            const previous = queryClient.getQueryData<ContentWithUser[]>(queryKey);
            updateInputRequests((candidate) =>
                candidate.request_id === request.request_id
                    ? { ...candidate, status: "answered", answers }
                    : candidate,
            );

            const text = answerText(request, answers);
            const inputResponse: UserInputSubmission = {
                requestId: request.request_id,
                answers: answers.map((answer) => ({
                    questionId: answer.question_id,
                    selectedOptionIds: answer.selected_option_ids,
                })),
            };
            const ok = await runTurn(text, inputResponse);
            if (!ok) queryClient.setQueryData(queryKey, previous);
        },
        [isProcessing, isHistoryLoading, queryClient, queryKey, runTurn, updateInputRequests],
    );

    /**
     * A member Topic's own answer, delivered to that Topic's own session — not
     * the current one. Deliberately not `runTurn`: that appends to *this*
     * conversation, clears `tasksRef`, and enters processing state, none of
     * which apply here since no turn is starting in this view.
     *
     * `POST /chat` always answers with an SSE stream whether or not the caller
     * wants one. `sendMessageStream` consumes it to completion, so awaiting
     * this call is what keeps the member's resume alive — dropping the
     * connection early would cut it off mid-write. All the step/response
     * callbacks are no-ops: that stream's content belongs to the member's own
     * view, not this one.
     */
    const submitMemberInput = useCallback(
        async (topicId: string, request: UserInputRequestView, answers: UserInputAnswer[]) => {
            if (request.status !== "pending") return;
            updateInputRequests((candidate) =>
                candidate.request_id === request.request_id
                    ? { ...candidate, status: "answered", answers }
                    : candidate,
            );

            const inputResponse: UserInputSubmission = {
                requestId: request.request_id,
                answers: answers.map((answer) => ({
                    questionId: answer.question_id,
                    selectedOptionIds: answer.selected_option_ids,
                })),
            };

            try {
                await streaming.sendMessageStream(
                    agentId,
                    answerText(request, answers),
                    topicId,
                    () => {}, // onStep
                    () => {}, // onActionResponse
                    () => {}, // onIntermediateResponse
                    () => {}, // onFinalResponse
                    undefined, // onTopicUpdate
                    (error) => { sonnerToast.error(String(typeof error === "string" ? error : error?.message ?? error)); },
                    undefined, // onComplete
                    undefined, // onStreamingUpdate
                    undefined, // selectedFiles
                    undefined, // messageClassification
                    undefined, // language
                    0, // retryCount
                    inputResponse,
                );
            } catch {
                // Put the card back so the user can retry; the member never got the answer.
                updateInputRequests((candidate) =>
                    candidate.request_id === request.request_id
                        ? { ...candidate, status: "pending" }
                        : candidate,
                );
            }
        },
        [agentId, streaming, updateInputRequests],
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

    const memberCards = useMemo<MemberInputCard[]>(() => {
        const rows = queryClient.getQueryData<ContentWithUser[]>(queryKey) ?? [];
        return rows.flatMap((row) => {
            const metadata = (row as { content?: { metadata?: Record<string, unknown> } }).content?.metadata;
            const request = metadata?.inputRequest as UserInputRequestView | undefined;
            const topicId = metadata?.memberTopicId as string | undefined;
            if (!request || !topicId) return [];
            return [{
                topicId,
                topicName: (metadata?.memberTopicName as string | undefined) ?? topicId,
                requestId: request.request_id,
                status: request.status,
            }];
        });
    }, [queryClient, queryKey, messages]);

    // Once every card a turn produced is resolved, resume the Research turn
    // exactly once. `continuationFiredRef` is keyed on the set of request ids
    // rather than a boolean: without it the effect would re-fire on every
    // unrelated message append while the resolved set is unchanged, and it
    // re-arms as soon as a new turn's cards appear (memberCards empties out
    // between turns because a fresh turn's assistant messages don't carry
    // the previous turn's resolved cards forward).
    const continuationFiredRef = useRef<string | null>(null);

    useEffect(() => {
        if (!shouldContinueResearch(memberCards)) {
            // Cards gone (new turn) — arm the trigger again.
            if (memberCards.length === 0) continuationFiredRef.current = null;
            return;
        }
        const key = memberCards.map((card) => card.requestId).sort().join("|");
        if (continuationFiredRef.current === key) return;
        continuationFiredRef.current = key;
        void runTurn(t("research.continueAfterMemberInput"));
    }, [memberCards, runTurn, t]);

    return {
        messages,
        memberCards,
        isHistoryLoading,
        isProcessing,
        streamingText,
        liveTasks,
        pendingApproval: pendingInterrupt?.payload ?? null,
        isConnected,
        sendMessage,
        submitUserInput,
        submitMemberInput,
        stop,
        resolveApproval,
    };
}
