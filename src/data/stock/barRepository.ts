import type { BarFetcher, DailyBar, Timeframe } from "./alpacaClient.ts";
import type { BarStore } from "./barStore.ts";

const DEFAULT_BACKFILL_YEARS = 5;
const DAILY_FRESHNESS_MS = 30 * 60 * 1000;
const FIVE_MIN_FRESHNESS_MS = 5 * 60 * 1000;
const ONE_MIN_FRESHNESS_MS = 60 * 1000;
const DAILY_OVERLAP_DAYS = 10;
const INTRADAY_OVERLAP_MINUTES = 5;
const ONE_MIN_BACKFILL_DAYS = 180;
const FIVE_MIN_BACKFILL_DAYS = 10;
/** 重叠区收盘价相对偏差阈值；超过即判定发生拆股/分红。 */
const SPLIT_EPSILON = 0.0001;

export type BarRepository = {
  getBars(symbol: string, timeframe: Timeframe, count: number): Promise<DailyBar[]>;
};

export type BarRepositoryDeps = {
  store: BarStore;
  client: BarFetcher;
  now?: () => Date;
  backfillYears?: number;
  /** 测试覆写；生产按 timeframe 使用 1m / 5m / 30m。 */
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

/** 重叠区任一 bar 的收盘价偏差超过阈值即为 true。 */
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

  /** 全量回补。分钟线保留足够历史，以支持任意分钟周期的本地聚合。 */
  async function backfill(
    symbol: string,
    timeframe: Timeframe,
    today: string,
    nowIso: string,
  ): Promise<boolean> {
    const from = fullWindow(timeframe, today, backfillYears);
    const bars = await client.fetchBars(symbol, timeframe, from, today);
    if (bars.length === 0) return false;
    await store.putBars(symbol, timeframe, bars);
    await store.putCoverage({
      symbol,
      timeframe,
      firstDate: bars[0]!.t,
      lastDate: bars[bars.length - 1]!.t,
      backfilledAt: nowIso,
      lastCheckedAt: nowIso,
    });
    return true;
  }

  return {
    async getBars(symbol: string, timeframe: Timeframe, count: number): Promise<DailyBar[]> {
      const current = now();
      const nowIso = current.toISOString();
      const today = isoDate(current);
      const coverage = await store.getCoverage(symbol, timeframe);

      if (!coverage) {
        await backfill(symbol, timeframe, today, nowIso);
        return store.getBars(symbol, timeframe, count);
      }

      const checkedAgeMs = current.getTime() - new Date(coverage.lastCheckedAt).getTime();
      const freshnessMs = deps.freshnessMs ?? freshnessFor(timeframe);
      if (checkedAgeMs < freshnessMs) {
        return store.getBars(symbol, timeframe, count);
      }

      const from = incrementalFrom(timeframe, coverage.lastDate);
      const fetched = await client.fetchBars(symbol, timeframe, from, today);

      if (fetched.length === 0) {
        await store.putCoverage({ ...coverage, lastCheckedAt: nowIso });
        return store.getBars(symbol, timeframe, count);
      }

      const overlap = await store.getBarsOnOrAfter(symbol, timeframe, from);
      if (hasSplitDivergence(overlap, fetched)) {
        await store.clearSymbol(symbol, timeframe);
        await backfill(symbol, timeframe, today, nowIso);
        return store.getBars(symbol, timeframe, count);
      }

      await store.putBars(symbol, timeframe, fetched);
      const newest = fetched[fetched.length - 1]!.t;
      await store.putCoverage({
        ...coverage,
        lastDate: newest > coverage.lastDate ? newest : coverage.lastDate,
        lastCheckedAt: nowIso,
      });
      return store.getBars(symbol, timeframe, count);
    },
  };
}
