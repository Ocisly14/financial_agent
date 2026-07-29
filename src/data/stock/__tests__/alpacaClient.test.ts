import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtlCache, fetchBars } from "../alpacaClient.ts";

test("fetchBars 泛化 timeframe 并保留日线/分钟线时间格式", async () => {
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

test("TTL 内命中缓存，不重复调用 loader", async () => {
  let calls = 0;
  const cached = createTtlCache(async (key: string) => { calls++; return `${key}-${calls}`; }, 10_000);
  assert.equal(await cached("AAPL", 1_000), "AAPL-1");
  assert.equal(await cached("AAPL", 9_000), "AAPL-1");
  assert.equal(calls, 1);
});

test("TTL 过期后重新调用 loader", async () => {
  let calls = 0;
  const cached = createTtlCache(async (key: string) => { calls++; return `${key}-${calls}`; }, 10_000);
  await cached("AAPL", 1_000);
  assert.equal(await cached("AAPL", 11_001), "AAPL-2");
  assert.equal(calls, 2);
});

test("不同 key 各自独立缓存", async () => {
  let calls = 0;
  const cached = createTtlCache(async (key: string) => { calls++; return `${key}-${calls}`; }, 10_000);
  await cached("AAPL", 1_000);
  await cached("MSFT", 1_000);
  assert.equal(calls, 2);
  await cached("AAPL", 2_000);
  assert.equal(calls, 2);
});

test("loader 抛错时不缓存失败结果", async () => {
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
