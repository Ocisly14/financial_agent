# DCF Model as an Independent Panel (and English UI)

Date: 2026-08-11
Status: approved (design)

## Problem

The DCF workbook currently rides in the market chart column as a third tab kind.
`TopicChartTab` is a union of `symbol | overlay | model`, and `ChartTabBar` renders
all three in one strip. Two things are wrong with that:

1. **It is not the object it sits next to.** A chart tab is derived from message
   history and persisted as a user preference row; a model tab comes straight from
   the backend's model list and is neither. Every place the two meet needed a
   patch to keep them apart — `ChartPane`'s `selectedModelKey` shadow state (because
   `useTopicCharts`' `activeKey` fallback would override a model selection on the
   next render), `handleCloseTab`'s early return (because closing a model must not
   write a hidden-chart preference), `ChartTabBar`'s `draggable={tab.kind !== "model"}`
   and the model filter inside `handleDrop` (because a model tab in `orderedKeys`
   silently kills the whole reorder), and eight `Exclude<TopicChartTab, { kind: "model" }>`
   annotations to keep the renderers statically safe.
2. **The chrome lies.** The column's heading and `aria-label` are permanently
   "Market charts", with a `BarChart3` icon and a study count. Open the DCF
   workbook and the panel still says it is showing market charts.

Separately, the whole model UI is hardcoded Chinese (~35 strings) in an app whose
i18n default language is `en` and which ships an `en` / `zh-CN` locale pair with a
language switcher. The model panel is the only part of the app the switcher does
not reach.

## Goals

- DCF Model is a panel peer to Market, switched by an explicit control.
- The model UI goes through i18n like the rest of the app; English is what an
  `en` user sees.
- The workarounds listed above go away rather than move.

## Non-goals

- No change to what the workbook renders (sheets, grid, cell inspector layout).
- No change to the backend model API or the `model_revision` stream frame.
- `lib/semanticMarks.ts` and `MarkdownRenderer.tsx` contain Chinese inside
  bilingual regexes that match *agent output*. Those are not UI copy and are out
  of scope.
- Line-item labels (`row.label`) come from backend XBRL data and are not
  translated.

---

## §1 Architecture

### Layout

The left column of `TopicWorkspace` gains a segmented control above the panel body.
Exactly one panel is mounted at a time.

```
┌─ Rail ─┬────────── left column ──────────┬─ Conversation ─┐
│        │ [ Market ] [ DCF Model ]        │                │
│        │ ────────────────────────────────│                │
│        │ ▣ Market charts        3 studies │                │
│        │ [AAPL][NVDA][AAPL+NVDA] [+]     │                │
│        │        <candle chart>           │                │
└────────┴─────────────────────────────────┴────────────────┘

switched to DCF Model:
│        │ [ Market ] [ DCF Model ]        │
│        │ ▤ DCF Model · AAPL   rev 7 · draft│
│        │ [AAPL] [NVDA]                   │
│        │        <workbook grid>          │
│        │ [Summary|IS|BS|CF|Rev|WACC|DCF] │
```

The control sits inside the left column, above both panels, below `memberBand`.
It is the same in narrow mode (the 42dvh upper region) — no separate treatment.

### New components

**`components/workspace/WorkspacePanelSwitch.tsx`**

```ts
function WorkspacePanelSwitch({
  active: "market" | "model",
  onSelect: (panel: "market" | "model") => void,
  marketEnabled: boolean,
  modelEnabled: boolean,
}): JSX.Element
```

Two segments, always both rendered. A segment with no content is `disabled`
with a `title` explaining why, so the app never grows or loses a control under
the user's cursor. `role="tablist"` with `role="tab"` / `aria-selected` on the
segments.

**`components/model/ModelPanel.tsx`** — the DCF panel's own chrome, shaped like
`ChartPane`:

```ts
function ModelPanel({
  models: ModelView[],
  activeModelId: string | null,
  onSelectModel: (modelId: string) => void,
  context: ModelContextView | null,
  sheets, activeSheetId, onSelectSheet, markedSheetIds,
  isCellChanged, scrollToLineItemId,
}): JSX.Element
```

- `<section aria-label={t("model.panel")}>` with a header carrying the `Table2`
  icon, `t("model.panel")`, the active model's symbol, `rev N`, and the lifecycle
  stage. The revision-history disclosure (`RevisionDrawer`) moves here with them.
- A model strip: one button per entry in `models`. No drag, no close — a model is
  a backend object, not a user-arranged tab. It renders only when `models.length > 1`.
- Body: `ModelPane`.

`ModelPane` keeps only the sheet strip and the sheet body; its own header row and
`historyOpen` state move up to `ModelPanel`. Its `context` prop narrows to what
the sheets need.

