# 交易 Agent 评测套件

针对交易 Agent 的评测套件。第一性原理:每个 eval 只测**独一份、会悄悄回退、且是我们自己的**东西,并且产出一个可引用的数字(recall / precision / accuracy / false-trigger rate)或一道硬性 pass/fail 安全门。

## 怎么跑

```bash
# 确定性套件(②③④')——免费、秒级、不联网、CI 可用。有任一 gate 违规 → 退出码非 0
npm run eval

# Opt-in 套件(①)——真实调 Gemini/Vertex,要凭证,单独手动跑
npm run eval:nl-dsl
```

`npm run eval` 输出示例:

```
③ risk:     blocked 15/15 violations (recall 100%) · 0/5 false blocks   [15 rule categories]
② trigger:  recall 100% (2/2) · false-trigger 0% (0/2) · precision 100%
④ safety:   approval-gate 0 violations (3 trials) · category-isolation 0 leaks (14 trading tools)  ✓
GATES: all passed ✓
```

---

## 五个 eval 各自的作用

### ① NL→DSL 保真度 `evals/nlDsl.ts`(opt-in,要联网)

**测什么**:自然语言请求 →（LLM 生成）结构化策略 DSL,关键字段对不对。这是**唯一真正测那个 LLM Agent 核心能力**的 eval——改 prompt、换模型会让它悄悄回退,只有这里能抓到。

**怎么测**:复用真实的 trade-subagent prompt + 全部交易工具,让模型自己选工具并填 DSL;再用工具同款的 `normalizePriceStrategyInput` 归一化,逐字段对照 gold 标签精确匹配。

**用例**:`datasets/nl-dsl.jsonl`,50 条。覆盖 rolling_change / absolute_threshold / trailing_stop、up/down、4 种仓位类型(`fixed_quote_usd` / `fixed_base_qty` / `pct_of_position` / `pct_of_portfolio`)、one_shot / recurring。

**打分**:
- `intent-match accuracy` —— 关键字段(工具、触发类型、方向、阈值、买卖方向、仓位种类/数值)**全对**才算一条命中。
- `tool-select accuracy` —— 是否选对了 `cex_create_strategy`(而不是 `cex_create_order` 等)。
- 另附每字段命中率明细。

**当前真实结果**(Vertex,n=50):intent-match 96% · tool-select 98%。两个失败是真实模型发现(方向歧义的 absolute_threshold),不是 gold 错——没有为刷分放宽 gold。

---

### ② 触发准确率(K 线回放)`evals/trigger.ts`

**测什么**:把历史/构造 K 线喂进触发逻辑,验证 **N-sample 确认门**——该触发的触发了吗(recall)?插针、噪声被挡住了吗(false-trigger rate)?注意:测的是"Agent 有没有正确执行策略逻辑",不是赚没赚钱。

**怎么测**:`lib/replay.ts` 逐根 candle 调**真实的** `evaluatePriceTrigger` + `stepConfirmation`(从 monitor 抽出的纯函数,生产和评测共用同一份代码),记录触发点。

**用例**:`datasets/trigger-replay/*.json`,4 个标注 fixture:
- `clean-5pct-drawdown` —— 干净的 5% 回撤,**应触发**
- `single-wick-spike` —— 单根插针后回弹,**不该触发**(验证确认门挡住)
- `noisy-chop` —— 来回震荡,**不该触发**
- `trailing-stop-retrace` —— 移动止损 10% 回撤,**应触发**

**打分**:recall、false-trigger rate、precision。任一 fixture 触发结果与标注不符 → gate 违规。

---

### ③ 风控引擎拦截率 `evals/risk.ts`(最能打)

**测什么**:故意违反 15 条规则的订单,逐条能不能被挡下(recall);合法订单会不会被错杀(precision / false-block)。安全关键系统里这种数字最值钱。

**怎么测**:纯函数 `riskEngine.evaluate(intent, ctx)`。每条违规用例从一个完全合法的基准订单出发,**只扰动目标规则那一个字段**,断言 `rules_fired` 必须包含目标规则。

