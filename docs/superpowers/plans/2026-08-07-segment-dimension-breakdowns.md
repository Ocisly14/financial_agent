# Segment Dimension Breakdowns（渐进式披露）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 statement_unification subagent 通过渐进式披露工具自主发现 XBRL 维度轴（segment / product / geography 等），把选中的轴物化为 unified statements 的 breakdown 行，并让 spine_mapping 把它们安全地映射为 DCF 模型的 revenue streams / detail rows——全程防双计。

**Architecture:** 维度事实已经完整存在 `FilingTableStore`（每个 `FilingTableFactOccurrence` 带 `dimensions`），Python/Arelle 侧零改动。新增纯函数模块 `dimensionInventory.ts` 做轴目录聚合与数值解析；unification subagent 获得两个新工具（`list_dimension_axes` / `get_axis_breakdown`）和一个有步数上限的探索 loop；decision schema 的 row 增加 `breakdowns` 声明（agent 只选轴，数值由 host 确定性物化）；spine_mapping 侧加机械校验：breakdown 行只能做 detailRow、revenue 下只许一条轴。

**Tech Stack:** TypeScript (Node --experimental-strip-types)、node:test、node:sqlite。无新依赖。

## Global Constraints

- **不要执行 `git commit`**。每个 task 结束时 `git add` 暂存并汇报即可——用户 review 后自己提交（用户长期偏好）。
- 工具定义放 `mcp_tools/`（照 `mappingSubagentTools.ts` 先例）；prompt 文本一律放 `src/agent/prompts/dcfSubagentPrompts.ts`，不许内联在 agent/注册文件里。
- 数值上限（用户定）：每个父行 **≤3 条轴**；每条轴 **≤25 个 member**（截断并记录）；全模型 breakdown 行总数 **≤150**（截断并记录 finding）。
- Agent 永不输出数值；breakdown 的数值全部由 host 从 store 确定性解析（latest-filing-wins）。
- 单测运行命令：`node --env-file=.env --experimental-strip-types --experimental-sqlite --test <测试文件路径>`；全量：`npm test`。
- 仓库风格：紧凑、注释只讲代码本身讲不出的约束；测试用 `node:test` + `assert/strict`，fixture 手工构造（参考 `src/infra/xbrl/__tests__/spineFixture.ts`）。
- 向后兼容：老的 `UnifiedStatementsArtifact` 没有 `breakdownRows` 字段，读取处一律 `?? []`；`FinancialModelToolDeps.tableStore` 为可选，缺席时跳过探索与 breakdown（老测试不受影响）。

---

### Task 1: `dimensionInventory.ts` — 轴目录与 breakdown 数值解析（纯函数）

**Files:**
- Create: `src/infra/xbrl/dimensionInventory.ts`
- Test: `src/infra/xbrl/__tests__/dimensionInventory.test.ts`

**Interfaces:**
- Consumes: `FilingTable`（`src/infra/xbrl/tableTypes.ts`）、`XbrlDimension` / `FilingTableFactOccurrence`（`src/infra/xbrl/types.ts`）、`Period` / `Unit`（`src/financial-model/types.ts`）。
- Produces（后续 task 依赖的精确签名）:

```ts
export type AxisCatalogEntry = {
  axisQName: string;
  axisLabel: string;
  memberCount: number;
  /** 最多 6 个，latest filing 优先。 */
  sampleMemberLabels: string[];
  /** 按 factCount 降序，最多 8 个。 */
  concepts: Array<{ conceptQName: string; conceptLabel: string; factCount: number }>;
  accessions: string[];
  /** 只含 requestedPeriods 中 cls==="actual" 的期。 */
  periodCoverage: string[];
};
export function buildAxisCatalog(input: {
  tables: readonly FilingTable[]; requestedPeriods: readonly Period[];
}): AxisCatalogEntry[];

export type AxisMemberSeries = {
  memberQName: string; memberLabel: string;
  values: Record<string, number | null>; accessions: string[];
};
export type AxisBreakdown = {
  axisQName: string; conceptQName: string; unit: Unit | null;
  members: AxisMemberSeries[]; truncated: boolean;
};
export function buildAxisBreakdown(input: {
  tables: readonly FilingTable[]; requestedPeriods: readonly Period[];
  axisQName: string; conceptQName: string; maxMembers?: number; // default 25
}): AxisBreakdown;
```

解析语义（写进实现注释）：
- 候选事实 = 所有表格所有 cell 的 fact 中，`conceptQName` 匹配且 `dimensions` 含目标轴的。
- 同一 `(memberQName, periodId)` 多个候选时的确定性择一：维度总数最少 → `filedAt` 最新 → `htmlOrder` 最小。维度数最少优先是为了偏向"干净"的 segment 事实（segment fact 常额外挂 `ConsolidationItemsAxis`，但纯单轴的更接近披露主表）。
- 期只保留 `requestedPeriods` 中 `cls === "actual"` 的 id；member 无值的期填 `null`。
- member 排序：latest filing 中的出现顺序（`htmlOrder`），只在老 filing 出现的排最后。
- `unit`：取第一个被采用事实的 unit；无事实时 `null`。

- [ ] **Step 1: 写失败测试**

