import { test } from "node:test";
import assert from "node:assert/strict";
import { createBarRepository } from "../barRepository.ts";
import { InMemoryBarStore } from "./inMemoryBarStore.ts";
import type { DailyBar, BarFeed, Timeframe } from "../alpacaClient.ts";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

function fakeClient(script: DailyBar[][]) {
  const calls: { symbol: string; timeframe: Timeframe; feed: BarFeed; from: string; to: string }[] = [];
  let index = 0;
  return {
    calls,
    client: {
      fetchBars: async (
        symbol: string,
        timeframe: Timeframe,
        from: string,
        to: string,
        feed: BarFeed = "iex",
      ): Promise<DailyBar[]> => {
        calls.push({ symbol, timeframe, feed, from, to });
        return script[index++] ?? [];
      },
    },
  };
}

const NOW = new Date("2026-07-28T14:00:00Z");
const fixedNow = (): Date => NOW;

test("first daily request uses the five-year full backfill window", async () => {
  const store = new InMemoryBarStore();
  const { client, calls } = fakeClient([[bar("2026-07-24", 100), bar("2026-07-27", 101)]]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getBars("AAPL", "1Day", 60);

  assert.deepEqual(calls[0], {
    symbol: "AAPL", timeframe: "1Day", feed: "iex", from: "2021-07-28", to: "2026-07-28",
  });
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-24", "2026-07-27"]);
  assert.equal((await store.getCoverage("AAPL", "1Day", "iex"))?.timeframe, "1Day");
});

test("different timeframes use their own full backfill windows", async () => {
  const store = new InMemoryBarStore();
  const { client, calls } = fakeClient([
    [bar("2026-07-28T13:30:00Z", 100)],
    [bar("2026-07-21T13:30:00Z", 100)],
  ]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  await repo.getBars("AAPL", "1Min", 390);
  await repo.getBars("AAPL", "5Min", 390);

  assert.equal(calls[0]!.from, "2026-01-29");
  assert.equal(calls[1]!.from, "2026-07-18");
});

test("does not request upstream when store data is fresh", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Day", "iex", [bar("2026-07-27", 101)]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", feed: "iex", firstDate: "2026-07-27", lastDate: "2026-07-27",
    backfilledAt: "2026-07-28T13:50:00Z", lastCheckedAt: "2026-07-28T13:50:00Z",
  });
  const { client, calls } = fakeClient([]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  assert.equal((await repo.getBars("AAPL", "1Day", 60)).length, 1);
  assert.equal(calls.length, 0);
});

test("daily incremental fetch only goes back ten days before the last bar", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Day", "iex", [bar("2026-07-20", 95), bar("2026-07-24", 100)]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", feed: "iex", firstDate: "2026-07-20", lastDate: "2026-07-24",
    backfilledAt: "2026-07-24T20:00:00Z", lastCheckedAt: "2026-07-24T20:00:00Z",
  });
  const { client, calls } = fakeClient([
    [bar("2026-07-20", 95), bar("2026-07-24", 100), bar("2026-07-27", 101)],
  ]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getBars("AAPL", "1Day", 60);

  assert.equal(calls[0]!.from, "2026-07-14");
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-20", "2026-07-24", "2026-07-27"]);
});

test("minute incremental fetch goes back five minutes before the last bar's timestamp", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Min", "iex", [bar("2026-07-28T13:40:00.000Z", 100)]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Min", feed: "iex", firstDate: "2026-07-28T13:40:00.000Z",
    lastDate: "2026-07-28T13:40:00.000Z", backfilledAt: "2026-07-28T13:40:00Z",
    lastCheckedAt: "2026-07-28T13:40:00Z",
  });
  const { client, calls } = fakeClient([[bar("2026-07-28T13:41:00.000Z", 101)]]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  await repo.getBars("AAPL", "1Min", 390);

  assert.equal(calls[0]!.from, "2026-07-28T13:35:00.000Z");
});

