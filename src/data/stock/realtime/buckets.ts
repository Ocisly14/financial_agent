/**
 * Fixed-size rolling OHLC buffer for one symbol's realtime prices.
 *
 * Streamed quotes arrive far faster than any trigger needs to see them, so prices are
 * aggregated into fixed-width buckets: the bucket keeps the high and low, which is what
 * `trailing_stop` and `rolling_change` actually care about, at a bounded cost per bucket.
 *
 * Two properties this exists to guarantee:
 *
 *  - Buckets are sealed by the arrival of a price in a later bucket, never by a timer.
 *    A timer per symbol would mean N idle timers firing twice a second for no data.
 *  - Storage is a ring of a fixed number of slots, so appending is O(1) and never
 *    allocates. The previous polling buffer re-filtered its whole array on every append,
 *    which was affordable at one sample per 7 seconds and is not at two per second.
 */

export interface OhlcSample {
  ts: number;
  high: number;
  low: number;
  close: number;
}

export interface BucketBuffer {
  /** Fold one price into the bucket its timestamp falls in. */
  append(price: number, tsMs: number): void;
  /** Cold start: place already-aggregated bars (REST backfill) into their buckets. */
  seed(samples: readonly OhlcSample[]): void;
  /** Samples within the last `windowMs`, oldest first. Includes the unsealed current bucket. */
  window(windowMs: number, nowMs: number): OhlcSample[];
  /** Whether the retained samples span at least `windowMs`. */
  isArmed(windowMs: number, nowMs: number): boolean;
  /** Close of the most recent bucket. */
  latest(): number | undefined;
}

export const DEFAULT_BUCKET_MS = 500;
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

type Slot = { index: number; high: number; low: number; close: number };

export function createBucketBuffer(
  options: { bucketMs?: number | undefined; windowMs?: number | undefined } = {},
): BucketBuffer {
  const bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS;
  const capacity = Math.max(1, Math.ceil((options.windowMs ?? DEFAULT_WINDOW_MS) / bucketMs));
  const slots = new Array<Slot | undefined>(capacity);

  let newestIndex: number | undefined;
  let firstIndex: number | undefined;

  const bucketIndex = (tsMs: number): number => Math.floor(tsMs / bucketMs);
  const slotAt = (index: number): Slot | undefined => {
    const slot = slots[((index % capacity) + capacity) % capacity];
    // A slot still holding an older generation's bucket has been lapped by the ring.
    return slot?.index === index ? slot : undefined;
  };

  const put = (index: number, high: number, low: number, close: number): void => {
    if (newestIndex !== undefined && index < newestIndex) return; // stale; a later bucket is already open
    const existing = slotAt(index);
    if (existing) {
      existing.high = Math.max(existing.high, high);
      existing.low = Math.min(existing.low, low);
      existing.close = close;
      return;
    }
    slots[((index % capacity) + capacity) % capacity] = { index, high, low, close };
    newestIndex = index;
    if (firstIndex === undefined) firstIndex = index;
  };

  /** Oldest bucket index still retained: bounded by the ring, and by what has been written. */
  const oldestRetainedIndex = (): number | undefined =>
    newestIndex === undefined || firstIndex === undefined
      ? undefined
      : Math.max(firstIndex, newestIndex - capacity + 1);

  const oldestRetainedTs = (): number | undefined => {
    const oldest = oldestRetainedIndex();
    if (oldest === undefined || newestIndex === undefined) return undefined;
    for (let index = oldest; index <= newestIndex; index++) {
      const slot = slotAt(index);
      if (slot) return slot.index * bucketMs;
    }
    return undefined;
  };

  return {
    append(price, tsMs) {
      if (!Number.isFinite(price) || price <= 0) return;
      put(bucketIndex(tsMs), price, price, price);
    },

    seed(samples) {
      for (const sample of samples) {
        put(bucketIndex(sample.ts), sample.high, sample.low, sample.close);
      }
    },

    window(windowMs, nowMs) {
      const oldest = oldestRetainedIndex();
      if (oldest === undefined || newestIndex === undefined) return [];
      // Walking from the cutoff rather than over the whole ring keeps the cost
      // proportional to the window asked for, not to the hour retained.
      const from = Math.max(oldest, bucketIndex(nowMs - windowMs));
      const out: OhlcSample[] = [];
      for (let index = from; index <= newestIndex; index++) {
        const slot = slotAt(index);
        if (!slot) continue;
        const ts = slot.index * bucketMs;
        if (ts < nowMs - windowMs) continue;
        out.push({ ts, high: slot.high, low: slot.low, close: slot.close });
      }
      return out;
    },

    isArmed(windowMs, nowMs) {
      const oldest = oldestRetainedTs();
      return oldest !== undefined && nowMs - oldest >= windowMs;
    },

    latest() {
      return newestIndex === undefined ? undefined : slotAt(newestIndex)?.close;
    },
  };
}
