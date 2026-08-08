# DCF Workbench Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DCF 编排 agent 三个新工具——两级渐进式读数据层（`list_unified_statements` / `get_unified_rows`，选择参数沿树细分到 member 层）+ 统一 DSL 执行器（`calculate_model_rows`，Excel 语义、每行落库为 `metric.custom.*` 科目）。

**Architecture:** 读工具零新存储，直接消费 `sourceReviewStore` 的 unified artifact；执行器把整批行编译成一个 `applyOperations` 批（先全部 `add_line_item` 再全部 `set_formula`，行间引用交给 DSL 依赖图，环引用由 graph 的 `circular_dependency` 拒绝，一次调用一个 revision）。前置管道修理：`LineItem` 加可选 `description`，`assertMutableDefinition` 放行 `metric.custom.` 前缀。

**Tech Stack:** TypeScript（Node --experimental-strip-types）、node:test。无新依赖。

**Spec:** `docs/superpowers/specs/2026-08-08-dcf-agent-workbench-tools-design.md`（公式手册 skill 条目明确不在本期范围）。

## Global Constraints

- **不要执行 `git commit`**——每 task 结束 `git add` 暂存并汇报，用户 review 后自己提交。
- 工具定义放 `mcp_tools/financial-model/`（新文件 `workbenchTools.ts`，照 `waccTool.ts` 先例）；prompt 文本只进 `src/agent/prompts/`。
- 预算 host 固定：`get_unified_rows` 单页 ≤40 行；选择参数（statement/parentRowId/axisQName/parentMemberQName/memberQNames/memberFilter/rowIds/cursor）全部开放给 agent。
- 参数行 id 命名空间 `metric.custom.<slug>`（slug `^[a-z][a-z0-9_]*$`）；unit 缺省 `{kind:"ratio"}`；label 缺省由 slug 生成（下划线转空格）。
- 权限：所有工具 owner 校验，非 owner 一律 `financial_model_not_found`（不泄露存在性）。
- 单测：`node --env-file=.env --experimental-strip-types --experimental-sqlite --test <file>`；全量 `npm test`；类型 `npx tsc -p tsconfig.json --noEmit` 必须干净。
- 老快照兼容：读 `unified.breakdownRows ?? []`；`description` 缺省 undefined 不得使 codec/校验报错。

---

### Task 1: `LineItem.description` 贯通

**Files:**
- Modify: `src/financial-model/types.ts`（`LineItem`）
- Modify: `src/financial-model/operations.ts`（`NewExtensibleLineItem` + `addExtensibleLineItem` custom_metrics 分支）
- Modify: `src/financial-model/views.ts`（`WorkbookRowView` + `buildDcfRow`）
- Modify: `src/financial-model/snapshotCodec.ts`（若 codec 显式白名单字段则补 `description`；若透传则只加测试）
- Test: `src/financial-model/__tests__/service.test.ts`（追加）

**Interfaces:**
- Produces: `LineItem.description?: string`；`NewExtensibleLineItem.description?: string`；`WorkbookRowView.description?: string`。exactOptionalPropertyTypes 开着——一律条件展开 `...(x !== undefined ? { description: x } : {})`，不许赋 undefined。

- [ ] **Step 1: 写失败测试（追加到 service.test.ts，用现有 `setup()`/`CREATE_INPUT`）**

```ts
test("a custom metric row carries its description into the workbook view and survives codec round-trip", () => {
  const { store, service } = setup();
  service.createModel(CREATE_INPUT);
  service.applyOperations("model-1", 0, [
    { kind: "add_line_item", lineItem: { id: "metric.custom.opex_ratio", label: "Opex ratio",
      parentId: "custom_metrics", unit: { kind: "ratio" }, description: "Operating expense intensity" } },
  ]);
  const view = service.getModel("model-1");
  assert.ok("currentWorkbook" in view);
  const row = view.currentWorkbook.sections.metrics.find((r) => r.lineItemId === "metric.custom.opex_ratio");
  assert.equal(row?.description, "Operating expense intensity");
  // codec round-trip: encode → decode 后 description 仍在；老行（无 description）不受影响
  const snapshot = store.getRevision("model-1")!.snapshot;
  const decoded = financialModelSnapshotCodec.decode(financialModelSnapshotCodec.encode(snapshot));
  assert.equal(decoded.lineItems.find((i) => i.id === "metric.custom.opex_ratio")?.description, "Operating expense intensity");
});
```

（`financialModelSnapshotCodec` 该文件已 import。若 codec API 名称不同，以 `snapshotCodec.ts` 实际导出为准并在报告注明。）

