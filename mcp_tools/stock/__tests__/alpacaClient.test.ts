import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../alpacaClient.ts";

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
