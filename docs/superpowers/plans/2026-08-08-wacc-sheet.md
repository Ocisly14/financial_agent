# WACC Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WACC 从黑盒工具改造成与 DCF 主表同构的骨架表：建模即有 12 行固定结构（as-of 锚定创建日），引擎自动算可测项、算不了的空着并点名缺口，agent 用 `set_wacc_input` 填值/公式，`wacc` 行 = 锁定骨架公式的计算结果 = 唯一官方折现率。`compute_wacc`/`waccStore`/`wacc_status` 整条旁路移除。

**Architecture:** 新纯模块 `src/financial-model/waccSheet.ts`（骨架/标量求值器/刷新合并），快照持有 `waccSheet`；自动刷新沿用 `waccDerivation`（beta 窗口 5→10 年）在 review commit 后落成一次 `wacc_sheet_refreshed` revision；agent 写入走 `apply_financial_model_operations` 新操作 `set_wacc_input`；估值与 valued 门槛直读 `wacc` 行。

**Spec:** `docs/superpowers/specs/2026-08-08-wacc-sheet-design.md`（权重用 total_debt、net_debt 为展示行——用户已确认）。

## Global Constraints

- **不要执行 `git commit`**——每 task `git add` 暂存并汇报。
- 单测 `node --env-file=.env --experimental-strip-types --experimental-sqlite --test <file>`；全量 `npm test`；`npx tsc -p tsconfig.json --noEmit` 必须干净；exactOptionalPropertyTypes：可选字段一律条件展开。
- 骨架 12 行 rowId 固定：`beta, risk_free_rate, equity_risk_premium, cost_of_equity, cost_of_debt, equity_value, total_debt, net_debt, e_over_v, d_over_v, effective_tax_rate, wacc`。
- 锁定公式（agent 不可改）：`cost_of_equity = risk_free_rate + beta * equity_risk_premium`；`net_debt = total_debt - cash_and_equivalents_value`（cash 由刷新时从 spine 注入为 computed 标量，见 Task 3）；`e_over_v = equity_value / (equity_value + total_debt)`；`d_over_v = total_debt / (equity_value + total_debt)`；`wacc = e_over_v * cost_of_equity + d_over_v * cost_of_debt * (1 - effective_tax_rate)`。
- agent 可写行：`risk_free_rate`、`equity_risk_premium`（必填来源），`cost_of_debt`（覆盖 computed，rationale 必填）。其余行 `set_wacc_input` 一律拒绝。
- 自动项永不覆盖 agent 已写的行（source === "agent" 的行刷新跳过）。
- beta 窗口：`DEFAULT_BETA_YEARS` 5 → 10。
- prompt 文本只进 `src/agent/prompts/`。

---

### Task 1: `waccSheet.ts` 纯模块（骨架 + 标量求值 + 写入/刷新合并）

**Files:**
- Create: `src/financial-model/waccSheet.ts`
- Test: `src/financial-model/__tests__/waccSheet.test.ts`

**Interfaces（Produces，后续任务按此消费）:**

```ts
export const WACC_SHEET_ROW_IDS = [/* Global Constraints 的 12 个 */] as const;
export type WaccSheetRowId = typeof WACC_SHEET_ROW_IDS[number];
export type WaccSheetRow = {
  rowId: WaccSheetRowId; label: string; unit: Unit;
  source: "computed" | "agent" | "locked_formula" | "empty";
  value: number | null;
  formulaSource?: string;                    // locked 行恒有；agent 公式行有
  provenance?: { sourceType: string; sourceRefs: string[]; asOfDate: string; rationale: string };
  missingInputs: WaccSheetRowId[];           // 求值后为空数组或缺口清单
};
export type WaccSheet = { asOfDate: string; rows: WaccSheetRow[] };
export type WaccSheetComputedInput = { rowId: "beta"|"cost_of_debt"|"equity_value"|"total_debt"|"effective_tax_rate"|"cash_and_equivalents_value";
  value: number; provenance: NonNullable<WaccSheetRow["provenance"]> };
export type SetWaccInput = { rowId: WaccSheetRowId; value?: number; formula?: string;
  sourceType: string; sourceRefs: string[]; rationale: string; asOfDate: string };

export function createWaccSheet(asOfDate: string): WaccSheet;      // 12 行骨架 + cash_and_equivalents_value 隐藏第 13 行(unit currency, computed, 供 net_debt 公式引用)
export function applyComputedWaccInputs(sheet: WaccSheet, inputs: readonly WaccSheetComputedInput[]): WaccSheet; // source==="agent" 的行跳过
export function setWaccInput(sheet: WaccSheet, input: SetWaccInput): WaccSheet; // 锁定/不可写行抛 FinancialModelError("invalid_model_operation")
export function recalculateWaccSheet(sheet: WaccSheet): WaccSheet; // 求值全部公式行, 填 value/missingInputs
```

