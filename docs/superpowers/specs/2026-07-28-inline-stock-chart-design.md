---
title: 正文内嵌实时股价图表(StockChart) — 设计 spec
date: 2026-07-28
status: spec
---

**Status:** Design (pending implementation)
**Date:** 2026-07-28
**Author:** victor530914@gmail.com (with Claude)
**Scope:** 新增前端组件 `StockChart` 及其 markdown override 注册;新增后端端点 `GET /market/stocks/:symbol`;抽出 `mcp_tools/stock/sharedRepository.ts`;orchestrator 提示词增加标签使用说明。不改消息协议、不改 SSE、不改 `get_stock_price` 工具的行为。

前置依赖:`docs/superpowers/specs/2026-07-28-stock-price-tool-design.md`(已实现)提供的 `alpacaClient`、`barRepository`、`marketHours`。

---

## 1. 背景与目标

`get_stock_price` 工具目前只返回结构化数据,下游 subagent 把它写成文字。用户看到的是一段行情描述,没有图。

目标:让主 agent 能在回答正文里嵌入一块**活的**股价图表——随行情自动刷新,而不是生成一张静态图片或一个需要另开的 HTML 文件。

现有的 `price_chart` 工具走的是"生成 HTML 文件 → 存盘 → 以 artifact 返回路径"的路线。那条路线产出的是死快照,且脱离了对话正文。本设计不复用它,也不改动它。

### 非目标

- 不做自选列表(watchlist)。本设计只交付一个可嵌入的单标的组件;若日后要做行情页,在此组件之上搭建。
- 不做 WebSocket 推送。轮询已足够,理由见 §5。
- 不覆盖加密货币。crypto 已有 `price_chart` 与 Strategy Floor 的图表路径。

---

## 2. 嵌入机制:markdown 自定义标签

`MarkdownRenderer` 使用 `markdown-to-jsx` (7.7.17),其 `overrides` 映射表**原生支持 markdown 正文中的自定义标签**。因此主 agent 只需在回答里写:

```markdown
AAPL 今天走强,收复了 340 关口。

<StockChart symbol="AAPL" days="60" />

从日线看,上方压力位在 342.87。
```

`client/src/components/MarkdownRenderer.tsx` 的 `baseMarkdownOverrides` 增加一条 `StockChart: StockChartBlock`,与已有的 `p` / `table` / `img` 覆盖是同一机制。

**这是本设计选择该方案的核心理由:** 不发明新语法、不写解析器、不改消息协议、不碰 SSE 流。标签写在段落之间即为块级图表,前后文字照常渲染。

### 主 agent 必须被告知该标签存在

模型不会自发输出一个它没见过的标签。`src/agent/prompts/orchestratorPrompt.ts` 增加一段说明,包含:

- **何时用**:回答涉及某支美股的价格或走势时。
- **语法**:`<StockChart symbol="TICKER" days="60" />`,`days` 可省略(默认 60)。
- **三条约束**:一支股票在一条回答里只放一个标签;标签必须独占一行,不能写进代码块或行内;仅限美股,加密货币不要用这个标签。

---

## 3. Props 校验:模型输出不可信

`symbol` 会被拼进请求 URL,而它来自模型生成的文本。这是本设计唯一的新风险面。

组件内先做校验,**不合法就不发请求**:

```ts
parseStockChartProps({ symbol, days }) -> { symbol: string; days: number } | { error: string }
```

- `symbol`:必须匹配 `/^[A-Z][A-Z.-]{0,5}$/`(先 trim + 转大写)。不匹配则渲染一行"无效的股票代码:{原样显示}",不发请求。
- `days`:解析为整数并夹在 `[1, 365]`,非数字则取默认值 60。

后端**独立再校验一次**,不依赖前端已经拦过。两侧用同一条正则,但各自实现,避免前端被绕过时后端裸奔。

---

## 4. 后端端点

### `GET /market/stocks/:symbol?bars=60`

```jsonc
{
  "symbol": "AAPL",
  "quote": {
    "price": 339.34, "prevClose": 336.93, "changePercent": 0.72,
    "bidPrice": 339.30, "askPrice": 339.38,
    "dayOpen": 340.02, "dayHigh": 342.87, "dayLow": 335.63,
    "volume": 1450015, "quoteTimestamp": "2026-07-28T18:56:07Z"
  },
  "session": "regular",
  "bars": [{ "t": "2026-07-27", "o": 336.5, "h": 338.1, "l": 335.0, "c": 336.93, "v": 2428489 }],
  "dataSource": "Alpaca (IEX feed)",
  "fetchedAtMs": 1785700567000
}
```

`bars=0` 时**省略 `bars` 字段**。这是刻意的:日 K 盘中几乎不变(repository 本身有 30 分钟新鲜窗口),而报价 5 秒一刷。客户端分两条查询后,高频的那条就不必每 5 秒重复搬运 60 根 K 线。

数据来源全部复用现成件:`getSnapshotCached`(10 秒 TTL,多个浏览器标签同时打开也只打一次网络)与 `barRepository.getDailyBars`(读 SQLite)。

### 落点与一处顺带的重构

`src/server/server.ts` 已超过 900 行,不再往里塞 handler。新建 `src/server/stockMarketRoutes.ts` 存放 `handleStockQuote`,`server.ts` 只加一行路由分发。

