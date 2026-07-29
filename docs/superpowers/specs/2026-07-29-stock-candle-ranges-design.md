---
title: StockChart 蜡烛图与 range 切换 — 设计 spec
date: 2026-07-29
status: spec
---

**Status:** Design (pending implementation)
**Date:** 2026-07-29
**Author:** victor530914@gmail.com (with Claude)
**Scope:** `StockChart` 由日线折线图改为蜡烛图，默认展示当日分时，并提供 1D/5D/1M/3M/1Y 五档 range 切换；`barStore` / `barRepository` / `alpacaClient` 增加 timeframe 维度；`CandleScope` 抽出配色主题；端点参数由 `bars` 改为 `range`。不改消息协议、不改 SSE、不改 `get_stock_price` 工具的对外行为。

**前置：** `docs/superpowers/specs/2026-07-28-inline-stock-chart-design.md`。那份 spec 的 §4（端点参数）与 §7（呈现）被本文替代，其余部分（嵌入机制、props 校验、流式渲染、可见性门控、历史消息时间错位）继续有效。两份合起来才是 `StockChart` 的完整设计。

---

## 1. 背景与目标

已实现的 `StockChart` 画的是近 60 个交易日的**日线收盘价折线**，末端追加一个实时价的点。它能用，但不是用户看盘时想要的东西：

- 默认视图是三个月的日线，而人打开一支股票最先想看的是**今天走成什么样**；
- 折线丢掉了开高低收，看不出当日的震荡幅度；
- 盘中时今天被画了两次——最后一根未收盘的日 K 加上追加的实时点，右端出现一小段几乎水平的冗余尾巴。

目标：**默认展示当日蜡烛图，并像股票软件一样可以点按钮切换区间。**

### 非目标

- 不做成交量副图。
- 不做拖拽平移与滚轮缩放。用户要的是按钮切 range，视口交互是另一个量级的东西（需要视口状态管理、边界加载、惯性），YAGNI。
- 不做技术指标叠加（均线、布林带等）。
- 不覆盖加密货币。crypto 有 Strategy Floor 自己的路径。

---

## 2. 数据层：一套机制，加一个维度

### 现有机制不动

`mcp_tools/stock/barRepository.ts:76-113` 已经是"首次全量回补、之后只补增量"的形状：

- 没有 coverage 记录 → 全量回补，写入 bars 与 coverage；
- 有记录且距 `lastCheckedAt` 不足 `freshnessMs` → 直接读 SQLite，不碰网络；
- 超过 → 只拉 `lastDate - OVERLAP_DAYS` 到今天这一段，upsert；
- 顺带比对重叠区间，`hasSplitDivergence` 发现拆股/分红导致的价格口径漂移就 `clearSymbol` 后整体重拉。

多 range **不引入第二套缓存机制**，只给这一套加一个 timeframe 维度。

### `alpacaClient`

`fetchDailyBars(symbol, from, to)` 与 `fetchIntradayBars(symbol, day)` 目前是两个把 timeframe 写死的函数（`1Day` / `1Min`）。合并为：

```ts
fetchBars(symbol: string, timeframe: Timeframe, from: string, to: string): Promise<Bar[]>
```

`Timeframe = "1Min" | "5Min" | "1Day"`。Alpaca 本来就是同一个 `/stocks/:symbol/bars` 端点、同一套分页与 `adjustment=all`，差别只是 `timeframe=` 的取值。原来两个函数改为薄封装保留——`get_stock_price` 工具仍在调用它们，本次不改工具。

日内 bar 的 `t` 是完整 ISO 时刻，日 K 的 `t` 是 `YYYY-MM-DD`。现有 `toBar(raw, dateOnly)` 已经处理了这个区别，按 timeframe 传 `dateOnly = (timeframe === "1Day")`。

### `barStore`

两张表各加一列，主键随之扩展：

```sql
stock_bars          PRIMARY KEY (symbol, t)  →  (symbol, timeframe, t)
stock_bar_coverage  PRIMARY KEY (symbol)     →  (symbol, timeframe)
```

SQLite 不能 `ALTER TABLE` 改主键，需要重建表。但这两张表是**纯缓存**——里面每一行都能从 Alpaca 重新拉回来，重建的代价只是每个 symbol 多一次回补请求。因此：**启动建表时检测到旧 schema（`stock_bars` 存在但无 `timeframe` 列）就 DROP 重建**，不写数据迁移脚本。这是刻意的选择：为一份可再生的缓存写迁移逻辑，维护成本高于收益。

`BarStore` 接口的每个方法都加 `timeframe` 参数。`Coverage` 类型加 `timeframe` 字段。

### `barRepository`

