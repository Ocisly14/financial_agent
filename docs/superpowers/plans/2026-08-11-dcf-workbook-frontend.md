# DCF 模型工作簿前端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已经跑通的后端 DCF 流程配一个 Excel 式只读实况看板，agent 每提交一次 revision，前端表格自动刷新并高亮刚变的格子。

**Architecture:** 后端新增两个只读 HTTP 路由（复用同一个 SQLite store 单例）和一帧轻量 SSE 信号 `model_revision`；前端凭信号 invalidate react-query 缓存去重取完整工作簿。建模引擎一行不改。

**Tech Stack:** Node 23 原生 `node:test` + `--experimental-strip-types`、React 19 + Vite + Tailwind + react-query v5、原生 `<table>` + CSS sticky（不引表格库）。

**Spec:** `docs/superpowers/specs/2026-08-11-dcf-workbook-frontend-design.md`

## Global Constraints

- **不要执行任何 git 命令。** 本计划的每个任务以「跑测试确认通过」收尾，**不 commit、不 add、不 push**。全部任务完成后由用户统一审阅。这覆盖 subagent-driven-development / executing-plans 里所有关于提交的默认步骤。
- **后端建模引擎一行都不改。** 不得修改 `src/financial-model/` 下除 `__tests__/` 以外的任何文件，也不得修改 `mcp_tools/financial-model/`。新增只有：`src/server/financialModelRoutes.ts`、`src/server/server.ts` 的路由分支、`src/framework/types.ts` 的一支联合成员、`src/infra/events/sseProjector.ts` 的一个投影分支，以及 `client/` 下的新文件。
- **client 目录不得 import `src/` 下的任何东西。** 现在一个跨目录 import 都没有，`client/src/types/core.ts` 开头写明了「本地镜像类型」的约定。类型手写镜像，靠 Task 2 的契约测试防漂移。
- **client 内的测试文件用相对路径 import，不用 `@/` 别名。** 这些测试跑在 node 下，没有 Vite 的路径解析。照 `client/src/lib/__tests__/topicCharts.test.ts` 的写法。
- 跑全部测试：`pnpm test`
- 跑单个测试文件：`node --env-file=.env --experimental-strip-types --experimental-sqlite --test <路径>`
- 新增的测试文件路径必须落在 `package.json` `test` 脚本已有的 glob 内（`src/server/__tests__/*.test.ts`、`src/financial-model/**/__tests__/*.test.ts`、`client/src/lib/__tests__/*.test.ts` 均已覆盖），否则 `pnpm test` 不会跑到它。

---

## 文件结构

**新建（后端）**
- `src/server/financialModelRoutes.ts` — 两个读路由的纯逻辑，返回 `{ status, body }`，不碰 `http.ServerResponse`。照 `src/server/stockMarketRoutes.ts` 的先例：逻辑独立成模块，`server.ts` 里只留一行薄适配。
- `src/server/__tests__/financialModelRoutes.test.ts`
- `src/financial-model/__tests__/viewContract.test.ts` — 前端镜像类型的防漂移契约测试。

**修改（后端）**
- `src/framework/types.ts` — `SSEEvent` 联合加一支 `model_revision`。
- `src/infra/events/sseProjector.ts` — `tool_result` 分支加投影。
- `src/server/__tests__/sseProjector.test.ts` — 追加投影测试。
- `src/server/server.ts` — 路由分支两处。

**新建（前端）**
- `client/src/types/financialModel.ts` — 后端视图类型的手写镜像。
- `client/src/lib/workbook.ts` — 全部纯逻辑（格式化、行层级、sheet 派生、变更命中）。
- `client/src/lib/__tests__/workbook.test.ts`
- `client/src/hooks/useFinancialModel.ts` — 数据与变更状态。
- `client/src/components/model/` — 九个组件（见 Task 8~10）。

**修改（前端）**
- `client/src/lib/api.ts` — 两个 GET 方法 + SSE `model_revision` 分支。
- `client/src/hooks/useTopicStream.ts` — `onModelRevision` 回调。
- `client/src/hooks/useResearchStream.ts` — 透传该回调。
- `client/src/lib/topicCharts.ts` — `TopicChartTab` 加 `ModelTab` 一支。
- `client/src/components/workspace/ChartPane.tsx` — 渲染分支加 `model`。
- `client/src/components/workspace/ChartTabBar.tsx` — 标签外观加 `model` 分支。
- `client/src/components/workspace/TopicWorkspace.tsx` — 接线。

---

## Task 1: 后端两个只读路由

**Files:**
- Create: `src/server/financialModelRoutes.ts`
- Create: `src/server/__tests__/financialModelRoutes.test.ts`
- Modify: `src/server/server.ts`

**Interfaces:**
- Consumes: `FinancialModelService`、`InMemoryModelStore`、`financialModelSnapshotCodec`（均已存在）
- Produces: `listTopicModels(deps, agentId, topicId) → { status: 200; body: { models: ModelView[] } }`；`getModelContext(deps, modelId) → { status: 200; body: ModelContextView } | { status: 404; body: { success: false; error: string } }`；`type FinancialModelReadDeps = { modelStore: ModelStore<FinancialModelSnapshot, RevisionChangeSummary> }`

- [ ] **Step 1: 写失败的测试**

创建 `src/server/__tests__/financialModelRoutes.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { FinancialModelService, type CreateModelInput, type RevisionChangeSummary } from "../../financial-model/service.ts";
import type { FinancialModelSnapshot } from "../../financial-model/operations.ts";
import { financialModelSnapshotCodec } from "../../financial-model/snapshotCodec.ts";
import { InMemoryModelStore } from "../../financial-model/store.ts";
import type { Period } from "../../financial-model/types.ts";
import { getModelContext, listTopicModels } from "../financialModelRoutes.ts";

const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" },
];

function createInput(overrides: Partial<CreateModelInput> = {}): CreateModelInput {
  return {
    modelId: "model-1",
    ownerAgentId: "agent-1",
    originSessionId: "topic-1",
    symbol: "TEST",
    metadata: { companyName: "Synthetic Company" },
    reportingCurrency: "USD",
    periods: PERIODS,
    preparedStatementRows: [{
      sourceLineItemId: "source.income_statement.revenue",
      statement: "income_statement",
      label: "Revenue",
      unit: { kind: "currency", code: "USD" },
      order: 1,
    }],
    ...overrides,
  };
}

function setup() {
  const modelStore = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  return { deps: { modelStore }, service: new FinancialModelService(modelStore, "test-session") };
}

test("listTopicModels returns only the models a topic owns", () => {
  const { deps, service } = setup();
  service.createModel(createInput());
  service.createModel(createInput({ modelId: "model-2", originSessionId: "topic-2", symbol: "OTHER" }));

  const result = listTopicModels(deps, "agent-1", "topic-1");

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.models.map((model) => model.modelId), ["model-1"]);
  assert.equal(result.body.models[0]?.symbol, "TEST");
});

test("listTopicModels hides archived models", () => {
  const { deps, service } = setup();
  const created = service.createModel(createInput());
  service.archive("model-1", created.revision);

  assert.deepEqual(listTopicModels(deps, "agent-1", "topic-1").body.models, []);
});

test("getModelContext returns the full workbook context", () => {
  const { deps, service } = setup();
  service.createModel(createInput());

  const result = getModelContext(deps, "model-1");

  assert.equal(result.status, 200);
  assert.ok("currentWorkbook" in result.body);
  assert.equal(result.body.model.symbol, "TEST");
  assert.deepEqual(result.body.currentWorkbook.periods.map((period) => period.id), ["FY2024", "FY2025"]);
});

test("getModelContext reports 404 for an unknown model", () => {
  const { deps } = setup();

  const result = getModelContext(deps, "nope");

  assert.equal(result.status, 404);
  assert.equal(result.body.success, false);
});

test("getModelContext still reads an archived model by id", () => {
  const { deps, service } = setup();
  const created = service.createModel(createInput());
  service.archive("model-1", created.revision);

  assert.equal(getModelContext(deps, "model-1").status, 200);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/server/__tests__/financialModelRoutes.test.ts`
Expected: FAIL — `Cannot find module '../financialModelRoutes.ts'`

- [ ] **Step 3: 写实现**

创建 `src/server/financialModelRoutes.ts`：

```ts
import { FinancialModelError } from "../financial-model/errors.ts";
import type { FinancialModelSnapshot } from "../financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../financial-model/service.ts";
import type { ModelStore, ModelView } from "../financial-model/store.ts";
import type { ModelContextView } from "../financial-model/views.ts";

export type FinancialModelReadDeps = {
  modelStore: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>;
};

/** The service takes a session id only to stamp `creatingSessionId` on writes.
 *  These routes never write, so a constant is honest — inventing a session id
 *  here would put a fictional author on nothing. */
const READ_SESSION_ID = "http-read";

export type RouteResult<T> = { status: 200; body: T } | { status: 404; body: { success: false; error: string } };

/** The tab strip's source. A topic id IS its session id, so ownership is a
 *  plain filter — no join table needed. Archived models are excluded: history
 *  should stay readable by id, but a live tab strip is not where it belongs. */
export function listTopicModels(
  deps: FinancialModelReadDeps,
  agentId: string,
  topicId: string,
): { status: 200; body: { models: ModelView[] } } {
  const service = new FinancialModelService(deps.modelStore, READ_SESSION_ID);
  const models = service.listModels({ ownerAgentId: agentId, originSessionId: topicId, includeArchived: false });
  return { status: 200, body: { models } };
}

/** Passing no options is what makes `getModel` return the full context view
 *  rather than a slice — see `FinancialModelService.getModel`. */
export function getModelContext(
  deps: FinancialModelReadDeps,
  modelId: string,
): RouteResult<ModelContextView> {
  const service = new FinancialModelService(deps.modelStore, READ_SESSION_ID);
  try {
    return { status: 200, body: service.getModel(modelId) as ModelContextView };
  } catch (error) {
    if (error instanceof FinancialModelError && error.code === "financial_model_not_found") {
      return { status: 404, body: { success: false, error: `model not found: ${modelId}` } };
    }
    throw error;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/server/__tests__/financialModelRoutes.test.ts`
Expected: PASS，5 个测试全绿

- [ ] **Step 5: 接进 server.ts**

在 `src/server/server.ts` 顶部 import 区加：

```ts
import { getModelContext, listTopicModels } from "./financialModelRoutes.ts";
import { getDefaultFinancialModelToolDeps } from "../../mcp_tools/financial-model/financialModelTools.ts";
```

在 `const topicChartsMatch = ...` 那一段**之前**插入（`/charts` 的正则不会误吞 `/models`，但放在前面读起来更顺）：

```ts
      const topicModelsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topics\/([^/]+)\/models$/);
      if (topicModelsMatch && method === "GET") {
        const result = listTopicModels(
          { modelStore: getDefaultFinancialModelToolDeps().modelStore },
          decodeURIComponent(topicModelsMatch[1]!),
          decodeURIComponent(topicModelsMatch[2]!),
        );
        return jsonOk(res, { success: true, ...result.body });
      }

      const financialModelMatch = pathname.match(/^\/api\/financial-models\/([^/]+)$/);
      if (financialModelMatch && method === "GET") {
        const result = getModelContext(
          { modelStore: getDefaultFinancialModelToolDeps().modelStore },
          decodeURIComponent(financialModelMatch[1]!),
        );
        if (result.status === 404) return jsonError(res, 404, result.body.error);
        return jsonOk(res, { success: true, ...result.body });
      }
```

- [ ] **Step 6: 跑全部测试确认没有回归**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 2: 视图契约测试（防镜像漂移）

**Files:**
- Create: `src/financial-model/__tests__/viewContract.test.ts`

**Interfaces:**
- Consumes: `FinancialModelService.getModel`
- Produces: 无导出。这个测试是 Task 4 手写镜像类型的守卫 —— 后端字段一改名它就红。

- [ ] **Step 1: 写测试**

