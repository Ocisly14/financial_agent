import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamClient } from "../streamClient.ts";
import { manualClock, socketFactory } from "./fakeSocket.ts";

const CREDENTIALS = { key: "key-id", secret: "secret-key" };

function setup(options: Parameters<typeof createStreamClient>[0] extends never ? never : Record<string, unknown> = {}) {
  const factory = socketFactory();
  const clock = manualClock();
  const quotes: { symbol: string; bid: number; ask: number; ts: number }[] = [];
  const states: string[] = [];
  const client = createStreamClient({
    feed: "iex",
    credentials: CREDENTIALS,
    createSocket: factory.create,
    schedule: clock.schedule,
    onQuote: (symbol, quote) => quotes.push({ symbol, ...quote }),
    onStateChange: (state) => states.push(state),
    jitter: () => 0,
    ...options,
  });
  return { client, factory, clock, quotes, states };
}

function authenticate(socket: ReturnType<typeof socketFactory>["sockets"][number]): void {
  socket.open();
  socket.message([{ T: "success", msg: "connected" }]);
  socket.message([{ T: "success", msg: "authenticated" }]);
}

test("connecting opens the feed's endpoint and authenticates", () => {
  const { client, factory } = setup();
  client.connect();

  const socket = factory.sockets[0]!;
  assert.equal(socket.url, "wss://stream.data.alpaca.markets/v2/iex");
  socket.open();
  assert.deepEqual(socket.lastFrame(), { action: "auth", key: "key-id", secret: "secret-key" });
});

test("the sip feed connects to the sip endpoint", () => {
  const { client, factory } = setup({ feed: "sip" });
  client.connect();
  assert.equal(factory.sockets[0]!.url, "wss://stream.data.alpaca.markets/v2/sip");
});

test("symbols requested before authentication are subscribed once it completes", () => {
  const { client, factory } = setup();
  client.connect();
  client.subscribe(["AAPL", "MSFT"]);

  const socket = factory.sockets[0]!;
  assert.equal(socket.frames().length, 0, "nothing may be sent before the socket is open");

  authenticate(socket);
  assert.deepEqual(socket.lastFrame(), { action: "subscribe", quotes: ["AAPL", "MSFT"] });
});

test("subscribing after authentication sends immediately", () => {
  const { client, factory } = setup();
  client.connect();
  const socket = factory.sockets[0]!;
  authenticate(socket);

  client.subscribe(["TSLA"]);
  assert.deepEqual(socket.lastFrame(), { action: "subscribe", quotes: ["TSLA"] });
});

test("unsubscribing sends an unsubscribe frame", () => {
  const { client, factory } = setup();
  client.connect();
  const socket = factory.sockets[0]!;
  authenticate(socket);
  client.subscribe(["TSLA"]);

  client.unsubscribe(["TSLA"]);
  assert.deepEqual(socket.lastFrame(), { action: "unsubscribe", quotes: ["TSLA"] });
});

test("quote messages reach the consumer", () => {
  const { client, factory, quotes } = setup();
  client.connect();
  const socket = factory.sockets[0]!;
  authenticate(socket);

  socket.message([{ T: "q", S: "AAPL", bp: 99.98, ap: 100.02, t: "2026-08-14T14:00:00.5Z" }]);

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0]!.symbol, "AAPL");
  assert.equal(quotes[0]!.bid, 99.98);
  assert.equal(quotes[0]!.ask, 100.02);
  assert.equal(quotes[0]!.ts, Date.parse("2026-08-14T14:00:00.5Z"));
});

test("message types other than quotes are ignored", () => {
  const { client, factory, quotes } = setup();
  client.connect();
  const socket = factory.sockets[0]!;
  authenticate(socket);

  socket.message([{ T: "t", S: "AAPL", p: 100 }, { T: "b", S: "AAPL", c: 100 }]);
  assert.equal(quotes.length, 0);
});

test("a dropped connection reconnects with exponential backoff", () => {
  const { client, factory, clock } = setup();
  client.connect();
  authenticate(factory.sockets[0]!);

  factory.sockets[0]!.remoteClose();
  assert.equal(client.state(), "reconnecting");
  assert.equal(clock.runNext(), 1_000);
  assert.equal(factory.sockets.length, 2, "a new socket is opened");

  factory.sockets[1]!.remoteClose();
  assert.equal(clock.runNext(), 2_000);
  factory.sockets[2]!.remoteClose();
  assert.equal(clock.runNext(), 4_000);
});

test("backoff is capped", () => {
  const { client, factory, clock } = setup({ backoffMaxMs: 3_000 });
  client.connect();
  authenticate(factory.sockets[0]!);

  for (let attempt = 0; attempt < 5; attempt++) {
    factory.sockets.at(-1)!.remoteClose();
    assert.ok(clock.runNext() <= 3_000);
  }
});

test("a reconnect resubscribes everything currently held", () => {
  const { client, factory, clock } = setup();
  client.connect();
  authenticate(factory.sockets[0]!);
  client.subscribe(["AAPL", "MSFT"]);
  client.unsubscribe(["AAPL"]);

  factory.sockets[0]!.remoteClose();
  clock.runNext();
  authenticate(factory.sockets[1]!);

  assert.deepEqual(factory.sockets[1]!.lastFrame(), { action: "subscribe", quotes: ["MSFT"] });
});

test("repeated failures degrade the client so callers can fall back", () => {
  const { client, factory, clock, states } = setup({ degradeAfterAttempts: 3 });
  client.connect();
  authenticate(factory.sockets[0]!);

  for (let attempt = 0; attempt < 3; attempt++) {
    factory.sockets.at(-1)!.remoteClose();
    clock.runNext();
  }

  assert.equal(client.state(), "degraded");
  assert.ok(states.includes("degraded"));
});

test("a successful reconnect clears the degraded state", () => {
  const { client, factory, clock } = setup({ degradeAfterAttempts: 2 });
  client.connect();
  authenticate(factory.sockets[0]!);
  for (let attempt = 0; attempt < 2; attempt++) {
    factory.sockets.at(-1)!.remoteClose();
    clock.runNext();
  }
  assert.equal(client.state(), "degraded");

  authenticate(factory.sockets.at(-1)!);
  assert.equal(client.state(), "connected");
});

test("hitting the connection limit backs off far longer than a normal retry", () => {
  const { client, factory, clock } = setup({ connectionLimitBackoffMs: 30_000 });
  client.connect();
  const socket = factory.sockets[0]!;
  socket.open();
  socket.message([{ T: "error", code: 406, msg: "connection limit exceeded" }]);
  socket.remoteClose();

  assert.equal(clock.runNext(), 30_000);
});

test("an auth failure stops retrying instead of hammering the endpoint", () => {
  const { client, factory, clock } = setup();
  client.connect();
  const socket = factory.sockets[0]!;
  socket.open();
  socket.message([{ T: "error", code: 402, msg: "auth failed" }]);
  socket.remoteClose();

  assert.equal(client.state(), "down");
  assert.equal(clock.pending.length, 0, "no reconnect may be scheduled");
});

test("closing the client stops reconnecting", () => {
  const { client, factory, clock } = setup();
  client.connect();
  authenticate(factory.sockets[0]!);

  client.close();
  factory.sockets[0]!.remoteClose();

  assert.equal(clock.pending.length, 0);
  assert.equal(client.state(), "down");
});
