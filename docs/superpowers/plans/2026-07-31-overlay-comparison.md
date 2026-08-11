# 叠加对比图实施计划（第二阶段 2b）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 能生成归一化的多标的叠加对比图，图直接成为 tab；任何 tab 都能拖出来变成浮动窗以便并排对照。

**Architecture:** 叠加图是**规格**不是数据（`{symbols, range, normalize}`，前端自己取 bar 再算），所以图永远是活的。`topic_charts` 加一列 `kind` 显式区分「一个标的」和「一次叠加」，排序仍在一张表里。浮动是 **tab 的属性**，不是叠加图的属性 —— 拖出 tab 条即分离，任何 tab 都适用。

**Tech Stack:** Node 23（`--experimental-strip-types`、`--experimental-sqlite`）、`node:test` + `node:assert/strict`、React 19、TanStack Query v5、Tailwind、pnpm。

## Global Constraints

- **规格文档**：`docs/superpowers/specs/2026-07-31-overlay-comparison-design.md`。每个任务以它为准。
- **不要提交。** 只改代码、跑测试，改动留在工作区。禁止 `git add` / `commit` / `stash` / `checkout` / `reset`（删文件用 `rm`）。
- **不做逐任务审查。** 全部任务完成后统一测试。
- **现有 agent 一行不改。** `src/framework/orchestrator.ts`、`dispatcher.ts`、`subagent.ts`、`contextCompaction.ts`、`src/agent/prompts/`、`src/agent/subagents/` 全部原样。看起来必须改就停下报 BLOCKED。
- **不写迁移**（demo 阶段）。schema 直接改 `CREATE TABLE`，本地开发库删掉重建。
- 测试运行器只有根 `pnpm test`。**客户端没有 React 测试运行器** —— 可测逻辑必须在 `client/src/lib/` 或 `src/` 下的纯函数里。
- 相对导入**必须带 `.ts` 后缀**。SQLite 测试用 `SqliteEventStore.open(":memory:")`。
- **所有代码英文**：注释、doc comment、测试名、prompt。用户可见文案走 i18n，`en.ts` 与 `zh-CN.ts` 必须同步。
- 设计 token：`text-label-1..4`、`bg-fill-1..3`、`border-sep`、`fin-label`、`fin-figure`、`material`、`shadow-e2-rim`；禁止裸数值与 `white/N`、`black/N`、`slate-N`、`gray-N`。
- 基线：**241 测试通过**，`pnpm build`、`pnpm build:client`、`client tsc --noEmit` 全清。

---

## 文件结构

**新建**
- `client/src/lib/overlayNormalize.ts` — 归一化与对齐（纯函数，本阶段正确性核心）
- `client/src/lib/__tests__/overlayNormalize.test.ts`
- `client/src/components/OverlayChart.tsx`
- `client/src/components/workspace/FloatingChart.tsx` — 分离出去的 tab 的浮动容器
- `client/src/hooks/useDetachedTabs.ts`

**修改**
- `src/infra/db/sqliteEventStore.ts` — `topic_charts` 加 `kind`/`overlay`，主键改造
- `src/infra/db/__tests__/topicStore.test.ts`
- `src/server/server.ts` — 图表偏好按 `kind` 分别校验
- `src/agent/research/tools.ts`、`researchPrompt.ts` — `overlay` 与 `edit_overlay`
- `client/src/types/core.ts` — `TopicChartPreference` 改为可辨识联合
- `client/src/lib/chartWorkspace.ts` + 测试 — `stock_overlay` 解析
- `client/src/lib/topicCharts.ts` + 测试 — 叠加 tab 不参与推导匹配
- `client/src/hooks/useTopicCharts.ts`、`client/src/components/workspace/ChartPane.tsx`、`ChartTabBar.tsx`
- 两个 locale 文件

---

## Task 1: 归一化与对齐（纯函数）

**这是本阶段正确性最集中的地方。**叠加图最容易出的错都在这里，而且错得隐蔽 ——
一条线凭空多出一截涨幅，看图的人不会察觉。