`getDailyBars(symbol, days)` → `getBars(symbol, timeframe, count)`。回补、增量、拆股检测的逻辑**一行不动**，只是把两个原本固定的构造参数改为按 timeframe 查表：

| Range | timeframe | 回补窗口 | 新鲜度窗口 | 典型根数 |
|---|---|---|---|---|
| 1D | 1Min | 当日 | 1 分钟 | ~390 |
| 5D | 5Min | 10 个交易日 | 5 分钟 | ~390 |
| 1M | 1Day | 5 年 | 30 分钟 | 21 |
| 3M | 1Day | 5 年 | 30 分钟 | 63 |
| 1Y | 1Day | 5 年 | 30 分钟 | 252 |

1M / 3M / 1Y **共用同一份日 K 数据**，只是 `count` 不同——不产生额外存储，也不产生额外的上游拉取。这是把 range 映射到 timeframe（而非各自一套数据）带来的直接好处。

`OVERLAP_DAYS` 对日内 timeframe 要换算成时间而非天数：增量窗口取 `lastBarTs` 往前一小段（分钟线取 5 分钟）以覆盖边界重叠，语义与日线的 overlap 一致。

### 分钟线的保留

1Min 的回补窗口是"当日"，意味着每个交易日首次请求会拉当天的分钟线并落库，隔天的旧分钟线留在库里不清理。单 symbol 单日约 390 行，体积可忽略，不做定期清理——真需要时 `clearSymbol` 已经存在。

---

## 3. 端点

```
GET /market/stocks/:symbol?range=1D|5D|1M|3M|1Y|none
```

`range=none` 取代原 spec 的 `bars=0`：只回报价、不含 candles，供 5 秒轮询的那条查询使用。理由不变——日 K 与分钟线盘中变化远慢于报价，高频那条不该反复搬运几百根 K 线。

其余取值返回报价 + 该区间的 candles。响应新增两个字段：

```jsonc
{
  "symbol": "AAPL",
  "quote": { /* 不变 */ },
  "session": "regular",
  "range": "1D",
  "timeframe": "1Min",
  "candles": [{ "t": "2026-07-29T13:31:00Z", "o": 340.4, "h": 340.9, "l": 340.2, "c": 340.8, "v": 12043 }],
  "staleness": null,
  "dataSource": "Alpaca (IEX feed)",
  "fetchedAtMs": 1785345344203
}
```

`timeframe` 必须回给前端——x 轴刻度格式（`13:31` 还是 `07-29`）由它决定，前端不该从 range 二次推导。

字段名由 `bars` 改为 `candles`：现在返回的是完整 OHLC 且渲染成蜡烛，`bars` 这个名字在前端语境里容易和成交量柱混淆。后端仓库层仍叫 bar，那是数据层的词。

**非法 `range` 退回 `1D`，不返回 400。** 与现有 `bars` 参数的处理一致：模型写歪一个可选参数不该让整块图表消失。symbol 校验、限流、`staleness`、404 / 502 / 429 的行为全部不变。

### 盘前、盘后与周末的 1D

当日尚无 bar（盘前早段、周末、假日）时，退回**最近一个有数据的交易日**的分时，而不是画一张空图。响应的 `staleness` 复用现有结构：`{ reason: "previous_session", asOf: "2026-07-28" }`。前端据此在头部标注那天的日期。

---

## 4. 组件

### `CandleScope` 抽出主题

`client/src/components/cex/CandleScope.tsx` 是一个 310 行、零依赖的手绘 canvas 蜡烛图，自带价格网格、实时标线、悬停十字线与 OHLC 读数，注释里已经写明"data-source-agnostic"。不引入 `chartjs-chart-financial` 之类的新依赖。

唯一的障碍是它硬编码了 Phosphor Desk 的深色配色（`COL` 常量）。把它提成可选 prop：

```ts
theme?: CandleTheme   // 缺省即现在的 Phosphor 配色
```

`strategy-floor` 的调用处不传，行为逐像素不变。绘制逻辑、十字线、OHLC 读数原封不动。`StockChart` 传一套跟随聊天主题的浅色配色。

### `StockChart` 结构

