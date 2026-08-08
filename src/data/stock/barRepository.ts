import type { BarFeed, BarFetcher, DailyBar, Timeframe } from "./alpacaClient.ts";
import type { BarStore } from "./barStore.ts";

const DEFAULT_BACKFILL_YEARS = 5;
const DAILY_FRESHNESS_MS = 30 * 60 * 1000;
const FIVE_MIN_FRESHNESS_MS = 5 * 60 * 1000;
const ONE_MIN_FRESHNESS_MS = 60 * 1000;
const DAILY_OVERLAP_DAYS = 10;
const INTRADAY_OVERLAP_MINUTES = 5;
const ONE_MIN_BACKFILL_DAYS = 180;
const FIVE_MIN_BACKFILL_DAYS = 10;
/** Relative close-price deviation threshold in the overlap window; exceeding it means a split or dividend occurred. */
const SPLIT_EPSILON = 0.0001;

export type BarRepository = {
  getBars(symbol: string, timeframe: Timeframe, count: number, feed?: BarFeed): Promise<DailyBar[]>;
  /** Bars for an absolute, inclusive date range. `from > to` yields an empty array.
   *  Reaching back before what is cached widens the cache rather than returning a short series. */
  getBarsBetween(symbol: string, timeframe: Timeframe, from: string, to: string, feed?: BarFeed): Promise<DailyBar[]>;
};

export type BarRepositoryDeps = {
  store: BarStore;
  client: BarFetcher;
  /** Tape used when a caller does not name one. */
  defaultFeed?: BarFeed;
  now?: () => Date;
  backfillYears?: number;
  /** Test override; production uses 1m / 5m / 30m depending on timeframe. */
  freshnessMs?: number;
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(value: string, days: number): string {
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function shiftYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return isoDate(d);
}

function shiftMinutes(value: string, minutes: number): string {
  const d = new Date(value);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

function freshnessFor(timeframe: Timeframe): number {
  if (timeframe === "1Min") return ONE_MIN_FRESHNESS_MS;
  if (timeframe === "5Min") return FIVE_MIN_FRESHNESS_MS;
  return DAILY_FRESHNESS_MS;
}

function fullWindow(timeframe: Timeframe, today: string, backfillYears: number): string {
  if (timeframe === "1Day") return shiftYears(today, -backfillYears);
  if (timeframe === "5Min") return shiftDays(today, -FIVE_MIN_BACKFILL_DAYS);
  return shiftDays(today, -ONE_MIN_BACKFILL_DAYS);
}

function incrementalFrom(timeframe: Timeframe, lastBarTs: string): string {
  return timeframe === "1Day"
    ? shiftDays(lastBarTs, -DAILY_OVERLAP_DAYS)
    : shiftMinutes(lastBarTs, -INTRADAY_OVERLAP_MINUTES);
}

/** True if any bar's close price in the overlap window deviates past the threshold. */
function hasSplitDivergence(stored: DailyBar[], fetched: DailyBar[]): boolean {
  const fetchedByTimestamp = new Map(fetched.map((bar) => [bar.t, bar]));
  for (const old of stored) {
    const fresh = fetchedByTimestamp.get(old.t);
    if (!fresh || old.c === 0) continue;
    if (Math.abs(fresh.c - old.c) / Math.abs(old.c) > SPLIT_EPSILON) return true;
  }
  return false;
}

export function createBarRepository(deps: BarRepositoryDeps): BarRepository {
  const { store, client } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const backfillYears = deps.backfillYears ?? DEFAULT_BACKFILL_YEARS;
  const defaultFeed: BarFeed = deps.defaultFeed ?? "iex";

  /** Full backfill. Minute bars keep enough history to support local aggregation into any minute period. */
  async function backfill(
    symbol: string,
    timeframe: Timeframe,
    feed: BarFeed,
    today: string,
    nowIso: string,
    earliest?: string,
  ): Promise<boolean> {
    const window = fullWindow(timeframe, today, backfillYears);
    const from = earliest !== undefined && earliest < window ? earliest : window;
    const bars = await client.fetchBars(symbol, timeframe, from, today, feed);
    if (bars.length === 0) return false;
    await store.putBars(symbol, timeframe, feed, bars);
    await store.putCoverage({
      symbol,
      timeframe,
      feed,
      firstDate: bars[0]!.t,
      lastDate: bars[bars.length - 1]!.t,
      backfilledAt: nowIso,
      lastCheckedAt: nowIso,
    });
    return true;
  }

  /** Bring the local store up to date for this symbol/timeframe, then leave the
   *  reading to the caller. Shared by both public readers so their freshness
   *  behaviour cannot drift apart. */
  async function ensureFresh(symbol: string, timeframe: Timeframe, feed: BarFeed, earliest?: string): Promise<void> {
    const current = now();
    const nowIso = current.toISOString();
    const today = isoDate(current);
    const coverage = await store.getCoverage(symbol, timeframe, feed);

    if (!coverage) {
      await backfill(symbol, timeframe, feed, today, nowIso, earliest);
      return;
    }

    // A request reaching before what was cached is answered by widening the cache, not by silently
    // returning a shorter series: a 10-year beta over a 5-year backfill is a different number.
    if (earliest !== undefined && earliest < coverage.firstDate) {
      const older = await client.fetchBars(symbol, timeframe, earliest, coverage.firstDate, feed);
      if (older.length > 0) {
        await store.putBars(symbol, timeframe, feed, older);
        await store.putCoverage({ ...coverage, firstDate: older[0]!.t, lastCheckedAt: nowIso });
      }
    }

    const checkedAgeMs = current.getTime() - new Date(coverage.lastCheckedAt).getTime();
    const freshnessMs = deps.freshnessMs ?? freshnessFor(timeframe);
    if (checkedAgeMs < freshnessMs) return;

    const from = incrementalFrom(timeframe, coverage.lastDate);
    const fetched = await client.fetchBars(symbol, timeframe, from, today, feed);

    if (fetched.length === 0) {
      await store.putCoverage({ ...coverage, lastCheckedAt: nowIso });
      return;
    }

    const overlap = await store.getBarsOnOrAfter(symbol, timeframe, feed, from);
    if (hasSplitDivergence(overlap, fetched)) {
      await store.clearSymbol(symbol, timeframe, feed);
      await backfill(symbol, timeframe, feed, today, nowIso, earliest ?? coverage.firstDate);
      return;
    }

    await store.putBars(symbol, timeframe, feed, fetched);
    const newest = fetched[fetched.length - 1]!.t;
    await store.putCoverage({
      ...coverage,
      lastDate: newest > coverage.lastDate ? newest : coverage.lastDate,
      lastCheckedAt: nowIso,
    });
  }

  return {
    async getBars(symbol: string, timeframe: Timeframe, count: number, feed: BarFeed = defaultFeed): Promise<DailyBar[]> {
      await ensureFresh(symbol, timeframe, feed);
      return store.getBars(symbol, timeframe, feed, count);
    },

    async getBarsBetween(
      symbol: string,
      timeframe: Timeframe,
      from: string,
      to: string,
      feed: BarFeed = defaultFeed,
    ): Promise<DailyBar[]> {
      if (from > to) return [];
      // Same freshness and backfill path as getBars: a second, divergent copy of
      // that logic is a worse cost than the one coverage comparison it saves.
      await ensureFresh(symbol, timeframe, feed, from);
      const onOrAfter = await store.getBarsOnOrAfter(symbol, timeframe, feed, from);
      return onOrAfter.filter((bar) => bar.t <= to);
    },
  };
}
