import type { DailyBar, Timeframe } from "../alpacaClient.ts";
import type { BarStore, Coverage } from "../barStore.ts";

/** BarStore 的内存实现，供单测使用。语义须与 MongoBarStore 一致。 */
export class InMemoryBarStore implements BarStore {
  private readonly bars = new Map<string, Map<string, DailyBar>>();
  private readonly coverage = new Map<string, Coverage>();

  private key(symbol: string, timeframe: Timeframe): string {
    return `${symbol}:${timeframe}`;
  }

  private sorted(symbol: string, timeframe: Timeframe): DailyBar[] {
    const byDate = this.bars.get(this.key(symbol, timeframe));
    if (!byDate) return [];
    return [...byDate.values()].sort((a, b) => a.t.localeCompare(b.t));
  }

  async getCoverage(symbol: string, timeframe: Timeframe): Promise<Coverage | undefined> {
    return this.coverage.get(this.key(symbol, timeframe));
  }

  async putCoverage(coverage: Coverage): Promise<void> {
    this.coverage.set(this.key(coverage.symbol, coverage.timeframe), { ...coverage });
  }

  async getBars(symbol: string, timeframe: Timeframe, limit: number): Promise<DailyBar[]> {
    const all = this.sorted(symbol, timeframe);
    return all.slice(Math.max(0, all.length - limit));
  }

  async getBarsOnOrAfter(symbol: string, timeframe: Timeframe, fromDate: string): Promise<DailyBar[]> {
    return this.sorted(symbol, timeframe).filter((bar) => bar.t >= fromDate);
  }

  async putBars(symbol: string, timeframe: Timeframe, bars: DailyBar[]): Promise<void> {
    const key = this.key(symbol, timeframe);
    let byDate = this.bars.get(key);
    if (!byDate) {
      byDate = new Map<string, DailyBar>();
      this.bars.set(key, byDate);
    }
    for (const bar of bars) byDate.set(bar.t, { ...bar });
  }

  async clearSymbol(symbol: string, timeframe: Timeframe): Promise<void> {
    const key = this.key(symbol, timeframe);
    this.bars.delete(key);
    this.coverage.delete(key);
  }
}
