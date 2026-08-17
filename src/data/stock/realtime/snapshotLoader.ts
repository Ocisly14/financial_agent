import type { Snapshot } from "../alpacaClient.ts";
import { getRealtimeFeed } from "./sharedFeed.ts";

/**
 * A `loadSnapshot` compatible with the REST one the chart and quote paths already inject.
 *
 * The realtime layer only supplies bid, ask and last price; `dayOpen`, `prevClose` and `volume`
 * exist solely in the REST snapshot. So this is a merge rather than a substitution, and callers
 * see the same shape whether or not the stream happens to be up.
 */
export function realtimeSnapshotLoader(): (symbol: string, nowMs: number) => Promise<Snapshot> {
  return (symbol, nowMs) => getRealtimeFeed().latestSnapshot(symbol, nowMs);
}
