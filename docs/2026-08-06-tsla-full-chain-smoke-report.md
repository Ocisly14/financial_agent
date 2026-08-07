# TSLA 全链路 Smoke 报告(premap → decomposition → apply → mapping_review)

日期:2026-08-06
标的:TSLA · 历史 5 年 · 8 份 filing(5× 10-K + 3× 10-K/A,FY2021–FY2025)
脚本:`scripts/xbrl/smoke-premap-mapping-review.ts`(`SMOKE_SKIP_INSIGHTS=1`)
run id:`ing_d1c1be0e-632f-4d91-90dc-e74d1d7ec4a1` · model:`fm_3e824ea7-df07-4971-9d7b-c05ce7d96cd6`
输出:`data/smoke/xbrl/tsla-5y-fullchain-2026-08-06/`
耗时:06:59:24 → 07:03:50 UTC(约 4.5 分钟)

## 1. 结论

五个阶段全部跑通,无异常退出。引擎自动 premap 与 agent 审核的分工按设计工作:
**引擎填的 27 行,agent 一条都没改(`remapCount: 0`)**,只补了引擎不认识的 10 行。
唯一的实质问题仍是 provider 限流——8 个 map subagent 里 3 个失败,直接导致 driver 方案
FY2021/FY2025 两年无数据。

## 2. 各阶段结果

| 阶段 | 结果 |
|---|---|
| 1 statement_extraction | 8 filing 提取成功,1086 条 diagnostics;insights 跳过 |
| 2 create_financial_model(premap L1 + L2a) | revision 2;**27 个目标映射,14 个未映射,74 个源行未消费,1 个降级** |
| 3 revenue_decomposition(8 map + 1 reduce) | **5 成功 / 3 失败**;3 个候选方案,选出 driver;**`merge_children` 首次被调用** |
| 4 apply_revenue_decomposition(物化 + L2b) | revision 3;premap 升到 **33 个目标,7 条 revenue 分项** |
| 5 mapping_review(agent 审核) | 10 条 plan,**0 remap / 10 新增**,0 新类别行、0 分组 |

## 3. 阶段 2 — 引擎自动映射

27 个目标全部走 `concept_vocab`(Layer 1 词表精确匹配),其中 23 个覆盖全部 5 个期间。
两处多行合并由引擎自动完成(同一 spine 目标在不同年份换了标签,期间不重叠):

- `income_tax_expense` ← `Provision for (benefit from) income taxes` + `(Benefit from) provision for income taxes`
- `net_income_attributable_nci` ← 两个年份不同措辞的少数股东损益行

3 个目标只覆盖 3 个期间(`acquisitions`、`capital_expenditures`、`net_investing_cash_flow`、
`operating_cash_flow`),对应此前已知的 FY2021/FY2022 现金流量表 fact 缺失问题。

### 降级 1 项

```
net_income: overlapping periods across source rows
  source.income_statement.net_income.05cb632d0375                          (us-gaap:ProfitLoss)
  source.income_statement.net_income_attributable_to_common_stockholders…  (us-gaap:NetIncomeLoss)
  source.cash_flow_statement.net_income.d4c35ab7d554                       (us-gaap:ProfitLoss)
```

三行覆盖同一批期间,引擎按 spec §3 拒绝猜测,不出 plan,把目标退回 `unmapped` 交 agent。

## 4. 阶段 3 — map-reduce 收入分解

8 个 filing_decomposition subagent 并发上限 3。5 个返回结果,其中 3 个是 10-K/A 修正件,
正确判断出"只有封面表、无收入分解表"并返回空方案——这是期望行为,不是失败。

reduce agent 拿到候选后调用了 **`merge_children`**(合并地理方案里的两个同义子项),
这条路径在上一轮从未被触发,本轮首次在真实数据上跑通。

3 个候选方案:

| | 方案 | 轴 | 子项 | residual |
|---|---|---|---|---|
| **DRIVER** | Revenue by Product and Service | `srt:ProductOrServiceAxis` | 汽车销售 / 监管积分 / 汽车租赁 / 能源发电与储能 / 服务及其他 | FY2021=1, FY2022–24=0, FY2025=1 |
| | Revenue by Segment | `us-gaap:StatementBusinessSegmentsAxis` | 汽车分部 / 能源分部 | FY2021–24=0, FY2025=1 |
| | Revenue by Geography | `srt:StatementGeographicalAxis` | 美国 / 中国 / 其他国际 | FY2021–24=0, FY2025=1 |