**Files:**
- Create: `client/src/lib/overlayNormalize.ts`
- Create: `client/src/lib/__tests__/overlayNormalize.test.ts`

**Interfaces:**
- Produces:
  - `type Bar = { t: string; c: number }`
  - `type SeriesInput = { symbol: string; bars: Bar[] }`
  - `type NormalizeMode = "pct" | "index100"`
  - `type NormalizedSeries = { symbol: string; points: Array<{ t: string; v: number }>; baseDate: string; baseValue: number }`
  - `type OverlayResult = { series: NormalizedSeries[]; axis: string[]; dropped: string[] }`
  - `normalizeOverlay(inputs: SeriesInput[], mode: NormalizeMode, visibleFrom?: string): OverlayResult`

- [ ] **Step 1: 写失败的测试**

Create `client/src/lib/__tests__/overlayNormalize.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOverlay, type SeriesInput } from "../overlayNormalize.ts";

const series = (symbol: string, pairs: Array<[string, number]>): SeriesInput =>
  ({ symbol, bars: pairs.map(([t, c]) => ({ t, c })) });

test("pct expresses each line as percent change from its base", () => {
  const result = normalizeOverlay(
    [series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110]])],
    "pct",
  );
  assert.deepEqual(result.series[0]?.points.map((p) => p.v), [0, 10]);
});

test("index100 rebases to 100 and is a linear transform of pct", () => {
  const bars: Array<[string, number]> = [["2026-01-01", 100], ["2026-01-02", 110]];
  const pct = normalizeOverlay([series("AAPL", bars)], "pct").series[0]!;
  const idx = normalizeOverlay([series("AAPL", bars)], "index100").series[0]!;
  assert.deepEqual(idx.points.map((p) => p.v), [100, 110]);
  idx.points.forEach((point, i) => {
    assert.ok(Math.abs(point.v - (pct.points[i]!.v + 100)) < 1e-9);
  });
});

test("the axis is the intersection of the inputs, never a union", () => {
  const result = normalizeOverlay(
    [
      series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110], ["2026-01-03", 120]]),
      series("NVDA", [["2026-01-02", 50], ["2026-01-03", 55]]),
    ],
    "pct",
  );
  // 2026-01-01 is missing from NVDA, so it is not on the axis at all.
  assert.deepEqual(result.axis, ["2026-01-02", "2026-01-03"]);
  assert.equal(result.series.every((s) => s.points.length === 2), true);
});

test("no interpolation: a gap inside one series shrinks the axis", () => {
  const result = normalizeOverlay(
    [
      series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110], ["2026-01-03", 120]]),
      series("NVDA", [["2026-01-01", 50], ["2026-01-03", 55]]),
    ],
    "pct",
  );
  // NVDA did not trade on the 2nd. Inventing a point for it would be fabricating data.
  assert.deepEqual(result.axis, ["2026-01-01", "2026-01-03"]);
});

test("a symbol listed later than the others keeps its OWN base date", () => {
  const result = normalizeOverlay(
    [
      series("AAPL", [["2026-01-01", 100], ["2026-02-01", 150]]),
      series("IPO", [["2026-02-01", 20]]),
    ],
    "pct",
  );
  const ipo = result.series.find((s) => s.symbol === "IPO");
  assert.equal(ipo?.baseDate, "2026-02-01");
  assert.deepEqual(ipo?.points.map((p) => p.v), [0], "starting it at someone else's base would invent a gain it never had");
});

test("the base follows the visible window", () => {
  const bars: Array<[string, number]> = [
    ["2026-01-01", 100], ["2026-02-01", 150], ["2026-03-01", 180],
  ];
  const zoomed = normalizeOverlay([series("AAPL", bars)], "pct", "2026-02-01");
  assert.equal(zoomed.series[0]?.baseDate, "2026-02-01");
  assert.deepEqual(zoomed.series[0]?.points.map((p) => Math.round(p.v)), [0, 20]);
});

test("a visibleFrom past every bar falls back to the full range rather than emptying the chart", () => {
  const result = normalizeOverlay(
    [series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110]])],
    "pct",
    "2030-01-01",
  );
  assert.equal(result.axis.length, 2);
});

test("a symbol with no bars at all is dropped and named", () => {
  const result = normalizeOverlay(
    [series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110]]), series("DEAD", [])],
    "pct",
  );
  assert.deepEqual(result.series.map((s) => s.symbol), ["AAPL"]);
  assert.deepEqual(result.dropped, ["DEAD"]);
});

test("fewer than two overlapping points yields no series rather than a misleading flat line", () => {
  const result = normalizeOverlay(
    [
      series("AAPL", [["2026-01-01", 100]]),
      series("NVDA", [["2026-01-01", 50]]),
    ],
    "pct",
  );
  assert.deepEqual(result.series, []);
  assert.deepEqual(result.axis, []);
});

test("a zero base is dropped rather than dividing by zero", () => {
  const result = normalizeOverlay(
    [series("AAPL", [["2026-01-01", 0], ["2026-01-02", 10]]), series("NVDA", [["2026-01-01", 50], ["2026-01-02", 55]])],
    "pct",
  );
  assert.deepEqual(result.series.map((s) => s.symbol), ["NVDA"]);
  assert.deepEqual(result.dropped, ["AAPL"]);
});

test("input order is preserved in the output", () => {
  const result = normalizeOverlay(
    [
      series("NVDA", [["2026-01-01", 50], ["2026-01-02", 55]]),
      series("AAPL", [["2026-01-01", 100], ["2026-01-02", 110]]),
    ],
    "pct",
  );
  assert.deepEqual(result.series.map((s) => s.symbol), ["NVDA", "AAPL"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A3 overlayNormalize | head -20`