`context` is null while the workbook for a known model is still loading —
`models` arrives from its own query before the workbook does. In that window
`ModelPanel` renders its header (the symbol is already known from `models`) with
`t("common.loading")` in the body, rather than returning null and collapsing the
panel the user just switched to.

### Model selection

`useFinancialModel` already exposes `models`, `activeModelId` and `setActiveModelId`;
today nothing calls the setter and selection is faked in `ChartPane`. `ModelPanel`
uses the hook's own state. `ChartPane`'s `selectedModelKey` is deleted.

### Deletions

`lib/topicCharts.ts`: the `ModelChartTab` member of `TopicChartTab` is removed, and
the union returns to `symbol | overlay`. Removed with it:

- `chartTabKey`'s `model:` branch
- every `Exclude<TopicChartTab, { kind: "model" }>` (in `topicCharts.ts`,
  `ChartPane.tsx`)
- `ChartTabBar`: the `Table2` branch, `draggable={tab.kind !== "model"}`, the
  `tab.kind !== "model"` filter in `handleDrop`, and the `kind === "model"` arm of
  the label expression
- `ChartPane`: props `modelTabs` / `modelPane` / `modelFocusRequest`, the
  `selectedModelKey` state, `handleSelectTab`, `handleCloseTab` (reverts to passing
  `closeTab` directly), the focus-token effect, the `tab.kind === "model"` guard in
  the floating-window map, and the `active.kind === "model"` arms in the header
  study-count and the body

`ChartPane` goes back to being about charts only. Its `tabs` is `chartTabs`.

### Panel visibility and fallback

`TopicWorkspace` owns:

```ts
const [activePanel, setActivePanel] = useState<"market" | "model">("market");
```

- Column exists when `Boolean(chartTopicId) && (tabs.length > 0 || models.length > 0)`
  — the same condition as today's `hasCharts`, unchanged.
- `marketEnabled = tabs.length > 0`, `modelEnabled = models.length > 0`.
- If the active panel is the disabled one, render the other. This is derived at
  render time (`const shown = enabled(activePanel) ? activePanel : other`), not
  written back into state, so a model arriving and later disappearing does not
  strand the user on a panel they never chose.

### Auto-focus

`model.focusRequest` moves out of `ChartPane` into `TopicWorkspace`. The existing
token-ref pattern is kept verbatim (a repeat request for the same model must fire
again; unrelated re-renders must not):

```ts
useEffect(() => {
  if (!focusRequest || focusRequest.token === focusTokenRef.current) return;
  focusTokenRef.current = focusRequest.token;
  model.setActiveModelId(focusRequest.modelId);
  setActivePanel("model");
}, [focusRequest]);
```

Semantics are unchanged from today (the agent builds a model, the user sees it);
the switch now moves the panel as well as the model.

---

## §2 Internationalisation

A new `model` namespace in both `client/src/i18n/locales/en.ts` and `zh-CN.ts`.
English goes in `en.ts`; the current hardcoded Chinese moves verbatim into `zh-CN.ts`.

### `SheetDescriptor` becomes translatable

`deriveSheets()` in `lib/workbook.ts` is a pure function with no access to `t`.
Rather than thread a translator into it, the descriptor carries a key:

```ts
export type SheetDescriptor = {
  id: string;
  labelKey: string;                       // was: label: string
  labelParams?: { category: string };     // segment sheets only
  group: SheetGroup;
  kind: SheetKind;
  statement?: SourceStatementKey;
  categoryName?: string;
};
```

`ModelPane` renders `t(sheet.labelKey, sheet.labelParams)`. The function stays pure
and the tests assert a key rather than a rendered string.

### String inventory