三个方案都带 `residual_ratio_above_30pct` 标记,原因单一:缺年份。

reduce 的选择理由:产品/服务口径最细、经济含义最强。**注意 driver 的 FY2021 residual=1**
(分部/地区方案是 0),因为提供 FY2021 产品口径的那份 filing 恰好是失败的三份之一——
即 reduce 选了一个覆盖更差的方案,它当时看不到"这是限流造成的空洞"还是"公司确实没披露"。

### 失败诊断

```
filing_decomposition_failed 0001628280-26-003952: Invalid JSON response   (FY2025 10-K)
filing_decomposition_failed 0000950170-23-001409: Invalid JSON response   (FY2022 10-K)
filing_decomposition_failed 0000950170-22-000796: Invalid JSON response   (FY2021 10-K)
```

`Invalid JSON response` 来自 Vertex/ai-sdk 客户端,不是我们的解析——API 返回了非 JSON 体,
限流特征。并发降到 3 + 2–4 秒退避后仍未消除,本轮反而比上一轮多丢了一份(3/8 vs 2/8)。

## 5. 阶段 4 — 物化与 Layer 2b 注入

driver 方案物化后,premap 从 27 → **33 个目标**,revenue 分项 7 条:

```
revenue.total                          [concept_vocab, 5p]
revenue.automotive_sales               [decomposition_scheme, 3p]
revenue.automotive_regulatory_credits  [decomposition_scheme, 3p]
revenue.automotive_leasing             [decomposition_scheme, 3p]
revenue.energy_generation_and_storage  [decomposition_scheme, 3p]
revenue.services_and_other             [decomposition_scheme, 3p]
revenue.other_productorserviceaxis     [decomposition_scheme, 2p]
```

5 个业务分项各只有 3 个期间(FY2022–FY2024),对应上面丢失的两年。
`revenue.other_productorserviceaxis` 是残差兜底行,2 个期间。

同差恒等式校验通过(否则整组分项会被降级),说明这 3 年里 Σ 分项 = 总收入。

## 6. 阶段 5 — agent 审核

agent 先调 `waive_column_conflicts` 处理现金流量表期初余额列冲突,再调 `get_statement_rows`
查看候选源行,最后给出 10 条 plan,**全部是 ADD,零 remap**。

| 目标 | 源行 | 说明 |
|---|---|---|
| `net_income` | 利润表 `Net income` | **解决了引擎的降级**:明确选利润表而非现金流量表 |
| `depreciation_amortization` | `Depreciation, amortization and impairment` | TSLA 自定义 concept,词表未覆盖 |
| `debt_issuance` / `debt_repayment` | 现金流量表对应行 | 同上 |
| `property_plant_equipment` | `Property, plant and equipment, net` | 同上 |
| `accrued_operating_liabilities` | `Accrued liabilities and other` | 同上 |
| `other_operating_current_assets` | `Prepaid expenses and other current assets` | 同上 |
| `other_operating_expenses` | `Restructuring and other` | 语义判断,非词表可解 |
| `non_operating_income_expense` | 2 行合并(`Other (expense) income, net` + `Other income (expense), net`) | 跨年措辞变化 |
| `reported_change_operating_assets_liabilities` | **6 行合并**(应收/存货/经营租赁车辆/预付/应付/递延收入) | 多行聚合的正确用法 |

本轮 agent **没有新增 revenue 分项**(上一轮跳过 decomposition 时它自己补了 5 条),
因为阶段 4 已经注入好了——说明 agent 正确识别出这些行已存在,没有重复添加。

## 7. 已知问题(未做修改)

1. **限流仍是主要瓶颈**:3/8 map agent 失败,并发 3 + 退避不足以消除。所有 residual 标记
   和分项期间缺失都由此而来,不是独立缺陷。
2. **reduce 无法区分"数据缺失"与"未披露"**:本轮它选了 FY2021 有空洞的产品口径方案,
   而分部口径其实覆盖 FY2021–24 完整。diagnostics 里有失败记录,但没有喂给 reduce agent。
3. **manifest 里的 `premapCounts` 是阶段 2 快照**(27),不是阶段 4 之后的 33;
   阶段 4 的数字只在 stdout 里。属于脚本的记录口径,不影响功能。
4. **`net_income` 这类同概念家族多行竞争有确定性解法**(优先利润表、优先合并口径),
   目前每次都要花一次 agent 调用去解,可以下沉到引擎减少交给 agent 的量。
5. FY2021/FY2022 现金流量表 fact 缺失依旧(4 个目标只有 3p),与之前几轮一致。
