# DCF Agent Workbench Tools — Design

三个新工具，补齐 DCF 编排 agent 在"读数据层证据"和"用公式做参数化计算"上的空白。全部为 `RegisteredTool`，放 `mcp_tools/financial-model/`（照 `waccTool.ts` 先例），注册进 `FINANCIAL_MODELING_TOOLS`，owner 校验与现有工具一致。

## 背景与动机

- 编排 agent 目前看不到 step2 产出的 unified 三大表和 breakdown 行（含未进工作簿的轴，如 Apple 的地域轴）——写预测假设时缺证据来源。
- agent 需要"用已有科目写公式、命名成参数、engine 先算出来"的初始化能力（如 product 毛利率、opex/revenue），现在只能逐条拼 `apply_financial_model_operations`，且行上无处放描述。
- 铁律"不许在 prose 里做算术"要求所有计算走 engine。

## 工具一/二：渐进式读数据层（照 step2 两级模式）

数据源：`sourceReviewStore.get(modelId).unifiedStatements`（含 `breakdownRows`）。零新存储。

### `list_unified_statements`

- 输入：`{ modelId, statement? }`——`statement` 可选，只列三大表之一。
- 输出（目录级，不含数值）：
  - `rows`: `[{ rowId, label, statement, periodsCovered }]`（unified 行索引）
  - `breakdownAxes`: `[{ axisQName, parentRowId, memberCount, hasMemberTree, inWorkbook }]` —— `hasMemberTree` 标记该轴是否带 `parentMemberQName` 层级；`inWorkbook` 由该轴任一 member 是否已作为 stream/detail 落入当前 workbook 判定（对照 lineItems 前缀）
  - `periods`: 期 id 列表
- 错误：模型不存在/非 owner → `financial_model_not_found`；无 unified artifact → `unified_statements_unavailable`（提示先跑 statement_unification）。

### `get_unified_rows`

选择参数沿数据的树状层级一路细分到底，全部可选、AND 组合：

```
{ modelId,
  statement?,        // 第 1 层：哪张表（income_statement / balance_sheet / cash_flow_statement）
  parentRowId?,      // 第 2 层：哪个父行（unified rowId；筛出它本身 + 挂它下面的 breakdown 行）
  axisQName?,        // 第 3 层：哪条轴
  parentMemberQName?,// 第 4 层：成员树中哪个节点之下（如 us-gaap:ProductMember 的直接子成员）
  memberQNames?,     // 第 4 层：点名具体 member（数组）
  memberFilter?,     // 第 4 层：member label/QName 大小写不敏感子串
  rowIds?,           // 直通：点名任意行 id（unified 或 breakdown），绕过上述过滤
  cursor? }          // 翻页：上次响应的 nextCursor
```

- 输出：`[{ rowId, label, statement?, axisQName?, parentMemberQName?, values }]` + 截断时 `nextCursor`。
- 例：`{parentRowId:"revenue", axisQName:"srt:ProductOrServiceAxis", parentMemberQName:"us-gaap:ProductMember"}` → 恰好 iPhone/Mac/iPad/Wearables 四行。
- 预算（host 固定不可设）：单页 ≤40 行。

## 工具三：`calculate_model_rows`（统一 DSL 执行器）

定位（用户定）：**代码侧只是一个纯执行器**——agent 写 DSL 公式、engine 执行、落库返回逐期值；"该算哪些参数、公式长什么样"不进工具结构，而是写成公式手册（prompt/skill 层，见"知识面"节）。一次调用 = 一张小计算表，**每一行都落库**为 `custom_metrics` 下的科目。

