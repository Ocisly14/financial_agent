# TSLA 全链路 Smoke 报告 — 切换到 Anthropic 之后

日期:2026-08-06
标的:TSLA · 历史 5 年 · 8 份 filing(5× 10-K + 3× 10-K/A,FY2021–FY2025)
脚本:`scripts/xbrl/smoke-premap-mapping-review.ts`(`SMOKE_SKIP_INSIGHTS=1`)
Provider:Anthropic · MEDIUM=`claude-sonnet-5` · SMALL=`claude-haiku-4-5-20251001` · LARGE=`claude-opus-5`
run id:`ing_2d55dc3a-bed7-4889-a567-83403274c0b3` · model:`fm_ee4e3be1-888c-4f0a-84fc-4428487f0971`
输出:`data/smoke/xbrl/tsla-5y-fullchain-anthropic-run2-2026-08-06/`(含完整 `run.log`)
耗时:07:35:42 → 07:47:06 UTC(约 11.4 分钟,39 次 LLM 调用)

## 1. 结论

**五个阶段全部成功,零失败的 subagent,driver 方案五年 residual 全为 0、无任何标记。**
这是目前为止最干净的一轮。相比 Gemini 那两轮,差别不是边际的:map agent 从 5/8、6/8 变成 8/8,
driver 方案从"两年空洞"变成"五年完整"。

## 2. 三轮横向对比

| | 轮次 A(Gemini 3.1 Pro) | 轮次 B(Sonnet 5,修复前) | 轮次 C(Sonnet 5,本轮) |
|---|---|---|---|
| filing_decomposition | 5/8 成功 | 6/8 成功 | **8/8 成功** |
| 候选方案数 | 3 | 2 | 2 |
| driver | 产品/服务 | 地区 | 产品/服务 |
| driver residual | FY2021=1, FY2025=1 | 全 0 | **全 0** |
| revenue 分项期间覆盖 | 3p | 5p | **5p** |
| mapping_review | 成功 | **崩溃** | **成功** |
| 全链路 | 5/5 | 4/5 | **5/5** |

轮次 B 的崩溃和 2 个 map 失败都是我们自己的 `max_tokens` bug,不是 provider 问题(见 §6)。

## 3. 阶段 2 — 引擎自动 premap

与前几轮完全一致(确定性逻辑,本就该稳定):**27 个目标映射,14 个未映射,74 个源行未消费,
1 个降级**。23 个目标覆盖全部 5 个期间。

降级项仍是 `net_income`:`NetIncomeLoss` 与 `ProfitLoss` 两个 concept 命中三行(利润表两行、
现金流量表一行),期间完全重叠,引擎按 spec §3 拒绝猜测,退回给 agent。

## 4. 阶段 3 — map-reduce 收入分解

**8 个 filing_decomposition subagent 全部成功,diagnostics 为空。** 3 份 10-K/A 正确返回空方案
(只有封面表),5 份完整 10-K 全部产出方案。

两个候选,都是满分覆盖:

| | 方案 | 轴 | 子项 | residual |
|---|---|---|---|---|
| **DRIVER** | Total revenues by product/service line | `srt:ProductOrServiceAxis` | 汽车销售 / 汽车监管积分 / 汽车租赁 / 能源发电与储能**销售** / 能源发电与储能**租赁** / 服务及其他 | FY2021–FY2025 全 0 |
| | Total revenues by geography | `srt:StatementGeographicalAxis` | 美国 / 中国 / 其他国际 | FY2021–FY2025 全 0 |

两个方案都零标记。reduce 选了产品/服务口径,它比 Gemini 轮次多拆了一层——把"能源发电与储能"
按销售/租赁拆开,6 个子项。这是从 ASC 606 收入分解附注里读出来的,不是利润表表面行。

## 5. 阶段 4/5 — 物化与 agent 审核

物化后 premap 从 27 → **33 个目标,7 条 revenue 行,每条都覆盖 5 个期间**:

```
revenue.total                                  [concept_vocab, 5p]
revenue.automotive_sales                       [decomposition_scheme, 5p]
revenue.automotive_regulatory_credits          [decomposition_scheme, 5p]
revenue.automotive_leasing                     [decomposition_scheme, 5p]
revenue.energy_generation_and_storage_sales    [decomposition_scheme, 5p]
revenue.energy_generation_and_storage_leasing  [decomposition_scheme, 5p]
revenue.services_and_other                     [decomposition_scheme, 5p]
```

没有残差兜底行——Σ 分项 = 总收入,五年都成立。

mapping_review 给出 **10 条 plan,0 remap,10 新增**,与之前几轮一致。值得单独记的是这轮的
rationale 质量:

