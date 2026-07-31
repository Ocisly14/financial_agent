import { createContext } from "react";

/**
 * The message's send time (millisecond timestamp).
 *
 * Chat history is persisted, but `<StockChart />` renders the current quote. If a user scrolls
 * back to this message three days later, the chart shows the price from three days later,
 * mismatching the text written at the time. The component uses this value to label the header
 * "message sent N days ago", giving an explanation for the mismatch between text and chart.
 *
 * A value of null means we're outside a chat context (e.g. the component is reused elsewhere),
 * in which case the badge is not shown.
 */
export const MessageTimeContext = createContext<number | null>(null);

/**
 * Streaming render flag. While true, `<StockChart />` renders only a placeholder skeleton
 * without sending a request — the body is still growing token by token and the tag may be only
 * half-written.
 */
export const StreamingContext = createContext<boolean>(false);
