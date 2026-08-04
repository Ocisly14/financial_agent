import test from "node:test";
import assert from "node:assert/strict";
import type { DailyBar } from "../../stock/index.ts";
import { analyzeSectorUniverse } from "../sectorAnalysis.ts";

function bars(
  count: number,
  dailyReturn: number,
  options: { startPrice?: number; missing?: Set<number>; shockAt?: number; shockFactor?: number } = {},
): DailyBar[] {
  const result: DailyBar[] = [];
  let price = options.startPrice ?? 100;
  const start = new Date("2025-01-01T00:00:00Z");
  for (let index = 0; index < count; index += 1) {
    if (index > 0) price *= 1 + dailyReturn;
    if (index === options.shockAt) price *= options.shockFactor ?? 1;
    if (options.missing?.has(index)) continue;
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    const close = Number(price.toFixed(8));
    result.push({
      t: date.toISOString().slice(0, 10),
      o: close,
      h: close,
      l: close,
      c: close,
      v: 1_000,
      vw: close,
    });
  }
  return result;
}

test("ranks all supplied sectors and preserves absolute versus relative trend semantics", () => {
  const result = analyzeSectorUniverse({
    benchmarkBars: bars(261, 0.0005),
    sectors: [
      { symbol: "XLK", sector: "Technology", bars: bars(261, 0.0012) },
      { symbol: "XLF", sector: "Financials", bars: bars(261, 0.0007) },
      { symbol: "XLU", sector: "Utilities", bars: bars(261, -0.0004) },
    ],
  });

  assert.deepEqual(result.sectors.map((sector) => sector.symbol), ["XLK", "XLF", "XLU"]);
  assert.deepEqual(result.sectors.map((sector) => sector.rank), [1, 2, 3]);
  assert.equal(result.sectors[0]?.absolute_trend, "bullish");
  assert.ok((result.sectors[0]?.relative_returns_pct.d60 ?? 0) > 0);
  assert.equal(result.sectors[2]?.absolute_trend, "bearish");
  assert.ok((result.sectors[2]?.relative_returns_pct.d60 ?? 0) < 0);
});

test("single-sector analysis returns metrics without inventing a cross-sectional score", () => {
  const result = analyzeSectorUniverse({
    benchmarkBars: bars(261, 0.0005),
    sectors: [{ symbol: "XLK", sector: "Technology", bars: bars(261, 0.001) }],
  });

  const sector = result.sectors[0]!;
  assert.equal(sector.rank, null);
  assert.equal(sector.strength_score, null);
  assert.equal(sector.absolute_trend, "bullish");
  assert.ok((sector.returns_pct.d252 ?? 0) > 0);
  assert.ok((sector.relative_returns_pct.d252 ?? 0) > 0);
  assert.ok(sector.trend.relative_r_squared > 0.99);
});

test("multi-horizon returns use exact trailing-session endpoints", () => {
  const result = analyzeSectorUniverse({
    benchmarkBars: bars(261, 0),
    sectors: [{ symbol: "XLK", sector: "Technology", bars: bars(261, 0.01) }],
  });
  const sector = result.sectors[0]!;

  assert.equal(sector.returns_pct.d20, Number(((1.01 ** 20 - 1) * 100).toFixed(2)));
  assert.equal(sector.returns_pct.d60, Number(((1.01 ** 60 - 1) * 100).toFixed(2)));
  assert.equal(sector.relative_returns_pct.d120, Number(((1.01 ** 120 - 1) * 100).toFixed(2)));
  assert.equal(sector.returns_pct.d252, Number(((1.01 ** 252 - 1) * 100).toFixed(2)));
});

test("identical sectors receive equal percentile composites and a flat relative series has zero quality", () => {
  const shared = bars(261, 0.0005);
  const result = analyzeSectorUniverse({
    benchmarkBars: shared,
    sectors: [
      { symbol: "XLK", sector: "Technology", bars: shared },
      { symbol: "XLF", sector: "Financials", bars: shared },
    ],
  });

  assert.equal(result.sectors[0]?.strength_score, 50);
  assert.equal(result.sectors[1]?.strength_score, 50);
  assert.equal(result.sectors[0]?.trend.relative_slope_annualized_pct, 0);
  assert.equal(result.sectors[0]?.trend.relative_r_squared, 0);
});

test("relative calculations use only dates shared by the sector and SPY without interpolation", () => {
  const result = analyzeSectorUniverse({
    benchmarkBars: bars(261, 0.0005, { missing: new Set([100]) }),
    sectors: [{ symbol: "XLK", sector: "Technology", bars: bars(261, 0.001) }],
  });

  assert.equal(result.sectors[0]?.coverage.bars, 260);
});

test("a relative winner in an all-falling universe remains absolutely bearish", () => {
  const result = analyzeSectorUniverse({
    benchmarkBars: bars(261, -0.0005),
    sectors: [
      { symbol: "XLP", sector: "Consumer Staples", bars: bars(261, -0.0002) },
      { symbol: "XLK", sector: "Technology", bars: bars(261, -0.0008) },
    ],
  });

  assert.equal(result.sectors[0]?.symbol, "XLP");
  assert.equal(result.sectors[0]?.rank, 1);
  assert.equal(result.sectors[0]?.absolute_trend, "bearish");
  assert.ok((result.sectors[0]?.strength_score ?? 0) > (result.sectors[1]?.strength_score ?? 0));
});

test("risk metrics expose drawdown and every result serializes without NaN or Infinity", () => {
  const result = analyzeSectorUniverse({
    benchmarkBars: bars(261, 0),
    sectors: [{
      symbol: "XLE",
      sector: "Energy",
      bars: bars(261, 0.001, { shockAt: 220, shockFactor: 0.7 }),
    }],
  });

  assert.ok(result.sectors[0]!.risk.max_drawdown_120d_pct > 25);
  assert.doesNotMatch(JSON.stringify(result), /NaN|Infinity/);
});
