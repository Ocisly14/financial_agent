import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteBarStore } from "../barStore.ts";
import type { DailyBar } from "../alpacaClient.ts";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

function store(): SqliteBarStore {
  return SqliteBarStore.open(":memory:");
}

test("sqlite: putBars 去重且按日期升序返回", async () => {
  const s = store();
  await s.putBars("AAPL", [bar("2026-07-03", 103), bar("2026-07-01", 101)]);
  await s.putBars("AAPL", [bar("2026-07-02", 102)]);
  const bars = await s.getBars("AAPL", 10);
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-01", "2026-07-02", "2026-07-03"]);
  s.close();
});

test("sqlite: 同一日期 upsert 覆盖旧值（拆股重拉依赖此行为）", async () => {
  const s = store();
  await s.putBars("AAPL", [bar("2026-07-01", 101)]);
  await s.putBars("AAPL", [bar("2026-07-01", 50.5)]);
  const bars = await s.getBars("AAPL", 10);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.c, 50.5);
  s.close();
});

test("sqlite: getBars 取最近 N 根，仍按升序", async () => {
  const s = store();
  await s.putBars("AAPL", [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  assert.deepEqual((await s.getBars("AAPL", 2)).map((b) => b.t), ["2026-07-02", "2026-07-03"]);
  s.close();
});

test("sqlite: getBarsOnOrAfter 是闭区间起点", async () => {
  const s = store();
  await s.putBars("AAPL", [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  assert.deepEqual(
    (await s.getBarsOnOrAfter("AAPL", "2026-07-02")).map((b) => b.t),
    ["2026-07-02", "2026-07-03"],
  );
  s.close();
});

test("sqlite: symbol 之间互不干扰", async () => {
  const s = store();
  await s.putBars("AAPL", [bar("2026-07-01", 1)]);
  await s.putBars("MSFT", [bar("2026-07-01", 400)]);
  assert.equal((await s.getBars("AAPL", 10))[0]!.c, 1);
  assert.equal((await s.getBars("MSFT", 10))[0]!.c, 400);
  s.close();
});

test("sqlite: clearSymbol 清空该 symbol 的 bars 与 coverage", async () => {
  const s = store();
  await s.putBars("AAPL", [bar("2026-07-01", 1)]);
  await s.putBars("MSFT", [bar("2026-07-01", 400)]);
  await s.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-01", lastDate: "2026-07-01",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  await s.clearSymbol("AAPL");
  assert.deepEqual(await s.getBars("AAPL", 10), []);
  assert.equal(await s.getCoverage("AAPL"), undefined);
  assert.equal((await s.getBars("MSFT", 10)).length, 1); // 未误删其他 symbol
  s.close();
});

test("sqlite: coverage 可写入、读回并覆盖更新", async () => {
  const s = store();
  await s.putCoverage({
    symbol: "AAPL", firstDate: "2021-07-28", lastDate: "2026-07-27",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  assert.equal((await s.getCoverage("AAPL"))?.lastDate, "2026-07-27");
  await s.putCoverage({
    symbol: "AAPL", firstDate: "2021-07-28", lastDate: "2026-07-28",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T14:00:00Z",
  });
  const coverage = await s.getCoverage("AAPL");
  assert.equal(coverage?.lastDate, "2026-07-28");
  assert.equal(coverage?.lastCheckedAt, "2026-07-28T14:00:00Z");
  assert.equal(await s.getCoverage("MSFT"), undefined);
  s.close();
});

test("sqlite: 批量写入 1260 根（5 年回补规模）", async () => {
  const s = store();
  const bars: DailyBar[] = [];
  for (let i = 0; i < 1260; i++) {
    const d = new Date(Date.UTC(2021, 0, 1) + i * 86_400_000);
    bars.push(bar(d.toISOString().slice(0, 10), 100 + i * 0.1));
  }
  await s.putBars("AAPL", bars);
  assert.equal((await s.getBars("AAPL", 5000)).length, 1260);
  s.close();
});
