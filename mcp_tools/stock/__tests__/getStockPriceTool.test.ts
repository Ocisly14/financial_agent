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

test("缺少 symbol 参数时返回错误上下文，不猜标的", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => { throw new Error("should not be called"); } },
    snapshot: async () => { throw new Error("should not be called"); },
  });
  const result = await tool.execute({ task: "帮我看看今天的行情" }, CTX);
  assert.match(result.summary, /symbol/i);
  assert.equal(result.generation_context!.data["symbol"], null);
  assert.equal(result.generation_context!.data["error"], "symbol_required");
});

test("symbol 统一转为大写并去除空白", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 211)] },
    snapshot: async () => ({ ...SNAPSHOT, symbol: "AAPL" }),
  });
  const result = await tool.execute({ task: "查一下", symbol: "  aapl " }, CTX);
  assert.equal(result.generation_context!.data["symbol"], "AAPL");
});

test("正常路径：返回报价、日 K 与数据源标注", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-24", 210), bar("2026-07-27", 211)] },
    snapshot: async () => SNAPSHOT,
  });
  const result = await tool.execute({ task: "AAPL 现在多少钱", symbol: "AAPL" }, CTX);
  const data = result.generation_context!.data;

  assert.equal(data["symbol"], "AAPL");
  assert.equal(data["price"], 213.45);
  assert.equal(data["prevClose"], 211);
  assert.equal(data["dataSource"], "Alpaca (IEX feed)");
  assert.equal((data["dailyBars"] as DailyBar[]).length, 2);
  assert.match(result.summary, /AAPL/);
  assert.match(result.summary, /213\.45/);
  assert.deepEqual(result.visualizations, [{ type: "stock_price", symbol: "AAPL", range: "1D" }]);
});

test("snapshot 失败但库中有日 K：降级返回并标注 staleness", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 211)] },
    snapshot: async () => { throw new Error("network down"); },
  });
  const result = await tool.execute({ task: "AAPL", symbol: "AAPL" }, CTX);
  const data = result.generation_context!.data;

  assert.equal(data["price"], 211); // 回退到最新收盘价
  assert.match(String(data["staleness"]), /2026-07-27/);
  assert.match(result.summary, /2026-07-27/);
});

test("snapshot 与库都无数据：返回错误上下文而非抛异常", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [] },
    snapshot: async () => { throw new Error("network down"); },
  });
  const result = await tool.execute({ task: "AAPL", symbol: "AAPL" }, CTX);

  assert.match(result.generation_context!.prompt ?? "", /No market data available for AAPL/);
  assert.equal(result.generation_context!.data["error"], "network down");
});
