# Research 层：控制器 agent 与多单元工作区（第二阶段 2a）

日期：2026-07-30
前置：`docs/superpowers/specs/2026-07-30-topic-workspace-design.md`（第一阶段，已实施未提交）
范围：Research 实体、成员关系、控制器 agent、两行布局前端
不在范围：叠加对比图（`stock_overlay` + 浮动窗 + 钉住）—— 见 §10

## 1. 结论

Research 是把若干 Topic 并置起来做比较的单元。它有自己的对话、自己的论点，
成员 Topic 保持独立可访问，且可同时属于多个 Research。

关键架构决定：**Research agent 是用户的替身，不是现有 agent 的上层封装。**

它做四件事：给现有主 agent 投递指令、创建新 Topic、控制页面布局、把结果汇总成
面向用户的回答。它向 Topic 投递的指令，走的就是用户在聊天框里打字时走的那条路
（`orchestrator.run({ sessionId: topicId, userMessage })`，即 `server.ts` 的 `handleChat`）。

由此得到一条贯穿全文的硬约束：

> **现有 agent 一行都不改。** `OrchestratorRuntime`、`Dispatcher`、`orchestratorPrompt`、
> subagents、compaction 全部保持原样。它不知道对面是人还是 agent，也不需要知道。

递归、并发、超时的防护**只存在于 Research 这一层**，不下沉进现有框架。

## 2. 双写不是机制，是拓扑的结果

第一阶段的设计文档把「事实写回 Topic、解读留在 Research」当作一件要实现的事。
在这个拓扑下它不需要实现：

Research 让 AAPL 去查渠道库存 → 调用的是 AAPL 那个 session 的 orchestrator →
**那个 orchestrator 本来就只往自己的 session 写事件**。事实自动落在 AAPL 的时间线上。
Research 的 session 里只有它自己写的汇总与论点。

没有路由逻辑，没有「判断这句是事实还是解读」的分类器。省掉的这部分是本阶段
最大的一笔简化，而它来自把 agent 定位成替身而非封装。

## 3. 数据模型

```sql
CREATE TABLE IF NOT EXISTS researches (
  id         TEXT PRIMARY KEY,   -- 同时是它的 session_id，沿用 topic 的同一技巧
  agent_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS research_members (
  research_id         TEXT NOT NULL,
  topic_id            TEXT NOT NULL,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  -- 该成员的缩要，并入时生成、落后时惰性刷新（§4.2.2）
  digest              TEXT,
  digest_through_turn INTEGER NOT NULL DEFAULT 0,
  -- 控制器上次见到的 turn 数，用于外部增量（§4.2.3）
  seen_through_turn   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (research_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_research_members_topic ON research_members (topic_id);
```

`research_members` 不设跨 research 的唯一约束 —— 一个 Topic 属于多个 Research 是常态，
也是「事实层共享、解读层隔离」得以成立的前提。

删除一个 Topic 时一并删除它的 `research_members` 行。**成员归零的 Research 不自动删除** ——
它的对话和论点仍有价值；界面上显示为空成员状态。

仍不写迁移（demo 阶段，见前置文档 §4.1）。

## 4. 控制器 agent

独立模块 `src/agent/research/`，与现有 agent 并列而非嵌套。

**独立运行时 `ResearchRuntime`，不复用 `OrchestratorRuntime`。**

（初稿曾计划复用同一个类的第二个实例。行不通：`OrchestratorRuntime` 的允许工具集是
私有硬编码字段 `ORCHESTRATOR_DIRECT_TOOLS`（`orchestrator.ts:177`），复用就得改它，
而§1 的「现有 agent 一行都不改」是硬约束；何况独立性本身就是产品要求。）

代价是与 `orchestrator.ts` 的步进循环有部分结构重复。**这是有意接受的，
不要抽公共基类去消除它** —— 抽基类就是换个名义修改现有 agent。

它不注册任何 subagent：它的「下属」是完整的 Topic，不是 subagent。

### 4.1 工具集

| 工具 | 作用 | 备注 |
| --- | --- | --- |
| `ask_topic(topic_id, message)` | 以用户身份向该 Topic 投递一条消息 | 内部即 `orchestrator.run({ sessionId: topic_id, userMessage: message })` |
| `create_topic(name)` | 建一个新 Topic 并加为成员 | 复用 `createTopic` |
| `fetch_from_topic(topic_id, need)` | 带着问题去读该 Topic | 见 §4.3 |
| `focus(topic_id, symbol?)` | 切换焦点成员／图表 —— **瞬时，不落库** | 经 SSE 帧下发给前端 |
| `edit_tabs(topic_id, ops)` | 增删／钉住图表 tab —— **落库** | 复用 `PUT /topics/:id/charts` |
| `edit_members(ops)` | 增删成员 —— **落库** | 复用 `PUT /researches/:id/members` |

