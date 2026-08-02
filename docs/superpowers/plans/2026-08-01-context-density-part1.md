# 上下文信息密度 Part 1 — 行情数据源头截断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `get_stock_price` 注入 prompt 的行情数据从 ~84KB/symbol 降到 ~3KB/symbol，同时提高信息密度——用精确统计和降采样趋势替代千行原始 bar，并给模型一个能表达绝对日期区间的参数。

**Architecture:** 一个纯函数 `condenseBars()` 把 bar 数组变成「尾部原始 + 降采样趋势 + 精确统计」三段式 `BarDigest`；MCP 适配层 `toJsonData()` 调它。数据层 `BarRepository` 增加绝对区间查询 `getBarsBetween()`，支撑新的 `window` 参数。全部变换是确定性代码，不调用任何模型。

**Tech Stack:** TypeScript，Node 23（`--experimental-strip-types` + `--experimental-sqlite`），`node:test` + `node:assert/strict`，pnpm。

**Spec:** `docs/superpowers/specs/2026-08-01-context-density-design.md`

## Global Constraints

- 所有代码、注释、prompt 文本一律英文。计划与 spec 文档用中文。
- 数值压缩必须是纯代码，**不得调用 LLM**。`src/agent/prompts/orchestratorPrompt.ts:28` 要求答案里每个数字来自 `generation_context` data；模型总结数值数组会产生看似合理的错误统计量。
- 不改前端任何文件。图表走 `visualizations` 独立通道。
- 不改 `BarStore` 接口，不改 SQL，不加 DB 表，不做迁移。
- 不改 `src/framework/contextCompaction.ts`（那是 Part 2）。
- 唯一允许改动的 framework 文件是 `src/framework/subagent.ts` 第 314 行一处删除（Task 1）。
- 全部数值四舍五入到 2 位小数。
- 测试跑法：`pnpm test`（根目录）。基线：**316 passing / 0 failing**（`01eabb7`）。任何任务结束时不得低于这个数且不得有 failing。
- 分支 `topic-workspace`，起点 `01eabb7`。开工前工作区必须干净。
- 类型检查：`npx tsc --noEmit` 必须干净。
- 常量取值：`MAX_RANGE_DAYS = 1260`（`src/data/stock/stockChartData.ts:32`）。
- 不要自行 `git commit` 之外的推送操作；每个 Task 末尾的 commit 是计划的一部分，但不 push。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/data/stock/barDigest.ts` | 纯函数：bar 数组 → `BarDigest`。无 IO、无依赖、幂等。 | 新建 |
| `src/data/stock/__tests__/barDigest.test.ts` | 上者的单测。 | 新建 |
| `src/data/stock/index.ts` | 桶文件，导出 `condenseBars` / `BarDigest` / `BarStats`。 | 改 |
| `src/data/stock/barRepository.ts` | 增加 `getBarsBetween()`，复用现有 coverage/回填逻辑。 | 改 |
| `src/data/stock/__tests__/barRepository.test.ts` | 增加 `getBarsBetween` 用例。 | 改 |
| `src/data/stock/stockPriceData.ts` | `StockPriceQuery` 增 `window`；`StockPriceData` 增 `windowBars` / `windowNote`；装配逻辑。 | 改 |
| `src/data/stock/__tests__/stockPriceData.test.ts` | 增加 window 装配用例；mock 补 `getBarsBetween`。 | 改 |
| `mcp_tools/stock/getStockPriceTool.ts` | inputSchema（删 `task`、加 `window`）、`historyDays` clamp 与新默认值、`toJsonData()` 接入 `condenseBars`。 | 改 |
| `mcp_tools/stock/__tests__/getStockPriceTool.test.ts` | 字段改名、clamp、window 的断言。 | 改 |
| `mcp_tools/stock/prompts.ts` | 改写 `buildStockPricePrompt()` 说明新字段。 | 改 |
| `mcp_tools/trading/strategyTools.ts` | 删 4 处 `task` 声明与 4 处 `required` 条目。 | 改 |
| `src/framework/subagent.ts` | 删第 314 行的 `task` 注入。 | 改 |

---

### Task 1: 删除死掉的 `task` 工具入参

`task` 在三个层面都没有消费者：inputSchema 声明被 `subagent.ts:129` 无条件过滤（模型看不见）；`required` 条目没有任何校验读取它（全代码库无 required 校验，`required` 只用于渲染 `*` 标记，而渲染循环遍历的是已过滤的 `properties`）；`subagent.ts:314` 注入的值被 15 个 `execute` 函数中的 0 个读取。

**注意区分**：`subagent.ts:197` 与 `:283` 用的是 `input.request.task`（subagent 自己的请求对象，也是 `generation_context.data.task` 的来源），与工具入参 `callInput.task` 是两个东西。**不要动它们。**

**Files:**
- Modify: `mcp_tools/stock/getStockPriceTool.ts:62-65`
- Modify: `mcp_tools/trading/strategyTools.ts:39,41,206,208,254,256,297,299`
- Modify: `src/framework/subagent.ts:314`
- Test: `mcp_tools/stock/__tests__/getStockPriceTool.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 无新接口。后续任务在 `getStockPriceTool.ts` 的 `inputSchema.properties` 上继续增删，此任务确保那里不再有 `task`。

- [ ] **Step 1: 写失败测试**

在 `mcp_tools/stock/__tests__/getStockPriceTool.test.ts` 末尾追加：

```ts
test("input schema does not declare the framework-injected task parameter", () => {
  const tool = createGetStockPriceTool();
  assert.equal(tool.inputSchema?.properties?.["task"], undefined);
  assert.ok(!(tool.inputSchema?.required ?? []).includes("task"));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test 2>&1 | grep -E "^(not ok|# (pass|fail))"
```
Expected: 该用例 FAIL（`task` 当前存在于 properties）。

- [ ] **Step 3: 删除三层**

`mcp_tools/stock/getStockPriceTool.ts` — 删掉整个 `task` 属性块：

```ts
        task: {
          type: "string",
          description: "Natural-language request, passed through for report context.",
        },
```

`mcp_tools/trading/strategyTools.ts` — 四处 `required` 数组去掉 `"task"`：

```ts
      required: ["task", "name", "symbol", "phases"],   // → required: ["name", "symbol", "phases"],
      required: ["task", "strategy_id"],                // → required: ["strategy_id"],
      required: ["task"],                               // → required: [],
      required: ["task", "strategy_id", "op"],          // → required: ["strategy_id", "op"],
```

同文件四处属性声明整块删除：

```ts
        task: { type: "string", description: "Natural-language description of the user's intent." },
        task: { type: "string", description: "Natural-language request." },
        task: { type: "string", description: "Natural-language request." },
        task: { type: "string", description: "Natural-language request." },
```

`src/framework/subagent.ts:314` — 去掉注入：

```ts
const callInput: JsonObject = { task: input.request.task, ...call.input };
```
改为
```ts
const callInput: JsonObject = { ...call.input };
```

- [ ] **Step 4: 同步清理 `formatToolArgs` 的过滤（保留，加注释）**

`src/framework/subagent.ts:126-129` 的过滤现在没有目标了，但**保留它**——它是对"任何工具都不该声明 task"的防御，删掉会让将来重新引入的声明直接漏给模型。把注释改成反映现状：

```ts
/** Render a tool's argument schema as a structured block. `task` is filtered as a
 *  guard: no tool declares it any more, and none should — it was a framework-injected
 *  parameter that no `execute` ever read. */
function formatToolArgs(schema: JsonSchema | undefined): string {
```

- [ ] **Step 5: 跑全量测试**

```bash
pnpm test 2>&1 | tail -20 && npx tsc --noEmit
```
Expected: PASS，总数 ≥ 289（新增 1 个），0 failing，tsc 无输出。

- [ ] **Step 6: Commit**

```bash
git add mcp_tools/stock/getStockPriceTool.ts mcp_tools/stock/__tests__/getStockPriceTool.test.ts \
        mcp_tools/trading/strategyTools.ts src/framework/subagent.ts
git commit -m "refactor: drop the dead task tool parameter

It had no consumer at any of three layers: the inputSchema declaration was
filtered out of the model-visible schema, the required entries were never
validated, and the value injected into every tool call was read by none of
the fifteen execute functions.

The filter in formatToolArgs stays as a guard against reintroduction."
```

