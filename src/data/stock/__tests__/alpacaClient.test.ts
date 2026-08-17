import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtlCache, fetchBars, resolveFeed } from "../alpacaClient.ts";

test("fetchBars generalizes timeframe and preserves daily/minute timestamp format", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({
      bars: [{ t: "2026-07-28T13:30:00Z", o: 100, h: 102, l: 99, c: 101, v: 10, vw: 100.5 }],
      next_page_token: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const daily = await fetchBars("AAPL", "1Day", "2026-07-01", "2026-07-28");
    const intraday = await fetchBars("AAPL", "5Min", "2026-07-28", "2026-07-28");
    assert.equal(daily[0]!.t, "2026-07-28");
    assert.equal(intraday[0]!.t, "2026-07-28T13:30:00Z");
    assert.match(urls[0]!, /timeframe=1Day/);
    assert.match(urls[1]!, /timeframe=5Min/);
    assert.ok(urls.every((url) => url.includes("adjustment=all")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cache hit within TTL does not call loader again", async () => {
  let calls = 0;
  const cached = createTtlCache(async (key: string) => { calls++; return `${key}-${calls}`; }, 10_000);
  assert.equal(await cached("AAPL", 1_000), "AAPL-1");
  assert.equal(await cached("AAPL", 9_000), "AAPL-1");
  assert.equal(calls, 1);
});

test("loader is called again after TTL expires", async () => {
  let calls = 0;
  const cached = createTtlCache(async (key: string) => { calls++; return `${key}-${calls}`; }, 10_000);
  await cached("AAPL", 1_000);
  assert.equal(await cached("AAPL", 11_001), "AAPL-2");
  assert.equal(calls, 2);
});

test("different keys are cached independently", async () => {
  let calls = 0;
  const cached = createTtlCache(async (key: string) => { calls++; return `${key}-${calls}`; }, 10_000);
  await cached("AAPL", 1_000);
  await cached("MSFT", 1_000);
  assert.equal(calls, 2);
  await cached("AAPL", 2_000);
  assert.equal(calls, 2);
});

test("failed result is not cached when loader throws", async () => {
  let calls = 0;
  const cached = createTtlCache(async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return "ok";
  }, 10_000);
  await assert.rejects(() => cached("AAPL", 1_000));
  assert.equal(await cached("AAPL", 1_500), "ok");
  assert.equal(calls, 2);
});

test("a rate-limited request is retried after backing off", async () => {
  const originalFetch = globalThis.fetch;
  const delays: number[] = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response("rate limit", { status: 429 })
      : new Response(JSON.stringify({ bars: [], next_page_token: null }), { status: 200 });
  };
  try {
    await fetchBars("AAPL", "1Day", "2026-07-01", "2026-07-02", "iex", {
      sleep: async (ms: number) => { delays.push(ms); },
    });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [1_000]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries give up and surface the upstream status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("still limited", { status: 429 });
  try {
    await assert.rejects(
      fetchBars("AAPL", "1Day", "2026-07-01", "2026-07-02", "iex", { sleep: async () => {} }),
      /Alpaca 429/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 4xx that is not a rate limit is not retried", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("nope", { status: 403 }); };
  try {
    await assert.rejects(
      fetchBars("AAPL", "1Day", "2026-07-01", "2026-07-02", "iex", { sleep: async () => {} }),
      /Alpaca 403/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the feed defaults to the configured environment feed", () => {
  assert.equal(resolveFeed(undefined, { ALPACA_FEED: "sip" }), "sip");
  assert.equal(resolveFeed(undefined, {}), "iex");
  assert.equal(resolveFeed("iex", { ALPACA_FEED: "sip" }), "iex", "an explicit argument wins");
  assert.equal(resolveFeed(undefined, { ALPACA_FEED: "nonsense" }), "iex");
});
