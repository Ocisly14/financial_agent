# 叠加对比图（第二阶段 2b）

日期：2026-07-31
前置：`docs/superpowers/specs/2026-07-30-research-layer-design.md`（2a，已实施并提交）
范围：`stock_overlay` 可视化类型、归一化、浮动窗、保留为 tab
不在范围：Research 嵌套、多级撤销栈、现有 agent 的任何改动

## 1. 结论

Research 存在的理由是比较，但到 2a 为止，比较只能靠切 tab 和记忆。
叠加对比图把 N 个标的画进同一张归一化的图里，让比较变成一眼的事。

三条贯穿全文的决定：

**① 叠加图由对话产生，不是界面开关。**用户跟 agent 说「把 AAPL 和 NVDA 归一化叠一下」，
agent 发出一个可视化，前端弹出浮动窗。原始图永远不被改动。

理由是它和整个产品的主张一致：**图表内容由 agent 产出**。叠加是一次派生分析 ——
它是研究结果，不是视图状态。做成界面上的多选开关，等于把一次分析降格成一个复选框。

**② 它是「规格」，不是「数据」。**agent 只发 `{ symbols, range, normalize }`，
前端各自取 bar 再算。现有的 `stock_price` 就是这么做的（`StockChart.tsx:101` 自己
去 `/market/stocks/...` 取），只有 `stock_technical` 才携带算好的 `series`，
因为指标是服务端算的。

若 agent 把算好的点发过来，那张图会**冻结在提问那一刻** —— 第二天打开还是旧数据；
消息体积也会随标的数和区间长度暴涨。

**③ 生成即成 tab。**叠加图直接进入 tab 集合并被选中，`sort_order` 置 0
（沿用「新 tab 进最前」）。不喜欢就删，和任何别的 tab 一样。

> 这推翻了本文初稿的「保留才进 tab 集合」。那条门槛与 2a spec §6 已经定下的
> 「agent 全权，用户可撤销」自相矛盾 —— 既然 agent 可以直接增删 tab，
> 单独给叠加图设一道保留闸门没有道理。
>
> 也顺带说明：2a spec 曾把这个动作写成「钉住」。`pinned` 已在拖拽重排落地时
> 整个删除，这里不存在任何特殊的置顶 tab。

**④ 要对照就把 tab 拖出来。**叠加图不需要自己的窗口逻辑 ——
浮动是 **tab 的属性**，不是叠加图的属性（§5）。

## 2. 可视化类型

`client/src/lib/chartWorkspace.ts` 的 `WorkspaceVisualization` 增加第三种：

```ts
| {
    type: "stock_overlay";
    symbols: string[];              // 2–6 个
    range: StockRange;
    normalize: "pct" | "index100";
  }
```

`parseWorkspaceVisualization` 相应增加分支。校验：

- `symbols` 去重后 **2–6 个**。少于 2 不是叠加；多于 6 时线条互相遮蔽，图失去可读性 —— 超出截断并保留前 6 个。
- 每个 symbol 走既有的 `ticker()` 正则，不合法的丢弃（不是整张图丢弃）。
- 校验后不足 2 个 → 返回 `undefined`，按既有约定降级为无图。
- `normalize` 非法值 → 落到默认 `pct`，不抛错。存储与消息都是持久的，
  可能带着这个 build 不认识的值。

## 3. 归一化

### 3.1 两种模式

| 模式 | 算法 | 读数 | 何时用 |
| --- | --- | --- | --- |
| `pct`（默认） | `(v / base - 1) × 100` | `+18.3%` | 相对强弱：这段时间谁跑赢了 |
| `index100` | `v / base × 100` | `118.3` | 基金净值、指数对比的读数习惯 |

两者数学上等价，只是读数习惯不同。**默认 `pct`** —— 它是行业事实标准
（TradingView 加对比标的时整图自动切 percent scale；Bloomberg COMP、
Yahoo/Google Finance 的对比都是百分比）。金融工作者看到叠加图，
脑子里默认的读法就是「谁跑赢了多少」。