---

### Task 2: `condenseBars` 纯函数

三段式压缩的全部逻辑。无 IO、无依赖、幂等——这是整个 spec 里唯一携带算术的地方，因此测试最密。

**Files:**
- Create: `src/data/stock/barDigest.ts`
- Create: `src/data/stock/__tests__/barDigest.test.ts`
- Modify: `src/data/stock/index.ts`

**Interfaces:**
- Consumes: `DailyBar` from `./alpacaClient.ts` — `{ t: string; o: number; h: number; l: number; c: number; v: number; vw: number }`。`t` 对日线是 `"2026-07-27"`，对分钟线是完整 ISO 时间戳。
- Produces:
  - `condenseBars(bars: readonly DailyBar[], options?: { keepTail?: number; maxTrendPoints?: number }): BarDigest`
  - `type BarDigest = { recentBars: DailyBar[]; trend?: { t: string[]; c: number[]; bucketDays: number }; stats?: BarStats }`
  - `type BarStats = { from: string; to: string; count: number; first: number; last: number; min: { value: number; t: string }; max: { value: number; t: string }; mean: number; stdev: number; returnPct: number; maxDrawdownPct: number; sma20: number | null; sma50: number | null }`
  - 常量 `DEFAULT_KEEP_TAIL = 7`、`DEFAULT_MAX_TREND_POINTS = 120`（不导出，仅作默认值）

- [ ] **Step 1: 写失败测试**

创建 `src/data/stock/__tests__/barDigest.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { condenseBars } from "../barDigest.ts";
import type { DailyBar } from "../alpacaClient.ts";

/** A bar whose close is `c`; the other fields are derived so they stay distinguishable. */
function bar(t: string, c: number): DailyBar {
  return { t, o: c - 1, h: c + 1, l: c - 2, c, v: 1_000, vw: c };
}

/** `count` consecutive weekday-ish dates from 2020-01-01, closes given by `close(i)`. */
function series(count: number, close: (i: number) => number): DailyBar[] {
  const bars: DailyBar[] = [];
  const day = new Date(Date.UTC(2020, 0, 1));
  for (let i = 0; i < count; i++) {
    bars.push(bar(day.toISOString().slice(0, 10), close(i)));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return bars;
}

test("empty input yields no trend and no stats", () => {
  assert.deepEqual(condenseBars([]), { recentBars: [] });
});

test("input at or below keepTail is returned whole, with stats but no trend", () => {
  const bars = series(7, (i) => 100 + i);
  const digest = condenseBars(bars);
  assert.deepEqual(digest.recentBars, bars);
  assert.equal(digest.trend, undefined);
  assert.equal(digest.stats?.count, 7);
});

test("one bar past keepTail produces a single trend point at bucketDays 1", () => {
  const digest = condenseBars(series(8, (i) => 100 + i));
  assert.equal(digest.recentBars.length, 7);
  assert.equal(digest.trend?.bucketDays, 1);
  assert.deepEqual(digest.trend?.t, ["2020-01-01"]);
  assert.deepEqual(digest.trend?.c, [100]);
});

test("a thousand bars keep seven raw and cap the trend at the point budget", () => {
  const digest = condenseBars(series(1000, (i) => 100 + i));
  assert.equal(digest.recentBars.length, 7);
  assert.equal(digest.trend?.bucketDays, Math.ceil(993 / 120));
  assert.equal(digest.trend?.t.length, digest.trend?.c.length);
  assert.ok((digest.trend?.t.length ?? 0) <= 120);
});

test("each trend point is the last bar of its bucket", () => {
  // 13 bars: 6 in the head (keepTail 7), maxTrendPoints 3 → bucketDays 2 → buckets [0,1] [2,3] [4,5]
  const digest = condenseBars(series(13, (i) => 100 + i), { maxTrendPoints: 3 });
  assert.equal(digest.trend?.bucketDays, 2);
  assert.deepEqual(digest.trend?.c, [101, 103, 105]);
  assert.deepEqual(digest.trend?.t, ["2020-01-02", "2020-01-04", "2020-01-06"]);
});

test("a short final bucket still emits its point", () => {
  // 12 bars: 5 in the head, bucketDays 2 → buckets [0,1] [2,3] [4]
  const digest = condenseBars(series(12, (i) => 100 + i), { maxTrendPoints: 3 });
  assert.deepEqual(digest.trend?.c, [101, 103, 104]);
});

test("stats cover the whole input, not just the downsampled head", () => {
  const digest = condenseBars(series(100, (i) => 100 + i));
  assert.equal(digest.stats?.from, "2020-01-01");
  assert.equal(digest.stats?.count, 100);
  assert.equal(digest.stats?.first, 100);
  assert.equal(digest.stats?.last, 199);
});

test("derived figures match hand-computed values", () => {
  const bars = [bar("2021-01-01", 10), bar("2021-01-02", 20), bar("2021-01-03", 30)];
  const stats = condenseBars(bars, { keepTail: 3 }).stats!;
  assert.deepEqual(stats.min, { value: 10, t: "2021-01-01" });
  assert.deepEqual(stats.max, { value: 30, t: "2021-01-03" });
  assert.equal(stats.mean, 20);
  // population stdev of [10,20,30] = sqrt(200/3) = 8.16
  assert.equal(stats.stdev, 8.16);
  assert.equal(stats.returnPct, 200);
});

test("min and max report the first occurrence of a repeated extreme", () => {
  const bars = [bar("2021-01-01", 5), bar("2021-01-02", 9), bar("2021-01-03", 5), bar("2021-01-04", 9)];
  const stats = condenseBars(bars, { keepTail: 4 }).stats!;
  assert.equal(stats.min.t, "2021-01-01");
  assert.equal(stats.max.t, "2021-01-02");
});

test("a monotonic rise has no drawdown", () => {
  const stats = condenseBars(series(50, (i) => 100 + i), { keepTail: 50 }).stats!;
  assert.equal(stats.maxDrawdownPct, 0);
});

test("max drawdown is measured from the running peak", () => {
  // peak 200 → trough 150 is 25%; the later 180 → 171 dip is only 5%
  const bars = [
    bar("2021-01-01", 100), bar("2021-01-02", 200), bar("2021-01-03", 150),
    bar("2021-01-04", 180), bar("2021-01-05", 171),
  ];
  const stats = condenseBars(bars, { keepTail: 5 }).stats!;
  assert.equal(stats.maxDrawdownPct, 25);
});

test("a zero opening price yields zero return rather than Infinity", () => {
  const bars = [bar("2021-01-01", 0), bar("2021-01-02", 50)];
  const stats = condenseBars(bars, { keepTail: 2 }).stats!;
  assert.equal(stats.returnPct, 0);
  assert.ok(Number.isFinite(stats.returnPct));
});

test("moving averages are null until enough bars exist", () => {
  const short = condenseBars(series(19, (i) => 100 + i), { keepTail: 19 }).stats!;
  assert.equal(short.sma20, null);
  assert.equal(short.sma50, null);

  const mid = condenseBars(series(20, () => 100), { keepTail: 20 }).stats!;
  assert.equal(mid.sma20, 100);
  assert.equal(mid.sma50, null);

  const long = condenseBars(series(50, () => 100), { keepTail: 50 }).stats!;
  assert.equal(long.sma50, 100);
});

test("moving averages use only the trailing window", () => {
  // The first 10 closes are 1 and the last 20 are 200: an sma20 that reached
  // back past the window would land well under 200.
  const bars = series(30, (i) => (i < 10 ? 1 : 200));
  const stats = condenseBars(bars, { keepTail: 30 }).stats!;
  assert.equal(stats.sma20, 200);
  assert.equal(stats.sma50, null);
});

test("condensing is idempotent for a given input", () => {
  const bars = series(300, (i) => 100 + Math.sin(i));
  assert.deepEqual(condenseBars(bars), condenseBars(bars));
});

test("the input array is not mutated", () => {
  const bars = series(30, (i) => 100 + i);
  const before = JSON.stringify(bars);
  condenseBars(bars);
  assert.equal(JSON.stringify(bars), before);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test 2>&1 | grep -E "barDigest|# (pass|fail)"
```
Expected: FAIL，`Cannot find module '../barDigest.ts'`。

