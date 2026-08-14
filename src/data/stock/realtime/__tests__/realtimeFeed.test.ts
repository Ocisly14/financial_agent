import { test } from "node:test";
import assert from "node:assert/strict";
import { createRealtimeFeed } from "../index.ts";
import { manualClock, socketFactory } from "./fakeSocket.ts";
import type { Snapshot } from "../../alpacaClient.ts";

const BASE = Date.parse("2026-08-14T14:00:00Z");
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    symbol: "AAPL",
    price: 100,
    bidPrice: 99.9,
    askPrice: 100.1,
    dayOpen: 98,
    dayHigh: 101,
    dayLow: 97,
    prevClose: 96,
    volume: 1_000,
    quoteTimestamp: "2026-08-14T14:00:00Z",
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const factory = socketFactory();
  const clock = manualClock();
  const restCalls: string[] = [];
  const backfillCalls: string[] = [];
  const feed = createRealtimeFeed({
    feed: "iex",
    credentials: { key: "k", secret: "s" },
    createSocket: factory.create,
    schedule: clock.schedule,
    jitter: () => 0,
    loadSnapshot: async (symbol: string) => {
      restCalls.push(symbol);
      return snapshot({ symbol });
    },
    loadBackfill: async (symbol: string) => {
      backfillCalls.push(symbol);
      return [
        { ts: BASE - 60_000, high: 100, low: 99, close: 99.5 },
        { ts: BASE, high: 101, low: 100, close: 100.5 },
      ];
    },
    ...overrides,
  });
  return { feed, factory, clock, restCalls, backfillCalls };
}

function authenticate(socket: ReturnType<typeof socketFactory>["sockets"][number]): void {
  socket.open();
  socket.message([{ T: "success", msg: "authenticated" }]);
}

function quote(symbol: string, bid: number, ask: number, tsMs: number) {
  return { T: "q", S: symbol, bp: bid, ap: ask, t: new Date(tsMs).toISOString() };
}

test("the first read of an unseen symbol falls back to REST and leases a subscription", async () => {
  const { feed, factory, restCalls } = setup();
  feed.start();
  authenticate(factory.sockets[0]!);

  const price = await feed.latestPrice("AAPL", BASE);

  assert.equal(price, 100);
  assert.deepEqual(restCalls, ["AAPL"]);
  assert.deepEqual(factory.sockets[0]!.lastFrame(), { action: "subscribe", quotes: ["AAPL"] });
});

test("once the stream has a price, REST is no longer consulted", async () => {
  const { feed, factory, restCalls } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);

  socket.message([quote("AAPL", 101.98, 102.02, BASE + 1_000)]);
  const price = await feed.latestPrice("AAPL", BASE + 1_500);

  assert.equal(price, 102);
  assert.deepEqual(restCalls, ["AAPL"], "no second REST call");
});

test("a stale streamed price is not trusted; REST answers instead", async () => {
  const { feed, factory, restCalls } = setup({ maxStalenessMs: 15_000 });
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);
  socket.message([quote("AAPL", 101.98, 102.02, BASE + 1_000)]);

  const price = await feed.latestPrice("AAPL", BASE + 60_000);

  assert.equal(price, 100);
  assert.equal(restCalls.length, 2);
});

test("a snapshot keeps REST's daily aggregates and takes the stream's live quote", async () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);
  socket.message([quote("AAPL", 101.98, 102.02, BASE + 1_000)]);

  const result = await feed.latestSnapshot("AAPL", BASE + 1_500);

  assert.equal(result.bidPrice, 101.98);
  assert.equal(result.askPrice, 102.02);
  assert.equal(result.price, 102);
  assert.equal(result.dayOpen, 98, "daily fields still come from REST");
  assert.equal(result.prevClose, 96);
});

test("streamed quotes accumulate into the window", async () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);

  socket.message([quote("AAPL", 99.99, 100.01, BASE)]);
  socket.message([quote("AAPL", 100.99, 101.01, BASE + 1_000)]);

  const window = feed.window("AAPL", 60_000, BASE + 1_500);
  assert.deepEqual(window.map((sample) => sample.close), [100, 101]);
});

