---
title: 自动交易策略系统(Auto-Trading Strategy Engine) — 设计 spec
date: 2026-06-10
status: spec
---

**Status:** Design (pending implementation)
**Date:** 2026-06-10
**Author:** victor530914@gmail.com (with Claude)
**Scope:** 在 financial-agent 现有 CEX 工具(`mcp_tools/trading/`)基础上,新增"价格驱动的自动交易策略"子系统。**核心策略:从 staging 分支 `financial-agent/financial-agent-0428` 的 `packages/plugin-cex` 移植复用成熟组件(策略 DSL/runtime、幂等、数量规整、回测、websocket 用户数据流、风控规则),并在其上扩展我们的价格触发语义 + 补建常驻监控循环。** v1 仅现货(spot)、仅价格驱动触发。前端监控面板与护栏设置页面单独留待后续设计。

---

## 1. 背景与目标

当前 financial-agent 的 CEX 流程是完全人在回路:`cex_prepare_order` → 用户审批 → `cex_create_order`,状态全在内存,无条件触发、无定时监控。

目标:用户(通过 LLM 对话)创建价格驱动的自动交易策略,例如"如果 BTC 在 10 分钟内下跌 5%,卖出持仓的 10%"。策略经用户一次性确认激活后,后续触发与下单**完全自动执行,无需逐笔确认**,但始终受风控引擎硬上限与全局 kill switch 约束。

### 关键决策:移植复用 staging plugin-cex

经核查,staging 分支(`financial-agent/financial-agent-0428` @ `staging`,`packages/plugin-cex`)已实现一整套成熟的交易/策略基础设施,与本设计高度重叠。两边均为 ESM,风控规则同源(financial-agent 是其简化移植)。我们**移植复用**这些组件,而非从零实现。核心逻辑文件几乎零 `@elizaos/core` 耦合,可直接拷贝。

### 非目标(v1)

- 不支持期货/杠杆/保证金(仅 spot)。
- 不支持情绪/新闻触发(staging 的 DSL 有 `sentiment.score` 信号,本期不接入数据源)。
- 仅支持 `market` 与 `marketable_limit` 订单(普通 `limit` 挂单留待后续)。
- 不实现前端界面(仅预留后端数据接口)。
- 不引入数据库,持久化用 JSON 文件。
- 假设单一服务器进程,不处理多实例协调。

---

## 2. 复用清单(移植 / 适配 / 新建)

源:`financial-agent/financial-agent-0428` @ `staging`,路径前缀 `packages/plugin-cex/src/`。

| 组件 | 源文件 | 处理 | 说明 |
|---|---|---|---|
| 策略 DSL(Zod schema) | `strategy/strategyDSL.ts` | **移植 + 扩展** | 0 elizaos 耦合;扩展我们的价格触发类型(§4) |
| 策略评估引擎 | `strategy/strategyRuntime.ts` | **移植 + 扩展** | `runStrategyOnce()` 单次评估;0 耦合 |
| NL→策略 | `strategy/nlToDSL.ts` | 移植 | 启发式编译;0 耦合 |
| 幂等键 | `idempotency/intentHash.ts` | 移植 | `computeIntentHash`/`deriveClientOrderId`;0 耦合。下单自带防重复提交 |
| 数量/价格规整 | `exchanges/services/binanceQuantization.ts` | 移植 | LOT_SIZE/tickSize/minNotional;0 耦合(解决议题10) |
| 回测引擎 | `backtest/runner.ts` + `indicators.ts` | 移植 | OHLCV 模拟、夏普/回撤等指标;0 耦合。klines 历史源可复用 |
| 订单/余额 websocket | `reconciliation/binanceUserDataStream.ts` `reconciliation/coinbaseUserOrderStream.ts` | **适配** | 真实 ws(`wss://stream.binance.com`),带重连/心跳;仅 1 处 logger 耦合,替换即可 |
| 风控 14 规则 | `risk/rules/*.ts` | 已有同源 | financial-agent 已有(`riskEngine.ts`);新增 `maxDailyAutoTrades`(§8) |
| **常驻监控循环调度器** | —— | **新建** | staging 只有单次评估,无周期调度。本设计核心(§5) |
| **价格历史缓冲 + K线回填** | —— | **新建** | staging 行情仅 REST 点查;rolling 窗口需缓冲(§5.1) |
| **策略持久化 + 成本基准/当日盈亏** | —— | **新建** | JSON 文件(§7) |
| **行情 websocket(可选,后续)** | —— | 后续 | staging 无行情 ws,仅订单 ws。v1 先 REST 轮询 |