- [ ] **Step 3: 实现**

创建 `src/data/stock/barDigest.ts`：

```ts
import type { DailyBar } from "./alpacaClient.ts";

/**
 * Condensing a bar series for the model's prompt.
 *
 * A `get_stock_price` call used to inject its full bar array verbatim — a
 * thousand daily bars is ~84KB, about 21k tokens, and the model reads almost
 * none of it. What it actually uses is the last few bars, the shape of the rest,
 * and figures derived from the whole thing. This produces exactly those three.
 *
 * Every value here is computed, never estimated. Handing a numeric series to a
 * model to summarize is the single most reliable way to get plausible wrong
 * numbers, and `src/agent/prompts/orchestratorPrompt.ts` requires every figure
 * in an answer to come from this data.
 */

/** Raw bars kept at the tail. One trading week — these are the only bars a
 *  question quotes individually ("today", "yesterday", "this week"). Anything
 *  older is a question about shape, which `trend` answers. */
const DEFAULT_KEEP_TAIL = 7;

/** Ceiling on trend points. 120 is enough for the shape of any span to read,
 *  and two parallel arrays of that length cost ~2.4KB against the 84KB the
 *  raw series cost. */
const DEFAULT_MAX_TREND_POINTS = 120;

export type BarStats = {
  from: string;
  to: string;
  count: number;
  first: number;
  last: number;
  min: { value: number; t: string };
  max: { value: number; t: string };
  mean: number;
  stdev: number;
  returnPct: number;
  maxDrawdownPct: number;
  sma20: number | null;
  sma50: number | null;
};

export type BarDigest = {
  /** Tail bars, verbatim. Safe to quote per-bar. */
  recentBars: DailyBar[];
  /** Downsampled closes for everything before the tail. Omitted when there is
   *  nothing before it.
   *
   *  Parallel arrays rather than an array of objects: `[{t,c},…]` repeats two
   *  key names per point, `{t:[…],c:[…]}` writes them once. Dates are stored
   *  per point rather than derived from a start plus a step, because trading
   *  days are not calendar-uniform — a derived date would be wrong, and a wrong
   *  date gets quoted as fact. */
  trend?: { t: string[]; c: number[]; bucketDays: number };
  /** Exact figures over the whole input, including `recentBars`. Omitted only
   *  for empty input. */
  stats?: BarStats;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Population standard deviation: this is a complete known series, not a sample. */
function stdev(values: number[], mean: number): number {
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Largest peak-to-trough fall, as a percentage of the peak, where the peak
 *  precedes the trough. Zero for a series that never falls. */
function maxDrawdownPct(closes: number[]): number {
  let peak = closes[0]!;
  let worst = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const fall = ((peak - close) / peak) * 100;
      if (fall > worst) worst = fall;
    }
  }
  return worst;
}

/** Mean of the last `window` closes, or null when the series is shorter. */
function sma(closes: number[], window: number): number | null {
  if (closes.length < window) return null;
  const tail = closes.slice(closes.length - window);
  return round2(tail.reduce((sum, c) => sum + c, 0) / tail.length);
}

function computeStats(bars: readonly DailyBar[]): BarStats {
  const closes = bars.map((b) => b.c);
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;

  let min = { value: closes[0]!, t: bars[0]!.t };
  let max = { value: closes[0]!, t: bars[0]!.t };
  for (let i = 1; i < bars.length; i++) {
    // Strict comparison keeps the FIRST occurrence of a repeated extreme.
    if (closes[i]! < min.value) min = { value: closes[i]!, t: bars[i]!.t };
    if (closes[i]! > max.value) max = { value: closes[i]!, t: bars[i]!.t };
  }

  const mean = closes.reduce((sum, c) => sum + c, 0) / closes.length;

  return {
    from: bars[0]!.t,
    to: bars[bars.length - 1]!.t,
    count: bars.length,
    first: round2(first),
    last: round2(last),
    min: { value: round2(min.value), t: min.t },
    max: { value: round2(max.value), t: max.t },
    mean: round2(mean),
    stdev: round2(stdev(closes, mean)),
    // A zero opening price would make the ratio infinite; report no move
    // rather than emitting Infinity into the prompt.
    returnPct: first === 0 ? 0 : round2(((last - first) / first) * 100),
    maxDrawdownPct: round2(maxDrawdownPct(closes)),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
  };
}

export function condenseBars(
  bars: readonly DailyBar[],
  options?: { keepTail?: number; maxTrendPoints?: number },
): BarDigest {
  if (bars.length === 0) return { recentBars: [] };

  const keepTail = options?.keepTail ?? DEFAULT_KEEP_TAIL;
  const maxTrendPoints = options?.maxTrendPoints ?? DEFAULT_MAX_TREND_POINTS;
  const stats = computeStats(bars);

  if (bars.length <= keepTail) {
    return { recentBars: bars.map((bar) => ({ ...bar })), stats };
  }

  const head = bars.slice(0, bars.length - keepTail);
  const bucketDays = Math.max(1, Math.ceil(head.length / maxTrendPoints));
  const t: string[] = [];
  const c: number[] = [];
  // Each bucket contributes its LAST bar: the close a bucket ends on is the
  // one a reader compares against the next bucket. A short final bucket still
  // contributes, so the trend runs right up to where `recentBars` begins.
  for (let start = 0; start < head.length; start += bucketDays) {
    const bucketEnd = Math.min(start + bucketDays, head.length) - 1;
    t.push(head[bucketEnd]!.t);
    c.push(round2(head[bucketEnd]!.c));
  }

  return {
    recentBars: bars.slice(bars.length - keepTail).map((bar) => ({ ...bar })),
    trend: { t, c, bucketDays },
    stats,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test 2>&1 | grep -E "barDigest|# (pass|fail)" && npx tsc --noEmit
```
Expected: 17 个新用例全 PASS，总 failing 为 0。

- [ ] **Step 5: 从桶文件导出**

在 `src/data/stock/index.ts` 顶部（`alpacaClient` 的 export 块之后）插入，保持文件里按模块名字母序的既有风格：

```ts
export { condenseBars, type BarDigest, type BarStats } from "./barDigest.ts";
```

- [ ] **Step 6: 跑 tsc 并 commit**

```bash
npx tsc --noEmit && pnpm test 2>&1 | tail -5
git add src/data/stock/barDigest.ts src/data/stock/__tests__/barDigest.test.ts src/data/stock/index.ts
git commit -m "feat: add condenseBars, a deterministic bar-series digest

Turns a bar array into three parts the model actually uses: the last few bars
verbatim, a downsampled close series for shape, and exact derived figures over
the whole span. All computed, never estimated — a model asked to summarize a
numeric series produces plausible wrong numbers, and the orchestrator prompt
requires every figure in an answer to come from this data."
```

---

### Task 3: 接入 `toJsonData()`，改名字段，clamp 并提高 `historyDays`

体积收益在这一步全部到手。字段从 `dailyBars` / `intradayBars` 改名为 `daily` / `intraday`——形状变了还用旧名，模型会继续按 `dailyBars[0].o` 索引。

`historyDays` 现在没有任何上限（`getStockPriceTool.ts:93-96` 只做 `> 0` 和 `Math.floor`），这是 1000 能长驱直入的原因。同时把默认值从 60 提到 250：压缩之后 250 天只比 60 天多约 1KB 且封顶，而模型能看到一整年的形状。

**Files:**
- Modify: `mcp_tools/stock/getStockPriceTool.ts:13`（默认值常量）、`:22-40`（`toJsonData`）、`:93-96`（clamp）、`:124`（`staleness` 里对 `dailyBars` 的引用）
- Modify: `mcp_tools/stock/__tests__/getStockPriceTool.test.ts`

**Interfaces:**
- Consumes: `condenseBars(bars, options?): BarDigest`（Task 2）
- Produces: `generation_context.data` 的新形状——`daily: BarDigest`，可选 `intraday: BarDigest`，可选 `historyDaysNote: string`。后续 Task 5 在同一个对象上加 `window` 与 `windowNote`；Task 6 的 prompt 描述这些字段。

- [ ] **Step 1: 写失败测试**

