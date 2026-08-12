# DCF 模型工作簿前端：Excel 式只读实况看板

日期：2026-08-11
前置：`docs/superpowers/specs/2026-08-08-wacc-sheet-design.md`、`docs/superpowers/specs/2026-07-30-topic-workspace-design.md`
参考实物：`docs/Mar 19 (4) 11D AAPL New.xlsx`（Capital IQ 导出的 AAPL 模型，标签结构的蓝本）
范围：模型工作簿的前端展示、两个只读 HTTP 路由、一帧 SSE 信号
不在范围：可编辑单元格、可比公司分析（Multiple Analysis）、beta 明细回归表 —— 见 §9

## 1. 结论

后端 DCF 全流程已经跑通，但它的产出目前只有 agent 自己看得见。这份设计给它配一个
**只读的实况看板**：在现有工作区的图表列里多一个标签，点进去是一份 Excel 式的多表
工作簿，agent 每提交一次 revision，表格自动刷新、刚变的格子高亮。

一条贯穿全文的约束：

> **后端建模引擎一行都不改。** `FinancialModelService` / `operations` / `engine` /
> `valuation` / `waccSheet` 全部保持原样。新增的只有两个读路由、一帧 SSE，以及前端。

这条约束成立，是因为后端的视图层早就是表格形状的了：`CurrentWorkbookView` 有
`periods`（列）× `WorkbookRowView[]`（行），每格 `WorkbookCellView` 自带
`value` / `status` / `source` / `diagnostics`。前端不需要"把数据变成表格"，只需要
**把已经是表格的东西画出来**。

## 2. 三个已定的产品决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 交互范围 | **只读** | 所有修改仍然通过对话让 agent 做。写路径要引入乐观并发（`expectedRevision` 冲突）和「agent 与用户同时写」的竞态，那是另一个数量级的问题 |
| 界面位置 | **工作区图表列的一个标签** | 和 market chart 同层，点击切换。对话与模型同屏，"看着它搭起来"才成立 |
| 实时程度 | **变动高亮 + 自动定位** | `revision_summary` 已经带 `changedSections` 和变动的 lineItemIds / periodIds，高亮几乎是白送的 |

## 3. 实时通道：SSE 推轻信号，HTTP 取全量

选定方案：**SSE 只推一帧几十字节的变更信号，客户端凭信号去重取完整工作簿。**

被否掉的两个：SSE 直推完整快照（一个 workbook 序列化后是几百 KB 量级，每次 revision
都推会撑爆聊天流，且首次进页面/刷新后仍然需要一条 GET 兜底 —— 等于两套路径都要写）；
轮询（agent 提交 revision 的节奏极不均匀，连发几次然后沉默几分钟，轮询要么慢要么浪费，
且拿不到"哪些格子变了"，高亮做不成）。

选中方案的关键好处是**自愈**：页面刷新、断线重连、错过任意多帧，下一次 GET 都会拿到
一致的全量状态。信号丢失只会让高亮少闪一次，永远不会让表格停在错误的数据上。

### 3.1 SSE 帧

`src/framework/types.ts` 的 `SSEEvent` 联合新增一支：

```ts
| { type: "model_revision"; model_id: string; revision: number;
    lifecycle_stage: string;
    changed_sections: ModelReadSection[];
    changed_line_item_ids: string[];
    changed_period_ids: string[];
    change_kinds: string[] }
```

`change_kinds` 是 `RevisionChange["kind"]` 的列表。它必须存在，因为
**`changedSections` 里没有 WACC** —— `ModelReadSection` 只覆盖五个 DCF section 加三张
原始报表，WACC 与估值配置的变动只体现在 `changes[].kind` 上（`wacc_sheet_refreshed`、
`wacc_input_set`、`valuation_config_set`）。少了这个字段，改 WACC 就不会高亮。

### 3.2 投影