```ts
// src/infra/xbrl/__tests__/dimensionInventory.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildAxisCatalog, buildAxisBreakdown } from "../dimensionInventory.ts";
import type { FilingTable } from "../tableTypes.ts";
import type { FilingTableFactOccurrence, XbrlDimension } from "../types.ts";
import { period } from "./spineFixture.ts";

const SEG = "us-gaap:StatementBusinessSegmentsAxis";
const REV = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax";
const USD = { kind: "currency", code: "USD" } as const;

function dim(member: string, memberLabel: string, axis = SEG): XbrlDimension {
  return { axisQName: axis, axisLabel: "Segments", memberQName: member, memberLabel };
}
function dimFact(concept: string, periodId: string, value: number, dims: XbrlDimension[], htmlOrder = 1): FilingTableFactOccurrence {
  return { occurrenceId: `${concept}|${periodId}|${dims.map((d) => d.memberQName).join(",")}|${htmlOrder}`,
    conceptQName: concept, conceptLabel: concept, htmlOrder, contextId: "c", periodId, value,
    unit: USD, decimals: -6, dimensions: dims, sourceAnchor: "#f" };
}
function table(over: Partial<FilingTable> & { accession: string; filedAt: string; facts: FilingTableFactOccurrence[] }): FilingTable {
  const { facts, ...rest } = over;
  return { sourceTableId: `${over.accession}-t1`, form: "10-K", reportDate: over.filedAt,
    heading: "Segment information", htmlOrder: 5, sourceAnchor: "#t1",
    prescreen: { tier: "weak", presentationOverlap: 0, dimensionlessRatio: 0, periodSpan: 2, factCount: facts.length },
    suggestedStatements: [], columns: [],
    rows: [{ order: 1, labelText: "Revenue", indentLevel: 0, cells: facts.map((fact, index) => ({ columnIndex: index + 1, text: String(fact.value), fact })) }],
    ...rest };
}

const periods = [period("FY2024", 2024), period("FY2025", 2025)];

test("buildAxisCatalog aggregates axes with member samples and top concepts", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:BMember", "Segment B")]),
    dimFact("us-gaap:OperatingIncomeLoss", "FY2025", 10e9, [dim("x:AMember", "Segment A")]),
  ] });
  const catalog = buildAxisCatalog({ tables: [t], requestedPeriods: periods });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.axisQName, SEG);
  assert.equal(catalog[0]!.memberCount, 2);
  assert.deepEqual(catalog[0]!.concepts.map((c) => c.conceptQName), [REV, "us-gaap:OperatingIncomeLoss"]);
  assert.deepEqual(catalog[0]!.periodCoverage, ["FY2025"]);
});

test("buildAxisBreakdown resolves latest-filing-wins per member per period", () => {
  const older = table({ accession: "acc-2024", filedAt: "2025-01-30", facts: [
    dimFact(REV, "FY2024", 55e9, [dim("x:AMember", "Segment A")]),
  ] });
  const latest = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2024", 56e9, [dim("x:AMember", "Segment A")]), // 重述，应赢
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
  ] });
  const breakdown = buildAxisBreakdown({ tables: [older, latest], requestedPeriods: periods, axisQName: SEG, conceptQName: REV });
  assert.equal(breakdown.members.length, 1);
  assert.deepEqual(breakdown.members[0]!.values, { FY2024: 56e9, FY2025: 60e9 });
  assert.deepEqual(breakdown.unit, USD);
});

test("buildAxisBreakdown prefers the fact with fewest dimensions", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 61e9, [dim("x:AMember", "Segment A"),
      dim("us-gaap:OperatingSegmentsMember", "Operating", "us-gaap:ConsolidationItemsAxis")]),
    dimFact(REV, "FY2025", 60e9, [dim("x:AMember", "Segment A")]),
  ] });
  const breakdown = buildAxisBreakdown({ tables: [t], requestedPeriods: periods, axisQName: SEG, conceptQName: REV });
  assert.equal(breakdown.members[0]!.values["FY2025"], 60e9);
});

test("buildAxisBreakdown truncates at maxMembers and flags it", () => {
  const facts = Array.from({ length: 30 }, (_, i) =>
    dimFact(REV, "FY2025", 1e9 + i, [dim(`x:M${i}Member`, `M${i}`)], i + 1));
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts });
  const breakdown = buildAxisBreakdown({ tables: [t], requestedPeriods: periods, axisQName: SEG, conceptQName: REV, maxMembers: 25 });
  assert.equal(breakdown.members.length, 25);
  assert.equal(breakdown.truncated, true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/dimensionInventory.test.ts`
Expected: FAIL — `Cannot find module .../dimensionInventory.ts`

- [ ] **Step 3: 实现 `dimensionInventory.ts`**

要点（完整实现，非骨架）：

```ts
import type { Period, Unit } from "../../financial-model/types.ts";
import type { FilingTable } from "./tableTypes.ts";
import type { FilingTableFactOccurrence } from "./types.ts";

// （此处放上文 Interfaces 段声明的 4 个导出类型）

type Occurrence = { fact: FilingTableFactOccurrence; filedAt: string; accession: string };

function collect(tables: readonly FilingTable[]): Occurrence[] {
  return tables.flatMap((table) => table.rows.flatMap((row) => row.cells.flatMap((cell) =>
    cell.fact ? [{ fact: cell.fact, filedAt: table.filedAt, accession: table.accession }] : [])));
}

export function buildAxisCatalog(input: { tables: readonly FilingTable[]; requestedPeriods: readonly Period[] }): AxisCatalogEntry[] {
  const actual = new Set(input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => p.id));
  // 按 filedAt 降序遍历，member 样例与 axisLabel 取 latest 优先
  const occurrences = collect(input.tables).sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  const axes = new Map<string, { label: string; members: Map<string, string>;
    concepts: Map<string, { label: string; count: number }>; accessions: Set<string>; periods: Set<string> }>();
  for (const { fact, accession } of occurrences) {
    if (!actual.has(fact.periodId)) continue;
    for (const dimension of fact.dimensions) {
      const entry = axes.get(dimension.axisQName)
        ?? { label: dimension.axisLabel, members: new Map(), concepts: new Map(), accessions: new Set(), periods: new Set() };
      if (!entry.members.has(dimension.memberQName)) entry.members.set(dimension.memberQName, dimension.memberLabel);
      const concept = entry.concepts.get(fact.conceptQName) ?? { label: fact.conceptLabel, count: 0 };
      concept.count += 1; entry.concepts.set(fact.conceptQName, concept);
      entry.accessions.add(accession); entry.periods.add(fact.periodId);
      axes.set(dimension.axisQName, entry);
    }
  }
  return [...axes].map(([axisQName, e]) => ({ axisQName, axisLabel: e.label,
    memberCount: e.members.size, sampleMemberLabels: [...e.members.values()].slice(0, 6),
    concepts: [...e.concepts].sort((a, b) => b[1].count - a[1].count).slice(0, 8)
      .map(([conceptQName, c]) => ({ conceptQName, conceptLabel: c.label, factCount: c.count })),
    accessions: [...e.accessions].sort(), periodCoverage: [...e.periods].sort() }))
    .sort((a, b) => b.concepts.reduce((s, c) => s + c.factCount, 0) - a.concepts.reduce((s, c) => s + c.factCount, 0));
}

export function buildAxisBreakdown(input: { tables: readonly FilingTable[]; requestedPeriods: readonly Period[];
  axisQName: string; conceptQName: string; maxMembers?: number }): AxisBreakdown {
  const actualIds = input.requestedPeriods.filter((p) => p.cls === "actual").map((p) => p.id).sort();
  const actual = new Set(actualIds);
  const candidates = collect(input.tables).filter(({ fact }) => fact.conceptQName === input.conceptQName
    && actual.has(fact.periodId) && fact.dimensions.some((d) => d.axisQName === input.axisQName));
  // (member, period) 择一：维度最少 → filedAt 最新 → htmlOrder 最小
  candidates.sort((a, b) => a.fact.dimensions.length - b.fact.dimensions.length
    || b.filedAt.localeCompare(a.filedAt) || a.fact.htmlOrder - b.fact.htmlOrder);
  const byMember = new Map<string, { label: string; values: Map<string, number>; accessions: Set<string>; order: number }>();
  let order = 0;
  for (const { fact, accession } of candidates) {
    const dimension = fact.dimensions.find((d) => d.axisQName === input.axisQName)!;
    const member = byMember.get(dimension.memberQName)
      ?? { label: dimension.memberLabel, values: new Map(), accessions: new Set(), order: order++ };
    if (!member.values.has(fact.periodId)) { member.values.set(fact.periodId, fact.value); member.accessions.add(accession); }
    byMember.set(dimension.memberQName, member);
  }
  const maxMembers = input.maxMembers ?? 25;
  const all = [...byMember].sort((a, b) => a[1].order - b[1].order);
  return { axisQName: input.axisQName, conceptQName: input.conceptQName,
    unit: candidates[0]?.fact.unit ?? null,
    members: all.slice(0, maxMembers).map(([memberQName, m]) => ({ memberQName, memberLabel: m.label,
      values: Object.fromEntries(actualIds.map((id) => [id, m.values.get(id) ?? null])),
      accessions: [...m.accessions].sort() })),
    truncated: all.length > maxMembers };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/dimensionInventory.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add src/infra/xbrl/dimensionInventory.ts src/infra/xbrl/__tests__/dimensionInventory.test.ts
```