test("dirty quotes never reach the window", async () => {
  // No backfill, so the window shows the quote path and nothing else.
  const { feed, factory } = setup({ loadBackfill: async () => [] });
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);

  // Crossed: bid above ask.
  socket.message([quote("AAPL", 500, 100, BASE)]);

  assert.deepEqual(feed.window("AAPL", 60_000, BASE + 500), []);
});

test("subscribing backfills the window so it arms without waiting for the stream", async () => {
  const { feed, factory, backfillCalls } = setup();
  feed.start();
  authenticate(factory.sockets[0]!);

  await feed.latestPrice("AAPL", BASE);
  await flush();

  assert.deepEqual(backfillCalls, ["AAPL"]);
  assert.equal(feed.isArmed("AAPL", 60_000, BASE), true);
});

test("a window is not armed before its backfill lands", async () => {
  let release: (() => void) | undefined;
  const { feed, factory } = setup({
    loadBackfill: () => new Promise((resolve) => {
      release = () => resolve([{ ts: BASE - 60_000, high: 100, low: 99, close: 99.5 }]);
    }),
  });
  feed.start();
  authenticate(factory.sockets[0]!);
  await feed.latestPrice("AAPL", BASE);

  assert.equal(feed.isArmed("AAPL", 60_000, BASE), false);
  release!();
  await flush();
  assert.equal(feed.isArmed("AAPL", 60_000, BASE), true);
});

test("reconciling strategy symbols pins them on the stream", () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);

  feed.reconcileStrategySymbols(["AAPL", "MSFT"], BASE);

  assert.deepEqual(socket.lastFrame(), { action: "subscribe", quotes: ["AAPL", "MSFT"] });
  assert.equal(feed.status().pinned, 2);
});

test("strategy symbols beyond capacity are reported so they can degrade to REST", () => {
  const { feed, factory } = setup({ capacity: 1 });
  feed.start();
  authenticate(factory.sockets[0]!);

  feed.reconcileStrategySymbols(["AAPL", "MSFT"], BASE);

  assert.deepEqual(feed.status().overflow, ["MSFT"]);
});

test("an unsubscribed symbol still answers from REST", async () => {
  const { feed, factory, restCalls } = setup({ capacity: 1 });
  feed.start();
  authenticate(factory.sockets[0]!);
  feed.reconcileStrategySymbols(["AAPL"], BASE);

  const price = await feed.latestPrice("TSLA", BASE);

  assert.equal(price, 100);
  assert.deepEqual(restCalls, ["TSLA"]);
});

test("a degraded stream keeps serving prices from REST", async () => {
  const { feed, factory, clock, restCalls } = setup({ degradeAfterAttempts: 1 });
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);
  socket.message([quote("AAPL", 101.98, 102.02, BASE + 1_000)]);

  socket.remoteClose();
  clock.runNext();
  assert.equal(feed.status().state, "degraded");

  const price = await feed.latestPrice("AAPL", BASE + 1_500);
  assert.equal(price, 100, "the stream is not trusted while degraded");
  assert.equal(restCalls.length, 2);
});

test("prices arriving while degraded still land in the window", async () => {
  const { feed, factory, clock } = setup({ degradeAfterAttempts: 1, loadBackfill: async () => [] });
  feed.start();
  authenticate(factory.sockets[0]!);
  await feed.latestPrice("AAPL", BASE);
  factory.sockets[0]!.remoteClose();
  clock.runNext();

  // REST polling during degradation feeds the same buffer the stream would have.
  feed.recordPrice("AAPL", 103, BASE + 2_000);

  assert.deepEqual(feed.window("AAPL", 60_000, BASE + 2_500).map((s) => s.close), [103]);
});

test("expired leases are unsubscribed from the stream", async () => {
  const { feed, factory } = setup({ leaseTtlMs: 60_000 });
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);

  feed.sweep(BASE + 120_000);

  assert.deepEqual(socket.lastFrame(), { action: "unsubscribe", quotes: ["AAPL"] });
});