创建 `src/financial-model/__tests__/viewContract.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialModelSnapshot } from "../operations.ts";
import { FinancialModelService, type CreateModelInput, type RevisionChangeSummary } from "../service.ts";
import { financialModelSnapshotCodec } from "../snapshotCodec.ts";
import { InMemoryModelStore } from "../store.ts";
import type { ModelContextView } from "../views.ts";
import type { Period } from "../types.ts";

/**
 * `client/src/types/financialModel.ts` hand-mirrors these view types, because
 * the client bundle must not import from `src/`. A rename on this side would
 * otherwise silently blank a column in the UI. This test is the tripwire:
 * every key the client reads is asserted present on a real model's JSON.
 * Adding fields stays free; renaming one fails here.
 */
const PERIODS: Period[] = [
  { id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" },
  { id: "FY2025", label: "FY2025", start: "2025-01-01", end: "2025-12-31", cls: "forecast" },
];

function buildContext(): ModelContextView {
  const store = new InMemoryModelStore<FinancialModelSnapshot, RevisionChangeSummary>(financialModelSnapshotCodec);
  const service = new FinancialModelService(store, "contract-session");
  const input: CreateModelInput = {
    modelId: "contract-model",
    ownerAgentId: "agent-1",
    originSessionId: "topic-1",
    symbol: "TEST",
    metadata: { companyName: "Synthetic Company" },
    reportingCurrency: "USD",
    periods: PERIODS,
    preparedStatementRows: [{
      sourceLineItemId: "source.income_statement.revenue",
      statement: "income_statement",
      label: "Revenue",
      unit: { kind: "currency", code: "USD" },
      order: 1,
    }],
  };
  service.createModel(input);
  return service.getModel("contract-model") as ModelContextView;
}

function assertHasKeys(value: unknown, keys: string[], label: string): void {
  assert.ok(value && typeof value === "object", `${label} should be an object`);
  for (const key of keys) {
    assert.ok(key in (value as Record<string, unknown>), `${label} is missing key "${key}"`);
  }
}

test("model context view exposes the top-level keys the client mirrors", () => {
  const context = buildContext();
  assertHasKeys(context, ["model", "revisionHistory", "currentWorkbook"], "ModelContextView");
  assertHasKeys(context.model, ["modelId", "symbol", "currentRevision", "lifecycleStage", "ownerAgentId", "originSessionId"], "ModelView");
});

test("current workbook exposes the keys the client mirrors", () => {
  const workbook = buildContext().currentWorkbook;
  assertHasKeys(workbook, [
    "modelId", "revision", "lifecycleStage", "periods", "sections",
    "categoryGroups", "reconciliationResults", "valuationConfig",
    "diagnostics", "valuation", "waccSheet", "mode",
  ], "CurrentWorkbookView");
  assertHasKeys(workbook.sections, ["history", "metrics", "revenue", "operations", "dcf"], "sections");
});

test("periods expose the keys the client mirrors", () => {
  const period = buildContext().currentWorkbook.periods[0];
  assertHasKeys(period, ["id", "label", "start", "end", "cls"], "Period");
});

test("workbook rows and cells expose the keys the client mirrors", () => {
  const rows = buildContext().currentWorkbook.sections.operations;
  assert.ok(rows.length > 0, "operations section should have rows");
  const row = rows[0]!;
  assertHasKeys(row, [
    "lineItemId", "label", "section", "role", "unit", "order",
    "sources", "formulas", "assumptions", "cells",
  ], "WorkbookRowView");
  const cell = row.cells[PERIODS[0]!.id];
  assertHasKeys(cell, ["value", "status", "source", "diagnostics"], "WorkbookCellView");
});

test("the wacc sheet exposes the keys the client mirrors", () => {
  const waccSheet = buildContext().currentWorkbook.waccSheet;
  assert.ok(waccSheet, "a new model should already carry a wacc sheet");
  assertHasKeys(waccSheet, ["asOfDate", "rows"], "WaccSheet");
  assertHasKeys(waccSheet.rows[0], ["rowId", "label", "unit", "source", "value", "missingInputs"], "WaccSheetRow");
});

test("revision summaries expose the keys the model_revision frame is built from", () => {
  const [summary] = buildContext().revisionHistory;
  assertHasKeys(summary, [
    "revision", "parentRevision", "lifecycleStage", "createdAt",
    "changes", "changedSections", "warningCount",
  ], "RevisionSummary");
});

test("the summary sheet whitelist line items exist in the skeleton", () => {
  // Keep in sync with SUMMARY_ROWS in client/src/lib/workbook.ts (Task 6).
  // The client picks these by id across four sections; a skeleton rename would
  // otherwise blank the summary sheet with no error anywhere.
  const sections = buildContext().currentWorkbook.sections;
  const allIds = new Set(
    [...sections.history, ...sections.metrics, ...sections.revenue, ...sections.operations]
      .map((row) => row.lineItemId),
  );
  for (const id of [
    "revenue.total", "growth.revenue.total",
    "gross_profit", "metric.gross_margin",
    "ebitda", "metric.ebitda_margin",
    "operating_income", "margin.operating",
    "net_income", "metric.net_margin",
  ]) {
    assert.ok(allIds.has(id), `summary whitelist line item "${id}" no longer exists`);
  }
});
```

- [ ] **Step 2: 跑测试**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/financial-model/__tests__/viewContract.test.ts`
Expected: PASS，7 个测试全绿。

如果最后一个测试失败（某个 whitelist id 不存在），**不要改测试去将就** —— 去 `src/financial-model/skeleton.ts` 和 `metrics.ts` 查该行的真实 id，把正确的 id 写回测试，并同步记下来给 Task 6 用。

- [ ] **Step 3: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 3: SSE 帧与投影

**Files:**
- Modify: `src/framework/types.ts`
- Modify: `src/infra/events/sseProjector.ts`
- Modify: `src/server/__tests__/sseProjector.test.ts`

**Interfaces:**
- Consumes: `SessionState.record`、`projectEvent`
- Produces: SSE 帧 `{ type: "model_revision"; model_id: string; revision: number; lifecycle_stage: string; changed_sections: string[]; changed_line_item_ids: string[]; changed_period_ids: string[]; change_kinds: string[] }`

**背景（实现前必读）：** 工具执行结果以 `tool_result` 事件记入 `SessionState`，payload 形如 `{ tool_use_id, task_id, name, summary, generation_context }`，而工具真正的结构化输出在 `generation_context.data` 里（见 `src/framework/subagent.ts:502-507`）。DCF 工具的 `data` 带 `model_id` / `revision` / `lifecycle_stage` / `revision_summary`。子 agent 的 `tool_result` 是 sidechain 事件，但记进的是**同一个** `SessionState`，所以无需额外打通。

- [ ] **Step 1: 写失败的测试**

追加到 `src/server/__tests__/sseProjector.test.ts` 末尾：

```ts
test("a financial model tool result projects one model_revision frame", () => {
  const state = new SessionState("session-model", new Date().toISOString());
  state.beginTurn("Build the AAPL model");
  const event = state.record("financial_modeling", "tool_result", {
    tool_use_id: "tu-1",
    task_id: "task-1",
    name: "apply_financial_model_operations",
    summary: "assumptions set",
    generation_context: {
      data: {
        model_id: "model-1",
        revision: 12,
        lifecycle_stage: "operations_fcff",
        revision_summary: {
          revision: 12,
          changedSections: ["operations", "dcf"],
          warningCount: 0,
          changes: [
            { kind: "assumption_set", lineItemId: "tax_rate", periodIds: ["FY2026", "FY2027"] },
            { kind: "formula_set", lineItemId: "nopat", appliesTo: "forecast", periodIds: ["FY2026"] },
          ],
        },
      },
    },
  }, { isSidechain: true });

  const frames = projectEvent(event, state).filter((frame) => frame.type === "model_revision");
  assert.equal(frames.length, 1);
  const frame = frames[0]!;
  assert.equal(frame.type, "model_revision");
  assert.equal(frame.model_id, "model-1");
  assert.equal(frame.revision, 12);
  assert.equal(frame.lifecycle_stage, "operations_fcff");
  assert.deepEqual(frame.changed_sections, ["operations", "dcf"]);
  assert.deepEqual(frame.changed_line_item_ids.sort(), ["nopat", "tax_rate"]);
  assert.deepEqual(frame.changed_period_ids.sort(), ["FY2026", "FY2027"]);
  assert.deepEqual(frame.change_kinds.sort(), ["assumption_set", "formula_set"]);
});

test("a wacc-only revision still carries its change kinds", () => {
  const state = new SessionState("session-wacc", new Date().toISOString());
  state.beginTurn("Refresh WACC");
  const event = state.record("financial_modeling", "tool_result", {
    tool_use_id: "tu-2",
    task_id: "task-2",
    name: "apply_financial_model_operations",
    summary: "wacc refreshed",
    generation_context: {
      data: {
        model_id: "model-1",
        revision: 13,
        lifecycle_stage: "operations_fcff",
        // changedSections is deliberately empty: ModelReadSection has no WACC
        // member, so the sheet mapping has to come from change kinds.
        revision_summary: {
          revision: 13,
          changedSections: [],
          warningCount: 0,
          changes: [{ kind: "wacc_sheet_refreshed", rowIds: ["beta", "wacc"] }],
        },
      },
    },
  }, { isSidechain: true });

  const frame = projectEvent(event, state).find((f) => f.type === "model_revision");
  assert.ok(frame && frame.type === "model_revision");
  assert.deepEqual(frame.changed_sections, []);
  assert.deepEqual(frame.change_kinds, ["wacc_sheet_refreshed"]);
  assert.deepEqual(frame.changed_line_item_ids, []);
});

