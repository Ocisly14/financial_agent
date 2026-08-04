import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChatComposer } from "@/components/ChatComposer";
import type { UUID, UserInputRequestView } from "@/types/core";
import {
    ChatBubbleMessage,
    ChatBubbleTimestamp,
} from "@/components/ui/chat/chat-bubble";
import { ChatMessageList } from "@/components/ui/chat/chat-message-list";
import { useAutoScroll } from "@/components/ui/chat/hooks/useAutoScroll";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import CopyButton from "@/components/copy-button";
import ChatTtsButton from "@/components/ui/chat/chat-tts-button";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import type { MessageSource } from "@/components/marks/citationContext";
import { MessageTimeContext } from "@/components/stockChartContext";
import type { ContentWithUser } from "@/components/chat/types";
import { ChatProgressPill, type ProgressTask } from "@/components/ChatProgressPill";
import { UserInputCard } from "@/components/chat/UserInputCard";
import { cn, moment } from "@/lib/utils";
import type { useTopicStream } from "@/hooks/useTopicStream";

/** Set by the Research controller when it asked a Topic something on the
 *  user's behalf (spec §5). Persisted on the `user_message` event; absent on
 *  every turn the human actually typed. */
type MessageOrigin = { researchId: string; researchName: string };

function originOf(message: ContentWithUser): MessageOrigin | undefined {
    const candidate =
        (message as { origin?: unknown }).origin ??
        (message as { content?: { origin?: unknown } }).content?.origin;
    if (!candidate || typeof candidate !== "object") return undefined;
    const { researchId, researchName } = candidate as Record<string, unknown>;
    if (typeof researchId !== "string" || typeof researchName !== "string") return undefined;
    return { researchId, researchName };
}

/**
 * The attribution label on a turn the user never typed (spec §5).
 *
 * A Topic's timeline contains user-role messages the Research controller sent
 * on the human's behalf. Unlabelled, the history stops being trustworthy —
 * three months on there is no way to tell what you asked from what was asked
 * for you. Collapsible, because on a Topic that a Research drove hard the
 * label would otherwise out-shout the questions themselves.
 */
function OriginLabel({ agentId, origin }: { agentId: UUID; origin: MessageOrigin }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(true);

    if (!expanded) {
        return (
            <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-label={t("conversation.originExpand")}
                title={t("conversation.originLabel", { name: origin.researchName })}
                className="fin-label text-label-3 transition-colors hover:text-label-1"
            >
                ◇
            </button>
        );
    }

    return (
        <span className="fin-label flex items-center gap-1 text-label-3">
            <Link
                to={`/research/${agentId}/${origin.researchId}`}
                className="truncate transition-colors hover:text-label-1"
                title={origin.researchName}
            >
                {t("conversation.originLabel", { name: origin.researchName })}
            </Link>
            <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label={t("conversation.originCollapse")}
                className="shrink-0 transition-colors hover:text-label-1"
            >
                ×
            </button>
        </span>
    );
}

interface ConversationPaneProps {
    agentId: UUID;
    title: string;
    subtitle?: string;
    stream: ReturnType<typeof useTopicStream>;
    input: string;
    onInputChange: (value: string) => void;
}

/**
 * Renders one conversation: header, message history, and composer. Holds no
 * notion of who is on the other end — it only consumes the `stream` prop, so
 * phase 2's Research view (several topics merged into one session) can reuse
 * this exact component with a different stream.
 */