`src/infra/events/sseProjector.ts` 的 `tool_result` 分支：payload 里 `data.model_id`
是 string 且 `data.revision` 是 number 时发一帧，`changed_*` 从 `data.revision_summary`
（即 `RevisionChangeSummary`）取 —— `changedSections` 直接拿，line item / period ids
从 `changes[]` 各变体收集（`facts_reviewed`、`assumption_set`、`formula_set`、
`category_group_set` 等都带 `lineItemIds` / `periodIds`）。不满足条件则返回零帧。

**子 agent 无需额外打通。** DCF 的活儿跑在 subagent 里，而 subagent 的 `tool_result`
是以 sidechain 事件记进同一个 `SessionState` 的（`src/framework/subagent.ts:507`），
`attachSse` 订阅的正是这个 state。子 agent 每提交一次 revision，帧自然流到主 SSE 流上。

## 4. 后端：两个只读路由

加在 `src/server/server.ts` 现有 pathname 匹配链里，紧挨 topicCharts 那组：

```
GET /api/agents/:agentId/topics/:topicId/models
  → listModels({ ownerAgentId: agentId, originSessionId: topicId, includeArchived: false })
  → { models: ModelView[] }

GET /api/financial-models/:modelId
  → service.getModel(modelId)          // 不传 options ⇒ 完整 ModelContextView
  → { model, revisionHistory, currentWorkbook }
```

第一个路由能成立，是因为 `ModelFilter.originSessionId` 已经存在，而 **topicId 就是
sessionId**。不需要新表、不需要新关联。

服务实例复用 `getDefaultFinancialModelToolDeps().modelStore` —— 和 agent 工具是同一个
SQLite store 单例，不新开连接。`new FinancialModelService(store, sessionId)` 的
sessionId 只用于写路径的 `creatingSessionId`，读路由传常量 `"http-read"`。

模型不存在返回 404。archived 的模型不出现在列表里，但直接按 id 请求仍可读（历史留档
应该可查，只是不该出现在实况标签栏上）。

## 5. 标签结构：对齐 Excel，但只画后端真有的

### 5.1 从参考 Excel 到后端的映射

| Excel sheet | 后端来源 | 状态 |
|---|---|---|
| IS / BS / CF | `sourceStatementReview.sheets` | 直接对上 |
| WACC | `waccSheet`（12 行，beta→cost of equity→E/V,D/V→WACC） | 直接对上 |
| DCF | `operations` + `dcf` section + `valuation` | 对上，且多两张敏感性矩阵 |
| Key Stats | 跨 `revenue` / `history` / `operations` / `metrics` 四个 section 按白名单投影 | 前端拼装，不动后端 |
| Segment_Q / Segment_A / Geo_Segments | `DcfCategoryGroup` + `revenue` section 子行 | 结构对上，但切分方式不同（见 §5.2） |
| beta | `computeBeta()` 只返回标量，无收益率序列 | 不做独立表（见 §9） |
| Multiple Analysis | 引擎中无 comps 概念 | 本次不做（见 §9） |

### 5.2 一处结构性错位：Segment 的 Q/A 不存在

Excel 的 `Segment_Q` 与 `Segment_A` 是同一维度（业务分部）的季度 / 年度两个口径。
后端一个模型只有**一套期间栅格**：`Period` 只区分 `actual` / `ttm` / `forecast`，
没有年度/季度之分，且 `periodGrid` 会拒绝重叠期间。

所以 Q/A 这个切分在后端不存在，能对上的只有**维度**：`DcfCategoryGroup.category` 是
什么就出几张表。产品线一张、地理一张，agent 建了几个维度就几张，0 到 N 动态。

### 5.3 最终标签栏

```
摘要 ‖ 利润表 │ 资产负债表 │ 现金流量表 ‖ 收入 │ 分部:产品线 │ 分部:地理 … ‖ WACC │ DCF
     └── 原始报表（未映射）──┘   └─ 收入组：1 张兜底 + 按 category 动态 0~N 张 ─┘
```

标签栏底部排布（Excel 的位置），三组之间用细分隔符断开，让「模型 / 原始数据 / 推导」
三层结构在标签栏上就看得见。

