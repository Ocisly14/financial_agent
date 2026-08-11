import type { BarFeed, DailyBar, Timeframe } from "../alpacaClient.ts";
import type { BarStore, Coverage } from "../barStore.ts";

/** In-memory implementation of BarStore, for use in unit tests. Semantics must match MongoBarStore. */
export class InMemoryBarStore implements BarStore {
  private readonly bars = new Map<string, Map<string, DailyBar>>();
  private readonly coverage = new Map<string, Coverage>();

  private key(symbol: string, timeframe: Timeframe, feed: BarFeed): string {
    return `${symbol}:${timeframe}:${feed}`;
  }

  private sorted(symbol: string, timeframe: Timeframe, feed: BarFeed): DailyBar[] {
    const byDate = this.bars.get(this.key(symbol, timeframe, feed));
    if (!byDate) return [];
    return [...byDate.values()].sort((a, b) => a.t.localeCompare(b.t));
  }

  async getCoverage(symbol: string, timeframe: Timeframe, feed: BarFeed): Promise<Coverage | undefined> {
    return this.coverage.get(this.key(symbol, timeframe, feed));
  }

  async putCoverage(coverage: Coverage): Promise<void> {
    this.coverage.set(this.key(coverage.symbol, coverage.timeframe, coverage.feed), { ...coverage });
  }

  async getBars(symbol: string, timeframe: Timeframe, feed: BarFeed, limit: number): Promise<DailyBar[]> {
    const all = this.sorted(symbol, timeframe, feed);
    return all.slice(Math.max(0, all.length - limit));
  }

  async getBarsOnOrAfter(symbol: string, timeframe: Timeframe, feed: BarFeed, fromDate: string): Promise<DailyBar[]> {
    return this.sorted(symbol, timeframe, feed).filter((bar) => bar.t >= fromDate);
  }

  async putBars(symbol: string, timeframe: Timeframe, feed: BarFeed, bars: DailyBar[]): Promise<void> {
    const key = this.key(symbol, timeframe, feed);
    let byDate = this.bars.get(key);
    if (!byDate) {
      byDate = new Map<string, DailyBar>();
      this.bars.set(key, byDate);
    }
    for (const bar of bars) byDate.set(bar.t, { ...bar });
  }

  async clearSymbol(symbol: string, timeframe: Timeframe, feed: BarFeed): Promise<void> {
    const key = this.key(symbol, timeframe, feed);
    this.bars.delete(key);
    this.coverage.delete(key);
  }
}
