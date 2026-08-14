import { getSnapshotCached, resolveFeed } from "../alpacaClient.ts";
import { getSharedBarRepository } from "../sharedRepository.ts";
import { createRealtimeFeed, type OhlcSample, type RealtimeFeed } from "./index.ts";
import type { StreamSocket } from "./streamClient.ts";

/**
 * Process-wide realtime feed.
 *
 * Alpaca's free plan allows exactly one concurrent stream connection, so this must be a singleton
 * for the same reason `getSharedBarRepository` is: a second one would not be a waste, it would be
 * an error the vendor rejects.
 *
 * Without credentials the feed is still built but never connects: every read falls through to
 * REST, which is the behaviour that existed before this layer.
 */

let feed: RealtimeFeed | undefined;

/** Minute bars covering the window, used to arm a freshly subscribed symbol. */
async function loadBackfill(symbol: string, windowMs: number): Promise<OhlcSample[]> {
  const repository = await getSharedBarRepository();
  if (!repository) return [];
  const minutes = Math.ceil(windowMs / 60_000) + 5;
  const bars = await repository.getBars(symbol, "1Min", Math.max(1, minutes));
  return bars
    .map((bar) => ({ ts: new Date(bar.t).getTime(), high: bar.h, low: bar.l, close: bar.c }))
    .filter((bar) => Number.isFinite(bar.ts));
}

/**
 * Always returns a feed, even without credentials.
 *
 * A feed that never connects still owns the buckets, the filter and the subscription bookkeeping,
 * and its REST fallback answers every read. Returning undefined instead would force every caller —
 * and the monitor in particular — to carry a second, parallel price path for a case that differs
 * only in whether one socket ever opened.
 */
export function getRealtimeFeed(): RealtimeFeed {
  if (feed) return feed;
  const key = process.env["ALPACA_API_KEY_ID"];
  const secret = process.env["ALPACA_API_SECRET_KEY"];
  feed = createRealtimeFeed({
    feed: resolveFeed(),
    credentials: { key: key ?? "", secret: secret ?? "" },
    createSocket: (url) => new WebSocket(url) as unknown as StreamSocket,
    schedule: (fn, delayMs) => {
      const timer = setTimeout(fn, delayMs);
      return () => clearTimeout(timer);
    },
    loadSnapshot: getSnapshotCached,
    loadBackfill,
    capacity: Number(process.env["ALPACA_STREAM_CAPACITY"] ?? 30),
  });
  if (key && secret) feed.start();
  else console.warn("[realtime] ALPACA credentials are not set; prices fall back to REST.");
  return feed;
}

/** Test-only: drops the cached singleton. */
export function resetRealtimeFeed(): void {
  feed?.stop();
  feed = undefined;
}
