# 股票策略 Agent 评测套件

这套评测覆盖美股/ETF 策略的自然语言 DSL、触发准确率和审批/工具隔离不变量。

## 运行方式

```bash
# 确定性套件：不联网，适合 CI
npm run eval

# 自然语言到股票策略 DSL：调用当前配置的 LLM，需要凭证
npm run eval:nl-dsl

```

`npm run eval` 包含：

- 触发回放：将标注的股票价格序列送入真实 `evaluatePriceTrigger` 与确认状态机，统计 recall、false-trigger rate 和 precision。
- 安全不变量：验证策略激活审批状态，以及 `market_data` / `market_research` 与策略工具之间的类别隔离。

`npm run eval:nl-dsl` 复用生产环境的 `trading_operations` Prompt 和四个股票策略工具，检查模型生成的：

- 工具选择；
- 股票/ETF ticker；
- 百分比变化、绝对价格和移动止损等触发参数；
- BUY/SELL、仓位大小、paper/shadow 模式；
- 单阶段或多阶段 recurrence 与 guardrails。

每个 case 都是「定稿方案 → 预期 DSL → 跑模型 → 逐字段比对」：`input` 是已经定好每个参数的执行方案，
`gold` 是预期输出，评分器把模型生成的 `create_strategy` 参数和 `gold` 对照。多阶段评分是顺序无关的，
只校验 `gold` 明确钉住的字段，并额外校验 `depends_on`、`price_anchor` 和 `cancel_group` 构成的依赖结构。

比对之外还有一道 `schema-accepted`：生成的载荷走 `normalizePriceStrategyInput` + `tryParsePriceStrategy`，
即 `create_strategy` 自己那道关。字段逐个对上、整体仍被 schema 拒绝是会发生的——`rolling_change`
漏掉 `window_minutes` 就是这样，读起来每项都对，实际让 agent 赔上整个批次。所以 schema 不过即
不算 intent-match，输出会直接打印拒绝原因。

数据集里 `s01`–`s09` 是 `skills/strategy-design/references/trigger-selection.md`
三种入场形态（pullback / breakout / indicator turn）的具体执行方案，
覆盖支撑位回撤、突破加移动止损、以及 MACD/RSI/均线交叉三类指标入场。

## 目录

```text
scripts/eval/
  run.ts
  nl-dsl.ts
  evals/
    trigger.ts
    invariants.ts
    nlDsl.ts
  datasets/
    trigger-replay/*.json
    nl-dsl.jsonl
    nl-dsl-multiphase.jsonl
  lib/
    metrics.ts
    replay.ts
    report.ts
```