**说明:** staging 的 actions/adk 层有 38 处 `@elizaos/core` 耦合,但那是接入 elizaOS runtime 的胶水,financial-agent 用自己的 MCP 工具/subagent 替换,无需移植。

---

## 3. 整体架构

```
┌─────────────────┐
│  Frontend (SPA) │ ← 本期不实现(策略面板 + 护栏设置页,后续单独设计)
└────────┬────────┘
         │ SSE/轮询 (复用现有 approval 机制)
┌────────▼────────────────────────────┐
│   Node.js Server (/src/server/)     │
│  - 策略激活 approval endpoint (新增)  │
│  - 策略状态查询 endpoint (新增)       │
└────────┬────────────────────────────┘
         │
    ┌────┴─────────────────────────────────┐
    │                                       │
┌───▼──────────────┐   ┌───────────────────▼────────────────┐
│ Trade Subagent    │   │ Strategy Monitor (新建,常驻调度器)   │
│ (LLM驱动)         │   │ - setTimeout 自调度循环(非 setInterval)│
│ - nlToDSL 生成草案 │   │ - 维护价格缓冲(K线回填)              │
│ - cex_create_strategy│ │ - 调 runStrategyOnce() 评估触发      │
└───┬──────────────┘   │ - 触发: 规整→风控→幂等下单           │
    │                   │ - 更新状态/落盘/记录执行日志          │
    │                   └───────────┬─────────────────────────┘
    │              ┌────────────────┤
    │              │ (移植自 staging)│
    ▼              ▼                ▼
┌──────────────────────────────────────────────────┐
│  移植组件: strategyDSL / strategyRuntime / nlToDSL  │
│  idempotency / binanceQuantization / backtest      │
│  binanceUserDataStream(订单/余额实时)               │
└─────────────────┬─────────────────────────────────┘
                  │
┌─────────────────▼──────────────────────────────────┐
│  Strategy Store (data/strategies/*.json)            │
│  + executions.log.jsonl + cost_basis + daily_pnl    │
└─────────────────┬───────────────────────────────────┘
                  │
        ┌─────────┴────────────┐
        │  MCP Trading Tools    │
        │  cex_create_order     │ ← Monitor 直接调用(server端,不经过LLM)
        │  get_ticker/get_balance│   幂等键防重复;复用风控硬上限
        │  Risk Engine          │
        └─────────┬─────────────┘
                  │  [Binance API, spot only]
```

**关键设计点:**

- Strategy Monitor 是**确定性后台循环**,不经过 LLM——触发后直接走"规整→风控→幂等下单",低延迟可预测。
- LLM 只负责"创建策略草案"(借 `nlToDSL`);用户一次性确认激活后完全自动化。
- 风控硬上限(kill switch、单笔/日亏损/日笔数上限、白名单、行情新鲜度等)执行时强制复核,策略配置不可绕过。
- 订单/余额用移植的 **websocket 用户数据流**实时获知成交,替代轮询;**行情价格** v1 仍 REST 轮询 + K线回填(行情 ws 留待后续)。

---

## 4. 策略 DSL 扩展(我们的价格触发类型)

移植 staging 的 `strategyDSL`(信号 + entry/exit 规则模型)作为基座,**新增一类价格触发信号**,覆盖你的核心用例。新增的 trigger 模型:

```typescript
interface PriceTrigger {
  type: "rolling_change" | "absolute_threshold" | "trailing_stop";
  direction: "up" | "down";
  pct?: number;             // rolling_change / trailing_stop
  window_minutes?: number;  // 仅 rolling_change
  price?: number;           // 仅 absolute_threshold(电平判定,创建时校验,见 §6)
  reference_price?: number; // trailing_stop 运行高/低水位,每次抬高即持久化(§5.4)
  confirm_samples?: number; // N 连续确认防插针,默认 2(§5.2)
}
```

**语义(关键决策):**

- **`rolling_change` 采用「回撤语义」(drawdown),非端点对端点净变化:**
  - `down`: `(rolling_high_in_window − current) / rolling_high_in_window >= pct`
  - `up`:   `(current − rolling_low_in_window) / rolling_low_in_window >= pct`
  - 衡量"现价相对窗口内滚动 high/low 的回撤/反弹幅度"。V 型行情(先跌 8% 再反弹到 −2%)也能正确触发止损,不被反弹掩盖。
- **`absolute_threshold`** 电平判定;`down`: 现价<price 即满足。创建/激活时校验"是否已满足",已满足则拒绝并提示(§6),避免激活即触发。
- **`trailing_stop`** 追踪止损/止盈;用 K线 high/low 抬锚,锚点持久化(§5.4)。

