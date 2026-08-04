import { test } from "node:test";
import assert from "node:assert/strict";
import { createGetStockPriceTool } from "../getStockPriceTool.ts";
import type { Snapshot, DailyBar } from "../../../src/data/stock/index.ts";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

const CTX = { sessionId: "test-session" };

const SNAPSHOT: Snapshot = {
  symbol: "AAPL", price: 213.45, bidPrice: 213.4, askPrice: 213.5,
  dayOpen: 210, dayHigh: 214, dayLow: 209.5, prevClose: 211,
  volume: 52_300_000, quoteTimestamp: "2026-07-28T19:42:00Z",
};

test("returns an error context instead of guessing a symbol when the symbol argument is missing", async () => {
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async () => { throw new Error("should not be called"); },
      getBarsBetween: async () => [],
    },
    snapshot: async () => { throw new Error("should not be called"); },
  });
  const result = await tool.execute({ task: "Show me today's market action" }, CTX);
  assert.match(result.summary, /symbol/i);
  assert.equal(result.generation_context!.data["symbol"], null);
  assert.equal(result.generation_context!.data["error"], "symbol_required");
});

test("symbol is uppercased and trimmed of whitespace", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 211)], getBarsBetween: async () => [] },
    snapshot: async () => ({ ...SNAPSHOT, symbol: "AAPL" }),
  });
  const result = await tool.execute({ task: "Look it up", symbol: "  aapl " }, CTX);
  assert.equal(result.generation_context!.data["symbol"], "AAPL");
});

test("happy path: returns quote, daily bars, and data source label", async () => {
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async () => [bar("2026-07-24", 210), bar("2026-07-27", 211)],
      getBarsBetween: async () => [],
    },
    snapshot: async () => SNAPSHOT,
  });
  const result = await tool.execute({ task: "What is AAPL trading at now?", symbol: "AAPL" }, CTX);
  const data = result.generation_context!.data;

  assert.equal(data["symbol"], "AAPL");
  assert.equal(data["price"], 213.45);
  assert.equal(data["prevClose"], 211);
  assert.equal(data["dataSource"], "Alpaca (IEX feed)");
  assert.equal((data["daily"] as { recentBars: DailyBar[] }).recentBars.length, 2);
  assert.match(result.summary, /AAPL/);
  assert.match(result.summary, /213\.45/);
  assert.deepEqual(result.visualizations, [{ type: "stock_price", symbol: "AAPL", range: 1 }]);
});

test("snapshot fails but daily bars exist in the store: degrades gracefully and labels staleness", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 211)], getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("network down"); },
  });
  const result = await tool.execute({ task: "AAPL", symbol: "AAPL" }, CTX);
  const data = result.generation_context!.data;

  assert.equal(data["price"], 211); // falls back to the latest close price
  assert.match(String(data["staleness"]), /2026-07-27/);
  assert.match(result.summary, /2026-07-27/);
});

test("neither snapshot nor store has data: returns an error context instead of throwing", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [], getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("network down"); },
  });
  const result = await tool.execute({ task: "AAPL", symbol: "AAPL" }, CTX);

  assert.match(result.generation_context!.prompt ?? "", /No market data available for AAPL/);
  assert.equal(result.generation_context!.data["error"], "network down");
});

test("input schema does not declare the framework-injected task parameter", () => {
  const tool = createGetStockPriceTool();
  assert.equal(tool.inputSchema?.properties?.["task"], undefined);
  assert.ok(!(tool.inputSchema?.required ?? []).includes("task"));
});