- **解开了 `net_income` 降级**,并给出了可核对的理由:选利润表的 `ProfitLoss` 行,因为它是唯一
  5 年全覆盖的、且能和 `pretax_income − income_tax_expense` 对上;现金流量表那行只有 FY2023–25
  且数值相同(重复),`Net income attributable to common stockholders` 是 NCI 调整后的不同概念。
- **明确拒绝映射 6 个目标并说明原因**:`general_and_administrative`(TSLA 的 SG&A 是合并一行,
  没有单独的 G&A)、`other_operating_current_liabilities`、`asset_sale_proceeds`、`dividends`、
  `restricted_cash`、`share_repurchases`(报表里根本没有对应行)——
  "mapping them would require inventing figures, which is out of scope"。
  这正是希望它做的:不硬凑。
- 主动豁免了 9 条现金流量表期初余额行的 `incompatible_context` 列冲突,并说明该行不被任何
  DCF spine 目标消费。

## 6. 本轮修复的问题

三处都在 `src/infra/llm/anthropicProvider.ts`:

1. **`max_tokens` 硬编码 8192**。Claude 5 自适应思考,思考 token 与输出共用这个预算,
   顶满后返回里一个 text block 都没有,`text` 为空串,调用方 `JSON.parse` 报
   "did not return JSON" —— 错误完全指向错的方向。轮次 B 的 mapping_review 崩溃就是这个
   (`out=8192` 正好顶格)。
   改为:默认请求 200000 故意超限,从 400 的错误文案里正则抓出真实上限并缓存重发。
   实测上限 Sonnet 5 / Opus 5 = 128000,Haiku 4.5 = 64000。不写死表,换模型自动跟上。
2. **`temperature` 被 Claude 5 弃用**(Sonnet 5 / Opus 5 直接 400,Haiku 4.5 仍接受)。
   同样用运行时学习:收到该 400 就记住这个 model id,之后不再带。
3. **空 text block 被伪装成解析失败**。provider 层现在直接抛出带 `stop_reason`、`max_tokens`、
   `output_tokens`、实际 block 类型的明确错误。

另外 `.env` 里 `LLM_MODEL_*` 是空字符串,而 provider 用的是 `??` 兜底——空串不是 nullish,
model id 会变成 `""`。改成 `||`。这个 bug 会让切换 provider 静默失败。

## 7. 本轮出现但被自动恢复的两次错误

新加的原始错误日志(`ModelRouter` + `describeProviderError`)第一次派上用场:

```
[07:36:15] failed after 4034ms | {"name":"Error","message":"Anthropic returned no text block
  (model=claude-sonnet-5 stop_reason=end_turn max_tokens=128000 output_tokens=57 blocks=[thinking,text])"}
```

注意 `blocks=[thinking,text]` 且 `stop_reason=end_turn`、`output_tokens=57` —— **这次不是截断**,
是模型正常结束却返回了一个内容为空的 text block。和 §6.1 的截断是两种不同的成因,
新的报错信息把它们区分开了。loop 的重试成功恢复。

```
[07:40:50] failed after 301596ms | {"name":"TypeError","message":"fetch failed",
  "name.2":"HeadersTimeoutError","code":"UND_ERR_HEADERS_TIMEOUT"}
```

undici 默认 5 分钟 headers 超时。同样被重试恢复。若后续频繁出现,可以给 fetch 配更长的
`headersTimeout` 或改用流式。

两次错误都没有影响最终结果(diagnostics 为空)。

## 8. 遗留问题

1. **FY2021/FY2022 现金流量表 fact 缺失依旧**:`acquisitions`、`capital_expenditures`、
   `net_investing_cash_flow`、`operating_cash_flow` 只有 3 个期间;agent 也注意到了
   (`reported_change_operating_assets_liabilities` 只映射了 FY2023–25)。这是 XBRL 提取侧的问题,
   与 provider 无关,三轮都存在。
2. **`net_income` 这类同概念家族多行竞争有确定性解法**(优先利润表、优先 5 年全覆盖的行),
   现在每轮都要烧一次 agent 调用去解。可以下沉到引擎。
3. **manifest 的 `premapCounts` 是阶段 2 快照**(27),不是阶段 4 之后的 33;阶段 4 的数字只在
   `run.log` 里。脚本记录口径问题,不影响功能。
4. **轮次 B 那次西班牙语机器人验证页输出未复现**,本轮无异常输出。原因仍未知,继续观察。
5. `statement_extraction` 的 1086 条 diagnostics 三轮不变,尚未逐条审查。