- [ ] **Step 2: 运行确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/financial-model/__tests__/service.test.ts`
Expected: FAIL —— `description` 不在 NewExtensibleLineItem 类型上 / row.description undefined

- [ ] **Step 3: 实现**

types.ts `LineItem` 与 operations.ts `NewExtensibleLineItem` 各加 `description?: string`；`addExtensibleLineItem` 的 custom_metrics 分支 push 时 `...(input.description !== undefined ? { description: input.description } : {})`；views.ts `WorkbookRowView` 加 `description?: string`，`buildDcfRow` 同样条件展开；打开 `snapshotCodec.ts` 检查 lineItems 的 encode/decode——若逐字段拷贝则补 description（同条件展开），若整体 structuredClone/JSON 透传则无需改。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2 + `npx tsc -p tsconfig.json --noEmit`
Expected: PASS + TSC 干净

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add src/financial-model/types.ts src/financial-model/operations.ts src/financial-model/views.ts src/financial-model/snapshotCodec.ts src/financial-model/__tests__/service.test.ts
```

---

### Task 2: `assertMutableDefinition` 放行 `metric.custom.*`

**Files:**
- Modify: `src/financial-model/operations.ts:174-181`
- Test: `src/financial-model/__tests__/service.test.ts`（追加）

**Interfaces:**
- Produces: `set_formula` / `set_line_item_source` 对 `metric.custom.*` 行放行；registry metric 行（如 `metric.roa`）与 `REGISTRY_DRIVER_IDS` 六行照旧拒绝。

- [ ] **Step 1: 写失败测试**

```ts
test("metric.custom rows accept formulas while registry metrics and fixed drivers stay immutable", () => {
  const { service } = setup();
  service.createModel(CREATE_INPUT);
  const result = service.applyOperations("model-1", 0, [
    { kind: "add_line_item", lineItem: { id: "metric.custom.gm", label: "GM", parentId: "custom_metrics", unit: { kind: "ratio" } } },
    { kind: "set_formula", formula: { lineItemId: "metric.custom.gm", appliesTo: "historical",
      source: "revenue.total / revenue.total", periodIds: ["FY2024", "FY2025"] } },
  ]);
  assert.equal(result.revision, 1);
  assert.throws(() => service.applyOperations("model-1", 1, [
    { kind: "set_formula", formula: { lineItemId: "metric.roa", appliesTo: "historical", source: "net_income", periodIds: ["FY2024"] } },
  ]), invalidCode("invalid_model_operation"));
  assert.throws(() => service.applyOperations("model-1", 1, [
    { kind: "set_formula", formula: { lineItemId: "margin.operating", appliesTo: "historical", source: "net_income", periodIds: ["FY2024"] } },
  ]), invalidCode("invalid_model_operation"));
});
```

- [ ] **Step 2: 运行确认失败**（第一段 applyOperations 抛 "registry-owned definition is immutable"）

- [ ] **Step 3: 实现**

```ts
function assertMutableDefinition(item: LineItem): void {
  // metric.custom.* is agent-owned: no engine identity or default chain reads it, so redefining it
  // can only affect chains the agent built itself. Registry metrics and the fixed drivers stay locked.
  if ((item.section === "metrics" && !item.id.startsWith("metric.custom.")) || REGISTRY_DRIVER_IDS.has(item.id)) {
    operationError(`registry-owned definition is immutable: ${item.id}`);
  }
  if (item.historical === "calculated" || item.forecast === "calculated") {
    operationError(`engine-native row is immutable: ${item.id}`);
  }
}
```

