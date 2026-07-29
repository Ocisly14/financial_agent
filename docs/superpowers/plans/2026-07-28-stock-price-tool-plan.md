# get_stock_price 工具实施计划

> **变更记录（2026-07-28，实施完成后）：** 存储层由 MongoDB 改为 **SQLite**（Node 内置 `node:sqlite`，零依赖）。受影响的是 Task 3 的 `barStore.ts` 与 Task 5 的 `getRepository()`——本文档中这两处的代码块仍是 Mongo 版本，**以仓库中的实际实现和 spec 为准**。其余任务（alpacaClient、marketHours、barRepository、工具层）不受影响，与本计划一致。另：所有 npm 脚本已追加 `--experimental-sqlite` 标志。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `get_stock_price` 工具，实时报价按需调 Alpaca，历史日 K 落地本地库并做读时增量更新。

**Architecture:** 四层，边界是硬约束——`alpacaClient` 不碰数据库，`barStore` 不碰网络，缺口判断与拆股检测只存在于 `barRepository`，工具层只做组装。repository 通过依赖注入接收 client 与 store，因此全部核心逻辑可在无网络、无数据库的条件下单测。

**Tech Stack:** TypeScript + Node 23 原生 `--experimental-strip-types`；`node:test` + `node:assert/strict`；`node:sqlite`（需 `--experimental-sqlite`）；全局 `fetch`。无新增依赖。

## Global Constraints

- Node `>=23.0.0`，源码直接以 `.ts` 运行，**import 路径必须带 `.ts` 后缀**（如 `from "../config.ts"`），与现有代码一致。
- 测试文件必须放在 `mcp_tools/stock/__tests__/` 下并以 `.test.ts` 结尾——`npm test` 的 glob 是 `mcp_tools/**/__tests__/*.test.ts`。
- 环境变量经 `mcp_tools/config.ts` 的 `env(key)` 读取（缺失时抛错），不要直接读 `process.env`。
- 工具返回结构固定为 `{ summary: string, generation_context: { prompt: string, data: JsonObject } }`，所有失败路径也必须返回该结构而非抛异常。
- 数据源标注一律为 `"Alpaca (IEX feed)"`——免费档是 IEX 单一交易所行情，不是 SIP 合并行情，不得在文案中称其为"全市场"。
- Alpaca 请求头：`APCA-API-KEY-ID` 与 `APCA-API-SECRET-KEY`；base URL `https://data.alpaca.markets/v2`；日 K 一律带 `adjustment=all`。
- 不要执行 `git commit`。每个 Task 末尾停下来交由用户审阅，由用户决定何时提交。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `mcp_tools/stock/alpacaClient.ts` | 纯 HTTP。三个取数函数 + 一个通用的 TTL 缓存工厂。不引用数据库 |
| `mcp_tools/stock/marketHours.ts` | 纯函数：由 UTC 时刻判断美股所处时段 |
| `mcp_tools/stock/barStore.ts` | `BarStore` 接口 + `MongoBarStore` 实现。不引用网络 |
| `mcp_tools/stock/barRepository.ts` | 编排：读库 → 判缺口 → 补拉 → 拆股检测 → 回写 |
| `mcp_tools/stock/prompts.ts` | 报告提示词构造 |
| `mcp_tools/stock/getStockPriceTool.ts` | 工具定义与组装 |
| `mcp_tools/stock/__tests__/inMemoryBarStore.ts` | 测试替身（非 `.test.ts`，不会被当作测试运行） |
| `mcp_tools/stock/__tests__/*.test.ts` | 单测 |
| `mcp_tools/registerTools.ts` | 注册工具 + 加入 `ONCHAIN_DATA_TOOLS` |
| `.env.example` | 新增 Alpaca 段 |

---

### Task 1: Alpaca HTTP 客户端与 TTL 缓存

**Files:**
- Create: `mcp_tools/stock/alpacaClient.ts`
- Test: `mcp_tools/stock/__tests__/alpacaClient.test.ts`

**Interfaces:**
- Consumes: `env` from `mcp_tools/config.ts`
- Produces:
  - `type DailyBar = { t: string; o: number; h: number; l: number; c: number; v: number; vw: number }`
  - `type Snapshot = { symbol: string; price: number | null; bidPrice: number | null; askPrice: number | null; dayOpen: number | null; dayHigh: number | null; dayLow: number | null; prevClose: number | null; volume: number | null; quoteTimestamp: string }`
  - `fetchDailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]>`
  - `fetchIntradayBars(symbol: string, day: string): Promise<DailyBar[]>`
  - `fetchSnapshot(symbol: string): Promise<Snapshot>`
  - `createTtlCache<T>(load: (key: string) => Promise<T>, ttlMs: number): (key: string, nowMs: number) => Promise<T>`
  - `type BarFetcher = { fetchDailyBars: typeof fetchDailyBars }`

- [ ] **Step 1: 写失败测试**

`createTtlCache` 是本任务唯一可离线单测的单元（取数函数打真实网络，留到 Task 5 手工验证）。

创建 `mcp_tools/stock/__tests__/alpacaClient.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../alpacaClient.ts'`

- [ ] **Step 3: 实现 alpacaClient.ts**

