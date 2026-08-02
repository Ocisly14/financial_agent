---
title: 上下文信息密度 Part 1 — 行情数据源头截断 — 设计 spec
date: 2026-08-01
status: spec
---

**Status:** Spec
**Date:** 2026-08-01
**Author:** victor530914@gmail.com (with Claude)
**Scope:** 新增 `src/data/stock/barDigest.ts`（纯函数）；`BarRepository` 增加 `getBarsBetween()`；改写 `mcp_tools/stock/getStockPriceTool.ts` 的 `toJsonData()` 与 `inputSchema`；更新 `mcp_tools/stock/prompts.ts`；删除死掉的 `task` 工具入参三层（`getStockPriceTool.ts` + `strategyTools.ts` 的声明与 `required`，以及 `src/framework/subagent.ts:314` 的注入）。不改 orchestrator / dispatcher 协议，不改 subagent 的其余部分，不改 `contextCompaction.ts`，不改 `BarStore` 接口，不改前端任何文件，不加 DB 表、不改 SQL。

---

## 1. 背景：95% 的上下文体积来自一个字段

对 dev 库 `data/sessions.sqlite` 全部非 sidechain 事件按 kind 统计：

| kind | 条数 | 字节 | 占比 |
|---|---|---|---|
| `task_result` | 6 | 446,481 | **95.3%** |
| `reply` | 14 | 14,720 | 3.1% |
| `tool_result` | 4 | 4,134 | 0.9% |
| `dispatch` | 6 | 1,463 | 0.3% |
| `user_message` | 6 | 730 | 0.16% |

拆开最大的一条 `task_result`（173,266 字节）：

```
generation_context.data.tool_outputs[0].data   84,729   ← get_stock_price / NVDA
    dailyBars: array[1000]                     84,426   ← 占该条 99.6%
    其余 13 个标量字段                             ~300
generation_context.data.tool_outputs[1].data   86,578   ← get_stock_price / AAPL
generation_context.prompt                       1,034
summary                                           234
visualizations                                    105
```

**一次 `get_stock_price` 往 prompt 里灌 1000 根日线 ≈ 21k token。两个 symbol 一轮 ≈ 43k token，占 200k 窗口的 21%。**

同一条记录里 12 个 `tool_outputs` 只有 10 个唯一，22,808 字节是逐字节完全重复。

（样本较小：6 条 `task_result`，会话均为单轮。比例是结构性的，可信；跨轮累积量未测。）

### 这个体积不该产生

`generation_context.data` 只有一个消费者：orchestrator 的 prompt。

- 前端图表走 `visualizations`（105 字节的引用 `[{"type":"stock_price","symbol":"NVDA","range":"1D"}]`），由前端自行取数、用 SVG 渲染。`src/framework/types.ts:81` 明确注明 `Structured UI-only chart sources; excluded from generation_context`。
- `src/infra/events/sseProjector.ts` 只从 `gc.data.tool_outputs` 里筛 `create_strategy`，不读行情数据。
- `src/framework/citationSources.ts` 只读 `gc.data.results`（web search），不读行情数据。

也就是说，那 1000 根 bar 从一开始就是**只为了给模型看而存在的，而模型看不了 1000 根 bar**。

产生它的现场是 `mcp_tools/stock/getStockPriceTool.ts` 的 `toJsonData()`：

```ts
dailyBars: data.dailyBars.map((bar) => ({ ...bar })),
```

原样透传。因此修复点在源头，而不是事后压缩：不产生就不用压，历史事件里也不会留下死重。

## 2. 目标

在**不降低模型回答精度**的前提下，把行情工具注入 prompt 的体积降两个数量级，并且让信息密度上升——模型拿到的应该是它真正会用的东西，而不是它得先做算术才能用的东西。

判据是信息密度，不是压缩率：每 token 承载多少后续轮次真会用到的信息。

### 非目标