**动作(action)** 沿用 staging 的 `orderSpec`,但限定:

```typescript
action: {
  side: "buy" | "sell";
  size: { type: "pct_of_position" | "pct_of_portfolio" | "fixed_quote_usd" | "fixed_base_qty"; value: number };
  order_type: "market" | "marketable_limit";   // 不支持普通 limit(§5.5)
  max_slippage_bps?: number;                    // 仅 marketable_limit,默认 50
}
```

**复现(recurrence):**

```typescript
recurrence: {
  mode: "one_shot" | "recurring";   // 默认值由 trigger.type 决定,LLM 可覆盖
  cooldown_minutes?: number;        // recurring 生效
  reanchor: boolean;                // 触发后参考价是否重置
  max_triggers?: number;            // 可选,不填即不限次数(§9 兜底)
  trigger_count: number;            // 运行时维护
}
```

默认语义:`trailing_stop` 与"止损止盈型"`rolling_change`/`absolute_threshold` → 默认 `one_shot`;"DCA 摊薄型" `rolling_change` → 默认 `recurring` + `reanchor=true` + `cooldown`。

**护栏(guardrails)/风控参数全部可选**,未设用全局默认值,前端单独设置页配置(§8.1)。

---

## 5. Strategy Monitor(新建,`src/trading/strategyMonitor.ts`)

这是 staging 缺失、本设计的核心:把单次的 `runStrategyOnce()` 包成常驻周期调度。

### 5.1 价格历史缓冲 + K线回填(`src/trading/priceHistory.ts`)

- 内存环形缓冲:`{ symbol -> [{ ts, high, low, close }] }`,每 symbol 保留最近 ~1 小时。用 K线(OHLC),high/low 正好供回撤语义,天然抗插针。
- **窗口回填(关键)**:策略激活时、服务重启加载 active/running 策略时,先用 Binance klines 接口拉取覆盖 ≥`window_minutes` 的历史 K线回填。于是 `rolling_change` **立即**可正确评估,不存在"数据不足时用短窗冒充长窗"的假触发。回测引擎已有的 klines 历史源(`RealOhlcvDataSource`)可复用。
- 回填后主循环每轮用最新 ticker/最近 K线增量更新尾部。

### 5.2 主循环(自调度,默认 5-10s;`setTimeout`-after-completion,非 `setInterval`)

```
循环(上一轮完成后再排下一轮,避免重入):
1. 收集所有 active 策略涉及的 symbol(去重),每 symbol 仅一次 get_ticker/kline
2. 增量更新价格缓冲
3. 遍历 active 策略,调 runStrategyOnce() + 我们的 PriceTrigger 评估:
   - rolling_change(回撤): 窗口内滚动 high(down)/low(up) → 现价回撤/反弹幅度 ≥ pct
   - absolute_threshold: 现价 vs 阈值(电平)
   - trailing_stop: 维护 reference_price,算回撤
   防插针: 条件须连续 confirm_samples 次(默认2)都满足才算触发,单次满足只记数
4. 连续确认达标 -> 状态 running { strategy_id, execution_id, started_at }
5. 算 size(实时重拉 get_balance,不用循环开始的快照;见 §5.3 跨策略)
6. §5.6 规整数量/价格 -> 风控硬规则评估(§8)
   - 拦截 -> 记 block 原因; one_shot→paused(需人工关注); recurring→active
   - 通过 -> cex_create_order(strategy_id, source="auto_strategy", client_order_id=幂等键)
7. 写 executions.log.jsonl,更新成本基准/当日盈亏(§7.1),更新策略状态文件
8. running -> one_shot 转 completed;recurring 转 active(重置 reference_price + cooldown)
```

订单成交由移植的 **binanceUserDataStream(websocket)**实时回报,驱动 running→completed/active 的转换与对账,替代轮询。

### 5.3 跨策略仓位重叠避免(同 symbol 串行 + 实时余额)

多策略作用同一资产时,若各自基于同一余额快照算百分比会超卖。v1:**同一 symbol 串行**(一笔下单+对账确认完成才处理该 symbol 下一个策略)+ **下单前实时重拉余额**。不同 symbol 仍可并发。

### 5.4 trailing_stop 锚点维护与持久化

锚点(`down` 高水位/`up` 低水位)每次抬高即写入 `strategy-<id>.json`,重启从磁盘恢复真实水位,**不倒退到当前价**(否则白让利润保护)。用 K线 high/low 抬锚,避免采样间隙错过极值。

### 5.5 订单类型:仅 market 与 marketable_limit