```ts
import { env } from "../config.ts";

const ALPACA_BASE = "https://data.alpaca.markets/v2";
const FEED = "iex";

export type DailyBar = {
  t: string;   // 交易日 "2026-07-27"（日线）或完整 ISO 时刻（分钟线）
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
};

export type Snapshot = {
  symbol: string;
  price: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  prevClose: number | null;
  volume: number | null;
  quoteTimestamp: string;
};

export type BarFetcher = {
  fetchDailyBars: (symbol: string, from: string, to: string) => Promise<DailyBar[]>;
};

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

function num(val: unknown): number | null {
  return typeof val === "number" && isFinite(val) ? val : null;
}

async function alpacaFetch(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${ALPACA_BASE}${path}`, {
    headers: {
      Accept: "application/json",
      "APCA-API-KEY-ID": env("ALPACA_API_KEY_ID"),
      "APCA-API-SECRET-KEY": env("ALPACA_API_SECRET_KEY"),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${res.status}: ${body.slice(0, 200)}`);
  }
  const json: unknown = await res.json();
  const rec = asRecord(json);
  if (!rec) throw new Error("Alpaca returned a non-object response");
  return rec;
}

function toBar(raw: unknown, dateOnly: boolean): DailyBar | undefined {
  const r = asRecord(raw);
  if (!r) return undefined;
  const t = typeof r["t"] === "string" ? r["t"] : undefined;
  const c = num(r["c"]);
  if (!t || c === null) return undefined;
  return {
    t: dateOnly ? t.slice(0, 10) : t,
    o: num(r["o"]) ?? c,
    h: num(r["h"]) ?? c,
    l: num(r["l"]) ?? c,
    c,
    v: num(r["v"]) ?? 0,
    vw: num(r["vw"]) ?? c,
  };
}

async function fetchBarsPaged(path: string, dateOnly: boolean): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  let pageToken: string | undefined;
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const body = await alpacaFetch(`${path}${suffix}`);
    for (const raw of Array.isArray(body["bars"]) ? body["bars"] : []) {
      const bar = toBar(raw, dateOnly);
      if (bar) bars.push(bar);
    }
    pageToken = typeof body["next_page_token"] === "string" ? body["next_page_token"] : undefined;
  } while (pageToken);
  return bars;
}

/** 日 K。from/to 为 "YYYY-MM-DD"，闭区间。一律取复权后价。 */
export async function fetchDailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]> {
  const qs = `timeframe=1Day&start=${from}&end=${to}&adjustment=all&limit=10000&feed=${FEED}`;
  return fetchBarsPaged(`/stocks/${encodeURIComponent(symbol)}/bars?${qs}`, true);
}

/** 指定交易日的分钟线。day 为 "YYYY-MM-DD"。 */
export async function fetchIntradayBars(symbol: string, day: string): Promise<DailyBar[]> {
  const qs = `timeframe=1Min&start=${day}&end=${day}&limit=1000&feed=${FEED}`;
  return fetchBarsPaged(`/stocks/${encodeURIComponent(symbol)}/bars?${qs}`, false);
}

export async function fetchSnapshot(symbol: string): Promise<Snapshot> {
  const body = await alpacaFetch(`/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${FEED}`);
  const trade = asRecord(body["latestTrade"]);
  const quote = asRecord(body["latestQuote"]);
  const daily = asRecord(body["dailyBar"]);
  const prev = asRecord(body["prevDailyBar"]);
  if (!trade && !quote && !daily) {
    throw new Error(`No snapshot data for ${symbol}`);
  }
  return {
    symbol,
    price: num(trade?.["p"]) ?? num(daily?.["c"]),
    bidPrice: num(quote?.["bp"]),
    askPrice: num(quote?.["ap"]),
    dayOpen: num(daily?.["o"]),
    dayHigh: num(daily?.["h"]),
    dayLow: num(daily?.["l"]),
    prevClose: num(prev?.["c"]),
    volume: num(daily?.["v"]),
    quoteTimestamp:
      (typeof trade?.["t"] === "string" ? trade["t"] : undefined) ??
      (typeof quote?.["t"] === "string" ? quote["t"] : undefined) ??
      new Date().toISOString(),
  };
}

/**
 * 按 key 缓存 load 的结果 ttlMs 毫秒。nowMs 由调用方传入，便于测试。
 * loader 抛错时不写缓存。
 */
export function createTtlCache<T>(
  load: (key: string) => Promise<T>,
  ttlMs: number,
): (key: string, nowMs: number) => Promise<T> {
  const cache = new Map<string, { value: T; expiresAt: number }>();
  return async (key: string, nowMs: number): Promise<T> => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > nowMs) return hit.value;
    const value = await load(key);
    cache.set(key, { value, expiresAt: nowMs + ttlMs });
    return value;
  };
}

/** 实时报价缓存：10 秒 TTL。 */
export const getSnapshotCached = createTtlCache(fetchSnapshot, 10_000);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS，4 个 TTL 缓存测试全绿

- [ ] **Step 5: 类型检查并交付审阅**

Run: `npx tsc --noEmit`
Expected: exit 0

停下来向用户汇报本任务产出，等待审阅。**不要提交。**

---

### Task 2: 美股交易时段判定

**Files:**
- Create: `mcp_tools/stock/marketHours.ts`
- Test: `mcp_tools/stock/__tests__/marketHours.test.ts`

**Interfaces:**
- Produces:
  - `type MarketSession = "pre-market" | "regular" | "after-hours" | "closed"`
  - `marketSession(now: Date): MarketSession`
  - `etDateString(now: Date): string` — 返回美东日期 `"YYYY-MM-DD"`

这一层只影响文案标注（告诉模型"现在是盘前"），不参与任何取数决策，因此**不处理美股节假日**——节假日会被标为 `regular` 但 snapshot 返回的是上一交易日数据，`staleness` 字段仍会如实反映。这是刻意的取舍：维护节假日表的长期成本远高于文案精度的收益。

- [ ] **Step 1: 写失败测试**

创建 `mcp_tools/stock/__tests__/marketHours.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketSession, etDateString } from "../marketHours.ts";

// 2026-07-28 是周二。EDT = UTC-4。
test("盘中时段", () => {
  assert.equal(marketSession(new Date("2026-07-28T14:00:00Z")), "regular"); // 10:00 ET
  assert.equal(marketSession(new Date("2026-07-28T13:30:00Z")), "regular"); // 09:30 ET 开盘
  assert.equal(marketSession(new Date("2026-07-28T19:59:00Z")), "regular"); // 15:59 ET
});

test("盘前时段", () => {
  assert.equal(marketSession(new Date("2026-07-28T08:00:00Z")), "pre-market"); // 04:00 ET
  assert.equal(marketSession(new Date("2026-07-28T13:29:00Z")), "pre-market"); // 09:29 ET
});

test("盘后时段", () => {
  assert.equal(marketSession(new Date("2026-07-28T20:00:00Z")), "after-hours"); // 16:00 ET
  assert.equal(marketSession(new Date("2026-07-28T23:59:00Z")), "after-hours"); // 19:59 ET
});

test("非交易时段与周末", () => {
  assert.equal(marketSession(new Date("2026-07-28T05:00:00Z")), "closed");     // 01:00 ET 周二
  assert.equal(marketSession(new Date("2026-07-25T14:00:00Z")), "closed");     // 周六
  assert.equal(marketSession(new Date("2026-07-26T14:00:00Z")), "closed");     // 周日
});

test("冬令时 EST = UTC-5", () => {
  // 2026-01-06 周二，14:00 UTC = 09:00 ET，尚未开盘
  assert.equal(marketSession(new Date("2026-01-06T14:00:00Z")), "pre-market");
  assert.equal(marketSession(new Date("2026-01-06T15:00:00Z")), "regular"); // 10:00 ET
});

test("etDateString 返回美东日历日", () => {
  assert.equal(etDateString(new Date("2026-07-28T14:00:00Z")), "2026-07-28");
  // 02:00 UTC 周三 = 22:00 ET 周二
  assert.equal(etDateString(new Date("2026-07-29T02:00:00Z")), "2026-07-28");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../marketHours.ts'`

- [ ] **Step 3: 实现 marketHours.ts**

用 `Intl.DateTimeFormat` 的 `America/New_York` 时区做换算，夏令时由运行时处理，不手写规则。

```ts
export type MarketSession = "pre-market" | "regular" | "after-hours" | "closed";

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
});

type EtClock = { date: string; minutes: number; weekday: string };

function etClock(now: Date): EtClock {
  const parts = ET_PARTS.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // hour12:false 在部分运行时会把午夜渲染成 "24"
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
    weekday: get("weekday"),
  };
}

/** 美东日历日 "YYYY-MM-DD"。 */
export function etDateString(now: Date): string {
  return etClock(now).date;
}

/**
 * 判定美股所处时段。仅用于文案标注，不处理节假日。
 * 盘前 04:00–09:30、盘中 09:30–16:00、盘后 16:00–20:00（美东）。
 */
export function marketSession(now: Date): MarketSession {
  const { minutes, weekday } = etClock(now);
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre-market";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "after-hours";
  return "closed";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS，6 个时段测试全绿

- [ ] **Step 5: 交付审阅**

Run: `npx tsc --noEmit`
Expected: exit 0

停下来向用户汇报。**不要提交。**

---

### Task 3: 日 K 存储层

**Files:**
- Create: `mcp_tools/stock/barStore.ts`
- Create: `mcp_tools/stock/__tests__/inMemoryBarStore.ts`
- Test: `mcp_tools/stock/__tests__/inMemoryBarStore.test.ts`

**Interfaces:**
- Consumes: `DailyBar` from `alpacaClient.ts`；`mongodb` 驱动
- Produces:
  - `type Coverage = { symbol: string; firstDate: string; lastDate: string; backfilledAt: string; lastCheckedAt: string }`
  - `interface BarStore { getCoverage(symbol): Promise<Coverage | undefined>; putCoverage(c: Coverage): Promise<void>; getBars(symbol, limit): Promise<DailyBar[]>; getBarsOnOrAfter(symbol, fromDate): Promise<DailyBar[]>; putBars(symbol, bars): Promise<void>; clearSymbol(symbol): Promise<void> }`
  - `class MongoBarStore implements BarStore`，`static connect(uri: string): Promise<MongoBarStore>`
  - `class InMemoryBarStore implements BarStore`（测试替身，位于 `__tests__/`）

`getBars(symbol, limit)` 返回**最近 limit 根，按日期升序**（最旧在前），这是画图和算均线的自然顺序。Task 4 与 Task 5 都依赖这个约定。

- [ ] **Step 1: 写失败测试**

创建 `mcp_tools/stock/__tests__/inMemoryBarStore.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryBarStore } from "./inMemoryBarStore.ts";
import type { DailyBar } from "../alpacaClient.ts";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

test("putBars 去重且按日期升序返回", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-03", 103), bar("2026-07-01", 101)]);
  await store.putBars("AAPL", [bar("2026-07-02", 102)]);
  const bars = await store.getBars("AAPL", 10);
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-01", "2026-07-02", "2026-07-03"]);
});

test("putBars 同一日期覆盖旧值", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 101)]);
  await store.putBars("AAPL", [bar("2026-07-01", 50.5)]);
  const bars = await store.getBars("AAPL", 10);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.c, 50.5);
});