```
┌─────────────────────────────────────────────┐
│ AAPL  $342.26  +0.66%  [盘中]   Alpaca (IEX) │
│ 实时数据 · 消息发于 3 天前                     │
│ [1D] 5D  1M  3M  1Y                          │
│ ┌─────────────────────────────────────────┐ │
│ │            CandleScope                  │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

当前 range 存在组件的 `useState`，初值来自标签的 `range` prop。用户点按钮就地切换——不跨消息共享、不写 localStorage、不进 URL。刷新页面回到标签指定的初值。

容器仍然一律用 `<span className="block">`，理由见前一份 spec §2（模型可能忘了在标签前后留空行，那样 `<div>` 会落进 `<p>` 变成非法嵌套）。

### 标签语法

```
<StockChart symbol="AAPL" />            → 开在 1D
<StockChart symbol="AAPL" range="1Y" /> → 开在 1Y
<StockChart symbol="AAPL" range="7D" /> → 非法，退回 1D
```

`days` prop **直接删除**，不做兼容——前一份 spec 的实现尚未提交，没有存量。

`parseStockChartProps` 的返回类型由 `{ symbol, days }` 改为 `{ symbol, range }`，`range` 校验为五个字面量之一，不匹配则取 `1D`。symbol 的校验规则不变。

orchestrator 提示词相应更新：说明 `range` 可选、缺省 1D、五个合法值，并给出何时该指定（用户问"过去一年表现如何"就写 `range="1Y"`，问"今天"用缺省）。

### 轮询

两条查询的分工不变：

- **报价查询** `["stock-quote", symbol]` —— `range=none`，恒按 session 轮询（5s / 30s / 停），驱动头部那一行。
- **candles 查询** `["stock-candles", symbol, range]` —— 1D 与 5D 按 session 轮询（新分钟线要追进来）；1M / 3M / 1Y 的 `staleTime` 设 5 分钟，只在切换 range 时取。

candles 查询的响应里也带 `quote`（端点对所有 `range` 都返回报价），但头部**只读报价查询的那一份**，避免两条查询的价格在不同时刻抵达时头部数字来回跳。candles 响应的 `quote` 仅用于兜底：报价查询尚未返回时先拿它显示。

`pollIntervalForSession` 保留。新增一个纯函数决定某个 range 要不要轮询：

```ts
shouldPollCandles(range: StockRange): boolean   // 1D、5D 为 true
```

可见性门控（`IntersectionObserver`）与 `refetchIntervalInBackground: false` 照旧，对两条查询都生效。

---

## 5. 测试

**后端**（注入假 client 与假 store，不打网络）：

1. `range=1D` → `timeframe: "1Min"`，`candles` 非空。
2. `range=1M` / `3M` / `1Y` → 均为 `timeframe: "1Day"`，`candles` 长度分别为 21 / 63 / 252 的上限内。
3. `range=none` → 响应**不含** `candles` 字段。
4. 非法 `range`（`7D`、`abc`、空）→ 退回 `1D`，不返回 400。
5. **增量拉取**：同一 symbol + timeframe 连续请求两次，断言第二次传给假 client 的 `from` 是上次末尾时间戳附近的 overlap 窗口，而**不是**全量回补窗口。这条是"只补新的"的钉子。
6. 首次请求（无 coverage）→ 假 client 收到的是全量回补窗口。
7. 拆股导致重叠区价格漂移 → `clearSymbol` 被调用且触发重新全量回补。
8. 当日无 bar → 退回上一交易日，`staleness.reason === "previous_session"`。
9. 旧 schema 的库（无 `timeframe` 列）→ 建表逻辑 DROP 重建，不抛错。

**前端纯函数**：

10. `parseStockChartProps` —— `range` 缺省为 `1D`；五个合法值原样通过；非法值退回 `1D`；symbol 校验行为不变。
11. `shouldPollCandles` —— 1D / 5D 为 true，1M / 3M / 1Y 为 false。

**回归**：

12. 现有 77 个测试保持全绿（`bars` → `range` 涉及的用例改写，不是删除）。
13. `CandleScope` 不传 `theme` 时使用原 Phosphor 配色——断言默认值对象与原 `COL` 常量相等。

canvas 绘制本身仍不做单测，靠手工验证：交易时段与休市各看一次，五档 range 各点一遍。

---

## 6. 实施顺序

1. `alpacaClient`：`fetchBars` 泛化 + 两个薄封装 + 测试。纯重构，现有测试须全绿。
2. `barStore`：timeframe 列、主键重建、旧 schema 检测 + 测试 9。
3. `barRepository`：`getBars(symbol, timeframe, count)` + 按 timeframe 的参数表 + 测试 5、6、7。
4. 端点：`range` 参数、`candles` / `timeframe` 字段、上一交易日退回 + 测试 1–4、8。
5. `CandleScope` 抽 theme + 测试 13 + Strategy Floor 回归验证。
6. `StockChart` 改造：range 按钮条、`useState`、两条查询的新分工 + 测试 10、11。
7. orchestrator 提示词更新，手工验证模型会写 `range` 且渲染正常。

第 1–3 步是纯数据层，可以在不碰任何前端代码的情况下验证完毕。
