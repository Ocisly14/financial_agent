import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyBar, Timeframe } from "../../../src/data/stock/index.ts";
import type { BarRepository } from "../../../src/data/stock/index.ts";
import { sma } from "../indicators.ts";
import { aggregateMinuteBars, parseTechnicalTimeframe } from "../stockTechnicalData.ts";
import { createTechnicalIndicatorTools, TECHNICAL_TOOL_NAMES } from "../technicalIndicatorTools.ts";

function bars(count = 400): DailyBar[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.25 + Math.sin(index / 5) * 5;
    return {
      t: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      o: close - 0.5,
      h: close + 1,
      l: close - 1,
      c: close,
      v: 1_000_000 + index * 1_000,
      vw: close,
    };
  });
}

function minuteBars(count: number): DailyBar[] {
  const start = Date.parse("2026-07-28T13:30:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = index + 1;
    return {
      t: new Date(start + index * 60_000).toISOString(),
      o: close - 0.25,
      h: close + 0.5,
      l: close - 0.5,
      c: close,
      v: 100,
      vw: close,
    };
  });
}

test("pure SMA calculation remains parameterized", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [1.5, 2.5, 3.5]);
});

test("accepts flexible minute and hour timeframe aliases", () => {
  assert.deepEqual(parseTechnicalTimeframe("15m"), {
    timeframe: "15Min",
    sourceTimeframe: "1Min",
    aggregateMinutes: 15,
  });
  assert.deepEqual(parseTechnicalTimeframe("1 hour"), {
    timeframe: "60Min",
    sourceTimeframe: "1Min",
    aggregateMinutes: 60,
  });
  assert.equal(parseTechnicalTimeframe("391Min"), undefined);
});

test("aggregates arbitrary minute candles from the 09:30 ET session boundary", () => {
  const fifteenMinute = aggregateMinuteBars(minuteBars(31), 15);
  assert.equal(fifteenMinute.length, 3);
  assert.deepEqual(fifteenMinute[0], {
    t: "2026-07-28T13:30:00.000Z",
    o: 0.75,
    h: 15.5,
    l: 0.5,
    c: 15,
    v: 1_500,
    vw: 8,
  });
  assert.equal(fifteenMinute[1]!.t, "2026-07-28T13:45:00.000Z");

  const hourly = aggregateMinuteBars(minuteBars(61), 60);
  assert.equal(hourly.length, 2);
  assert.equal(hourly[0]!.t, "2026-07-28T13:30:00.000Z");
  assert.equal(hourly[0]!.c, 60);
  assert.equal(hourly[1]!.t, "2026-07-28T14:30:00.000Z");
});

test("registers nine independently callable stock indicator tools", () => {
  const repository: BarRepository = { getBars: async () => bars() };
  const tools = createTechnicalIndicatorTools({ getRepository: async () => repository });

  assert.deepEqual(tools.map((tool) => tool.name), [...TECHNICAL_TOOL_NAMES]);
  for (const tool of tools) {
    assert.deepEqual(tool.inputSchema.required, ["symbol"]);
  }
});

test("an indicator reads the requested stock bars from the repository", async () => {
  const calls: Array<{ symbol: string; timeframe: Timeframe; count: number }> = [];
  const allBars = bars();
  const repository: BarRepository = {
    getBars: async (symbol, timeframe, count) => {
      calls.push({ symbol, timeframe, count });
      return allBars.slice(-count);
    },
  };
  const tool = createTechnicalIndicatorTools({ getRepository: async () => repository })
    .find((candidate) => candidate.name === "stock_sma")!;

  const result = await tool.execute(
    { symbol: " aapl ", timeframe: "1Day", period: 20, history_bars: 80 },
    { sessionId: "test" },
  );

  assert.deepEqual(calls, [{ symbol: "AAPL", timeframe: "1Day", count: 80 }]);
  assert.equal(result.error, undefined);
  assert.equal(result.generation_context?.prompt, undefined);
  assert.equal(result.generation_context?.data.symbol, "AAPL");
  assert.equal(result.generation_context?.data.indicator, "SMA");
  assert.equal(result.generation_context?.data.period, 20);
  assert.equal(result.visualizations?.[0]?.type, "stock_technical");
  assert.equal(result.visualizations?.[0]?.symbol, "AAPL");
  assert.equal(result.visualizations?.[0]?.placement, "overlay");
});

test("a custom minute indicator reads 1Min bars and returns the aggregated timeframe", async () => {
  const calls: Array<{ symbol: string; timeframe: Timeframe; count: number }> = [];
  const repository: BarRepository = {
    getBars: async (symbol, timeframe, count) => {
      calls.push({ symbol, timeframe, count });
      return minuteBars(31);
    },
  };
  const tool = createTechnicalIndicatorTools({ getRepository: async () => repository })
    .find((candidate) => candidate.name === "stock_sma")!;

  const result = await tool.execute(
    { symbol: "AAPL", timeframe: "15m", period: 2, history_bars: 3 },
    { sessionId: "test" },
  );

  assert.deepEqual(calls, [{ symbol: "AAPL", timeframe: "1Min", count: 390 }]);
  assert.equal(result.error, undefined);
  assert.equal(result.generation_context?.data.timeframe, "15Min");
  assert.equal(result.generation_context?.data.source_timeframe, "1Min");
  assert.equal(result.generation_context?.data.bar_count, 3);
});

test("every indicator returns structured stock data without a prompt template", async () => {
  const allBars = bars();
  const repository: BarRepository = {
    getBars: async (_symbol, _timeframe, count) => allBars.slice(-count),
  };

  for (const tool of createTechnicalIndicatorTools({ getRepository: async () => repository })) {
    const result = await tool.execute({ symbol: "SPY" }, { sessionId: "test" });
    assert.equal(result.error, undefined, `${tool.name}: ${result.summary}`);
    assert.equal(result.generation_context?.prompt, undefined, tool.name);
    assert.equal(result.generation_context?.data.symbol, "SPY", tool.name);
    assert.match(String(result.generation_context?.data.data_source), /stock bar database/i, tool.name);
    assert.equal(result.visualizations?.length, 1, tool.name);
    assert.equal(result.visualizations?.[0]?.type, "stock_technical", tool.name);
    assert.equal(result.visualizations?.[0]?.symbol, "SPY", tool.name);
  }
});

test("rejects a missing symbol before opening the stock repository", async () => {
  let opened = false;
  const tool = createTechnicalIndicatorTools({
    getRepository: async () => {
      opened = true;
      return undefined;
    },
  })[0]!;

  const result = await tool.execute({}, { sessionId: "test" });

  assert.equal(opened, false);
  assert.equal(result.error?.code, "invalid_symbol");
});
