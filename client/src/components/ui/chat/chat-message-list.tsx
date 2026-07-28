import * as React from "react";

interface ChatMessageListProps extends React.HTMLAttributes<HTMLDivElement> {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    isAtBottom: boolean;
    scrollToBottom: () => void;
    disableAutoScroll: () => void;
    smooth?: boolean;
}

const ChatMessageList = React.forwardRef<HTMLDivElement, ChatMessageListProps>(
    (
        { className, children, scrollRef, isAtBottom, scrollToBottom, disableAutoScroll, ...props },
        ref
    ) => {
        return (
            <div ref={ref} className="relative w-full h-full">
                {/*
                  The inner div is the actual scroll container — useAutoScroll
                  reads scrollHeight / scrollTop / clientHeight from this
                  element. It MUST have overflow-y-auto; the previous
                  overflow-visible meant scrollHeight === clientHeight and
                  scrollToBottom() was a no-op. Without a real scroll
                  container, overflow fell through to the document body,
                  giving a broken chat where opening a room landed near the
                  oldest message and the floating input bar slid out of view
                  as the user scrolled.
                */}
                <div
                    className={`flex flex-col w-full h-full p-2 md:p-4 overflow-y-auto overflow-x-hidden max-w-full ${className || ""}`}
                    ref={scrollRef}
                    onWheel={disableAutoScroll}
                    onTouchMove={disableAutoScroll}
                    {...props}
                >
                    <div className="flex flex-col gap-6 pb-4 max-w-full min-w-0">{children}</div>
                </div>
            </div>
        );
    }
);

ChatMessageList.displayName = "ChatMessageList";

export { ChatMessageList };