在 `mcp_tools/stock/__tests__/getStockPriceTool.test.ts` 追加。先读现有文件顶部的 helper（`bar()` 与 `createGetStockPriceTool` 的调用方式）并沿用：

```ts
test("daily bars are condensed rather than passed through", async () => {
  const bars = Array.from({ length: 300 }, (_, i) =>
    bar(`2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, 100 + i));
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => bars, getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute({ symbol: "AAPL" }, { sessionId: "s" });
  const data = result.generation_context!.data as Record<string, unknown>;

  assert.equal(data["dailyBars"], undefined, "the raw array must not be injected");
  const daily = data["daily"] as { recentBars: unknown[]; trend?: { c: number[] }; stats?: { count: number } };
  assert.equal(daily.recentBars.length, 7);
  assert.equal(daily.stats?.count, 300);
  assert.ok((daily.trend?.c.length ?? 0) <= 120);
});

test("historyDays is clamped and the clamp is reported", async () => {
  let requested = 0;
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async (_s, _tf, count) => { requested = count; return [bar("2026-07-27", 100)]; },
      getBarsBetween: async () => [],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute({ symbol: "AAPL", historyDays: 99_999 }, { sessionId: "s" });
  const data = result.generation_context!.data as Record<string, unknown>;

  assert.equal(requested, 1260, "must not ask the repository for more than MAX_RANGE_DAYS");
  assert.match(String(data["historyDaysNote"]), /1260/);
});

test("a call with no historyDays asks for a year", async () => {
  let requested = 0;
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async (_s, _tf, count) => { requested = count; return [bar("2026-07-27", 100)]; },
      getBarsBetween: async () => [],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  await tool.execute({ symbol: "AAPL" }, { sessionId: "s" });
  assert.equal(requested, 250);
});

test("a historyDays within the limit produces no note", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute({ symbol: "AAPL", historyDays: 1260 }, { sessionId: "s" });
  assert.equal((result.generation_context!.data as Record<string, unknown>)["historyDaysNote"], undefined);
});
```

**注意**：上面的 mock 已经带了 `getBarsBetween`，因为 Task 4 会把它变成 `BarRepository` 的必需方法。在 Task 4 之前它是多余的属性，TypeScript 对对象字面量的多余属性检查会报错——**所以本任务的 mock 先不要写 `getBarsBetween`，Task 4 再统一加**。执行本任务时请从上面每个 mock 里删掉那一行。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test 2>&1 | grep -E "getStockPriceTool|# (pass|fail)"
```
Expected: 四个新用例 FAIL（当前注入的是 `dailyBars`，且无 clamp）。

- [ ] **Step 3: 改默认值常量与 import**

`mcp_tools/stock/getStockPriceTool.ts` 顶部：

```ts
import { condenseBars, MAX_RANGE_DAYS } from "../../src/data/stock/index.ts";
```
（加进已有的 `from "../../src/data/stock/index.ts"` 那个 import 块，不要新开一行 import。）

```ts
const DEFAULT_HISTORY_DAYS = 60;
```
改为
```ts
/** A trading year. Before `condenseBars`, a longer default meant a proportionally
 *  larger prompt, so 60 was the compromise. Now the trend is capped at a fixed
 *  point budget: a year costs about 1KB more than a quarter and shows the model
 *  annual highs, lows and drawdowns that three months cannot. */
const DEFAULT_HISTORY_DAYS = 250;
```

同一常量区再加两个。取值理由要读懂 `intradayBars` 当前的语义：`src/data/stock/stockPriceData.ts:143` 是 `latestSession(await repository.getBars(symbol, "1Min", 960))` —— 本地 store 里最近**一个完整交易日**的分钟线，含盘前盘后最多约 960 根，不是"今天到现在为止"。

```ts
/** Minute bars kept raw: the last quarter hour. The only question needing
 *  per-minute precision is "is it moving right now", and minute bars are the
 *  lowest-density data in the system. */
const INTRADAY_KEEP_TAIL = 15;
/** Enough points for the session's shape: ~6 minutes per bucket in regular
 *  hours, ~16 across an extended-hours session. */
const INTRADAY_MAX_TREND_POINTS = 60;
```

注意分钟线的 `t` 是完整 ISO 时间戳（`"2026-07-31T19:59:59.518851197Z"`）而不是 `"2026-07-27"`——`condenseBars` 对此无需特殊处理（它只做 `t` 的透传），但估算体积时每个 trend 点比日线贵约一倍。

- [ ] **Step 4: 改 `toJsonData()`**

```ts
function toJsonData(data: StockPriceData): JsonObject {
  return {
    symbol: data.symbol,
    price: data.price,
    bidPrice: data.bidPrice,
    askPrice: data.askPrice,
    dayOpen: data.dayOpen,
    dayHigh: data.dayHigh,
    dayLow: data.dayLow,
    prevClose: data.prevClose,
    changePercent: data.changePercent,
    volume: data.volume,
    marketSession: data.marketSession,
    quoteTimestamp: data.quoteTimestamp,
    // Renamed from `dailyBars`: the shape changed, and reusing the old name
    // would leave the model indexing `dailyBars[0].o` into a digest.
    daily: condenseBars(data.dailyBars) as unknown as JsonObject,
    dataSource: data.dataSource,
    ...(data.intradayBars
      ? {
          intraday: condenseBars(data.intradayBars, {
            keepTail: INTRADAY_KEEP_TAIL,
            maxTrendPoints: INTRADAY_MAX_TREND_POINTS,
          }) as unknown as JsonObject,
        }
      : {}),
    ...(data.staleness ? { staleness: data.staleness } : {}),
  };
}
```

- [ ] **Step 5: 改 clamp**

`getStockPriceTool.ts:93-96`：

```ts
      const historyDays =
        typeof input["historyDays"] === "number" && input["historyDays"] > 0
          ? Math.floor(input["historyDays"])
          : DEFAULT_HISTORY_DAYS;
```
改为
```ts
      const requestedHistoryDays =
        typeof input["historyDays"] === "number" && input["historyDays"] > 0
          ? Math.floor(input["historyDays"])
          : DEFAULT_HISTORY_DAYS;
      // Reaching further back is what `window` is for. Without this ceiling the
      // model's existing habit — widen the trailing history until it covers the
      // date it wants — silently survives every other change here.
      const historyDays = Math.min(requestedHistoryDays, MAX_RANGE_DAYS);
      const historyDaysNote =
        requestedHistoryDays > MAX_RANGE_DAYS
          ? `historyDays was capped at ${MAX_RANGE_DAYS} trading days. To look at an earlier period, pass a \`window\` instead of widening historyDays.`
          : undefined;
```

在返回 `generation_context.data` 的地方把它带上（该对象由 `toJsonData(data)` 展开）：

```ts
          data: {
            ...toJsonData(data),
            ...(historyDaysNote ? { historyDaysNote } : {}),
          },
```

- [ ] **Step 6: 修 `staleness` 里的旧引用**

`getStockPriceTool.ts:124` 仍然读 `data.dailyBars`。它读的是**数据层**的 `StockPriceData`（未压缩，Task 2 没动它），所以**保持原样即可**——确认这一行仍然编译通过，不要改成 `daily`：

```ts
        ? ` | data as of ${data.dailyBars[data.dailyBars.length - 1]?.t}`
```

- [ ] **Step 7: 更新既有断言**

`mcp_tools/stock/__tests__/getStockPriceTool.test.ts` 里现有用例若断言了 `data.dailyBars`，改为断言 `data.daily.recentBars`。用以下命令定位：

```bash
grep -n "dailyBars\|intradayBars" mcp_tools/stock/__tests__/getStockPriceTool.test.ts
```

- [ ] **Step 8: 跑测试并 commit**

```bash
pnpm test 2>&1 | tail -10 && npx tsc --noEmit
git add mcp_tools/stock/getStockPriceTool.ts mcp_tools/stock/__tests__/getStockPriceTool.test.ts
git commit -m "feat: condense bar series at the tool boundary

get_stock_price injected its full bar array into the prompt — a thousand daily
bars is ~84KB per symbol, about 21% of a 200k window for two symbols. It now
injects a digest, and the fields are renamed so the model cannot index the old
shape.