| Location | Key | en | zh-CN |
|---|---|---|---|
| `ModelPanel` | `model.panel` | DCF Model | DCF 模型 |
| `ModelPanel` | `model.revision` | rev {{revision}} | rev {{revision}} |
| `WorkspacePanelSwitch` | `model.switch.market` | Market | 行情 |
| `WorkspacePanelSwitch` | `model.switch.model` | DCF Model | DCF 模型 |
| `WorkspacePanelSwitch` | `model.switch.noCharts` | No charts in this topic yet | 该话题还没有图表 |
| `WorkspacePanelSwitch` | `model.switch.noModel` | No model in this topic yet | 该话题还没有模型 |
| `workbook.ts` | `model.sheets.summary` | Summary | 摘要 |
| `workbook.ts` | `model.sheets.incomeStatement` | Income statement | 利润表 |
| `workbook.ts` | `model.sheets.balanceSheet` | Balance sheet | 资产负债表 |
| `workbook.ts` | `model.sheets.cashFlowStatement` | Cash flow statement | 现金流量表 |
| `workbook.ts` | `model.sheets.revenue` | Revenue | 收入 |
| `workbook.ts` | `model.sheets.segment` | Segment: {{category}} | 分部：{{category}} |
| `workbook.ts` | `model.sheets.wacc` | WACC | WACC |
| `workbook.ts` | `model.sheets.dcf` | DCF | DCF |
| `WorkbookGrid` | `model.grid.lineItem` | Line item | 科目 |
| `WorkbookGrid` | `model.grid.empty` | This sheet has no content yet. | 这张表还没有内容。 |
| `SummarySheet` | `model.summary.history` | Historical statement items | 历史报表科目 |
| `SummarySheet` | `model.summary.metrics` | All metrics | 全部指标 |
| `SourceStatementSheet` | `model.source.reconFailed` | {{count}} reconciliation checks failed: | {{count}} 项勾稽未通过： |
| `WaccSheetView` | `model.wacc.asOf` | As of {{date}} | 截至 {{date}} |
| `WaccSheetView` | `model.wacc.missingInputs` | Missing inputs: {{inputs}} | 缺少输入：{{inputs}} |
| `CellInspector` | `model.cell.value` | Value | 值 |
| `CellInspector` | `model.cell.status` | Status | 状态 |
| `CellInspector` | `model.cell.source` | Source | 来源 |
| `CellInspector` | `model.cell.formula` | Formula | 公式 |
| `CellInspector` | `model.cell.rationale` | Rationale | 依据 |
| `CellInspector` | `model.cell.asOf` | As of | 截至 |
| `CellInspector` | `model.cell.refs` | References | 引用 |
| `CellInspector` | `model.cell.diagnostic` | Diagnostic | 诊断 |
| `DcfSheet` | `model.dcf.valuation` | Valuation | 估值结论 |
| `DcfSheet` | `model.dcf.perpetuityGrowth` | Perpetuity growth | 永续增长法 |
| `DcfSheet` | `model.dcf.exitMultiple` | Exit multiple | 退出倍数法 |
| `DcfSheet` | `model.dcf.waccByGrowth` | WACC × perpetuity growth | WACC × 永续增长 |
| `DcfSheet` | `model.dcf.waccByMultiple` | WACC × exit multiple | WACC × 退出倍数 |
| `DcfSheet` | `model.dcf.terminalValue` | Terminal value | 终值 |
| `DcfSheet` | `model.dcf.terminalPresentValue` | PV of terminal value | 终值现值 |
| `DcfSheet` | `model.dcf.enterpriseValue` | Enterprise value | 企业价值 |
| `DcfSheet` | `model.dcf.equityValue` | Equity value | 股权价值 |
| `DcfSheet` | `model.dcf.valuePerShare` | Value per share | 每股价值 |

Two list joins are currently hardcoded to the Chinese enumeration comma `、`
(`WaccSheetView` `missingInputs`, `SourceStatementSheet` failed results). Both
become `", "` at the join site and the separator is not translated — the joined
values are identifiers, and `", "` reads correctly in both locales.

`CellInspector`'s `Field label="Fact"` is already English and keeps its literal.
`SummarySheet`'s `Section title="Key Financials"` is likewise already English but
is moved to `model.summary.keyFinancials` so the whole sheet goes through one
mechanism.

---

## §3 Testing

`pnpm test` covers `client/src/lib/__tests__/*.test.ts` only — there is no
component test infrastructure in this repo, and this design does not add one.

**Changed:** `client/src/lib/__tests__/workbook.test.ts:184` asserts
`sheets[1]?.label === "分部:Product line"`. It becomes an assertion on
`labelKey === "model.sheets.segment"` and `labelParams` deep-equal
`{ category: "Product line" }`. Any other assertion in that file reading `.label`
on a `SheetDescriptor` is updated the same way.

**New:** `client/src/lib/__tests__/locales.test.ts` — walks `en` and `zh-CN`
recursively and asserts their key sets are identical, reporting the missing paths
on both sides. This outlives the current change: every future string added to one
locale and forgotten in the other fails here.

**Manual:** panel switching, disabled-segment fallback, and auto-focus on a new
model are component behaviour with no test harness. Verified by running
`pnpm start:client` against a topic that has both charts and a model, and a topic
that has only one of the two.

## Risks

- **Reordering regression.** `reorderTabs` currently receives a list that had
  model tabs filtered out of it. With the kind removed, `tabs` and the reorder
  list are the same set again, which is what `reorderTabs`' length check always
  assumed. Worth a manual drag-reorder pass after the change.
- **Detached floating windows.** They key off chart tab keys and are unaffected,
  but the `tab.kind === "model"` guard in the window map is removed, so the map
  now trusts `byKey` to hold only chart tabs. It does, once the kind is gone.
