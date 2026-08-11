# DCF 引擎 legacy 清理与端到端验证

2026-08-10 · 分支 `dcf`

从"删掉 review 路径的残留"开始,最后变成一次完整的 legacy 拔除。过程中撞出四个真实缺陷——其中两个会让**生产路径上的每一个模型都无法离开 `draft`**,一个让 prompt 里承诺的修正手段根本调不通。清理完成后跑了 step8 真实 agent 端到端,通过。

---

## 一、结论速览

| 项 | 结果 |
| --- | --- |
| 引擎侧改动 | 15 个文件,**+259 / −1166** 行(未提交) |
| prompt 侧改动 | 已提交 `3bc3796 refine the dcf agent prompt` |
| 类型检查 | `npx tsc --noEmit` 干净 |
| 单元测试 | **1022 / 1022** 通过(清理前套件是红的) |
| step8 端到端 | **PASS** — 7 步、11 次工具调用、0 工具报错 |
| 清理中发现的缺陷 | **4 个**,全部已修 |

---

## 二、Prompt 层:移除重复的工具描述(已提交)

四个 subagent 的 system prompt 里都有一段 `Allowed tools:\n{{allowedTools}}`,而 native function calling 每步已经把同一批工具的完整 JSON schema 发出去了。

实测 `financial_modeling` 的体量:

```
prose system(去掉工具块)  :  2,764 chars
{{allowedTools}} 文本块      : 10,068 chars   ← 散文部分的 3.6 倍
native tool specs JSON      : 16,755 chars
```

其中 `apply_financial_model_operations` 一个就占文本块的 4,942 chars。

判定为可删的依据:

1. `formatToolArgs` 从同一份 `inputSchema` 渲染,还做了减法(过滤 `task`、深度截到 6 层)——是 native spec 的**严格子集**。
2. 可调工具由 `buildLoopToolSpecs` 的列表 + `runToolCall` 的 `allowed.get()` 硬拦,不靠散文兜底。
3. `finish` 工具本来就只存在于 native spec 中,prompt 里"call the finish tool"已在依赖 native 通道。
4. 三个真 provider(anthropic / google / vertex)都发 `options.tools`;`MockLlmProvider` 是写死脚本,不读 prompt 里的工具列表。

`formatAllowedTools` 保留导出(`scripts/eval/evals/nlDsl.ts` 仍在用),并加注说明它已不在 subagent 循环中使用。

缓存未受影响:Anthropic 的缓存前缀是 `tools → system → messages`,`cache_control` 打在 system 上,前缀里仍含 ~4.8K token 的 tool specs,远超 1024 token 最小可缓存长度。

---

## 三、Legacy 拔除

### 3.1 fact review 路径残留

`service.reviewFacts` / `stageFacts` 被移除后,留下一批孤儿:

- `ReviewFactsInput` 类型、失效的 `applyFactReview` import
- service.ts 中**十个**只被 `reviewFacts` 调用过的函数:`validateMappingPeriods`、`ensureUniqueDecisionIds`、`isRevenueStreamId`、`planKey`、`referencesLineItem`、`streamIsReferenced`、`removeRevenueStreams`、`dropHistoricalPlanFormulas`、`sortStatementPlans`、`sortCategoryGroups`、`factsReviewedChange`
- `mcp_tools/financial-model/schemas.ts` 的 `reviewInputSchema`、`parseHistoryReviewInput`

### 3.2 statement-mapping 机制

`set_statement_mapping_plan` 及其下游全部移除:`applyStatementMappingPlans`(skeleton)、`StatementMappingPlan` 类型、operations 的 union 成员与 handler、service 的 `operationChanges` 分支、views 的 `statement_mapping_plan_set` change kind 与校验、`WorkbookRowView.mappingRefs`、`SourceStatementReviewView.activeMappings/proposedMappings`、slice lineage 的 `statementMappingPlans`、codec 的 `normalizeStatementMappingPlan` / `validateStatementPlan`。

连带 `proposedStatementMappings` —— 它**从来没有写入方**,只被初始化为 `[]`、编解码、被 views 读,早已是死的。

### 3.3 `mappingException`

它是老的**映射修复回路**的一环:对账失败 → 通过 mapping plans 反查是哪些 `source_*` 行喂给了出问题的 canonical 行 → 把 workbook 退回 `statement_mapping` 模式并**只摊开这几行**。

plans 一删,第二步的回溯链就没了,而收窄逻辑还在跑。实测后果:

```
lifecycle    : draft
workbook mode: statement_mapping     ← 从 dcf 退回去了
income / balance / cashflow rows : 0 / 0 / 0   ← 三张 source 表全空
```