**不提供 Z-score。**它回答的是另一个问题（偏离常态多远），
而画成几条叠在一起的价格线，多数人会当成涨跌幅读。它属于独立的价差面板。

### 3.2 基准点跟随可见区间

归一化基准是**当前可见区间的左边缘**，不是 range 的绝对起点。
缩放到最近一个月，所有线以一个月前为基准重算。

这与 TradingView 一致，也是专业工具的肌肉记忆：缩放到哪段，看到的就是那段的相对表现。
代价是要监听缩放并重算 —— 值得，固定基准会让用户放大后看到与直觉不符的百分比。

### 3.3 口径必须常驻标注

图上常驻一行小字：`% change · from 2026-06-30`（或 `indexed to 100 · from …`），
基准日随缩放更新。

**这一条是「让 agent 选口径」这个决定的必要配套。**agent 可以按问题选模式，
所以同一个问题两次问可能得到不同口径的图 —— 标注让这件事无害：
读的人不会误读一张写明了口径的图。没有标注，换口径就是个隐蔽的陷阱。

### 3.4 数据对齐

各标的的 bar 时间戳不一定齐（停牌、上市日不同、ETF 与个股的交易日差异）。

- 以**交集**的时间轴为准，不做插值。插出来的点是编造的数据。
- **上市晚于区间起点的标的会把整个轴缩到重叠区间**，所有线一起以重叠起点为基准。
  这是对的，不是缺陷：叠加图回答的是「这段时间谁跑赢了」，
  几条线的窗口不同，这个比较本身就没有意义。图上标注的基准日会如实反映这一点。
- **只有一根 bar 的标的不参与定义轴**，但会挂到它有数据的那个轴点上。
  否则一个几乎没有数据的标的会把整张图压缩掉。它的基准取它**自己**在轴上的首个点 ——
  绝不对齐到别人的基准，那会凭空多出一截涨幅。
- 交集少于 2 个点 → 不渲染图，显示「区间内无重叠数据」。

## 4. agent 工具

新增 `overlay(symbols, range?, normalize?)`，加入 `RESEARCH_TOOL_SPECS`。

它**落库**：生成即成为 tab（§1③、§6），`sortOrder` 置 0 并自动选中。
不是 `focus` 那种瞬时动作 —— 用户要删就删，和任何别的 tab 一样。
`range` 缺省取当前聚焦成员的 range；`normalize` 缺省 `pct`。

prompt 里要写明的行为约束（沿用 `edit_tabs` 那种「用后果约束」的写法）：

- 用在真正需要比较的时候；单个标的的走势看原始图就够了
- 默认 `pct`；只有在做基金/指数净值对比时才用 `index100`
- 用户会看到你选的口径，选错会被当场看出来

**普通 Topic 视图同样可用。**一个 Topic 里 agent 画过 AAPL 和 SPY，
比较它们是自然需求 —— 叠加不是 Research 专属。

### 4.1 `edit_overlay`：可以改窗口，不能改标的

```
edit_overlay(chart_id, { range?, normalize? })
```

**能改**：`range`、`normalize`。
**不能改**：`symbols`。要换标的就调 `overlay` 生成一张新的。

这条线不是随意划的：

> **改区间是换个窗口看同一个比较；改标的是换了一个比较。**

后者本质上是另一张图。而用户可能已经围绕现有那张 tab 做了判断、把它拖出来对照过、
甚至在对话里引用过它 —— 就地把标的换掉，会让那个 tab 悄悄变成另一件东西，
而它的标题、位置、用户对它的记忆全都还是旧的。生成新图则一切都是显式的。

`normalize` 归在「可改」一侧：`+18%` 还是 `118` 是同一个比较的两种读数，
不是另一个比较。

`edit_overlay` **落库**（它改的是一个已持久化的 tab），因此属于 2a spec §6
「agent 全权、用户可撤销」的范围 —— 改动要能撤销。

