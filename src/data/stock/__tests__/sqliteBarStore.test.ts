import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteBarStore } from "../barStore.ts";
import type { DailyBar } from "../alpacaClient.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

function store(): SqliteBarStore {
  return SqliteBarStore.open(":memory:");
}

const TF = "1Day" as const;

test("sqlite: putBars 去重且按日期升序返回", async () => {
  const s = store();
  await s.putBars("AAPL", TF, [bar("2026-07-03", 103), bar("2026-07-01", 101)]);
  await s.putBars("AAPL", TF, [bar("2026-07-02", 102)]);
  const bars = await s.getBars("AAPL", TF, 10);
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-01", "2026-07-02", "2026-07-03"]);
  s.close();
});

test("sqlite: 同一日期 upsert 覆盖旧值（拆股重拉依赖此行为）", async () => {
  const s = store();
  await s.putBars("AAPL", TF, [bar("2026-07-01", 101)]);
  await s.putBars("AAPL", TF, [bar("2026-07-01", 50.5)]);
  const bars = await s.getBars("AAPL", TF, 10);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.c, 50.5);
  s.close();
});

test("sqlite: getBars 取最近 N 根，仍按升序", async () => {
  const s = store();
  await s.putBars("AAPL", TF, [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  assert.deepEqual((await s.getBars("AAPL", TF, 2)).map((b) => b.t), ["2026-07-02", "2026-07-03"]);
  s.close();
});

test("sqlite: getBarsOnOrAfter 是闭区间起点", async () => {
  const s = store();
  await s.putBars("AAPL", TF, [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  assert.deepEqual(
    (await s.getBarsOnOrAfter("AAPL", TF, "2026-07-02")).map((b) => b.t),
    ["2026-07-02", "2026-07-03"],
  );
  s.close();
});

test("sqlite: symbol 之间互不干扰", async () => {
  const s = store();
  await s.putBars("AAPL", TF, [bar("2026-07-01", 1)]);
  await s.putBars("MSFT", TF, [bar("2026-07-01", 400)]);
  assert.equal((await s.getBars("AAPL", TF, 10))[0]!.c, 1);
  assert.equal((await s.getBars("MSFT", TF, 10))[0]!.c, 400);
  s.close();
});

test("sqlite: clearSymbol 清空该 symbol 的 bars 与 coverage", async () => {
  const s = store();
  await s.putBars("AAPL", TF, [bar("2026-07-01", 1)]);
  await s.putBars("MSFT", TF, [bar("2026-07-01", 400)]);
  await s.putCoverage({
    symbol: "AAPL", timeframe: TF, firstDate: "2026-07-01", lastDate: "2026-07-01",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  await s.clearSymbol("AAPL", TF);
  assert.deepEqual(await s.getBars("AAPL", TF, 10), []);
  assert.equal(await s.getCoverage("AAPL", TF), undefined);
  assert.equal((await s.getBars("MSFT", TF, 10)).length, 1); // 未误删其他 symbol
  s.close();
});

test("sqlite: coverage 可写入、读回并覆盖更新", async () => {
  const s = store();
  await s.putCoverage({
    symbol: "AAPL", timeframe: TF, firstDate: "2021-07-28", lastDate: "2026-07-27",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  assert.equal((await s.getCoverage("AAPL", TF))?.lastDate, "2026-07-27");
  await s.putCoverage({
    symbol: "AAPL", timeframe: TF, firstDate: "2021-07-28", lastDate: "2026-07-28",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T14:00:00Z",
  });
  const coverage = await s.getCoverage("AAPL", TF);
  assert.equal(coverage?.lastDate, "2026-07-28");
  assert.equal(coverage?.lastCheckedAt, "2026-07-28T14:00:00Z");
  assert.equal(await s.getCoverage("MSFT", TF), undefined);
  s.close();
});

test("sqlite: 批量写入 1260 根（5 年回补规模）", async () => {
  const s = store();
  const bars: DailyBar[] = [];
  for (let i = 0; i < 1260; i++) {
    const d = new Date(Date.UTC(2021, 0, 1) + i * 86_400_000);
    bars.push(bar(d.toISOString().slice(0, 10), 100 + i * 0.1));
  }
  await s.putBars("AAPL", TF, bars);
  assert.equal((await s.getBars("AAPL", TF, 5000)).length, 1260);
  s.close();
});

test("sqlite: timeframe 之间互不干扰", async () => {
  const s = store();
  await s.putBars("AAPL", "1Day", [bar("2026-07-01", 100)]);
  await s.putBars("AAPL", "1Min", [bar("2026-07-01T13:30:00Z", 101)]);
  assert.equal((await s.getBars("AAPL", "1Day", 10))[0]!.c, 100);
  assert.equal((await s.getBars("AAPL", "1Min", 10))[0]!.c, 101);
  s.close();
});

test("sqlite: 旧 schema 启动时丢弃并重建", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stock-store-"));
  const path = join(dir, "legacy.db");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE stock_bars (symbol TEXT, t TEXT, PRIMARY KEY(symbol, t));");
  legacy.exec("CREATE TABLE stock_bar_coverage (symbol TEXT PRIMARY KEY, first_date TEXT, last_date TEXT, backfilled_at TEXT, last_checked_at TEXT);");
  legacy.close();

  const s = SqliteBarStore.open(path);
  await s.putBars("AAPL", "1Day", [bar("2026-07-01", 100)]);
  assert.equal((await s.getBars("AAPL", "1Day", 10)).length, 1);
  s.close();
});