布局工具刻意拆成三个而不是一个笼统的 `set_layout`：瞬时的焦点切换与落库的结构改动
是两类不同的动作，撤销机制（§6）只适用于后者。合成一个工具会让「哪些要弹撤销提示」
变成运行时判断，而它本该是类型上的区分。

`ask_topic` 是同步的：它等待那次 orchestrator run 结束，返回该 Topic 的最终回答文本。
Research agent 因此可以在同一轮里投递、拿到结果、再汇总。

### 4.2 成员信息的三层供给

成员信息**不依赖现有的压缩机制** —— 缩要（§4.2.2）自行生成，
与 `loadCompaction` 是否有产物无关。

分三层供给，各司其职：

| 层 | 回答什么 | 何时产生 | 预算 |
| --- | --- | --- | --- |
| 开局名册 | 有谁 · 大概是什么 | Research 会话开始时**一次** | ~200 token/成员 |
| 外部增量 | 我没造成的变化 | 每轮，**仅在真有外部变化时** | 通常为 0 |
| `fetch_from_topic` | 具体说了什么 | 控制器主动调用 | 按需 |

#### 4.2.1 开局名册（一次性）

每个成员一块，约 200 token：身份（名字 · `leadSymbol` · 图表 tab 列表 ·
turn 数 · 最后活动）加上该成员的**缩要**（§4.2.2）。

**不每轮重渲染。**控制器自己的对话历史就是变更记录 —— 它派了活、看到了结果，
所以它知道成员变成了什么样。每轮重发名册是在重复历史已有的信息，
更糟的是两者会打架：名册讲当前状态，历史讲过程，模型得自己调和。

#### 4.2.2 成员缩要与惰性刷新

Topic 被并入 Research 时，用 SMALL 模型生成一份缩要，存在
`research_members.digest`，同时记 `digest_through_turn`。

**缩要会过期**：并入之后，Research 驱动了它、用户又直接跟它聊过，
缩要描述的还是并入那天。每轮开始时比对该 Topic 当前 turn 数与
`digest_through_turn`，**落后了才重新生成**。没进展不花钱。

#### 4.2.3 外部增量（每轮，通常为空）

控制器的历史只记录**它自己造成的**变化。用户直接去 Topic 聊天、
或另一个 Research 驱动了同一个 Topic，它都看不见，且无从察觉。

每轮开始时比对各成员的 turn 数与控制器上次见到的值：没变就一个字不发；
变了才发一行——

```
[外部更新] AAPL 自你上次查看后新增 3 轮（用户直接对话）· 最新结论: …
```

绝大多数轮次这块是空的。

### 4.3 `fetch_from_topic`：带着问题去读

```
fetch_from_topic(topic_id, need: string) -> {
  framing: string,     // 一句话说明为何选这些 —— 不得含任何数字
  excerpts: [...],     // 按 turn 号解析回来的原文
  data: [...],         // 按索引解析回来的 preservedData 条目
  charts: [...],       // 按 id 解析回来的图表
  coverage: string,    // 「已覆盖全部 42 轮」或「只看了最近 30 轮」
}
```

**索引单位是 turn**，锚在该 turn 返回给用户的最终 reply 上。
`session_events` 已有 `turn` 字段，`projectChatHistory` 已有对应投影 ——
不需要新建索引结构，turn 号本身就是 id。

#### 4.3.1 Map-reduce，防止单次爆上下文

一个 Topic 在压缩触发前可达 12 万 token，SMALL 模型吃不下。所以：

1. 把该 Topic 的 turn 序列**切分**成若干片，每片控制在 SMALL 模型可吃的范围
2. 每片发一个 SMALL 模型，带上 `need`，返回**选中的 turn id + 相关度分数**
3. 分片并行

**汇总不再过模型**：工具直接对各片的选择做并集、按分数排序、按 token 预算截断。
再加一次汇总模型只会再加一次失真，而这一步没有需要理解的东西，只是排序。

#### 4.3.2 小模型只负责选，不负责说

**硬规则**：SMALL 模型的输出只能是选择（turn id、`preservedData` 索引、chart id）
加一句不含数字的 `framing`。所有实际内容由工具按 id 从原始数据里取回。

理由不是优化，是安全边界：若小模型用自己的话复述「AAPL 的 P/E 是 31.2」，
那个数字就经过了一次可能出错的转写。在金融产品里，数字必须是原文。

为此，注入给 SMALL 模型的分片必须是**编号过的**（每个 turn 带号、
每条 `preservedData` 带索引），否则它无从引用。

### 4.4 防护（只在这一层）

