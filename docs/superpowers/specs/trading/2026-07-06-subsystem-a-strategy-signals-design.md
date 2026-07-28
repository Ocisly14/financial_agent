# 子系统 A:策略生成增强 + 骨架(SignalContext / StrategyEngine)详细设计

日期:2026-07-06
状态:方案(待评审)
上位 spec:`2026-07-03-web3-strategy-loop-design.md`(顶层伞状架构)
范围:三个子系统里的**第一个**。落地共用骨架 + 让 agent 能生成"价格 + TA + 链上/情绪"复合信号策略。回测(B)、优化内环(C)不在本 spec。

---

## 1. 目标与非目标

### 目标
1. **runtime 切换到完整 `strategyDSL`**(signals / entries / exits / risk),干净替换现有 `priceStrategy`,不做后兼容包裹。
2. **统一信号分类法**:把现有 3 个价格位移触发也归为 signal,与 TA / 链上 / 情绪并列;rules 统一引用 signal。
3. **落地骨架**:`SignalContext` 接口 + `StrategyEngine.evaluate` 纯核心,供 monitor(实盘)驱动;为 B/C 预留同一驱动面。
4. **rules 支持全量嵌套布尔**(and/or/not 任意组合),表达 web3 复合条件。
5. **tool + prompt + 评测集全部重写**到 strategyDSL,守住 NL→DSL 生成保真度。

### 非目标(留给 B / C)
- `HistoricalSignalContext` 与历史链上/情绪数据源 → **子系统 B**。
- 生成→回测→优化内环、参数扫描、绩效记忆 → **子系统 C**。
- 组合级/多标的 → 远期。
- 旧 priceStrategy draft 的迁移 → **不做**(干净切换,旧 draft 可废弃)。

---

## 2. 骨架:SignalContext + StrategyEngine

### 2.1 `SignalContext`(信号数据面,接口)

按时间戳提供一次评估所需的全部信号值。**A 只实现 `LiveSignalContext`**(实盘拉源);`HistoricalSignalContext` 由 B 实现同一接口。

```
interface SignalContext {
  // 返回某 signal 在时刻 t 的值;数据不可用时返回 { available: false }
  valueOf(signalId, t): { available: true, value: number } | { available: false }
}
```

- 有状态信号(rolling_change 需窗口序列、trailing_stop 需 reference 追踪)的**状态**不放进 SignalContext;SignalContext 只暴露"当前可算出的原始量",状态由 StrategyEngine 的 `state` 承接(见 2.2)。
- "数据不可用"是一等返回值;上层对不可用有确定性行为(默认该 signal 判为 false / 不触发)。实盘与回测(B)共用这套语义,保证对齐。

### 2.2 `StrategyEngine.evaluate`(纯核心)

```
evaluate(dsl: StrategyDSL, ctx: SignalContext, state: EngineState, t) 
  → { decisions: OrderIntent[], nextState: EngineState }
```

一次评估的链路:

```
signals[]  ──(SignalContext.valueOf)──►  每个 signal 求值(含"不可用")
    │
    ▼
entries[]/exits[].when  ──(ruleSchema 递归求值:and/or/not/lt/gt/…)──►  bool
    │  命中
    ▼
.then (orderSpec)  ──►  OrderIntent(side/order_type/sizing/tif)
```

- **纯函数**:同 `(dsl, ctx, state, t)` → 同输出。无 I/O、无时钟依赖(t 显式传入)。
- `EngineState` 收纳:每 signal/phase 的确认计数(复用 `confirmation.ts::stepConfirmation`)、trailing_stop 的 reference_price、recurrence 触发计数与 cooldown 时间戳。
- **三方共用**:monitor(实盘)、backtest(B)、eval-replay(②)都调这一个 evaluate。

---

## 3. 统一信号分类法

signal 的 `kind` 枚举(扩展现有 `signalSchema`):

| 家族 | kind | 关键 params | 有状态 |
|---|---|---|---|
| 价格位移 | `price.rolling_change` | pct, window_minutes, direction, confirm_samples | 是(窗口) |
| 价格位移 | `price.threshold` | price, direction, confirm_samples | 否 |
| 价格位移 | `price.trailing_stop` | pct, direction, reference_price?, reanchor | 是(anchor) |
| 技术指标 | `price.rsi` | period, (阈值在 rule 里比) | 否 |
| 技术指标 | `price.sma_cross` / `price.ema_cross` | fast, slow | 否 |
| 技术指标 | `price.atr_band` | period, mult | 否 |
| 量能 | `volume.zscore` | window | 否 |
| 链上 | `onchain.exchange_netflow` / `onchain.whale_netflow` / `onchain.tx_volume` | window | 否 |
| 情绪 | `sentiment.fear_greed` | — | 否 |

