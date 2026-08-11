---
title: 正文内嵌实时股价图表(StockChart) — 设计 spec
date: 2026-07-28
status: spec
---

**Status:** Implemented；§4(端点参数)与 §7(呈现)已被 `2026-07-29-stock-candle-ranges-design.md` 替代
**Date:** 2026-07-28
**Author:** victor530914@gmail.com (with Claude)
**Scope:** 新增前端组件 `StockChart` 及其 markdown override 注册;新增后端端点 `GET /market/stocks/:symbol`;抽出 `mcp_tools/stock/sharedRepository.ts`;`getSnapshotCached` 的 TTL 由 10 秒改为 5 秒;orchestrator 提示词增加标签使用说明。不改消息协议、不改 SSE。

`get_stock_price` 工具的**代码**不改,但它与本端点共用 `getSnapshotCached`,因此会连带受 TTL 变更影响——同一 symbol 在 5–10 秒内的重复调用会多打一次 Alpaca。这是可接受的:该工具本就不在热路径上,而组件需要 5 秒粒度(见 §5)。

前置依赖:`docs/superpowers/specs/2026-07-28-stock-price-tool-design.md`(已实现)提供的 `alpacaClient`、`barRepository`、`marketHours`。

---

## 1. 背景与目标

`get_stock_price` 工具目前只返回结构化数据,下游 subagent 把它写成文字。用户看到的是一段行情描述,没有图。

目标:让主 agent 能在回答正文里嵌入一块**活的**股价图表——随行情自动刷新,而不是生成一张静态图片或一个需要另开的 HTML 文件。

旧的"生成 HTML 文件 → 存盘 → 返回路径"路线已彻底删除。所有新图表使用结构化 visualization spec,由前端统一 renderer 绘制。

### 非目标

- 不做自选列表(watchlist)。本设计只交付一个可嵌入的单标的组件;若日后要做行情页,在此组件之上搭建。
- 不做 WebSocket 推送。轮询已足够,理由见 §5。
- 不覆盖加密货币。该组件只接受通过股票 symbol 校验的美股/ETF。

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
- **四条约束**:一支股票在一条回答里只放一个标签;**标签必须独占一行,且前后各留一个空行**;不能写进代码块或行内;仅限美股,加密货币不要用这个标签。

"前后各留空行"不是排版洁癖,是正确性要求,见下。

### 块级 vs 行内:必须留空行的原因

markdown-to-jsx 只有在标签前后都有空行时才把它当块级 HTML 处理。若标签只是独占一行却与上下文粘在同一段落内,它会被当作 inline 节点,外面套着 `CustomParagraph` 渲染出的 `<p>` —— 而 `<p>` 内嵌 `<div><canvas>` 是非法 DOM 嵌套,React 会告警且布局会塌。

实测(markdown-to-jsx 7.7.17 + `renderToStaticMarkup`,override 为 `p` 与 `StockChart`):

| 写法 | 渲染结果 |
|---|---|
| 前后有空行 | `<div><p>…</p><span …>CHART</span><p>…</p></div>` —— 块级兄弟节点 |
| 独占一行但无空行 | `<p>AAPL 走强。\n<span …>CHART</span>后文。</p>` —— **嵌在 `<p>` 内** |
| 行内 | `<span>… <span …>CHART</span> …</span>` |
| 半截标签 | `<p>&lt;StockChart symb</p>` —— 转义为字面文本,不吞后续正文 |

第二行就是必须兜底的原因:那个位置若是 `<div>` 即为非法嵌套。提示词负责让模型留空行,但模型输出不可信,组件本身也要兜底:`StockChartBlock` 的最外层用 `<span className="block ...">` 而非 `<div>`。`<span>` 在 `<p>` 内合法,`display:block` 又保证了块级视觉效果。canvas 是 replaced element,同样可以合法出现在 `<p>` 里。这样即便模型忘了空行,页面也只是嵌在段落里,不会报错。

### 流式渲染

`client/src/components/chat.tsx:590` 把 `streamingText` 逐 token 喂给 `MarkdownRenderer`,标签会依次经历 `<StockChart`、`<StockChart symb`、`<StockChart symbol="AAPL"` 等中间态。实测(见下)markdown-to-jsx 会把未闭合的 `<` **转义成字面文本**渲染,于是用户看到半截原始标记一闪而过;标签一旦补全,组件又会在回答尚未写完时挂载并开始轮询。