---

### Task 2: breakdown 物化 `materializeBreakdowns` + artifact 类型扩展

**Files:**
- Modify: `src/infra/xbrl/dimensionInventory.ts`（追加）
- Modify: `src/infra/xbrl/unifiedStatements.ts`（只加类型字段）
- Test: `src/infra/xbrl/__tests__/dimensionInventory.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `buildAxisBreakdown`；`UnificationDecision` / `UnifiedRowDecision`（`unifiedStatements.ts`）。
- Produces:

```ts
// unifiedStatements.ts 内：
export type UnifiedRowDecision = { rowId: string; statement: StatementKind; label: string;
  components: UnifiedComponent[]; perYearOverrides?: UnifiedRowOverride[]; rationale: string;
  /** ≤3 条轴；agent 只声明轴与 concept，数值由 materializeBreakdowns 解析。 */
  breakdowns?: Array<{ axisQName: string; conceptQName: string; rationale: string }> };

export type UnifiedStatementsArtifact = { /* 现有字段不变，追加： */
  /** 维度拆分行。老 artifact 无此字段，读取处一律 `?? []`。 */
  breakdownRows?: BreakdownRow[] };

// dimensionInventory.ts 内：
export type BreakdownRow = { rowId: string; parentRowId: string; axisQName: string;
  memberQName: string; label: string; unit: Unit | null;
  values: Record<string, number | null>; rationale: string };
export const MAX_AXES_PER_ROW = 3;
export const MAX_MEMBERS_PER_AXIS = 25;
export const MAX_BREAKDOWN_ROWS = 150;
export function materializeBreakdowns(input: { decision: UnificationDecision;
  tables: readonly FilingTable[]; requestedPeriods: readonly Period[];
}): { breakdownRows: BreakdownRow[]; findings: string[] };
```

语义：
- rowId = `${parentRowId}.${axisSlug}.${memberSlug}`；`axisSlug` = 轴 QName 冒号后的 local name 去掉尾缀 `Axis` 后小写；`memberSlug` = member local name 去掉尾缀 `Member` 后小写，非 `[a-z0-9]` 折叠为 `_`。
- findings（喂回 agent 的 patch loop）：某 row 声明的 `(axisQName, conceptQName)` 在 store 里零事实 → `breakdown for row "X" found no facts for <axis>/<concept>`；row 声明 >3 条轴 → 保留前 3 条并出 finding；总行数 >150 → 截断并出 finding。member 截断（>25）不算 finding，只在行数上体现（探索工具已让 agent 看过 truncated 标志）。

- [ ] **Step 1: 写失败测试（追加到现有测试文件）**

```ts
import { materializeBreakdowns, MAX_BREAKDOWN_ROWS } from "../dimensionInventory.ts";
import type { UnificationDecision } from "../unifiedStatements.ts";

function decisionWith(breakdowns: NonNullable<UnificationDecision["rows"][number]["breakdowns"]>): UnificationDecision {
  return { rows: [{ rowId: "net_sales", statement: "income_statement", label: "Net sales",
    components: [{ conceptQName: REV, weight: 1 }], rationale: "face line", breakdowns }] };
}

test("materializeBreakdowns builds member rows under the parent rowId", () => {
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts: [
    dimFact(REV, "FY2025", 60e9, [dim("x:ProductsMember", "Products")]),
    dimFact(REV, "FY2025", 40e9, [dim("x:ServicesMember", "Services")]),
  ] });
  const { breakdownRows, findings } = materializeBreakdowns({
    decision: decisionWith([{ axisQName: SEG, conceptQName: REV, rationale: "segment split" }]),
    tables: [t], requestedPeriods: periods });
  assert.deepEqual(findings, []);
  assert.deepEqual(breakdownRows.map((r) => r.rowId),
    ["net_sales.statementbusinesssegments.products", "net_sales.statementbusinesssegments.services"]);
  assert.equal(breakdownRows[0]!.parentRowId, "net_sales");
  assert.equal(breakdownRows[0]!.values["FY2025"], 60e9);
});

test("materializeBreakdowns caps axes per row at 3 with a finding", () => {
  const axes = ["a:A1Axis", "a:A2Axis", "a:A3Axis", "a:A4Axis"].map((axisQName) =>
    ({ axisQName, conceptQName: REV, rationale: "r" }));
  const t = table({ accession: "acc-2025", filedAt: "2026-01-30", facts:
    axes.map((a, i) => dimFact(REV, "FY2025", 1e9, [dim(`x:M${i}Member`, `M${i}`, a.axisQName)])) });
  const { breakdownRows, findings } = materializeBreakdowns({
    decision: decisionWith(axes), tables: [t], requestedPeriods: periods });
  assert.equal(new Set(breakdownRows.map((r) => r.axisQName)).size, 3);
  assert.equal(findings.filter((f) => f.includes("more than 3 axes")).length, 1);
});

