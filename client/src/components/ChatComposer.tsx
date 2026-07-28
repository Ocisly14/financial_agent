import { useRef, useState } from "react";
import { ArrowDown, Send, Square, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UUID } from "@/types/core";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AudioRecorder } from "@/components/audio-recorder";
import { cn } from "@/lib/utils";
import { ManualComposeDialog } from "@/components/cex/ManualComposeDialog";

interface ChatComposerProps {
    agentId: UUID;
    input: string;
    isProcessing: boolean;
    isAtBottom: boolean;
    onInputChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    onScrollToBottom: () => void;
    /** F10 — called when the user confirms a pre-composed trade order.
     *  The parent (chat.tsx) stages `composed` on its ref and fires the
     *  normal send path with `prompt` as the transcript message. */
    onComposedSend?: (
        prompt: string,
        composed: { action: string; parameters: Record<string, unknown>; preApproved: true }
    ) => void;
}

export function ChatComposer({
    agentId,
    input,
    isProcessing,
    isAtBottom,
    onInputChange,
    onSend,
    onStop,
    onScrollToBottom,
    onComposedSend,
}: ChatComposerProps) {
    const { t } = useTranslation();
    const [isInputCollapsed, setIsInputCollapsed] = useState(false);
    const collapseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // F10 — manual Trade compose dialog state.
    const [composeOpen, setComposeOpen] = useState(false);

    const handleMouseEnter = () => {
        if (collapseTimeoutRef.current) {
            clearTimeout(collapseTimeoutRef.current);
            collapseTimeoutRef.current = null;
        }
        setIsInputCollapsed(false);
    };

    const handleMouseLeave = () => {
        if (input.trim().length > 0) return;
        collapseTimeoutRef.current = setTimeout(() => {
            setIsInputCollapsed(true);
        }, 1000);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (e.nativeEvent.isComposing) return;
            onSend();
        }
    };

    return (
        <>
        <div className="flex-shrink-0 z-30 px-2 sm:px-0 pb-[env(safe-area-inset-bottom,0px)] w-full">
            <div
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className={cn(
                    "mx-auto w-full px-4 sm:px-0 pointer-events-auto rounded-3xl border border-white/30 dark:border-white/20 backdrop-blur-md shadow-[0_5px_13px_rgba(15,23,42,0.55)]",
                    "ease-in-out",
                    isInputCollapsed
                        ? "max-w-[160px] max-h-6 overflow-hidden mb-3 [transition:max-height_0.5s_ease-in-out,max-width_1s_ease-in-out_0.5s]"
                        : "max-w-2xl md:max-w-3xl xl:max-w-4xl max-h-[80vh] mb-2 [transition:max-width_1s_ease-in-out,max-height_0.5s_ease-in-out]"
                )}
            >
                <div
                    className={cn(
                        "flex flex-col transition-opacity duration-300",
                        isInputCollapsed
                            ? "space-y-0 opacity-0 pointer-events-none invisible"
                            : "space-y-1 opacity-100 visible"
                    )}
                    inert={isInputCollapsed ? true : undefined}
                >
                    <div className="px-2 pb-3 pt-2">
                        <div className="relative">
                            <div
                                aria-hidden
                                className="pointer-events-none absolute inset-x-6 bottom-[-40px] h-24 rounded-full bg-slate-500/10 blur-3xl dark:bg-slate-900/60"
                            />
                            {!isAtBottom && (
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    onClick={onScrollToBottom}
                                    className="absolute -top-14 left-1/2 z-20 -translate-x-1/2 rounded-full border-white/70 bg-white/90 text-muted-foreground shadow-[0_18px_40px_rgba(15,23,42,0.25)] backdrop-blur-xl transition-transform duration-300 hover:-translate-y-0.5 hover:text-foreground dark:border-white/10 dark:bg-slate-900/80 dark:text-slate-200"
                                >
                                    <ArrowDown className="size-4" />
                                    <span className="sr-only">{t("common.scrollToLatestMessage")}</span>
                                </Button>
                            )}
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    onSend();
                                }}
                                className={cn(
                                    "relative z-10 overflow-hidden rounded-2xl border border-white/50 shadow-[0_6px_15px_rgba(15,23,42,0.25)] transition-all duration-300 ease-in-out",
                                    "bg-white/80 dark:bg-slate-950/60 supports-[backdrop-filter]:bg-white/55 supports-[backdrop-filter]:backdrop-blur-2xl dark:supports-[backdrop-filter]:bg-slate-900/40"
                                )}
                            >
                                <ChatInput
                                    onKeyDown={handleKeyDown}
                                    value={input}
                                    onChange={(e) => onInputChange(e.target.value)}
                                    placeholder={t("chat.inputPlaceholder")}
                                    className="min-h-10 resize-none rounded-md bg-transparent border-0 py-1 pl-2 pr-0.5 mt-2 shadow-none focus-visible:ring-0"
                                />
                                <div className="flex items-center p-1.5 pt-0">
                                    <AudioRecorder
                                        agentId={agentId}
                                        onChange={(newInput) => onInputChange(newInput)}
                                    />
                                    <div className="ml-auto flex items-center gap-1.5">
                                        {/* F10 — manual Trade compose entry.
                                            Prefills the chat input with a
                                            templated NL trade prompt so the
                                            existing CEX workflow opens the
                                            order editor with accountSnapshot
                                            pre-fetched. The user reviews +
                                            edits the line, then presses Send.
                                            Lightweight scaffold; a richer
                                            in-place form is tracked as F10
                                            follow-up. */}
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            disabled={isProcessing}
                                            title="Compose a trade — opens the order editor; one click places the order"
                                            onClick={() => setComposeOpen(true)}
                                            className={cn("gap-0.5 h-[30px]")}
                                            data-tour="chat-trade"
                                            data-testid="chat-trade-compose"
                                        >
                                            <TrendingUp className="size-3.5" />
                                            Trade
                                        </Button>
                                        {isProcessing ? (
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        type="button"
                                                        variant="destructive"
                                                        size="sm"
                                                        onClick={onStop}
                                                        className="gap-0.5 h-[30px]"
                                                    >
                                                        <Square className="size-3.5" />
                                                        {t("common.stop")}
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent side="top">
                                                    <p>{t("common.stopProcessingImmediately")}</p>
                                                </TooltipContent>
                                            </Tooltip>
                                        ) : (
                                            <Button
                                                type="submit"
                                                size="sm"
                                                disabled={!input.trim()}
                                                className="gap-0.5 h-[30px]"
                                            >
                                                {t("common.sendMessage")}
                                                <Send className="size-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        {/* F10.2 — Manual Trade compose dialog. Confirming inside the
            dialog stages the pre-approved composed payload on the ref
            and immediately fires the standard send path with the NL
            summary as the transcript message. The server honors
            `preApproved` and skips the redundant human_input_required
            modal while keeping every risk gate in place. */}
        <ManualComposeDialog
            open={composeOpen}
            onOpenChange={setComposeOpen}
            agentId={agentId}
            onConfirm={(prompt, composed) => {
                setComposeOpen(false);
                onComposedSend?.(prompt, composed);
            }}
        />
    </>
    );
}