求值器：单列标量环境。用 `parseFormula` 得 AST，引用只允许 12+1 个 rowId（未知引用抛错）；输入为 null → 结果 null 且 `missingInputs` 记直接缺失的输入行（传递闭包不展开，只记一层——诊断链靠逐行看）。按依赖序迭代至不动点；环 → `circular_dependency`。单位：beta/e_over_v/d_over_v ratio，rf/ERP/costs/tax/wacc percent…实现按 `combine` 单位代数推导，锁定公式的产出单位在骨架里预声明并断言一致。

- [ ] **Step 1: 失败测试**（骨架形状与锁定公式；缺口传导；agent 写入与拒绝；computed 不覆盖 agent；链式补齐后 wacc 算出——用 beta 1.2、rf 0.04、erp 0.05、cod 0.03、E 3e12、D 1e11、cash 3e10、tax 0.15 手算断言 wacc ≈ (E/V)*0.1 + (D/V)*0.03*0.85）
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过 + tsc** → **Step 5: `git add`（不 commit）**

---

### Task 2: 快照集成（snapshot / codec / views / 创建初始化）

**Files:**
- Modify: `src/financial-model/operations.ts`（`FinancialModelSnapshot` 加 `waccSheet: WaccSheet | null`）
- Modify: `src/financial-model/snapshotCodec.ts`（编解码 + 老快照 null 兼容）
- Modify: `src/financial-model/service.ts`（`createModel` 初始化 `createWaccSheet(<创建日 YYYY-MM-DD>)` 并 `recalculateWaccSheet`；`structuredClone` 路径自然携带）
- Modify: `src/financial-model/views.ts`（`CurrentWorkbookView` 加 `waccSheet: WaccSheet | null`，`buildWorkbookView` 透传）
- Test: `src/financial-model/__tests__/service.test.ts` 追加

**Interfaces:** Consumes Task 1 全部导出。Produces：`view.currentWorkbook.waccSheet`。

- [ ] 失败测试：createModel 后 `currentWorkbook.waccSheet` 有 12 行、asOfDate 为当天、`wacc.missingInputs` 非空；codec round-trip；老快照（手工构造无 waccSheet 的 encode 输出）decode 得 null。
- [ ] 实现 → 全量测试（codec/goldenDcf 等不得破）→ tsc → `git add`。

---

### Task 3: 自动刷新接线（commit 后派生 → `wacc_sheet_refreshed` revision）

**Files:**
- Modify: `src/financial-model/waccDerivation.ts`（`DEFAULT_BETA_YEARS` → 10；确认派生输出含 beta/costOfDebt/equityValue/totalDebt/taxRate，并补 `cash_and_equivalents_value`——从 committed spine 的 `cash_and_equivalents` 行读，缺则 unreachable）
- Modify: `src/financial-model/service.ts`（新方法 `refreshWaccSheet(modelId, expectedRevision, inputs: WaccSheetComputedInput[]): CommitResult`——apply+recalculate+commit，summary change 用新 kind `wacc_sheet_refreshed`；`views.ts` validKinds/validateSummary 注册该 kind）
- Modify: `mcp_tools/financial-model/financialModelTools.ts`（`mutate` 的 `refreshWacc` 分支改为：调 `deriveParameters`（读 `waccDerivation` 现有入口与 `barRepository`），把结果转成 `WaccSheetComputedInput[]` 调 `service.refreshWaccSheet`；响应 summary 描述改为"刷新了 N 个自动项，wacc 行当前 <值|null 及缺口>"）
- Test: `src/financial-model/__tests__/service.test.ts` + `mcp_tools/financial-model/__tests__/financialModelTools.test.ts` 追加

**先读**：`waccRefresh.ts` 的 `refreshWaccParameters` 看现有派生调用形态（barRepository 注入、失败即跳过的容错——沿用：派生抛错时 mutate 不失败，响应记 `wacc_refresh_skipped` 原因）。

- [ ] 失败测试：review commit 后（barRepository 用假 bars 注入）waccSheet 的 beta/equity_value 等被填、agent 预写的 rf 未被覆盖、产生一次 `wacc_sheet_refreshed` revision；barRepository 缺席时 commit 照常、响应带 skipped 原因。
- [ ] 实现 → 通过 → `git add`。

