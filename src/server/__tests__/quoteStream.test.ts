import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { handleStockQuoteStream } from "../quoteStreamRoute.ts";
import type { RealtimeFeed } from "../../data/stock/realtime/index.ts";

const BASE = Date.parse("2026-08-14T14:00:00Z");

/** Minimal ServerResponse stand-in: records what was written and can be closed by the test. */
function fakeResponse() {
  const chunks: string[] = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  const closeHandlers: (() => void)[] = [];
  const res = {
    writeHead(status: number, headers: Record<string, string>) { head = { status, headers }; return res; },
    write(chunk: string) { chunks.push(chunk); return true; },
    end() { for (const handler of closeHandlers) handler(); },
    on(event: string, handler: () => void) { if (event === "close") closeHandlers.push(handler); return res; },
  };
  return {
    res: res as unknown as ServerResponse,
    chunks,
    head: () => head,
    close: () => { for (const handler of closeHandlers) handler(); },
    /** Parsed data: frames, ignoring comments such as keepalive pings. */
    frames: () => chunks
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6).trim()) as Record<string, unknown>),
  };
}

/** A RealtimeFeed whose price pushes the test drives by hand. */
function fakeFeed(overrides: Partial<RealtimeFeed> = {}) {
  const listeners = new Map<string, (price: number, ts: number) => void>();
  let unsubscribed = 0;
  const feed: RealtimeFeed = {
    start() {}, stop() {},
    latestPrice: async () => 100,
    latestSnapshot: async () => { throw new Error("unused"); },
    currentPrice: () => undefined,
    window: () => [],
    isArmed: () => true,
    reconcileStrategySymbols() {},
    recordPrice() {},
    sweep() {},
    status: () => ({ state: "connected", pinned: 0, leased: 0, capacity: 30, overflow: [] }),
    subscribePrice: (symbol, listener) => {
      listeners.set(symbol, listener);
      return () => { unsubscribed += 1; listeners.delete(symbol); };
    },
    ...overrides,
  };
  return { feed, push: (symbol: string, price: number, ts: number) => listeners.get(symbol)?.(price, ts), unsubscribed: () => unsubscribed };
}

/** Timers the test fires explicitly. */
function manualTimers() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const entry = { fn, ms };
      pending.push(entry);
      return () => { const i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1); };
    },
    fire: (ms: number) => { for (const entry of [...pending]) if (entry.ms === ms) entry.fn(); },
  };
}

function setup(feedOverrides: Partial<RealtimeFeed> = {}) {
  const response = fakeResponse();
  const feed = fakeFeed(feedOverrides);
  const timers = manualTimers();
  return { response, feed, timers, deps: { feed: feed.feed, setTimer: timers.setTimer, now: () => BASE } };
}

test("the stream opens with SSE headers", () => {
  const { response, deps } = setup();
  handleStockQuoteStream("aapl", response.res, deps);

  assert.equal(response.head()?.status, 200);
  assert.equal(response.head()?.headers["Content-Type"], "text/event-stream");
  assert.equal(response.head()?.headers["Cache-Control"], "no-cache");
});

test("a price arriving on the stream is written as a quote frame", () => {
  const { response, feed, deps } = setup();
  handleStockQuoteStream("AAPL", response.res, deps);

  feed.push("AAPL", 102.5, BASE + 1_000);

  assert.deepEqual(response.frames().at(-1), {
    type: "quote", symbol: "AAPL", price: 102.5, ts: BASE + 1_000,
  });
});

test("the symbol is normalised before it is used", () => {
  const { response, feed, deps } = setup();
  handleStockQuoteStream(" aapl ", response.res, deps);

  feed.push("AAPL", 101, BASE);
  assert.equal(response.frames().at(-1)?.["symbol"], "AAPL");
});

test("an already-buffered price is sent immediately so the client is never blank", () => {
  const { response, deps } = setup({ currentPrice: () => 99.5 });
  handleStockQuoteStream("AAPL", response.res, deps);

  assert.deepEqual(response.frames()[0], { type: "quote", symbol: "AAPL", price: 99.5, ts: BASE });
});

test("nothing is sent up front when the buffer is empty", () => {
  const { response, deps } = setup();
  handleStockQuoteStream("AAPL", response.res, deps);

  assert.deepEqual(response.frames(), []);
});

test("a keepalive comment is written on its interval", () => {
  const { response, timers, deps } = setup();
  handleStockQuoteStream("AAPL", response.res, { ...deps, keepaliveMs: 15_000 });

  timers.fire(15_000);
  assert.ok(response.chunks.includes(": ping\n\n"));
});

test("closing the connection unsubscribes and cancels the timers", () => {
  const { response, feed, timers, deps } = setup();
  handleStockQuoteStream("AAPL", response.res, deps);
  assert.ok(timers.pending.length > 0);

  response.close();

  assert.equal(feed.unsubscribed(), 1);
  assert.equal(timers.pending.length, 0);
});

test("a disconnected stream is covered by polling REST instead", async () => {
  const restCalls: string[] = [];
  const { response, timers, deps } = setup({
    status: () => ({ state: "degraded", pinned: 0, leased: 0, capacity: 30, overflow: [] }),
    latestPrice: async (symbol) => { restCalls.push(symbol); return 97.25; },
  });
  handleStockQuoteStream("AAPL", response.res, { ...deps, fallbackIntervalMs: 5_000 });

  timers.fire(5_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(restCalls, ["AAPL"]);
  assert.equal(response.frames().at(-1)?.["price"], 97.25);
});

test("the REST fallback stays quiet while the stream is healthy", async () => {
  const restCalls: string[] = [];
  const { response, timers, deps } = setup({
    latestPrice: async (symbol) => { restCalls.push(symbol); return 97.25; },
  });
  handleStockQuoteStream("AAPL", response.res, { ...deps, fallbackIntervalMs: 5_000 });

  timers.fire(5_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(restCalls, [], "the subscription already covers a connected stream");
});

test("the opening frame is not repeated when the subscription delivers the same price", () => {
  const { response, feed, deps } = setup({ currentPrice: () => 99.5 });
  handleStockQuoteStream("AAPL", response.res, deps);

  // The handshake write bypasses the subscriber, so without dedupe here the first pushed
  // quote — identical by definition, it is what was buffered — would go out twice.
  feed.push("AAPL", 99.5, BASE + 200);

  assert.deepEqual(response.frames().map((f) => f["price"]), [99.5]);
});

test("an unchanged REST fallback price is not resent", async () => {
  const { response, timers, deps } = setup({
    currentPrice: () => 97.25,
    status: () => ({ state: "degraded", pinned: 0, leased: 0, capacity: 30, overflow: [] }),
    latestPrice: async () => 97.25,
  });
  handleStockQuoteStream("AAPL", response.res, { ...deps, fallbackIntervalMs: 5_000 });

  timers.fire(5_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(response.frames().map((f) => f["price"]), [97.25]);
});