不是"不收窄",是**收窄到零行**——比不给还糟,看起来像这家公司的原始报表里什么都没有。

同时它携带的信息量已归零:`reason` 恒为 `"reconciliation"`(另外四个取值 `unmapped`/`restatement`/`structure_change`/`low_confidence` 早无生产者),`sourceLineItemIds` 恒为 `[]`,`periodIds` 与 `reconciliationResults` 重复。

整个类型、snapshot 字段、`reconciliationMappingException`、codec 的 normalize/validate、views 的 mode 降级与 `limitToException` 全部删除。`buildSourceReview` 简化为永远给完整 source 表。

### 3.4 其余死代码

按"有没有写入方"的统一标准扫出:

| 项 | 判定依据 |
| --- | --- |
| `mappingDiagnostics` | 初始化为 `[]`、被排序(空数组上的空操作)、编解码、被读,**无任何写入方** |
| `facts_reviewed` change kind | 生产者 `factsReviewedChange` 随 `reviewFacts` 删除,类型与校验器成孤儿 |
| `facts_staged` change kind | **从未被发出过**——`factsStagedChange` 虽声明返回它,两个调用方都只取字段去拼 `statements_staged`。已重新标注为它实际服务的类型 |
| `import_source_row` | 从 `parseOperations` 的 known-set 移除(见 §4.4) |

### 3.5 明确保留的部分

| 保留项 | 原因 |
| --- | --- |
| `set_category_group` | 作用在 **canonical 行**(`members[].lineItemId`),不是 legacy;`operations.test.ts` 有一整组专属覆盖 |
| `stage_advanced` change kind | `service.ts` 仍在 lifecycle 推进时发出 |
| `factReviewDecisions` | 经 `replace_fact` 仍然活跃 |
| `stagePreparedStatements` | 生产的 `create_financial_model` 正在用 |

> **一次纠正**:我最初把 `set_statement_mapping_plan` 和 `set_category_group` 当成同一套东西建议一并删除。查类型后确认:前者 `members[].sourceLineItemId` 作用在 `source_*` 行,是真 legacy;后者 `members[].lineItemId` 作用在 canonical 行,是活的建模功能。只删了前者。

### 3.6 数据

先查后删,结果与预期不同:

| 库 | 内容 | 处置 |
| --- | --- | --- |
| `data/financial-models.sqlite` | 16 张表**全部 0 行** | 未动(本就是空的) |
| `data/e2e-test/aapl/step8-models.db` | 1 model / 4 revisions,1.1 MB | 已删(可由 step8 重新生成) |
| `data/sessions.sqlite` | 会话日志,与本次迁移无关 | 未动 |
| `data/stock.db` | 股票 bar 数据,重抓代价高 | 未动 |

**没有任何 legacy 生产数据存在**,因此 codec 的向后兼容层(把退休字段挪进 `SNAPSHOT_OPTIONAL_FIELDS` 读到就丢弃)在确认后改为硬删除。

---

## 四、清理中发现的四个缺陷

这些不是清理造成的,是迁移本身遗漏的。没有它们,legacy 删干净了但流水线是坏的。

### 4.1 每个 spine 模型都被读成 `statement_mapping`

`views.ts` 的 mode 派生只认 `statementMappingPlans.length > 0`,而 `commitSpineFacts` 从不写 plans。lifecycle 侧早已更新(认 `committedSpine`),view 侧没跟上。

**症状**:模型提交 spine 后仍以 `statement_mapping` 模式返回,每次都附带完整 `sourceStatementReview` 而非 DCF workbook。

**发现方式**:`service.test.ts:286/412` 在我动手前就已红着报这个。

**修复**:把判定提取为共享的 `hasCommittedSpine()`,`historyGate` 与 view 共用。

### 4.2 生产模型永远停在 `draft`

`historyGate` 那条"选中历史期不得有 staged fact"写于"staged = 未审阅"的年代。旧的 `reviewFacts` 会把每条 staged 的 source fact 都 commit/reject 掉;新的 `commitSpineFacts` 只提交 canonical spine facts,**filing 证据行按设计永远保持 staged**,于是 gate 永远拒绝。

**验证**:用真实 `create_financial_model` + spine 提交探测 → `draft`。

**为什么 e2e 没暴露**:step4–7 脚本用 `preparedStatementRows: []` 跳过了 `stagePreparedStatements`,不会留下 staged source facts。只有走生产工具路径才触发。

**修复**:gate 只对 canonical 行上的 staged fact 生效,`source_*` 行豁免。