test("a buffered price older than the staleness window is not offered as current", async () => {
  const { feed, factory } = setup({ maxStalenessMs: 15_000 });
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);
  socket.message([quote("AAPL", 101.98, 102.02, BASE + 1_000)]);

  assert.equal(feed.currentPrice("AAPL", BASE + 1_500), 102);
  // Market closed, or the stream went quiet: the last print must not keep driving triggers.
  assert.equal(feed.currentPrice("AAPL", BASE + 60_000), undefined);
});

test("a price is not current while the stream is not connected", async () => {
  const { feed, factory, clock } = setup({ degradeAfterAttempts: 1, loadBackfill: async () => [] });
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  await feed.latestPrice("AAPL", BASE);
  socket.message([quote("AAPL", 101.98, 102.02, BASE + 1_000)]);
  socket.remoteClose();
  clock.runNext();

  assert.equal(feed.currentPrice("AAPL", BASE + 1_500), undefined);
});

test("a price subscriber receives accepted quotes for its own symbol only", async () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  const seen: { price: number; ts: number }[] = [];
  feed.subscribePrice("AAPL", (price, ts) => seen.push({ price, ts }));

  socket.message([quote("AAPL", 99.99, 100.01, BASE)]);
  socket.message([quote("MSFT", 400, 400.02, BASE + 1_000)]);

  assert.deepEqual(seen, [{ price: 100, ts: BASE }]);
});

test("dirty quotes are never delivered to subscribers", async () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  const seen: number[] = [];
  feed.subscribePrice("AAPL", (price) => seen.push(price));

  socket.message([quote("AAPL", 500, 100, BASE)]); // crossed
  assert.deepEqual(seen, []);
});

test("unsubscribing stops delivery", async () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  const seen: number[] = [];
  const off = feed.subscribePrice("AAPL", (price) => seen.push(price));

  socket.message([quote("AAPL", 99.99, 100.01, BASE)]);
  off();
  socket.message([quote("AAPL", 100.99, 101.01, BASE + 1_000)]);

  assert.deepEqual(seen, [100]);
});

test("two subscribers on one symbol both get the price", async () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  const a: number[] = [];
  const b: number[] = [];
  feed.subscribePrice("AAPL", (price) => a.push(price));
  feed.subscribePrice("AAPL", (price) => b.push(price));

  socket.message([quote("AAPL", 99.99, 100.01, BASE)]);

  assert.deepEqual([a, b], [[100], [100]]);
});

test("throttling collapses a burst to the interval, keeping the newest price", async () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  const seen: number[] = [];
  feed.subscribePrice("AAPL", (price) => seen.push(price), { throttleMs: 500 });

  socket.message([quote("AAPL", 99.99, 100.01, BASE)]);        // first: delivered
  socket.message([quote("AAPL", 100.09, 100.11, BASE + 100)]); // inside the window
  socket.message([quote("AAPL", 100.19, 100.21, BASE + 200)]); // inside the window
  socket.message([quote("AAPL", 100.29, 100.31, BASE + 600)]); // window elapsed

  // Rounded: the mid of 100.29/100.31 is not exact in binary, and this test is about
  // which samples survive the throttle, not float representation.
  assert.deepEqual(seen.map((price) => Math.round(price * 100) / 100), [100, 100.3]);
});

test("an unchanged price is not re-delivered", async () => {
  const { feed, factory } = setup();
  feed.start();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  const seen: number[] = [];
  feed.subscribePrice("AAPL", (price) => seen.push(price), { throttleMs: 0 });

  socket.message([quote("AAPL", 99.99, 100.01, BASE)]);
  socket.message([quote("AAPL", 99.99, 100.01, BASE + 1_000)]);
  socket.message([quote("AAPL", 100.99, 101.01, BASE + 2_000)]);

  assert.deepEqual(seen, [100, 101]);
});

test("prices written by the degraded REST fallback also reach subscribers", async () => {
  const { feed, factory } = setup();
  feed.start();
  authenticate(factory.sockets[0]!);
  const seen: number[] = [];
  feed.subscribePrice("AAPL", (price) => seen.push(price));

  feed.recordPrice("AAPL", 103, BASE);

  assert.deepEqual(seen, [103]);
});
