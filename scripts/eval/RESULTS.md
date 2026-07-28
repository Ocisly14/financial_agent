# 交易 Agent 评测结果分析报告

**最后更新**:2026-06-18
**被测对象**:交易 Agent 评测套件 ①②③④'
**LLM 配置**(仅 ①):Vertex / Gemini,`modelClass=MEDIUM`,`temperature=0`,并发 10
**确定性套件**:纯函数,离线,可复现

> ① 是真实 LLM 调用,`temperature=0` 但非位级确定,重跑可能 ±几个百分点抖动。②③④' 完全确定。

---

## 一、总览(最终)

| Eval | 指标 | 结果 |
|---|---|---|
| ③ 风控拦截 | recall / false-block | **15/15 拦截(100%) · 0 误杀** |
| ② 触发回放 | recall / false-trigger | **100% / 0%** |
| ④' 安全不变量 | 违规数 | **0**(审批门 + 14 工具隔离) |
| ① NL→DSL 单阶段 (n=30) | intent / tool-select | **100% / 100%** |
| ① NL→DSL 多阶段 (n=100) | intent / tool-select | **100% / 100%** |
| ① 多阶段细分 | phase-count / per-phase / guardrails | **100% / 100% (217/217) / 100% (19/19)** |
| 本地单测 | pass | 全过(含新增 sizing / confirmation / toolAccess) |

确定性套件全部 gate 通过,`npm run eval` 退出码 0。

---

## 二、确定性安全套件(②③④')

- **③ 风控**:15 条违规订单逐条覆盖全部 15 条规则(含 kill-switch / global-kill),全部拦下;5 条合法订单 0 误杀。
- **② 触发**:4 个标注 fixture 经真实 `evaluatePriceTrigger` + `stepConfirmation` 回放,该触发的全触发、插针/噪声全被 N-sample 确认门挡住。
- **④' 安全不变量**:无 approval 不成交(3 对抗序列)+ category 硬隔离(14 个交易工具)= 0 违规。

---

## 三、① NL→DSL 保真度

### 单阶段 (n=30):100% / 100%
覆盖 10 种 触发×方向×买卖 组合,含动量买入(rolling up + BUY)、移动入场(trailing up + BUY)。

### 多阶段 (n=100):100% / 100%
100 条 / 217 phase。覆盖:2–5 阶段 DCA 跌幅梯、分层止盈、建仓+止盈+止损、绝对价梯、移动止损/移动入场、递归(max_triggers/cooldown)、4 种仓位类型、guardrails(budget/max_notional/双)、mode(live/shadow)、order_type/slippage、confirm_samples、reanchor。

> 达到 100% 的过程并非一蹴而就——是反复用 raw 输出区分「模型错」与「gold/NL 错」、逐个修正测试集本身的结果。详见第五节。

---

## 四、本轮架构与产品改动(从 81% → 100% 的真正原因)

### 1. 结构化 schema 注入(框架级)
**问题**:`formatAllowedTools` 原本只注入「散文描述 + 顶层参数名」,嵌套字段名(如 `guardrails.max_notional_usd`、phase 子字段)从不出现在模型可见文本里 → 模型只能编字段名(`max_notional_per_order_usd`),而 zod 静默 strip → 风控约束丢失。

**改动**:
- `src/framework/subagent.ts`:新增递归 schema 渲染器(枚举、`*`=required、嵌套展开),导出 `formatAllowedTools`。
- `mcp_tools/trading/strategyTools.ts`:`cex_create_strategy` 的 `inputSchema` 填满嵌套结构;description 从 ~16 行精简到 4 句(纯行为/路由规则)。
- 30 个 tool 全部注入结构化 schema(审计 0 结构缺口)。
- eval 改用框架导出的 `formatAllowedTools`,所见即真实。

**效果**:guardrails 保真度 70% → **100%**,且在 100 条规模上稳定。

### 2. 三个订单/策略工具描述重写
`cex_create_order` / `cex_prepare_order` / `cex_create_strategy` 描述按「立即成交 vs 未来价格条件触发」重写,互斥点名彼此,消除路由歧义。

### 3. 修复产品 bug:`pct_of_portfolio` 执行器实现(选项 B)
**问题**:schema/normalize 都支持 `pct_of_portfolio`,但执行器 `return { qty: 0, "not supported in v1" }` → 用户能创建一个「触发时静默跳过、永不成交」的策略。

**改动**(`src/trading/strategyExecutor.ts`):
- 新增 `resolvePortfolioValueUsd()`:live 余额按市价估值优先,否则 cost-basis 持仓按市价(回退账面成本);稳定币 $1。
- 抽出纯函数 `quantityFromSize()`,`pct_of_portfolio` = 组合市值 × 百分比 ÷ 价格。
- 新增 `src/trading/__tests__/sizing.test.ts`(5 例,覆盖 4 种 sizing)。
- schema / normalize / 执行器三者一致,fail-loud 而非静默空跑。

---

## 五、迭代中发现的「测试集 vs 真模型」问题(诚实记录)

多阶段从 81% 爬到 100% 的过程中,绝大多数「失败」核查 raw 后是**测试集本身的问题**,不是模型能力问题:

| 问题类 | 表现 | 真相 | 处理 |
|---|---|---|---|
| 窗口传播 | 止盈/次腿 NL 没写时间窗 | 模型按规则正确拒绝(不编数字) | 每个 rolling 腿补显式窗口 |
| `pct_of_position` 语义 | "trail the rest" 模型填 100,gold 填 50 | 执行器按**当前持仓%**算,模型对 | gold 对齐 + 措辞去歧义 |
| guardrail 字段名 | 模型用 `max_notional_per_order_usd` | schema 字段名没注入给模型 | 见第四节①(schema 注入) |
| 预算→recurring | "$2000 预算 / $500 单笔" 模型推断 recurring | 合理推断 | NL 改为显式 recurring + max_triggers |
| 方向歧义 | "hits/reaches X" 的 absolute 方向 | NL 本身歧义 | 精简单阶段集时剔除 |

**沉淀**:`scripts/eval/_lint-multi.ts` 固化了结构化检查(枚举/required/窗口/guardrail key/百分比浮点),改数据集后复跑可挡住大部分 gold 退化。

---

## 六、已知边界 / 后续

- `reference_price`(trailing 显式锚点)仍被 `normalizeTrigger` 丢弃(未拷贝)——本套件故意不评测;若要支持需在 normalize 补传。
- `pct_of_portfolio` 估值为「全持仓市价之和」,不含未跟踪的现金余额;live 路径每个资产一次取价,触发频率低可接受。
- 多阶段 100% 是当前数据集 + 当前模型的快照;扩更多边界用例仍可能暴露新短板。

---

## 七、复现命令

```bash
npm run eval          # ②③④' 确定性套件(免费、离线、有 gate)
npm run eval:nl-dsl   # ① 单阶段(30)+ 多阶段(100),实时 Vertex,并发 10
node --experimental-strip-types scripts/eval/_lint-multi.ts   # 改多阶段数据集后跑
```