### 4.3 `replace_fact` 根本调不通

引擎的 supersede 配对要求 replacement 携带 `supersedesFactId`(`factLifecycle.ts:180`),而工具的 `fact` schema 是 `additionalProperties: false` 且不含该字段——**不带被引擎拒,带了被 schema 拒**。

这一条尤其要紧:新 AUTHORITY prompt 的整个立论就是"spine 的事实直接提交,映射错了在后续 revision 上用 `replace_fact` 修正",而那条修正路径当时是断的。

**修复**:补进 schema。

### 4.4 错误提示把 host-only 操作说成可写

`parseOperations` 的 known-set 里列着 `import_source_row`,但它不在 `operationVariants` 中——它是 `workbenchTools.ts` 内部构造的 host-only kind。agent 手写它会被 schema 拒,而提示却说"这个 kind 认识,是某个字段缺了或写坏了",把人往错方向指。

**修复**:从 known-set 移除。

### 4.5 已记录未修:`Provenance.decimals` 注释失实

`types.ts:109` 写着 "drives the reconciliation tolerance",但 `comparisonTolerance` 纯按数值量级计算,**从不读 `provenance.decimals`**;整个 `src/financial-model` 除 codec 编解码外无人读它。真正用 decimals 算容差的是上游 `unifiedStatements.ts` 的 `valueTolerance`(统一阶段判断两份 filing 是否报同一个数),不是一回事。`accession` / `filingUrl` / `signFlipped` 同理只存不读(但对 agent 仍有价值,lineage 会原样带出)。

---

## 五、新增:对账失败的 unified 溯源

删除 `mappingException` 后,需要以正确的形态恢复"追溯输入"的能力。

关键澄清:**spine fact 是带溯源的**,只是指向另一个存储层。

```ts
// spineFromUnified.ts
provenance: { sourceType: "unified_statements",
  sourceRefs: sourceFacts.map((f) => f.factId),  // 被求和的 unified fact
  concept: rowIds.join("+") }                     // 被合并的 unified 行 ID
```

三个命名空间:

| 层 | 标识 | 来源 |
| --- | --- | --- |
| ① workbook `source_*` 行 | `sourceLineItemId` | ingestion 的 `prepared.rows`,单份 filing 的报表呈现 |
| ② unified 行 | slug `rowId` | statement_unification 的跨年度概念对齐,键是 `conceptQName` |
| ③ canonical spine 行 | `revenue.total` 等 | spine_mapping 的产出 |

**③ → ② 完整**(就是上面的 provenance)。**② → ① 不存在**:`PreparedStatementRow` 没有 `conceptQName`,两者除 label 外无共同连接键。老的 mapping plan 直连 ③ → ①,所以它一没,通往 workbook source 行的路就断了——而 `mappingException.sourceLineItemIds` 恰好被 codec 校验为必须是 `source_*` 行 ID,指的正是断掉的那一头。

**方案**:线索长在对账结果上,不再借"mapping exception"的壳。

`ReconciliationResult` 新增可选字段:

```ts
unifiedTrail?: Array<{ lineItemId: string; rowIds: string[] }>;
```

只在 `status === "failed"` 时出现,由 `recalculate` 中的 `attachUnifiedTrail` 填充(接在 `reconcileDcf` 之后,那里能同时看到对账结果与 facts)。数据源是 spine_mapping 已经在写的 `provenance.concept`——**没有新增任何需要维护的映射记录,线索本来就在,只是以前没接到失败结果上**。`rowIds` 可直接喂给 `get_unified_rows`。

修复前后对比(同一个恒等式冲突场景:`revenue.total=100`、`cost_of_revenue=60`、`gross_profit=35`):

```
修复前                              修复后
lifecycle : draft                   lifecycle : draft            ← 都正确卡住
mode      : statement_mapping       mode      : dcf              ← 不再降级
source 表 : 0 / 0 / 0 行            无空表附加
线索      : 无                      unifiedTrail:
                                      revenue.total   ← ["revenue"]
                                      cost_of_revenue ← ["cogs"]
                                      gross_profit    ← ["gross_profit"]
```

这个字段持久化,codec round-trip 有测试覆盖。

---

## 六、step8 真实 agent 端到端

清理后的完整验证。因先前删掉了 `step8-models.db`,这次走**完整 foundation 构建**而非断点续跑。

```
Foundation ready at revision 2
  WACC 留给 agent 的空洞: equity_risk_premium, cost_of_equity, cost_of_debt, wacc

lifecycle: valued          WACC: 10.51%
Gordon: $117.43 /sh    |   Exit: $180.92 /sh

**PASS** — 一次 dispatch 达到 valued
```