**标签按后端实际存在的内容动态生成。** 模型还在 draft 阶段只有原始报表时就只出那三张；
WACC 没跑就没有 WACC 标签。这样标签栏本身就是进度条 —— 比挂一排空壳诚实。

### 5.4 每张表的内容

**摘要**（对应 Key Stats）。顶部 Key Financials 块，按固定 lineItemId 白名单挑行，行序
对齐参考 Excel。**白名单跨四个 section** —— 这些行并不集中在一处，白名单必须按
lineItemId 取，不能按 section 取：

| 显示行 | lineItemId | 所在 section |
|---|---|---|
| Total Revenue | `revenue.total` | revenue |
| ↳ Growth Over Prior Year | `growth.revenue.total` | revenue |
| Gross Profit | `gross_profit` | history |
| ↳ Margin % | `metric.gross_margin` | metrics |
| EBITDA | `ebitda` | operations |
| ↳ Margin % | `metric.ebitda_margin` | metrics |
| EBIT | `operating_income` | operations |
| ↳ Margin % | `margin.operating` | operations |
| Net Income | `net_income` | history |
| ↳ Margin % | `metric.net_margin` | metrics |

白名单里的行**允许缺席**：模型还没建到那一步时该行不存在，跳过即可，不留空行。

下面两个可折叠区放**完整**的 `history` 全量（映射进来的原始报表行）与 `metrics` 全量
（后端有 30 个默认指标：ROIC / ROE / FCF margin / 各类 CAGR…）。这两个 section 不属于
任何其他 sheet，摘要是它们唯一的归宿 —— 折叠区是入口，不是裁剪。

**利润表 / 资产负债表 / 现金流量表**。`sourceStatementReview.sheets` 原样渲染。行尾挂
勾稽不平在表头出警示带（来自 `reconciliations`）。

原本这里还要在行尾挂"映射到模型哪一行"的引用芯片，但 statement-mapping 那套 API 已在
`02682e2`（"remove the statement-mapping legacy"）里从引擎删除 —— `activeMappings` 和
`WorkbookRowView.mappingRefs` 都不复存在。这张表因此只剩原始行 + 勾稽警示带。

**分部**。`revenue` section 里属于该 category 的成员行 + 合计对账。成员的
`treatment`（add / subtract / exclude）要显示出来，否则合不上的时候看不懂。

**没有任何 category group 时，这一组退化成一张「收入」表，放 `revenue` section 全量。**
`revenue` section 不能无处安放 —— 摘要只白名单挑了 `revenue.total` 和它的增长率，剩下的
收入拆分行必须有归宿。有 category group 时，不属于任何 group 的 revenue 行也归到这张
「收入」表里，它和分部表并列存在。

**WACC**。`waccSheet` 12 行。每行显示 `source`（computed / agent / locked_formula /
empty）与 `value`，点开看 `provenance`（sourceType / sourceRefs / asOfDate / rationale）
和 `formulaSource`。beta 就是其中一行 —— 点开能看到窗口年数、市场基准、日/周 beta、
观测数、区间，判断 beta 靠不靠谱的信息量已经够了。`missingInputs` 非空的行要标出来。

**DCF**。三块纵向排列：`operations` section（EBIT→NOPAT→FCFF 推导，对应参考 Excel 里
DCF sheet 的上半部分）、`dcf` section、`valuation` 结果块（`explicitPeriods` 分期现值、
`perpetuityGrowth` 与 `exitMultiple` 两法并列、`waccByGrowth` 与 `waccByMultiple`
两张敏感性矩阵）。

## 6. 前端

### 6.1 类型：手写镜像 + 契约测试

client 目录对 `src/` 是完全隔离的 —— 现在一个跨目录 import 都没有，`core.ts` 开头就
写明了这是「本地镜像类型」的约定。照办，不为这个功能破例。

新建 `client/src/types/financialModel.ts`，镜像 `ModelContextView` /
`CurrentWorkbookView` / `WorkbookRowView` / `WorkbookCellView` / `Period` / `Unit` /
`WaccSheet` / `ValuationOutput` / `RevisionSummary` / `ModelView`。