- **不做图像注入。** `src/infra/llm/provider.ts:10` 的消息类型是 `content: string`，三个 provider 适配器（Anthropic / Google / Vertex）全部只传纯文本；系统里也不存在任何服务端渲染的图表——图是前端拿 `visualizations` 引用自己画的。要注入图像得同时改造消息类型链路和新建 headless 渲染。而且模型从折线图像素里读不出精确数值，这与 §5 的反编造规则直接冲突。趋势用数值序列表达更准也更便宜。若仍需要图像通道，另立 spec。
- **不改 compaction（Part 2）。** 现有 `contextCompaction.ts` 有三个已知问题（压缩对象反了、`preservedData` 无限追加原始 `gc.data`、`restore()` 不按 `summarizedThroughTurn` 重放导致重启后摘要与原文双份注入）。本 spec 落地后 95% 的体积在源头消失，Part 2 的紧迫性会掉一个数量级，应在重新测量真实占比后再定范围。
- **不改前端。** `visualizations` 通道不动，图表渲染完全不受影响。
- **不动 `stock_chart_data`。** 那条链路服务前端画图，需要完整序列。
- **不做跨轮去重。** 属于 Part 2。

## 3. 核心决策：确定性降采样，不用模型

压缩数值序列**必须是纯代码**，不能交给 LLM。

`src/agent/prompts/orchestratorPrompt.ts:28` 规定：最终答案里每个数字必须来自 task result 的 `generation_context` data，不许编造。让模型去总结一个千元素数值数组，正是幻觉概率最高的场景——它会产出看起来合理的错误统计量，而这些错误值随后会被当作"来自 generation_context"引用进答案。

因此本 spec 的全部变换是纯函数：确定、幂等、可单测、无网络、无模型调用。

## 4. `condenseBars` — 新增纯函数

新文件 `src/data/stock/barDigest.ts`。

### 4.1 签名

```ts
import type { DailyBar } from "./alpacaClient.ts";

export type BarDigest = {
  /** 尾部原始 bar，逐根精确，可被模型直接引用。 */
  recentBars: DailyBar[];
  /** 更早部分的降采样收盘价序列。bar 数不超过 keepTail 时省略。 */
  trend?: {
    /** 每个桶的最后一个交易日。与 `c` 逐位对应。 */
    t: string[];
    /** 每个桶的收盘价。与 `t` 逐位对应。 */
    c: number[];
    /** 每桶包含多少个交易日。仅供模型判断粒度。 */
    bucketDays: number;
  };
  /** 覆盖全部输入 bar（含 recentBars）的精确派生统计。 */
  stats?: BarStats;
};

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

export function condenseBars(
  bars: readonly DailyBar[],
  options?: { keepTail?: number; maxTrendPoints?: number },
): BarDigest;
```

### 4.2 常量

```ts
/** 尾部保留的原始 bar 数。一周交易日。这些是模型唯一会逐根引用的部分——
 *  "今天""昨天""这周"这类问题必须精确到根，再往前就是趋势问题了。 */
const DEFAULT_KEEP_TAIL = 7;

/** 趋势序列的点数上限。120 个点足以让任何时间跨度的形状可辨，
 *  而两个平行数组合计约 2.4KB —— 对比原始 1000 根 bar 的 84KB。 */
const DEFAULT_MAX_TREND_POINTS = 120;
```

### 4.3 行为

1. `bars` 为空 → `{ recentBars: [] }`，无 `trend`、无 `stats`。
2. `bars.length <= keepTail` → `{ recentBars: [...bars], stats }`，无 `trend`。数据本来就短，没有可降采样的部分。
3. 否则：
   - `recentBars` = 末尾 `keepTail` 根，原样。
   - `head` = 其余部分（`bars.slice(0, -keepTail)`）。
   - `bucketDays = Math.ceil(head.length / maxTrendPoints)`（至少 1）。
   - 按 `bucketDays` 从**头部起**顺序分桶；每桶取**最后一根** bar 的 `t` 和 `c`。最后一桶不足也照样出一个点。
   - `stats` 基于**全部** `bars` 计算，不是只基于 head。

### 4.4 为什么是平行数组

`[{t,c},{t,c},…]` 每点重复两个 key 名；`{t:[…], c:[…]}` 只写一次。120 个点从约 3.1KB 降到约 2.4KB，且 JSON 结构更浅。日期必须逐点保留而不能用 `from` + 步长推算——交易日不是日历均匀的，推算出的日期会错，而错的日期会被当作事实引用。

### 4.5 统计量定义（实现必须逐条对齐）