- signal 只**产出一个数值**(或不可用);**阈值比较放进 rule**(如 `rsi < 30`)。这让同一 signal 能被不同 rule 复用。
- A 全部实现 `LiveSignalContext` 里这些家族的求值:价格/TA/量能从 K 线现算(移植 `indicators.ts`);链上/情绪调现有 onchain / 情绪工具。

---

## 4. rules:全量嵌套布尔

- 沿用现有 `ruleSchema`(`op ∈ {lt,lte,gt,gte,eq,and,or,not,between}`,args 可递归含子 rule / signalId / 常量)。
- entries/exits 各是 `{ id, when: rule, then: orderSpec }`。
- StrategyEngine 递归求值 `when`;叶子 `lt/gt/…` 的一侧是 signalId(经 SignalContext 求值)、另一侧是常量或另一 signal。
- **不可用信号的布尔语义**:参与比较的 signal 不可用 → 该比较为 false(默认不触发);在 `not` 下同样按 false 传播(不反转成 true)。写进 StrategyEngine 契约并由 eval 固定。

---

## 5. runtime 重写(干净切换)

- `strategyMonitor.ts`:改为对每个 active 策略调 `StrategyEngine.evaluate`;确认门、trailing anchor 持久化、recurrence 收敛逻辑从"逐 phase"迁到"逐 entry/exit + EngineState"。
- `strategyExecutor.ts`:消费 evaluate 产出的 `OrderIntent[]`,走现有下单/风控/paper venue 路径(不变)。
- `strategyStore` / `StoredStrategy`:`dsl` 字段类型从 `PriceStrategyDSL` 换为 `StrategyDSL`;`priceStrategy.ts` 及其 normalize 退役。
- `priceHistory.ts`:保留为 `LiveSignalContext` 的价格/K 线来源。

**边界收益**:monitor/executor 不再懂具体触发类型,只懂"evaluate → 下单";新增信号只动 SignalContext + signal 枚举,不动执行层。

---

## 6. 工具与 prompt 重写

- `cex_create_strategy` 的 inputSchema 从 `phases[]` 改为 `signals[] / entries[] / exits[] / risk`,字段名/枚举对齐 strategyDSL。工具描述与"缺字段就停、不臆造"的护栏保留。
- trade 子 agent prompt:补充统一信号分类法与"signal 出数值、阈值在 rule 比"的表达范式,给复合条件示例(如 `RSI<30 AND onchain.exchange_netflow<0 → BUY`)。
- 归一化层(对标现有 `normalizePriceStrategyInput`)重写为 strategyDSL 版,容忍模型的字段别名。

---

## 7. 评测(重写 + 迁移)

- **① NL→DSL**:50 条数据集重写为 strategyDSL gold;新增覆盖 TA / 链上 / 情绪 / AND-OR-NOT 复合条件的用例。逐字段精确匹配口径不变。
- **② 触发回放**:`replay.ts` 迁移到统一 `StrategyEngine.evaluate`(而非旧 priceTrigger 直调),fixture 语义不变,顺带验证信号求值。
- **③④'**:风控与安全不变量不受影响,回归跑通即可。

---

## 8. 错误处理与确定性

- SignalContext 求值抛错/超时 → 归一化为"不可用"(fail-safe 不触发),不让实盘因单个数据源抖动误触发。
- StrategyEngine 全程纯函数、无时钟;`t` 与所有外部量经 ctx/state 显式传入 —— 这是 ⑤(回测确定性)与 ②(回放)成立的前提。
- trailing_stop anchor、recurrence 计数等状态每次变化即经 store 持久化(延续现有"重启不回吐收益"保证)。

---

## 9. 交付边界(本子 spec 完成即)

agent 能生成一份含 TA/链上/情绪复合条件的合法 strategyDSL → 存 draft → 经审批 → monitor 用 StrategyEngine 实盘评估执行;① NL→DSL 与 ②③④' 全绿。**回测按钮尚不存在(B),优化内环尚不存在(C)。**