test("split price divergence clears only the affected timeframe and does a full refetch", async () => {
  class TrackingStore extends InMemoryBarStore {
    clears: Array<[string, Timeframe]> = [];
    override async clearSymbol(symbol: string, timeframe: Timeframe, feed: BarFeed): Promise<void> {
      this.clears.push([symbol, timeframe]);
      await super.clearSymbol(symbol, timeframe, feed);
    }
  }
  const store = new TrackingStore();
  await store.putBars("AAPL", "1Day", "iex", [bar("2026-07-20", 190), bar("2026-07-24", 200)]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", feed: "iex", firstDate: "2026-07-20", lastDate: "2026-07-24",
    backfilledAt: "2026-07-24T20:00:00Z", lastCheckedAt: "2026-07-24T20:00:00Z",
  });
  const { client, calls } = fakeClient([
    [bar("2026-07-20", 95), bar("2026-07-24", 100)],
    [bar("2026-07-20", 95), bar("2026-07-24", 100), bar("2026-07-27", 102)],
  ]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getBars("AAPL", "1Day", 60);

  assert.deepEqual(store.clears, [["AAPL", "1Day"]]);
  assert.equal(calls[1]!.from, "2021-07-28");
  assert.deepEqual(bars.map((b) => b.c), [95, 100, 102]);
});

test("first 1Min backfill covers 180 days to support arbitrary minute aggregation", async () => {
  const store = new InMemoryBarStore();
  const { client, calls } = fakeClient([
    [bar("2026-07-27T13:30:00Z", 100), bar("2026-07-27T13:31:00Z", 101)],
  ]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getBars("AAPL", "1Min", 390);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.from, "2026-01-29");
  assert.equal(bars.length, 2);
});

test("count limits the number of bars returned and an empty backfill does not write coverage", async () => {
  const store = new InMemoryBarStore();
  const { client } = fakeClient([[bar("2026-07-20", 1), bar("2026-07-24", 2), bar("2026-07-27", 3)], []]);
  const repo = createBarRepository({ store, client, now: fixedNow });
  assert.deepEqual((await repo.getBars("AAPL", "1Day", 2)).map((b) => b.c), [2, 3]);
  assert.deepEqual(await repo.getBars("NOSUCH", "1Day", 60), []);
  assert.equal(await store.getCoverage("NOSUCH", "1Day", "iex"), undefined);
});

test("getBarsBetween returns the inclusive range in ascending order", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Day", "iex", [
    bar("2026-01-05", 10),
    bar("2026-01-06", 20),
    bar("2026-01-07", 30),
    bar("2026-01-08", 40),
  ]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", feed: "iex", firstDate: "2026-01-05", lastDate: "2026-01-08",
    backfilledAt: "2026-01-08T00:00:00.000Z", lastCheckedAt: "2026-01-08T00:00:00.000Z",
  });
  const repo = createBarRepository({
    store,
    client: { fetchBars: async () => [] },
    now: () => new Date("2026-01-08T00:10:00Z"),
  });

  const bars = await repo.getBarsBetween("AAPL", "1Day", "2026-01-06", "2026-01-07");
  assert.deepEqual(bars.map((b) => b.t), ["2026-01-06", "2026-01-07"]);
});

test("getBarsBetween returns nothing when from is after to", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Day", "iex", [bar("2026-01-05", 10)]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", feed: "iex", firstDate: "2026-01-05", lastDate: "2026-01-05",
    backfilledAt: "2026-01-05T00:00:00.000Z", lastCheckedAt: "2026-01-05T00:00:00.000Z",
  });
  const repo = createBarRepository({
    store,
    client: { fetchBars: async () => [] },
    now: () => new Date("2026-01-05T00:10:00Z"),
  });

  assert.deepEqual(await repo.getBarsBetween("AAPL", "1Day", "2026-02-01", "2026-01-01"), []);
});

test("getBarsBetween returns nothing when the range misses local coverage", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Day", "iex", [bar("2026-01-05", 10)]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", feed: "iex", firstDate: "2026-01-05", lastDate: "2026-01-05",
    backfilledAt: "2026-01-05T00:00:00.000Z", lastCheckedAt: "2026-01-05T00:00:00.000Z",
  });
  const repo = createBarRepository({
    store,
    client: { fetchBars: async () => [] },
    now: () => new Date("2026-01-05T00:10:00Z"),
  });

  assert.deepEqual(await repo.getBarsBetween("AAPL", "1Day", "2020-01-01", "2020-06-01"), []);
});
