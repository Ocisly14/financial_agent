import { useRef, useState } from "react";
import { ArrowDown, Send, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UUID } from "@/types/core";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AudioRecorder } from "@/components/audio-recorder";
import { cn } from "@/lib/utils";

interface ChatComposerProps {
    agentId: UUID;
    input: string;
    isProcessing: boolean;
    isDisabled?: boolean;
    isAtBottom: boolean;
    onInputChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    onScrollToBottom: () => void;
}

export function ChatComposer({
    agentId,
    input,
    isProcessing,
    isDisabled = false,
    isAtBottom,
    onInputChange,
    onSend,
    onStop,
    onScrollToBottom,
}: ChatComposerProps) {
    const { t } = useTranslation();
    const [isInputCollapsed, setIsInputCollapsed] = useState(false);
    const collapseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        <div className="flex-shrink-0 z-30 px-2 sm:px-0 pb-[env(safe-area-inset-bottom,0px)] w-full">
            <div
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className={cn(
                    // Hairline + a shallow shadow instead of the old 13px/55%
                    // drop: depth should come from the border, not from a cloud
                    // under the control.
                    "mx-auto w-full px-4 sm:px-0 pointer-events-auto rounded-2xl border border-border/60 backdrop-blur-md shadow-[0_2px_10px_rgba(15,23,42,0.10)] dark:shadow-[0_2px_14px_rgba(0,0,0,0.45)]",
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
                                className="pointer-events-none absolute inset-x-6 bottom-[-40px] h-24 rounded-full bg-slate-500/[0.06] blur-3xl dark:bg-slate-900/40"
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
                                    if (isDisabled) return;
                                    onSend();
                                }}
                                className={cn(
                                    "relative z-10 overflow-hidden rounded-xl border border-border/70 transition-all duration-200",
                                    // The instrument lights up on focus rather
                                    // than sitting permanently raised.
                                    "focus-within:border-sky-500/50 focus-within:ring-1 focus-within:ring-sky-500/20",
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
                                                disabled={!input.trim() || isDisabled}
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

    );
}