镜像会漂移，这个风险正面处理：`src/financial-model/__tests__/viewContract.test.ts`
建一个真实模型，断言 `getModel()` 产出的 JSON 上确实存在 client 依赖的那批 key。
字段改名会当场红；加字段则无害地放过。这比「靠人记得同步」实在。

### 6.2 数据 hook

`client/src/hooks/useFinancialModel.ts`：

```ts
useFinancialModel(agentId, topicId) → {
  models: ModelView[]                      // ["financialModels", agentId, topicId]
  workbook: ModelContextView | undefined   // ["financialModel", modelId]
  changed: ChangedCells | null             // 刚变的 line item × period，带 revision 号
  onRevisionFrame(frame)                   // 交给 stream 调
}
```

`onRevisionFrame` 做三件事：累积 `changed`；`invalidateQueries(["financialModel", model_id])`；
若 `models` 里还没有这个 model_id 就一并 invalidate 列表查询（模型刚被 agent 创建的那一刻）。

**连发合并**：agent 常常连着提交好几个 revision（逐个 section 提交）。invalidate 做
150ms debounce 合并成一次重取；但 `changed` 在 debounce 窗口内是**累积**的，不是覆盖 ——
否则合并会吃掉前几次的高亮。

### 6.3 接线

`TopicWorkspace.tsx`，无循环依赖 —— 模型 hook 不依赖流，流只需要它的回调：

```ts
const model = useFinancialModel(agentId, topicId);
const stream = useResearchStream(..., { onModelRevision: model.onRevisionFrame });
```

`useTopicStream` 的 options 加一个 `onModelRevision` 兄弟回调，走和现有 `onDirective`
一样的「在 per-task 聚合之前把帧摘掉」的路子 —— 一次 revision 不是一条进度行，混进
任务列表里会把「agent 提交了第 47 版」和「agent 跑了一次扫描」摆成同一种东西。
`client/src/lib/api.ts` 的 `handleEvent` switch 加一支 `case 'model_revision'` 转发。

### 6.4 组件

新目录 `client/src/components/model/`：

```
ModelPane.tsx              标签内容壳：模型头（symbol · rev N · lifecycleStage）+ 底部 sheet 标签栏
WorkbookGrid.tsx           通用网格：期间列 × 行（含层级），所有表共用
WorkbookCell.tsx           一格：数值格式化 + 来源/状态视觉 + 高亮
CellInspector.tsx          点格子的溯源浮层（source / formulaSource / assumption / diagnostics）
SummarySheet.tsx           摘要（Key Financials 白名单 + 完整 history/metrics 折叠区）
SourceStatementSheet.tsx   三张原始报表之一 + 映射芯片 + 勾稽警示带
RevenueSheet.tsx           收入组：一个 category 一张，外加无 group 时的兜底全量表
WaccSheetView.tsx          12 行推导 + provenance
DcfSheet.tsx               operations + dcf + valuation 结果块
RevisionDrawer.tsx         修订历史抽屉
```

纯逻辑抽到 `client/src/lib/workbook.ts`（单位格式化、行层级、`sheetsTouchedBy`、
摘要白名单投影、changed-cell 命中判断），和 `topicCharts.ts` / `stockChart.ts` 现有
分法一致。组件保持薄。

`revisionHistory` 不做成 sheet —— 它是整个模型的属性，不是一张表。放 ModelPane 头部：
`AAPL · rev 47 · operations_fcff` 里的 `rev 47` 芯片可点，展开 `RevisionDrawer`。

### 6.5 视觉规则

这套要写死成规范，否则表会变成花的：

- 行标签列 `sticky left`，期间表头 `sticky top`；层级靠缩进 + 字重，不画树形连线。
- `Period.cls` 是历史/预测的分界：`forecast` 列组前一条竖分隔线 + 列头淡色底，一眼看出
  模型从哪开始预测。`ttm` 列单独标注。
