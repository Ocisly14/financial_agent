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
    /** A replay keeps the standard composer visible but cannot dispatch. */
    readOnly?: boolean;
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
    readOnly = false,
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
                    // Pure sizing wrapper. It used to carry its own border,
                    // blur and shadow on top of the form's — two nested
                    // materials, and a second elevation for one control.
                    "mx-auto w-full px-4 sm:px-0 pointer-events-auto",
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
                                className="pointer-events-none absolute inset-x-6 bottom-[-40px] h-24 rounded-full bg-fill-1 blur-3xl"
                            />
                            {!isAtBottom && (
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    onClick={onScrollToBottom}
                                    className="material absolute -top-14 left-1/2 z-20 -translate-x-1/2 rounded-full border-sep text-label-2 shadow-e2-rim transition-transform duration-200 hover:-translate-y-0.5 hover:text-label-1"
                                >
                                    <ArrowDown className="size-4" />
                                    <span className="sr-only">{t("common.scrollToLatestMessage")}</span>
                                </Button>
                            )}
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    if (isDisabled || readOnly) return;
                                    onSend();
                                }}
                                className={cn(
                                    // E2 — the one control that lives permanently
                                    // above the message stream, so it is the one
                                    // control that earns an ambient shadow.
                                    "material relative z-10 overflow-hidden rounded-xl border border-sep shadow-e2-rim",
                                    "transition-[border-color,box-shadow] duration-200",
                                    // The instrument lights up on focus rather
                                    // than sitting permanently raised.
                                    "focus-within:border-brand/50 focus-within:ring-1 focus-within:ring-brand/20",
                                )}
                            >
                                <ChatInput
                                    onKeyDown={handleKeyDown}
                                    value={input}
                                    onChange={(e) => onInputChange(e.target.value)}
                                    placeholder={t("chat.inputPlaceholder")}
                                    disabled={isDisabled || readOnly}
                                    className="min-h-10 resize-none rounded-md bg-transparent border-0 py-1 pl-2 pr-0.5 mt-2 shadow-none focus-visible:ring-0"
                                />
                                <div className="flex items-center p-1.5 pt-0">
                                    {!readOnly && (
                                        <AudioRecorder
                                            agentId={agentId}
                                            onChange={(newInput) => onInputChange(newInput)}
                                        />
                                    )}
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
                                                disabled={!input.trim() || isDisabled || readOnly}
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