test("getBars 取最近 N 根，仍按升序", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  const bars = await store.getBars("AAPL", 2);
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-02", "2026-07-03"]);
});

test("getBarsOnOrAfter 是闭区间起点", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 1), bar("2026-07-02", 2), bar("2026-07-03", 3)]);
  const bars = await store.getBarsOnOrAfter("AAPL", "2026-07-02");
  assert.deepEqual(bars.map((b) => b.t), ["2026-07-02", "2026-07-03"]);
});

test("symbol 之间互不干扰", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 1)]);
  await store.putBars("MSFT", [bar("2026-07-01", 400)]);
  assert.equal((await store.getBars("AAPL", 10))[0]!.c, 1);
  assert.equal((await store.getBars("MSFT", 10))[0]!.c, 400);
});

test("clearSymbol 清空该 symbol 的 bars 与 coverage", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", [bar("2026-07-01", 1)]);
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2026-07-01", lastDate: "2026-07-01",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  await store.clearSymbol("AAPL");
  assert.deepEqual(await store.getBars("AAPL", 10), []);
  assert.equal(await store.getCoverage("AAPL"), undefined);
});

test("coverage 可写入并读回", async () => {
  const store = new InMemoryBarStore();
  await store.putCoverage({
    symbol: "AAPL", firstDate: "2021-07-28", lastDate: "2026-07-27",
    backfilledAt: "2026-07-28T00:00:00Z", lastCheckedAt: "2026-07-28T00:00:00Z",
  });
  assert.equal((await store.getCoverage("AAPL"))?.lastDate, "2026-07-27");
  assert.equal(await store.getCoverage("MSFT"), undefined);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module './inMemoryBarStore.ts'`

- [ ] **Step 3: 实现 barStore.ts**

```ts
import { MongoClient, type Collection } from "mongodb";
import type { DailyBar } from "./alpacaClient.ts";

export type Coverage = {
  symbol: string;
  firstDate: string;
  lastDate: string;
  backfilledAt: string;
  lastCheckedAt: string;
};

export interface BarStore {
  getCoverage(symbol: string): Promise<Coverage | undefined>;
  putCoverage(coverage: Coverage): Promise<void>;
  /** 最近 limit 根，按日期升序（最旧在前）。 */
  getBars(symbol: string, limit: number): Promise<DailyBar[]>;
  /** fromDate 起（含）的全部 bar，按日期升序。 */
  getBarsOnOrAfter(symbol: string, fromDate: string): Promise<DailyBar[]>;
  putBars(symbol: string, bars: DailyBar[]): Promise<void>;
  clearSymbol(symbol: string): Promise<void>;
}

type BarDoc = DailyBar & { symbol: string; timeframe: "1Day"; updatedAt: string };

export class MongoBarStore implements BarStore {
  private readonly client: MongoClient;
  private readonly bars: Collection<BarDoc>;
  private readonly coverage: Collection<Coverage>;

  private constructor(client: MongoClient, bars: Collection<BarDoc>, coverage: Collection<Coverage>) {
    this.client = client;
    this.bars = bars;
    this.coverage = coverage;
  }

  static async connect(uri: string): Promise<MongoBarStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    const db = client.db();
    const bars = db.collection<BarDoc>("stock_bars");
    const coverage = db.collection<Coverage>("stock_bar_coverage");
    await bars.createIndex({ symbol: 1, timeframe: 1, t: 1 }, { unique: true });
    await bars.createIndex({ symbol: 1, timeframe: 1, t: -1 });
    await coverage.createIndex({ symbol: 1 }, { unique: true });
    return new MongoBarStore(client, bars, coverage);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async getCoverage(symbol: string): Promise<Coverage | undefined> {
    const doc = await this.coverage.findOne({ symbol }, { projection: { _id: 0 } });
    return doc ?? undefined;
  }

  async putCoverage(coverage: Coverage): Promise<void> {
    await this.coverage.updateOne({ symbol: coverage.symbol }, { $set: coverage }, { upsert: true });
  }

  async getBars(symbol: string, limit: number): Promise<DailyBar[]> {
    const docs = await this.bars
      .find({ symbol, timeframe: "1Day" }, { projection: { _id: 0, symbol: 0, timeframe: 0, updatedAt: 0 } })
      .sort({ t: -1 })
      .limit(limit)
      .toArray();
    return (docs as unknown as DailyBar[]).reverse();
  }

  async getBarsOnOrAfter(symbol: string, fromDate: string): Promise<DailyBar[]> {
    const docs = await this.bars
      .find(
        { symbol, timeframe: "1Day", t: { $gte: fromDate } },
        { projection: { _id: 0, symbol: 0, timeframe: 0, updatedAt: 0 } },
      )
      .sort({ t: 1 })
      .toArray();
    return docs as unknown as DailyBar[];
  }

  async putBars(symbol: string, bars: DailyBar[]): Promise<void> {
    if (bars.length === 0) return;
    const updatedAt = new Date().toISOString();
    await this.bars.bulkWrite(
      bars.map((bar) => ({
        updateOne: {
          filter: { symbol, timeframe: "1Day" as const, t: bar.t },
          update: { $set: { ...bar, symbol, timeframe: "1Day" as const, updatedAt } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async clearSymbol(symbol: string): Promise<void> {
    await this.bars.deleteMany({ symbol, timeframe: "1Day" });
    await this.coverage.deleteOne({ symbol });
  }
}
```

创建 `mcp_tools/stock/__tests__/inMemoryBarStore.ts`：

```ts
import type { DailyBar } from "../alpacaClient.ts";
import type { BarStore, Coverage } from "../barStore.ts";

/** BarStore 的内存实现，供单测使用。语义须与 MongoBarStore 一致。 */
export class InMemoryBarStore implements BarStore {
  private readonly bars = new Map<string, Map<string, DailyBar>>();
  private readonly coverage = new Map<string, Coverage>();

  private sorted(symbol: string): DailyBar[] {
    const byDate = this.bars.get(symbol);
    if (!byDate) return [];
    return [...byDate.values()].sort((a, b) => a.t.localeCompare(b.t));
  }

  async getCoverage(symbol: string): Promise<Coverage | undefined> {
    return this.coverage.get(symbol);
  }

  async putCoverage(coverage: Coverage): Promise<void> {
    this.coverage.set(coverage.symbol, { ...coverage });
  }

  async getBars(symbol: string, limit: number): Promise<DailyBar[]> {
    const all = this.sorted(symbol);
    return all.slice(Math.max(0, all.length - limit));
  }

  async getBarsOnOrAfter(symbol: string, fromDate: string): Promise<DailyBar[]> {
    return this.sorted(symbol).filter((bar) => bar.t >= fromDate);
  }

  async putBars(symbol: string, bars: DailyBar[]): Promise<void> {
    let byDate = this.bars.get(symbol);
    if (!byDate) {
      byDate = new Map<string, DailyBar>();
      this.bars.set(symbol, byDate);
    }
    for (const bar of bars) byDate.set(bar.t, { ...bar });
  }

  async clearSymbol(symbol: string): Promise<void> {
    this.bars.delete(symbol);
    this.coverage.delete(symbol);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS，7 个存储层测试全绿

- [ ] **Step 5: 交付审阅**

Run: `npx tsc --noEmit`
Expected: exit 0

停下来向用户汇报。**不要提交。**

---

### Task 4: 读时增量 repository（含拆股检测）

**Files:**
- Create: `mcp_tools/stock/barRepository.ts`
- Test: `mcp_tools/stock/__tests__/barRepository.test.ts`

**Interfaces:**
- Consumes: `DailyBar`、`BarFetcher` from `alpacaClient.ts`；`BarStore`、`Coverage` from `barStore.ts`
- Produces:
  - `type BarRepository = { getDailyBars(symbol: string, days: number): Promise<DailyBar[]> }`
  - `createBarRepository(deps: { store: BarStore; client: BarFetcher; now?: () => Date; backfillYears?: number; freshnessMs?: number }): BarRepository`

**这是风险最集中的一层，先把测试写透。** 三条关键规则：

1. **零调用条件** —— spec 说"库已是最新则零 API 调用"，落到实现上需要一个确定性判据。采用：`lastCheckedAt` 距今在 `freshnessMs`（默认 30 分钟）以内即跳过网络。用"最近检查时间"而非"最近交易日"，是为了避免自行维护美股节假日表；增量请求本身只取 ~10 天 bar，代价极低。
2. **重叠比对** —— 增量请求的起点回退到 `lastDate` 前 10 个自然日，覆盖至少 5 个交易日。重叠区收盘价相对偏差 > `0.0001`（0.01%）即判定发生拆股/分红。
3. **拆股响应** —— `clearSymbol` 后全量重拉，保证库中历史统一处于当前复权口径。

- [ ] **Step 1: 写失败测试**

创建 `mcp_tools/stock/__tests__/barRepository.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../barRepository.ts'`

- [ ] **Step 3: 实现 barRepository.ts**

```ts
import type { BarFetcher, DailyBar } from "./alpacaClient.ts";
import type { BarStore } from "./barStore.ts";

const DEFAULT_BACKFILL_YEARS = 5;
const DEFAULT_FRESHNESS_MS = 30 * 60 * 1000;
/** 增量请求回退的自然日数，确保覆盖至少 5 个交易日用于重叠比对。 */
const OVERLAP_DAYS = 10;
/** 重叠区收盘价相对偏差阈值；超过即判定发生拆股/分红。 */
const SPLIT_EPSILON = 0.0001;

export type BarRepository = {
  getDailyBars(symbol: string, days: number): Promise<DailyBar[]>;
};

export type BarRepositoryDeps = {
  store: BarStore;
  client: BarFetcher;
  now?: () => Date;
  backfillYears?: number;
  freshnessMs?: number;
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function shiftYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return isoDate(d);
}

/** 重叠区任一交易日的收盘价偏差超过阈值即为 true。 */
function hasSplitDivergence(stored: DailyBar[], fetched: DailyBar[]): boolean {
  const fetchedByDate = new Map(fetched.map((bar) => [bar.t, bar]));
  for (const old of stored) {
    const fresh = fetchedByDate.get(old.t);
    if (!fresh || old.c === 0) continue;
    if (Math.abs(fresh.c - old.c) / Math.abs(old.c) > SPLIT_EPSILON) return true;
  }
  return false;
}

export function createBarRepository(deps: BarRepositoryDeps): BarRepository {
  const { store, client } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const backfillYears = deps.backfillYears ?? DEFAULT_BACKFILL_YEARS;
  const freshnessMs = deps.freshnessMs ?? DEFAULT_FRESHNESS_MS;

  /** 全量回补。返回是否写入了数据。 */
  async function backfill(symbol: string, today: string, nowIso: string): Promise<boolean> {
    const bars = await client.fetchDailyBars(symbol, shiftYears(today, -backfillYears), today);
    if (bars.length === 0) return false;
    await store.putBars(symbol, bars);
    await store.putCoverage({
      symbol,
      firstDate: bars[0]!.t,
      lastDate: bars[bars.length - 1]!.t,
      backfilledAt: nowIso,
      lastCheckedAt: nowIso,
    });
    return true;
  }

  return {
    async getDailyBars(symbol: string, days: number): Promise<DailyBar[]> {
      const current = now();
      const nowIso = current.toISOString();
      const today = isoDate(current);
      const coverage = await store.getCoverage(symbol);

      if (!coverage) {
        await backfill(symbol, today, nowIso);
        return store.getBars(symbol, days);
      }

      const checkedAgeMs = current.getTime() - new Date(coverage.lastCheckedAt).getTime();
      if (checkedAgeMs < freshnessMs) {
        return store.getBars(symbol, days);
      }

      const from = shiftDays(coverage.lastDate, -OVERLAP_DAYS);
      const fetched = await client.fetchDailyBars(symbol, from, today);

      if (fetched.length === 0) {
        await store.putCoverage({ ...coverage, lastCheckedAt: nowIso });
        return store.getBars(symbol, days);
      }

      const overlap = await store.getBarsOnOrAfter(symbol, from);
      if (hasSplitDivergence(overlap, fetched)) {
        // 拆股/分红：库中历史已是过期口径，整体重拉
        await store.clearSymbol(symbol);
        await backfill(symbol, today, nowIso);
        return store.getBars(symbol, days);
      }

      await store.putBars(symbol, fetched);
      const newest = fetched[fetched.length - 1]!.t;
      await store.putCoverage({
        ...coverage,
        lastDate: newest > coverage.lastDate ? newest : coverage.lastDate,
        lastCheckedAt: nowIso,
      });
      return store.getBars(symbol, days);
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS，8 个 repository 测试全绿

- [ ] **Step 5: 交付审阅**

Run: `npx tsc --noEmit`
Expected: exit 0

停下来向用户汇报。**不要提交。**

---

### Task 5: 工具层、提示词与注册

**Files:**
- Create: `mcp_tools/stock/prompts.ts`
- Create: `mcp_tools/stock/getStockPriceTool.ts`
- Test: `mcp_tools/stock/__tests__/getStockPriceTool.test.ts`
- Modify: `mcp_tools/registerTools.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `getSnapshotCached`、`fetchIntradayBars`、`fetchDailyBars`、`Snapshot`、`DailyBar` from `alpacaClient.ts`；`marketSession`、`etDateString` from `marketHours.ts`；`createBarRepository`、`BarRepository` from `barRepository.ts`；`MongoBarStore` from `barStore.ts`；`RegisteredTool` from `mcp_tools/toolRegistry.ts`
- Produces:
  - `createGetStockPriceTool(overrides?: { repository?: BarRepository; snapshot?: (symbol: string, nowMs: number) => Promise<Snapshot> }): RegisteredTool`

`symbol` 是**必填**入参，由调用工具的 agent 给出——它读得到完整对话，判断用户指的是哪支票远比工具内部正则可靠。工具不做 ticker 猜测；缺参时返回明确的错误上下文，让 agent 补齐后重试。

`overrides` 参数只为单测存在，生产调用 `createGetStockPriceTool()` 不传参。

- [ ] **Step 1: 写失败测试**

创建 `mcp_tools/stock/__tests__/getStockPriceTool.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGetStockPriceTool } from "../getStockPriceTool.ts";
import type { Snapshot, DailyBar } from "../alpacaClient.ts";

function bar(t: string, c: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v: 1000, vw: c };
}

const SNAPSHOT: Snapshot = {
  symbol: "AAPL", price: 213.45, bidPrice: 213.4, askPrice: 213.5,
  dayOpen: 210, dayHigh: 214, dayLow: 209.5, prevClose: 211,
  volume: 52_300_000, quoteTimestamp: "2026-07-28T19:42:00Z",
};

test("缺少 symbol 参数时返回错误上下文，不猜标的", async () => {
  const tool = createGetStockPriceTool({
    repository: { getDailyBars: async () => { throw new Error("should not be called"); } },
    snapshot: async () => { throw new Error("should not be called"); },
  });
  const result = await tool.execute({ task: "帮我看看今天的行情" });
  assert.match(result.summary, /symbol/i);
  assert.equal(result.generation_context.data["symbol"], null);
  assert.equal(result.generation_context.data["error"], "symbol_required");
});

test("symbol 统一转为大写并去除空白", async () => {
  const tool = createGetStockPriceTool({
    repository: { getDailyBars: async () => [bar("2026-07-27", 211)] },
    snapshot: async () => ({ ...SNAPSHOT, symbol: "AAPL" }),
  });
  const result = await tool.execute({ task: "查一下", symbol: "  aapl " });
  assert.equal(result.generation_context.data["symbol"], "AAPL");
});

test("正常路径：返回报价、日 K 与数据源标注", async () => {
  const tool = createGetStockPriceTool({
    repository: { getDailyBars: async () => [bar("2026-07-24", 210), bar("2026-07-27", 211)] },
    snapshot: async () => SNAPSHOT,
  });
  const result = await tool.execute({ task: "AAPL 现在多少钱", symbol: "AAPL" });
  const data = result.generation_context.data;

  assert.equal(data["symbol"], "AAPL");
  assert.equal(data["price"], 213.45);
  assert.equal(data["prevClose"], 211);
  assert.equal(data["dataSource"], "Alpaca (IEX feed)");
  assert.equal((data["dailyBars"] as DailyBar[]).length, 2);
  assert.match(result.summary, /AAPL/);
  assert.match(result.summary, /213\.45/);
});

test("snapshot 失败但库中有日 K：降级返回并标注 staleness", async () => {
  const tool = createGetStockPriceTool({
    repository: { getDailyBars: async () => [bar("2026-07-27", 211)] },
    snapshot: async () => { throw new Error("network down"); },
  });
  const result = await tool.execute({ task: "AAPL", symbol: "AAPL" });
  const data = result.generation_context.data;

  assert.equal(data["price"], 211); // 回退到最新收盘价
  assert.match(String(data["staleness"]), /2026-07-27/);
  assert.match(result.summary, /2026-07-27/);
});

test("snapshot 与库都无数据：返回错误上下文而非抛异常", async () => {
  const tool = createGetStockPriceTool({
    repository: { getDailyBars: async () => [] },
    snapshot: async () => { throw new Error("network down"); },
  });
  const result = await tool.execute({ task: "AAPL", symbol: "AAPL" });

  assert.match(result.generation_context.prompt, /No market data available for AAPL/);
  assert.equal(result.generation_context.data["error"], "network down");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../getStockPriceTool.ts'`

- [ ] **Step 3: 实现 prompts.ts**

```ts
import type { MarketSession } from "./marketHours.ts";

const SESSION_LABEL: Record<MarketSession, string> = {
  "pre-market": "pre-market trading (regular session has not opened)",
  regular: "regular trading hours",
  "after-hours": "after-hours trading (regular session has closed)",
  closed: "outside all trading sessions",
};

export function buildStockPricePrompt(
  symbol: string,
  session: MarketSession,
  staleness: string | undefined,
): string {
  const lines = [
    `Use the following market data for ${symbol} to write a Market section.`,
    `The quote was taken during ${SESSION_LABEL[session]}.`,
    `Cover: current price versus previous close, intraday range, volume, and what the recent daily bars show about trend.`,
    `Prices come from the Alpaca IEX feed — a single exchange, not the consolidated SIP tape. Treat them as indicative, not as an execution reference.`,
    `Cite numeric values from the payload. Do not invent news catalysts or price levels that are not present.`,
  ];
  if (staleness) lines.push(`IMPORTANT: ${staleness} State this limitation in the section.`);
  return lines.join("\n");
}
```

- [ ] **Step 4: 实现 getStockPriceTool.ts**

```ts
import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import { getSnapshotCached, fetchIntradayBars, type DailyBar, type Snapshot } from "./alpacaClient.ts";
import { marketSession, etDateString } from "./marketHours.ts";
import { createBarRepository, type BarRepository } from "./barRepository.ts";
import { MongoBarStore } from "./barStore.ts";
import * as alpaca from "./alpacaClient.ts";

const DEFAULT_HISTORY_DAYS = 60;
const DATA_SOURCE = "Alpaca (IEX feed)";

let sharedRepository: BarRepository | undefined;
let repositoryFailed = false;

/** 惰性建立 Mongo 连接；失败则退化为纯 API 模式（见 spec §7）。 */
async function getRepository(): Promise<BarRepository | undefined> {
  if (sharedRepository) return sharedRepository;
  if (repositoryFailed) return undefined;
  try {
    const uri = process.env["MONGODB_URI"] ?? "mongodb://localhost:27017/financial-agent";
    const store = await MongoBarStore.connect(uri);
    sharedRepository = createBarRepository({ store, client: { fetchDailyBars: alpaca.fetchDailyBars } });
    return sharedRepository;
  } catch {
    repositoryFailed = true;
    return undefined;
  }
}

function pct(current: number, base: number): number | null {
  if (!isFinite(base) || base === 0) return null;
  return parseFloat((((current - base) / base) * 100).toFixed(2));
}

function fmtVolume(volume: number | null): string {
  if (volume === null) return "N/A";
  if (volume >= 1e9) return `${(volume / 1e9).toFixed(2)}B`;
  if (volume >= 1e6) return `${(volume / 1e6).toFixed(1)}M`;
  if (volume >= 1e3) return `${(volume / 1e3).toFixed(1)}K`;
  return String(volume);
}

export function createGetStockPriceTool(overrides?: {
  repository?: BarRepository;
  snapshot?: (symbol: string, nowMs: number) => Promise<Snapshot>;
}): RegisteredTool {
  const loadSnapshot = overrides?.snapshot ?? getSnapshotCached;

  return {
    name: "get_stock_price",
    description:
      "Fetch live US stock quotes and recent daily bars for one ticker. You must pass the ticker in the symbol argument. Live quotes come from Alpaca; daily history is served from a local store that updates incrementally.",
    category: "non_trading",
    inputSchema: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: {
          type: "string",
          description: "US stock ticker to look up, e.g. AAPL, TSLA, NVDA. Required — resolve it from the conversation before calling.",
        },
        task: {
          type: "string",
          description: "Natural-language request, passed through for report context.",
        },
        historyDays: {
          type: "number",
          description: `How many trading days of daily bars to return. Defaults to ${DEFAULT_HISTORY_DAYS}.`,
        },
        includeIntraday: {
          type: "boolean",
          description: "Whether to include today's 1-minute bars. Defaults to false.",
        },
      },
    },
    execute: async (input: JsonObject) => {
      const symbol =
        typeof input["symbol"] === "string" && input["symbol"].trim()
          ? input["symbol"].trim().toUpperCase()
          : undefined;

      if (!symbol) {
        return {
          summary: "No symbol was passed to get_stock_price. Call it again with the ticker in the symbol argument.",
          generation_context: {
            prompt:
              "No ticker was supplied. Determine which stock the user means from the conversation and call get_stock_price again with the symbol argument set.",
            data: { symbol: null, error: "symbol_required" },
          },
        };
      }

      const historyDays =
        typeof input["historyDays"] === "number" && input["historyDays"] > 0
          ? Math.floor(input["historyDays"])
          : DEFAULT_HISTORY_DAYS;
      const includeIntraday = input["includeIntraday"] === true;
      const current = new Date();
      const session = marketSession(current);

      // 日 K：优先走本地库；库不可用时直接拉 API
      let dailyBars: DailyBar[] = [];
      try {
        const repository = overrides?.repository ?? (await getRepository());
        if (repository) {
          dailyBars = await repository.getDailyBars(symbol, historyDays);
        } else {
          // Mongo 不可用：退化为纯 API 模式。多取自然日以覆盖 historyDays 个交易日
          const from = new Date(current);
          from.setUTCDate(from.getUTCDate() - Math.ceil(historyDays * 1.5) - 5);
          const fetched = await alpaca.fetchDailyBars(
            symbol,
            from.toISOString().slice(0, 10),
            etDateString(current),
          );
          dailyBars = fetched.slice(Math.max(0, fetched.length - historyDays));
        }
      } catch {
        dailyBars = [];
      }

      let snapshot: Snapshot | undefined;
      let snapshotError: string | undefined;
      try {
        snapshot = await loadSnapshot(symbol, current.getTime());
      } catch (err) {
        snapshotError = err instanceof Error ? err.message : String(err);
      }

      const latestBar = dailyBars[dailyBars.length - 1];

      if (!snapshot && !latestBar) {
        return {
          summary: `Market data unavailable for ${symbol}: ${snapshotError ?? "no data"}`,
          generation_context: {
            prompt: `No market data available for ${symbol}.`,
            data: { symbol, error: snapshotError ?? "no data", dataSource: DATA_SOURCE },
          },
        };
      }

      const staleness =
        !snapshot && latestBar
          ? `Live quote unavailable; the most recent data is the daily close for ${latestBar.t}.`
          : undefined;

      const price = snapshot?.price ?? latestBar?.c ?? null;
      const prevClose =
        snapshot?.prevClose ?? (dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2]!.c : null);
      const changePercent = price !== null && prevClose !== null ? pct(price, prevClose) : null;

      let intradayBars: DailyBar[] | undefined;
      if (includeIntraday) {
        try {
          intradayBars = await fetchIntradayBars(symbol, etDateString(current));
        } catch {
          intradayBars = [];
        }
      }

      const data: JsonObject = {
        symbol,
        price,
        bidPrice: snapshot?.bidPrice ?? null,
        askPrice: snapshot?.askPrice ?? null,
        dayOpen: snapshot?.dayOpen ?? latestBar?.o ?? null,
        dayHigh: snapshot?.dayHigh ?? latestBar?.h ?? null,
        dayLow: snapshot?.dayLow ?? latestBar?.l ?? null,
        prevClose,
        changePercent,
        volume: snapshot?.volume ?? latestBar?.v ?? null,
        marketSession: session,
        quoteTimestamp: snapshot?.quoteTimestamp ?? latestBar?.t ?? null,
        dailyBars,
        dataSource: DATA_SOURCE,
        ...(intradayBars ? { intradayBars } : {}),
        ...(staleness ? { staleness } : {}),
      };

      const changeStr = changePercent !== null ? `${changePercent >= 0 ? "+" : ""}${changePercent}%` : "N/A";
      const priceStr = price !== null ? `$${price}` : "N/A";
      const suffix = staleness ? ` | 数据截至 ${latestBar?.t}` : ` | ${session}`;

      return {
        summary: `${symbol} ${priceStr} | ${changeStr} | Vol ${fmtVolume(data["volume"] as number | null)}${suffix}`,
        generation_context: {
          prompt: buildStockPricePrompt(symbol, session, staleness),
          data,
        },
      };
    },
  };
}
```

在文件顶部补上 prompts 的 import：

```ts
import { buildStockPricePrompt } from "./prompts.ts";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS，6 个工具层测试全绿；全套测试（Task 1–5 共 25 个）全绿

- [ ] **Step 6: 注册工具**

修改 `mcp_tools/registerTools.ts`：

import 区（`// market` 分组下）加一行：

```ts
import { createGetStockPriceTool } from "./stock/getStockPriceTool.ts";
```

`registerAllTools` 的 non_trading 段添加：

```ts
  registry.register(createGetStockPriceTool());
```

`ONCHAIN_DATA_TOOLS` 数组添加：

```ts
  "get_stock_price",
```

- [ ] **Step 7: 补充 .env.example**

在文件末尾追加：

```
# --------------------------------
# Alpaca — US stock market data
# --------------------------------
ALPACA_API_KEY_ID=
ALPACA_API_SECRET_KEY=
```

- [ ] **Step 8: 验证工具已注册**

Run: `npm run tools:list`
Expected: 输出中包含 `get_stock_price`

- [ ] **Step 9: 端到端手工验证**

前置：`.env` 中填入真实的 Alpaca key（免费档在 alpaca.markets 注册即得），本地 MongoDB 运行中。

Run: `npx tsc --noEmit`
Expected: exit 0

用一次性脚本跑真实调用（放在 scratchpad，不要提交进仓库）：

```bash
node --env-file=.env --experimental-strip-types -e "
import('./mcp_tools/stock/getStockPriceTool.ts').then(async (m) => {
  const tool = m.createGetStockPriceTool();
  const r = await tool.execute({ task: 'AAPL 现在多少钱' });
  console.log(r.summary);
  console.log('bars:', r.generation_context.data.dailyBars.length);
  const again = await tool.execute({ task: 'AAPL 现在多少钱' });
  console.log('second call:', again.summary);
});
"
```

Expected:
- 首次调用触发 5 年回补，`bars` 数量接近 `historyDays` 默认值 60
- 第二次调用因 `lastCheckedAt` 在 30 分钟新鲜窗口内，不再请求日 K
- Mongo 中 `stock_bars` 集合出现 AAPL 文档，`stock_bar_coverage` 有对应记录
- 若当前处于非交易时段，`summary` 中的 `marketSession` 应为 `pre-market` / `after-hours` / `closed` 之一

- [ ] **Step 10: 交付审阅**

停下来向用户汇报全部五个任务的产出，等待审阅。**不要提交。**

---

## 自查记录

**Spec 覆盖检查**（逐节对照 `docs/superpowers/specs/2026-07-28-stock-price-tool-design.md`）：

| Spec 章节 | 对应 Task |
|---|---|
| §2 数据源与认证 | Task 1（请求头、base URL、`adjustment=all`）、Task 5 Step 7（env） |
| §3 分层架构 | Task 1 / 3 / 4 / 5，四层边界与 File Structure 表一致 |
| §4 数据模型与索引 | Task 3 |
| §4 读时增量 | Task 4 规则 1 与测试 2、3 |
| §4 复权与拆股检测 | Task 4 规则 2、3 与测试 5、6 |
| §5 三类数据落地方式 | 日 K → Task 3/4；snapshot 10 秒 TTL → Task 1；分钟线现拉不落库 → Task 5 |
| §6 工具接口（symbol 必填，由 agent 给出） | Task 5 |
| §7 错误处理七种情况 | Task 5（snapshot 失败降级、双失败、无效 symbol 不写 coverage → Task 4 测试 8、Mongo 不可用退化） |
| §8 六个测试用例 | Task 4 测试 1–6，另加 days 限制与空回补两例 |
| §9 注册与配置 | Task 5 Step 6、7 |

**对 spec 的一处细化**：spec §4 说"以 Alpaca 返回的最新 bar 日期判定是否最新"，但这需要先发一次请求，无法实现"零调用"。Task 4 改用 `lastCheckedAt` 距今 30 分钟内即跳过网络作为确定性判据——既避免维护美股节假日表，又真正做到热路径零调用。增量请求本身只取约 10 天 bar，成本极低。

**类型一致性**：`DailyBar` / `Snapshot`（Task 1）→ `BarStore`（Task 3）→ `BarRepository`（Task 4）→ 工具层（Task 5）签名逐层核对一致；`getBars` 的"升序、最近 N 根"约定在 Task 3 定义、Task 4 与 Task 5 依赖，三处描述统一。
