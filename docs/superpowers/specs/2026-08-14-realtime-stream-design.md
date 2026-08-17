# 实时行情流设计：Alpaca WebSocket 取代快照轮询

日期：2026-08-14

## 目标

策略监控当前每 7 秒轮询一次 Alpaca REST 快照。把取价路径换成 Alpaca WebSocket 实时流，
把策略评估频率提到 500ms，同时让前端行情展示和 `get_stock_price` 共用同一个实时来源。

## 两条独立的数据路径

这次改动只碰其中一条，必须先说清楚边界。

**实时路径（本设计新建）**：WebSocket 流 → 进程内存 → 策略触发评估 + 前端实时价展示。
只保留最近 1 小时的滚动窗口，**不落盘**。

**回填库（已存在，不动）**：REST → SQLite `stock_bars` → 画图、技术指标、以后的 regression 回测。
由 `barRepository.ensureFresh` 按 1m/5m/30m 的新鲜度窗口维护。

两条路不交叉。特别地：**流内收到的分钟 bar 不写入 `stock_bars`**。写入会与
`ensureFresh` 维护的覆盖区间（`stock_bar_coverage`）打架，让"这段区间是否已回填"这个
判断失去意义。

## 现状与问题

三个调用方各自直连 `getSnapshotCached`（5 秒 TTL 内存缓存）：

- `src/server/stockMarketRoutes.ts:32` — 前端行情/图表
- `src/data/stock/stockPriceData.ts:124` — `get_stock_price` 工具
- `src/trading/stockStrategyMarketData.ts:10` — 策略监控

策略监控之上还有第二套实时状态：`src/trading/priceHistory.ts`，一个 7 天保留期的
内存 OHLC 缓冲，由轮询结果喂养。

直接把 `ACTIVE_INTERVAL_MS` 改小是无效的，原因有三：

1. **5 秒 TTL 缓存**：1 秒轮询会有 4/5 的轮次拿到同一个缓存值。更糟的是
   `stepConfirmation` 数的是轮次不是不同的价格，重复采样会让 N 次确认失效。
2. **速率限制**：免费档 200 请求/分钟。1 秒一轮时每标的 60 请求/分钟，只能支撑约 3 个标的。
   而 `alpacaFetch`（`alpacaClient.ts:67`）没有 429 处理，超限表现为策略静默不评估。
3. **O(n) 缓冲区**：`priceHistory.appendPrice` 每次追加都全量 filter 一遍 7 天缓冲。

## Alpaca 流的硬限制

免费档：**1 个并发连接**、**trades/quotes 订阅上限 30 个标的**（minute bars 不限）、
仅 IEX。付费档（Algo Trader Plus / Unlimited）无符号限制并可用 SIP。

端点：`wss://stream.data.alpaca.markets/v2/{iex|sip}`