普通 `limit` 可能永不成交 → 策略卡死 running、阻塞同 symbol 其他策略,v1 不支持。止损用 **marketable_limit(带最大滑点保护的可成交限价单)**:挂在「现价 ∓ `max_slippage_bps`」保护价,盘口够厚即刻成交,崩太狠时剩余挂保护价等待,绝不成交在更差价。既执行止损又有滑点下限,且不因 slippageCap 把整单 block 掉。

### 5.6 数量/价格规整(移植 binanceQuantization)

仓位原始数量几乎一定不满足交易所精度过滤器(与风控 `minOrderSize` 名义额下限是两回事)。下单前:拉 `exchangeInfo` 的 LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL(缓存)→ 数量向下取整到 stepSize(卖出向下更安全)→ 保护价取整到 tickSize → 规整后低于 minQty/minNotional 则记 "skipped: below exchange minimum",one_shot 转 paused 提示、recurring 回 active。

---

## 6. 状态机与激活流程

状态:沿用 staging runtime 的 `running/paused/stopped` 思想,扩展为策略实例完整生命周期:

```
pending_approval ──(用户激活)──> active ──(连续确认触发)──> running { execution_id, order_id, strategy_id }
                                    ▲                              │ (ws 回报成交/对账完成)
                                    │                              ▼
                       (recurring: 重置锚点+cooldown) ◄──┬── one_shot? ──> completed
                                                          └── 否 ──> active
                              (用户暂停/取消,仅 active/paused 可操作)
                                    ▼
                            paused / cancelled
风控拦截或下单失败: one_shot→paused(failure_reason,需人工关注); recurring→active
```

`running` 作用:Monitor 评估时跳过 running 策略避免重复触发;`running.execution_id` 关联执行日志与对账。重启见 §10。

**`absolute_threshold` 创建校验**:创建和激活两个时机都校验,若现价已满足条件则**拒绝并提示用户**确认("BTC 当前 $58,000,已低于设定 $60,000,请确认意图"),用户确认后方可强制创建。

**激活流程(复用现有 approval 机制):**
1. `cex_create_strategy` 后记 `approval_required` 事件,状态 `pending_approval`。
2. 新增 `POST /agents/:agentId/cex-workflow/strategy-approval` 处理激活/拒绝。
3. 激活 → `active`,Monitor 开始监控,后续触发无需再确认;拒绝 → `cancelled`。

---

## 7. 持久化(全部落盘)

```
data/strategies/
  strategy-<id>.json      # 完整策略 + 状态(含 trailing_stop 锚点)
  executions.log.jsonl    # 追加: { ts, strategy_id, execution_id, order_id, client_order_id, trigger_snapshot, order_result, realized_pnl? }
data/trading/
  cost_basis.json         # { asset -> { qty, avg_cost_usd } } 移动加权平均
  daily_pnl_<UTCdate>.json# { date, realized_pnl_usd, trade_count }
  risk_config.json        # 全局护栏默认值(前端设置页读写)
```

所有交易状态全部持久化,保证服务重启后风控护栏(`dailyLossLimit`、成本基准、trailing 锚点、当日笔数)不被清零绕过。`strategy-*.json`/`cost_basis.json`/`daily_pnl_*.json`/`risk_config.json` 原子写(临时文件 + rename);`executions.log.jsonl` 仅追加。

### 7.1 成本基准与当日盈亏

- **成本基准**:每笔买入成交移动加权更新持仓均价;每笔卖出按均价结转已实现盈亏并减持仓。落盘。
- **当日已实现盈亏**:每笔自动单成交 `realized_pnl = (成交价 − 成本均价) × 数量 − 手续费`,累加落盘;`trade_count`+1。
- 风控 `dailyLossLimit` 与 `maxDailyAutoTrades` 读这两个持久化文件,重启从磁盘恢复。
- 跨自然日(UTC,可配置时区)滚动到新 `daily_pnl_<date>.json` 并归零。

---

## 8. 风控集成

复用 financial-agent 已有的 `riskEngine.evaluate(intent, context, rulesToRun)`(与 staging `risk/rules/*` 同源),策略执行时固定运行以下硬规则(配置不可绕过):

- `killSwitch` / `liveTradingGlobalKill`
- `assetAllowlist`
- `maxOrderSize` / `exposureCap`
- `dailyLossLimit`(读持久化当日已实现亏损,重启不清零)
- `maxDailyAutoTrades`(**新增**):读持久化当日 `trade_count`,达上限拦截所有自动单(手动单不受影响),默认 50 笔/天可配;重启不清零。防跑飞策略一天打出大量单的总闸
- `marketDataFreshness`
- `cooldown` / `reconciliationHealth`