处理方式:**流式期间不渲染该标签**。`MarkdownRenderer` 增加一个可选 prop `streaming?: boolean`,为真时:

1. 用 `stripIncompleteTrailingTag(text)` 砍掉末尾未闭合的 `<...` 片段(正则 `/<[^>]*$/`),藏掉半截标记的闪现;
2. overrides 里把 `StockChart` 映射到一个占位组件(一行"图表将在回答完成后显示"的骨架),不发任何请求。

`chat.tsx:590` 的流式预览传 `streaming`,已定稿的消息(`chat.tsx:503`/`507`)不传。定稿后组件正常挂载,只挂载一次。

消息正文直接交给单个 `MarkdownRenderer`;不存在文件式图表分段或 iframe 嵌入链路。

---

## 3. Props 校验:模型输出不可信

`symbol` 会被拼进请求 URL,而它来自模型生成的文本。这是本设计唯一的新风险面。

组件内先做校验,**不合法就不发请求**:

```ts
parseStockChartProps({ symbol, days }) -> { symbol: string; days: number } | { error: string }
```

- `symbol`:先 trim + 转大写,再要求匹配 `/^[A-Z][A-Z.-]{0,5}$/`。不匹配则渲染一行"无效的股票代码:{原样显示}",不发请求。
- `days`:解析为整数并夹在 `[1, 365]`,非数字则取默认值 60。

后端**独立再校验一次**,不依赖前端已经拦过。两侧用同一条正则、**同样先 trim + 转大写再匹配**,但各自实现,避免前端被绕过时后端裸奔。归一化口径必须两侧一致:后端收到 `aapl` 应视为 `AAPL` 正常返回,而不是判 400 —— 否则前端归一化过的请求能过、直接调用端点的请求却被拒,行为不可预测。400 只留给归一化后仍不合法的输入(含 `/`、`..`、空格、超长等)。

拼 URL 时对 symbol 做 `encodeURIComponent`,即使它已经过正则。

### props 与 query 参数的映射

组件的 prop 叫 `days`(对模型友好:"要多少天的日 K"),端点的 query 参数叫 `bars`(对后端诚实:实际返回的是几根 K 线,休市日不产生 bar,两者不等)。映射就是直传数值:`days=60` → `?bars=60`。

