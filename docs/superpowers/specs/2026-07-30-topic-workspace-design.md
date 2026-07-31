# Topic 工作区：前端布局重构（第一阶段）

日期：2026-07-30
分支：`topic-workspace`
范围：`client/` 全部布局与导航结构，`src/` 中 room 相关的模型与接口
不在范围：Research 实体、跨单元双写、Research agent（第二阶段）

## 1. 结论

当前前端是**一个聊天应用，图表是挂件**。要变成一个金融工作台，改的不是配色和间距，
而是三件结构性的事：

1. **让上下文有身份。** 现在的组织单位是「聊天室」——一个会话习语，关掉就等于扔掉。
   改成 **Topic**：一个可以是标的（AAPL）也可以是宏观面（美联储降息路径）的最小研究单元，
   跨会话累积，三个月后回来它还记得。
2. **把图表的控制权交给用户。** 图表 tab 现在由 `chartWorkspace.ts` 从消息 metadata 推导。
   消息是持久的，所以 tab 其实也持久 —— **真正缺的不是持久性，是控制权**：
   用户不能钉住一个标的、不能删掉一个、不能自己加一个，只能求 agent 再画一次。
3. **把空间的分配权交给用户。** 列宽写死在 `chat.tsx` 的断点里。金融终端里，
   按屏幕和任务重新分配空间是基本诉求，不是高级功能。

第二阶段的 Research（多个 Topic 合并、跨单元比较、双写）不在本次交付内，
但**第一阶段的外壳必须是 Research 的同构外壳** —— Topic 是「只有一个 tab 的 Research」。
这一条约束贯穿全文，是许多设计选择的理由。

## 2. 现状事实

对 `client/src` 与 `src/` 的实际核对（非估计）：

| 事实 | 出处 | 后果 |
| --- | --- | --- |
| room 就是 session，1:1 | `server.ts` 中 `app.sessions.delete(roomId)`；`ensureRoom(agentId, sessionId, …)` | Topic 不需要新建实体，只需给 room 一个像样的身份 |
| 图表列只在消息带 visualization 时存在 | `chat.tsx` 的 `chartWorkspace.charts.length > 0` | 宏观 topic 永远没有图表；图表列会突然长出来又消失 |
| 列宽是断点常量 | `chat.tsx` 的 `xl:grid-cols-[…]` / `2xl:grid-cols-[…]` | 用户无权分配空间 |
| 策略入口埋在 731 行组件的中段 | `room-selector.tsx:427` | 一级导航实质上不存在 |
| 策略页自带一套 `sq-*` CSS | `routes/strategy-dashboard.css` | 全 app 两套设计语言并存 |
| `room-selector.tsx` 731 行、`chat.tsx` 444 行 | — | 同时承担布局、SSE、审批弹窗、消息渲染；第二阶段无法在其上落地 |
| 事实/解读的分界已存在 | `lib/semanticMarks.ts` 的 `INLINE_MARK_KINDS` / `BLOCK_MARK_KINDS` | 第二阶段的双写路由可以直接复用，不需要 agent 学新能力 |

最后一条值得展开，因为它决定了第二阶段的可行性：inline 标记 `metric` / `level` /
`catalyst` / `cite` 全部锚定在数据上（事实层），block 标记 `thesis` / `risk` 是判断（解读层），
且 `MARK_LIMITS` 已规定 `thesis: 1`。后端 `contextCompaction.ts` 的 `preservedData`
是压缩后仍然保留的硬数据。**「事实写回 Topic、解读留在 Research」这条规则不需要发明，
它已经被标注出来了。**

## 3. 概念模型

### 3.1 Topic

最小研究单元。一个 Topic 有：

- **一个名字**
- **一条持久的对话**（即现有 session，`topic.id === session_id`）
- **一个图表 tab 集合**（见 §3.2）

**Topic 不存「主标的」，也不存「类型」。**这两个字段在初稿里存在过，是设计错误：