`guardrails.max_notional_usd` 与全局 `maxOrderSize` 取较小值。下单走移植的幂等路径(`deriveClientOrderId`),自带防重复提交。

### 8.1 护栏参数均可选(带默认值),前端单独页面配置

所有风控/护栏参数(`maxOrderSize`/`exposureCap`/`dailyLossLimit`/`maxDailyAutoTrades`/`max_slippage_bps`/`confirm_samples`/`max_triggers` 等)均可选,未设用 `risk_config.json` 全局默认。提供**独立前端设置页**集中查看/修改(具体设计随前端面板后续讨论);本期后端保证全局默认配置文件 + 读写接口。

---

## 9. 新增 MCP 工具(`mcp_tools/trading/`)

| 工具 | 作用 |
|---|---|
| `cex_create_strategy` | 借移植的 `nlToDSL` 把用户描述编译成策略草案,写盘,状态 `pending_approval`,返回 `strategy_id` |
| `cex_list_strategies` | 列出策略(按 status 过滤),返回现价、距触发还差多少、状态 |
| `cex_get_strategy` | 单策略详情 + 关联执行历史(过滤 `executions.log.jsonl`) |
| `cex_update_strategy` | 暂停/恢复/取消(状态转换校验:仅 active/paused 互转,running/completed/cancelled 不可逆) |
| `cex_backtest_strategy` | (可选,移植 `backtest/runner`)对策略跑历史回测,返回夏普/回撤/胜率等 |

订单与策略关联:`cex_create_order` 新增可选 `strategy_id` + `source: "manual"|"auto_strategy"`(默认 manual),随订单持久化并传给对账,双向可追溯。

`reanchor`+`recurring` 的 DCA 在单边下跌会"接飞刀";`max_triggers` 可选(不填即不限次),资金耗尽风险由 `exposureCap`/`dailyLossLimit`/`maxDailyAutoTrades` 三层兜底,用户需自行评估敞口。

---

## 10. 错误处理与重启

| 场景 | 处理 |
|---|---|
| `get_ticker` 失败 | 跳过本轮该 symbol,warning,下轮重试 |
| 风控拦截 | 记 block 原因;one_shot→paused(需人工关注);recurring→active |
| 下单失败(API) | 同上,写 `failure_reason` |
| 服务重启 | 从 `data/strategies/*.json` 重载 active/running;K线回填价格窗口;`running` 策略用 `client_order_id` 经 websocket/订单查询核实最终结果后再转 completed/active(幂等键保证不重复下单) |

---

## 11. 前端(本期不实现)

独立的"自动策略"界面(策略列表、触发进度、实时价格图表、执行历史、全局风控状态)+ 护栏设置页,留待后续单独设计。本期后端的 MCP 工具与持久化结构需能支撑该界面所需数据。

---

## 12. 测试计划

- **移植组件回归**:随移植带过 staging 的 `__tests__`(strategy.dsl/runtime、idempotency、quantization、risk rules、backtest),保证移植后绿。
- **单元**:新增 PriceTrigger 评估(rolling_change 回撤/absolute_threshold/trailing_stop),边界(窗口数据不足、价格持平、reanchor、confirm_samples 连续确认)。
- **单元**:仓位计算(4 种 size 类型)结合 mock 余额 + 规整。
- **集成**:Strategy Monitor 循环,mock ticker/balance/create_order,验证状态机(active→running→completed/active)、风控拦截、`strategy_id`/`client_order_id` 关联写入、跨策略串行。
- **集成**:激活流程(pending_approval→active)走 approval 端点;`absolute_threshold` 创建校验拒绝路径。
- **集成**:重启场景——`running` 策略经幂等核实、当日盈亏/笔数从盘恢复不清零。

---

## 13. 已知限制 / 非目标

- 仅现货;期货/杠杆后续。
- 仅价格驱动;情绪/新闻信号(DSL 已有字段)本期不接数据源。
- 仅 `market`/`marketable_limit`;普通 `limit` 后续。
- 行情价格 v1 仍 REST 轮询 + K线回填;**行情 websocket** 留待后续(订单/余额 ws 本期即用)。
- `recurring`+`reanchor` 单边下跌"接飞刀"风险依赖三层硬护栏兜底,用户自行评估。
- 单一服务器进程,不处理多实例协调。
- 前端界面 + 护栏设置页后续单独设计。
- 移植引入 `ws`、`zod`、(可选)`@binance/*` 等依赖;websocket 流的 logger 需替换为 financial-agent 的日志。
