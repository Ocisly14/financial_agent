import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import MessageLoading from "./message-loading";
import { Button, type ButtonProps } from "../button";
import { Brain, ChevronDown, ChevronUp } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useTranslation } from "react-i18next";

// ChatBubble
const chatBubbleVariant = cva(
    "flex gap-2 max-w-full md:max-w items-end relative group",
    {
        variants: {
            variant: {
                received: "self-start",
                sent: "self-end flex-row-reverse",
            },
            layout: {
                default: "",
                ai: "max-w-full w-full items-center",
            },
        },
        defaultVariants: {
            variant: "received",
            layout: "default",
        },
    }
);

interface ChatBubbleProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof chatBubbleVariant> {}

const ChatBubble = React.forwardRef<HTMLDivElement, ChatBubbleProps>(
    ({ className, variant, layout, children, ...props }, ref) => (
        <div
            className={cn(
                chatBubbleVariant({ variant, layout, className }),
                "relative group"
            )}
            ref={ref}
            {...props}
        >
            {React.Children.map(children, (child) =>
                React.isValidElement(child) && typeof child.type !== "string"
                    ? React.cloneElement(child, {
                          variant,
                          layout,
                      } as React.ComponentProps<typeof child.type>)
                    : child
            )}
        </div>
    )
);
ChatBubble.displayName = "ChatBubble";

// ChatBubbleAvatar
interface ChatBubbleAvatarProps {
    src?: string;
    fallback?: string;
    className?: string;
}

const ChatBubbleAvatar: React.FC<ChatBubbleAvatarProps> = ({
    src,
    fallback,
    className,
}) => {
    const { t } = useTranslation();

    return (
        <Avatar className={className}>
            <AvatarImage src={src} alt={t("common.avatar")} />
            <AvatarFallback>{fallback}</AvatarFallback>
        </Avatar>
    );
};

// ChatBubbleMessage
const chatBubbleMessageVariants = cva("p-2 md:p-4 mx-2", {
    variants: {
        variant: {
            received:
                "bg-secondary text-secondary-foreground rounded-r-lg rounded-tl-lg",
            sent: "md:bg-primary md:text-primary-foreground md:rounded-l-lg md:rounded-tr-lg",
        },
        layout: {
            default: "",
            ai: "border-t w-full rounded-none bg-transparent",
        },
    },
    defaultVariants: {
        variant: "received",
        layout: "default",
    },
});

interface ChatBubbleMessageProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof chatBubbleMessageVariants> {
    isLoading?: boolean;
}

const ChatBubbleMessage = React.forwardRef<
    HTMLDivElement,
    ChatBubbleMessageProps
>(
    (
        { className, variant, layout, isLoading = false, children, ...props },
        ref
    ) => (
        <div
            className={cn(
                chatBubbleMessageVariants({ variant, layout, className }),
                "break-words max-w-full whitespace-pre-wrap"
            )}
            ref={ref}
            {...props}
        >
            {isLoading ? (
                <div className="flex items-center space-x-2">
                    <MessageLoading />
                </div>
            ) : (
                children
            )}
        </div>
    )
);
ChatBubbleMessage.displayName = "ChatBubbleMessage";

// ChatBubbleTimestamp
interface ChatBubbleTimestampProps extends React.HTMLAttributes<HTMLDivElement> {
    timestamp: string;
}

const ChatBubbleTimestamp: React.FC<ChatBubbleTimestampProps> = ({
    timestamp,
    className,
    ...props
}) => (
    <div className={cn("fin-figure text-[11px] text-right text-muted-foreground/70 select-none", className)} {...props}>
        {timestamp}
    </div>
);

// ChatBubbleAction
type ChatBubbleActionProps = ButtonProps & {
    icon: React.ReactNode;
};

const ChatBubbleAction: React.FC<ChatBubbleActionProps> = ({
    icon,
    onClick,
    className,
    variant = "ghost",
    size = "icon",
    ...props
}) => (
    <Button
        variant={variant}
        size={size}
        className={className}
        onClick={onClick}
        {...props}
    >
        {icon}
    </Button>
);