## 5. 把 tab 拖出来变成浮动窗

**浮动是 tab 的属性，不是叠加图的属性。**任何一个 tab 都能拖出来 ——
把 AAPL 拖出来和 NVDA 的 tab 并排看，和拖出一张叠加图一样有用。
叠加图因此不需要任何自己的窗口逻辑。

交互接在已有的拖拽重排上（`ChartTabBar` 的原生 HTML5 拖拽）：
在 tab 条**内**拖是重排，拖出 tab 条边界并松手是分离。同一个手势，不是新增一套操作。

规则，多数与浏览器一致，第二条**故意不一致**：

1. **分离后该 tab 离开 tab 条**，出现在浮动窗里（浏览器行为）。
2. **关闭浮动窗 = 回到 tab 条，不是删除。**浏览器关窗即关 tab，因为还能重开；
   这里一个 tab 是持久化的用户偏好，关个窗就删掉太暴力。
   **删除仍然只有 tab 上的 `×` 一条路。**
3. **浮动状态不持久**，刷新后全部回到 tab 条。它是「我现在要对照」的临时布局，
   不是长期偏好；持久化它要存位置、尺寸、层级，而下次打开时意图多半已经不同。
4. **可以同时拖出多个。**是用户自己拖的，由用户管理，不设人为上限。
5. 浮动窗可拖动、可缩放、非模态。初始位置在图表区中央偏上，不遮 tab 条。
6. **窄屏（< 1024px）不支持分离** —— 空间不够并排，并排正是它唯一的理由。
   窄屏下拖拽只重排。

## 6. 叠加图作为 tab

生成即成为 tab 条上一个普通 tab：`sort_order` 置 0（沿用「新 tab 进最前」）、
自动选中、显示 `AAPL+NVDA` 并带一个派生标记，可拖、可分离、可关，
与原始 tab 一视同仁。

### 6.1 `topic_charts` 改造

一张 tab 现在有两种：一个标的，或一次叠加。schema 必须显式表达这件事。

```sql
CREATE TABLE IF NOT EXISTS topic_charts (
  id         TEXT PRIMARY KEY,
  topic_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- 'symbol' | 'overlay'
  symbol     TEXT,                 -- kind='symbol' 时是 ticker，否则 NULL
  overlay    TEXT,                 -- kind='overlay' 时是 JSON，否则 NULL
  range      TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_charts_symbol
  ON topic_charts (topic_id, symbol) WHERE symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_topic_charts_topic_order
  ON topic_charts (topic_id, sort_order);
```

`overlay` 存 `{ symbols, range, normalize }` 的 JSON。

**为什么不是把叠加编码进 `symbol` 列。**初稿曾计划存一个合成键
`overlay:AAPL+NVDA:pct`。那会让这一列同时装两种东西，后果具体：
服务端的 ticker 正则不再描述它；每个读取方都得先解析字符串才知道自己拿到了什么
（否则 `mergeTopicCharts` 会拿叠加键去和真实标的匹配，`ChartPane` 会去请求
`/market/stocks/overlay:AAPL+NVDA:pct`）；而 `PRIMARY KEY (topic_id, symbol)`
会顺带变成「同一组标的+同一口径只能存一张」——一个副作用，不是决定。

**为什么不是另开一张 `topic_overlays` 表。**tab 顺序是一条 `sort_order` 序列，
也是这个功能唯一的顺序真相来源。拆到两张表就要跨表合并排序和重排，
那正是不一致会出现的地方。

加一列 `kind` 同时避开两者：排序仍在一张表里，`symbol` 列回到只装 ticker，
读取方按 `kind` 显式分叉而不是靠解析字符串猜。

代价是主键从 `(topic_id, symbol)` 换成合成 id，去重靠上面那个部分唯一索引。
这会改动已经写好并提交的 `topic_charts` 读写代码 —— **demo 阶段不写迁移，
所以代价只是改代码，没有数据需要保全。**

### 6.2 波及面