historyDays gains the ceiling it never had, and its default rises from 60 to
250: with the trend capped at a fixed point budget a year costs about 1KB more
than a quarter."
```

---

### Task 4: `BarRepository.getBarsBetween()`

`window` 需要按绝对日期取 bar，而 `BarRepository` 现有接口只有 `getBars(symbol, timeframe, count)`——按"最近 N 根"取，签名里没有日期。底层 `BarStore` 已经有 `getBarsOnOrAfter(symbol, timeframe, fromDate)`，只是没暴露到 repository 层。

**这个任务会改接口，13 处结构化 mock 会同时断掉类型。** 必须一并更新，列表在 Step 4。

**Files:**
- Modify: `src/data/stock/barRepository.ts:16`（接口）、`:107-146`（实现，在 `getBars` 之后追加）
- Modify: `src/data/stock/__tests__/barRepository.test.ts`
- Modify: 13 处 mock（见 Step 4）

**Interfaces:**
- Consumes: `BarStore.getBarsOnOrAfter(symbol, timeframe, fromDate): Promise<DailyBar[]>`
- Produces: `BarRepository.getBarsBetween(symbol: string, timeframe: Timeframe, from: string, to: string): Promise<DailyBar[]>` — 返回 `from <= t <= to` 的 bar，升序，两端闭区间。`from > to` 返回 `[]`。

- [ ] **Step 1: 写失败测试**

在 `src/data/stock/__tests__/barRepository.test.ts` 追加。先读文件顶部现有的 store/client fixture 构造方式并沿用：

```ts
test("getBarsBetween returns the inclusive range in ascending order", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Day", [
    { t: "2026-01-05", o: 1, h: 1, l: 1, c: 10, v: 1, vw: 1 },
    { t: "2026-01-06", o: 1, h: 1, l: 1, c: 20, v: 1, vw: 1 },
    { t: "2026-01-07", o: 1, h: 1, l: 1, c: 30, v: 1, vw: 1 },
    { t: "2026-01-08", o: 1, h: 1, l: 1, c: 40, v: 1, vw: 1 },
  ]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", firstDate: "2026-01-05", lastDate: "2026-01-08",
    backfilledAt: "2026-01-08T00:00:00.000Z", lastCheckedAt: "2026-01-08T00:00:00.000Z",
  });
  const repository = createBarRepository({
    store,
    client: { fetchBars: async () => [] },
    now: () => new Date("2026-01-08T00:10:00Z"),
  });

  const bars = await repository.getBarsBetween("AAPL", "1Day", "2026-01-06", "2026-01-07");
  assert.deepEqual(bars.map((b) => b.t), ["2026-01-06", "2026-01-07"]);
});

test("getBarsBetween returns nothing when from is after to", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Day", [{ t: "2026-01-05", o: 1, h: 1, l: 1, c: 10, v: 1, vw: 1 }]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", firstDate: "2026-01-05", lastDate: "2026-01-05",
    backfilledAt: "2026-01-05T00:00:00.000Z", lastCheckedAt: "2026-01-05T00:00:00.000Z",
  });
  const repository = createBarRepository({
    store,
    client: { fetchBars: async () => [] },
    now: () => new Date("2026-01-05T00:10:00Z"),
  });

  assert.deepEqual(await repository.getBarsBetween("AAPL", "1Day", "2026-02-01", "2026-01-01"), []);
});

test("getBarsBetween returns nothing when the range misses local coverage", async () => {
  const store = new InMemoryBarStore();
  await store.putBars("AAPL", "1Day", [{ t: "2026-01-05", o: 1, h: 1, l: 1, c: 10, v: 1, vw: 1 }]);
  await store.putCoverage({
    symbol: "AAPL", timeframe: "1Day", firstDate: "2026-01-05", lastDate: "2026-01-05",
    backfilledAt: "2026-01-05T00:00:00.000Z", lastCheckedAt: "2026-01-05T00:00:00.000Z",
  });
  const repository = createBarRepository({
    store,
    client: { fetchBars: async () => [] },
    now: () => new Date("2026-01-05T00:10:00Z"),
  });

  assert.deepEqual(await repository.getBarsBetween("AAPL", "1Day", "2020-01-01", "2020-06-01"), []);
});
```

若 `barRepository.test.ts` 里 fixture 的构造方式与上面不同（例如 `createBarRepository` 的参数名不叫 `client`），**以文件里现有用例为准**，只保留断言部分。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test 2>&1 | grep -E "getBarsBetween|# (pass|fail)"
```
Expected: FAIL，`repository.getBarsBetween is not a function`。

- [ ] **Step 3: 实现**

`src/data/stock/barRepository.ts` 接口（第 16 行附近）加一行：

```ts
  getBars(symbol: string, timeframe: Timeframe, count: number): Promise<DailyBar[]>;
  /** Bars for an absolute, inclusive date range. `from > to` yields an empty array. */
  getBarsBetween(symbol: string, timeframe: Timeframe, from: string, to: string): Promise<DailyBar[]>;
```

在返回对象里，`getBars` 之后追加。**freshness / backfill 的前置逻辑与 `getBars` 完全一致**——历史日 K 不可变，理论上 `to` 早于今天时可以跳过回填，但那会分叉出第二条新鲜度逻辑，省下的也只是一次 coverage 比较：

```ts
    async getBarsBetween(
      symbol: string,
      timeframe: Timeframe,
      from: string,
      to: string,
    ): Promise<DailyBar[]> {
      if (from > to) return [];
      // Same freshness and backfill path as getBars: a second, divergent copy of
      // that logic is a worse cost than the one coverage comparison it saves.
      await this.getBars(symbol, timeframe, 1);
      const onOrAfter = await store.getBarsOnOrAfter(symbol, timeframe, from);
      return onOrAfter.filter((bar) => bar.t <= to);
    },
```

上面的 `this.getBars` 在对象字面量里不可用。改为把 freshness 逻辑抽成一个内部函数，两个方法都调用它：

```ts
  /** Bring the local store up to date for this symbol/timeframe, then leave the
   *  reading to the caller. Shared by both public readers so their freshness
   *  behaviour cannot drift apart. */
  async function ensureFresh(symbol: string, timeframe: Timeframe): Promise<void> {
    const current = now();
    const nowIso = current.toISOString();
    const today = isoDate(current);
    const coverage = await store.getCoverage(symbol, timeframe);

    if (!coverage) {
      await backfill(symbol, timeframe, today, nowIso);
      return;
    }

    const checkedAgeMs = current.getTime() - new Date(coverage.lastCheckedAt).getTime();
    const freshnessMs = deps.freshnessMs ?? freshnessFor(timeframe);
    if (checkedAgeMs < freshnessMs) return;

    const from = incrementalFrom(timeframe, coverage.lastDate);
    const fetched = await client.fetchBars(symbol, timeframe, from, today);

    if (fetched.length === 0) {
      await store.putCoverage({ ...coverage, lastCheckedAt: nowIso });
      return;
    }

    const overlap = await store.getBarsOnOrAfter(symbol, timeframe, from);
    if (hasSplitDivergence(overlap, fetched)) {
      await store.clearSymbol(symbol, timeframe);
      await backfill(symbol, timeframe, today, nowIso);
      return;
    }

    await store.putBars(symbol, timeframe, fetched);
    const newest = fetched[fetched.length - 1]!.t;
    await store.putCoverage({
      ...coverage,
      lastDate: newest > coverage.lastDate ? newest : coverage.lastDate,
      lastCheckedAt: nowIso,
    });
  }

  return {
    async getBars(symbol: string, timeframe: Timeframe, count: number): Promise<DailyBar[]> {
      await ensureFresh(symbol, timeframe);
      return store.getBars(symbol, timeframe, count);
    },

    async getBarsBetween(
      symbol: string,
      timeframe: Timeframe,
      from: string,
      to: string,
    ): Promise<DailyBar[]> {
      if (from > to) return [];
      await ensureFresh(symbol, timeframe);
      const onOrAfter = await store.getBarsOnOrAfter(symbol, timeframe, from);
      return onOrAfter.filter((bar) => bar.t <= to);
    },
  };
```

这是把现有 `getBars` 体内的四个分支原样搬进 `ensureFresh`，每个 `return store.getBars(...)` 变成 `return`。**行为必须完全不变**——现有 `barRepository.test.ts` 的全部用例是这次重构的回归锁，一个都不能改。

