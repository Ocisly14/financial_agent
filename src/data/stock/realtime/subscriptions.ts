/**
 * Which symbols the stream is subscribed to, and who is holding each one.
 *
 * Alpaca's free plan caps trades/quotes subscriptions at 30 symbols on a single connection,
 * so subscription slots are a scarce resource that has to be allocated, not just requested.
 * Two kinds of claim compete for them:
 *
 *  - **pinned** — a symbol an active strategy is monitoring. Never evicted. A stop-loss must
 *    not lose its feed because someone opened a chart.
 *  - **leased** — a symbol something is reading right now (a chart, a price tool). Evicted
 *    least-recently-used first, and dropped entirely after an idle window.
 *
 * When the pins alone exceed capacity the excess is reported as `overflow` rather than silently
 * dropped: those strategies fall back to REST polling, and the caller needs to be able to say so.
 *
 * Pure state machine — no network, no clock. Every entry point takes `nowMs` and returns the
 * subscribe/unsubscribe delta for the caller to send.
 */

export interface SubscriptionDelta {
  subscribe: string[];
  unsubscribe: string[];
}

export interface SubscriptionStatus {
  pinned: number;
  leased: number;
  capacity: number;
  /** Active strategy symbols that did not fit and must degrade to REST. */
  overflow: string[];
}

export interface SubscriptionSet {
  /** Drive the pinned set from the current active-strategy symbols. Idempotent. */
  reconcilePins(activeSymbols: readonly string[], nowMs: number): SubscriptionDelta;
  lease(symbol: string, nowMs: number): { subscribed: boolean; delta: SubscriptionDelta };
  expire(nowMs: number): SubscriptionDelta;
  isSubscribed(symbol: string): boolean;
  subscribed(): string[];
  status(): SubscriptionStatus;
}

export const DEFAULT_CAPACITY = 30;
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

type Entry = { pinned: boolean; leasedAt?: number };

const empty = (): SubscriptionDelta => ({ subscribe: [], unsubscribe: [] });

export function createSubscriptionSet(
  options: { capacity?: number | undefined; leaseTtlMs?: number | undefined } = {},
): SubscriptionSet {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  const entries = new Map<string, Entry>();
  let desiredPins: string[] = [];

  const evictableLease = (): string | undefined => {
    let oldest: { symbol: string; at: number } | undefined;
    for (const [symbol, entry] of entries) {
      if (entry.pinned || entry.leasedAt === undefined) continue;
      if (!oldest || entry.leasedAt < oldest.at) oldest = { symbol, at: entry.leasedAt };
    }
    return oldest?.symbol;
  };

  /** Free one slot by dropping the least recently used lease. Pins are never touched. */
  const makeRoom = (delta: SubscriptionDelta): boolean => {
    if (entries.size < capacity) return true;
    const victim = evictableLease();
    if (victim === undefined) return false;
    entries.delete(victim);
    delta.unsubscribe.push(victim);
    return true;
  };

  return {
    reconcilePins(activeSymbols, _nowMs) {
      const delta = empty();
      desiredPins = [...activeSymbols];
      const desired = new Set(desiredPins);

      // Removals first: a symbol leaving the active set may be the slot an incoming pin needs.
      for (const [symbol, entry] of [...entries]) {
        if (!entry.pinned || desired.has(symbol)) continue;
        entry.pinned = false;
        // Something else may still be reading it, in which case it lives on as a lease.
        if (entry.leasedAt === undefined) {
          entries.delete(symbol);
          delta.unsubscribe.push(symbol);
        }
      }

      for (const symbol of desiredPins) {
        const entry = entries.get(symbol);
        if (entry) {
          entry.pinned = true;
          continue;
        }
        if (!makeRoom(delta)) continue; // overflow; reported through status()
        entries.set(symbol, { pinned: true });
        delta.subscribe.push(symbol);
      }

      return delta;
    },

    lease(symbol, nowMs) {
      const existing = entries.get(symbol);
      if (existing) {
        existing.leasedAt = nowMs;
        return { subscribed: true, delta: empty() };
      }
      const delta = empty();
      if (!makeRoom(delta)) return { subscribed: false, delta: empty() };
      entries.set(symbol, { pinned: false, leasedAt: nowMs });
      delta.subscribe.push(symbol);
      return { subscribed: true, delta };
    },

    expire(nowMs) {
      const delta = empty();
      for (const [symbol, entry] of [...entries]) {
        if (entry.pinned || entry.leasedAt === undefined) continue;
        if (nowMs - entry.leasedAt <= leaseTtlMs) continue;
        entries.delete(symbol);
        delta.unsubscribe.push(symbol);
      }
      return delta;
    },

    isSubscribed(symbol) {
      return entries.has(symbol);
    },

    subscribed() {
      return [...entries.keys()];
    },

    status() {
      let pinned = 0;
      let leased = 0;
      for (const entry of entries.values()) {
        if (entry.pinned) pinned += 1;
        else if (entry.leasedAt !== undefined) leased += 1;
      }
      return {
        pinned,
        leased,
        capacity,
        overflow: desiredPins.filter((symbol) => !entries.has(symbol)),
      };
    },
  };
}
