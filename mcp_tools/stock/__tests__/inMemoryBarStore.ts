import type { DailyBar } from "../alpacaClient.ts";
import type { BarStore, Coverage } from "../barStore.ts";

/** BarStore 的内存实现，供单测使用。语义须与 MongoBarStore 一致。 */
export class InMemoryBarStore implements BarStore {
  private readonly bars = new Map<string, Map<string, DailyBar>>();
  private readonly coverage = new Map<string, Coverage>();

  private sorted(symbol: string): DailyBar[] {
    const byDate = this.bars.get(symbol);
    if (!byDate) return [];
    return [...byDate.values()].sort((a, b) => a.t.localeCompare(b.t));
  }

  async getCoverage(symbol: string): Promise<Coverage | undefined> {
    return this.coverage.get(symbol);
  }

  async putCoverage(coverage: Coverage): Promise<void> {
    this.coverage.set(coverage.symbol, { ...coverage });
  }

  async getBars(symbol: string, limit: number): Promise<DailyBar[]> {
    const all = this.sorted(symbol);
    return all.slice(Math.max(0, all.length - limit));
  }

  async getBarsOnOrAfter(symbol: string, fromDate: string): Promise<DailyBar[]> {
    return this.sorted(symbol).filter((bar) => bar.t >= fromDate);
  }

  async putBars(symbol: string, bars: DailyBar[]): Promise<void> {
    let byDate = this.bars.get(symbol);
    if (!byDate) {
      byDate = new Map<string, DailyBar>();
      this.bars.set(symbol, byDate);
    }
    for (const bar of bars) byDate.set(bar.t, { ...bar });
  }

  async clearSymbol(symbol: string): Promise<void> {
    this.bars.delete(symbol);
    this.coverage.delete(symbol);
  }
}