全部基于收盘价 `c` 序列，除非另有说明。

| 字段 | 定义 |
|---|---|
| `from` / `to` | `bars[0].t` / `bars[at-1].t` |
| `count` | `bars.length` |
| `first` / `last` | `bars[0].c` / `bars[at-1].c` |
| `min` / `max` | 收盘价极值及其**首次出现**的交易日 |
| `mean` | 收盘价算术平均 |
| `stdev` | 总体标准差（除以 `n`，非 `n-1`）——这是完整已知序列，不是抽样 |
| `returnPct` | `(last - first) / first * 100` |
| `maxDrawdownPct` | 收盘价序列上 `max(peak - trough) / peak * 100`，peak 在 trough 之前。无回撤时为 `0` |
| `sma20` / `sma50` | 末 20 / 50 根收盘价均值；bar 数不足则为 `null` |

全部数值四舍五入到 2 位小数（`returnPct` / `maxDrawdownPct` / 价格类均同）。`first === 0` 时 `returnPct` 为 `0`，不产生 `Infinity`。

`sma20` / `sma50` 是明确要给的——模型自己在 1000 个数里求均值既贵又易错，而这是它最常需要的派生量。

## 5. `window` — 绝对日期区间

促成本 spec 的那条 173KB 记录，模型拉 1000 根日线是为了拿 **2026-01-30 一天的收盘价**。统计量和降采样都替代不了这个需求：`historyDays` 只能表达"最近 N 个交易日"，锚点永远是今天，够不到过去的某一段。

### 5.0 案发现场

这不是推测模型"可能"会怎么用参数。dev 库里 §1 那条 173KB 记录对应的 `tool_use` 事件原文：

```json
{"name":"get_stock_price","input":{
  "task":"Fetch historical price data for AAPL and NVDA from 2026-01-31 to 2026-07-31.
          Calculate the total percentage return for both stocks over this period
          to determine which one outperformed.",
  "symbol":"AAPL",
  "historyDays":500}}
```

模型在 `task` 里**用自己的话写清楚了它要的是 2026-01-31 到 2026-07-31 这个绝对区间**，然后因为参数集里没有任何东西能表达区间，只好翻译成 `historyDays: 500`，拉回 500 根 bar 自己算收益率。两个 symbol，就是那 173KB。

两个结论同时落地：`window` 是模型已经在表达的需求（§5）；而它把真实意图写进了一个没有任何消费者的参数（§6.4）。

给 `get_stock_price` 增加参数：

```ts
window: {
  type: "object",
  properties: {
    from: { type: "string", description: "Inclusive start, YYYY-MM-DD." },
    to: { type: "string", description: "Inclusive end, YYYY-MM-DD." },
  },
  required: ["from", "to"],
  description:
    "An absolute date range to look at, independent of `historyDays`. Use this whenever the question names a past date or period — it is far cheaper and more precise than requesting a long trailing history and searching it yourself. Returns the same condensed shape as `daily`, at full per-day resolution for ranges up to about 120 trading days.",
},
```

### 5.1 返回形状

**与 `daily` 完全相同的 `BarDigest`**，走同一个函数：

```ts
window: condenseBars(windowBars, { keepTail: WINDOW_KEEP_TAIL }),
```

```ts
/** 显式窗口保留的原始尾部。比 daily 的 7 大：一个被点名的区间，
 *  用户问的通常就是这段本身，而不是"最近怎么样"。 */
const WINDOW_KEEP_TAIL = 30;
```

不为窗口引入第二种结构，是本节最重要的决定。模型只需要理解一种形状；`prompts.ts` 里对 `recentBars` / `trend` / `stats` 的解释同时适用于两个字段。

### 5.2 为什么这仍然精确

窗口跨度在约 **127 个交易日**以内时，head 部分 `bucketDays = Math.ceil(97/120) = 1` —— 每个交易日都占一个 trend 点，`t[i]` 和 `c[i]` 是该日的真实日期与真实收盘价，不是估算，不是插值。

所以「2026-01-30 收盘多少」传 `{from:"2026-01-01", to:"2026-02-10"}` 拿回的是精确值。超过约 127 天才开始分桶，而那时提问已经是"上半年怎么走的"这类形状问题，且 `stats.min` / `stats.max` 仍带精确日期兜住极值。