`kind` 一列改变了「一张 tab 是什么」，所以下列都要跟着改，且都是显式分叉：

- **`TopicChartPreference`（`client/src/types/core.ts`）**变成可辨识联合：
  `{ kind: "symbol"; symbol: string; … } | { kind: "overlay"; overlay: OverlaySpec; … }`。
  用联合而不是「symbol 与 overlay 都可空」，让 TypeScript 替我们守住分叉 ——
  可空字段会让每个使用点都得自己判空，那正是回到了字符串解析的老路。
- **`mergeTopicCharts`（`lib/topicCharts.ts`）**：叠加 tab **不参与**与推导结果的匹配。
  推导只产出标的，叠加是用户保留下来的产物，两者没有对应关系。
  它按 `sort_order` 参与排序，仅此而已。
- **`ChartPane` / `ChartTabBar`**：按 `kind` 决定渲染 `StockChart` 还是 `OverlayChart`，
  以及 tab 上显示 ticker 还是 `AAPL+NVDA` 加派生标记。
- **服务端 `handleReplaceTopicCharts`**：按 `kind` 分别校验 —— `symbol` 走既有 ticker 正则，
  `overlay` 走 §2 的规则（2–6 个、逐个校验 ticker、`normalize` 落默认）。
- **agent 的 `edit_tabs`**：只操作 `kind='symbol'` 的行。叠加 tab 由 `overlay`
  创建、由 `edit_overlay`（§4.1）修改 —— 分开是因为两者能改的东西不同：
  `edit_tabs` 增删的是标的，而叠加 tab 的标的**不可就地修改**。
  让一个工具同时管两种 tab，就得在运行时判断哪些操作对哪种合法，
  而这本该是工具边界上的区分。

## 7. 渲染

新增 `client/src/components/OverlayChart.tsx`。

复用既有取数路径：每个 symbol 一个 `useQuery`，key 与 `StockChart` 一致
（`/market/stocks/:symbol?range=`），所以已看过的标的是缓存命中。

归一化本身是纯函数，放 `client/src/lib/overlayNormalize.ts` —— 客户端没有
React 测试运行器，可测逻辑必须在 `lib/` 下（沿用第一阶段的约束）。

线条配色取语义 token，不自己发明颜色；6 条线要在浅色和深色下都可区分。

## 8. 测试

`client/src/lib/__tests__/overlayNormalize.test.ts`：

- `pct` 与 `index100` 的换算正确，且互为线性变换
- 基准点随可见区间变化时重算
- 时间轴取交集，不插值
- 上市晚于区间起点的标的，从自己首个点起算，并带回它自己的基准日
- 交集少于 2 点时返回空结果而非抛错
- 某标的全区间无数据时被剔除，其余照常渲染

`chartWorkspace.test.ts` 增加 `stock_overlay` 的解析用例：
去重、少于 2 个丢弃、多于 6 个截断、非法 ticker 单个丢弃、非法 `normalize` 落默认。

`topicStore.test.ts` 增加 §6.1 新 schema 的用例：
两种 `kind` 共存于一张表并按 `sort_order` 一起排序、部分唯一索引仍然阻止重复 ticker、
叠加行不受该索引约束（同一组标的可存两种口径）、整体覆盖写保留两种行。

`topicCharts.test.ts` 增加：叠加 tab 不参与与推导结果的匹配 ——
agent 画了 AAPL 不会与一张含 AAPL 的叠加 tab 合并成一行。

不为浮动窗写组件测试（无 React 测试运行器）。

## 9. 明确不做

- Z-score 及其它统计口径
- 叠加图上叠加技术指标
- 就地修改一张叠加图的标的（§4.1 —— 换标的即生成新图）
- 浮动窗位置/尺寸的持久化（§5 第 3 条）
- 窄屏下的 tab 分离（§5 第 6 条）
- 跨 Research 的叠加（叠加图属于某个 topic 的 tab 集合）
- 现有 agent 的任何改动
