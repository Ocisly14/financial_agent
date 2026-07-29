import { test } from "node:test";
import assert from "node:assert/strict";
import { createBarRepository } from "../barRepository.ts";
import { InMemoryBarStore } from "./inMemoryBarStore.ts";
import type { DailyBar } from "../alpacaClient.ts";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

/** 假 client：记录每次调用的区间，按预设脚本返回 bar。 */
function fakeClient(script: DailyBar[][]) {
  const calls: { symbol: string; from: string; to: string }[] = [];
  let index = 0;
  return {
    calls,
    client: {
      fetchDailyBars: async (symbol: string, from: string, to: string): Promise<DailyBar[]> => {
        calls.push({ symbol, from, to });
        return script[index++] ?? [];
      },
    },
  };
}

const NOW = new Date("2026-07-28T14:00:00Z");
const fixedNow = (): Date => NOW;

test("首次遇到 symbol：全量回补并写入 coverage", async () => {
  const store = new InMemoryBarStore();
  const { client, calls } = fakeClient([[bar("2026-07-24", 100), bar("2026-07-27", 101)]]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getDailyBars("AAPL", 60);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.from, "2021-07-28"); // 默认回补 5 年
  assert.equal(calls[0]!.to, "2026-07-28");
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-24", "2026-07-27"]);
  const coverage = await store.getCoverage("AAPL");
  assert.equal(coverage?.firstDate, "2026-07-24");
  assert.equal(coverage?.lastDate, "2026-07-27");
});

test("库数据新鲜时零 API 调用", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-27", 101)]);
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-27", lastDate: "2026-07-27",
    backfilledAt: "2026-07-28T13:50:00Z",
    lastCheckedAt: "2026-07-28T13:50:00Z", // 距 NOW 仅 10 分钟
  });
  const { client, calls } = fakeClient([]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getDailyBars("AAPL", 60);

  assert.equal(calls.length, 0);
  assert.equal(bars.length, 1);
});

test("库数据过期：只请求缺口区间，不重拉历史", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-20", 95), bar("2026-07-24", 100)]);
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-20", lastDate: "2026-07-24",
    backfilledAt: "2026-07-24T20:00:00Z", lastCheckedAt: "2026-07-24T20:00:00Z",
  });
  // 重叠区价格一致 + 一根新 bar
  const { client, calls } = fakeClient([[bar("2026-07-20", 95), bar("2026-07-24", 100), bar("2026-07-27", 101)]]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getDailyBars("AAPL", 60);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.from, "2026-07-14"); // lastDate 前 10 个自然日
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-20", "2026-07-24", "2026-07-27"]);
  assert.equal((await store.getCoverage("AAPL"))?.lastDate, "2026-07-27");
});

test("周末/假日无新 bar：不报错，只更新 lastCheckedAt", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-24", 100)]);
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-24", lastDate: "2026-07-24",
    backfilledAt: "2026-07-24T20:00:00Z", lastCheckedAt: "2026-07-24T20:00:00Z",
  });
  const { client } = fakeClient([[bar("2026-07-24", 100)]]); // 只有重叠区，无新增
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getDailyBars("AAPL", 60);

  assert.equal(bars.length, 1);
  const coverage = await store.getCoverage("AAPL");
  assert.equal(coverage?.lastDate, "2026-07-24");
  assert.equal(coverage?.lastCheckedAt, NOW.toISOString());
});

test("拆股：重叠区偏差超阈值触发全量重拉", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-20", 190), bar("2026-07-24", 200)]);
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-20", lastDate: "2026-07-24",
    backfilledAt: "2026-07-24T20:00:00Z", lastCheckedAt: "2026-07-24T20:00:00Z",
  });
  // 第一次增量请求返回 1:2 拆股后的价格；第二次是全量重拉
  const { client, calls } = fakeClient([
    [bar("2026-07-20", 95), bar("2026-07-24", 100)],
    [bar("2026-07-20", 95), bar("2026-07-24", 100), bar("2026-07-27", 102)],
  ]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getDailyBars("AAPL", 60);

  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.from, "2021-07-28"); // 全量重拉
  assert.deepEqual(bars.map((b) => b.c), [95, 100, 102]); // 旧的 190/200 已被覆盖
});

test("重叠区一致时不触发重拉", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-24", 100)]);
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-24", lastDate: "2026-07-24",
    backfilledAt: "2026-07-24T20:00:00Z", lastCheckedAt: "2026-07-24T20:00:00Z",
  });
  // 0.005% 的浮点级差异，低于 0.01% 阈值
  const { client, calls } = fakeClient([[bar("2026-07-24", 100.005), bar("2026-07-27", 101)]]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  await repo.getDailyBars("AAPL", 60);

  assert.equal(calls.length, 1);
});

test("days 参数限制返回条数", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-20", 1), bar("2026-07-24", 2), bar("2026-07-27", 3)]);
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-20", lastDate: "2026-07-27",
    backfilledAt: "2026-07-28T13:50:00Z", lastCheckedAt: "2026-07-28T13:50:00Z",
  });
  const { client } = fakeClient([]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getDailyBars("AAPL", 2);

  assert.deepEqual(bars.map((b) => b.t), ["2026-07-24", "2026-07-27"]);
});

test("回补返回空数组：不写 coverage（避免固化无效 symbol）", async () => {
  const store = new InMemoryBarStore();
  const { client } = fakeClient([[]]);
  const repo = createBarRepository({ store, client, now: fixedNow });

  const bars = await repo.getDailyBars("NOSUCH", 60);

  assert.deepEqual(bars, []);
  assert.equal(await store.getCoverage("NOSUCH"), undefined);
});