### 5.3 边界

- **不是交易日的端点**：`from` 向后取最近一个交易日，`to` 向前取最近一个交易日。解析后的实际区间写进 `stats.from` / `stats.to`，模型据此可以看出自己拿到的是哪一段。
- **区间与本地覆盖范围无交集** → 省略整个 `window` 字段，并置 `windowNote` 说明请求区间与可得范围。**不静默返回空**：模型据此知道数据不可得，而不是以为自己没要过。
- **部分越界** → 返回交集，`stats.from` / `stats.to` 自然反映实际得到的范围，无需额外说明。
- **`from > to`** → 视为无效输入，省略 `window` 并在 `windowNote` 说明。不做静默交换。
- **跨度上限** `MAX_RANGE_DAYS`（沿用 `stockChartData.ts` 已有常量），超出则截断到 `to` 往前 `MAX_RANGE_DAYS`，并在 `windowNote` 说明。
- `window` 与 `historyDays` **可以共存且互不干扰**：前者是绝对区间，出 `window` 字段；后者是尾随窗口，出 `daily` 字段。两者锚点不同，不是同一件事的两种写法。

### 5.4 同时必须给 `historyDays` 加上限

`window` 之所以有必要，是因为 `historyDays` 表达不了绝对日期——它是一个纯计数，锚点永远是今天：

```ts
// stockPriceData.ts:76
dailyBars = await repository.getBars(query.symbol, "1Day", query.historyDays);
```

`BarRepository.getBars(symbol, timeframe, count)` 的签名里没有日期。模型要够到 2026-01-30，唯一的表达方式就是把 N 调大到盖住它——它算出 1000，就传了 1000。**§1 的 84KB 是这个参数设计逼出来的，不是模型的问题。**

而工具层对它没有任何上限：

```ts
// getStockPriceTool.ts:93-96
typeof input["historyDays"] === "number" && input["historyDays"] > 0
  ? Math.floor(input["historyDays"])
  : DEFAULT_HISTORY_DAYS
```

项目里已有 `parseRangeDays()`（`src/data/stock/stockChartData.ts`）做 `MIN_RANGE_DAYS` / `MAX_RANGE_DAYS` 的严格校验，其注释明确写了 callers 应当 reject 而非 substitute——但那套只接在 charts 链路上，`get_stock_price` 没用。

因此本 spec 必须一并：把 `historyDays` clamp 到 `MAX_RANGE_DAYS`，被 clamp 时在 `windowNote` 同级的说明字段里告知模型，并在 description 里指明"需要更早的数据请用 `window`，不要调大 `historyDays`"。否则加了 `window` 也没用，模型仍可绕回老路。

注意 clamp 的**作用变了**：见 §5.6，压缩之后它不再控制 prompt 体积，只是资源保护（防止 `getBars` 把巨量行读进内存、防止触发上游大回填）。

### 5.6 默认值：`historyDays` 从 60 提到 250

`condenseBars` 之后，`trend` 封顶 `DEFAULT_MAX_TREND_POINTS` 点，超过约 127 个交易日再往前要多少天都不再增加体积：

| `historyDays` | 改前 | 改后 |
|---|---|---|
| 60 | ~5KB | ~1.5KB |
| 250 | ~21KB | ~2.4KB |
| 1000 | ~84KB | ~2.4KB |

现有默认值 60（约三个月）是被体积逼出来的折中。改后 **250（约一年）只比 60 多约 1KB 且封顶**，而模型能看到的形状多得多——年内高低点、季度级趋势、完整回撤，60 天给不了这些。

因此 `DEFAULT_HISTORY_DAYS` 从 `60` 改为 `250`。这是本 spec 里唯一一处**主动增加**注入量的改动，理由是密度：多花的 1KB 换来的是一整年的形状，而不是更多的重复。

### 5.7 `window` 与 `historyDays` 为什么都要保留

两者不是同一件事的两种写法：

- `historyDays` 表达"最近 N 个交易日"，**不需要日历算术**。用 `window` 表达同一件事，模型得自己从今天往回数交易日、跳过周末与假期——这正是它算错的地方。
- `historyDays` 带默认值，只传 `symbol` 的裸调用仍能拿回一整年的趋势。
- `window` 表达"过去的某一段"，锚点是绝对日期，`historyDays` 根本够不到。

