import type { ServerResponse } from "node:http";
import { getRealtimeFeed } from "../data/stock/realtime/sharedFeed.ts";
import type { RealtimeFeed } from "../data/stock/realtime/index.ts";

/**
 * Server-sent price stream for one symbol.
 *
 * The chart used to poll this value every 5 seconds, which put a hard floor under how fresh a
 * displayed price could be regardless of how fast the quote stream ran underneath. Pushing
 * instead removes that floor without asking the browser to poll harder: nothing is sent while a
 * price is unmoving, so a quiet symbol costs one keepalive comment every 15 seconds.
 *
 * The throttle is applied by the feed's subscription rather than here, using each sample's own
 * timestamp, so it collapses a burst deterministically and needs no timer of its own.
 */

/** Matches the realtime buffer's bucket width: a finer push would be a false resolution. */
export const QUOTE_STREAM_THROTTLE_MS = 500;
/** How often to poll REST while the stream is not connected. */
export const QUOTE_STREAM_FALLBACK_MS = 5_000;

export interface QuoteStreamDeps {
  feed: RealtimeFeed;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => () => void;
  throttleMs?: number | undefined;
  keepaliveMs?: number | undefined;
  fallbackIntervalMs?: number | undefined;
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
}

export function handleStockQuoteStream(
  rawSymbol: string,
  res: ServerResponse,
  deps: Partial<QuoteStreamDeps> = {},
): void {
  const feed = deps.feed ?? getRealtimeFeed();
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  const throttleMs = deps.throttleMs ?? QUOTE_STREAM_THROTTLE_MS;
  const keepaliveMs = deps.keepaliveMs ?? Number.parseInt(process.env["SSE_KEEPALIVE_INTERVAL"] ?? "15000", 10);
  const fallbackIntervalMs = deps.fallbackIntervalMs ?? QUOTE_STREAM_FALLBACK_MS;

  const symbol = rawSymbol.trim().toUpperCase();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Three paths write frames — the opening snapshot, the subscription, and the REST fallback —
  // and the first two overlap by construction: the opening frame IS the buffered price the
  // subscription is about to replay. Deduping at the single exit keeps that from reaching the
  // client twice, and covers a fallback poll that finds nothing has moved.
  let lastSentPrice: number | undefined;
  const send = (price: number, tsMs: number): void => {
    if (price === lastSentPrice) return;
    lastSentPrice = price;
    res.write(`data: ${JSON.stringify({ type: "quote", symbol, price, ts: tsMs })}\n\n`);
  };

  // Whatever is already buffered goes out at once; otherwise the client would show nothing
  // until the symbol happens to trade.
  const buffered = feed.currentPrice(symbol, now());
  if (buffered !== undefined) send(buffered, now());

  const unsubscribe = feed.subscribePrice(symbol, send, { throttleMs });

  const cancelKeepalive = setTimer(() => res.write(": ping\n\n"), keepaliveMs);

  // Only reached when the stream is down: a chart symbol is not necessarily one the monitor is
  // polling, so this path is what keeps a degraded feed from looking like a frozen price.
  const cancelFallback = setTimer(() => {
    if (feed.status().state === "connected") return;
    void feed
      .latestPrice(symbol, now())
      .then((price) => { if (price > 0) send(price, now()); })
      .catch((error: unknown) => console.warn(`[quoteStream] REST fallback failed for ${symbol}:`, error));
  }, fallbackIntervalMs);

  res.on("close", () => {
    unsubscribe();
    cancelKeepalive();
    cancelFallback();
  });
}