test("a tool result without model fields projects no model_revision frame", () => {
  const state = new SessionState("session-plain", new Date().toISOString());
  state.beginTurn("Search filings");
  const event = state.record("financial_modeling", "tool_result", {
    tool_use_id: "tu-3",
    task_id: "task-3",
    name: "financial_search",
    summary: "3 results",
    generation_context: { data: { results: [] } },
  }, { isSidechain: true });

  assert.deepEqual(projectEvent(event, state).filter((frame) => frame.type === "model_revision"), []);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/server/__tests__/sseProjector.test.ts`
Expected: FAIL — 三个新测试报 `frames.length` 为 0（`model_revision` 尚不存在）

- [ ] **Step 3: 加帧类型**

在 `src/framework/types.ts` 的 `SSEEvent` 联合里，`{ type: "artifact"; ... }` 那一支**之后**插入：

```ts
  | { type: "model_revision"; model_id: string; revision: number; lifecycle_stage: string;
      changed_sections: string[]; changed_line_item_ids: string[]; changed_period_ids: string[];
      change_kinds: string[] }
```

`changed_sections` 与 `change_kinds` 用 `string[]` 而非从 `src/financial-model/` import 联合类型：framework 层不该依赖某个具体领域模块，且这些值最终要 JSON 化过网络，运行时本来就是字符串。

- [ ] **Step 4: 写投影**

在 `src/infra/events/sseProjector.ts` 里，`case "tool_result"` 分支改成：

```ts
    case "tool_result": {
      const taskId = (p.task_id as string) ?? "";
      const artifactFrames: SSEEvent[] = ((p.artifacts as ArtifactRef[] | undefined) ?? [])
        .map((artifact) => ({ type: "artifact", task_id: taskId, artifact }));
      return [...artifactFrames, ...modelRevisionFrames(p)];
    }
```

在文件底部（`strategyCreatedFrames` 旁边）加：

```ts
/** A committed model revision, projected out of whatever tool produced it.
 *
 * `changed_sections` alone is not enough to tell the UI which sheet moved:
 * `ModelReadSection` covers the five DCF sections and the three source
 * statements, and has no WACC member at all. A WACC refresh therefore shows up
 * only as a change *kind*, which is why both travel on the frame. */
function modelRevisionFrames(payload: JsonObject): SSEEvent[] {
  const data = asObject(asObject(payload.generation_context)?.data);
  if (!data) return [];
  const modelId = data.model_id;
  const revision = data.revision;
  if (typeof modelId !== "string" || typeof revision !== "number") return [];

  const summary = asObject(data.revision_summary);
  const changes = Array.isArray(summary?.changes) ? summary.changes : [];
  const sections = Array.isArray(summary?.changedSections) ? summary.changedSections : [];

  const lineItemIds = new Set<string>();
  const periodIds = new Set<string>();
  const kinds = new Set<string>();
  for (const raw of changes) {
    const change = asObject(raw);
    if (!change) continue;
    if (typeof change.kind === "string") kinds.add(change.kind);
    // The id-bearing keys across the RevisionChange union as of 02682e2:
    // `lineItemId` (assumption_set / formula_set / fact_replaced /
    // line_item_added / metric_added / line_item_source_set),
    // `parentLineItemId` (category_group_set), `mappedLineItemIds`
    // (statements_staged). Do not add speculative keys for kinds that do not
    // exist — check the union in `src/financial-model/views.ts` first.
    if (typeof change.lineItemId === "string") lineItemIds.add(change.lineItemId);
    if (typeof change.parentLineItemId === "string") lineItemIds.add(change.parentLineItemId);
    if (Array.isArray(change.mappedLineItemIds)) {
      for (const id of change.mappedLineItemIds) if (typeof id === "string") lineItemIds.add(id);
    }
    if (Array.isArray(change.periodIds)) {
      for (const id of change.periodIds) if (typeof id === "string") periodIds.add(id);
    }
  }

  return [{
    type: "model_revision",
    model_id: modelId,
    revision,
    lifecycle_stage: typeof data.lifecycle_stage === "string" ? data.lifecycle_stage : "",
    changed_sections: sections.filter((value): value is string => typeof value === "string"),
    changed_line_item_ids: [...lineItemIds],
    changed_period_ids: [...periodIds],
    change_kinds: [...kinds],
  }];
}
```

`asObject` 已存在于该文件，无需新增。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/server/__tests__/sseProjector.test.ts`
Expected: PASS，含新增 3 个

- [ ] **Step 6: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 4: 前端镜像类型

**Files:**
- Create: `client/src/types/financialModel.ts`

**Interfaces:**
- Produces: `ModelContextView`、`CurrentWorkbookView`、`WorkbookRowView`、`WorkbookCellView`、`Period`、`Unit`、`WaccSheet`、`WaccSheetRow`、`ValuationOutput`、`RevisionSummary`、`ModelView`、`DcfCategoryGroup`、`Diagnostic`、`ModelRevisionFrame`

- [ ] **Step 1: 写类型文件**

创建 `client/src/types/financialModel.ts`：

```ts
// Hand-written mirror of the server's financial-model view types.
//
// The client bundle deliberately imports nothing from `src/` (see the note at
// the top of core.ts), so these shapes are duplicated rather than shared. The
// tripwire against drift is server-side:
// `src/financial-model/__tests__/viewContract.test.ts` asserts every key below
// exists on a real model's JSON.
//
// Only the fields the UI reads are mirrored. Extra server fields are harmless.

export type Unit =
  | { kind: "currency"; code: string }
  | { kind: "percent" }
  | { kind: "ratio" }
  | { kind: "shares" }
  | { kind: "per_share"; code: string }
  | { kind: "number" };

export type PeriodClass = "actual" | "ttm" | "forecast";

export type Period = {
  id: string;
  label: string;
  start: string;
  end: string;
  cls: PeriodClass;
};

export type Diagnostic = {
  code: "missing_input" | "divide_by_zero" | "skipped_ttm" | "not_applicable";
  refs: string[];
};

export type CellSource = "actual" | "assumption" | "formula" | "calculated" | "none";

export type WorkbookCellStatus = "ok" | "missing_input" | "divide_by_zero" | "not_applicable" | "not_modeled";

export type WorkbookCellSource =
  | { kind: "fact"; factId: string }
  | { kind: "assumption"; assumptionId: string }
  | { kind: "formula"; definitionIndex: number }
  | { kind: "calculated"; output: string }
  | { kind: "none" };

export type WorkbookCellView = {
  value: number | null;
  status: WorkbookCellStatus;
  source: WorkbookCellSource;
  diagnostics: Diagnostic[];
};

export type AssumptionPayload =
  | { kind: "values"; values: number[]; unit: Unit }
  | { kind: "not_applicable" };

// NOTE the shape: `periods` (plural) + a `payload` union carrying a values
// ARRAY parallel to it — not one period with one value. Provenance is flat and
// required, not a nested optional object.
export type Assumption = {
  assumptionId: string;
  lineItemId: string;
  periods: string[];
  payload: AssumptionPayload;
  sourceType: string;
  sourceRefs: string[];
  asOfDate: string;
  rationale: string;
};

export type DcfWorkbookSection = "history" | "metrics" | "revenue" | "operations" | "dcf";

export type WorkbookRowView = {
  lineItemId: string;
  label: string;
  parentId?: string;
  section: DcfWorkbookSection;
  role: string;
  unit: Unit;
  order: number;
  sources: { historical: CellSource; forecast: CellSource };
  formulas: Array<{ appliesTo: "historical" | "forecast"; periodIds: string[]; source: string }>;
  assumptions: Assumption[];
  cells: Record<string, WorkbookCellView>;
  description?: string;
};

export type SourceStatementKey = "income_statement" | "balance_sheet" | "cash_flow_statement";

export type SourceStatementRowView = {
  sourceLineItemId: string;
  label: string;
  unit: Unit;
  cells: Record<string, WorkbookCellView>;
};

// A discriminated union on the server. `identity` exists ONLY on the
// accounting_identity arm — category reconciliations (the ones a
// DcfCategoryGroup produces) have no identity at all, so any UI label must
// narrow on `kind` first.
type ReconciliationValues = {
  ruleId: string;
  periodId: string;
  status: "passed" | "failed" | "insufficient_data" | "not_applicable";
  required: boolean;
  actual: number | null;
  calculated: number | null;
  residual: number | null;
  difference: number | null;
  tolerance: number;
  refs: string[];
};

export type ReconciliationResult =
  | (ReconciliationValues & { kind: "category"; parentLineItemId: string; category: string })
  | (ReconciliationValues & { kind: "accounting_identity"; identity: string; parentLineItemId: string });

// NOTE: statement mapping was deleted from the engine in commit 02682e2
// ("remove the statement-mapping legacy"). There is no activeMappings /
// proposedMappings / diagnostics here any more — do not add them back.
export type SourceStatementReviewView = {
  selectedPeriodIds: string[];
  sheets: Record<SourceStatementKey, SourceStatementRowView[]>;
  reconciliations: ReconciliationResult[];
};

export type DcfCategoryGroup = {
  parentLineItemId: string;
  category: string;
  periodIds: string[];
  members: Array<{ lineItemId: string; treatment: "add" | "subtract" | "exclude" }>;
  reviewDecisionId: string;
};

export type WaccSheetRow = {
  rowId: string;
  label: string;
  unit: Unit;
  source: "computed" | "agent" | "locked_formula" | "empty";
  value: number | null;
  formulaSource?: string;
  provenance?: { sourceType: string; sourceRefs: string[]; asOfDate: string; rationale: string };
  missingInputs: string[];
};

export type WaccSheet = { asOfDate: string; rows: WaccSheetRow[] };

export type ExplicitPeriodValue = {
  periodId: string;
  fcff: number;
  wacc: number;
  discountFactor: number;
  presentValue: number;
};

// Field names verified against src/financial-model/valuation.ts: the terminal
// present value is `terminalPresentValue` and the per-share number is
// `impliedValuePerShare`. Do not rename them to something that reads better.
export type TerminalMethodResult = {
  method: "perpetuity_growth" | "exit_multiple";
  explicitPeriods: ExplicitPeriodValue[];
  terminalValue: number;
  terminalPresentValue: number;
  terminalValuePercentOfEnterpriseValue: number;
  enterpriseValue: number;
  equityValue: number;
  dilutedShares: number;
  impliedValuePerShare: number;
};

// The matrix holds CELL OBJECTS, not bare numbers: reading values[i][j] as a
// number is the mistake this comment exists to prevent.
export type SensitivityCell = {
  rowDelta: number;
  columnDelta: number;
  impliedValuePerShare: number | null;
};

export type SensitivityMatrix = {
  rowVariable: "wacc_delta";
  columnVariable: "terminal_growth_delta" | "exit_multiple_delta";
  rowDeltas: number[];
  columnDeltas: number[];
  cells: SensitivityCell[][];
};

export type ValuationOutput = {
  explicitPeriods: ExplicitPeriodValue[];
  perpetuityGrowth: TerminalMethodResult;
  exitMultiple: TerminalMethodResult;
  waccByGrowth: SensitivityMatrix;
  waccByMultiple: SensitivityMatrix;
};

export type LifecycleStage =
  | "draft" | "history_committed" | "revenue_forecast" | "operations_fcff" | "valued" | "archived";

export type RevisionSummary = {
  revision: number;
  parentRevision: number | null;
  lifecycleStage: LifecycleStage;
  createdAt: string;
  changes: Array<{ kind: string } & Record<string, unknown>>;
  changedSections: string[];
  warningCount: number;
  blockerCount: number;
};

export type ModelView = {
  modelId: string;
  ownerAgentId: string;
  originSessionId: string;
  symbol: string;
  metadata: Record<string, unknown>;
  currentRevision: number;
  lifecycleStage: LifecycleStage;
  updatedAt: string;
  createdAt: string;
};

type CurrentWorkbookBase = {
  modelId: string;
  revision: number;
  lifecycleStage: LifecycleStage;
  periods: Period[];
  sections: Record<DcfWorkbookSection, WorkbookRowView[]>;
  categoryGroups: DcfCategoryGroup[];
  reconciliationResults: ReconciliationResult[];
  diagnostics: Diagnostic[];
  valuation: ValuationOutput | null;
  waccSheet: WaccSheet | null;
};

// Keep the server's discriminated union rather than flattening it to an
// optional field: `mode: "dcf"` GUARANTEES there is no source review, and a
// flattened optional lets a component reach for `sourceStatementReview!`
// without narrowing and fail only at runtime.
export type CurrentWorkbookView = CurrentWorkbookBase & (
  | { mode: "statement_mapping"; sourceStatementReview: SourceStatementReviewView }
  | { mode: "dcf"; sourceStatementReview?: never }
);

export type ModelContextView = {
  model: ModelView;
  revisionHistory: RevisionSummary[];
  currentWorkbook: CurrentWorkbookView;
};

/** The SSE frame projected in `src/infra/events/sseProjector.ts`. */
export type ModelRevisionFrame = {
  model_id: string;
  revision: number;
  lifecycle_stage: string;
  changed_sections: string[];
  changed_line_item_ids: string[];
  changed_period_ids: string[];
  change_kinds: string[];
};
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --prefix client exec tsc -b --noEmit`
Expected: 无错误（这个文件目前无人引用，只验证它自身合法）

- [ ] **Step 3: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 5: 纯逻辑之一——格式化与行层级

**Files:**
- Create: `client/src/lib/workbook.ts`
- Create: `client/src/lib/__tests__/workbook.test.ts`

**Interfaces:**
- Consumes: Task 4 的类型
- Produces: `formatCellValue(cell, unit) → string`；`columnScaleLabel(unit) → string`；`buildRowTree(rows) → RowNode[]`，其中 `type RowNode = { row: WorkbookRowView; depth: number }`

- [ ] **Step 1: 写失败的测试**

创建 `client/src/lib/__tests__/workbook.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildRowTree, columnScaleLabel, formatCellValue } from "../workbook.ts";
import type { Unit, WorkbookCellView, WorkbookRowView } from "../../types/financialModel.ts";

const USD: Unit = { kind: "currency", code: "USD" };

const cell = (over: Partial<WorkbookCellView> = {}): WorkbookCellView => ({
  value: 1234567,
  status: "ok",
  source: { kind: "none" },
  diagnostics: [],
  ...over,
});

const row = (lineItemId: string, over: Partial<WorkbookRowView> = {}): WorkbookRowView => ({
  lineItemId,
  label: lineItemId,
  section: "operations",
  role: "none",
  unit: USD,
  order: 0,
  sources: { historical: "actual", forecast: "none" },
  formulas: [],
  assumptions: [],
  cells: {},
  ...over,
});

test("currency cells render with thousands separators and no unit suffix", () => {
  assert.equal(formatCellValue(cell({ value: 1234567 }), USD), "1,234,567");
  assert.equal(formatCellValue(cell({ value: -4200 }), USD), "(4,200)");
});

test("percent and ratio cells use their own precision", () => {
  assert.equal(formatCellValue(cell({ value: 0.38234 }), { kind: "percent" }), "38.2%");
  assert.equal(formatCellValue(cell({ value: 1.2345 }), { kind: "ratio" }), "1.23");
  assert.equal(formatCellValue(cell({ value: 6.1234 }), { kind: "per_share", code: "USD" }), "6.12");
  assert.equal(formatCellValue(cell({ value: 15334000 }), { kind: "shares" }), "15,334,000");
});

test("each non-ok status has its own glyph, and none of them show a number", () => {
  assert.equal(formatCellValue(cell({ status: "missing_input" }), USD), "—");
  assert.equal(formatCellValue(cell({ status: "divide_by_zero" }), USD), "#DIV/0!");
  assert.equal(formatCellValue(cell({ status: "not_applicable" }), USD), "");
  assert.equal(formatCellValue(cell({ status: "not_modeled" }), USD), "·");
});

test("a null value renders as missing even when the status claims ok", () => {
  assert.equal(formatCellValue(cell({ value: null }), USD), "—");
});

test("the column header carries the currency, so cells do not repeat it", () => {
  assert.equal(columnScaleLabel(USD), "USD");
  assert.equal(columnScaleLabel({ kind: "percent" }), "%");
  assert.equal(columnScaleLabel({ kind: "ratio" }), "×");
});

test("row tree nests children under parents and keeps section order", () => {
  const tree = buildRowTree([
    row("revenue.total", { order: 1, parentId: "revenue" }),
    row("revenue", { order: 0 }),
    row("growth.revenue.total", { order: 2, parentId: "revenue.total" }),
  ]);

  assert.deepEqual(tree.map((node) => [node.row.lineItemId, node.depth]), [
    ["revenue", 0],
    ["revenue.total", 1],
    ["growth.revenue.total", 2],
  ]);
});

test("a row whose parent is absent from the section is treated as a root", () => {
  // Sections are read independently, so a child can arrive without its parent.
  // Dropping it would silently hide data; it becomes a root instead.
  const tree = buildRowTree([row("ebitda", { order: 0, parentId: "not.in.this.section" })]);
  assert.deepEqual(tree.map((node) => [node.row.lineItemId, node.depth]), [["ebitda", 0]]);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test client/src/lib/__tests__/workbook.test.ts`
Expected: FAIL — `Cannot find module '../workbook.ts'`

- [ ] **Step 3: 写实现**

创建 `client/src/lib/workbook.ts`：

```ts
import type { Unit, WorkbookCellView, WorkbookRowView } from "../types/financialModel.ts";

/** What a cell shows when it holds no number. Each status gets its own glyph
 *  rather than a shared blank: "the model does not compute this here"
 *  (not_applicable) and "an input never arrived" (missing_input) look identical
 *  when both render empty, and only one of them is a problem. */
const STATUS_GLYPH: Record<Exclude<WorkbookCellView["status"], "ok">, string> = {
  missing_input: "—",
  divide_by_zero: "#DIV/0!",
  not_applicable: "",
  not_modeled: "·",
};

const decimalsFor = (unit: Unit): number => {
  switch (unit.kind) {
    case "percent": return 1;
    case "ratio":
    case "per_share": return 2;
    default: return 0;
  }
};

/** Negative currency renders in accounting parentheses — a leading minus is
 *  easy to miss in a dense grid, and this is the convention the readers of a
 *  DCF already have in their eyes. */
export function formatCellValue(cell: WorkbookCellView, unit: Unit): string {
  if (cell.status !== "ok") return STATUS_GLYPH[cell.status];
  if (cell.value === null) return STATUS_GLYPH.missing_input;

  const scaled = unit.kind === "percent" ? cell.value * 100 : cell.value;
  const decimals = decimalsFor(unit);
  const text = Math.abs(scaled).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const signed = scaled < 0 ? `(${text})` : text;
  return unit.kind === "percent" ? `${signed}%` : signed;
}

/** The unit belongs in the column header, not repeated in every cell. */
export function columnScaleLabel(unit: Unit): string {
  switch (unit.kind) {
    case "currency":
    case "per_share": return unit.code;
    case "percent": return "%";
    case "ratio": return "×";
    case "shares": return "shares";
    case "number": return "";
  }
}

export type RowNode = { row: WorkbookRowView; depth: number };

/** Flattens the parent/child rows into render order with a depth for indent.
 *  A row whose `parentId` is not present in this section becomes a root rather
 *  than disappearing — sections are fetched independently, and silently
 *  dropping data is worse than showing it at the wrong indent. */
export function buildRowTree(rows: readonly WorkbookRowView[]): RowNode[] {
  const present = new Set(rows.map((row) => row.lineItemId));
  const childrenOf = new Map<string, WorkbookRowView[]>();
  const roots: WorkbookRowView[] = [];

  for (const row of [...rows].sort((a, b) => a.order - b.order)) {
    const parentId = row.parentId;
    if (parentId !== undefined && present.has(parentId)) {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(row);
      childrenOf.set(parentId, siblings);
    } else {
      roots.push(row);
    }
  }

  const nodes: RowNode[] = [];
  const walk = (row: WorkbookRowView, depth: number): void => {
    nodes.push({ row, depth });
    for (const child of childrenOf.get(row.lineItemId) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return nodes;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test client/src/lib/__tests__/workbook.test.ts`
Expected: PASS，7 个测试全绿

- [ ] **Step 5: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 6: 纯逻辑之二——sheet 派生与变更命中

**Files:**
- Modify: `client/src/lib/workbook.ts`
- Modify: `client/src/lib/__tests__/workbook.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `workbook.ts`
- Produces: `type SheetId = string`；`type SheetDescriptor = { id: SheetId; label: string; group: "model" | "source" | "derived"; kind: "summary" | "source" | "revenue" | "wacc" | "dcf"; categoryName?: string }`；`deriveSheets(workbook) → SheetDescriptor[]`；`SUMMARY_ROWS: ReadonlyArray<{ lineItemId: string; indent: boolean }>`；`buildSummaryRows(workbook) → WorkbookRowView[]`；`sheetsTouchedBy(frame, sheets, workbook) → SheetId[]`；`isCellChanged(frame, lineItemId, periodId) → boolean`

- [ ] **Step 1: 写失败的测试**

追加到 `client/src/lib/__tests__/workbook.test.ts`。先在文件顶部补 import：

```ts
import {
  buildRowTree, buildSummaryRows, columnScaleLabel, deriveSheets,
  formatCellValue, isCellChanged, sheetsTouchedBy,
} from "../workbook.ts";
import type {
  CurrentWorkbookView, ModelRevisionFrame, Unit, WorkbookCellView, WorkbookRowView,
} from "../../types/financialModel.ts";
```

然后追加：

```ts
const workbook = (over: Partial<CurrentWorkbookView> = {}): CurrentWorkbookView => ({
  modelId: "m1",
  revision: 1,
  lifecycleStage: "operations_fcff",
  periods: [{ id: "FY2024", label: "FY2024", start: "2024-01-01", end: "2024-12-31", cls: "actual" }],
  sections: { history: [], metrics: [], revenue: [], operations: [], dcf: [] },
  categoryGroups: [],
  reconciliationResults: [],
  diagnostics: [],
  valuation: null,
  waccSheet: null,
  mode: "dcf",
  ...over,
});

const frame = (over: Partial<ModelRevisionFrame> = {}): ModelRevisionFrame => ({
  model_id: "m1",
  revision: 2,
  lifecycle_stage: "operations_fcff",
  changed_sections: [],
  changed_line_item_ids: [],
  changed_period_ids: [],
  change_kinds: [],
  ...over,
});

test("sheets appear only when the model actually has their content", () => {
  const bare = deriveSheets(workbook());
  assert.deepEqual(bare.map((sheet) => sheet.id), []);

  const withOperations = deriveSheets(workbook({
    sections: { history: [], metrics: [], revenue: [], operations: [row("ebitda")], dcf: [] },
  }));
  assert.deepEqual(withOperations.map((sheet) => sheet.id), ["dcf"]);
});

test("the sheet strip orders model, source, then derived groups", () => {
  const sheets = deriveSheets(workbook({
    mode: "statement_mapping",
    sections: {
      history: [row("net_income", { section: "history" })],
      metrics: [],
      revenue: [row("revenue.total", { section: "revenue" })],
      operations: [row("ebitda")],
      dcf: [],
    },
    waccSheet: { asOfDate: "2026-01-01", rows: [] },
    sourceStatementReview: {
      selectedPeriodIds: ["FY2024"],
      sheets: {
        income_statement: [{ sourceLineItemId: "s1", label: "Revenue", unit: USD, cells: {} }],
        balance_sheet: [],
        cash_flow_statement: [],
      },
      reconciliations: [],
    },
  }));

  assert.deepEqual(sheets.map((sheet) => sheet.id), [
    "summary", "source:income_statement", "revenue", "wacc", "dcf",
  ]);
  assert.deepEqual(sheets.map((sheet) => sheet.group), [
    "model", "source", "model", "derived", "derived",
  ]);
});

test("each category group becomes its own segment sheet alongside the revenue fallback", () => {
  const sheets = deriveSheets(workbook({
    sections: {
      history: [], metrics: [], operations: [], dcf: [],
      revenue: [row("revenue.products", { section: "revenue" }), row("revenue.total", { section: "revenue" })],
    },
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "Product line",
      periodIds: ["FY2024"],
      members: [{ lineItemId: "revenue.products", treatment: "add" }],
      reviewDecisionId: "d1",
    }],
  }));

  assert.deepEqual(sheets.map((sheet) => sheet.id), ["revenue", "segment:Product line"]);
  assert.equal(sheets[1]?.label, "分部:Product line");
});