- `kind` 永远等于 `symbol ? 'instrument' : 'macro'`，是同一事实的两份拷贝，只会不同步。
- `symbol` 与 `topic_charts` 冗余 —— 「这个 topic 是关于 AAPL 的」这句话，`topic_charts`
  里那一行已经说了。保留它等于给同一个事实开两个入口，而两个入口可以互相矛盾：
  你可以把 topic 绑定到 AAPL，同时 tab 栏里只有 NVDA。

更要命的是它在界面上也是两套动作：「绑定标的」和「＋ 加一个 tab」表达的是同一个意图。
删掉 `symbol` 就把两个动作合成一个。

**「宏观 topic」不需要枚举来表达 —— 它就是没有图表 tab 的 topic。**

侧栏和状态栏需要的 ticker 徽标是**派生**的，不是存储的：`listTopics` 用一次 LEFT JOIN
取该 topic 的首个可见图表（按 `pinned DESC, sort_order ASC`），以 `leadSymbol` 之名返回。
命名刻意与 `symbol` 区分，读到的人一眼能看出它不可写。没有 tab 的 topic 就没有徽标，
只显示名字 —— 这是对的，宏观 topic 本来也没有 ticker。

Topic 之间没有层级。第二阶段的 Research 会在其上叠加一层成员关系，
**原有 Topic 保持独立可访问**，不被 Research 吞掉。

### 3.2 图表 tab 集合：谁拥有它

这是本阶段最容易做错的地方，所以规则写死：

> **研究内容由 agent 产出，tab 集合由用户拥有。**

具体：
- `buildSymbolChartWorkspace()` **保持不变**，继续从消息推导出每个标的的 range 与 studies。
  这是「agent 画了什么」。
- 新表 `topic_charts` 只记录**用户对 tab 集合的意志**：加了什么、删了什么、钉了什么、
  怎么排序、range 覆盖。它**不存 study 内容**，避免与消息推导的结果分叉。
- 最终 tab 集合 = `(推导所得 ∪ 用户新增) − 用户隐藏`，按用户排序，钉住的在前。

宏观 Topic 通常没有 tab，此时对话独占整个工作区 —— 这是稳定状态，不是降级。

## 4. 数据模型与接口

### 4.1 Schema

`chat_rooms` 直接在 `SqliteEventStore` 的 `SCHEMA` 常量里加一列 `archived_at INTEGER`。
只有这一列 —— 见 §3.1，`symbol` 与 `kind` 是被否决的设计。

**不写迁移。**项目仍处于 demo 阶段，没有需要保全的数据，所以不引入
`ALTER TABLE` 的幂等辅助 —— 列直接写进 `CREATE TABLE`，本地已存在的开发库删掉重建即可。
一套只服务于假想数据的迁移机制，是纯粹的维护负担。

新表：

```sql
CREATE TABLE IF NOT EXISTS topic_charts (
  topic_id   TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  range      TEXT,               -- 用户覆盖；NULL 表示沿用推导值
  pinned     INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (topic_id, symbol)
);
```

`deleteRoom` 的事务（`SqliteEventStore:237-243`）须一并删除 `topic_charts` 行。

### 4.2 命名：彻底改名，不留半截

`room` → `topic` 的改名贯穿 DB 之外的全部层：HTTP 路由、`apiClient` 方法、
类型名、i18n key。表名 `chat_rooms` 保留（避免数据迁移风险），但代码中一律以 topic 称之，
在 `SqliteEventStore` 内注明表名是历史遗留。

理由：半改名的概念是最坏的结果 —— 第二阶段引入 Research 时，
「room / topic / research」三个词并存会让每一处调用点都需要现场翻译。

接口变化：