两者输出到不同字段（`daily` / `window`），可以共存（§5.3 末条）。

### 5.5 数据层：`getBarsBetween`

`BarRepository` 现有接口只有 `getBars(symbol, timeframe, count)` —— 只能按"最近 N 根"取。新增：

```ts
getBarsBetween(symbol: string, timeframe: Timeframe, from: string, to: string): Promise<DailyBar[]>;
```

实现委托给 `BarStore` 已有的 `getBarsOnOrAfter(symbol, timeframe, from)`，再按 `to` 过滤。**`BarStore` 接口不变，SQL 不变，schema 不变。**

新鲜度处理与 `getBars` 一致：先走 coverage 检查与增量回填，再读本地库。`to` 早于今天时不需要触发回填（历史日 K 不可变），可直接读——但为保持与 `getBars` 行为一致、避免两条分叉的新鲜度逻辑，实现应复用同一段前置逻辑，不做这项优化。

## 6. 接入点

### 6.1 `toJsonData()`

`mcp_tools/stock/getStockPriceTool.ts`。现在是：

```ts
dailyBars: data.dailyBars.map((bar) => ({ ...bar })),
...(data.intradayBars ? { intradayBars: data.intradayBars.map((bar) => ({ ...bar })) } : {}),
```

改为：

```ts
daily: condenseBars(data.dailyBars),
...(data.intradayBars
  ? { intraday: condenseBars(data.intradayBars, { keepTail: 30, maxTrendPoints: 60 }) }
  : {}),
```

字段名从 `dailyBars` / `intradayBars` 改成 `daily` / `intraday`：形状变了，沿用旧名会让模型按旧结构去索引 `dailyBars[0].o`。改名让它必然看到新结构。

分钟线的参数按它当前的真实语义定：`01eabb7` 之后 `intradayBars` 不再是"直连 API 拉今天"，而是 `latestSession(repository.getBars(symbol, "1Min", 960))` —— 本地 store 里最近**一个完整交易日**的分钟线，含盘前盘后最多约 960 根（04:00–20:00 ET）。

`keepTail: 15` 是"最近一刻钟逐根"：需要逐分钟精度的问题只有"此刻在动吗"，15 分钟足够，而分钟线是全系统信息密度最低的数据。`maxTrendPoints: 60` 让常规时段约 6 分钟一桶、盘前盘后约 16 分钟一桶，足以看出当日形状。合计约 2.8KB。

注意分钟线的 `t` 是完整 ISO 时间戳而非 `"2026-07-27"`，所以 `trend.t` 每点比日线贵约一倍——这已经计入上面的估算。

13 个标量字段（`price` / `dayOpen` / `prevClose` / …）全部原样保留——它们合计约 300 字节，且是密度最高的部分。

### 6.2 `buildStockPricePrompt()`

`mcp_tools/stock/prompts.ts` 现有这句：

> `Cover: current price versus previous close, intraday range, volume, and what the recent daily bars show about trend.`

必须改写，明确新字段各自的含义与用法，否则模型会去找已不存在的 `dailyBars`：

```
Cover: current price versus previous close, intraday range, volume, and trend.
The payload's `daily` field is condensed on purpose:
- `daily.recentBars` — the last 7 trading days, exact OHLCV. Quote these directly.
- `daily.trend` — earlier closes, downsampled. `t` and `c` are parallel arrays;
  `t[i]` is the last trading day of bucket i and `c[i]` its close. Each bucket
  spans `bucketDays` trading days. Use this for shape and direction, never as a
  per-day quote.
- `daily.stats` — exact derived figures over the whole history. These are computed,
  not estimated: quote them as given and do not recompute them yourself.
- `window` — present when an absolute date range was requested. Same three-part
  shape as `daily`, covering that range instead of the trailing history. Its
  `stats.from` / `stats.to` are the trading days actually returned, which may be
  narrower than the range asked for — quote dates from there, not from the request.
- `windowNote` — present only when the requested range could not be served as
  asked. State the limitation rather than answering as if the range was covered.
```