`getRepository()` 目前是 `getStockPriceTool.ts` 的模块私有函数。抽成 `mcp_tools/stock/sharedRepository.ts` 并导出 `getSharedBarRepository()`,工具与 HTTP 端点共用同一个 SQLite 句柄——否则进程内会开出两个 WAL 连接指向同一文件,属于自找麻烦。`getStockPriceTool.ts` 改为调用该函数。

### 错误处理

| 情况 | 行为 |
|---|---|
| symbol 不合法(未过正则) | 400,`{ error: "invalid_symbol" }` |
| Alpaca 无此代码 / 404 | 404,`{ error: "symbol_not_found" }` |
| snapshot 失败但库中有日 K | 200,省略 `quote`,照常返回 `bars`,附 `staleness` 字段 |
| 两者都失败 | 502,`{ error: "market_data_unavailable" }` |
| SQLite 打不开 | 与工具层一致:退化为纯 API 拉取,不落库 |

---

## 5. 轮询策略

`refetchInterval` 由**后端返回的 `session` 字段**驱动,而非前端自行计算美东时间:

| session | 间隔 |
|---|---|
| `regular` | 5 秒 |
| `pre-market` / `after-hours` | 30 秒 |
| `closed` | `false`(react-query 停止轮询) |

判定逻辑只存在于后端 `marketHours.ts` 一处。前端只有一个纯函数做映射:

```ts
pollIntervalForSession(session: MarketSession): number | false
```

选择轮询而非 WebSocket:MCP 工具与聊天正文都是请求-响应式的,一条消息里的图表存活期通常是几分钟;为此维护长连接、断线重连与订阅生命周期,成本远大于收益。5 秒延迟对阅读一段行情分析毫无影响。

两条 react-query 查询分工明确:

- `["stock-bars", symbol, days]` —— `staleTime` 5 分钟,不轮询
- `["stock-quote", symbol]` —— `refetchInterval` 按上表,`bars=0`

---

## 6. 历史消息的时间错位

聊天记录是持久化的,而图表画的是**当下**行情。用户三天后翻回这条消息,图表显示的是三天后的价格,与当时的文字描述对不上。

处理方式:**图表照常实时,但在顶部标注消息的发送时间距今多久**——"实时数据 · 消息发于 3 天前"。图文不符的地方由这行提示解释,而不是假装不存在。

实现:`client/src/components/chat.tsx` 在渲染消息时用一个 `MessageTimeContext.Provider` 包住 `MarkdownRenderer`,把 `message.timestamp` 传下去;`StockChart` 用 `useContext` 读取。无 context 时(例如在非聊天场景复用该组件)不显示角标。

选这个方案而非"历史消息渲染静态快照",是因为后者需要把"是否最新消息"这个上下文一路传进渲染层,且用户往往就是想看那支股票现在什么价——冻结反而不符合预期。

---

## 7. 呈现

- **图形**:`chart.js/auto`,照 `client/src/components/NativeReportChart.tsx` 已有的 `useRef` + canvas + `useEffect` 清理模式。不新增依赖。
- **数据系列**:日 K 收盘价折线,末端追加一个实时价数据点。
- **配色**:以 `prevClose` 为基准,涨为绿、跌为红,与仓库既有的涨跌语义一致。
- **头部一行**:价格、涨跌幅、时段徽标(盘前 / 盘中 / 盘后 / 休市)、`Alpaca (IEX)` 小字标注。IEX 而非 SIP 这个限制必须在 UI 上如实呈现,与工具层的口径一致。
- **加载与断连**:首次加载显示骨架;轮询失败时**保留上一次成功的数据**并在头部显示"连接中断 · 数据截至 hh:mm",由 react-query 自动重试。

---

## 8. 测试

**后端** `handleStockQuote`(注入假 repository 与假 snapshot,不打网络):

1. `bars=60` → 响应含 `bars` 数组且长度正确。
2. `bars=0` → 响应**不含** `bars` 字段。
3. 非法 symbol(`../etc`、小写、超长)→ 400,且假 repository 的调用计数为 0。
4. snapshot 抛错但库中有 bar → 200,无 `quote`,有 `staleness`。
5. 两者都失败 → 502。
6. `session` 字段透传自 `marketSession`。

**前端纯函数**:

7. `pollIntervalForSession` —— 四个时段分别得到 5000 / 30000 / 30000 / false。
8. `parseStockChartProps` —— 合法 symbol 通过;`aapl` 归一化为 `AAPL`;含注入字符的被拒;`days` 越界被钳制到 `[1, 365]`;`days` 缺省为 60。

canvas 渲染本身不做单测:断言像素成本高、价值低,靠手工验证(交易时段与休市各看一次)。

---

## 9. 实施顺序

1. `sharedRepository.ts` 抽取 + `getStockPriceTool.ts` 改为调用它(纯重构,现有 54 个测试须保持全绿)。
2. `stockMarketRoutes.ts` + §8 的 1–6 号测试 + `server.ts` 路由接线。
3. `parseStockChartProps` / `pollIntervalForSession` 两个纯函数 + 7、8 号测试。
4. `StockChart` 组件 + `MarkdownRenderer` override 注册 + `MessageTimeContext`。
5. orchestrator 提示词补充说明,手工验证模型确实会输出该标签且渲染正常。
