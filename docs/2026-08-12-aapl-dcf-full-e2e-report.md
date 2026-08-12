# AAPL DCF 全链路 E2E 验证报告

日期：2026-08-12  
状态：**通过（功能链路）**；估值假设和终值敏感性仍需人工投资判断复核。

## 结论摘要

在完全重新开始、没有预先填入报表映射或模型公式的条件下，DCF agent 已自行完成 AAPL FY2021–FY2025 历史数据提取、报表统一、spine 映射、收入拆分与预测、运营/FCFF 公式、WACC、终值和股权桥，并在一轮内将模型从空白推进到 `valued`。

本次运行的最终模型为 `fm_f4808513-257c-468c-94d7-640b2bd6d3e0`，最终 revision 为 9，生命周期为 `valued`，没有 lifecycle blocker。它验证的重点不是某一个估值数字，而是：在去掉 skeleton 的预设声明和预播种公式后，agent 仍能根据实际取得的数据自行决定一个单元格应来自报表映射、公式还是假设，并能在诊断信息引导下完成全链路。

| 项目 | 结果 |
| --- | --- |
| 历史期间 / 预测期间 | FY2021–FY2025 / FY2026–FY2030 |
| E2E 轮数 | 1 |
| 最终 revision / lifecycle | 9 / `valued` |
| LLM 调用 / agent 工具调用 | 25 / 31 |
| 运行时间 | 1,007,132 ms（约 16.8 分钟） |
| 历史报表覆盖 | 5 份 10-K，三张主表均为 5/5 覆盖 |
| 统一报表 | 72 行；0 个 rollup break；0 个未解决 finding |
| spine 映射 | 37 个映射、12 个明细行、1 个有理由的缺口 |
| 假设数量 / 自定义分析行 | 9 / 0 |

## 本轮要验证的设计

### 1. Skeleton 不再预设数据来源

所有 skeleton 行不再在创建时声明为 `historical: "actual"`、forecast 或公式，也不再给任何历史行预播种公式。历史与预测单元格的来源在实际填表时由统一的声明判断逻辑推导：

- 有已落地的报表事实时，声明为 actual；
- 有模型公式时，声明为 formula；
- 有明确假设时，声明为 assumption；
- 都没有时，保持未完成，让 agent 根据生命周期诊断自行选择补公式或寻找/映射数据。

这避免了把 `cash_available_for_bridge` 一类“并非报表原始科目、而是多个科目求和”的行错误归入“等映射”批次。agent 在本次运行中自行建立了该行的构成，最终历史桥为：现金及短期投资 $54.7B、非经营性投资 $77.7B、债务 $98.7B。

### 2. 生命周期阻塞原因可见

`deriveLifecycle().passes()` 不再只返回一个停留阶段而吞掉精确失败原因。模型概览会返回结构化 `lifecycle_blockers`，包括 `stage`、`code`、`message` 和相关 cell refs。若股权桥缺少 `cash_available_for_bridge@FY2025`，agent 能看到“不为数值”的精确 blocker，而不是仅看到停在 `operations_fcff`；随后自行判断是写公式还是补映射。

### 3. 读取错误不再伪装为成功的空结果

针对相邻的“agent 读错 section 却得到空数组”的问题，工具已将下列无效读取转为可操作的错误：

- 用 `lineItemIds` 精确查询但 section 不匹配；
- `lineItemIds` 与 parent / role / period class 筛选条件相互冲突；
- `get_unified_rows` 请求了未知的显式 row id；
- `get_axis_breakdown` 请求了未知 axis 或 concept。

错误会指出实际 section 或要求先列出可用项目，而不是给出看似正常的零行结果。模糊 member filter 的零命中仍保留为正常业务结果，避免把合法的“无此成员”误报为接口错误。

### 4. Revision 后保留已读上下文，而非全量清空

此前 mutation 后只要 revision 前进，agent 的所有 `workbook_slice` 都被清空。问题不在工具没有返回 DCF 数据，而在 agent 写完 WACC/公式后失去了先前读取的 DCF 上下文，于是重复读取同一 section，形成无效循环。

现在 mutation 只返回概要性的 `model_change_context`：revision、变更 sections、变更 rows，以及每行涉及的来源、公式期间和 assumption ids。agent 自己决定是否需要重新读取具体 section：