test("daily bars are condensed rather than passed through", async () => {
  const bars = Array.from({ length: 300 }, (_, i) =>
    bar(`2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, 100 + i));
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => bars, getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute({ symbol: "AAPL" }, { sessionId: "s" });
  const data = result.generation_context!.data as Record<string, unknown>;

  assert.equal(data["dailyBars"], undefined, "the raw array must not be injected");
  const daily = data["daily"] as { recentBars: unknown[]; trend?: { c: number[] }; stats?: { count: number } };
  assert.equal(daily.recentBars.length, 7);
  assert.equal(daily.stats?.count, 300);
  assert.ok((daily.trend?.c.length ?? 0) <= 120);
});

test("historyDays is clamped and the clamp is reported", async () => {
  let requested = 0;
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async (_s, _tf, count) => { requested = count; return [bar("2026-07-27", 100)]; },
      getBarsBetween: async () => [],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute({ symbol: "AAPL", historyDays: 99_999 }, { sessionId: "s" });
  const data = result.generation_context!.data as Record<string, unknown>;

  assert.equal(requested, 1260, "must not ask the repository for more than MAX_RANGE_DAYS");
  assert.match(String(data["historyDaysNote"]), /1260/);
});

test("a call with no historyDays asks for a year", async () => {
  let requested = 0;
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async (_s, _tf, count) => { requested = count; return [bar("2026-07-27", 100)]; },
      getBarsBetween: async () => [],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  await tool.execute({ symbol: "AAPL" }, { sessionId: "s" });
  assert.equal(requested, 250);
});

test("a historyDays within the limit produces no note", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute({ symbol: "AAPL", historyDays: 1260 }, { sessionId: "s" });
  assert.equal((result.generation_context!.data as Record<string, unknown>)["historyDaysNote"], undefined);
});

test("a window under the tail budget comes back entirely raw", async () => {
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async () => [bar("2026-07-27", 100)],
      getBarsBetween: async () => [bar("2026-01-05", 50), bar("2026-01-06", 55)],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute(
    { symbol: "AAPL", window: { from: "2026-01-01", to: "2026-01-10" } },
    { sessionId: "s" },
  );
  const data = result.generation_context!.data as Record<string, unknown>;
  const window = data["window"] as { recentBars: unknown[]; trend?: unknown };
  assert.equal(window.recentBars.length, 2);
  assert.equal(window.trend, undefined);
});

test("a window keeps every day distinct up to the trend budget", async () => {
  // 120 head bars + 30 tail = 150, so bucketDays stays 1 and every trading day
  // keeps its own exact close — this is what makes "what did it close at on
  // 2026-01-30" answerable from a window rather than from a thousand raw bars.
  const bars = Array.from({ length: 150 }, (_, i) =>
    bar(`2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, 100 + i));
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => bars },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute(
    { symbol: "AAPL", window: { from: "2026-01-01", to: "2026-06-01" } },
    { sessionId: "s" },
  );
  const window = (result.generation_context!.data as Record<string, unknown>)["window"] as {
    trend?: { bucketDays: number; t: string[] };
  };
  assert.equal(window.trend?.bucketDays, 1, "every trading day must keep its own exact close");
  assert.equal(window.trend?.t.length, 120);
});

test("daily and window coexist without interfering", async () => {
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async () => [bar("2026-07-27", 100)],
      getBarsBetween: async () => [bar("2026-01-05", 50)],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute(
    { symbol: "AAPL", historyDays: 60, window: { from: "2026-01-01", to: "2026-01-10" } },
    { sessionId: "s" },
  );
  const data = result.generation_context!.data as Record<string, unknown>;
  assert.ok(data["daily"]);
  assert.ok(data["window"]);
});

test("a malformed window is rejected with a note instead of reaching the repository", async () => {
  let getBarsBetweenCalled = false;
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async () => [bar("2026-07-27", 100)],
      getBarsBetween: async () => { getBarsBetweenCalled = true; return []; },
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute(
    { symbol: "AAPL", window: { from: "Jan 5", to: "2026-01-10" } },
    { sessionId: "s" },
  );
  const data = result.generation_context!.data as Record<string, unknown>;
  assert.equal(getBarsBetweenCalled, false, "a malformed window must not reach the repository");
  assert.equal(data["window"], undefined);
  assert.match(String(data["windowNote"]), /YYYY-MM-DD/);
});

test("a window missing to/from is rejected with a note", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute(
    { symbol: "AAPL", window: { from: "2026-01-01" } },
    { sessionId: "s" },
  );
  const data = result.generation_context!.data as Record<string, unknown>;
  assert.equal(data["window"], undefined);
  assert.match(String(data["windowNote"]), /YYYY-MM-DD/);
});

test("a fractional historyDays floors to at least 1 day, not 0", async () => {
  let requested = -1;
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async (_s, _tf, count) => { requested = count; return [bar("2026-07-27", 100)]; },
      getBarsBetween: async () => [],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  await tool.execute({ symbol: "AAPL", historyDays: 0.5 }, { sessionId: "s" });
  assert.equal(requested, 1, "0.5 must floor to 1, not 0");
});

test("the generation prompt names the condensed fields", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute({ symbol: "AAPL" }, { sessionId: "s" });
  const prompt = result.generation_context!.prompt!;
  for (const field of ["daily.recentBars", "daily.trend", "daily.stats"]) {
    assert.ok(prompt.includes(field), `prompt must explain ${field}`);
  }
  assert.ok(!prompt.includes("dailyBars"), "prompt must not name the removed field");
  // stats.min/max are close-based, not the true period high/low: the prose
  // must say so, not just "min/max with dates" (see barDigest.ts stats).
  assert.match(prompt, /closing (high|low)/i);
  // `intraday` is emitted by toJsonData whenever includeIntraday is requested
  // but was previously never described at all.
  assert.match(prompt, /\bintraday\b/);
  assert.match(prompt, /minute/i);
  // window must not be described as present whenever a range was requested —
  // it is also conditional on bars actually coming back.
  assert.match(prompt, /window is absent/i);
});