test("materializeBreakdowns reports an axis/concept with no facts", () => {
  const { breakdownRows, findings } = materializeBreakdowns({
    decision: decisionWith([{ axisQName: SEG, conceptQName: "us-gaap:Nothing", rationale: "r" }]),
    tables: [], requestedPeriods: periods });
  assert.deepEqual(breakdownRows, []);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /no facts/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/dimensionInventory.test.ts`
Expected: FAIL — `materializeBreakdowns is not exported` / breakdowns 字段类型错误

- [ ] **Step 3: 实现**

`unifiedStatements.ts`：给 `UnifiedRowDecision` 加 `breakdowns?`、给 `UnifiedStatementsArtifact` 加 `breakdownRows?`（如上）。不改任何函数逻辑。

`dimensionInventory.ts` 追加：

```ts
const slug = (qname: string, strip: RegExp): string =>
  (qname.split(":").pop() ?? qname).replace(strip, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x";

export function materializeBreakdowns(input: { decision: UnificationDecision;
  tables: readonly FilingTable[]; requestedPeriods: readonly Period[] }): { breakdownRows: BreakdownRow[]; findings: string[] } {
  const breakdownRows: BreakdownRow[] = [];
  const findings: string[] = [];
  for (const row of input.decision.rows) {
    const declared = row.breakdowns ?? [];
    if (declared.length > MAX_AXES_PER_ROW) {
      findings.push(`row "${row.rowId}" declares more than ${MAX_AXES_PER_ROW} axes; keeping the first ${MAX_AXES_PER_ROW}`);
    }
    for (const breakdown of declared.slice(0, MAX_AXES_PER_ROW)) {
      const resolved = buildAxisBreakdown({ tables: input.tables, requestedPeriods: input.requestedPeriods,
        axisQName: breakdown.axisQName, conceptQName: breakdown.conceptQName, maxMembers: MAX_MEMBERS_PER_AXIS });
      if (resolved.members.length === 0) {
        findings.push(`breakdown for row "${row.rowId}" found no facts for ${breakdown.axisQName}/${breakdown.conceptQName}`);
        continue;
      }
      const axisSlug = slug(breakdown.axisQName, /axis$/i);
      for (const member of resolved.members) {
        breakdownRows.push({ rowId: `${row.rowId}.${axisSlug}.${slug(member.memberQName, /member$/i)}`,
          parentRowId: row.rowId, axisQName: breakdown.axisQName, memberQName: member.memberQName,
          label: member.memberLabel, unit: resolved.unit, values: member.values, rationale: breakdown.rationale });
      }
    }
  }
  if (breakdownRows.length > MAX_BREAKDOWN_ROWS) {
    findings.push(`breakdown rows exceed ${MAX_BREAKDOWN_ROWS}; truncated`);
    breakdownRows.length = MAX_BREAKDOWN_ROWS;
  }
  return { breakdownRows, findings };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/dimensionInventory.test.ts`
Expected: PASS（7 tests）。另跑 `node ... --test src/infra/xbrl/__tests__/unifiedStatements.test.ts` 确认类型追加没破坏现有测试。

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add src/infra/xbrl/dimensionInventory.ts src/infra/xbrl/unifiedStatements.ts src/infra/xbrl/__tests__/dimensionInventory.test.ts
```

---

### Task 3: store 读取口 + 两个渐进式披露工具

**Files:**
- Modify: `src/infra/xbrl/filingTableStore.ts`（接口 + 两个实现加 `getRunTables`）
- Modify: `mcp_tools/financial-model/mappingSubagentTools.ts`
- Test: `mcp_tools/financial-model/__tests__/mappingSubagentTools.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `buildAxisCatalog` / `buildAxisBreakdown`；`SourceReviewArtifact.ingestionRunId`。
- Produces:

```ts
// filingTableStore.ts 接口追加：
getRunTables(runId: string): FilingTable[];
// InMemory 实现：return [...this.run(runId).tables.values()].map(t => structuredClone(t) as FilingTable);
// Sqlite 实现：return this.tables(runId);   （私有 tables() 已存在）

// mappingSubagentTools.ts：
export type MappingSubagentDeps = {
  modelStore: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>;
  sourceReviewStore: SourceReviewStore;
  ownerAgentId: string;
  /** 缺席时不注册维度探索工具（老调用方 / 测试不受影响）。 */
  tableStore?: FilingTableStore;
};
// createStatementUnificationTools 返回的 tools Map 在 tableStore 存在时含三个工具：
//   load_concept_inventory（现有，不变）
//   list_dimension_axes    input {symbol} → { symbol, axes: AxisCatalogEntry[] }
//   get_axis_breakdown     input {symbol, axisQName, conceptQName} → AxisBreakdown & { symbol }
```

两个新工具都走现有 `resolveModel`，再 `sourceReviewStore.get(modelId)` 取 `ingestionRunId` 与 `statementViews.income_statement.candidate.periods`（requestedPeriods），`tableStore.getRunTables(ingestionRunId)` 取表。新工具不设置 `loaded`（宿主的 wrongIssuer 校验仍以 `load_concept_inventory` 为准）。

- [ ] **Step 1: 写失败测试（追加到现有测试文件，复用其现有 fixture/store 搭建方式）**

现有测试文件已经构造了 modelStore / sourceReviewStore 和 sourceReview fixture；照同样方式把 `ingestionRunId` 写进 sourceReview，用 `InMemoryFilingTableStore` `saveTables("ing-1", [table])`（table fixture 抄 Task 1 测试里的 `table()`/`dimFact()` 辅助，或提到共享 fixture）：

```ts
test("list_dimension_axes returns the axis catalog for the resolved run", () => {
  const tableStore = new InMemoryFilingTableStore();
  tableStore.saveTables("ing-1", [/* 一张含 SEG 轴两个 member 的表 */]);
  const { tools } = createStatementUnificationTools({ modelStore, sourceReviewStore, ownerAgentId: "agent-1", tableStore });
  const result = tools.get("list_dimension_axes")!.execute({ symbol: "TST" }) as { axes: Array<{ axisQName: string }> };
  assert.equal(result.axes.length, 1);
  assert.equal(result.axes[0]!.axisQName, "us-gaap:StatementBusinessSegmentsAxis");
});

test("get_axis_breakdown returns member series", () => {
  /* 同上搭建 */
  const result = tools.get("get_axis_breakdown")!.execute({ symbol: "TST",
    axisQName: "us-gaap:StatementBusinessSegmentsAxis", conceptQName: REV }) as { members: unknown[] };
  assert.equal(result.members.length, 2);
});

test("dimension tools are absent without a tableStore", () => {
  const { tools } = createStatementUnificationTools({ modelStore, sourceReviewStore, ownerAgentId: "agent-1" });
  assert.equal(tools.has("list_dimension_axes"), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test mcp_tools/financial-model/__tests__/mappingSubagentTools.test.ts`
Expected: FAIL — 未知工具名 / deps 类型不符

- [ ] **Step 3: 实现**

`filingTableStore.ts` 加 `getRunTables`（两实现各一行，如上）。`mappingSubagentTools.ts`：

```ts
const AXIS_INPUT: JsonSchema = { type: "object", additionalProperties: false, required: ["symbol", "axisQName", "conceptQName"],
  properties: { symbol: { type: "string" }, axisQName: { type: "string" }, conceptQName: { type: "string" } } };

function runContext(deps: MappingSubagentDeps, raw: JsonObject, schema: JsonSchema) {
  const { modelId, symbol } = resolveModel(deps, raw, schema);
  const review = deps.sourceReviewStore.get(modelId);
  if (!review) throw new Error(`no source review stored for ${symbol}`);
  return { symbol, review,
    tables: deps.tableStore!.getRunTables(review.ingestionRunId),
    requestedPeriods: review.statementViews.income_statement.candidate.periods };
}
```

在 `createStatementUnificationTools` 内，`deps.tableStore` 存在时往 Map 追加：

```ts
const axesTool: LoopTool = { name: "list_dimension_axes", category: "non_trading",
  description: "List every XBRL dimension axis present in one ticker's extracted filings, with member counts and top concepts.",
  inputSchema: SYMBOL_INPUT,
  execute(raw) { const c = runContext(deps, raw, this.inputSchema);
    return { symbol: c.symbol, axes: buildAxisCatalog({ tables: c.tables, requestedPeriods: c.requestedPeriods }) } as unknown as JsonValue; } };
const breakdownTool: LoopTool = { name: "get_axis_breakdown", category: "non_trading",
  description: "Member-level values for one axis and concept, resolved latest-filing-wins.",
  inputSchema: AXIS_INPUT,
  execute(raw) { const c = runContext(deps, raw, this.inputSchema);
    return { symbol: c.symbol, ...buildAxisBreakdown({ tables: c.tables, requestedPeriods: c.requestedPeriods,
      axisQName: String(raw["axisQName"]), conceptQName: String(raw["conceptQName"]) }) } as unknown as JsonValue; } };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test mcp_tools/financial-model/__tests__/mappingSubagentTools.test.ts`
Expected: PASS。另跑 `npm test` 确认 store 接口追加没破坏别处（InMemory/Sqlite 的其他消费者）。

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add src/infra/xbrl/filingTableStore.ts mcp_tools/financial-model/mappingSubagentTools.ts mcp_tools/financial-model/__tests__/mappingSubagentTools.test.ts
```

---

### Task 4: 维度探索 loop `exploreDimensions`

**Files:**
- Create: `src/agent/financial-modeling/dimensionExploration.ts`
- Modify: `src/agent/prompts/dcfSubagentPrompts.ts`（新增 `exploreInstruction`）
- Test: `src/agent/financial-modeling/__tests__/dimensionExploration.test.ts`

**Interfaces:**
- Consumes: `LoopTool`、`ModelRouter`（fake 写法参考 `src/agent/financial-modeling/__tests__/loadWorkingSet.test.ts` 里的 router stub）。
- Produces:

```ts
export const MAX_EXPLORATION_STEPS = 8;
/** 返回 digest：agent 每次 get_axis_breakdown 拉到的结果原文拼接，供 decision 阶段引用；没探索则为 ""。 */
export function exploreDimensions(input: { modelRouter: ModelRouter; subagent: string;
  systemPrompt: string; task: string; tools: Map<string, LoopTool>;
  maxSteps?: number }): Promise<{ digest: string }>;
```

协议：system = `systemPrompt + "\n\n" + exploreInstruction(toolNames)`；user = `[ORCHESTRATOR INSTRUCTION]\n${task}`。每轮模型输出一个 JSON：`{"tool":"list_dimension_axes"|"get_axis_breakdown","input":{...}}` 或 `{"done":true}`。宿主执行工具、把 `[TOOL RESULT <name>]\n<json>` 追加为 user 消息继续；工具抛错时把错误文本追加继续（消耗一步）。到 `done` 或步数用尽为止。digest 只收 `get_axis_breakdown` 的结果（`list_dimension_axes` 是导航，不进 decision 上下文）。工具执行失败或 JSON 不合法均不中断整个 run——探索是增强，不是前置条件。

`dcfSubagentPrompts.ts` 追加：

```ts
export const exploreInstruction = (toolNames: readonly string[]) =>
  `DIMENSION EXPLORATION. You may now discover segment/product/geography breakdowns for this issuer.
Available tools: ${toolNames.join(", ")}. Each turn return EXACTLY one JSON object and nothing else:
either {"tool":"<name>","input":{...}} or {"done":true}.
Start with list_dimension_axes. Fetch a breakdown ONLY for an axis that disaggregates a real driver of
this issuer's economics — revenue by product/segment/geography, segment operating income, and the like.
Fair-value levels, share-based-compensation buckets, debt instruments and similar disclosure mechanics
are never useful here. Fetch at most 3 axes per statement line you intend to break down. When you have
what you need — or nothing useful exists — return {"done":true}.`;
```

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { exploreDimensions } from "../dimensionExploration.ts";
import type { LoopTool } from "../../../mcp_tools/financial-model/mappingSubagentTools.ts";

const scripted = (responses: string[]) => ({
  async generate() { return { text: responses.shift() ?? '{"done":true}', metrics: { tokens_in: 0, tokens_out: 0 } }; },
}) as never; // 与 loadWorkingSet.test.ts 的 stub 同款；以那边的实际写法为准

const tool = (name: string, result: unknown, calls: unknown[]): LoopTool => ({
  name, category: "non_trading", description: name,
  inputSchema: { type: "object", additionalProperties: true, properties: {} },
  execute(input) { calls.push(input); return result as never; } });

test("explores axes then breakdowns and returns their digest", async () => {
  const calls: unknown[] = [];
  const tools = new Map([
    ["list_dimension_axes", tool("list_dimension_axes", { axes: [{ axisQName: "seg" }] }, calls)],
    ["get_axis_breakdown", tool("get_axis_breakdown", { members: [{ memberQName: "x:A" }] }, calls)],
  ]);
  const { digest } = await exploreDimensions({ modelRouter: scripted([
    '{"tool":"list_dimension_axes","input":{"symbol":"TST"}}',
    '{"tool":"get_axis_breakdown","input":{"symbol":"TST","axisQName":"seg","conceptQName":"rev"}}',
    '{"done":true}',
  ]), subagent: "statement_unification", systemPrompt: "sys", task: "unify TST", tools });
  assert.equal(calls.length, 2);
  assert.match(digest, /x:A/);
  assert.doesNotMatch(digest, /"axes"/); // 目录不进 digest
});

test("stops at maxSteps and survives tool errors", async () => {
  const calls: unknown[] = [];
  const throwing: LoopTool = { ...tool("list_dimension_axes", {}, calls),
    execute() { throw new Error("boom"); } };
  const { digest } = await exploreDimensions({ modelRouter: scripted([
    '{"tool":"list_dimension_axes","input":{"symbol":"TST"}}',
    '{"tool":"list_dimension_axes","input":{"symbol":"TST"}}',
  ]), subagent: "statement_unification", systemPrompt: "sys", task: "unify TST",
    tools: new Map([["list_dimension_axes", throwing]]), maxSteps: 2 });
  assert.equal(digest, "");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/dimensionExploration.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `dimensionExploration.ts`**

```ts
import type { LoopTool } from "../../../mcp_tools/financial-model/mappingSubagentTools.ts";
import type { LlmMessage, ModelRouter } from "../../infra/llm/provider.ts";
import { exploreInstruction } from "../prompts/dcfSubagentPrompts.ts";
import { createLogger } from "../../infra/logger/logger.ts";

const log = createLogger("dimension_exploration");
export const MAX_EXPLORATION_STEPS = 8;

export async function exploreDimensions(input: { modelRouter: ModelRouter; subagent: string;
  systemPrompt: string; task: string; tools: Map<string, LoopTool>; maxSteps?: number }): Promise<{ digest: string }> {
  const maxSteps = input.maxSteps ?? MAX_EXPLORATION_STEPS;
  const messages: LlmMessage[] = [
    { role: "system", content: `${input.systemPrompt}\n\n${exploreInstruction([...input.tools.keys()])}` },
    { role: "user", content: `[ORCHESTRATOR INSTRUCTION]\n${input.task}` },
  ];
  const fetched: string[] = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    const completion = await input.modelRouter.generate(messages,
      { modelClass: "MEDIUM", temperature: 0, metadata: { mode: "dcf_subagent", subagent: input.subagent, phase: "explore" } });
    messages.push({ role: "assistant", content: completion.text });
    const start = completion.text.indexOf("{"); const end = completion.text.lastIndexOf("}");
    let feedback: string;
    try {
      if (start < 0 || end < start) throw new Error("expected one JSON object");
      const parsed = JSON.parse(completion.text.slice(start, end + 1)) as { done?: boolean; tool?: string; input?: object };
      if (parsed.done === true) break;
      const tool = parsed.tool !== undefined ? input.tools.get(parsed.tool) : undefined;
      if (!tool) throw new Error(`unknown tool: ${String(parsed.tool)}`);
      const result = JSON.stringify(tool.execute((parsed.input ?? {}) as never));
      if (tool.name === "get_axis_breakdown") fetched.push(result);
      feedback = `[TOOL RESULT ${tool.name}]\n${result}`;
    } catch (error) {
      // 探索是增强不是前置条件：错误喂回去让它改，或它自己 done。
      feedback = `[EXPLORATION ERROR]\n${error instanceof Error ? error.message : String(error)}`;
    }
    messages.push({ role: "user", content: feedback });
  }
  log.info(`exploration fetched ${fetched.length} breakdown(s)`);
  return { digest: fetched.join("\n") };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/dimensionExploration.test.ts`
Expected: PASS

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add src/agent/financial-modeling/dimensionExploration.ts src/agent/prompts/dcfSubagentPrompts.ts src/agent/financial-modeling/__tests__/dimensionExploration.test.ts
```

---

### Task 5: unification agent 接线 — 探索、decision schema、物化、prompt

**Files:**
- Modify: `src/agent/financial-modeling/statementUnificationAgent.ts`
- Modify: `src/agent/prompts/dcfSubagentPrompts.ts`（`statementUnificationPrompt` 加 breakdown 段、envelope 提及）
- Test: `src/agent/financial-modeling/__tests__/statementUnificationAgent.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 `materializeBreakdowns`、Task 4 `exploreDimensions`。
- Produces: `runStatementUnificationAgent` 入参追加 `tables?: readonly FilingTable[]`（缺省 `[]`）；返回的 `artifact.breakdownRows` 在有声明时非空。

接线逻辑（都在 `runStatementUnificationAgent` 内）：
1. `loadWorkingSet` 之后：若 `input.tools.has("list_dimension_axes")` 且 `(input.tables ?? []).length > 0`，调 `exploreDimensions`（同 tools、同 task），拿 `digest`；否则 `digest = ""`。
2. `ROW` schema 的 `properties` 追加：

```ts
breakdowns: { type: "array", items: { type: "object", additionalProperties: false,
  required: ["axisQName", "conceptQName", "rationale"],
  properties: { axisQName: { type: "string" }, conceptQName: { type: "string" }, rationale: { type: "string" } } } },
```

3. `context()` 追加参数 `digest: string`，非空时在末尾拼 `\n\n[DIMENSION BREAKDOWNS EXPLORED]\n${digest}`（decision 与 patch 两处都传）。
4. 每轮 `buildUnifiedStatements` 之后：`const bd = materializeBreakdowns({ decision, tables: input.tables ?? [], requestedPeriods: input.requestedPeriods });` findings 合并 `[...completeness, ...artifact.findings, ...bd.findings]`；`last.artifact = { ...artifact, breakdownRows: bd.breakdownRows, unresolvedFindings: findings }`。

`statementUnificationPrompt` 追加一段（放在 Rules 之后、Output 之前）：

```
DIMENSION BREAKDOWNS. Before deciding you explored the issuer's dimension axes; the breakdowns you fetched
are shown under [DIMENSION BREAKDOWNS EXPLORED]. Attach to a row at most 3 "breakdowns" entries
({axisQName, conceptQName, rationale}) for axes whose members disaggregate that row into real economic
drivers — revenue by product/segment/geography and the like. Code resolves the member values; you never
copy them. A breakdown is supplementary: it never changes the row's own components or total. Declare only
axes you actually saw in exploration, with the conceptQName the members were reported under.
```

`statementUnificationEnvelope` 里的 `{"rows":[...],"notes":"..."}` 描述保持不变（breakdowns 是 rows 内字段，schema 校验管它）。

- [ ] **Step 1: 写失败测试（追加）**

照现有测试文件的 scripted-router 写法（该文件已有 loadWorkingSet + decision 的脚本序列；新增用例给 router 多排一段探索脚本）：

```ts
test("materializes breakdown rows the decision declares", async () => {
  // 脚本顺序：load → explore（直接 {"done":true}）→ decision（rows[0] 带 breakdowns）
  // tools：现有 fixture 的 load_concept_inventory + Task 3 的两个工具（或最少 list_dimension_axes 占位，让探索分支开启）
  // input.tables：一张含 SEG 轴 Products/Services 两个 member 的表（fixture 同 Task 1）
  const run = await runStatementUnificationAgent({ /* ...现有搭建... */ tables: [segTable] });
  const rows = run.artifact.breakdownRows ?? [];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.parentRowId, "net_sales");
});

test("breakdown findings feed the correction loop", async () => {
  // decision 声明一个 store 里不存在的 (axis, concept)；maxRuns=1 → unresolvedFindings 含 "no facts"
  const run = await runStatementUnificationAgent({ /* ... */ maxRuns: 1, tables: [segTable] });
  assert.ok(run.artifact.unresolvedFindings.some((f) => f.includes("no facts")));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/statementUnificationAgent.test.ts`
Expected: 新增两条 FAIL（`tables` 未知参数 / breakdowns 被 schema 拒绝），存量用例 PASS

- [ ] **Step 3: 实现（按上面接线逻辑 1–4 + prompt 追加）**

- [ ] **Step 4: 运行确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/financial-modeling/__tests__/statementUnificationAgent.test.ts`
Expected: 全部 PASS（存量 + 新增）

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add src/agent/financial-modeling/statementUnificationAgent.ts src/agent/prompts/dcfSubagentPrompts.ts src/agent/financial-modeling/__tests__/statementUnificationAgent.test.ts
```

---

### Task 6: spine_mapping — breakdown 上下文、机械防双计、事实物化

**Files:**
- Modify: `src/infra/xbrl/spineFromUnified.ts`
- Modify: `src/agent/financial-modeling/spineMappingAgent.ts`（context 序列化）
- Modify: `src/agent/prompts/dcfSubagentPrompts.ts`（`spineMappingPrompt` 加规则）
- Test: `src/infra/xbrl/__tests__/spineFromUnified.test.ts`（追加；文件已存在则追加，不存在则查 `src/infra/xbrl/__tests__/` 下实际测试文件名再追加）

**Interfaces:**
- Consumes: `UnifiedStatementsArtifact.breakdownRows`（Task 2）。
- Produces: 行为变化，签名不变——`checkSpineCompleteness` / `buildSpineFromUnified` 读 `input.unified.breakdownRows ?? []`。

规则（全部机械、host 侧）：
1. `checkSpineCompleteness`：
   - `knownRows` 并入 breakdown rowIds（detailRows 可以引用它们）。
   - breakdown rowId 出现在任何 `mappings[].rowIds` → finding `breakdown row "X" may only be used as a detailRow, never in a spine mapping`（防双计：总数已由父行的 dimensionless 事实供给）。
   - "每个 unified row 必须落位"的既有循环**不含** breakdown 行（它们是可选补充，不落位不是 finding）。
   - revenue 单轴规则：`parentTargetId === "revenue" || parentTargetId.startsWith("revenue.")` 的 detailRows 中，属于 breakdown 的行若跨 >1 个 `axisQName` → finding `revenue streams must come from a single axis; found <a1> and <a2>`（revenue 下的 detail 会变成可被求和的 stream，两条轴并存必然双计；其他父行的 detail 是纯补充行，允许混轴）。
2. `buildSpineFromUnified`：`rowsById` 构建改为并集——unified rows 照旧，breakdown 行映射为 `{ statement: undefined, unit: row.unit, values: row.values }`；`materialize` 内：
   - fact 溯源查找 `unifiedFacts.get(...)` 仅在 `row.statement` 存在时进行（breakdown 行无 unified fact，`sourceRefs` 为空即可）；
   - unit 回退链改为 `sourceFacts[0]?.unit ?? rowUnit ?? { kind: "number" }`（`rowUnit` 取自 contributing 行的存储 unit）。

`spineMappingPrompt` 追加一条规则：

```
- BREAKDOWN rows (rowId shaped parent.axis.member, listed after the unified rows with their axis) are
  dimensional slices of their parent row. Use them ONLY as detailRows; never inside a mapping — the
  parent already supplies the total, and mapping a slice would count the money twice. Under revenue,
  pick ONE axis (the one that best explains the top line) and add its members as detailRows; members
  of the other axes stay unused, which is fine. They are exempt from the "every row must land
  somewhere" rule.
```

`spineMappingAgent.ts` 的 `context()`：`[UNIFIED STATEMENTS]` 的 JSON 里追加 `breakdownRows: (unified.breakdownRows ?? []).map(({ rowId, parentRowId, axisQName, label, values }) => ({ rowId, parentRowId, axisQName, label, values }))`。

- [ ] **Step 1: 写失败测试（追加到 spineFromUnified 的现有测试文件，复用其 unified fixture 构造方式）**

```ts
test("breakdown rows are rejected inside mappings", () => {
  const unified = unifiedFixture(/* rows: net_sales */);
  unified.breakdownRows = [{ rowId: "net_sales.seg.a", parentRowId: "net_sales", axisQName: "seg",
    memberQName: "x:AMember", label: "A", unit: null, values: { FY2025: 1 }, rationale: "r" }];
  const findings = checkSpineCompleteness({ unified, decision: { mappings: [
    { targetId: "revenue.total", rowIds: ["net_sales", "net_sales.seg.a"], rationale: "r" }],
    detailRows: [], excluded: [], spineGaps: [] }, spineIds: new Set(["revenue.total"]) });
  assert.ok(findings.some((f) => f.includes("only be used as a detailRow")));
});

test("revenue detail rows from two axes raise a finding", () => {
  /* breakdownRows 两条，axisQName 各异，均作 parentTargetId "revenue" 的 detailRows */
  assert.ok(findings.some((f) => f.includes("single axis")));
});

test("a breakdown detailRow materializes staged facts from its stored values", () => {
  const result = buildSpineFromUnified({ decision: { mappings: [{ targetId: "revenue.total", rowIds: ["net_sales"], rationale: "r" }],
    detailRows: [{ parentTargetId: "revenue", rowId: "net_sales.seg.a", rationale: "r" }],
    excluded: [], spineGaps: [] }, unified, spineIds: new Set(["revenue.total"]) });
  const detail = result.facts.find((f) => f.lineItemId === "revenue.net_sales_seg_a");
  assert.ok(detail);
  assert.equal(detail!.value, 1);
});

test("unplaced breakdown rows are not findings", () => {
  /* breakdownRows 存在但 decision 不引用；checkSpineCompleteness 不因此报 unplaced */
});
```

（`detailLineItemId("revenue", "net_sales.seg.a")` 现有 slug 规则产出 `revenue.net_sales_seg_a`——测试按现实现断言。）

- [ ] **Step 2: 运行确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/infra/xbrl/__tests__/spineFromUnified.test.ts`
Expected: 新增用例 FAIL，存量 PASS

- [ ] **Step 3: 实现（规则 1、2 + 两处 prompt/context 修改）**

- [ ] **Step 4: 运行确认通过**

Run: 同上 + `node ... --test src/agent/financial-modeling/__tests__/spineMappingAgent.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add src/infra/xbrl/spineFromUnified.ts src/agent/financial-modeling/spineMappingAgent.ts src/agent/prompts/dcfSubagentPrompts.ts src/infra/xbrl/__tests__/spineFromUnified.test.ts
```

---

### Task 7: dcfSubagentTool 与 deps 接线 + 汇报计数

**Files:**
- Modify: `mcp_tools/financial-model/financialModelTools.ts`（deps 类型 + defaults）
- Modify: `mcp_tools/financial-model/dcfSubagentTool.ts`
- Test: `mcp_tools/financial-model/__tests__/financialModelTools.test.ts` 或该目录下覆盖 dcfSubagentTool 的现有测试文件（先看 `run_dcf_subagent` 的现有用例在哪个文件，追加到那里）

**Interfaces:**
- Consumes: Task 3 的 `MappingSubagentDeps.tableStore` / `getRunTables`；Task 5 的 `runStatementUnificationAgent({ tables })`。
- Produces:

```ts
// financialModelTools.ts:
export type FinancialModelToolDeps = { /* 现有字段… */
  /** 维度探索的数据源；缺席时 statement_unification 不做 breakdown。 */
  tableStore?: FilingTableStore };
// getDefaultFinancialModelToolDeps(): defaults 增加
//   tableStore: SqliteFilingTableStore.open(databasePath),
```

`dcfSubagentTool.ts` 的 statement_unification 分支：
- `createStatementUnificationTools({...现有, ...(deps.financial.tableStore ? { tableStore: deps.financial.tableStore } : {}) })`
- `runStatementUnificationAgent({ ...现有, tables: deps.financial.tableStore?.getRunTables(sourceReview.ingestionRunId) ?? [] })`
- 汇报 summary 追加计数：在现有 `[income_statement 40, ...]` 之后拼 `${(run.artifact.breakdownRows ?? []).length === 0 ? "" : `, ${(run.artifact.breakdownRows ?? []).length} breakdown row(s) on ${new Set((run.artifact.breakdownRows ?? []).map((r) => r.axisQName)).size} axis/axes`}`
- `generation_context.data.unifiedStatements` 增加 `breakdownRows: (run.artifact.breakdownRows ?? []).length`。

- [ ] **Step 1: 写失败测试**

在现有 run_dcf_subagent 的 statement_unification 用例基础上（它已 stub 了 modelRouter 与 stores）：注入 `InMemoryFilingTableStore`（saveTables 到 sourceReview 的 ingestionRunId 下）+ 让 stub 的 unification run 返回带 2 条 breakdownRows 的 artifact，断言：

```ts
assert.match(result.summary, /2 breakdown row\(s\)/);
const data = result.generation_context!.data as { unifiedStatements: { breakdownRows: number } };
assert.equal(data.unifiedStatements.breakdownRows, 2);
```

再加一条：deps 无 tableStore 时行为不变（summary 无 breakdown 字样）。

- [ ] **Step 2: 运行确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test <该测试文件>`
Expected: 新增用例 FAIL

- [ ] **Step 3: 实现（上述三处接线 + defaults）**

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 5: 暂存（不 commit）**

```bash
git add mcp_tools/financial-model/financialModelTools.ts mcp_tools/financial-model/dcfSubagentTool.ts mcp_tools/financial-model/__tests__/
```

---

### Task 8: 编排 agent prompt 提示 + 顺手修一处过时表述

**Files:**
- Modify: `src/agent/prompts/subagentPrompts.ts`（`financialModelingSubagentPrompt`）

无需测试（纯 prompt 文本），但改完跑 `npm test` 确认没有 prompt 快照类断言被牵动。

- [ ] **Step 1: 两处文本修改**

1. 第 71 行 `which leaves the workbook holding source rows and no spine` → `which leaves the workbook holding the period grid and no facts yet`（修正 Task 前就存在的过时表述：新路径下 create_financial_model 不再产生 source rows）。
2. statement_unification 介绍句（第 73 行）追加：`It also explores the issuer's XBRL dimension axes and attaches segment/product/geography breakdown rows to the lines they disaggregate; spine_mapping can then stage them as revenue streams or detail rows, so ask for segment detail there rather than pasting it into a task.`

- [ ] **Step 2: 运行全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: 暂存（不 commit）**

```bash
git add src/agent/prompts/subagentPrompts.ts
```

---

## Self-Review 记录

- **覆盖**：渐进式披露工具（Task 3）、探索 loop（Task 4）、第二步标记到父行（Task 2/5 的 `breakdowns`→`breakdownRows`，`parentRowId` 即"对应大科目行"）、第三步 map 进 DCF（Task 6 detailRows→streams）、用户改的上限（≤3 轴/父行、150 行全模型、25 member/轴，Global Constraints + Task 2 常量）、防双计（Task 6 规则 1）、revenue 单轴（Task 6）、编排层可见性（Task 7 计数、Task 8 prompt）。
- **类型一致性**：`AxisCatalogEntry`/`AxisBreakdown`/`BreakdownRow`/`materializeBreakdowns`/`exploreDimensions`/`getRunTables`/`tables?` 各任务间名称与形参已核对一致。
- **已知留白（有意不做）**：脚注表的 role 级放宽（数据已在 tableStore，无需）；breakdown 的 members-vs-total 残差核对（reconciling item 使其天然不闭合，本期只透传不校验，后续可加信息性 `breakdownChecks`）；`statementExtractionTool` 自开 tableStore 与 deps.tableStore 的合并（同一 DB 文件，行为等价，不动）。