- 未重新读取的旧 slice 保留为“历史上下文”，并明确标记其 revision 已旧，不能当作当前数值使用；
- agent 对某 section 进行当前 revision 的读取后，该 section 的旧 slice 被替换；
- 若 revision 前进却没有可解释的变更上下文，仍采取保守清理。

这既不把完整变更数据硬塞入提示词，也不会因无关 mutation 让 agent 忘掉已经完成的表格工作。

### 5. 维度拆分可以进入模型

spine mapping loader 现能提供 `breakdownRows`。本轮成功保留了 Product / Service 一级收入拆分及 iPhone、Mac、iPad、Wearables 等二级明细，agent 因而以两个经济特征不同的收入流建模，而不是仅用一个合并收入增长率。

## 执行方式与验证范围

本次为新建全量运行，命令为：

```bash
node --env-file=.env --experimental-strip-types --experimental-sqlite \
  scripts/xbrl/e2e_test/dcf-agent-e2e.ts --fresh
```

`--fresh` 仅删除并重新建立本次 E2E 的 AAPL 输出目录；未对工作区做 reset 或清理其他文件。运行从 SEC filing 提取开始，没有复用已填的模型 revision，也没有使用预制历史公式。

此外，针对 revision 续跑路径，E2E 脚本已支持：

- `E2E_MODEL_DB_PATH`：指定既有模型数据库；
- `E2E_RESUME_MODEL_ID`：指定从哪一个模型续跑。

该路径曾从旧模型的 revision 5 以干净 agent session 续跑，并在一轮内推进至 revision 11 / `valued`；这验证了新 revision-context 策略不会阻断接力执行。最终的全新运行则是本报告的主验证对象。

## 全链路过程

| 阶段 | 主要产出 | 最终 revision |
| --- | --- | --- |
| 报表提取与统一 | 5 年 10-K；72 个统一行；11 个 breakdown 行；7 个 restatement 记录 | 1–2 |
| Spine 映射 | 37 个映射、12 个 detail rows；1 个有理由缺口 | 3 |
| 历史公式 | 历史运营与桥接相关计算 | 4 |
| 收入预测 | Product / Service 及明细驱动预测 | 5 |
| 运营预测 | 营业利润率、税、D&A、Capex、NWC | 6 |
| FCFF | FY2026–FY2030 FCFF 与折现链 | 7 |
| WACC | 市场参数、资本结构、折现率 | 8 |
| 终值、股权桥与敏感性 | 永续增长与退出倍数两种估值方法 | 9 |

统一报表提交时出现过一次输入校验错误：某个 decision row 缺少必填 `rationale`。agent 随后补齐原因说明、将保留字段 row id `revenue` 改为 `net_sales`，并删除不与合并口径相符的 geographic segment operating-income breakdown。后续提交成功，最终没有 rollup break 或未解决 finding。该问题为一次性、可恢复的数据契约错误；没有出现重复工具循环或必须人工 kill 的严重故障。

唯一保留的 spine 缺口是 `accrued_operating_liabilities`：Apple 的披露将其他流动负债混合在一个科目中，不能可靠拆为目标口径。agent 将此作为明确 gap 保留，而没有伪造一个映射值；其余必需覆盖项均完成。

## 模型关键判断和输入

### 业务与预测判断

- Product 在 FY2021–FY2025 的历史 CAGR 约为 0.8%，属成熟、周期性业务；Services CAGR 约为 12.4%，且收入占比从 18.7% 上升至 26.2%。
- 因此收入未使用单一总增长率，而是分别建模：Products 由低个位数增长驱动，Services 从双位数增长逐步放缓。
- 历史运营利润率从 29.8% 提升至 32.0%；预测延续服务组合改善带来的温和扩张，而非机械保持不变。
- 预测期核心假设：Products 增长约 4.0%–4.5%，Services 增长 12.0% 逐步降至 10.0%，运营利润率由 32.2% 升至 33.4%，税率 16.0%，D&A / 收入 2.9%，Capex / 收入 2.82%，经营 NWC / 收入 -12.8%。

### WACC

最终 WACC 为 **10.29%**。agent 采用的基础输入为：beta 1.20（10 年相对 SPY）、30 年美国国债 5.24% 的无风险利率、4.3% 的隐含 ERP、5.5% 的税前债务成本及 16.8% 的五年平均有效税率。资本结构约为 98% 权益权重，原因是 AAPL 市值远高于约 $99B 债务。

### 终值与股权桥