| 现有 | 改为 |
| --- | --- |
| `GET  /api/agents/:agentId/rooms` | `GET  /api/agents/:agentId/topics` |
| `POST /api/agents/:agentId/rooms` | `POST /api/agents/:agentId/topics` |
| `PUT  /api/agents/:agentId/rooms/:roomId` | `PUT  /api/agents/:agentId/topics/:topicId` |
| `DELETE …/rooms/:roomId` | `DELETE …/topics/:topicId` |
| — | `PUT …/topics/:topicId/charts`（tab 集合的用户意志，整体覆盖写） |

`PUT /topics/:topicId` 的 body 仍然只接受 `{ name }`。标的不在这里表达 —— 它是
`PUT /topics/:topicId/charts` 的事。后端因此**不需要** ticker 校验：合法的 ticker
由 charts 端点把关，那里本来就要校验。

`listTopics`（即现 `SqliteEventStore:186` 的 `listRooms`）的返回值增加派生字段 `leadSymbol`：

```sql
LEFT JOIN (
  SELECT topic_id, symbol,
         ROW_NUMBER() OVER (PARTITION BY topic_id ORDER BY pinned DESC, sort_order ASC) AS rn
  FROM topic_charts WHERE hidden = 0
) lead ON lead.topic_id = chat_rooms.id AND lead.rn = 1
```

侧栏要为每行渲染徽标，不能为此对每个 topic 再发一次请求。
排序沿用现有的 `updated_at DESC, created_at DESC`，「最近活跃的 topic」即该排序的第一行。

### 4.3 迁移

Demo 阶段，无需迁移：本地开发库删掉重建。现存 room 若保留则直接是 Topic，没有图表 tab。
**不做符号推断** —— 从历史消息猜标的会产生错误的 tab，而错误的 tab 比空 tab 栏更难发现。
用户改名、往 tab 栏加一个标的，都是一次点击的事。

## 5. 路由

```
/                                  → 重定向到最近活跃的 topic
/topic/:agentId/:topicId           → 统一工作区
/strategies/:agentId               → 原样保留
/strategies/:agentId/:strategyId   → 原样保留
```

`/chat/:agentId/:roomId` 与 `/chat/:agentId` 删除，不做重定向兼容 —— 本项目无外部链接。

## 6. 组件结构

`room-selector.tsx`（731 行）与 `chat.tsx`（444 行）同时承担布局、SSE 流处理、
审批弹窗和消息渲染。第二阶段要在同一个外壳上加 Research，必须先拆开。

```
routes/topic.tsx                 路由参数解析 → TopicWorkspace，处理 topic 不存在/空列表
components/workspace/
  TopicWorkspace.tsx             三栏外壳 + 分隔条状态。Research 将来复用同一个组件
  TopicRail.tsx                  侧栏：topic 列表、新建、改名、归档、绑定标的
  TopicRailItem.tsx              单行（含标的徽标、最后消息、未读态）
  ChartPane.tsx                  tab 条 + FinancialChartRenderer（由 MarketChartWorkspace 演化）
  ChartTabBar.tsx                tab 的增删钉排序 —— tab 集合的用户意志都在这里
  ConversationPane.tsx           消息流 + ChatComposer
  StatusBar.tsx                  顶部细栏
hooks/
  useTopicStream.ts              SSE / 流式 / 任务进度（抽自 chat.tsx）
  useTopicCharts.ts              推导结果与用户意志的合并（§3.2 的规则）
  useSplitLayout.ts              分隔条拖拽 + localStorage 持久化
lib/
  chartWorkspace.ts              不变
  topicCharts.ts                 合并规则的纯函数，可单测
```

`StrategyApprovalDialog` 的触发状态从 `chat.tsx` 移到 `useTopicStream`，
由 `TopicWorkspace` 渲染 —— 它是工作区级的中断，不属于对话流。

删除：`components/room-selector.tsx`、`components/MarketChartWorkspace.tsx`、
`components/chat.tsx`、`routes/chat.tsx`。

## 7. 布局几何