- [ ] **Step 4: 运行确认通过**（该测试文件全量 + `npm test` 确认无既有用例依赖旧行为）

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add src/financial-model/operations.ts src/financial-model/__tests__/service.test.ts
```

---

### Task 3: 读工具 `list_unified_statements` / `get_unified_rows`

**Files:**
- Create: `mcp_tools/financial-model/workbenchTools.ts`
- Modify: `src/infra/xbrl/spineFromUnified.ts`（把 `resolveDetailLineItemIds` 内的 member 末段 slug 逻辑提为导出 `memberSlug(rowId: string): string`，原处改调用）
- Modify: `mcp_tools/registerTools.ts` + `mcp_tools/financial-model/financialModelTools.ts`（`FINANCIAL_MODELING_TOOLS` 增补两个名字）
- Test: `mcp_tools/financial-model/__tests__/workbenchTools.test.ts`

**Interfaces:**
- Consumes: `FinancialModelToolDeps`（modelStore + sourceReviewStore）；`UnifiedStatementsArtifact.rows/breakdownRows/periods`；`BreakdownRow.parentMemberQName`。
- Produces:

```ts
export const WORKBENCH_TOOLS = ["list_unified_statements", "get_unified_rows", "calculate_model_rows"] as const;
export function createWorkbenchTools(deps?: FinancialModelToolDeps): RegisteredTool[];
export const UNIFIED_ROWS_PAGE = 40;
```

行为：
- 两工具共用前置：`requireOwner` 同款校验（modelStore.getMeta + ownerAgentId）→ `sourceReviewStore.get(modelId)?.unifiedStatements`，缺失返回 `error.code = "unified_statements_unavailable"`，message 提示先跑 statement_unification。
- `list_unified_statements` `{modelId, statement?}` → `{ periods, rows: [{rowId,label,statement,periodsCovered}], breakdownAxes: [{axisQName, parentRowId, memberCount, hasMemberTree, inWorkbook}] }`。`periodsCovered` = values 非 null 的期数；`hasMemberTree` = 该 (axis,parentRow) 组任一行带 `parentMemberQName`；`inWorkbook` = 当前 snapshot 的 lineItems 中存在 `revenue.${memberSlug(row.rowId)}` 或以 `.${memberSlug(row.rowId)}` 结尾且 `revenue.` 开头的 id（启发式，注释说明）。
- `get_unified_rows`：过滤器 AND 组合、`rowIds` 直通绕过过滤、`memberFilter` 大小写不敏感匹配 label/memberQName、`parentMemberQName` 精确匹配 breakdown 行的同名字段；候选 = unified rows（statement/parentRowId 适用）∪ breakdown rows（全部过滤器适用；`parentRowId` 对 breakdown 行匹配其 `parentRowId` 字段）；排序稳定（unified 先、breakdown 后，各按原序）；`cursor`（非负整数）+ `UNIFIED_ROWS_PAGE` 截断，截断时返回 `nextCursor`。输出行：`{rowId,label,statement?,axisQName?,parentMemberQName?,values}`（条件展开可选字段）。

- [ ] **Step 1: 写失败测试**

fixture 参考 `dcfSubagentTool.test.ts` 的 stores 搭建方式（InMemory 各 store + service.createModel + sourceReviewStore.save 一个带 rows/breakdownRows 的 unified artifact；breakdown 行覆盖两条轴，其中产品轴带 `parentMemberQName` 两层树）。用例（每条都断言具体行 id 集合）：

```ts
test("list returns catalog without values and marks axes with member trees", ...);
test("list with statement filter narrows to that sheet's rows", ...);
test("get filters compose down the tree to exact members", () => {
  // {parentRowId:"net_sales", axisQName:PROD, parentMemberQName:"us-gaap:ProductMember"} → 恰好两个叶子
});
test("get memberFilter matches label case-insensitively and rowIds bypasses filters", ...);
test("get paginates at 40 with nextCursor", ...); // 构造 45 条 breakdown 行
test("missing artifact and foreign owner fail with the documented codes", ...);
```

- [ ] **Step 2: 运行确认失败**（module not found）

- [ ] **Step 3: 实现**（工具骨架照 `waccTool.ts` 的 RegisteredTool 形态；纯过滤逻辑提成文件内小函数便于直测；`memberSlug` 从 spineFromUnified 导出复用，勿复制粘贴）

- [ ] **Step 4: 运行确认通过 + `npm test`**（spineFromUnified 重构不得破坏其测试）

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add mcp_tools/financial-model/workbenchTools.ts mcp_tools/financial-model/__tests__/workbenchTools.test.ts src/infra/xbrl/spineFromUnified.ts mcp_tools/registerTools.ts mcp_tools/financial-model/financialModelTools.ts
```

---

### Task 4: `calculate_model_rows`

**Files:**
- Modify: `mcp_tools/financial-model/workbenchTools.ts`（追加第三个工具）
- Test: `mcp_tools/financial-model/__tests__/workbenchTools.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `description` 贯通、Task 2 的放行；`FinancialModelService.applyOperations(modelId, expectedRevision, ModelOperation[])`。
- Produces: 工具 `calculate_model_rows`，输入 schema：

```ts
{ type: "object", additionalProperties: false, required: ["modelId", "expectedRevision", "rows"], properties: {
  modelId: { type: "string" }, expectedRevision: { type: "number" },
  rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "formula"],
    properties: { id: { type: "string" }, formula: { type: "string" },
      label: { type: "string" }, description: { type: "string" }, unit: { type: "object" } } } } } }