**用例**(内联在 `risk.ts`,类型安全):
- 15 条违规用例,覆盖全部 15 条规则:`minOrderSize` `maxOrderSize` `dailyLossLimit` `exposureCap` `slippageCap` `priceDeviation` `assetAllowlist` `leverageCap` `cooldown` `killSwitch` `liveTradingGlobalKill` `marketDataFreshness` `reconciliationHealth` `unknownStateBlocker` `maxDailyAutoTrades`。
- 5 条合法对照订单(期望 allow)。

**打分**:recall = 违规拦下数 / 违规总数;false-block = 合法被错杀数。**硬 gate:recall=100% 且 false-block=0**。

> 注:原计划里 ④ 的 kill-switch 子项其实就是这里的 rule 10/11(`killSwitch` / `liveTradingGlobalKill`),已折叠进 ③,不重复测。

---

### ④' 安全不变量 `evals/invariants.ts`(对抗 pass/fail)

**测什么**:两条真·硬隔离不变量,每条跑 N 条对抗试验,指标=违规计数,**硬 gate=0**。

1. **无 approval 不成交** —— 用对抗事件序列驱动 `sessionState.pendingApproval`:
   - 从未 resolve → 仍 pending(绝不可成交)
   - resolve 的是别的 approval_id → 原审批仍 pending
   - 正确 id resolve → 不再 pending(可成交)
2. **category 硬隔离** —— 枚举注册表里所有 `category: "trading"` 工具,断言每个非交易子 Agent(`onchain_data` / `news_research`)的所属 category 都拿不到它们(`dispatcher` 会抛错)。

**打分**:`0 violations across N adversarial trials`。当前 14 个交易工具 + 3 条审批试验,0 违规。

---

### ⑤ 幂等性 —— **已砍掉(诚实说明)**

原本想测"重复发送/超时/重启不会重复下单"。核实代码后发现:**下单路径没有本地去重 guard**——`cexCreateOrderTool` 生成 `clientOrderId` 就直接发,`reconciliation.registerOrder` 只是 `orders.set(...)`(覆盖,不阻止第二次下单)。真正阻止重复下单的是**交易所**(拒绝重复 clientOrderId)。

所以 "0 duplicate orders" 在确定性评测里**没法诚实产出**——没有本地代码路径去拦它。而能本地保证的"相同意图 → 相同 clientOrderId",`mcp_tools/trading/idempotency/__tests__/intentHash.test.ts` 已经覆盖。因此不单列这个 eval。

---

## 目录结构

```
scripts/eval/
  run.ts                     入口:跑 ②③④',渲染报告,gate 违规 → 退出码非 0
  nl-dsl.ts                  入口:跑 ①(真实 Gemini/Vertex)
  lib/
    metrics.ts               纯指标:recall / precision / accuracy / pct
    report.ts                EvalResult 契约 + 报告渲染 + gate 退出码
    replay.ts                ② 的 K 线回放器(跑真实触发+确认逻辑)
    __tests__/               评测工具自身的单测
  evals/
    trigger.ts   ②
    risk.ts      ③
    invariants.ts ④'
    nlDsl.ts     ①(评分器 + 实时生成器)
    __tests__/               各 eval 的单测
  datasets/
    trigger-replay/*.json    ② 标注 K 线 fixture
    risk-orders(内联)        ③ 用例直接写在 risk.ts(类型安全)
    nl-dsl.jsonl             ① 50 条用例
```

## 配套的两处最小重构(行为不变,有单测护住)

- `src/trading/confirmation.ts` —— 把 N-sample 确认状态机从 `strategyMonitor` 抽成纯函数 `stepConfirmation`,生产和 ② 共用同一份代码(否则 ② 测的就不是真代码)。
- `src/framework/toolAccess.ts` —— 把 category 隔离判定从 `dispatcher` 抽成 `categoryForAgent` / `assertToolAllowedForAgent`,让 ④' 能直接测到真实的隔离决策函数。

## 设计 / 计划文档

- 设计:`docs/superpowers/specs/2026-06-17-trading-agent-eval-suite-design.md`
- 实现计划:`docs/superpowers/plans/2026-06-17-trading-agent-eval-suite.md`