```
┌──────────────────────────────────────────────────────────────┐
│ StatusBar                                              36px  │
├────────┬──────────────────────┬──────────────────────────────┤
│ Rail   │ ChartPane            │ ConversationPane             │
│ 240px  │ 默认 46%，可拖拽      │ 剩余，最小 480px              │
│ 可折 56│ 整列可折叠            │                              │
└────────┴──────────────────────┴──────────────────────────────┘
```

- 分隔条可拖拽，比例存 `localStorage`，按 topic 无关的全局键（用户的空间偏好是习惯，不是每个 topic 一份）
- ChartPane 为空（宏观 topic 且无 tab）时，该列不渲染，对话占满剩余宽度。
  **无过渡动画** —— 布局跳变比布局动画更诚实，因为它反映的是内容的有无，不是状态切换。
- 断点：`< 1024px` 时 ChartPane 与 ConversationPane 变为上下两段，Rail 转为 off-canvas sheet（沿用现有 `ui/sheet.tsx`）
- 现有的「有 visualization 才长出图表列」的突变行为删除

## 8. 状态栏

只放**真实信号**，宁缺毋滥：

- SSE 连接状态（来自 `useTopicStream`）
- 当前 topic 的名字与 `leadSymbol`（没有 tab 时只显示名字）
- paper / live 模式（来自策略数据，而非硬编码字符串 —— 现有 `strategies.tsx` 里的 `<ModeTag mode="paper" />` 是写死的，这是个 bug）
- 主题切换（`ThemeToggle` 从浮动按钮收进这里）与语言切换

**不放**：市场时钟、P&L、账户净值。目前没有真实数据源，摆上去是装饰而不是信息，
且会在第二阶段变成需要拆除的假承诺。

## 9. 设计语言统一

按 `docs/2026-07-30-visual-design-language.md` 已确立的体系（已在 `53d25fd` 落地 token 层）：
组件只引用等级（`--e2`、`--label-2`、`--fill-1`），不写数字。

本阶段额外收编策略页：**删除 `routes/strategy-dashboard.css` 的整套 `sq-*` 体系**，
`strategies.tsx` 与 `strategy-detail.tsx` 改用 token 与既有组件。
**只换样式，不动结构与 IA** —— 策略页仍在原路由、功能不变。
理由：留一块视觉飞地，等于把「统一设计语言」这件事永远推迟。

## 10. 测试

现有测试（`lib/__tests__/` 下 4 个文件）必须继续通过 —— 其中
`chartWorkspace.test.ts` 覆盖的推导逻辑本阶段不改，是重构安全网。

新增单测：

- `topicCharts.test.ts` —— §3.2 的合并规则：推导 ∪ 新增 − 隐藏、钉住排序、range 覆盖、
  用户隐藏了一个标的但 agent 又画了它（应保持隐藏）
- `useSplitLayout` 的比例夹取（最小宽度、窗口缩小到小于最小值之和时的行为）

不为布局写快照测试 —— 快照对布局重构毫无价值，只会在每次调整时制造噪音。

## 11. 为第二阶段留的接口

本阶段不实现，但外壳必须容纳：

- `TopicWorkspace` 接受一个 **tab 集合**而非单个 topic。Topic 视图传 1 个成员，
  Research 视图将来传 N 个。这是「同构外壳」的具体含义。
- `ConversationPane` 的对话主体由 props 指定（topic session 或 research session），
  组件本身不假设自己在跟谁说话。
- `ChartTabBar` 的多选合并（用户自选几个 tab 叠加成一张归一化对比图）**本阶段不实现**，
  但 tab 的数据结构预留 `selected` 态，不需要将来改结构。

## 12. 明确不做

- Research 实体、成员关系、跨 session 读结论、双写路由、Research agent
- 策略页的 IA 重排（是否挂靠到 Topic 上）
- 从历史消息推断 topic 的标的
- 市场时钟、P&L、持仓等无真实数据源的信息
- `/chat/*` 旧路由的兼容重定向