---

### Task 4: `set_wacc_input` 操作

**Files:**
- Modify: `src/financial-model/operations.ts`（`ModelOperation` 加 `{ kind: "set_wacc_input"; input: SetWaccInput }`，handler 调 Task 1 的 `setWaccInput`+`recalculateWaccSheet`，快照无表时抛 invalid）
- Modify: `src/financial-model/service.ts`（`operationChanges` case → 新 change kind `wacc_input_set { rowId }`；views validKinds 注册）
- Modify: `mcp_tools/financial-model/schemas.ts`（operationsInputSchema 的操作 oneOf 增加 set_wacc_input 变体：rowId/value/formula/sourceType/sourceRefs/rationale，additionalProperties false）
- Test: service.test + financialModelTools.test 追加

- [ ] 失败测试：apply set_wacc_input(rf, erp) 后 wacc 行链式算出；对 `wacc`/`e_over_v` 写入被拒；缺 rationale 被 schema 拒；工具层 apply_financial_model_operations 全链路一条。
- [ ] 实现 → 通过 → `git add`。

---

### Task 5: 移除旧路 + 门槛/估值改读表 + prompt 重写

**Files:**
- Delete: `mcp_tools/financial-model/waccTool.ts`、`mcp_tools/financial-model/__tests__/waccTool.test.ts`、`src/financial-model/waccRefresh.ts`、`src/financial-model/waccStore.ts`、`src/financial-model/__tests__/waccStore.test.ts`
- Modify: `mcp_tools/financial-model/financialModelTools.ts`（deps 去 `waccParameterStore`；去 describeWaccStatus/waccStatusData/waccStatus 调用，`get_financial_model` 响应自然带 `current_workbook.waccSheet`）
- Modify: `src/agent/subagents/registerSubagents.ts`（去 `COMPUTE_WACC_TOOL`）
- Modify: `src/financial-model/service.ts`（stage gate：advance 到 `valued` 要求 `waccSheet.wacc.value !== null`——先读 `enforceStageGates` 现状，替换原 wacc 相关条件）
- Modify: `src/financial-model/valuation.ts` 或其调用处（wacc 输入改读 `snapshot.waccSheet` 的 wacc 行；原 `wacc` line item assumption 行：改为 `forecast:"calculated"` 由表回填每个 forecast 期，或最小改动保留但 `set_assumption` 对其拒绝——实现者读 `valuation.ts`/`reconciliation.ts` 后选改动最小且测试可证的一条，报告注明）
- Modify: `src/agent/prompts/subagentPrompts.ts`（WACC 两段重写：读表→填洞→wacc 行即官方值；删 compute_wacc 叙述）
- Test: 相关测试文件同步清理/追加（valued 门槛一条）

- [ ] 删除与改造 → `npm test` 全绿（涉旧路测试删改）→ tsc → `git add`
- [ ] 注意：`wacc.ts` 的 `computeWacc`/`effectiveTaxRates` 若仍被 waccDerivation/测试引用则保留，死了才删。

---

### Task 6: 收尾回归 + e2e 冒烟

**Files:**
- Modify: `scripts/xbrl/e2e_test/step4-formulas.ts`（仅当它引用了被删模块时修 import；功能不动）
- 新增 `scripts/xbrl/e2e_test/step6-wacc.ts`（不调 LLM：重放 step1-3 建 committed 模型 → 断言自动项已填/缺口点名 → set_wacc_input 补 rf/erp → 打印 12 行表与 wacc 值）

- [ ] step6 跑通打印全表；`npm test` + tsc 全绿 → `git add`。

---

## Self-Review 记录

- 用户三决策全覆盖：as-of=创建日（Task 2 初始化 + Task 3 刷新不改期）✓；compute_wacc 及旁路整体移除（Task 5）✓；beta 10y（Task 3）✓；权重 total_debt、net_debt 展示行（Task 1 锁定公式）✓。
- "算不了的空着、agent 看到后填"：missingInputs 逐行点名（Task 1）+ 视图透出（Task 2）+ set_wacc_input（Task 4）+ prompt（Task 5）成环 ✓。
- 类型一致性：`WaccSheet`/`WaccSheetRow`/`WaccSheetComputedInput`/`SetWaccInput`/`refreshWaccSheet`/change kinds 已跨任务核对。
- 已知留白：`wacc` line item 行的处置给了两个可选实现（Task 5），由实现者按最小改动定并在报告注明——估值读数源唯一这一点不可妥协。