- **递归深度 1。**被 `ask_topic` 驱动的 Topic orchestrator 不得再触发 Research 层。
  实现：`ask_topic` 调用时在 Research 侧记录「正在驱动的 topic 集合」，
  同一轮内不得重入同一个 Topic。现有 orchestrator 无从发起 Research 调用，
  所以这条只需在 Research 侧成立。
- **并发上限 3。**同一轮最多同时驱动 3 个 Topic，超出排队。
- **每次 `ask_topic` 超时 6 分钟**，超时记为该成员本轮失败，不中断整轮。

### 4.5 SSE 帧转发

用户看的是 Research 的流。被驱动的 Topic orchestrator 会产生完整的 dispatch /
tool_call / task_done 帧序列 —— **不转发原始帧**，只在 Research 流上发一条压缩帧：

```
{ name: "topic_dispatch", data: { topicId, topicName, task, status } }
```

前端渲染成对话流里一条内嵌细条（「已派 NVDA 补渠道库存 → 事实已写回」）。
用户要看全过程，去那个 Topic 里看。

## 5. 代问的归属标记

Research 代用户向 Topic 提问后，该 Topic 的时间线会多出一条 **user 角色的消息，
而用户从未打过它**。不标记的话，历史将不可信 —— 三个月后无法重建自己当时在想什么。

`user_message` 事件增加可选字段：

```ts
origin?: { researchId: string; researchName: string }
```

**orchestrator 忽略这个字段**，流程完全不变；它只影响记录与渲染。
Topic 时间线上这些轮次带一个「来自 Research：半导体估值」的小标签，可折叠、可筛选。

## 6. 布局权限：agent 全权，用户可撤销

Research agent 可以直接改变持久布局：切焦点、切图、增删 tab、加成员、钉住、调分栏。
改动落库，刷新后仍在。

**这推翻了第一阶段的一条规则**，必须一并修改：

> `client/src/lib/topicCharts.ts` 中「用户隐藏的标的，agent 再画多少次也保持隐藏」
> 的规则作废，连同 `topicCharts.test.ts` 里守着它的那个用例。
> `hidden` 不再是对 agent 的否决权，只是一次删除。

「可撤销」必须是真机制，否则只是「agent 覆盖、用户手动改回」：

- 每条布局偏好记录来源：`source: 'agent' | 'user'`
- 每次 agent 发起的改动弹一条带「撤销」的短提示，撤销即回退该次改动
- 撤销只回退最近一次 agent 改动，不做多级撤销栈（YAGNI）

## 7. 前端

沿用第一阶段的 `TopicWorkspace` —— 它已经收 `members: TopicSummary[]`
且 `conversationTitle` 已经会说多成员的情况。新增的是成员这一层。

### 7.1 两行结构（方案 A）

```
┌────────────────────────────────────────────────────────┐
│ StatusBar                                        36px  │
├───────┬────────────────────────────────┬───────────────┤
│ Rail  │ 成员 chip 行  AAPL² NVDA² 降息⁰ │ 对话           │
│       ├────────────────────────────────┤ （唯一一个）   │
│       │ 该成员的图表 tab  AAPL | SPY    │               │
│       ├────────────────────────────────┤               │
│       │ 图表区                          │               │
└───────┴────────────────────────────────┴───────────────┘
```

组件复用：`ChartPane` 与 `ChartTabBar` **原样使用**。它们已经按 `topicId` 工作
（`ChartPane` 内部调 `useTopicCharts(agentId, topicId, …)`），Research 视图只是把
「当前聚焦成员的 id」传进去。新增的只有成员行这一个组件。

### 7.2 成员行

**chip 内容**：`leadSymbol` 存在时显示 `leadSymbol`，否则显示 topic 名。
名字截断到 12 个字符加省略号（`美联储降息路径` 完整显示，更长的截断），
完整名走 `title` 属性。右上角一个上标数字＝该成员的图表数量。

**视觉区分**：成员 chip 用**圆角胶囊**（`rounded-full`），图表 tab 用第一阶段
已确立的**方角** `fin-figure` chip。两行紧邻，形状必须不同 —— 否则用户分不清
自己在切成员还是切图。这是刻意的差异，不是不一致。

**溢出**：横向滚动，不换行。换行会让工作区高度随成员数跳变。
沿用 `custom-scrollbar`。

**删除成员**：chip 悬停时出现 `×`。末尾一个虚线 `＋` 打开成员选择器（§7.4）。

### 7.3 各状态下的布局

| 状态 | 成员行 | 图表 tab 行 | 图表区 |
| --- | --- | --- | --- |
| 普通 Topic 视图（非 Research） | **不渲染** | 照第一阶段 | 照第一阶段 |
| Research 且只剩一个成员 | **渲染** | 渲染该成员的 tab | 渲染 |
| 多成员，聚焦成员有图 | 渲染 | 渲染该成员的 tab | 渲染 |
| 多成员，聚焦成员 0 图（宏观） | 渲染 | **不渲染** | **整列不渲染**，对话独占剩余宽度 |
| 成员归零 | 渲染（只有 `＋`） | 不渲染 | 整列不渲染 |