- [ ] **Step 4: 更新 13 处 mock**

每一处 `BarRepository` 的结构化 mock 补上 `getBarsBetween`。除非该用例专门测 window，一律用返回空数组的桩：

```ts
getBarsBetween: async () => [],
```

用这条命令列出全部 13 处（行号会随其他改动漂移，按内容定位）：

```bash
grep -rn "getBars: async" src mcp_tools --include="*.ts"
```

分布：`src/data/stock/__tests__/stockChartData.test.ts` 1 处、`src/data/stock/__tests__/stockPriceData.test.ts` 3 处、`mcp_tools/stock/__tests__/getStockPriceTool.test.ts` 5 处、`mcp_tools/technical/__tests__/technicalIndicatorTools.test.ts` 4 处。

`stockPriceData.test.ts` 里 `repository: null` 的那处是纯 API 回退路径，没有 `getBars`，**不要动**。

用这条命令确认没有遗漏：

```bash
npx tsc --noEmit
```

- [ ] **Step 5: 跑测试并 commit**

```bash
pnpm test 2>&1 | tail -10 && npx tsc --noEmit
git add src/data/stock/barRepository.ts src/data/stock/__tests__/barRepository.test.ts \
        src/data/stock/__tests__/stockChartData.test.ts src/data/stock/__tests__/stockPriceData.test.ts \
        mcp_tools/technical/__tests__/technicalIndicatorTools.test.ts \
        mcp_tools/stock/__tests__/getStockPriceTool.test.ts
git commit -m "feat: add BarRepository.getBarsBetween for absolute date ranges

The repository could only read trailing counts, so a question about a past
period had to be expressed as 'enough recent bars to cover it'. The freshness
and backfill path is extracted into ensureFresh and shared, so the two readers
cannot drift apart."
```

---

### Task 5: `window` 参数

促成整个 spec 的那条记录里，模型在 `task` 里写明它要 `2026-01-31` 到 `2026-07-31`，然后因为没有参数能表达区间，翻译成 `historyDays: 500` 拉回 500 根 bar 自己算。这个任务给它那个参数。

窗口跨度在约 127 个交易日内时，`condenseBars` 的 `bucketDays` 为 1——head 里每个交易日各占一个 trend 点，`t[i]` / `c[i]` 是真实日期与真实收盘价，不是插值。所以"某一天收盘多少"用一个窄 window 就能精确回答。

**Files:**
- Modify: `src/data/stock/stockPriceData.ts:33-37`（`StockPriceQuery`）、`:14-30`（`StockPriceData`）、`:62-145`（装配）
- Modify: `src/data/stock/__tests__/stockPriceData.test.ts`
- Modify: `mcp_tools/stock/getStockPriceTool.ts`（inputSchema、execute、`toJsonData`）
- Modify: `mcp_tools/stock/__tests__/getStockPriceTool.test.ts`

**Interfaces:**
- Consumes: `BarRepository.getBarsBetween(symbol, timeframe, from, to)`（Task 4）；`condenseBars`（Task 2）
- Produces: `StockPriceQuery.window?: { from: string; to: string }`；`StockPriceData.windowBars?: DailyBar[]`、`StockPriceData.windowNote?: string`；`generation_context.data.window?: BarDigest`、`data.windowNote?: string`

- [ ] **Step 1: 写失败测试（数据层）**

`src/data/stock/__tests__/stockPriceData.test.ts` 追加：

```ts
test("a window is fetched by absolute date and returned unabridged", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "2026-01-01", to: "2026-02-01" } },
    {
      repository: {
        getBars: async () => [bar("2026-07-27", 100)],
        getBarsBetween: async (_s, _tf, from, to) => {
          assert.equal(from, "2026-01-01");
          assert.equal(to, "2026-02-01");
          return [bar("2026-01-05", 50), bar("2026-01-30", 60)];
        },
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.deepEqual(result.data.windowBars?.map((b) => b.t), ["2026-01-05", "2026-01-30"]);
  assert.equal(result.data.windowNote, undefined);
});

test("a window with no local coverage reports why rather than returning empty", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "1990-01-01", to: "1990-06-01" } },
    {
      repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.equal(result.data.windowBars, undefined);
  assert.match(result.data.windowNote ?? "", /1990-01-01/);
});

test("an inverted window is refused, not silently swapped", async () => {
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "2026-06-01", to: "2026-01-01" } },
    {
      repository: {
        getBars: async () => [bar("2026-07-27", 100)],
        getBarsBetween: async () => { throw new Error("must not be called for an inverted range"); },
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.equal(result.data.windowBars, undefined);
  assert.match(result.data.windowNote ?? "", /before/i);
});

test("an over-long window is truncated back from its end", async () => {
  let askedFrom = "";
  const result = await loadStockPriceData(
    { symbol: "AAPL", historyDays: 60, includeIntraday: false, window: { from: "1990-01-01", to: "2026-01-01" } },
    {
      repository: {
        getBars: async () => [bar("2026-07-27", 100)],
        getBarsBetween: async (_s, _tf, from) => { askedFrom = from; return [bar("2021-01-04", 5)]; },
      },
      snapshot: async () => SNAPSHOT,
      now: () => NOW,
    },
  );
  assert.ok(result.ok);
  assert.notEqual(askedFrom, "1990-01-01");
  assert.match(result.data.windowNote ?? "", /1260/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test 2>&1 | grep -E "window|# (pass|fail)"
```
Expected: FAIL — `window` 不是 `StockPriceQuery` 的属性，tsc 也会报错。

- [ ] **Step 3: 扩类型**

`src/data/stock/stockPriceData.ts`：

```ts
export type StockPriceQuery = {
  symbol: string;
  historyDays: number;
  includeIntraday: boolean;
  /** An absolute, inclusive date range, independent of `historyDays`. The two
   *  have different anchors — trailing-from-today versus fixed — so they are not
   *  two spellings of one thing, and both may be present. */
  window?: { from: string; to: string };
};
```

`StockPriceData` 加两个可选字段（在 `staleness` 之前）：

```ts
  /** Bars for the requested `window`, unabridged. Absent when the range could
   *  not be served; `windowNote` then says why. */
  windowBars?: DailyBar[];
  /** Present only when the requested window could not be served as asked. */
  windowNote?: string;
```

- [ ] **Step 4: 装配**

在 `loadStockPriceData` 里，`intradayBars` 那段之后、`return` 之前插入。`MAX_RANGE_DAYS` 从 `./stockChartData.ts` import：

```ts
  let windowBars: DailyBar[] | undefined;
  let windowNote: string | undefined;
  if (query.window) {
    const { from, to } = query.window;
    if (from > to) {
      // Not swapped: an inverted range is a mistake upstream, and silently
      // fixing it hides that the model asked for something it did not mean.
      windowNote = `The window was ignored: its start (${from}) is after its end (${to}).`;
    } else {
      const capped = capWindowStart(from, to);
      if (capped !== from) {
        windowNote = `The window was truncated to the ${MAX_RANGE_DAYS} calendar days before ${to} (from ${capped}).`;
      }
      try {
        // `repository` is already resolved at the top of loadStockPriceData
        // (stockPriceData.ts:93) — do NOT re-resolve it here.
        const bars = (await repository?.getBarsBetween(query.symbol, "1Day", capped, to)) ?? [];
        if (bars.length > 0) windowBars = bars;
        else {
          windowNote = `No stored bars fall in ${capped}..${to} for ${query.symbol}.`;
        }
      } catch {
        windowNote = `The window ${capped}..${to} could not be read.`;
      }
    }
  }
```

`capWindowStart` 放在文件里 `pct` 附近：

```ts
/** Pull a window's start forward so it spans at most MAX_RANGE_DAYS calendar
 *  days back from its end. Calendar days, not trading days: the cap exists to
 *  bound how much gets read into memory, and converting to trading days here
 *  would need a market calendar for no gain. */
function capWindowStart(from: string, to: string): string {
  const end = new Date(`${to}T00:00:00Z`);
  const earliest = new Date(end);
  earliest.setUTCDate(earliest.getUTCDate() - MAX_RANGE_DAYS);
  const earliestIso = earliest.toISOString().slice(0, 10);
  return from < earliestIso ? earliestIso : from;
}
```