来源：[WebSocket Stream 文档](https://docs.alpaca.markets/docs/streaming-market-data)、
[About Market Data API](https://docs.alpaca.markets/us/docs/about-market-data-api)

两个直接后果：

- 按需订阅必须带淘汰策略。
- WS 客户端是进程级单例，与 `getSharedBarRepository` 同一模式。`npm run dev` 的
  `--watch` 重启瞬间会短暂双连接，重连逻辑必须能吃掉 `connection limit exceeded`。

Node v24 自带全局 `WebSocket`，不引入新依赖。

## 已确定的设计决策

| 决策 | 选择 |
|---|---|
| 订阅范围 | 按需订阅：用到谁订谁；活跃策略的标的常驻 |
| 权威读取源 | 进程内存镜像；实时窗口不落盘 |
| 窗口粒度 | 500ms 桶，桶内记 high/low/close |
| 窗口长度 | 1 小时滚动 |
| 防噪声 | 入口过滤，**移除 `confirm_samples` 确认机制** |
| feed | 可配置，默认 IEX |
| 断连 | 自动重连；期间回退 REST 轮询 |

### 关于移除 confirm_samples

N 次确认是加密货币设计的遗留（见 `2026-06-10-auto-trading-strategy-design.md`）：
7×24、单交易所薄盘、无熔断，需要多次采样确认。美股有 LULD 涨跌停带、clearly erroneous
trade 撤销规则和全国最优报价保护，全市场级别的假插针基本不存在。

但 IEX 只占全市场约 2% 成交量，单场内的不代表性数据仍然存在；且采样从 7 秒提到 500ms
之后这个问题变严重——原来 7 秒一采本身平均掉了微观噪声。

因此不是简单删除确认，而是把防噪声从"触发器上数次数"移到"数据入口做质量过滤"。

## 一、模块边界

```
src/data/stock/realtime/
  streamClient.ts    WS 连接：鉴权握手、订阅/退订报文、重连退避、消息解析
  subscriptions.ts   订阅集合状态机：pin / lease / LRU 淘汰、容量上限
  quoteFilter.ts     入口过滤：crossed/locked、异常宽价差、离群点
  buckets.ts         500ms 桶聚合 + 1h 滚动窗口
  index.ts           组装 + 对外 API
```

`subscriptions`、`quoteFilter`、`buckets` 三者是纯函数或纯状态机：不碰网络、不读时钟，
时间由调用方传入（与 `createTtlCache(load, ttlMs)` 中 `nowMs` 由调用方提供的做法一致）。
连接管理这一件难测的事被隔离在 `streamClient` 内。

### 对外接口

```ts
/** 与 getSnapshotCached 同签名，可直接替换现有注入点。REST 日线字段 + 流报价叠加。 */
latestSnapshot(symbol: string, nowMs: number): Promise<Snapshot>

/** 只要中价的轻量读法，策略路径用。流不可信时回退 REST。 */
latestPrice(symbol: string, nowMs: number): Promise<number>

/** 缓冲区里的最新价，完全同步、不碰网络。监控循环每 tick 用它。 */
currentPrice(symbol: string): number | undefined

/** 同步返回 500ms 桶序列，策略触发评估用。 */
window(symbol: string, windowMs: number, nowMs: number): OhlcSample[]

/** 窗口是否已覆盖 windowMs（rolling_change 的 armed 判定）。同步。 */
isArmed(symbol: string, windowMs: number, nowMs: number): boolean

/** 用当前活跃策略集合对账 pinned 订阅。幂等。 */
reconcileStrategySymbols(symbols: readonly string[], nowMs: number): void

/** 降级期间 REST 轮询的写入口。 */
recordPrice(symbol: string, price: number, tsMs: number): void

/** 清理超时未访问的 lease。 */
sweep(nowMs: number): void

/** 连接状态与订阅占用，供前端展示与日志。 */
status(): { state: "idle" | "connecting" | "connected" | "reconnecting" | "degraded" | "down";
            pinned: number; leased: number; capacity: number; overflow: string[] }
```

**快照是叠加而不是替换。** `Snapshot` 里的 `dayOpen` / `prevClose` / `volume` 只存在于 REST
快照，流里的 quote 只有 bid/ask。所以 `latestSnapshot` 保留 REST 的日线聚合字段，只把实时
报价覆盖到价格字段上；对外签名不变。策略路径不需要日线字段，走更轻的 `latestPrice`。

**读不写。** `latestPrice` 回退到 REST 时不会把该价格写进窗口——窗口是"流看到了什么"的记录，
把一个 5 秒缓存的 REST 值混进 500ms 序列会让它谎报自己的分辨率。降级轮询通过 `recordPrice`
显式写入。

**冷启动回填在订阅时触发，不在读取时触发。** pin 与 lease 建立时异步发起一次
REST 1 分钟 bar 回填；`window` 与 `isArmed` 保持同步，回填未完成时 `isArmed` 返回
false，调用方等下一轮即可。这样读路径上没有任何 await，与"内存镜像为准"一致。

`state` 四态的含义：`connected` 流正常；`reconnecting` 断连重试中，窗口暂停增长；
`degraded` 重试失败已切到 REST 轮询；`down` 不可恢复（缺凭证、鉴权被拒），实时层停用、
全部调用方走 REST。

`src/trading/priceHistory.ts` 删除，其 `backfill` / `windowSamples` / `isArmed`
职责搬入 `buckets.ts`。

## 二、订阅生命周期

容量（默认 30，可配置）分两类占用：

- **pinned** — 活跃策略的标的，永不淘汰。
- **leased** — 前端图表、`get_stock_price` 等按需访问，TTL 5 分钟无访问则自动退订。

满员时新的 lease 淘汰最久未访问的 leased。若容量被 pinned 占满，新 lease 被拒，
该标的走 REST——即今天的行为，不算退步。

**pin 的维护方式**：不在 `start_strategy`、审批路由、`manage_strategy` 三处各调一次。
策略状态能从这三个地方改，散着调迟早漏。改为**监控循环每轮对账**：读活跃策略集合，
与当前 pinned 集合求差集，增订退订。幂等，任何路径改了状态都会在下一轮收敛。

**已知边界**：活跃策略标的数超过容量时，超出部分只能走 REST 轮询降级。免费档下这是
硬上限。`realtimeStatus()` 暴露该情况并记日志。

**`getRealtimeFeed()` 恒返回实例，不返回 undefined。** 没有凭证时 feed 照常构建，只是从不
连接、状态停在 `down`，所有读取穿透到 REST。返回 undefined 会迫使每个调用方——尤其是监控
循环——为"有没有开过一个 socket"这唯一的差别多养一条平行取价路径。

## 三、数据流与桶聚合

**只订阅 `quotes` 通道，不订 trades。** 免费档的 30 个名额按 trades+quotes 合并计算，
而现有 `fetchStockStrategyPrice` 本就取 bid/ask 中价、成交价仅作兜底。只订 quotes 让
每个标的占 1 个名额而非 2 个，语义与现状一致；成交价兜底交给 REST 回退路径。

```
quote(bid, ask, ts) → quoteFilter → mid = (bid+ask)/2 → bucket[floor(ts/500)]
```

桶记 high / low / close，对齐现有的 `OhlcSample`（`{ ts, high, low, close }`，无 open）。

**桶不靠定时器封口**，靠下一条消息跨桶时封口，读取时把当前未封口的桶也计入。
否则每个标的都需要一个 500ms 定时器空转。

**1h 窗口用固定长度环形缓冲**（7200 槽，写指针取模），不是数组加 filter。
现有 `appendPrice` 的全量 filter 在 7 秒一采时无所谓，500ms 下是每秒两次遍历数万元素。

**冷启动**：订阅建立时（pin 或 lease）异步发起一次 REST 1 分钟 bar 回填，
即现有 `backfill()` 的逻辑。粒度粗于 500ms，但它只用来回答"窗口够不够长"这一个问题。

## 四、入口过滤

丢弃规则（阈值为可配置常量，下列为初始默认值）：

1. crossed / locked 报价（`bid >= ask`）
2. 缺失或非正的 bid / ask
3. 价差过宽：`(ask - bid) / mid > 2%`。开盘数分钟与薄盘标的会命中，是预期效果。
4. 离群点：偏离最近 20 个桶 close 的中位数超过 5%。

**第 4 条有一个会致命的失败模式**：若规则是"偏离超阈值就丢弃"，那么真正的崩盘或跳空
——也就是止损最该触发的时刻——数据会被整段过滤掉，策略静默地什么都不做。这比不过滤危险。

因此离群检测必须带逃生阀：**连续 3 个桶都指向同一方向的偏离，就接受它并把中位数基准
重置到新水平**。孤立野点是脏数据，持续偏离是真行情。3 个桶 = 1.5 秒，代价是极端行情下
比无过滤晚 1.5 秒触发，换取的是不会被一个野点误触发。

这一条写成显式测试：喂一段真实跳空序列，断言触发器照常开火。按 CLAUDE.md 的要求，
逃生阀加完后要拆掉它、确认该用例变红。

## 五、降级路径

```
connected ──断连──> reconnecting ──连续失败超阈值──> degraded (REST 轮询)
    ^                                                        │
    └──────────────────── 恢复 ──────────────────────────────┘
```

- 重连指数退避 1s→30s 带抖动。连续 3 次重连失败即进入 `degraded`。
- `connection limit exceeded` 与鉴权失败单独处理：退避上限拉长并显式日志。
  `npm run dev` 的 `--watch` 重启必然撞上前者。
- **degraded 期间的 REST 轮询把结果喂进同一个桶聚合器**。下游 `window` /
  `latestSnapshot` 完全无感，只是桶变稀疏。降级不是一条平行代码路径——否则它
  永远缺乏测试覆盖。
- **REST 回退按标的独立限流**（`REST_FALLBACK_INTERVAL_MS = 7_000`）。监控 tick 是 500ms，
  若回退不限流，一个断流的标的就会变成每分钟 120 次请求，直接撞穿 200/分钟的配额。
- **休市走过期判定，而不是交易日历。** 原计划用 `marketSession(now)` 显式识别休市，
  实现时没有采用：收盘后 socket 并不断开，只是安静下来，所以真正的风险不是"误判为故障"，
  而是监控循环拿着上一场收盘的最后一笔价继续评估。`currentPrice` 因此带过期检查——
  最新桶超过 `maxStalenessMs`（默认 15 秒）即返回 undefined，调用方落到限流的 REST 回退。
  这条同时覆盖了休市、盘中断流和薄盘无报价三种情况，比查交易日历更直接。
- `status()` 暴露状态供前端展示。

## 六、改动清单

**新增**：`src/data/stock/realtime/` 七个文件——五个核心模块，加上进程级单例
`sharedFeed.ts` 与适配现有注入点的 `snapshotLoader.ts`。

**修改**：

| 文件 | 改动 |
|---|---|
| `alpacaClient.ts:2` | `FEED` 常量抽为可配置（`ALPACA_FEED` 环境变量）；`alpacaFetch` 补 429/5xx 退避——degraded 回退依赖它 |
| `src/data/stock/index.ts` | 导出实时层 |
| `stockMarketRoutes.ts:32` | `loadSnapshot` 默认值换成 `realtimeSnapshotLoader()`（一行） |
| `stockPriceData.ts:124` | 同上（一行） |
| `stockStrategyMarketData.ts` | `fetchStockStrategyPrice` 改读实时层；`fetchStockStrategySamples` 与 `fetchStockTechnicalStrategySamples`（回填库路径）**不动** |
| `strategyMonitor.ts` | `ACTIVE_INTERVAL_MS` 7000→500（`IDLE_INTERVAL_MS` 60s 保持不变）；每轮 reconcile pin 集合；取价改同步读内存 + 限流的 REST 回退；删除 `confirmCounts` 与 `stepConfirmation` 调用；新增 `MonitorDeps` 注入口 |
| `alpacaClient.ts` | 新增 `resolveFeed()` 与 `alpacaFetch` 的 429/5xx 指数退避重试（3 次，1s/2s） |
| `priceTrigger.ts` | 七个 trigger schema 移除 `confirm_samples` |
| `strategyTools.ts` | `create_strategy` 描述中的 confirm 相关文字 |
| `subagentPrompts.ts` | trading_operations prompt 中的 confirm 相关规则 |
| `src/server.ts` | 启动时即建连，让凭证或连接数问题出现在启动日志而不是某次工具调用里 |
| `scripts/eval/` | trigger replay 数据集与断言跟随 confirm 语义移除而调整 |

**删除**：`src/trading/priceHistory.ts`、`src/trading/confirmation.ts`。

`stockMarketRoutes.ts` 与 `stockPriceData.ts` 通过 `loadSnapshot` 依赖注入取快照，
签名统一为 `(symbol, nowMs) => Promise<Snapshot>`。实时层提供同签名函数后，这两处各改
一行默认值，现有测试不受影响。

**存量策略无需迁移脚本**：`mcp_tools/trading` 与 `src/trading` 中无任何 `.strict()`
或 `.passthrough()`，zod 默认 strip 未知字段，`data/strategies/*.json` 里遗留的
`confirm_samples` 读取时自动丢弃。

## 七、测试策略

**纯单元、零网络**（模块拆分的主要回报）：

- `subscriptions` — pin 优先于 lease、LRU 淘汰、满员拒绝 lease、pinned 超容量的降级
- `quoteFilter` — crossed/locked、宽价差、**孤立野点被丢弃 vs 持续跳空被放行**
- `buckets` — 跨桶封口、环形缓冲回绕、窗口长度与 armed 判定

**`streamClient`** 注入内存 fake WebSocket，测鉴权握手顺序、订阅/退订报文、重连退避、
`connection limit exceeded` 分支。不连真网。

**集成**：喂录制的 quote 序列走完整链路，断言触发行为。

**`scripts/eval` 的 trigger replay 必须把入口过滤器接进管线。** 确认门是它原本衡量的两件事
之一，那个职责现在归过滤器；不接进去，false-trigger 指标衡量的就是一条生产中不存在的链路。
四个 fixture 因此需要 5 个预热样本，过滤器才有基准可比。

**监控循环补测试**：改动前 `runOnce` / `evaluatePhase` 没有任何测试覆盖（原测试文件只测
`nextTickDelay`），所以换掉取价来源时不会有任何测试变红。新增 `monitorTick.test.ts`，
并通过定向变异验证每个守卫确实能失败。

**必跑的既有护栏**：本次改动了 `subagentPrompts.ts` 的 trading prompt，按 CLAUDE.md
的规定，`promptCacheSplit.test.ts` 与 `dcfPromptInjection.test.ts` 必须跑。

## 不在本次范围内

- 流内分钟 bar 写入 `stock_bars`（会与回填库的覆盖区间冲突）
- 逐笔 tick 归档与持久化（实时窗口不落盘）
- 实时层拆为独立进程（当前只有 `src/server.ts` 一个长驻进程）
- 前端"行情降级"的 UI 展示（本次只提供 `realtimeStatus()` 接口）
- SIP feed 的实际启用（本次只做成可配置）
