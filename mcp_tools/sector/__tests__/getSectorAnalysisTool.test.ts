import test from "node:test";
import assert from "node:assert/strict";
import type { BarRepository, DailyBar, Timeframe } from "../../../src/data/stock/index.ts";
import { SECTOR_UNIVERSE } from "../../../src/data/sector/index.ts";
import { createGetSectorAnalysisTool } from "../getSectorAnalysisTool.ts";

const CTX = { sessionId: "sector-test" };

function bars(dailyReturn: number, count = 261): DailyBar[] {
  const result: DailyBar[] = [];
  let price = 100;
  const start = new Date("2025-01-01T00:00:00Z");
  for (let index = 0; index < count; index += 1) {
    if (index > 0) price *= 1 + dailyReturn;
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    const close = Number(price.toFixed(8));
    result.push({ t: date.toISOString().slice(0, 10), o: close, h: close, l: close, c: close, v: 1_000, vw: close });
  }
  return result;
}

function repository(overrides: Record<string, DailyBar[]> = {}): {
  repository: BarRepository;
  calls: Array<{ symbol: string; timeframe: Timeframe; count: number }>;
} {
  const calls: Array<{ symbol: string; timeframe: Timeframe; count: number }> = [];
  const rates = new Map<string, number>(
    SECTOR_UNIVERSE.map((sector, index) => [sector.symbol, 0.0011 - index * 0.00012]),
  );
  return {
    calls,
    repository: {
      getBars: async (symbol, timeframe, count) => {
        calls.push({ symbol, timeframe, count });
        if (Object.hasOwn(overrides, symbol)) return overrides[symbol]!;
        return bars(symbol === "SPY" ? 0.0005 : rates.get(symbol) ?? 0);
      },
      getBarsBetween: async () => [],
    },
  };
}

test("default call loads SPY plus all eleven sectors and summarizes every sector", async () => {
  const fake = repository();
  const tool = createGetSectorAnalysisTool({ repository: fake.repository });
  const result = await tool.execute({}, CTX);

  assert.equal(fake.calls.length, 12);
  assert.deepEqual(new Set(fake.calls.map((call) => call.symbol)), new Set(["SPY", ...SECTOR_UNIVERSE.map((sector) => sector.symbol)]));
  assert.equal(fake.calls.every((call) => call.timeframe === "1Day" && call.count === 261), true);

  const data = result.generation_context!.data as Record<string, unknown>;
  assert.equal(data["comparison_scope"], "full_universe");
  assert.equal((data["sectors"] as unknown[]).length, 11);
  assert.match(result.generation_context!.prompt ?? "", /every successfully returned sector exactly once/i);
  assert.match(String(data["data_source"]), /local SQLite repository/);
  for (const sector of SECTOR_UNIVERSE) {
    assert.equal(result.summary.split(sector.symbol).length - 1, 1, `${sector.symbol} must appear once in summary`);
  }
});

test("an explicit multi-sector subset is ranked only within that comparison scope", async () => {
  const fake = repository();
  const tool = createGetSectorAnalysisTool({ repository: fake.repository });
  const result = await tool.execute({ sector_symbols: ["XLK", "XLF"] }, CTX);
  const data = result.generation_context!.data as Record<string, unknown>;

  assert.deepEqual(fake.calls.map((call) => call.symbol), ["SPY", "XLK", "XLF"]);
  assert.equal(data["comparison_scope"], "selected_subset");
  assert.deepEqual((data["sectors"] as Array<Record<string, unknown>>).map((sector) => sector["rank"]), [1, 2]);
});

test("single-sector call loads only SPY and that ETF and omits cross-sectional rank", async () => {
  const fake = repository();
  const tool = createGetSectorAnalysisTool({ repository: fake.repository });
  const result = await tool.execute({ sector_symbols: ["XLK"] }, CTX);

  assert.deepEqual(fake.calls.map((call) => call.symbol), ["SPY", "XLK"]);
  const data = result.generation_context!.data as Record<string, unknown>;
  assert.equal(data["comparison_scope"], "single_sector");
  const sector = (data["sectors"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(sector["rank"], null);
  assert.equal(sector["strength_score"], null);
  assert.match(result.summary, /no cross-sectional rank/i);
});

test("rejects an empty, duplicate, or unsupported sector selection", async () => {
  const fake = repository();
  const tool = createGetSectorAnalysisTool({ repository: fake.repository });

  for (const sector_symbols of [[], ["XLK", "XLK"], ["QQQ"]]) {
    const result = await tool.execute({ sector_symbols }, CTX);
    assert.equal(result.error?.code, "invalid_sector_symbols");
  }
  assert.equal(fake.calls.length, 0);
});

test("one unavailable sector is reported while the rest remain comparable", async () => {
  const fake = repository({ XLE: [] });
  const tool = createGetSectorAnalysisTool({ repository: fake.repository });
  const result = await tool.execute({}, CTX);
  const data = result.generation_context!.data as Record<string, unknown>;

  assert.equal((data["sectors"] as unknown[]).length, 10);
  assert.deepEqual((data["unavailable"] as Array<Record<string, unknown>>).map((entry) => entry["symbol"]), ["XLE"]);
  assert.match(result.summary, /XLE.*insufficient/i);
});

test("reports database unavailability without bypassing the repository", async () => {
  const tool = createGetSectorAnalysisTool({ getRepository: async () => undefined });
  const result = await tool.execute({}, CTX);

  assert.equal(result.error?.code, "stock_database_unavailable");
});

test("insufficient SPY history fails before sector data is requested", async () => {
  const fake = repository({ SPY: bars(0, 10) });
  const tool = createGetSectorAnalysisTool({ repository: fake.repository });
  const result = await tool.execute({}, CTX);

  assert.equal(result.error?.code, "insufficient_benchmark_bars");
  assert.deepEqual(fake.calls.map((call) => call.symbol), ["SPY"]);
});

test("input schema exposes sector selection but not the framework-injected task", () => {
  const tool = createGetSectorAnalysisTool();
  assert.ok(tool.inputSchema.properties?.["sector_symbols"]);
  assert.equal(tool.inputSchema.properties?.["task"], undefined);
});