最后两行沿用第一阶段既有的机制：图表列为空时不渲染该列（`ratio === 0` 路径），
**且无过渡动画** —— 它反映的是内容的有无，不是状态切换。

成员归零的 Research 仍然有效：对话和论点还在，界面上是一个只有 `＋` 的成员行
加一句空态说明。

### 7.4 成员选择器

`＋` 打开一个下拉（复用 `ui/dropdown-menu.tsx`），列出该 agent 下尚未成为本
Research 成员的 Topic，按最近活跃排序，顶部一个过滤输入框。
多选，确认后一次性 `PUT /researches/:id/members`。

在 Topic 视图里，同一个选择器由图表 tab 条旁的「＋ 比较」触发；选定后
创建 Research（名字＝各成员 `leadSymbol` 或 topic 名以 ` · ` 连接）并跳转。

### 7.5 agent 改动的可见性

agent 通过 `focus` 切换焦点时，用户必须看得出来，否则会以为界面自己乱跳：

- 被 agent 切中的成员 chip 播放一次**一次性**的高亮描边（约 600ms 后归于常态）
- agent 发起的**落库**改动（`edit_tabs` / `edit_members`）弹一条带「撤销」的短提示（§6）
- `focus` 是瞬时的，**不弹提示** —— 它没有东西可撤销

### 7.6 StatusBar

Research 视图下显示 Research 名 + 成员数（`◇ 半导体估值 · 3 成员`），
不显示 `leadSymbol` —— 多成员时哪个标的都不能代表整体。
Topic 视图维持第一阶段的行为（topic 名 + `leadSymbol`）。

### 7.7 窄屏（< 1024px）

沿用第一阶段的上下堆叠（图表在上 `42dvh`，对话在下 `flex-1`，侧栏走 off-canvas）。
成员行**留在图表区顶部**，与图表 tab 行上下相邻 —— 它属于图表这一侧，
不能挪到对话区，否则焦点与所看内容分离。
两行 chip 在 42dvh 里各占约 28px，图表本身仍有约 300px，可接受。

### 7.8 侧栏

两个**平铺**分区：`Research` 与 `Topics`，**不嵌套**。
一个 Topic 可属于多个 Research，嵌套会让它在侧栏里出现多次 ——
侧栏就从「东西的列表」退化成「路径的列表」。成员关系只在 Research 内部展示。

Research 行显示 `◇` 前缀 + 名字 + 成员数。折叠态（56px）显示 `◇` 和成员数。

### 7.9 路由

```
/research/:agentId/:researchId
```

聚焦哪个成员**不进 URL** —— 它是瞬时视图状态，且 agent 可以改它。
把它放进 URL 会让 agent 的每次 `focus` 都写一条浏览器历史。

## 8. 服务端接口

```
GET    /api/agents/:agentId/researches
POST   /api/agents/:agentId/researches          { name?, topicIds: string[] }
PUT    /api/agents/:agentId/researches/:id      { name? }
DELETE /api/agents/:agentId/researches/:id
PUT    /api/agents/:agentId/researches/:id/members  { topicIds: string[] }   -- 整体覆盖
POST   /api/chat  的 sessionId 传 researchId 即与 Research agent 对话
```

最后一条意味着 `handleChat` 需要按 sessionId 判断走哪个 runtime。这是 `server.ts`
的改动，不是 agent 框架的改动 —— 约束（§1）依然成立。

## 9. 测试

- `research_members` 的增删与级联（删 Topic 清成员行、成员归零的 Research 仍存在）
- 缩要的惰性刷新：`digest_through_turn` 落后时刷新、持平时不调用模型
- 外部增量：成员 turn 数未变时注入为空；变化时只发变化的那些成员
- `fetch_from_topic` 的分片与汇总：切分不丢 turn、并集去重、按分数排序、
  按预算截断后 `coverage` 如实标注
- **小模型只选不说**：给定一个含数字的分片，返回的 `framing` 不得含数字，
  且 `excerpts` 与原始 turn 文本逐字相等（这是本阶段最重要的一个测试 ——
  它守的是「数字必须是原文」这条安全边界）
- 递归深度 1 与并发上限 3
- `topicCharts` 的 `hidden` 语义变更后的合并规则（§6 推翻的那条要有新用例）

`ask_topic` 的端到端不写自动化测试（需要模型凭据），改为手动核对步骤。

## 10. 明确不做

- 叠加对比图：`stock_overlay` 可视化类型、浮动窗、钉住为派生 tab（2b）
- Research 嵌套 Research
- 多级撤销栈
- 现有 agent 的任何改动