倒数第二句是硬要求：`stats.from` / `stats.to` 与请求区间不同时必须按实际区间陈述，否则会出现"1月31日收盘 X"而实际是1月30日的错误。

### 6.3 工具 description

`get_stock_price` 的 description 现有 `...and recent daily bars for one ticker`，改为说明返回的是"最近 7 根原始 bar + 降采样趋势 + 精确统计"，并提示问到过去某个日期或时段时用 `window` 而不是调大 `historyDays`。模型的调用策略取决于它对返回内容的预期，description 不改会继续出现"拉 1000 天自己找"的行为。

## 6.4 删除 `task` 工具入参（三层全删）

工具入参 `task` 在三个层面上都没有消费者：

| 层 | 位置 | 状况 |
|---|---|---|
| inputSchema 声明 | `getStockPriceTool.ts:62`，`strategyTools.ts:41/208/256/299` | 被 `subagent.ts:129` 无条件过滤，模型看不见 |
| `required` 条目 | `strategyTools.ts` 四处 | 全代码库无 required 校验；`required` 仅用于 `subagent.ts:113-115` 给字段标 `*`，而那个循环遍历 `properties`，`task` 已被过滤，标不到任何东西 |
| 注入的值 | `subagent.ts:314` | 15 个 `execute` 函数无一读取 |

```ts
// subagent.ts:314 — 无条件注入
const callInput: JsonObject = { task: input.request.task, ...call.input };
// subagent.ts:129 — 无条件对模型隐藏
const visible = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => k !== "task"));
```

三层一起删，包括 `subagent.ts:314` 的注入。只删声明会留下一个仍在注入、仍无人读的值，把问题从"死声明"变成"死数据"。

**安全性**：`subagent.ts:197` 与 `:283` 用的是 `input.request.task`（subagent 自己的请求对象，也是 `gc.data.task` 的来源），与工具入参 `callInput.task` 是两个东西。删除 `:314` 不影响它们。

**不接线。** 让 `get_stock_price` 真正读取任务描述（例如让 `buildStockPricePrompt()` 据此裁剪要写哪一段）是加功能，与本 spec 的信息密度目标无关，另议。

## 7. 类型与导出

- `BarDigest` / `BarStats` / `condenseBars` 从 `src/data/stock/index.ts` 导出，与现有导出风格一致。
- `StockPriceQuery` 增加可选字段 `window?: { from: string; to: string }`；`StockPriceData` 增加可选字段 `windowBars?: DailyBar[]` 与 `windowNote?: string`。
- 数据层返回的 `dailyBars` / `windowBars` **保持无损**——`condenseBars` 只作用在 MCP 适配层的 `toJsonData()` 上。这样数据层不受 prompt 的取舍约束，将来其他消费者拿到的仍是完整序列。

## 8. 测试

新增 `src/data/stock/__tests__/barDigest.test.ts`（`node:test` + `node:assert/strict`，与现有测试一致）：

| 用例 | 断言 |
|---|---|
| 空数组 | `recentBars` 为 `[]`，无 `trend`、无 `stats` |
| `length <= keepTail` | 全部进 `recentBars`，无 `trend`，`stats` 存在 |
| `length = keepTail + 1` | `trend` 恰好 1 个点，`bucketDays === 1` |
| 1000 根 | `recentBars.length === 7`；`trend.t.length === trend.c.length` 且 `<= 120`；`bucketDays === Math.ceil(993/120)` |
| 分桶取末根 | 构造已知序列，逐位核对 `trend.c` 取的是每桶最后一根的 `c` |
| `stats` 覆盖全序列 | `from`/`to`/`count` 对应输入首尾与长度，**不是** head 的首尾 |
| 已知序列的统计量 | `min`/`max`/`mean`/`stdev`/`returnPct`/`maxDrawdownPct` 逐个对拍手算值 |
| 单调上升序列 | `maxDrawdownPct === 0` |
| `first === 0` | `returnPct === 0`，非 `Infinity`/`NaN` |
| bar 数 < 20 / < 50 | `sma20` / `sma50` 为 `null` |
| 幂等 | 同一输入两次调用结果 `deepEqual` |

现有 `mcp_tools/stock/` 下针对 `get_stock_price` 的测试若断言了 `dailyBars` 字段，随改名一并更新。