在返回对象里带上：

```ts
      ...(windowBars ? { windowBars } : {}),
      ...(windowNote ? { windowNote } : {}),
```

- [ ] **Step 5: 跑数据层测试**

```bash
pnpm test 2>&1 | grep -E "stockPriceData|# (pass|fail)" && npx tsc --noEmit
```
Expected: 4 个新用例 PASS。

- [ ] **Step 6: 接工具层 inputSchema**

`mcp_tools/stock/getStockPriceTool.ts` 的 `inputSchema.properties` 加：

```ts
        window: {
          type: "object",
          properties: {
            from: { type: "string", description: "Inclusive start, YYYY-MM-DD." },
            to: { type: "string", description: "Inclusive end, YYYY-MM-DD." },
          },
          required: ["from", "to"],
          description:
            "An absolute date range to look at, independent of historyDays. Use this whenever the question names a past date or period — it is far cheaper and more precise than widening historyDays and searching the result yourself. Returns the same condensed shape as `daily`, at full per-day resolution for ranges up to about 120 trading days.",
        },
```

- [ ] **Step 7: 接工具层 execute 与 `toJsonData`**

在 `execute` 里解析（放在 `historyDays` 之后）：

```ts
      const rawWindow = input["window"];
      const window =
        rawWindow !== null && typeof rawWindow === "object" && !Array.isArray(rawWindow)
          && typeof (rawWindow as Record<string, unknown>)["from"] === "string"
          && typeof (rawWindow as Record<string, unknown>)["to"] === "string"
          ? {
              from: (rawWindow as Record<string, string>)["from"]!,
              to: (rawWindow as Record<string, string>)["to"]!,
            }
          : undefined;
```

传进 `loadStockPriceData`：

```ts
        { symbol, historyDays, includeIntraday: input["includeIntraday"] === true, ...(window ? { window } : {}) },
```

`toJsonData` 里，在 `daily` 之后加：

```ts
    // Same three-part shape as `daily`, so the prompt's explanation of
    // recentBars / trend / stats covers both fields.
    ...(data.windowBars
      ? { window: condenseBars(data.windowBars, { keepTail: WINDOW_KEEP_TAIL }) as unknown as JsonObject }
      : {}),
    ...(data.windowNote ? { windowNote: data.windowNote } : {}),
```

并在常量区加：

```ts
/** Raw bars kept at the tail of an explicit window. Larger than `daily`'s seven:
 *  a range the user named is usually itself the subject, not a backdrop for
 *  "how has it been lately". */
const WINDOW_KEEP_TAIL = 30;
```

- [ ] **Step 8: 写工具层测试**

`mcp_tools/stock/__tests__/getStockPriceTool.test.ts` 追加：

```ts
test("a window under the tail budget comes back entirely raw", async () => {
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async () => [bar("2026-07-27", 100)],
      getBarsBetween: async () => [bar("2026-01-05", 50), bar("2026-01-06", 55)],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute(
    { symbol: "AAPL", window: { from: "2026-01-01", to: "2026-01-10" } },
    { sessionId: "s" },
  );
  const data = result.generation_context!.data as Record<string, unknown>;
  const window = data["window"] as { recentBars: unknown[]; trend?: unknown };
  assert.equal(window.recentBars.length, 2);
  assert.equal(window.trend, undefined);
});

test("a window keeps every day distinct up to the trend budget", async () => {
  // 120 head bars + 30 tail = 150, so bucketDays stays 1 and every trading day
  // keeps its own exact close — this is what makes "what did it close at on
  // 2026-01-30" answerable from a window rather than from a thousand raw bars.
  const bars = Array.from({ length: 150 }, (_, i) =>
    bar(`2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, 100 + i));
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => bars },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute(
    { symbol: "AAPL", window: { from: "2026-01-01", to: "2026-06-01" } },
    { sessionId: "s" },
  );
  const window = (result.generation_context!.data as Record<string, unknown>)["window"] as {
    trend?: { bucketDays: number; t: string[] };
  };
  assert.equal(window.trend?.bucketDays, 1, "every trading day must keep its own exact close");
  assert.equal(window.trend?.t.length, 120);
});