interface ChatBubbleActionWrapperProps
    extends React.HTMLAttributes<HTMLDivElement> {
    variant?: "sent" | "received";
    className?: string;
}

const ChatBubbleActionWrapper = React.forwardRef<
    HTMLDivElement,
    ChatBubbleActionWrapperProps
>(({ variant, className, children, ...props }, ref) => (
    <div
        ref={ref}
        className={cn(
            "absolute top-1/2 -translate-y-1/2 flex opacity-100 group-hover:opacity-100 transition-opacity duration-200",
            variant === "sent"
                ? "-left-1 -translate-x-full flex-row-reverse"
                : "-right-1 translate-x-full",
            className
        )}
        {...props}
    >
        {children}
    </div>
));
ChatBubbleActionWrapper.displayName = "ChatBubbleActionWrapper";

// ThinkingBubble - New component for AI thinking process
const thinkingBubbleVariants = cva(
    "border border-dashed border-muted-foreground/30 bg-muted/20 rounded-lg p-3 mb-2 max-w-[80%] self-start",
    {
        variants: {
            variant: {
                default: "",
                collapsed: "cursor-pointer hover:bg-muted/30 transition-colors",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
);

interface ThinkingBubbleProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof thinkingBubbleVariants> {
    thinking: {
        analysis?: string;
        reasoning?: string;
        alternatives_considered?: string;
        considerations?: string;
    };
    isCollapsed?: boolean;
    onToggleCollapse?: () => void;
}

const ThinkingBubble = React.forwardRef<HTMLDivElement, ThinkingBubbleProps>(
    ({ className, variant, thinking, isCollapsed = false, onToggleCollapse, ...props }, ref) => {
        const { t } = useTranslation();
        const hasThinkingData = thinking.analysis || thinking.reasoning || thinking.alternatives_considered || thinking.considerations;
        
        if (!hasThinkingData) return null;

        return (
            <Collapsible open={!isCollapsed} onOpenChange={() => onToggleCollapse?.()}>
                <div
                    className={cn(thinkingBubbleVariants({ variant: isCollapsed ? "collapsed" : "default", className }))}
                    ref={ref}
                    {...props}
                >
                    <CollapsibleTrigger asChild>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                            <Brain className="size-4" />
                            <span className="font-medium">{t('progress.aiThinkingProcess')}</span>
                            {isCollapsed ? (
                                <ChevronDown className="size-4 ml-auto" />
                            ) : (
                                <ChevronUp className="size-4 ml-auto" />
                            )}
                        </div>
                    </CollapsibleTrigger>
                    
                    <CollapsibleContent className="mt-3 space-y-3">
                        {thinking.analysis && (
                            <div className="space-y-1">
                                <div className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">
                                    {t('progress.analysis')}
                                </div>
                                <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                                    {thinking.analysis}
                                </div>
                            </div>
                        )}
                        
                        {thinking.reasoning && (
                            <div className="space-y-1">
                                <div className="text-xs font-semibold text-green-600 dark:text-green-400 uppercase tracking-wide">
                                    {t('progress.reasoning')}
                                </div>
                                <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                                    {thinking.reasoning}
                                </div>
                            </div>
                        )}
                        
                        {thinking.alternatives_considered && (
                            <div className="space-y-1">
                                <div className="text-xs font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wide">
                                    {t('progress.alternativesConsidered')}
                                </div>
                                <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                                    {thinking.alternatives_considered}
                                </div>
                            </div>
                        )}
                        
                        {thinking.considerations && (
                            <div className="space-y-1">
                                <div className="text-xs font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wide">
                                    {t('progress.considerations')}
                                </div>
                                <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                                    {thinking.considerations}
                                </div>
                            </div>
                        )}
                    </CollapsibleContent>
                </div>
            </Collapsible>
        );
    }
);
ThinkingBubble.displayName = "ThinkingBubble";

export {
    ChatBubble,
    ChatBubbleAvatar,
    ChatBubbleMessage,
    ChatBubbleTimestamp,
    chatBubbleVariant,
    chatBubbleMessageVariants,
    ChatBubbleAction,
    ChatBubbleActionWrapper,
    ThinkingBubble,
};