- 单元格来源沿用金融建模的老规矩，用**字色**编码而非叠背景：`assumption` 蓝字（人工输入）、
  `formula` / `calculated` 默认色、`fact` 默认色但 inspector 里可追到 factId。金融背景的
  用户不用学。
- `status !== "ok"` 的四种显示：`missing_input` → 淡色 `—`；`divide_by_zero` → `#DIV/0!`；
  `not_applicable` → 留空；`not_modeled` → 极淡灰。
- 有 `diagnostics` 的格子右上角一个 2px 角标，点开即 CellInspector。
- 数值按 `Unit` 格式化：`currency` 千分位（量级统一提到列头标注，如 `US$ 千`）、
  `percent` 一位小数、`ratio` 两位、`per_share` 两位、`shares` 千分位整数。

**不引表格库**。原生 `<table>` + CSS sticky 够了。一个 workbook 是几十到几百行 × 十几列，
不需要虚拟滚动 —— 现在就上 react-table / ag-grid 是给未来的假设付钱。

## 7. 变动高亮与自动定位

### 7.1 哪张 sheet 动了

纯函数 `sheetsTouchedBy(frame, workbook) → sheetId[]`，放 `lib/workbook.ts`。它要同时看
**三个**输入，少一个都会漏：

```
1) change_kinds        wacc_sheet_refreshed | wacc_input_set  → WACC
                       valuation_config_set                   → DCF
2) changed_sections    source_*                → 对应原始报表
                       operations | dcf        → DCF
                       history | metrics       → 摘要
                       revenue                 → 收入组（下一条细分到具体哪张）
3) changed_line_item_ids
                       ∩ 摘要白名单 ≠ ∅        → 摘要
                       ∩ 某 category 的 members ≠ ∅ → 那张分部表
                       revenue 段其余变动      → 「收入」兜底表
```

三条缺一不可的原因，各自不同：

- 少了 `change_kinds`，改 WACC 永远不高亮 —— `changedSections` 的类型 `ModelReadSection`
  里根本没有 WACC（§3.1）。
- 少了 `changed_line_item_ids`，`revenue` section 的变动无法判断落在哪张分部表上，只能
  把整组都点亮。
- 只看 `changed_line_item_ids` 不看 `changed_sections`，则「新增了一行」这类改动
  （`line_item_added`）在白名单外时会静默。

反过来，`operations` 与 `revenue` 的变动**可能同时点亮两张表**（`ebitda` 既在摘要白名单
里，又在 DCF 的 operations 段中）。这是对的，不要去重成一张：函数返回数组，标签上的
小圆点按数组标记，自动定位只取第一个（按标签栏从左到右的顺序）。

### 7.2 高亮

`changed_line_item_ids × changed_period_ids` 的交叉格子加一个 class，CSS 动画 2s 淡出。
用 `key={revision}` 强制重挂，这样连着两次改同一格也能各闪一次。

### 7.3 自动定位的克制规则

不能 agent 一动就把用户的视线拽走。用户正在翻资产负债表对数，agent 在后台改了 DCF，
页面自己跳走就是抢控制权。

> 只在 **agent 回合进行中**（`isProcessing`）**且用户本回合没有手动点过标签**时，才自动
> 切到变动的 sheet 并把第一个变动行 `scrollIntoView({ block: "center" })`。用户一旦手动
> 点过任何标签，本回合内自动定位关闭，直到下一个回合重新开启。

没自动切时也不能让变化无声无息：那张 sheet 的标签上出现一个小圆点，点进去即消。

## 8. Tab 集成

`ChartPane` 现按 `TopicChartTab` 的 `kind` 分支渲染（`symbol` / `overlay`）。加第三支：

```ts
export type ModelTab = { kind: "model"; modelId: string; symbol: string };
export type TopicChartTab = SymbolChartTab | OverlayChartTab | ModelTab;
// chartTabKey → `model:${modelId}`
```