test("the summary sheet picks whitelisted rows across four sections in Excel order", () => {
  const rows = buildSummaryRows(workbook({
    sections: {
      history: [row("net_income", { section: "history" }), row("gross_profit", { section: "history" })],
      metrics: [row("metric.net_margin", { section: "metrics" }), row("metric.gross_margin", { section: "metrics" })],
      revenue: [row("revenue.total", { section: "revenue" })],
      operations: [row("ebitda"), row("operating_income")],
      dcf: [],
    },
  }));

  // growth.revenue.total, metric.ebitda_margin and margin.operating are absent
  // from this fixture — a whitelist row that does not exist is skipped, not
  // rendered as an empty row.
  assert.deepEqual(rows.map((r) => r.lineItemId), [
    "revenue.total", "gross_profit", "metric.gross_margin",
    "ebitda", "operating_income", "net_income", "metric.net_margin",
  ]);
});

test("a wacc change is found through change_kinds alone", () => {
  const sheets = deriveSheets(workbook({ waccSheet: { asOfDate: "2026-01-01", rows: [] } }));
  // changed_sections is empty: ModelReadSection has no WACC member at all.
  const touched = sheetsTouchedBy(frame({ change_kinds: ["wacc_sheet_refreshed"] }), sheets, workbook());
  assert.deepEqual(touched, ["wacc"]);
});

test("a revenue change lands on the segment sheet that owns the line item", () => {
  const book = workbook({
    sections: {
      history: [], metrics: [], operations: [], dcf: [],
      revenue: [row("revenue.products", { section: "revenue" })],
    },
    categoryGroups: [{
      parentLineItemId: "revenue.total",
      category: "Product line",
      periodIds: ["FY2024"],
      members: [{ lineItemId: "revenue.products", treatment: "add" }],
      reviewDecisionId: "d1",
    }],
  });
  const sheets = deriveSheets(book);

  const touched = sheetsTouchedBy(
    frame({ changed_sections: ["revenue"], changed_line_item_ids: ["revenue.products"] }),
    sheets,
    book,
  );
  assert.deepEqual(touched, ["segment:Product line"]);
});

test("a section-level change with no matching line item still marks the sheet", () => {
  // `line_item_added` outside the summary whitelist would otherwise be silent.
  const book = workbook({
    sections: { history: [], metrics: [], revenue: [], operations: [row("ebitda")], dcf: [] },
  });
  const touched = sheetsTouchedBy(
    frame({ changed_sections: ["operations"], change_kinds: ["line_item_added"] }),
    deriveSheets(book),
    book,
  );
  assert.deepEqual(touched, ["dcf"]);
});

test("one change may mark two sheets and they are not collapsed into one", () => {
  // `ebitda` is both a summary whitelist row and part of the DCF operations block.
  const book = workbook({
    sections: {
      history: [row("gross_profit", { section: "history" })],
      metrics: [], revenue: [], dcf: [],
      operations: [row("ebitda")],
    },
  });
  const touched = sheetsTouchedBy(
    frame({ changed_sections: ["operations"], changed_line_item_ids: ["ebitda"] }),
    deriveSheets(book),
    book,
  );
  assert.deepEqual(touched, ["summary", "dcf"]);
});

test("changed cells are the cross product of the changed ids", () => {
  const f = frame({ changed_line_item_ids: ["tax_rate"], changed_period_ids: ["FY2026", "FY2027"] });
  assert.equal(isCellChanged(f, "tax_rate", "FY2026"), true);
  assert.equal(isCellChanged(f, "tax_rate", "FY2025"), false);
  assert.equal(isCellChanged(f, "nopat", "FY2026"), false);
});

