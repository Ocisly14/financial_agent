import type { BarFetcher, DailyBar } from "./alpacaClient.ts";
import type { BarStore } from "./barStore.ts";

const DEFAULT_BACKFILL_YEARS = 5;
const DEFAULT_FRESHNESS_MS = 30 * 60 * 1000;
/** 增量请求回退的自然日数，确保覆盖至少 5 个交易日用于重叠比对。 */
const OVERLAP_DAYS = 10;
/** 重叠区收盘价相对偏差阈值；超过即判定发生拆股/分红。 */
const SPLIT_EPSILON = 0.0001;

export type BarRepository = {
  getDailyBars(symbol: string, days: number): Promise<DailyBar[]>;
};

export type BarRepositoryDeps = {
  store: BarStore;
  client: BarFetcher;
  now?: () => Date;
  backfillYears?: number;
  freshnessMs?: number;
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function shiftYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return isoDate(d);
}

/** 重叠区任一交易日的收盘价偏差超过阈值即为 true。 */
function hasSplitDivergence(stored: DailyBar[], fetched: DailyBar[]): boolean {
  const fetchedByDate = new Map(fetched.map((bar) => [bar.t, bar]));
  for (const old of stored) {
    const fresh = fetchedByDate.get(old.t);
    if (!fresh || old.c === 0) continue;
    if (Math.abs(fresh.c - old.c) / Math.abs(old.c) > SPLIT_EPSILON) return true;
  }
  return false;
}

export function createBarRepository(deps: BarRepositoryDeps): BarRepository {
  const { store, client } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const backfillYears = deps.backfillYears ?? DEFAULT_BACKFILL_YEARS;
  const freshnessMs = deps.freshnessMs ?? DEFAULT_FRESHNESS_MS;

  /** 全量回补。返回是否写入了数据。 */
  async function backfill(symbol: string, today: string, nowIso: string): Promise<boolean> {
    const bars = await client.fetchDailyBars(symbol, shiftYears(today, -backfillYears), today);
    if (bars.length === 0) return false;
    await store.putBars(symbol, bars);
    await store.putCoverage({
      symbol,
      firstDate: bars[0]!.t,
      lastDate: bars[bars.length - 1]!.t,
      backfilledAt: nowIso,
      lastCheckedAt: nowIso,
    });
    return true;
  }

  return {
    async getDailyBars(symbol: string, days: number): Promise<DailyBar[]> {
      const current = now();
      const nowIso = current.toISOString();
      const today = isoDate(current);
      const coverage = await store.getCoverage(symbol);

      if (!coverage) {
        await backfill(symbol, today, nowIso);
        return store.getBars(symbol, days);
      }

      const checkedAgeMs = current.getTime() - new Date(coverage.lastCheckedAt).getTime();
      if (checkedAgeMs < freshnessMs) {
        return store.getBars(symbol, days);
      }

      const from = shiftDays(coverage.lastDate, -OVERLAP_DAYS);
      const fetched = await client.fetchDailyBars(symbol, from, today);

      if (fetched.length === 0) {
        await store.putCoverage({ ...coverage, lastCheckedAt: nowIso });
        return store.getBars(symbol, days);
      }

      const overlap = await store.getBarsOnOrAfter(symbol, from);
      if (hasSplitDivergence(overlap, fetched)) {
        // 拆股/分红：库中历史已是过期口径，整体重拉
        await store.clearSymbol(symbol);
        await backfill(symbol, today, nowIso);
        return store.getBars(symbol, days);
      }

      await store.putBars(symbol, fetched);
      const newest = fetched[fetched.length - 1]!.t;
      await store.putCoverage({
        ...coverage,
        lastDate: newest > coverage.lastDate ? newest : coverage.lastDate,
        lastCheckedAt: nowIso,
      });
      return store.getBars(symbol, days);
    },
  };
}
