import type { Snapshot } from "../alpacaClient.ts";
import { createBucketBuffer, DEFAULT_BUCKET_MS, DEFAULT_WINDOW_MS, type BucketBuffer, type OhlcSample } from "./buckets.ts";
import { createQuoteFilter, type QuoteFilter } from "./quoteFilter.ts";
import { createSubscriptionSet, type SubscriptionDelta } from "./subscriptions.ts";
import { createStreamClient, type StreamSocket, type StreamState } from "./streamClient.ts";

export type { OhlcSample } from "./buckets.ts";
export type { StreamState } from "./streamClient.ts";

/**
 * The one place realtime prices come from.
 *
 * Composes the stream client, the subscription budget, the entry filter and the per-symbol
 * buckets into an interface the rest of the app can use without knowing any of that exists.
 *
 * Two rules shape the read path:
 *
 *  - **Reads never write.** `latestPrice` falling back to REST does not push that price into
 *    the window. A window is a record of what the stream saw; mixing a 5-second-cached REST
 *    value into a 500ms series would make it lie about its own resolution. Degraded polling
 *    writes through `recordPrice`, explicitly.
 *  - **A snapshot is a merge, not a replacement.** Quotes carry bid and ask; `dayOpen`,
 *    `prevClose` and `volume` only exist in the REST snapshot. So the snapshot path keeps
 *    REST's daily aggregates and overlays the live quote on top.
 */

/** How long a streamed price stays trustworthy without a follow-up. */
export const DEFAULT_MAX_STALENESS_MS = 15_000;

export interface RealtimeFeedOptions {
  feed: string;
  credentials: { key: string; secret: string };
  createSocket: (url: string) => StreamSocket;
  schedule: (fn: () => void, delayMs: number) => () => void;
  loadSnapshot: (symbol: string, nowMs: number) => Promise<Snapshot>;
  loadBackfill: (symbol: string, windowMs: number) => Promise<OhlcSample[]>;
  jitter?: (() => number) | undefined;
  capacity?: number | undefined;
  leaseTtlMs?: number | undefined;
  maxStalenessMs?: number | undefined;
  degradeAfterAttempts?: number | undefined;
  windowMs?: number | undefined;
  bucketMs?: number | undefined;
}

export interface RealtimeStatus {
  state: StreamState;
  pinned: number;
  leased: number;
  capacity: number;
  overflow: string[];
}

export interface RealtimeFeed {
  start(): void;
  stop(): void;
  /** Mid price: the stream when it is fresh and trusted, REST otherwise. */
  latestPrice(symbol: string, nowMs: number): Promise<number>;
  /** Full snapshot: REST daily aggregates with the live quote overlaid. */
  latestSnapshot(symbol: string, nowMs: number): Promise<Snapshot>;
  /**
   * Most recent trustworthy buffered price, without touching the network.
   *
   * Undefined when nothing is buffered, when the stream is not connected, or when the newest
   * bucket has gone stale — outside market hours the socket stays up and simply goes quiet, and
   * a strategy must not keep evaluating against the last print of the session.
   */
  currentPrice(symbol: string, nowMs: number): number | undefined;
  window(symbol: string, windowMs: number, nowMs: number): OhlcSample[];
  isArmed(symbol: string, windowMs: number, nowMs: number): boolean;
  /** Drive pinned subscriptions from the current active-strategy symbols. */
  reconcileStrategySymbols(symbols: readonly string[], nowMs: number): void;
  /** Write path for degraded REST polling. */
  recordPrice(symbol: string, price: number, tsMs: number): void;
  /**
   * Push accepted prices for one symbol as they land. Returns an unsubscribe function.
   *
   * `throttleMs` collapses a burst to at most one delivery per interval, keeping the newest
   * price; the sample's own timestamp is the clock, so this stays deterministic and needs no
   * timer. An unchanged price is never re-delivered — a subscriber only hears about movement.
   */
  subscribePrice(
    symbol: string,
    listener: (price: number, tsMs: number) => void,
    options?: { throttleMs?: number | undefined },
  ): () => void;
  /** Drop idle leases. */
  sweep(nowMs: number): void;
  status(): RealtimeStatus;
}

type PriceSubscriber = {
  listener: (price: number, tsMs: number) => void;
  throttleMs: number;
  lastSentAt?: number;
  lastSentPrice?: number;
};

type SymbolState = {
  buffer: BucketBuffer;
  filter: QuoteFilter;
  lastQuote?: { bid: number; ask: number; ts: number };
  backfilling: boolean;
  subscribers: Set<PriceSubscriber>;
};

function snapshotMid(snapshot: Snapshot): number {
  if (snapshot.bidPrice !== null && snapshot.askPrice !== null && snapshot.bidPrice > 0 && snapshot.askPrice > 0) {
    return (snapshot.bidPrice + snapshot.askPrice) / 2;
  }
  return snapshot.price ?? 0;
}