- 输入：`{ modelId, expectedRevision, rows: [{ id, formula, label?, description?, unit? }] }`
  - `id`：slug（`a-z0-9_`），落库为 `metric.custom.<slug>`（现有 `add_line_item` 对 custom_metrics 的既定命名空间，section=metrics）；批内与模型内均不得重复。
  - `formula`：现有 DSL（四则、SUM/AVERAGE/LAG/YOY/…），可引用模型任意科目 **和同批其他行**（用落库后的 `metric.custom.<slug>` id；工具允许简写 `<slug>` 并在校验前展开）。
  - `description`：短描述，存到 LineItem 新增的可选 `description` 字段，随 `get_financial_model` 行视图透出（与公式源码并排）。
  - `unit` 缺省 `{kind:"ratio"}`（底层 `add_line_item` 对 custom metric 要求显式 unit，由工具补默认值后下传）。
  - **已确认的阻塞与修法**：`assertMutableDefinition`（operations.ts:174-177）对整个 metrics section 一刀切拦 `set_formula`/`set_line_item_source`，导致 `add_line_item` 建出的 custom metric 行（生来 `historical:"formula"`）装不进公式。放行 `metric.custom.` 前缀，registry 自带 metric 行与六个固定 driver 照旧不可动：
    `if ((item.section === "metrics" && !item.id.startsWith("metric.custom.")) || REGISTRY_DRIVER_IDS.has(item.id)) …`
  - `label` 可选，缺省从 slug 生成（`product_gross_margin` → "product gross margin"）；`id`=公式引用标识，`label`=科目显示名，`description`=短说明，三者分工与现有 LineItem 一致。

## 知识面：公式手册（skill 格式，条目另议）

公式配方手册采用 **skill 格式**（仓库 `skills/` 目录的既有形态：frontmatter + 指令正文），内容是常用参数的 DSL 配方，agent 按需改科目 id 套用、经 `calculate_model_rows` 执行。**具体条目待后续讨论，不在本期实现范围**——本期只交付工具与管道，工具对参数语义零感知。
- 语义：
  - 行间引用由 DSL 依赖图解析，**与书写顺序无关**（Excel 单元格引用的等价物）；环引用由现有图校验拒绝。
  - 内部组合为一个 operations 批（`add_line_item` parentId=`custom_metrics` + `set_formula` historical），走 `applyOperations` 原子提交——**一次调用一个 revision**，失败整批回滚。
  - 历史侧公式由 engine 立即计算；预测侧初始 `none`，后续 agent 用现有 operations 自行决定当 driver 还是当锚（不预设分类，per 用户决定）。
- 输出：新 revision + 每行逐期计算值 + 该行公式/描述回显；某期输入缺失产出 null，随 cells 的现有 diagnostics 说明。

## 不做的事（YAGNI）

- 不做"草稿态"（不落库的临时求值）——用户明确去掉两态；快速算一把 = 建行读值，行本身就是审计记录。
- WACC 不加新工具：`compute_wacc` + 自动 wacc_status 已覆盖；参数级算式走 `calculate_model_rows`。
- 不给编排 agent 开原始 filing 表格（182 张）的读取口——数据层产物已够，需要时另议。

## 需要动的既有代码

- `src/financial-model/types.ts`：`LineItem` 加可选 `description?: string`；`operations.ts` `NewExtensibleLineItem` 同步；`views.ts` 行视图透出；`snapshotCodec` 序列化兼容（老快照无此字段）。
- `src/agent/prompts/subagentPrompts.ts`：financialModelingSubagentPrompt 增补三工具的用法段（读证据→定参数→写预测链的工作流提示）。
- `mcp_tools/financial-model/`：新文件 `workbenchTools.ts`（三个工具）+ 测试；`registerTools.ts`/`FINANCIAL_MODELING_TOOLS` 注册。

## 测试要点

- list/get：无 artifact 的错误路径；目录不含数值；四层过滤逐层收窄且可组合（statement→parentRowId→axisQName→parentMemberQName/memberQNames/memberFilter）；`rowIds` 直通绕过过滤；40 行截断 + `nextCursor` 翻页。
- calculate：批内乱序互引可算；环引用拒绝；重复 id 拒绝；description 落到行视图；一次调用一个 revision；某期输入缺失 → null 不炸批。
- 权限：非 owner 一律 `financial_model_not_found`。