`bars` 参数缺省时默认 60;`bars=0` 是显式请求"不要 K 线"(见 §4)。

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
  "staleness": null,
  "dataSource": "Alpaca (IEX feed)",
  "fetchedAtMs": 1785700567000
}
```

`staleness` 在正常响应中为 `null`;当 snapshot 失败、只能返回库中日 K 时,它是 `{ "reason": "quote_unavailable", "asOf": "2026-07-27" }`,`asOf` 为最后一根 bar 的日期。类型上恒定存在,避免前端做 `in` 判断。

`bars=0` 时**省略 `bars` 字段**。这是刻意的:日 K 盘中几乎不变(repository 本身有 30 分钟新鲜窗口),而报价 5 秒一刷。客户端分两条查询后,高频的那条就不必每 5 秒重复搬运 60 根 K 线。

数据来源全部复用现成件:`getSnapshotCached`(TTL 见 §5,多个浏览器标签同时打开也只打一次网络)与 `barRepository.getDailyBars`(读 SQLite)。

### 鉴权与限流

`client/src/lib/api.ts:24` 写明本仓库没有鉴权后端("no Bearer tokens, no CSRF, no cookies"),因此本端点不带鉴权,与既有的 `/user/*`、`/trading/*` 一致,不算破例。

但它与那些端点有一点不同:**symbol 由模型生成,且每次请求可能穿透到付费上游**。因此加一道进程内限流——按 symbol 的 TTL 缓存已经挡住了同标的的重复请求,再补一个全局上限:每分钟最多向 Alpaca 发起 120 次 snapshot 拉取,超出则返回 429 `{ error: "rate_limited" }`,前端显示"请求过于频繁"并由 react-query 退避重试。这不是安全边界,是账单边界。

### 落点与一处顺带的重构

`src/server/server.ts` 已超过 900 行,不再往里塞 handler。新建 `src/server/stockMarketRoutes.ts` 存放 `handleStockQuote`,`server.ts` 只加一行路由分发。

`getRepository()` 目前是 `getStockPriceTool.ts` 的模块私有函数。抽成 `mcp_tools/stock/sharedRepository.ts` 并导出 `getSharedBarRepository()`,工具与 HTTP 端点共用同一个 SQLite 句柄——否则进程内会开出两个 WAL 连接指向同一文件,属于自找麻烦。`getStockPriceTool.ts` 改为调用该函数。

### 错误处理

| 情况 | 行为 |
|---|---|
| symbol 归一化后仍不合法 | 400,`{ error: "invalid_symbol" }` |
| 超过每分钟上游调用上限 | 429,`{ error: "rate_limited" }` |
| Alpaca 无此代码 / 404 | 404,`{ error: "symbol_not_found" }` |
| snapshot 失败但库中有日 K | 200,省略 `quote`,照常返回 `bars`,附 `staleness` 字段 |
| 两者都失败 | 502,`{ error: "market_data_unavailable" }` |
| SQLite 打不开 | 与工具层一致:退化为纯 API 拉取,不落库 |

---

## 5. 轮询策略

### 先决条件:`getSnapshotCached` 的 TTL 改为 5 秒

`mcp_tools/stock/alpacaClient.ts:150` 目前是 `createTtlCache(fetchSnapshot, 10_000)`。若保持 10 秒不动而前端按 5 秒轮询,则一半的轮询命中缓存、拿回一模一样的数据,实际刷新粒度是 10 秒——下表的"5 秒"就是假的。

两种对齐方式,本设计选前者:

1. **TTL 降到 5 秒**,轮询保持 5 秒。上游调用量翻倍,但盘中活跃图表数量有限,且 §4 的限流兜底。
2. 轮询放慢到 10 秒。省流量,但盘中读价体验明显钝。

改动为一行:`createTtlCache(fetchSnapshot, 5_000)`,注释同步改。`createTtlCache` 的 4 个现有测试(`alpacaClient.test.ts:7,15,23,37`)各自传入自己的 ttl 参数,不依赖这个常量;`getStockPriceTool` 在测试中走 `overrides.snapshot` 注入。因此该改动不影响现有 54 个测试。

原则:**轮询间隔与上游缓存 TTL 必须相等**。仓库里 `client/src/hooks/useMarketSnapshot.ts` 的注释已经确立了这个口径("matches the upstream 5 s cache TTL so polling faster yields no fresher data"),本设计沿用。

### 间隔表

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

两条查询都加 `placeholderData: (prev) => prev`,照 `useMarketSnapshot.ts` 的做法,保证 symbol 或 days 变化时不闪空白。

### 可见性门控

聊天记录是持久的,一个长会话里可能存在十几条带图表的历史消息。若每个组件都无条件轮询,就是十几路 5 秒请求常驻——不同 symbol 之间 react-query 不会去重(query key 不同),而用户实际只在看屏幕上的那一两个。

两道门控:

- **视口**:组件用 `IntersectionObserver` 维护 `isVisible`,作为 `enabled` 的一部分。滚出视口即停,滚回来立即 refetch。
- **标签页**:`refetchIntervalInBackground: false`(react-query 默认值,显式写出以免日后被改掉)。浏览器标签页不在前台时不轮询。

`refetchOnWindowFocus` 保持默认开启:用户切回来时看到的应该是当下价格。

---

## 6. 历史消息的时间错位

聊天记录是持久化的,而图表画的是**当下**行情。用户三天后翻回这条消息,图表显示的是三天后的价格,与当时的文字描述对不上。

处理方式:**图表照常实时,但在顶部标注消息的发送时间距今多久**——"实时数据 · 消息发于 3 天前"。图文不符的地方由这行提示解释,而不是假装不存在。

实现:`client/src/components/chat.tsx` 的 `renderAssistantBubble` 用一个 `MessageTimeContext.Provider` 包住 `MarkdownRenderer`,把 `m.createdAt`(number,毫秒时间戳——`chat.tsx:537` 用的就是这个字段,消息上**没有** `timestamp` 字段)传下去;`StockChart` 用 `useContext` 读取。无 context 时(例如在非聊天场景复用该组件)不显示角标。

选这个方案而非"历史消息渲染静态快照",是因为后者需要把"是否最新消息"这个上下文一路传进渲染层,且用户往往就是想看那支股票现在什么价——冻结反而不符合预期。

---

## 7. 呈现

- **图形**:`chart.js/auto`,照 `client/src/components/NativeReportChart.tsx` 已有的 `useRef` + canvas + `useEffect` 清理模式。不新增依赖。
- **数据系列**:日 K 收盘价折线,末端追加一个实时价数据点。
- **配色**:以 `prevClose` 为基准,涨为绿、跌为红,与仓库既有的涨跌语义一致。
- **头部一行**:价格、涨跌幅、时段徽标(盘前 / 盘中 / 盘后 / 休市)、`Alpaca (IEX)` 小字标注。IEX 而非 SIP 这个限制必须在 UI 上如实呈现,与工具层的口径一致。
- **加载与断连**:首次加载显示骨架;轮询失败时**保留上一次成功的数据**并在头部显示"连接中断 · 数据截至 hh:mm",由 react-query 自动重试。
- **标记**:所有容器元素用 `<span className="block ...">`,理由见 §2 的"块级 vs 行内"。头部那一行同理。canvas 本身在 `<p>` 内合法,不必包装。
- **流式占位**:`streaming` 为真时渲染一个与最终图表等高的骨架块,避免定稿瞬间的布局跳动。

---

## 8. 测试

**后端** `handleStockQuote`(注入假 repository 与假 snapshot,不打网络):

1. `bars=60` → 响应含 `bars` 数组且长度正确。
2. `bars=0` → 响应**不含** `bars` 字段;`bars` 参数缺省 → 含 `bars`,长度 60。
3. 非法 symbol(`../etc`、含空格、超长)→ 400,且假 repository 的调用计数为 0。
4. **小写 `aapl` → 200**,归一化为 `AAPL` 后正常返回(与 §3 的两侧一致口径)。
5. snapshot 抛错但库中有 bar → 200,无 `quote`,`staleness.reason === "quote_unavailable"`。
6. 两者都失败 → 502。
7. 正常响应中 `staleness` 为 `null` 而非缺失。
8. `session` 字段透传自 `marketSession`。
9. 超过每分钟上游调用上限 → 429,且不再调用假 snapshot。

**前端纯函数**:

10. `pollIntervalForSession` —— 四个时段分别得到 5000 / 30000 / 30000 / false。
11. `parseStockChartProps` —— 合法 symbol 通过;`aapl` 归一化为 `AAPL`;含注入字符的被拒;`days` 越界被钳制到 `[1, 365]`;`days` 缺省为 60。
12. `stripIncompleteTrailingTag` —— `"文字 <StockChart symb"` → `"文字 "`;`"文字 <StockChart symbol=\"AAPL\" />"` 原样返回;不含 `<` 的文本原样返回;文本中的 `a < b` 不被误砍(仅当 `<` 之后到字符串末尾都没有 `>` 时才砍,`a < b` 满足该条件会被砍——这是可接受的:流式期间末尾片段马上会被后续 token 补全,且只影响预览态)。

**组件级(需要 DOM,用现有前端测试设施;若前端尚无测试运行器则降级为手工验证并在 PR 说明中记录)**:

13. `streaming` 为真时,完整的 `<StockChart />` 标签渲染为占位骨架且**不发起 fetch**。
14. `streaming` 为假时,同样的输入挂载真实组件并发起一次 fetch。
15. 标签未被空行包围(嵌在段落内)时,渲染结果不产生 `<div>` 嵌在 `<p>` 内的非法结构——断言外层是 `span`。

canvas 绘制本身不做单测:断言像素成本高、价值低,靠手工验证(交易时段与休市各看一次)。

---

## 9. 实施顺序

1. `sharedRepository.ts` 抽取 + `getStockPriceTool.ts` 改为调用它;同一步把 `alpacaClient.ts:150` 的 TTL 改为 `5_000` 并更新注释(纯重构 + 一行常量,现有 54 个测试须保持全绿)。
2. `stockMarketRoutes.ts`(含 symbol 归一化与限流)+ §8 的 1–9 号测试 + `server.ts` 路由接线。
3. `parseStockChartProps` / `pollIntervalForSession` / `stripIncompleteTrailingTag` 三个纯函数 + 10–12 号测试。
4. `StockChart` 组件 + `MarkdownRenderer` override 注册与 `streaming` prop + `MessageTimeContext` + 13–15 号测试。
5. orchestrator 提示词补充说明(含"前后各留空行"),手工验证模型确实会输出该标签、流式期间显示占位、定稿后渲染正常。

第 1 步会连带改变 `get_stock_price` 的缓存行为(见文首 Scope),虽是一行改动也应单独成 commit,便于日后回滚时不牵连 `sharedRepository` 的抽取。