export function createRealtimeFeed(options: RealtimeFeedOptions): RealtimeFeed {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS;
  const maxStalenessMs = options.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS;

  const symbols = new Map<string, SymbolState>();
  const subscriptions = createSubscriptionSet({
    capacity: options.capacity,
    leaseTtlMs: options.leaseTtlMs,
  });

  const stateFor = (symbol: string): SymbolState => {
    const existing = symbols.get(symbol);
    if (existing) return existing;
    const created: SymbolState = {
      buffer: createBucketBuffer({ windowMs, bucketMs }),
      filter: createQuoteFilter(),
      backfilling: false,
      subscribers: new Set(),
    };
    symbols.set(symbol, created);
    return created;
  };

  /** Deliver an accepted price to this symbol's subscribers, honouring each one's throttle. */
  const publish = (state: SymbolState, price: number, tsMs: number): void => {
    for (const subscriber of state.subscribers) {
      if (subscriber.lastSentPrice === price) continue;
      if (subscriber.lastSentAt !== undefined && tsMs - subscriber.lastSentAt < subscriber.throttleMs) continue;
      subscriber.lastSentAt = tsMs;
      subscriber.lastSentPrice = price;
      subscriber.listener(price, tsMs);
    }
  };

  const stream = createStreamClient({
    feed: options.feed,
    credentials: options.credentials,
    createSocket: options.createSocket,
    schedule: options.schedule,
    jitter: options.jitter,
    degradeAfterAttempts: options.degradeAfterAttempts,
    onQuote: (symbol, quote) => {
      const state = stateFor(symbol);
      const result = state.filter.accept(quote);
      if (!result.ok) return;
      state.lastQuote = { bid: quote.bid, ask: quote.ask, ts: quote.ts };
      state.buffer.append(result.mid, quote.ts);
      publish(state, result.mid, quote.ts);
    },
  });

  /** Fill a freshly subscribed symbol's window from history so it arms without waiting. */
  const kickBackfill = (symbol: string): void => {
    const state = stateFor(symbol);
    if (state.backfilling) return;
    state.backfilling = true;
    void options
      .loadBackfill(symbol, windowMs)
      .then((samples) => state.buffer.seed(samples))
      .catch((error: unknown) => {
        state.backfilling = false;
        console.warn(`[realtime] backfill failed for ${symbol}:`, error);
      });
  };

  const applyDelta = (delta: SubscriptionDelta): void => {
    if (delta.unsubscribe.length > 0) {
      stream.unsubscribe(delta.unsubscribe);
      // Drop the buffer too: a resubscribe later must not resume from a stale window.
      for (const symbol of delta.unsubscribe) symbols.delete(symbol);
    }
    if (delta.subscribe.length > 0) {
      stream.subscribe(delta.subscribe);
      for (const symbol of delta.subscribe) kickBackfill(symbol);
    }
  };

  /** Ensure the symbol has a subscription slot; returns whether it got one. */
  const ensureLeased = (symbol: string, nowMs: number): boolean => {
    const result = subscriptions.lease(symbol, nowMs);
    applyDelta(result.delta);
    return result.subscribed;
  };

  const freshStreamQuote = (symbol: string, nowMs: number): { bid: number; ask: number; ts: number } | undefined => {
    if (stream.state() !== "connected") return undefined;
    const quote = symbols.get(symbol)?.lastQuote;
    if (!quote) return undefined;
    return nowMs - quote.ts <= maxStalenessMs ? quote : undefined;
  };

  return {
    start() {
      stream.connect();
    },

    stop() {
      stream.close();
    },

    async latestPrice(symbol, nowMs) {
      ensureLeased(symbol, nowMs);
      const quote = freshStreamQuote(symbol, nowMs);
      if (quote) return (quote.bid + quote.ask) / 2;
      return snapshotMid(await options.loadSnapshot(symbol, nowMs));
    },

    async latestSnapshot(symbol, nowMs) {
      ensureLeased(symbol, nowMs);
      const rest = await options.loadSnapshot(symbol, nowMs);
      const quote = freshStreamQuote(symbol, nowMs);
      if (!quote) return rest;
      return {
        ...rest,
        bidPrice: quote.bid,
        askPrice: quote.ask,
        price: (quote.bid + quote.ask) / 2,
        quoteTimestamp: new Date(quote.ts).toISOString(),
      };
    },

    currentPrice(symbol, nowMs) {
      return freshStreamQuote(symbol, nowMs) ? symbols.get(symbol)?.buffer.latest() : undefined;
    },

    window(symbol, spanMs, nowMs) {
      return symbols.get(symbol)?.buffer.window(spanMs, nowMs) ?? [];
    },

    isArmed(symbol, spanMs, nowMs) {
      return symbols.get(symbol)?.buffer.isArmed(spanMs, nowMs) ?? false;
    },

    reconcileStrategySymbols(activeSymbols, nowMs) {
      applyDelta(subscriptions.reconcilePins(activeSymbols, nowMs));
    },

    recordPrice(symbol, price, tsMs) {
      const state = stateFor(symbol);
      state.buffer.append(price, tsMs);
      publish(state, price, tsMs);
    },

    subscribePrice(symbol, listener, options = {}) {
      const state = stateFor(symbol);
      const subscriber: PriceSubscriber = { listener, throttleMs: options.throttleMs ?? 0 };
      state.subscribers.add(subscriber);
      return () => { state.subscribers.delete(subscriber); };
    },

    sweep(nowMs) {
      applyDelta(subscriptions.expire(nowMs));
    },

    status() {
      return { state: stream.state(), ...subscriptions.status() };
    },
  };
}