Expected: FAIL — 找不到 `../overlayNormalize.ts`

- [ ] **Step 3: 实现**

要点，每一条都对应上面一个测试：

- **交集，不插值。**先求所有输入时间戳的交集作为 `axis`；某标的在某天没数据就整天不上轴。
  插出来的点是编造的数据。
- **上市晚于起点的标的用自己的首个点做基准**，并在 `baseDate` 里如实返回。
  绝不对齐到别人的基准 —— 那会凭空多出一截涨幅，而这是看图的人无法察觉的错误。
  注意：这类标的因为不在交集里，实际上会被交集规则自然处理；测试覆盖的是
  它确实带回了自己的 `baseDate`。
- `visibleFrom` 缺省即全区间；给了就取 `>= visibleFrom` 的部分重算基准。
  **`visibleFrom` 晚于所有 bar 时回退到全区间**，不要返回空图。
- 基准为 0 或非有限值 → 丢弃该标的并记进 `dropped`，不要产生 `Infinity`。
- 交集少于 2 点 → 返回空 `series` 与空 `axis`，由调用方显示「区间内无重叠数据」。
- 输出顺序与输入顺序一致（图例顺序应当可预期）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -20`
Expected: PASS，11 个新测试全过，既有 241 无回归

---

## Task 2: `topic_charts` 的 kind 改造

**Files:**
- Modify: `src/infra/db/sqliteEventStore.ts`（`SCHEMA`、`TopicChartPreferenceRow`、`listTopicCharts` `:340`、`replaceTopicCharts` `:353`）
- Modify: `src/infra/db/__tests__/topicStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OverlaySpec = { symbols: string[]; range: string; normalize: "pct" | "index100" };
  export type TopicChartPreferenceRow =
    | { id: string; kind: "symbol"; symbol: string; range: string | null; hidden: boolean; sortOrder: number }
    | { id: string; kind: "overlay"; overlay: OverlaySpec; range: string | null; hidden: boolean; sortOrder: number };
  ```

- [ ] **Step 1: 改 schema**

替换 `topic_charts` 的定义（spec §6.1）：

```sql
CREATE TABLE IF NOT EXISTS topic_charts (
  id         TEXT PRIMARY KEY,
  topic_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  symbol     TEXT,
  overlay    TEXT,
  range      TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_charts_symbol
  ON topic_charts (topic_id, symbol) WHERE symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_topic_charts_topic_order
  ON topic_charts (topic_id, sort_order);
```

**用可辨识联合而不是「两个字段都可空」** —— 可空字段会让每个使用点自己判空，
那正是这次改造要摆脱的字符串解析老路。

- [ ] **Step 2: 加测试**

在 `topicStore.test.ts` 里补（既有用例改成新形状，不要减少覆盖）：

```ts
test("both kinds live in one table and sort together", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  store.replaceTopicCharts("t1", [
    { id: "c1", kind: "overlay", overlay: { symbols: ["AAPL", "NVDA"], range: "1Y", normalize: "pct" }, range: null, hidden: false, sortOrder: 0 },
    { id: "c2", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 1 },
  ]);
  const rows = store.listTopicCharts("t1");
  assert.deepEqual(rows.map((r) => r.kind), ["overlay", "symbol"]);
  store.close();
});