agent 自己走的路径(60 步预算只用 7 步,11 次工具调用,**0 工具报错**):

```
step 1: read_skill_reference ×2          ← 按需取 playbook
step 2: list_unified_statements + get_unified_rows
step 3: financial_search ×2              ← 只用于取 ERP / 市场倍数
step 4: apply_financial_model_operations ← mutation 串行,每个独占一步
step 5: apply_financial_model_operations
step 6: apply_financial_model_operations
step 7: finish
```

这条路径正好穿过本轮每一处改动:`historyGate` 的 source 行豁免(不修则 foundation 到不了 `history_committed`,整个跑不动)、`hasCommittedSpine`(不修则 workbook 读不成 `dcf`)、`commitSpineFacts → refreshWaccSheet`(空洞列表正是设计预期:引擎能推的都推了,推不出的留给 agent)。

**覆盖缺口**:全程零对账失败,所以 §5 的 `unifiedTrail` 路径**没有被 e2e 走到**,目前仅有单元测试与手工复现覆盖。

---

## 七、模型质量发现(与代码改动无关)

### 7.1 两法终值背离 54%,无人解释

```
FY2030  fcff = 156.0B     ebitda = 198.1B

Gordon TV = 156.0 × 1.025 / (0.1051 − 0.025) = 1,995B
Exit   TV = 198.1 × 18                        = 3,566B   (1.79×)
```

换算到同一把尺子上就很刺眼:**Gordon 终值反推的隐含倍数是 1995 / 198.1 = 10.1x EV/EBITDA**,而 agent 在另一边填了 18x。反过来算,要让 18x 成立需要永续增长 5.9%,远超名义 GDP,站不住。

终值占企业价值比重:Gordon 70%,Exit 81%。

根因是两个数字用了**两把互不相干的尺子**——2.5% 拿宏观锚(≤ 名义 GDP),18x 拿市场相对锚(rationale 写"远低于当前 27-30x")。两者从未被放在一起对过,agent 也未对背离作出任何说明。

### 7.2 `valuationConfig` 从未被触碰

```
exitTerminalMetric: ebitda | discount: year_end | anchor: FY2025
config sourceType : user | "Default phase-1 valuation configuration"
```

仍是 `createModel` 写下的默认值。也就是说"倍数乘在 EBITDA 上"这个选择**不是 agent 做的,是它继承的**(尽管其 rationale 写着 "Exit EV/EBITDA of 18x",说明它知道)。折现惯例与敏感性区间同样是默认值。

值得记住的分层:`terminal_growth` / `exit_multiple` 是 **workbook 里的 assumption 行**(`skeleton.ts:198-199`),用 `set_assumption` 写;而**倍数乘在哪一行**由 `valuationConfig.exitTerminalMetric` 决定(`"ebitda"` | `"fcff"`),用 `set_valuation_config` 写。

### 7.3 自定义分析行 = 0

agent 一次都没调用 `calculate_model_rows`。profit-source 分解全在 prose 里完成,再直接落成 assumption。skill 里 "never do arithmetic in prose" 那条没有真正落实——虽然最终数字都由引擎计算。

这与 7.1 直接相关:**"隐含倍数 10.1x"就是一行公式的事**,而正因为没有任何交叉验证被落成引擎能算的行,这种自相矛盾没有任何机制会拦住它。

### 7.4 判断质量(正面)

把 Apple 拆成 Product / Services 两条流分别给增长率(产品 4%→3% 衰减、服务 12%→8%),营业利润率随服务占比上升从 32.3% 爬到 34%,税率 / D&A / capex / NWC 四项按"持续"处理并锚在 5 年均值上,负营运资本(−13%)也识别出来了。每条 assumption 都带 `sourceType` 和引用历史区间的 rationale。

---

## 八、未决事项

| 项 | 状态 |
| --- | --- |
| 引擎侧 15 个文件的改动 | **未 commit**,等审阅 |
| `Provenance.decimals` 注释失实 | 已记录,未改(§4.5) |
| `unifiedTrail` 缺 e2e 覆盖 | 建议给 `service.test.ts` 的 `spineFact` helper 补 `concept`,补一条端到端断言 |
| 终值双法交叉验证 | 建议写进 `skills/dcf-valuation/references/06-valuation.md`:两法必须换算到同一尺子(隐含倍数 / 隐含增长率)并解释差异 |
| 强制落成分析行 | 考虑在 skill 中要求关键交叉验证必须经 `calculate_model_rows`,而非 prose |
