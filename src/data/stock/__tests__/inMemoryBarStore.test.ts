import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryBarStore } from "./inMemoryBarStore.ts";
import type { DailyBar } from "../alpacaClient.ts";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

const TF = "1Day" as const;

test("putBars dedupes and returns ascending by date", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", TF, "iex", [bar("2026-07-03", 103), bar("2026-07-01", 101)]);
  await store.putBars("AAPL", TF, "iex", [bar("2026-07-02", 102)]);
  const bars = await store.getBars("AAPL", TF, "iex", 10);
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-01", "2026-07-02", "2026-07-03"]);
});

test("putBars overwrites the old value for the same date", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", TF, "iex", [bar("2026-07-01", 101)]);
  await store.putBars("AAPL", TF, "iex", [bar("2026-07-01", 50.5)]);
  const bars = await store.getBars("AAPL", TF, "iex", 10);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.c, 50.5);
});

test("getBars takes the most recent N bars, still ascending", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", TF, "iex", [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  const bars = await store.getBars("AAPL", TF, "iex", 2);
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-02", "2026-07-03"]);
});

test("getBarsOnOrAfter treats fromDate as inclusive", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", TF, "iex", [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  const bars = await store.getBarsOnOrAfter("AAPL", TF, "iex", "2026-07-02");
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-02", "2026-07-03"]);
});

test("symbols don't interfere with each other", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", TF, "iex", [bar("2026-07-01", 1)]);
  await store.putBars("MSFT", TF, "iex", [bar("2026-07-01", 400)]);
  assert.equal((await store.getBars("AAPL", TF, "iex", 10))[0]!.c, 1);
  assert.equal((await store.getBars("MSFT", TF, "iex", 10))[0]!.c, 400);
});

test("clearSymbol clears that symbol's bars and coverage", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", TF, "iex", [bar("2026-07-01", 1)]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: TF, feed: "iex", firstDate: "2026-07-01", lastDate: "2026-07-01",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  await store.clearSymbol("AAPL", TF, "iex");
  assert.deepEqual(await store.getBars("AAPL", TF, "iex", 10), []);
  assert.equal(await store.getCoverage("AAPL", TF, "iex"), undefined);
});

test("coverage can be written and read back", async () => {
  const store = new InMemoryBarStore();
  await store.putCoverage({
    symbol: "AAPL", timeframe: TF, feed: "iex", firstDate: "2021-07-28", lastDate: "2026-07-27",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  assert.equal((await store.getCoverage("AAPL", TF, "iex"))?.lastDate, "2026-07-27");
  assert.equal(await store.getCoverage("MSFT", TF, "iex"), undefined);
});