tab 来源与图表 tab 不同：图表是从消息历史 derive 的，模型 tab 直接来自
`GET .../topics/:topicId/models`，所以在 `mergeTopicCharts` 之外单独并入。**模型是后端的
客观存在，不是用户偏好，不写 `topicChartPreferences`。** tab 上带 `Table2` 图标 + ticker，
和股票 tab 一眼分得开。

拖拽排序、tear-off 到浮窗、关闭 —— 复用现有机制，`ModelPane` 对宽度无特殊要求。
**只有一处例外**：模型 tab 的 `×` 不写 hidden 偏好，因为下一帧 `model_revision` 会把它
带回来；关掉的语义是「这轮不看」，存进偏好会变成「永久藏掉一个还在长的模型」，是错的。

## 9. 不在范围

**可编辑单元格。** 所有修改仍通过对话。写路径要引入乐观并发冲突处理和 agent/用户
同时写的竞态，是独立一轮的事。

**Multiple Analysis（可比公司分析）。** 需要可比公司选集、各家的 TEV/EBITDA 等实时倒数、
LTM/NTM 口径 —— 后端 financial-model 引擎里没有任何 comps 概念，这是一个独立的后端项目。
本次**连标签都不出**：前端只渲染后端真实存在的 sheet，挂一个长期空壳会让标签栏这个
"进度条"失真。

**beta 明细回归表。** 参考 Excel 里是 2518 行日线 + log return + 协方差/方差。后端
`computeBeta()` 只返回标量（daily / weekly / average / 观测数 / 区间），不返回对齐后的
收益率序列。本次只在 WACC 表的 beta 行上展示结论与 provenance，零后端改动。要做完整
回归表需要改 `computeBeta` 的返回、加明细路由、前端上虚拟滚动 —— 单独一轮。

**前端组件渲染测试。** 见 §10。

## 10. 测试

跟着现有分层走，不新增框架：

| 层 | 位置 | 覆盖 |
|---|---|---|
| 视图契约 | `src/financial-model/__tests__/viewContract.test.ts` | 建真实模型 → 断言 `getModel()` JSON 上有 client 镜像依赖的那批 key |
| SSE 投影 | `src/server/__tests__/sseProjector.test.ts`（投影的现有测试就在这里，不另开目录） | 带 `model_id`+`revision` 的 tool_result → 一帧 `model_revision`；不带的 → 零帧；`changed_*` 取值正确；WACC 那种 `changedSections` 为空的 revision 仍带 `change_kinds` |
| 路由 | `src/server/__tests__/financialModelRoutes.test.ts` | 两个读路由的正常 / 404 / archived 过滤。路由逻辑独立成 `src/server/financialModelRoutes.ts`，照 `stockMarketRoutes.ts` 的先例 —— `server.ts` 里只留一行薄适配，逻辑才测得动 |
| 前端纯逻辑 | `client/src/lib/__tests__/workbook.test.ts` | `sheetsTouchedBy` 三条输入路径各一例（WACC 只走 `change_kinds`；revenue 变动经 lineItemId 落到正确的分部表；`line_item_added` 落在白名单外时仍由 `changed_sections` 兜住）、一次变动点亮两张表不去重、单位格式化、摘要白名单缺行时跳过、changed-cell 命中、行层级 |

前端组件本身不写渲染测试：这个仓库现在没有组件测试基建（`client/src/lib/__tests__`
全是纯函数测试），为一个只读视图引进 jsdom + testing-library 不划算。所以逻辑全部推到
`lib/workbook.ts` 里测，组件保持薄到不值得测。

## 11. 交付顺序

1. 后端两个路由 + `viewContract` 测试 —— 前端可以先用真实数据开发
2. SSE 帧 + 投影 + 测试
3. `lib/workbook.ts` 纯逻辑 + 测试
4. `WorkbookGrid` / `WorkbookCell` / `CellInspector` 三个基础件
5. 各张 sheet（原始报表 → 摘要 → WACC → DCF → 分部）
6. hook + 接线 + tab 集成
7. 高亮与自动定位

第 1、2 步互不依赖，可并行。第 4 步之后每张 sheet 之间互不依赖，可并行。