`window` 单独一组用例（§5.3 每条边界各一个）：

| 用例 | 断言 |
|---|---|
| 端点非交易日 | `stats.from` / `stats.to` 是实际返回的交易日，且落在请求区间内 |
| 区间与覆盖范围无交集 | 无 `window` 字段，有 `windowNote` |
| 部分越界 | 返回交集，`stats.from` / `stats.to` 反映实际范围 |
| `from > to` | 无 `window` 字段，有 `windowNote`；**不**静默交换 |
| 跨度 > `MAX_RANGE_DAYS` | 截断到 `to` 往前 `MAX_RANGE_DAYS`，有 `windowNote` |
| ≤ 30 交易日 | 全部进 `window.recentBars`，无 `trend` |
| ~120 交易日 | `trend.bucketDays === 1`，head 每个交易日各占一点（这是 §5.2 精确性的回归锁） |
| `window` 与 `historyDays` 并存 | `daily` 与 `window` 同时存在且互不影响 |

`historyDays` clamp（§5.4）：超过 `MAX_RANGE_DAYS` 时被截断且有说明字段；等于上限时不产生说明。

`getBarsBetween` 单独一组用例，用现有的 in-memory store fixture（`src/data/stock/__tests__/inMemoryBarStore.ts`）。

## 9. 体积预期

以 §1 那条 173KB 记录为基准，同样两个 symbol × 1000 天：

| | 改前 | 改后（估算） |
|---|---|---|
| `recentBars` | — | 7 × ~70B ≈ 0.5KB |
| `trend` | — | 120 点平行数组 ≈ 2.4KB |
| `stats` | — | ≈ 0.4KB |
| `dailyBars` | 84.4KB | 0 |
| **单 symbol 合计** | **~84.7KB** | **~3.3KB** |
| 两 symbol task_result | 173KB | ~8KB |

约 21 倍。且模型不再需要自行计算均值、极值、回撤——这些以精确值直接给出。

## 10. 风险

1. **模型行为回归。** 返回结构变了，`prompts.ts` 和 tool description 的改写是否足以让模型正确使用新字段，只能实测。落地后必须跑一轮真实提问对照（至少覆盖：当前价格、近一周走势、一年趋势、指定日期收盘价、指定时段走势、两标的对比），确认答案里的数字仍然准确且没有出现"数据不足"式的退化。
2. **模型可能不用 `window`。** 它已有的策略是"调大 `historyDays` 自己找"，这个习惯只能靠 description 与 `historyDays` 的 clamp 一起纠正。§5.4 的 clamp 是硬约束，description 是软引导——两者缺一都会让老行为存活。回归测试里必须有一条"问过去某个具体日期"的用例，直接观察它选了哪个参数。
3. **降采样掩盖短期剧烈波动。** `bucketDays` 较大时，桶内的单日暴涨暴跌在 `trend` 里看不见。`stats.min` / `stats.max` 带日期，正是为了兜住这一点——极值永远精确可见。
4. **旧会话的历史事件不变。** 本 spec 只影响新产生的 `task_result`。已存的 84KB 记录仍会在 prompt 里出现，直到 Part 2 处理它们。

## 11. 交付顺序

0. 删除 `task` 工具入参三层（§6.4：5 处 inputSchema 声明、4 处 `required` 条目、`subagent.ts:314` 的注入）。纯删除，无逻辑变更，可先行合入
1. `barDigest.ts` + 测试（纯函数，无依赖，可独立完成并验证）
2. `toJsonData()` 接入 + 字段改名 + `historyDays` clamp 与新默认值 250（§5.4、§5.6）+ 现有测试更新
3. `BarRepository.getBarsBetween()` + 测试（§5.5）
4. `window` 参数、边界处理与 `windowNote` + 测试（§5.3、§8）
5. `prompts.ts` 与 tool description 改写（§6.2、§6.3）
6. 真实提问回归对照（§10.1、§10.2），测量改后实际占比，据此决定 Part 2 范围

第 1 步和第 2 步之后体积收益就已经全部到手（84KB → ~3KB）；第 3–5 步解决的是精度与参数表达力，也就是让模型**不必**再去要 1000 天。两段可以分开验证。
