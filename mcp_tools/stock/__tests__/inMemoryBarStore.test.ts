import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryBarStore } from "./inMemoryBarStore.ts";
import type { DailyBar } from "../alpacaClient.ts";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

test("putBars 去重且按日期升序返回", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-03", 103), bar("2026-07-01", 101)]);
  await store.putBars("AAPL", [bar("2026-07-02", 102)]);
  const bars = await store.getBars("AAPL", 10);
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-01", "2026-07-02", "2026-07-03"]);
});

test("putBars 同一日期覆盖旧值", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 101)]);
  await store.putBars("AAPL", [bar("2026-07-01", 50.5)]);
  const bars = await store.getBars("AAPL", 10);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.c, 50.5);
});

test("getBars 取最近 N 根，仍按升序", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  const bars = await store.getBars("AAPL", 2);
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-02", "2026-07-03"]);
});

test("getBarsOnOrAfter 是闭区间起点", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  const bars = await store.getBarsOnOrAfter("AAPL", "2026-07-02");
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-02", "2026-07-03"]);
});

test("symbol 之间互不干扰", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 1)]);
  await store.putBars("MSFT", [bar("2026-07-01", 400)]);
  assert.equal((await store.getBars("AAPL", 10))[0]!.c, 1);
  assert.equal((await store.getBars("MSFT", 10))[0]!.c, 400);
});

test("clearSymbol 清空该 symbol 的 bars 与 coverage", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 1)]);
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-01", lastDate: "2026-07-01",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  await store.clearSymbol("AAPL");
  assert.deepEqual(await store.getBars("AAPL", 10), []);
  assert.equal(await store.getCoverage("AAPL"), undefined);
});

test("coverage 可写入并读回", async () => {
  const store = new InMemoryBarStore();
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2021-07-28", lastDate: "2026-07-27",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  assert.equal((await store.getCoverage("AAPL"))?.lastDate, "2026-07-27");
  assert.equal(await store.getCoverage("MSFT"), undefined);
});