test("a row-wide change with no period ids marks the whole row", () => {
  const f = frame({ changed_line_item_ids: ["tax_rate"], changed_period_ids: [] });
  assert.equal(isCellChanged(f, "tax_rate", "FY2026"), true);
  assert.equal(isCellChanged(f, "nopat", "FY2026"), false);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test client/src/lib/__tests__/workbook.test.ts`
Expected: FAIL — `deriveSheets is not a function` 等

- [ ] **Step 3: 写实现**

追加到 `client/src/lib/workbook.ts`（顶部 import 补上 `CurrentWorkbookView`、`ModelRevisionFrame`、`SourceStatementKey`）：

```ts
export type SheetGroup = "model" | "source" | "derived";
export type SheetKind = "summary" | "source" | "revenue" | "wacc" | "dcf";
export type SheetId = string;

export type SheetDescriptor = {
  id: SheetId;
  label: string;
  group: SheetGroup;
  kind: SheetKind;
  /** Present on `kind: "source"` — which of the three statements. */
  statement?: SourceStatementKey;
  /** Present on a segment sheet — which category group it renders. */
  categoryName?: string;
};

const SOURCE_LABELS: Record<SourceStatementKey, string> = {
  income_statement: "利润表",
  balance_sheet: "资产负债表",
  cash_flow_statement: "现金流量表",
};

/** The Key Financials block, in the order the reference workbook uses.
 *  These ids span four different sections — they are NOT co-located, so the
 *  pick has to be by line item id. `src/financial-model/__tests__/viewContract.test.ts`
 *  asserts every id here still exists in the skeleton. */
export const SUMMARY_ROWS: ReadonlyArray<{ lineItemId: string; indent: boolean }> = [
  { lineItemId: "revenue.total", indent: false },
  { lineItemId: "growth.revenue.total", indent: true },
  { lineItemId: "gross_profit", indent: false },
  { lineItemId: "metric.gross_margin", indent: true },
  { lineItemId: "ebitda", indent: false },
  { lineItemId: "metric.ebitda_margin", indent: true },
  { lineItemId: "operating_income", indent: false },
  { lineItemId: "margin.operating", indent: true },
  { lineItemId: "net_income", indent: false },
  { lineItemId: "metric.net_margin", indent: true },
];

const allRows = (workbook: CurrentWorkbookView): WorkbookRowView[] => [
  ...workbook.sections.history, ...workbook.sections.metrics,
  ...workbook.sections.revenue, ...workbook.sections.operations, ...workbook.sections.dcf,
];

/** A whitelist row that the model has not built yet is skipped, not rendered
 *  as a blank — an empty row claims "this is zero", which is a different
 *  statement from "the model has not got here". */
export function buildSummaryRows(workbook: CurrentWorkbookView): WorkbookRowView[] {
  const byId = new Map(allRows(workbook).map((row) => [row.lineItemId, row]));
  return SUMMARY_ROWS
    .map((entry) => byId.get(entry.lineItemId))
    .filter((row): row is WorkbookRowView => row !== undefined);
}

/** Which line items belong to a segment sheet, by category name. */
function segmentMembers(workbook: CurrentWorkbookView): Map<string, Set<string>> {
  const byCategory = new Map<string, Set<string>>();
  for (const group of workbook.categoryGroups) {
    const members = byCategory.get(group.category) ?? new Set<string>();
    for (const member of group.members) members.add(member.lineItemId);
    byCategory.set(group.category, members);
  }
  return byCategory;
}

/** The strip is generated from what the model actually holds, so it doubles as
 *  a progress indicator: a draft model shows only its source statements. */
export function deriveSheets(workbook: CurrentWorkbookView): SheetDescriptor[] {
  const sheets: SheetDescriptor[] = [];

  if (buildSummaryRows(workbook).length > 0) {
    sheets.push({ id: "summary", label: "摘要", group: "model", kind: "summary" });
  }

  const review = workbook.sourceStatementReview;
  if (review) {
    for (const statement of ["income_statement", "balance_sheet", "cash_flow_statement"] as const) {
      if (review.sheets[statement].length > 0) {
        sheets.push({
          id: `source:${statement}`, label: SOURCE_LABELS[statement],
          group: "source", kind: "source", statement,
        });
      }
    }
  }

  if (workbook.sections.revenue.length > 0) {
    sheets.push({ id: "revenue", label: "收入", group: "model", kind: "revenue" });
  }
  for (const category of segmentMembers(workbook).keys()) {
    sheets.push({
      id: `segment:${category}`, label: `分部:${category}`,
      group: "model", kind: "revenue", categoryName: category,
    });
  }

  if (workbook.waccSheet) {
    sheets.push({ id: "wacc", label: "WACC", group: "derived", kind: "wacc" });
  }
  if (workbook.sections.operations.length > 0 || workbook.sections.dcf.length > 0 || workbook.valuation) {
    sheets.push({ id: "dcf", label: "DCF", group: "derived", kind: "dcf" });
  }

  return sheets;
}

const WACC_KINDS = new Set(["wacc_sheet_refreshed", "wacc_input_set"]);
const DCF_KINDS = new Set(["valuation_config_set"]);

/** The server's `ModelReadSection` names, which are NOT a mechanical transform
 *  of the sheet keys: the third one is `source_cash_flow`, with no `_statement`
 *  suffix. Deriving these by string surgery silently kills that sheet's dot. */
const SOURCE_SECTION: Record<SourceStatementKey, string> = {
  income_statement: "source_income_statement",
  balance_sheet: "source_balance_sheet",
  cash_flow_statement: "source_cash_flow",
};

/**
 * Which sheets a revision touched.
 *
 * Three inputs, none of them optional:
 *   - `change_kinds` — the ONLY signal for WACC. `ModelReadSection` has no
 *     WACC member, so `changed_sections` can never report one.
 *   - `changed_line_item_ids` — resolves a `revenue` change to the specific
 *     segment sheet that owns the line item.
 *   - `changed_sections` — catches changes whose line items are not on any
 *     sheet's pick list, e.g. `line_item_added` outside the summary whitelist.
 *
 * A single change may legitimately touch two sheets (`ebitda` is both a summary
 * row and part of the DCF operations block). The result keeps both, in strip
 * order; the caller dot-marks all of them and auto-navigates to the first.
 */
export function sheetsTouchedBy(
  frame: ModelRevisionFrame,
  sheets: readonly SheetDescriptor[],
  workbook: CurrentWorkbookView,
): SheetId[] {
  const touched = new Set<SheetId>();
  const sections = new Set(frame.changed_sections);
  const kinds = new Set(frame.change_kinds);
  const changedIds = new Set(frame.changed_line_item_ids);
  const members = segmentMembers(workbook);
  const summaryIds = new Set(SUMMARY_ROWS.map((entry) => entry.lineItemId));

  for (const sheet of sheets) {
    switch (sheet.kind) {
      case "wacc":
        if ([...kinds].some((kind) => WACC_KINDS.has(kind))) touched.add(sheet.id);
        break;
      case "dcf":
        if (sections.has("operations") || sections.has("dcf")) touched.add(sheet.id);
        if ([...kinds].some((kind) => DCF_KINDS.has(kind))) touched.add(sheet.id);
        break;
      case "summary":
        if (sections.has("history") || sections.has("metrics")) touched.add(sheet.id);
        if ([...changedIds].some((id) => summaryIds.has(id))) touched.add(sheet.id);
        break;
      case "source":
        if (sheet.statement && sections.has(SOURCE_SECTION[sheet.statement])) touched.add(sheet.id);
        break;
      case "revenue": {
        if (!sections.has("revenue")) break;
        const owned = sheet.categoryName ? members.get(sheet.categoryName) ?? new Set<string>() : undefined;
        if (owned) {
          if ([...changedIds].some((id) => owned.has(id))) touched.add(sheet.id);
          break;
        }
        // The fallback revenue sheet takes anything no segment sheet claimed,
        // including a section-level change that named no line items at all.
        const claimed = new Set([...members.values()].flatMap((set) => [...set]));
        if (changedIds.size === 0 || [...changedIds].some((id) => !claimed.has(id))) touched.add(sheet.id);
        break;
      }
    }
  }

  return sheets.map((sheet) => sheet.id).filter((id) => touched.has(id));
}

/** A change that names line items but no periods changed the whole row
 *  (a formula or source swap), so every period in it lights up. */
export function isCellChanged(frame: ModelRevisionFrame, lineItemId: string, periodId: string): boolean {
  if (!frame.changed_line_item_ids.includes(lineItemId)) return false;
  return frame.changed_period_ids.length === 0 || frame.changed_period_ids.includes(periodId);
}
```

- [ ] **Step 4: 为 source section 名补一个测试**

`SOURCE_SECTION` 那张映射表是这个任务里最容易写错的一处 —— 三个名字看着像是能用字符串变换推出来的，实际上第三个是 `source_cash_flow` 而非 `source_cash_flow_statement`。锁死它：

```ts
test("source sheet ids map onto the server's own section names", () => {
  // The server calls the third one `source_cash_flow`, not
  // `source_cash_flow_statement`. Getting this wrong silently kills the dot.
  const book = workbook({
    mode: "statement_mapping",
    sourceStatementReview: {
      selectedPeriodIds: ["FY2024"],
      sheets: {
        income_statement: [{ sourceLineItemId: "s1", label: "Revenue", unit: USD, cells: {} }],
        balance_sheet: [{ sourceLineItemId: "s2", label: "Cash", unit: USD, cells: {} }],
        cash_flow_statement: [{ sourceLineItemId: "s3", label: "OCF", unit: USD, cells: {} }],
      },
      reconciliations: [],
    },
  });
  const sheets = deriveSheets(book);

  assert.deepEqual(sheetsTouchedBy(frame({ changed_sections: ["source_cash_flow"] }), sheets, book),
    ["source:cash_flow_statement"]);
  assert.deepEqual(sheetsTouchedBy(frame({ changed_sections: ["source_balance_sheet"] }), sheets, book),
    ["source:balance_sheet"]);
});
```

- [ ] **Step 5: 跑测试确认全部通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test client/src/lib/__tests__/workbook.test.ts`
Expected: PASS

- [ ] **Step 6: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 7: 表格基础组件

**Files:**
- Create: `client/src/components/model/WorkbookCell.tsx`
- Create: `client/src/components/model/CellInspector.tsx`
- Create: `client/src/components/model/WorkbookGrid.tsx`

**Interfaces:**
- Consumes: Task 4 类型、Task 5 的 `formatCellValue` / `buildRowTree` / `columnScaleLabel`
- Produces: `<WorkbookGrid rows periods changedCells onInspect />`，其中 `rows: WorkbookRowView[]`、`periods: Period[]`、`changedCells: (lineItemId: string, periodId: string) => boolean`；`<CellInspector row cell periodId onClose />`

**实现前必读 —— 视觉规范（spec §6.5，不得偏离）：**
- 行标签列 `sticky left-0`，期间表头 `sticky top-0`；层级用 `padding-left: depth * 12px` + 字重，不画连线。
- `cls === "forecast"` 的第一列前一条 `border-l-2`，且整个 forecast 列组表头淡色底；`cls === "ttm"` 列头额外标 `TTM`。
- 来源用**字色**：**逐格**判断 `cell.source.kind === "assumption"` → `text-blue-600 dark:text-blue-400`；其余默认色。不叠背景色。不要改用行级的 `sources.forecast` —— 那会把该行的历史列也一并染蓝，而历史列是事实不是假设。
- 数字右对齐、等宽数字（`tabular-nums`）；行标签左对齐。
- `diagnostics.length > 0` 的格子右上角 2px 圆点。
- 变更高亮：命中 `changedCells` 时加 `bg-amber-200/60 dark:bg-amber-400/25`，配一条 2s 淡出的 CSS 动画。

- [ ] **Step 1: 写 WorkbookCell**

创建 `client/src/components/model/WorkbookCell.tsx`：

```tsx
import { cn } from "@/lib/utils";
import { formatCellValue } from "@/lib/workbook";
import type { Unit, WorkbookCellView } from "@/types/financialModel";

/** One cell. Source is encoded in the *text colour*, not a background wash:
 *  blue means a human-entered assumption, which is the convention every reader
 *  of a banker's model already has in their eyes. Stacking backgrounds for
 *  source on top of the highlight wash would make the two unreadable together. */
export function WorkbookCell({
    cell,
    unit,
    changed,
    onInspect,
}: {
    cell: WorkbookCellView;
    unit: Unit;
    changed: boolean;
    onInspect: () => void;
}) {
    const isAssumption = cell.source.kind === "assumption";
    const hasDiagnostics = cell.diagnostics.length > 0;

    return (
        <td
            className={cn(
                "relative whitespace-nowrap px-3 py-1 text-right tabular-nums",
                "cursor-pointer hover:bg-muted/50",
                isAssumption && "text-blue-600 dark:text-blue-400",
                cell.status === "not_modeled" && "text-muted-foreground/40",
                cell.status === "missing_input" && "text-muted-foreground",
                cell.status === "divide_by_zero" && "text-destructive",
                changed && "animate-workbook-flash",
            )}
            onClick={onInspect}
        >
            {formatCellValue(cell, unit)}
            {hasDiagnostics && (
                <span className="absolute right-0.5 top-0.5 h-[2px] w-[2px] rounded-full bg-amber-500" />
            )}
        </td>
    );
}
```

在 `client/src/index.css` 末尾加动画（Tailwind 3 的 `@layer utilities`）：

```css
@layer utilities {
    @keyframes workbook-flash {
        from { background-color: rgb(253 230 138 / 0.6); }
        to { background-color: transparent; }
    }
    .animate-workbook-flash {
        animation: workbook-flash 2s ease-out;
    }
}
```

- [ ] **Step 2: 写 CellInspector**

创建 `client/src/components/model/CellInspector.tsx`：

```tsx
import { X } from "lucide-react";
import { formatCellValue } from "@/lib/workbook";
import type { WorkbookCellView, WorkbookRowView } from "@/types/financialModel";

/** Where a number came from. This is the whole reason a read-only grid is
 *  useful rather than decorative: a DCF cell is only trustworthy if you can
 *  get back to the filing fact or the formula behind it. */
export function CellInspector({
    row,
    periodId,
    onClose,
}: {
    row: WorkbookRowView;
    periodId: string;
    onClose: () => void;
}) {
    const cell: WorkbookCellView | undefined = row.cells[periodId];
    if (!cell) return null;

    const assumption = cell.source.kind === "assumption"
        ? row.assumptions.find((item) => item.assumptionId === cell.source.assumptionId)
        : undefined;
    const formula = cell.source.kind === "formula" ? row.formulas[cell.source.definitionIndex] : undefined;

    return (
        <div className="absolute z-20 w-80 rounded-md border bg-popover p-3 text-xs shadow-lg">
            <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                    <div className="font-medium">{row.label}</div>
                    <div className="text-muted-foreground">{periodId}</div>
                </div>
                <button type="button" onClick={onClose} aria-label="Close">
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
            </div>

            <dl className="space-y-1.5">
                <Field label="值" value={formatCellValue(cell, row.unit)} />
                <Field label="状态" value={cell.status} />
                <Field label="来源" value={cell.source.kind} />
                {cell.source.kind === "fact" && <Field label="Fact" value={cell.source.factId} />}
                {formula && <Field label="公式" value={formula.source} mono />}
                {assumption && (
                    <>
                        {/* Provenance is flat on Assumption, not a nested object —
                            and the values are an array parallel to `periods`,
                            so the cell's own number has to be looked up by index. */}
                        <Field label="依据" value={assumption.rationale} />
                        <Field label="截至" value={assumption.asOfDate} />
                        <Field label="引用" value={assumption.sourceRefs.join(", ")} />
                    </>
                )}
                {cell.diagnostics.map((diagnostic, index) => (
                    <Field key={index} label="诊断" value={`${diagnostic.code}: ${diagnostic.refs.join(", ")}`} />
                ))}
            </dl>
        </div>
    );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="flex gap-2">
            <dt className="w-12 shrink-0 text-muted-foreground">{label}</dt>
            <dd className={mono ? "break-all font-mono" : "break-words"}>{value}</dd>
        </div>
    );
}
```

- [ ] **Step 3: 写 WorkbookGrid**

创建 `client/src/components/model/WorkbookGrid.tsx`：

```tsx
import { useState } from "react";
import { cn } from "@/lib/utils";
import { buildRowTree, columnScaleLabel } from "@/lib/workbook";
import type { Period, WorkbookRowView } from "@/types/financialModel";
import { CellInspector } from "./CellInspector";
import { WorkbookCell } from "./WorkbookCell";

/** The one grid every sheet renders through. Row labels stick to the left and
 *  the period header sticks to the top, because a DCF is read by scanning a
 *  row across years — losing either axis makes the number meaningless.
 *
 *  No virtualisation and no table library: a workbook is tens to a few hundred
 *  rows by a dozen columns. */
export function WorkbookGrid({
    rows,
    periods,
    isCellChanged,
    scrollToLineItemId,
}: {
    rows: WorkbookRowView[];
    periods: Period[];
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
    /** When set, the row is scrolled into view — used by auto-locate. */
    scrollToLineItemId?: string;
}) {
    const [inspecting, setInspecting] = useState<{ lineItemId: string; periodId: string } | null>(null);
    const nodes = buildRowTree(rows);
    const firstForecastId = periods.find((period) => period.cls === "forecast")?.id;
    const inspectedRow = inspecting && rows.find((row) => row.lineItemId === inspecting.lineItemId);

    if (nodes.length === 0) {
        return <div className="p-6 text-sm text-muted-foreground">这张表还没有内容。</div>;
    }

    return (
        <div className="relative h-full overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-xs">
                <thead>
                    <tr>
                        <th className="sticky left-0 top-0 z-20 min-w-[260px] border-b bg-background px-3 py-2 text-left font-medium">
                            科目
                        </th>
                        {periods.map((period) => (
                            <th
                                key={period.id}
                                className={cn(
                                    "sticky top-0 z-10 border-b bg-background px-3 py-2 text-right font-medium",
                                    period.cls === "forecast" && "bg-muted/40",
                                    period.id === firstForecastId && "border-l-2",
                                )}
                            >
                                {period.label}
                                {period.cls === "ttm" && <span className="ml-1 text-muted-foreground">TTM</span>}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {nodes.map(({ row, depth }) => (
                        <tr
                            key={row.lineItemId}
                            ref={row.lineItemId === scrollToLineItemId
                                ? (element) => element?.scrollIntoView({ block: "center", behavior: "smooth" })
                                : undefined}
                            className="hover:bg-muted/30"
                        >
                            <th
                                scope="row"
                                className={cn(
                                    "sticky left-0 z-10 border-b bg-background px-3 py-1 text-left font-normal",
                                    depth === 0 && "font-medium",
                                )}
                                style={{ paddingLeft: 12 + depth * 12 }}
                            >
                                {row.label}
                                <span className="ml-2 text-[10px] text-muted-foreground">
                                    {columnScaleLabel(row.unit)}
                                </span>
                            </th>
                            {periods.map((period) => {
                                const cell = row.cells[period.id];
                                if (!cell) return <td key={period.id} className="border-b px-3 py-1" />;
                                return (
                                    <WorkbookCell
                                        key={period.id}
                                        cell={cell}
                                        unit={row.unit}
                                        changed={isCellChanged(row.lineItemId, period.id)}
                                        onInspect={() => setInspecting({ lineItemId: row.lineItemId, periodId: period.id })}
                                    />
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>

            {inspecting && inspectedRow && (
                <CellInspector
                    row={inspectedRow}
                    periodId={inspecting.periodId}
                    onClose={() => setInspecting(null)}
                />
            )}
        </div>
    );
}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm --prefix client exec tsc -b --noEmit`
Expected: 无错误

- [ ] **Step 5: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 8: 各张 sheet 组件

**Files:**
- Create: `client/src/components/model/SummarySheet.tsx`
- Create: `client/src/components/model/SourceStatementSheet.tsx`
- Create: `client/src/components/model/RevenueSheet.tsx`
- Create: `client/src/components/model/WaccSheetView.tsx`
- Create: `client/src/components/model/DcfSheet.tsx`

**Interfaces:**
- Consumes: Task 7 的 `WorkbookGrid`、Task 6 的 `buildSummaryRows` / `SheetDescriptor`
- Produces: 五个组件，签名统一为 `({ workbook, sheet, isCellChanged }: { workbook: CurrentWorkbookView; sheet: SheetDescriptor; isCellChanged: (lineItemId: string, periodId: string) => boolean })`

- [ ] **Step 1: SummarySheet**

创建 `client/src/components/model/SummarySheet.tsx`：

```tsx
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildSummaryRows } from "@/lib/workbook";
import type { CurrentWorkbookView } from "@/types/financialModel";
import { WorkbookGrid } from "./WorkbookGrid";

/** Key Financials up top, then the full history and metrics sections behind
 *  disclosures. Those two sections belong to no other sheet — the summary is
 *  their only home, so the fold is an entrance, not a trim. */
export function SummarySheet({
    workbook,
    isCellChanged,
}: {
    workbook: CurrentWorkbookView;
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
}) {
    return (
        <div className="flex h-full flex-col overflow-auto">
            <Section title="Key Financials" defaultOpen>
                <WorkbookGrid
                    rows={buildSummaryRows(workbook)}
                    periods={workbook.periods}
                    isCellChanged={isCellChanged}
                />
            </Section>
            <Section title="历史报表科目">
                <WorkbookGrid rows={workbook.sections.history} periods={workbook.periods} isCellChanged={isCellChanged} />
            </Section>
            <Section title="全部指标">
                <WorkbookGrid rows={workbook.sections.metrics} periods={workbook.periods} isCellChanged={isCellChanged} />
            </Section>
        </div>
    );
}

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="border-b">
            <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium hover:bg-muted/40"
                onClick={() => setOpen((value) => !value)}
            >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
                {title}
            </button>
            {open && children}
        </div>
    );
}
```

- [ ] **Step 2: SourceStatementSheet**

创建 `client/src/components/model/SourceStatementSheet.tsx`。原始报表的行是 `SourceStatementRowView`（只有 `sourceLineItemId` / `label` / `unit` / `cells`），要先适配成 `WorkbookRowView` 才能喂给 `WorkbookGrid`。

**注意**：spec 原本要在行尾挂「映射到模型哪一行」的引用芯片，但 statement-mapping 那套 API 已在 `02682e2` 里从引擎删除（`activeMappings` / `mappingRefs` 都不存在了）。这张表现在只有原始行 + 勾稽警示带。不要试图重建映射关系。

```tsx
import { AlertTriangle } from "lucide-react";
import type { CurrentWorkbookView, SourceStatementRowView, WorkbookRowView } from "@/types/financialModel";
import type { SheetDescriptor } from "@/lib/workbook";
import { WorkbookGrid } from "./WorkbookGrid";

/** Source rows carry no hierarchy, role, or formulas — they are the filing as
 *  filed. Adapting them to the workbook row shape keeps one grid for the whole
 *  app rather than a near-copy that drifts. */
function asWorkbookRow(row: SourceStatementRowView, order: number): WorkbookRowView {
    return {
        lineItemId: row.sourceLineItemId,
        label: row.label,
        section: "history",
        role: "none",
        unit: row.unit,
        order,
        sources: { historical: "actual", forecast: "none" },
        formulas: [],
        assumptions: [],
        cells: row.cells,
    };
}

export function SourceStatementSheet({
    workbook,
    sheet,
    isCellChanged,
}: {
    workbook: CurrentWorkbookView;
    sheet: SheetDescriptor;
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
}) {
    const review = workbook.sourceStatementReview;
    if (!review || !sheet.statement) return null;

    const rows = review.sheets[sheet.statement].map((row, index) => asWorkbookRow(row, index));
    const failed = review.reconciliations.filter((result) => result.status === "failed");

    return (
        <div className="flex h-full flex-col">
            {failed.length > 0 && (
                <div className="flex items-center gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>
                        {failed.length} 项勾稽未通过：
                        {failed.slice(0, 3).map((result) =>
                            // `identity` exists only on the accounting_identity arm;
                            // a category reconciliation is labelled by its category.
                            `${result.kind === "accounting_identity" ? result.identity : result.category}@${result.periodId}`,
                        ).join("、")}
                        {failed.length > 3 && " …"}
                    </span>
                </div>
            )}
            <div className="min-h-0 flex-1">
                <WorkbookGrid
                    rows={rows}
                    periods={workbook.periods.filter((period) => review.selectedPeriodIds.includes(period.id))}
                    isCellChanged={isCellChanged}
                />
            </div>
        </div>
    );
}
```

- [ ] **Step 3: RevenueSheet**

创建 `client/src/components/model/RevenueSheet.tsx`：

```tsx
import type { CurrentWorkbookView } from "@/types/financialModel";
import type { SheetDescriptor } from "@/lib/workbook";
import { WorkbookGrid } from "./WorkbookGrid";

/** Either one category group's members, or — with no group, or for rows no
 *  group claimed — the whole revenue section. The revenue section must always
 *  have a home: the summary only whitelists the total and its growth. */
export function RevenueSheet({
    workbook,
    sheet,
    isCellChanged,
}: {
    workbook: CurrentWorkbookView;
    sheet: SheetDescriptor;
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
}) {
    const group = sheet.categoryName
        ? workbook.categoryGroups.find((candidate) => candidate.category === sheet.categoryName)
        : undefined;

    const treatmentOf = new Map(group?.members.map((member) => [member.lineItemId, member.treatment]) ?? []);
    const rows = group
        ? workbook.sections.revenue
            .filter((row) => treatmentOf.has(row.lineItemId))
            // Treatment has to be visible: a member marked `exclude` is why the
            // parts stop adding up to the total, and that is not guessable.
            .map((row) => ({ ...row, label: `${row.label} [${treatmentOf.get(row.lineItemId)}]` }))
        : workbook.sections.revenue;

    return (
        <div className="h-full">
            <WorkbookGrid rows={rows} periods={workbook.periods} isCellChanged={isCellChanged} />
        </div>
    );
}
```

- [ ] **Step 4: WaccSheetView**

创建 `client/src/components/model/WaccSheetView.tsx`。WACC 表是**单列**的（每行一个值，没有期间维度），所以不走 `WorkbookGrid`：

```tsx
import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatCellValue } from "@/lib/workbook";
import type { CurrentWorkbookView, WaccSheetRow } from "@/types/financialModel";

/** WACC is a single-column derivation, not a period grid, so it does not go
 *  through WorkbookGrid. beta lives here as one row rather than its own sheet:
 *  the provenance (window, market proxy, observation count) is what tells you
 *  whether to trust it, and that fits in a disclosure. */
export function WaccSheetView({ workbook }: { workbook: CurrentWorkbookView }) {
    const [expanded, setExpanded] = useState<string | null>(null);
    const sheet = workbook.waccSheet;
    if (!sheet) return null;

    return (
        <div className="h-full overflow-auto">
            <div className="border-b px-3 py-2 text-xs text-muted-foreground">截至 {sheet.asOfDate}</div>
            <table className="w-full text-xs">
                <tbody>
                    {sheet.rows.map((row) => (
                        <WaccRow
                            key={row.rowId}
                            row={row}
                            expanded={expanded === row.rowId}
                            onToggle={() => setExpanded(expanded === row.rowId ? null : row.rowId)}
                        />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function WaccRow({ row, expanded, onToggle }: { row: WaccSheetRow; expanded: boolean; onToggle: () => void }) {
    const blocked = row.missingInputs.length > 0;
    return (
        <>
            <tr className="cursor-pointer border-b hover:bg-muted/30" onClick={onToggle}>
                <th scope="row" className={cn("px-3 py-1.5 text-left font-normal", row.rowId === "wacc" && "font-medium")}>
                    {row.label}
                </th>
                <td className={cn(
                    "px-3 py-1.5 text-right tabular-nums",
                    row.source === "agent" && "text-blue-600 dark:text-blue-400",
                    blocked && "text-muted-foreground",
                )}>
                    {formatCellValue(
                        { value: row.value, status: blocked ? "missing_input" : "ok", source: { kind: "none" }, diagnostics: [] },
                        row.unit,
                    )}
                </td>
                <td className="w-24 px-3 py-1.5 text-right text-[10px] text-muted-foreground">{row.source}</td>
            </tr>
            {expanded && (
                <tr className="border-b bg-muted/20">
                    <td colSpan={3} className="space-y-1 px-3 py-2 text-[11px]">
                        {row.formulaSource && <div className="font-mono break-all">{row.formulaSource}</div>}
                        {row.provenance && (
                            <>
                                <div>{row.provenance.rationale}</div>
                                <div className="text-muted-foreground">
                                    {row.provenance.sourceType} · {row.provenance.asOfDate} · {row.provenance.sourceRefs.join(", ")}
                                </div>
                            </>
                        )}
                        {blocked && <div className="text-amber-600">缺少输入：{row.missingInputs.join("、")}</div>}
                    </td>
                </tr>
            )}
        </>
    );
}
```

- [ ] **Step 5: DcfSheet**

创建 `client/src/components/model/DcfSheet.tsx`：

```tsx
import { formatCellValue } from "@/lib/workbook";
import type { CurrentWorkbookView, SensitivityMatrix, TerminalMethodResult } from "@/types/financialModel";
import { WorkbookGrid } from "./WorkbookGrid";

const USD_LIKE = { kind: "number" } as const;

/** Operations and DCF stack on one sheet with the valuation block below —
 *  this is the reference workbook's own DCF tab: the EBIT→NOPAT→FCFF build is
 *  the top half, the discounting is the bottom. */
export function DcfSheet({
    workbook,
    isCellChanged,
}: {
    workbook: CurrentWorkbookView;
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
}) {
    return (
        <div className="flex h-full flex-col overflow-auto">
            <WorkbookGrid
                rows={[...workbook.sections.operations, ...workbook.sections.dcf]}
                periods={workbook.periods}
                isCellChanged={isCellChanged}
            />
            {workbook.valuation && (
                <div className="border-t p-3">
                    <div className="mb-2 text-xs font-medium">估值结论</div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <TerminalCard title="永续增长法" result={workbook.valuation.perpetuityGrowth} />
                        <TerminalCard title="退出倍数法" result={workbook.valuation.exitMultiple} />
                    </div>
                    <Sensitivity title="WACC × 永续增长" matrix={workbook.valuation.waccByGrowth} />
                    <Sensitivity title="WACC × 退出倍数" matrix={workbook.valuation.waccByMultiple} />
                </div>
            )}
        </div>
    );
}

function TerminalCard({ title, result }: { title: string; result: TerminalMethodResult }) {
    const line = (label: string, value: number) => (
        <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{label}</span>
            <span className="tabular-nums">
                {formatCellValue({ value, status: "ok", source: { kind: "none" }, diagnostics: [] }, USD_LIKE)}
            </span>
        </div>
    );
    return (
        <div className="rounded-md border p-3 text-xs">
            <div className="mb-2 font-medium">{title}</div>
            <div className="space-y-1">
                {line("终值", result.terminalValue)}
                {line("终值现值", result.terminalPresentValue)}
                {line("企业价值", result.enterpriseValue)}
                {line("股权价值", result.equityValue)}
                {line("每股价值", result.impliedValuePerShare)}
            </div>
        </div>
    );
}

function Sensitivity({ title, matrix }: { title: string; matrix: SensitivityMatrix }) {
    return (
        <div className="mt-4">
            <div className="mb-1 text-xs font-medium">{title}</div>
            <table className="text-xs">
                <thead>
                    <tr>
                        <th className="px-2 py-1 text-left font-normal text-muted-foreground">
                            {matrix.rowVariable} \ {matrix.columnVariable}
                        </th>
                        {matrix.columnDeltas.map((column) => (
                            <th key={column} className="px-2 py-1 text-right font-normal tabular-nums">
                                {column.toFixed(2)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {matrix.rowDeltas.map((rowValue, rowIndex) => (
                        <tr key={rowValue}>
                            <th scope="row" className="px-2 py-1 text-left font-normal tabular-nums">{rowValue.toFixed(4)}</th>
                            {matrix.columnDeltas.map((_, columnIndex) => {
                                // `cells` holds SensitivityCell OBJECTS, not bare numbers.
                                const value = matrix.cells[rowIndex]?.[columnIndex]?.impliedValuePerShare ?? null;
                                return (
                                    <td key={columnIndex} className="px-2 py-1 text-right tabular-nums">
                                        {formatCellValue(
                                            { value, status: value === null ? "missing_input" : "ok", source: { kind: "none" }, diagnostics: [] },
                                            USD_LIKE,
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
```

- [ ] **Step 6: 类型检查**

Run: `pnpm --prefix client exec tsc -b --noEmit`
Expected: 无错误。若报 `SensitivityMatrix` 的字段名对不上，以 `src/financial-model/valuation.ts` 里的真实定义为准，同步改 `client/src/types/financialModel.ts`。

- [ ] **Step 7: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 9: 数据 hook 与 SSE 接线

**Files:**
- Modify: `client/src/lib/api.ts`
- Modify: `client/src/hooks/useTopicStream.ts`
- Modify: `client/src/hooks/useResearchStream.ts`
- Create: `client/src/hooks/useFinancialModel.ts`

**Interfaces:**
- Consumes: Task 4 类型、Task 6 的 `deriveSheets` / `sheetsTouchedBy` / `isCellChanged`
- Produces: `apiClient.getTopicModels(agentId, topicId)`、`apiClient.getFinancialModel(modelId)`；`useFinancialModel(agentId, topicId)` 返回 `{ models, activeModelId, setActiveModelId, workbook, context, lastFrame, onRevisionFrame }`

- [ ] **Step 1: 加 API 方法**

在 `client/src/lib/api.ts` 的 `apiClient` 对象里加两个方法（照该文件已有方法的写法，用同一个 `fetcher`）：

```ts
    getTopicModels: (agentId: string, topicId: string) =>
        fetcher({ url: `${BASE_URL}/api/agents/${agentId}/topics/${topicId}/models` }) as Promise<{
            success: boolean; models: ModelView[];
        }>,

    getFinancialModel: (modelId: string) =>
        fetcher({ url: `${BASE_URL}/api/financial-models/${modelId}` }) as Promise<
            { success: boolean } & ModelContextView
        >,
```

文件顶部 import 补 `import type { ModelContextView, ModelView } from "@/types/financialModel";`

- [ ] **Step 2: 在 SSE 分发里加分支**

`client/src/lib/api.ts` 的 `handleEvent` switch 里，`case 'topic_dispatch'` 之后加：

```ts
                    case 'model_revision':
                        // A committed model revision is not a unit of work — routing
                        // it through onStep would file "the agent committed rev 47"
                        // next to "the agent ran a scan" in the same progress list.
                        onModelRevision?.(parsed as ModelRevisionFrame);
                        break;
```

`onModelRevision` 来自 `StreamingApiClient.sendMessageStream`（`client/src/lib/api.ts:425`）。该方法用的是**位置参数**，目前 15 个，最后一个是 `inputResponse?: UserInputSubmission`。在它**之后**追加第 16 个可选参数：

```ts
        inputResponse?: UserInputSubmission,
        onModelRevision?: (frame: ModelRevisionFrame) => void,
    ) {
```

15 个位置参数本该改成 options 对象，但那要动这个方法的每一个调用点，超出本次范围 —— 跟着现有形状走，别顺手重构。

- [ ] **Step 3: useTopicStream 透传**

`client/src/hooks/useTopicStream.ts`：

1. options 类型加 `onModelRevision?: (frame: ModelRevisionFrame) => void`
2. 照现有 `onDirectiveRef` 的写法加一个 `onModelRevisionRef`（存 ref，避免内联闭包重建整条流）：

```ts
    const onModelRevisionRef = useRef(options?.onModelRevision);
    onModelRevisionRef.current = options?.onModelRevision;
```

3. 调用 `streaming` 的地方把 `onModelRevision: (frame) => onModelRevisionRef.current?.(frame)` 传下去

- [ ] **Step 4: useResearchStream 透传**

`client/src/hooks/useResearchStream.ts` 把 `onModelRevision` 从自己的 options 原样传给 `useTopicStream`。

- [ ] **Step 5: 写 useFinancialModel**

创建 `client/src/hooks/useFinancialModel.ts`：

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { deriveSheets, isCellChanged as cellChanged, sheetsTouchedBy } from "@/lib/workbook";
import type { ModelContextView, ModelRevisionFrame, ModelView } from "@/types/financialModel";

/** How long several revisions arriving back to back are folded into one refetch.
 *  The agent routinely commits section by section; refetching per frame would
 *  thrash the grid without showing anything new in between. */
const REFETCH_DEBOUNCE_MS = 150;

export type ModelChangeState = {
    revision: number;
    lineItemIds: string[];
    periodIds: string[];
    sheetIds: string[];
};

export function useFinancialModel(agentId: string, topicId: string) {
    const queryClient = useQueryClient();
    const [activeModelId, setActiveModelId] = useState<string | null>(null);
    const [change, setChange] = useState<ModelChangeState | null>(null);
    const pendingRef = useRef<ModelRevisionFrame[]>([]);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const { data: models = [] } = useQuery<ModelView[]>({
        queryKey: ["financialModels", agentId, topicId],
        queryFn: async () => (await apiClient.getTopicModels(agentId, topicId)).models ?? [],
        refetchOnWindowFocus: false,
    });

    const effectiveModelId = activeModelId ?? models[0]?.modelId ?? null;

    const { data: context } = useQuery<ModelContextView>({
        queryKey: ["financialModel", effectiveModelId],
        queryFn: async () => await apiClient.getFinancialModel(effectiveModelId!),
        enabled: effectiveModelId !== null,
        refetchOnWindowFocus: false,
    });

    const workbook = context?.currentWorkbook;
    const sheets = useMemo(() => (workbook ? deriveSheets(workbook) : []), [workbook]);

    const flush = useCallback(() => {
        const frames = pendingRef.current;
        pendingRef.current = [];
        timerRef.current = null;
        if (frames.length === 0) return;

        const modelIds = new Set(frames.map((frame) => frame.model_id));
        for (const modelId of modelIds) {
            void queryClient.invalidateQueries({ queryKey: ["financialModel", modelId] });
        }
        // A model the strip has never seen means the agent just created one.
        if ([...modelIds].some((id) => !models.some((model) => model.modelId === id))) {
            void queryClient.invalidateQueries({ queryKey: ["financialModels", agentId, topicId] });
        }
    }, [agentId, models, queryClient, topicId]);

    const onRevisionFrame = useCallback((frame: ModelRevisionFrame) => {
        pendingRef.current.push(frame);
        // Accumulate rather than replace: collapsing the refetch must not
        // collapse the highlights, or the earlier frames' cells never flash.
        setChange((previous) => {
            const sameRevision = previous?.revision === frame.revision;
            const lineItemIds = new Set(sameRevision ? previous.lineItemIds : []);
            const periodIds = new Set(sameRevision ? previous.periodIds : []);
            const sheetIds = new Set(sameRevision ? previous.sheetIds : []);
            for (const id of frame.changed_line_item_ids) lineItemIds.add(id);
            for (const id of frame.changed_period_ids) periodIds.add(id);
            if (workbook) for (const id of sheetsTouchedBy(frame, sheets, workbook)) sheetIds.add(id);
            return {
                revision: frame.revision,
                lineItemIds: [...lineItemIds],
                periodIds: [...periodIds],
                sheetIds: [...sheetIds],
            };
        });

        if (timerRef.current === null) timerRef.current = setTimeout(flush, REFETCH_DEBOUNCE_MS);
    }, [flush, sheets, workbook]);

    useEffect(() => () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
    }, []);

    const isCellChanged = useCallback(
        (lineItemId: string, periodId: string) => change !== null && cellChanged(
            {
                model_id: "", revision: change.revision, lifecycle_stage: "",
                changed_sections: [], change_kinds: [],
                changed_line_item_ids: change.lineItemIds,
                changed_period_ids: change.periodIds,
            },
            lineItemId,
            periodId,
        ),
        [change],
    );

    return {
        models, activeModelId: effectiveModelId, setActiveModelId,
        context, workbook, sheets, change, isCellChanged, onRevisionFrame,
    };
}
```

- [ ] **Step 6: 类型检查**

Run: `pnpm --prefix client exec tsc -b --noEmit`
Expected: 无错误

- [ ] **Step 7: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交。**

---

## Task 10: ModelPane 与 tab 集成

**Files:**
- Create: `client/src/components/model/ModelPane.tsx`
- Create: `client/src/components/model/RevisionDrawer.tsx`
- Modify: `client/src/lib/topicCharts.ts`
- Modify: `client/src/components/workspace/ChartPane.tsx`
- Modify: `client/src/components/workspace/ChartTabBar.tsx`
- Modify: `client/src/components/workspace/TopicWorkspace.tsx`

**Interfaces:**
- Consumes: Task 8 的五个 sheet 组件、Task 9 的 `useFinancialModel`
- Produces: `<ModelPane context sheets change activeSheetId onSelectSheet isCellChanged />`；`ModelTab = { kind: "model"; modelId: string; symbol: string }`

- [ ] **Step 1: RevisionDrawer**

创建 `client/src/components/model/RevisionDrawer.tsx`：

```tsx
import type { RevisionSummary } from "@/types/financialModel";

/** Revision history is a property of the model, not a table of its own, so it
 *  lives behind the header chip rather than taking a sheet tab. */
export function RevisionDrawer({ history }: { history: RevisionSummary[] }) {
    return (
        <div className="max-h-80 w-96 overflow-auto rounded-md border bg-popover p-2 text-xs shadow-lg">
            {[...history].reverse().map((summary) => (
                <div key={summary.revision} className="border-b px-2 py-1.5 last:border-0">
                    <div className="flex justify-between gap-2">
                        <span className="font-medium">rev {summary.revision}</span>
                        <span className="text-muted-foreground">{summary.lifecycleStage}</span>
                    </div>
                    <div className="text-muted-foreground">
                        {summary.changes.map((change) => change.kind).join("、") || "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{summary.createdAt}</div>
                </div>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: ModelPane**

创建 `client/src/components/model/ModelPane.tsx`：

```tsx
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { SheetDescriptor } from "@/lib/workbook";
import type { ModelContextView } from "@/types/financialModel";
import { DcfSheet } from "./DcfSheet";
import { RevenueSheet } from "./RevenueSheet";
import { RevisionDrawer } from "./RevisionDrawer";
import { SourceStatementSheet } from "./SourceStatementSheet";
import { SummarySheet } from "./SummarySheet";
import { WaccSheetView } from "./WaccSheetView";

export function ModelPane({
    context,
    sheets,
    activeSheetId,
    onSelectSheet,
    markedSheetIds,
    isCellChanged,
}: {
    context: ModelContextView;
    sheets: SheetDescriptor[];
    activeSheetId: string | undefined;
    onSelectSheet: (sheetId: string) => void;
    /** Sheets that changed but are not on screen — they get a dot. */
    markedSheetIds: string[];
    isCellChanged: (lineItemId: string, periodId: string) => boolean;
}) {
    const [historyOpen, setHistoryOpen] = useState(false);
    const active = sheets.find((sheet) => sheet.id === activeSheetId) ?? sheets[0];
    const workbook = context.currentWorkbook;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="relative flex items-center gap-2 border-b px-3 py-2 text-xs">
                <span className="font-medium">{context.model.symbol}</span>
                <button
                    type="button"
                    className="rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70"
                    onClick={() => setHistoryOpen((value) => !value)}
                >
                    rev {workbook.revision}
                </button>
                <span className="text-muted-foreground">{workbook.lifecycleStage}</span>
                {historyOpen && (
                    <div className="absolute left-3 top-8 z-30">
                        <RevisionDrawer history={context.revisionHistory} />
                    </div>
                )}
            </div>

            <div className="min-h-0 flex-1">
                {active?.kind === "summary" && <SummarySheet workbook={workbook} isCellChanged={isCellChanged} />}
                {active?.kind === "source" && <SourceStatementSheet workbook={workbook} sheet={active} isCellChanged={isCellChanged} />}
                {active?.kind === "revenue" && <RevenueSheet workbook={workbook} sheet={active} isCellChanged={isCellChanged} />}
                {active?.kind === "wacc" && <WaccSheetView workbook={workbook} />}
                {active?.kind === "dcf" && <DcfSheet workbook={workbook} isCellChanged={isCellChanged} />}
            </div>

            {/* Sheet strip along the bottom — the position a spreadsheet reader
                already looks for. Thin separators between the three groups make
                the model / source / derived layering visible in the strip itself. */}
            <div className="flex items-center gap-0.5 overflow-x-auto border-t bg-muted/30 px-2 py-1">
                {sheets.map((sheet, index) => (
                    <div key={sheet.id} className="flex items-center">
                        {index > 0 && sheets[index - 1]!.group !== sheet.group && (
                            <span className="mx-1 h-4 w-px bg-border" />
                        )}
                        <button
                            type="button"
                            onClick={() => onSelectSheet(sheet.id)}
                            className={cn(
                                "relative whitespace-nowrap rounded-t px-2.5 py-1 text-xs",
                                sheet.id === active?.id ? "bg-background font-medium shadow-sm" : "hover:bg-background/60",
                            )}
                        >
                            {sheet.label}
                            {markedSheetIds.includes(sheet.id) && sheet.id !== active?.id && (
                                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
                            )}
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
```

- [ ] **Step 3: 加 ModelTab 类型**

`client/src/lib/topicCharts.ts`：

```ts
/** A model workbook tab. Unlike the other two it is not derived from message
 *  history and never becomes a preference row — a model is an object the
 *  backend owns, not something the user arranged. */
export type ModelChartTab = {
    kind: "model";
    modelId: string;
    symbol: string;
};

export type TopicChartTab = SymbolChartTab | OverlayChartTab | ModelChartTab;
```

`chartTabKey` 改成：

```ts
export function chartTabKey(tab: TopicChartTab): string {
    if (tab.kind === "model") return `model:${tab.modelId}`;
    return tab.kind === "symbol" ? `symbol:${tab.symbol}` : `overlay:${tab.id}`;
}
```

`mergeTopicCharts` **不动** —— 模型 tab 在 TopicWorkspace 里单独并入（Step 5）。改完跑一次 `client/src/lib/__tests__/topicCharts.test.ts` 确认没有回归。

- [ ] **Step 4: ChartTabBar 与 ChartPane 加分支**

`ChartTabBar.tsx` 里现有的标签文案函数（`tab.kind === "symbol" ? tab.symbol : overlayTabLabel(...)`）改成三分支，model 返回 `tab.symbol` 并在前面渲染一个 `<Table2 className="h-3 w-3" />`（从 `lucide-react` import）。

`ChartPane.tsx` 的渲染分支加：

```tsx
{active.kind === "model" && modelPane}
```

`modelPane` 作为一个新 prop 从 `TopicWorkspace` 传进来（`ChartPane` 不该自己去取模型数据 —— 它现在也不自己取图表数据）。

- [ ] **Step 5: TopicWorkspace 接线**

`TopicWorkspace.tsx`：

```tsx
const model = useFinancialModel(agentId, activeTopic?.id ?? "");
const [activeSheetId, setActiveSheetId] = useState<string | undefined>(undefined);
// The turn-scoped latch behind the auto-locate rule — see Task 11.
const [userPickedThisTurn, setUserPickedThisTurn] = useState(false);

const stream = useResearchStream(/* 现有参数 */, {
    /* 现有 options */
    onModelRevision: model.onRevisionFrame,
});
```

模型 tab 并入现有 tab 列表：

```tsx
const tabsWithModels = useMemo(
    () => [
        ...tabs,
        ...model.models.map((entry): ModelChartTab => ({
            kind: "model", modelId: entry.modelId, symbol: entry.symbol,
        })),
    ],
    [tabs, model.models],
);
```

关闭模型 tab 时**不要**走 `onClose` 里写偏好的那条路：模型不是偏好，写进去会变成永久隐藏一个还在生长的模型。在 `onClose` 开头加 `if (key.startsWith("model:")) return;`（真要允许关闭，改成本地 `useState` 的一次性隐藏集合，但本次不做）。

把 `modelPane` 传给 `ChartPane`：

```tsx
modelPane={model.context ? (
    <ModelPane
        context={model.context}
        sheets={model.sheets}
        activeSheetId={activeSheetId}
        onSelectSheet={(sheetId) => { setActiveSheetId(sheetId); setUserPickedThisTurn(true); }}
        markedSheetIds={model.change?.sheetIds ?? []}
        isCellChanged={model.isCellChanged}
    />
) : null}
```

- [ ] **Step 6: 类型检查**

Run: `pnpm --prefix client exec tsc -b --noEmit`
Expected: 无错误

- [ ] **Step 7: 跑全部测试**

Run: `pnpm test`
Expected: 全绿（含 `topicCharts.test.ts` 无回归）。**不要提交。**

---

## Task 11: 自动定位

**Files:**
- Modify: `client/src/components/workspace/TopicWorkspace.tsx`

**Interfaces:**
- Consumes: Task 10 的 `activeSheetId` / `userPickedThisTurn` / `model.change`、`useResearchStream` 的 `isProcessing`

**规则（spec §7.3，不得放宽）：** 只在 **agent 回合进行中** 且 **用户本回合没有手动点过标签** 时自动切 sheet。用户点过任何标签后，本回合内不再自动切，直到下一个回合重开。

- [ ] **Step 1: 加回合边界的 latch 复位**

在 `TopicWorkspace.tsx` 里，`isProcessing` 由 false→true 时（新回合开始）复位 latch：

```tsx
const wasProcessingRef = useRef(false);
useEffect(() => {
    // A new turn re-opens auto-locate. Resetting on the rising edge (not on
    // every render where isProcessing is true) is what makes "this turn" a
    // real boundary rather than a permanent state.
    if (stream.isProcessing && !wasProcessingRef.current) setUserPickedThisTurn(false);
    wasProcessingRef.current = stream.isProcessing;
}, [stream.isProcessing]);
```

- [ ] **Step 2: 加自动定位**

```tsx
useEffect(() => {
    if (!stream.isProcessing || userPickedThisTurn) return;
    const target = model.change?.sheetIds[0];
    // The list is already in strip order (sheetsTouchedBy preserves it), so the
    // first entry is the leftmost changed sheet — a stable choice rather than
    // whichever frame happened to arrive last.
    if (target && target !== activeSheetId) setActiveSheetId(target);
}, [model.change, stream.isProcessing, userPickedThisTurn, activeSheetId]);
```

行内滚动由 `WorkbookGrid` 的 `scrollToLineItemId` 承担：把 `model.change?.lineItemIds[0]` 一路传到当前 sheet 的 `WorkbookGrid`（`ModelPane` 加一个 `scrollToLineItemId` prop 透传给各 sheet 组件，各 sheet 组件再透传给 `WorkbookGrid`）。仅在自动定位发生时传，用户手动切标签时传 `undefined`。

- [ ] **Step 3: 类型检查**

Run: `pnpm --prefix client exec tsc -b --noEmit`
Expected: 无错误

- [ ] **Step 4: 构建前端确认能打包**

Run: `pnpm build:client`
Expected: 构建成功

- [ ] **Step 5: 跑全部测试**

Run: `pnpm test`
Expected: 全绿。**不要提交 —— 全部任务到此结束，交给用户审阅。**

---

## 收尾检查

全部任务完成后，逐条确认：

- [ ] `pnpm test` 全绿
- [ ] `pnpm build:client` 成功
- [ ] `git status` 显示的改动只在计划列出的文件范围内（**只看，不提交**）
- [ ] `src/financial-model/` 下除 `__tests__/viewContract.test.ts` 外无改动
- [ ] `mcp_tools/` 下无改动
- [ ] `client/` 下没有任何文件 import `src/` 的东西：`grep -rn "\.\./\.\./src/" client/src` 应无输出