test("the partial index still blocks a duplicate ticker", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  assert.throws(() => store.replaceTopicCharts("t1", [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 0 },
    { id: "c2", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 1 },
  ]));
  store.close();
});

test("the same symbol set may be kept under two normalisations", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  store.replaceTopicCharts("t1", [
    { id: "c1", kind: "overlay", overlay: { symbols: ["AAPL", "NVDA"], range: "1Y", normalize: "pct" }, range: null, hidden: false, sortOrder: 0 },
    { id: "c2", kind: "overlay", overlay: { symbols: ["AAPL", "NVDA"], range: "1Y", normalize: "index100" }, range: null, hidden: false, sortOrder: 1 },
  ]);
  assert.equal(store.listTopicCharts("t1").length, 2, "the partial index must not constrain overlay rows");
  store.close();
});

test("a malformed overlay JSON row is skipped rather than crashing the read", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t1", "T");
  store.replaceTopicCharts("t1", [
    { id: "c1", kind: "symbol", symbol: "AAPL", range: null, hidden: false, sortOrder: 0 },
  ]);
  // Storage outlives the build that wrote it; a row this build cannot parse
  // must not take the whole tab bar down with it.
  store.rawExec?.("UPDATE topic_charts SET kind='overlay', symbol=NULL, overlay='{oops' WHERE id='c1'");
  assert.doesNotThrow(() => store.listTopicCharts("t1"));
  store.close();
});
```

最后一个测试需要 store 暴露一个测试用的裸执行入口；若不愿加，改为直接
`new DatabaseSync(":memory:")` 建同构表并调用解析函数 —— 二选一，
但**这条覆盖不能省**：坏数据不能让整条 tab 条崩掉。

- [ ] **Step 3: 实现读写并跑测试**

`listTopicCharts` 按 `kind` 分支组装联合类型，`overlay` 列 `JSON.parse` 失败则跳过该行。
`replaceTopicCharts` 按 `kind` 写入对应列，另一列写 NULL。

Run: `pnpm test 2>&1 | tail -20` — 零失败
Run: `pnpm build` — 干净

---

## Task 3: 服务端校验与 `stock_overlay` 解析

**Files:**
- Modify: `src/server/server.ts`（`handleReplaceTopicCharts`）
- Modify: `client/src/lib/chartWorkspace.ts`
- Modify: `client/src/lib/__tests__/chartWorkspace.test.ts`

`WorkspaceVisualization` 增加（spec §2）：

```ts
| { type: "stock_overlay"; symbols: string[]; range: StockRange; normalize: "pct" | "index100" }
```

`parseWorkspaceVisualization` 的校验，每条都要有测试：
去重后 2–6 个；超 6 个截断保留前 6；单个非法 ticker 丢弃该 symbol 而非整张图；
校验后不足 2 个返回 `undefined`；`normalize` 非法值落 `pct` 而不抛错。

服务端 `handleReplaceTopicCharts` 按 `kind` 分别校验，`overlay` 用同一套规则。
**两端的 ticker 正则必须一致**（`/^[A-Z][A-Z.-]{0,5}$/`）——不一致就会出现
前端能显示、后端拒绝存的标的。

---

## Task 4: 合并规则与客户端类型

**Files:**
- Modify: `client/src/types/core.ts`、`client/src/lib/topicCharts.ts` + 测试、`client/src/hooks/useTopicCharts.ts`

`TopicChartPreference` 改成与后端同构的可辨识联合。

`mergeTopicCharts`：**叠加 tab 不参与与推导结果的匹配。**推导只产出标的；
叠加是用户/agent 保留下来的产物，两者没有对应关系。它只按 `sortOrder` 参与排序。

新增测试：agent 画了 AAPL，不会与一张含 AAPL 的叠加 tab 合并成一行。

---

## Task 5: agent 的三个工具

**Files:**
- Modify: `src/agent/research/tools.ts`、`researchPrompt.ts`

- `overlay(symbols, range?, normalize?)` —— 生成并**落库成 tab**，`sortOrder` 置 0，自动选中。
  `range` 缺省取当前聚焦成员的 range，`normalize` 缺省 `pct`。
- `edit_overlay(chart_id, { range?, normalize? })` —— **不能改 symbols**（spec §4.1）。
  改标的要另调 `overlay`。落库，属于「agent 全权、用户可撤销」的范围。
- `edit_tabs` 收窄为只操作 `kind='symbol'` 的行。

prompt 里沿用「用后果约束」的写法：默认 `pct`，只有基金/指数净值对比才用 `index100`；
用户会看到你选的口径。

---

## Task 6: OverlayChart 组件

**Files:**
- Create: `client/src/components/OverlayChart.tsx`
- Modify: `client/src/components/workspace/ChartPane.tsx`、`ChartTabBar.tsx`

每个 symbol 一个 `useQuery`，key 与 `StockChart` 一致（`/market/stocks/:symbol?range=`），
所以已看过的标的是缓存命中。归一化调 Task 1 的纯函数。

**口径必须常驻标注**（spec §3.3）：`% change · from 2026-06-30`，基准日随缩放更新。
这是「让 agent 选口径」的必要配套 —— 没有标注，换口径就是隐蔽陷阱。

线条配色取语义 token，6 条线在浅色和深色下都要可区分。
`dropped` 的标的在图例上如实说明被剔除。

`ChartTabBar` 按 `kind` 渲染：叠加 tab 显示 `AAPL+NVDA` 加派生标记。

---

## Task 7: tab 拖出成浮动窗

**Files:**
- Create: `client/src/components/workspace/FloatingChart.tsx`、`client/src/hooks/useDetachedTabs.ts`
- Modify: `client/src/components/workspace/ChartTabBar.tsx`、`ChartPane.tsx`

**浮动是 tab 的属性，任何 tab 都能拖出来**（spec §5），不是叠加图专属。

接在已有的原生 HTML5 拖拽上（`ChartTabBar.tsx:122-126`）：条内拖是重排，
拖出 tab 条边界松手是分离。同一个手势。

六条规则照 spec §5 实现，注意第 2 和第 3 条**故意与浏览器不同**：

- 分离后该 tab 离开 tab 条
- **关闭浮动窗 = 回到 tab 条，不是删除**（tab 是持久化偏好，关窗就删太暴力；删除只有 `×`）
- **浮动状态不持久**，刷新回归 tab 条
- 可同时拖出多个，不设人为上限
- 可拖动、可缩放、非模态，初始位置在图表区中央偏上不遮 tab 条
- **窄屏（< 1024px）不支持分离**，拖拽只重排

---

## 统一测试（全部任务完成后）

- [ ] `pnpm test` 全绿（241 + 本阶段新增）
- [ ] `pnpm build`、`pnpm build:client` 无错误
- [ ] `cd client && npx tsc --noEmit` 零错误
- [ ] `git diff --stat -- src/framework/ src/agent/prompts/ src/agent/subagents/` 无输出
- [ ] `en.ts` 与 `zh-CN.ts` key 集合一致
- [ ] `grep -rn $'[一-鿿]' src/ client/src/ | grep -v locales/` 只剩既有的匹配数据
- [ ] 手动：让 agent 叠加两个标的 → 成为 tab 并选中 → 口径标注正确 →
      拖出成浮动窗 → 关闭回到 tab 条 → `×` 才是删除
