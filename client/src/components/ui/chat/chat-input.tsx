import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ChatInputProps
    extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

/**
 * Auto-grow textarea: starts at one row, expands with content up to
 * MAX_HEIGHT_PX, then becomes scrollable. Resets back to one row when
 * the controlled `value` clears (e.g. after submit). The forwarded ref
 * still points to the underlying <textarea> so existing callers
 * (focus(), selectionRange, etc.) keep working.
 */
const MAX_HEIGHT_PX = 200;

const ChatInput = React.forwardRef<HTMLTextAreaElement, ChatInputProps>(
    ({ className, value, onInput, ...props }, ref) => {
        const innerRef = React.useRef<HTMLTextAreaElement>(null);
        React.useImperativeHandle(
            ref,
            () => innerRef.current as HTMLTextAreaElement,
        );

        const adjustHeight = React.useCallback(() => {
            const el = innerRef.current;
            if (!el) return;
            // Reset first so shrink-on-delete also works.
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
        }, []);

        // Recompute on every value change. Covers programmatic resets
        // (setInput("") after submit), paste, and i18n template
        // injection. We don't gate this behind onInput because controlled
        // updates from the parent don't necessarily fire onInput.
        React.useLayoutEffect(() => {
            adjustHeight();
        }, [value, adjustHeight]);

        return (
            <Textarea
                autoComplete="off"
                ref={innerRef}
                name="message"
                rows={1}
                value={value}
                onInput={(e) => {
                    adjustHeight();
                    onInput?.(e);
                }}
                className={cn(
                    "min-h-10 max-h-[200px] px-4 py-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 w-full rounded-md resize-none overflow-y-auto",
                    className,
                )}
                {...props}
            />
        );
    },
);
ChatInput.displayName = "ChatInput";

export { ChatInput };