```

执行逻辑（全在 execute 内，顺序即规格）：
1. 校验每个 `id` 匹配 `^[a-z][a-z0-9_]*$`，批内不重复；`fullId = \`metric.custom.${id}\``。
2. slug 展开：对每条 formula，用 `/[A-Za-z_][A-Za-z0-9_.]*/g` 分词，token 恰好等于批内某 slug 时替换为其 fullId（`metric.custom.` 开头的 token 原样保留）。
3. 组批：先 N 条 `{kind:"add_line_item", lineItem:{id: fullId, label: label ?? slug.replace(/_/g," "), parentId:"custom_metrics", unit: unit ?? {kind:"ratio"}, ...(description? {description}:{})}}`，再 N 条 `{kind:"set_formula", formula:{lineItemId: fullId, appliesTo:"historical", source: expanded, periodIds: <snapshot 全部 actual 期 id>}}`。
4. `service.applyOperations(modelId, expectedRevision, batch)` —— 环引用/未知科目/重名由现有校验抛出，`toolError` 风格返回（错误码沿用 FinancialModelError）。
5. 成功响应：`summary` 含新 revision 与行数；`generation_context.data = { model_id, revision, rows: [{ lineItemId, label, description?, formula, values }] }`，values 从 `result.currentWorkbook.sections.metrics` 摘取该行 cells 的 value。

- [ ] **Step 1: 写失败测试**

```ts
test("calculate stages a mini sheet: out-of-order cross references compute in one revision", () => {
  // rows: [{id:"b", formula:"a * 2"}, {id:"a", formula:"revenue.total / revenue.total"}]
  // 断言: revision +1；b 的 FY2024/FY2025 值为 2；views 带回公式源码与 description
});
test("a circular batch is rejected atomically", () => {
  // a→b→a：error 存在，revision 未推进（getMeta/getRevision 校验）
});
test("duplicate slug in one batch is rejected before any operation runs", ...);
test("a formula referencing an unknown line item fails the whole batch", ...);
test("foreign owner gets financial_model_not_found", ...);
```

（fixture 复用 Task 3 的 setup；revenue.total 历史值经 stageSpineFacts + reviewFacts 或直接 `service.stageFacts`+review 铺一条，参考 service.test.ts 的既有铺数据方式，保证公式有输入。）

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**（如上 5 步逻辑；分词替换写成文件内纯函数 `expandSlugs(formula, slugs): string` 并单测覆盖 `metric.custom.` 原样保留与 `a`≠`abc` 的边界）

- [ ] **Step 4: 运行确认通过 + `npx tsc --noEmit` + `npm test`**

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add mcp_tools/financial-model/workbenchTools.ts mcp_tools/financial-model/__tests__/workbenchTools.test.ts
```

---

### Task 5: 编排 prompt 增补 + 收尾回归

**Files:**
- Modify: `src/agent/prompts/subagentPrompts.ts`（`financialModelingSubagentPrompt`）

- [ ] **Step 1: prompt 增补**

在 WACC 段之后、"BUILDING THE FORECAST"段之前插入一段（工具用法叙事，不含公式手册条目——手册另期以 skill 交付）：

```
EVIDENCE AND PARAMETERS. list_unified_statements / get_unified_rows read the unified statements and
every dimensional breakdown behind this model — including axes that never entered the workbook (e.g. a
geographic split) — narrowing statement → parent row → axis → member as far as you need. Use them to
ground forecast assumptions in disclosed data instead of recalling it. calculate_model_rows is your
worksheet: each row is {id, formula, label?, description?}, formulas are the same DSL as set_formula,
rows may reference each other in any order, and every row persists as metric.custom.<id> with its
formula and description on the record. Never do arithmetic in prose — put it in a row.
```

- [ ] **Step 2: 全量回归**

Run: `npm test` + `npx tsc -p tsconfig.json --noEmit`
Expected: 全绿 + 干净（`FINANCIAL_MODELING_TOOLS` 变了，registerSubagents 的 allowedTools 随 const 自动生效；确认无快照断言破裂）

- [ ] **Step 3: 暂存（不 commit）**

```bash
git add src/agent/prompts/subagentPrompts.ts
```

---

## Self-Review 记录

- **Spec 覆盖**：两级读工具（Task 3，树状参数到 member 层：statement/parentRowId/axisQName/parentMemberQName/memberQNames/memberFilter/rowIds/cursor）✓；统一 DSL 执行器单态全落库（Task 4）✓；description 贯通（Task 1）✓；metric.custom 放行（Task 2）✓；40 行预算 host 固定 ✓；公式手册条目明确出范围（Task 5 只写工具叙事）✓；WACC 不新增 ✓。
- **类型一致性**：`WORKBENCH_TOOLS`/`createWorkbenchTools`/`UNIFIED_ROWS_PAGE`/`memberSlug`/`expandSlugs`/`metric.custom.<slug>` 各任务名称已核对。
- **已知取舍**：`inWorkbook` 是启发式（member slug 对照 lineItem id），实现处注释说明；`unit` schema 用宽松 object（严格 Unit oneOf 由底层 add_line_item 校验兜底）。