- 永续增长率：3.5%；
- 退出倍数：20.0x EV/EBITDA；
- 股权桥：`cash_available_for_bridge` $54.697B + 非经营性投资 $77.723B − 债务 $98.657B；租赁负债、优先股和少数股东权益均按零处理。

这些均为 agent 的建模判断和输入，不应被视为独立投资建议或外部市场事实的最终确认。

## 估值输出

| 方法 | 企业价值 | 终值占 EV | 股权价值 | 稀释后每股价值 |
| --- | ---: | ---: | ---: | ---: |
| 永续增长法 | $2.150T | 74.2% | $2.183T | **$145.51** |
| 退出倍数法 | $3.185T | 82.6% | $3.218T | **$214.50** |

显式预测期 FCFF 从 FY2026 的 $124.3B 增至 FY2030 的 $162.6B。两种方法之间每股相差约 $69.0，说明结果对终值设定高度敏感。

已生成两张 5×5 敏感性表：WACC × 永续增长率、WACC × 退出倍数。在基准永续法下，WACC 上下 1% 的每股估值约为 $127.39–$169.91；在基准退出倍数法下，对应约为 $206.72–$222.66。敏感性表运行无诊断错误。

## 质量评价、风险与限制

功能链路已验证通过，但“模型可运行”不等同于“估值结论已充分审阅”。主要限制如下：

1. **终值主导。** 终值占 EV 74%–83%，显式五年预测并不是估值的主要决定因素；3.5% 永续增长率、20x 退出倍数和 10.29% WACC 是最关键的风险输入。
2. **两种终值法差异大。** $145.51 与 $214.50 的差异约 47%，应在投资评审中以敏感性区间呈现，不宜输出单一点目标价。
3. **一个披露口径缺口被诚实保留。** `accrued_operating_liabilities` 未被强行映射，避免产生虚假精确性，但人工审阅时可决定是否采用更精细的注释拆分。
4. **本轮没有自定义分析行。** 核心 DCF 已完成，但尚未额外生成如情景分层、同业倍数桥接、长期服务业务分部利润率等 custom analysis rows；这属于模型研究深度的提升空间，不影响生命周期通过。
5. **市场比较需要独立复核。** agent 在运行摘要中提到其 WACC sheet 内置的市场基准约 $305/股；该数值与同业倍数依据应在正式投资使用前重新抓取并核验日期、来源和单位。

## 已落地的代码与回归验证

本次相关实现主要位于：

- `mcp_tools/financial-model/financialModelTools.ts`：mutation 变更摘要及查询错误的显式化；
- `src/framework/subagent.ts`：revision-aware 的 workbook slice 保留与过期标记；
- `src/framework/__tests__/financialModelProgress.test.ts`：上下文投影的回归测试；
- `scripts/xbrl/e2e_test/dcf-agent-e2e.ts`：指定模型数据库与 revision 的续跑支持。

在最终上下文策略落地后，已运行：

```bash
pnpm build && node --experimental-strip-types --experimental-sqlite --test \
  src/framework/__tests__/financialModelProgress.test.ts \
  mcp_tools/financial-model/__tests__/progressiveModelRead.test.ts \
  mcp_tools/financial-model/__tests__/financialModelTools.test.ts
```

结果为 **33 / 33 通过**。随后运行本报告所述的全新端到端 E2E，结果为 **PASS**。

## 可复核产物

本次运行的全部可审计产物位于 `data/e2e-test/dcf-agent/aapl/`：

- `summary.json`：总结果、模型 id、生命周期、估值和敏感性；
- `run-config.json`：运行配置；
- `events.jsonl`、`notes.jsonl`、`steps/index.jsonl`：agent 过程记录；
- `model/revisions.json`：revision 演进；
- `model/final-snapshot.json`：最终模型快照；
- `model/source-review.json`：来源和覆盖审阅；
- `rounds/round-1.json`：本轮任务的完整摘要。

## 最终判定

**工程验收：通过。** 从空白的、无预设声明 / 无预播种公式的 skeleton 出发，agent 已能完成 DCF 到 `valued` 的完整闭环；生命周期阻塞可解释、错误读取不再静默为空、revision 后的上下文不会被不必要地全量清空，且两条估值终值路径和敏感性均有可复核输出。

**研究验收：待人工复核。** 下一步应优先审阅终值范围、WACC 的外部市场参数、Products / Services 增长与利润率假设，以及是否需要补充情景/同业分析行。该报告不构成证券投资建议。
