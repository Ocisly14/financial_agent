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