test("daily and window coexist without interfering", async () => {
  const tool = createGetStockPriceTool({
    repository: {
      getBars: async () => [bar("2026-07-27", 100)],
      getBarsBetween: async () => [bar("2026-01-05", 50)],
    },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute(
    { symbol: "AAPL", historyDays: 60, window: { from: "2026-01-01", to: "2026-01-10" } },
    { sessionId: "s" },
  );
  const data = result.generation_context!.data as Record<string, unknown>;
  assert.ok(data["daily"]);
  assert.ok(data["window"]);
});
```

- [ ] **Step 9: 跑测试并 commit**

```bash
pnpm test 2>&1 | tail -10 && npx tsc --noEmit
git add src/data/stock/stockPriceData.ts src/data/stock/__tests__/stockPriceData.test.ts \
        mcp_tools/stock/getStockPriceTool.ts mcp_tools/stock/__tests__/getStockPriceTool.test.ts
git commit -m "feat: give get_stock_price an absolute date window

historyDays is a trailing count anchored to today, so a question about a past
period could only be expressed as 'enough recent bars to reach it' — the
behaviour that produced 84KB task results. A window is answered in the same
condensed shape, at full per-day resolution for ranges up to about 120
trading days."
```

---

### Task 6: 改写 prompt 与 tool description

返回结构变了。`buildStockPricePrompt()` 现在说的是 "what the recent daily bars show about trend"——指向一个已不存在的字段。不改这里，模型会去找 `dailyBars`，找不到就退化成"数据不足"式的回答。

**Files:**
- Modify: `mcp_tools/stock/prompts.ts:18`
- Modify: `mcp_tools/stock/getStockPriceTool.ts:49-51`（tool description）
- Test: `mcp_tools/stock/__tests__/getStockPriceTool.test.ts`

**Interfaces:**
- Consumes: Task 3 与 Task 5 产出的字段名 `daily` / `intraday` / `window` / `windowNote` / `historyDaysNote`
- Produces: 无代码接口。产出的是模型的使用契约。

- [ ] **Step 1: 写失败测试**

```ts
test("the generation prompt names the condensed fields", async () => {
  const tool = createGetStockPriceTool({
    repository: { getBars: async () => [bar("2026-07-27", 100)], getBarsBetween: async () => [] },
    snapshot: async () => { throw new Error("no snapshot"); },
  });
  const result = await tool.execute({ symbol: "AAPL" }, { sessionId: "s" });
  const prompt = result.generation_context!.prompt!;
  for (const field of ["daily.recentBars", "daily.trend", "daily.stats"]) {
    assert.ok(prompt.includes(field), `prompt must explain ${field}`);
  }
  assert.ok(!prompt.includes("dailyBars"), "prompt must not name the removed field");
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test 2>&1 | grep -E "generation prompt|# (pass|fail)"
```
Expected: FAIL。

- [ ] **Step 3: 改写 `buildStockPricePrompt`**

`mcp_tools/stock/prompts.ts`，把这一行：

```ts
    `Cover: current price versus previous close, intraday range, volume, and what the recent daily bars show about trend.`,
```

替换为：

```ts
    `Cover: current price versus previous close, intraday range, volume, and trend.`,
    `The payload's bar data is condensed on purpose:`,
    `- daily.recentBars — the last 7 trading days, exact OHLCV. Quote these directly.`,
    `- daily.trend — earlier closes, downsampled. 't' and 'c' are parallel arrays: t[i] is the last trading day of bucket i and c[i] its close. Each bucket spans 'bucketDays' trading days. Use this for shape and direction, never as a per-day quote unless bucketDays is 1.`,
    `- daily.stats — exact derived figures over the whole history, including min/max with their dates, return, max drawdown and moving averages. These are computed, not estimated: quote them as given and do not recompute them yourself.`,
    `- window — present when an absolute date range was requested. Same three-part shape as daily, covering that range instead of the trailing history. Its stats.from and stats.to are the trading days actually returned, which may be narrower than the range asked for; quote dates from there, not from the request.`,
    `- windowNote / historyDaysNote — present only when a request could not be served as asked. State the limitation rather than answering as if it had been.`,
```

- [ ] **Step 4: 改写 tool description**

`mcp_tools/stock/getStockPriceTool.ts` 的 `description`：

```ts
    description:
      "Fetch live US stock quotes and condensed daily history for one ticker. You must pass the ticker in the symbol argument. Live quotes come from Alpaca; daily history is served from a local store that updates incrementally. History comes back as the last 7 exact bars, a downsampled close series for trend, and exact derived statistics (min/max with dates, return, max drawdown, moving averages) — do not recompute those yourself. To look at a specific past date or period, pass a `window`; do not widen `historyDays` to reach it.",
```

- [ ] **Step 5: 跑测试并 commit**

```bash
pnpm test 2>&1 | tail -10 && npx tsc --noEmit
git add mcp_tools/stock/prompts.ts mcp_tools/stock/getStockPriceTool.ts \
        mcp_tools/stock/__tests__/getStockPriceTool.test.ts
git commit -m "docs: teach the prompt and tool description the condensed shape

The generation prompt pointed at 'recent daily bars', a field that no longer
exists. The description now also steers the model to a window instead of a
wider historyDays, which is the habit that produced the oversized payloads."
```

---

### Task 7: 真实回归验证与体积复测

前六个任务全部有单测，但没有一个能回答"模型是否**用对了**新结构"。这个任务是人工的，且不可跳过——spec §10.1 和 §10.2 把它列为主要风险。

**Files:**
- 无代码改动。产出写入 `docs/superpowers/specs/2026-08-01-context-density-design.md` 的一个新章节。

**Interfaces:**
- Consumes: Task 1–6 的全部产出
- Produces: 实测数据，用于决定 Part 2 的范围

- [ ] **Step 1: 记录改前基线**

```bash
node --experimental-sqlite -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("data/sessions.sqlite",{readOnly:true});
for(const r of db.prepare(`SELECT kind, COUNT(*) n, SUM(LENGTH(payload_json)) bytes FROM session_events WHERE is_sidechain=0 GROUP BY kind ORDER BY bytes DESC`).all())
  console.log(String(r.kind).padEnd(20), String(r.n).padStart(5), String(r.bytes).padStart(9));
'
```

把输出记下来。这是 §1 那张表的当前值。

- [ ] **Step 2: 起服务**

```bash
pnpm dev
```
（若 5173 被占用，用 `--port 5200`；后端在 :3000。）

- [ ] **Step 3: 跑六个对照提问**

在一个**新建的 topic** 里逐个提问，每问一个记下答案里的数字是否正确、是否出现"数据不足"式退化：

| # | 提问 | 要验证的 |
|---|---|---|
| 1 | AAPL 现在多少钱 | 实时报价路径未受影响 |
| 2 | AAPL 这周走势如何 | 模型使用 `daily.recentBars`，逐日引用正确 |
| 3 | NVDA 过去一年的趋势和最大回撤 | 模型引用 `daily.stats` 而非自行计算；回撤数值与 stats 一致 |
| 4 | NVDA 在 2026 年 1 月 30 日收盘多少 | **模型是否选择了 `window` 而不是调大 `historyDays`** |
| 5 | 2026 年上半年 AAPL 怎么走的 | `window` 的 trend 被正确解读为形状 |
| 6 | 对比 AAPL 和 NVDA 今年以来的收益 | 两个 symbol 各一次调用，数字正确 |

第 4 题是关键——spec §10.2 指出模型的旧习惯是"调大 `historyDays` 自己找"，clamp 是硬约束但 description 是软引导。

- [ ] **Step 4: 检查模型实际选了什么参数**

```bash
node --experimental-sqlite -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("data/sessions.sqlite",{readOnly:true});
for(const r of db.prepare(`SELECT payload_json p FROM session_events WHERE kind='"'"'tool_use'"'"' ORDER BY sequence DESC LIMIT 12`).all()){
  const o=JSON.parse(r.p);
  if(o.name==="get_stock_price") console.log(JSON.stringify(o.input));
}'
```

第 4、5 题对应的调用应当出现 `window`。若仍是大 `historyDays`，说明 description 的引导不足——记录下来，这是需要迭代 prompt 的信号，不是实现缺陷。

- [ ] **Step 5: 复测体积**

重跑 Step 1 的命令。预期 `task_result` 的单条最大值从 173,266 降到 10,000 以下。

- [ ] **Step 6: 把结果写进 spec**

在 `docs/superpowers/specs/2026-08-01-context-density-design.md` 末尾追加一节：

```markdown
## 12. 落地实测（YYYY-MM-DD）

| kind | 改前字节 | 改后字节 |
|---|---|---|
| `task_result` | 446,481 | … |

单条 `task_result` 最大值：173,266 → …

六个对照提问的结果：…

第 4 题模型选择的参数：…

据此对 Part 2 的判断：…
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-08-01-context-density-design.md
git commit -m "docs: record the measured effect of the density change"
```

---

## Self-Review

**1. Spec 覆盖**

| Spec 章节 | 落在哪个 Task |
|---|---|
| §3 确定性，不用模型 | Task 2（全部为纯函数）+ Global Constraints |
| §4 `condenseBars` 签名、常量、行为、平行数组、统计量定义 | Task 2 |
| §5.0 案发现场 | Task 5 的任务说明 |
| §5.1–5.2 window 返回形状与精确性 | Task 5 Step 6–8（含 `bucketDays === 1` 的回归锁） |
| §5.3 边界（非交易日端点、无交集、部分越界、`from > to`、跨度上限、与 historyDays 共存） | Task 5 Step 1、Step 4、Step 8 |
| §5.4 `historyDays` clamp | Task 3 Step 5 |
| §5.5 `getBarsBetween` | Task 4 |
| §5.6 默认值 250 | Task 3 Step 3 |
| §5.7 两者都保留 | Task 5 Step 3 的类型注释 |
| §6.1 `toJsonData` 与字段改名 | Task 3 Step 4 |
| §6.2 `buildStockPricePrompt` | Task 6 Step 3 |
| §6.3 tool description | Task 6 Step 4 |
| §6.4 `task` 三层删除 | Task 1 |
| §7 类型与导出 | Task 2 Step 5、Task 5 Step 3 |
| §8 测试 | Task 2 Step 1、Task 4 Step 1、Task 5 Step 1/Step 8 |
| §9 体积预期 | Task 7 Step 5 |
| §10 风险 | Task 7 |

**已知偏离，需要执行者注意：**

- Spec §5.3 说"`from` 向后取最近一个交易日，`to` 向前取最近一个交易日"。计划里没有为此写显式的交易日历解析——`getBarsBetween` 用 `t >= from && t <= to` 过滤本地已存的 bar，非交易日的端点天然落空，效果等价且不需要市场日历。`stats.from` / `stats.to` 反映实际返回的首尾，满足 spec 对"模型能看出自己拿到的是哪一段"的要求。
- Spec §5.3 的跨度上限用 `MAX_RANGE_DAYS` 表述为交易日；计划里 `capWindowStart` 按**日历日**截断（注释已说明）。该上限的目的是限制读入内存的量，按日历日更严格，且不需要市场日历。

**2. Placeholder 扫描**：无 TBD / TODO / "similar to Task N" / 无代码的代码步骤。Task 3 Step 1 的测试里显式标注了"本任务先删掉 `getBarsBetween` 那行，Task 4 再统一加"，避免执行者撞上 TypeScript 的多余属性检查。

**3. 类型一致性**：`condenseBars` / `BarDigest` / `BarStats` 在 Task 2 定义，Task 3、Task 5 按同名同签名使用。`getBarsBetween(symbol, timeframe, from, to)` 在 Task 4 定义，Task 5 按同签名调用。`windowBars` / `windowNote` 在 Task 5 Step 3 定义，Step 4、Step 7 使用。字段名 `daily` / `intraday` / `window` / `windowNote` / `historyDaysNote` 全程一致。

**4. 一处需要执行者判断的地方**：Task 4 Step 3 是对 `getBars` 的重构（抽出 `ensureFresh`）。现有 `barRepository.test.ts` 的全部用例是这次重构的回归锁——**一个都不能改**。如果重构后有既有用例失败，那是重构错了，不是测试过时了。