export function ConversationPane({ agentId, title, subtitle, stream, input, onInputChange }: ConversationPaneProps) {
    const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll } = useAutoScroll();

    const {
        messages,
        isHistoryLoading,
        isProcessing,
        streamingText,
        liveTasks,
        sendMessage,
        stop,
    } = stream;

    const handleSend = () => {
        const trimmed = input.trim();
        if (!trimmed || isProcessing || isHistoryLoading) return;
        onInputChange("");
        void sendMessage(input);
    };

    const renderAssistantContent = (m: ContentWithUser, streaming: boolean) => {
        // Retrieved search hits ride along the message so inline citations can
        // show a source card without another round trip.
        const metadata = (m as { content?: { metadata?: Record<string, unknown> }; metadata?: Record<string, unknown> })
            .content?.metadata ?? (m as { metadata?: Record<string, unknown> }).metadata;
        const sources = Array.isArray(metadata?.sources) ? (metadata.sources as MessageSource[]) : [];
        const inputRequest = metadata?.inputRequest as UserInputRequestView | undefined;
        return (
            <>
                <MarkdownRenderer streaming={streaming} sources={sources}>{m.text ?? ""}</MarkdownRenderer>
                {inputRequest ? (
                    <UserInputCard
                        key={inputRequest.request_id}
                        request={inputRequest}
                        onSubmit={stream.submitUserInput}
                    />
                ) : null}
            </>
        );
    };

    const renderAssistantBubble = (
        m: ContentWithUser,
        opts: { isLoading?: boolean; tasks?: ProgressTask[]; tasksComplete?: boolean; streaming?: boolean } = {}
    ) => (
        // No bubble. The answer is a document and sits on the canvas; the
        // avatar rides in the left gutter so the prose keeps its full measure,
        // and the actions row hangs off the bottom as a footer.
        <article className="group/msg min-w-0 max-w-full py-3">
            <div className="flex min-w-0 gap-3">
                <Avatar className="mt-0.5 hidden size-7 shrink-0 select-none rounded-md border border-sep md:flex">
                    <AvatarFallback className="fin-label rounded-md bg-fill-1 text-label-2">FA</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                    {opts.tasks && opts.tasks.length > 0 && (
                        <ChatProgressPill tasks={opts.tasks} isComplete={opts.tasksComplete ?? true} />
                    )}
                    <ChatBubbleMessage isLoading={opts.isLoading}>
                        {/* Charts draw the current market, but the chat log is
                            persistent. Pass the message's send time down so
                            StockChart can label "sent N days ago". */}
                        <MessageTimeContext.Provider value={m.createdAt ?? null}>
                            {renderAssistantContent(m, opts.streaming ?? false)}
                        </MessageTimeContext.Provider>
                    </ChatBubbleMessage>
                    {/* The footer only appears on hover or keyboard focus —
                        a finished answer should end on its last sentence. */}
                    <div className="mt-2 flex items-center justify-between gap-4 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
                        {m.text && !opts.isLoading ? (
                            <div className="flex items-center gap-1">
                                <CopyButton text={m.text} />
                                <ChatTtsButton agentId={agentId} text={m.text} />
                            </div>
                        ) : <span />}
                        {m.createdAt ? (
                            <ChatBubbleTimestamp timestamp={moment(m.createdAt).format("LT")} />
                        ) : null}
                    </div>
                </div>
            </div>
        </article>
    );

    const renderUserBubble = (m: ContentWithUser) => {
        const origin = originOf(m);
        return (
        <div className="group/msg mb-5 mt-7 flex min-w-0 max-w-full flex-col items-end gap-1">
            {origin && <OriginLabel agentId={agentId} origin={origin} />}
            <ChatBubbleMessage variant="sent" className="max-w-[85%] whitespace-pre-wrap">
                {m.text}
            </ChatBubbleMessage>
            <div className="flex items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
                <CopyButton text={m.text} />
                {m.createdAt ? (
                    <ChatBubbleTimestamp timestamp={moment(m.createdAt).format("LT")} />
                ) : null}
            </div>
        </div>
        );
    };

    return (
        <div className={cn("flex h-full max-h-full min-h-0 min-w-0 flex-col overflow-hidden")}>
            <header className="flex shrink-0 items-baseline gap-2 border-b border-sep px-4 py-2.5">
                <h2 className="truncate text-[13px] font-semibold tracking-[-0.011em]">{title}</h2>
                {subtitle ? <span className="fin-label truncate text-label-3">{subtitle}</span> : null}
            </header>

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
                onInputChange={onInputChange}
                onSend={handleSend}
                onStop={stop}
                onScrollToBottom={scrollToBottom}
            />
        </div>
    );
}
