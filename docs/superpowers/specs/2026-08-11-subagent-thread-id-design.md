# Subagent 线程 ID：把「轨迹」从「制品」和「本轮」里拆出来

日期：2026-08-11
范围：`src/framework`（sessionState / dispatcher / subagent / contextCompaction）、事件表结构、orchestrator 与 subagent 的 prompt
不在范围：客户端、SSE 帧、跨话题线程、线程的重命名与删除 —— 见 §11

## 1. 结论

给 dispatch 加一个**跨轮稳定的 thread id**，让 subagent 的推理轨迹有自己的身份，
并把 orchestrator 的选择显式化：**续一条已有的线，还是开一条新的。**

同时把 `SessionEvent.is_sidechain` 这个布尔值换成 `thread_id` —— 主对话也是一条线程
（`<sessionId>:main`）。于是"这条事件谁该看见"从一个二值标记变成一次 id 比较。

三个 id 各司其职，这是整份设计的地基：

| | `model_id` | `thread_id` | `task_id` |
|---|---|---|---|
| 指向 | 制品：数值、revision、lifecycle | 轨迹：step notes、工具原始返回、报错 | 一次 dispatch |
| 存在 | 模型库，跨 session | event log，session 内 | event log，单轮 |
| 谁读 | 任何 agent，随时重读 | 只有这条线的 subagent | SSE 帧、本轮结果切片 |
| 丢了会怎样 | 算错数、写坏 revision | 重复劳动、重犯已纠正过的错 | 前端进度条错位 |

## 2. 现状与它漏在哪

- `sessionId` 就是 topic id（`chat_rooms.id`，见 `sqliteEventStore.ts:38` 的注释），
  对话开始时已经存在，不需要新造。
- 每次 dispatch 写一条 `dispatch` 事件，其 `event_id` 即 taskId；subagent 的 sidechain
  事件用 `payload.task_id` 挂在它上面，四个投影
  （`subagentProgress` / `subagentToolOutputs` / `subagentNotes` / `subagentToolErrors`）
  全部按它过滤。**投影键 = parentEventId** 由此而来。
- 唯一的跨轮延续是 `resumableInputPause(agent, model_id)`（`sessionState.ts:407`）：靠
  「最近一条 `asked_by` 匹配的 `user_input_required` + `paused_model_id` 相等 + 还没被别的
  `task_result` 消费」这一串启发式，猜出上一条 trace。

两个洞：

1. **预算耗尽那条路径根本没有延续。** financial_modeling 的 30 步预算烧完后，
   orchestrator 重新 dispatch，运行时开一条全新 trace（`dispatcher.ts:193`
   的 `resumedTrace ?? taskId` 落到 taskId），全靠开局那次
   `get_financial_model`（`subagent.ts:293`）把状态读回来。**数值读回来了，推理没读回来** ——
   模型看到一张自己没印象的表，于是重查已经查过的、重犯已经被纠正过的错。
2. **用 `model_id` 当轨迹身份是错配。** 同一个模型上的两条并行工作无法区分；而没有
   `model_id` 的工作（模型还没建、或 market_research）根本续不了。

## 3. 已定的五个决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | orchestrator 怎么表达「续 / 新」 | dispatch 带可选 `thread` 字段：填已有 id = 续，省略 = 开新 |
| 2 | 一个话题里同一 agent 几条线 | 多条，id 带序号 `<topicId>:<agent>:<n>` |
| 3 | thread 与 model_id 的关系 | thread 记住 model_id，续接时由 dispatcher 自动注入 |
| 4 | 交回 orchestrator 的 generation_context 范围 | agent 在 `finish` 时自己挑（`deliver` 字段） |
| 5 | orchestrator 从哪看到可续的线程 | 投影里单列一个 `[THREADS]` 区块 |

序号（决策 2）存在只为一件事：同一话题里先估 AAPL 再估 MSFT 时，两套推理不互相污染。
没有它，MSFT 的工作会接着 AAPL 的 trace 跑，`[PROGRESS SO FAR]` 里躺着一堆 AAPL 的 revision。

## 4. 事件模型：`is_sidechain` → `thread_id`

```ts
export interface SessionEvent {
  event_id: string;
  parent_event_id: string | null;
  session_id: string;
  thread_id: string;      // ← 取代 is_sidechain。主对话 = `${sessionId}:main`
  timestamp: string;
  source: Source;
  kind: string;
  turn: number;
  payload: JsonObject;
}
```

`record()` 的 `opts.isSidechain: boolean` 换成 `opts.thread: string`，缺省为主线程。
所有过滤变成一次 id 比较：

| 位置 | 现在 | 改后 |
|---|---|---|
| `projectForPrompt`（sessionState.ts:493） | `!e.is_sidechain` | `e.thread_id === main` |
| 四个 subagent 投影 | `e.is_sidechain && e.payload.task_id === id` | `e.thread_id === threadId` |
| `compact()`（contextCompaction.ts:36） | `e.is_sidechain` 跳过 | `e.thread_id !== main` 跳过 |
| `compactEvents`（sessionState.ts:207） | 按 turn 全删 | 只 splice `thread_id === main` 的 |
| `topicDigest.ts:57`、`researchRuntime.ts:463` | `e.is_sidechain` 跳过 | `e.thread_id !== main` 跳过 |
| `session_events` 表 | `is_sidechain INTEGER NOT NULL` | `thread_id TEXT NOT NULL`，加索引 `(session_id, thread_id)` |

**谁写进哪条线程** —— 这是本节唯一需要记住的规则，"写进哪条线程"就是"谁该看见它"：

- subagent 的 `tool_use` / `tool_result` / `subagent_note` → 写自己的线程。orchestrator
  看不见，因为它只投影主线程。
- subagent 的 `task_result` → 写**主线程**（这正是 orchestrator 能看见它的原因），
  payload 带 `thread` 指回来源线程。
- subagent 经 ask_user 抬上来的 `user_input_required` → 写**主线程**，payload 带 `paused_thread`。

事件的 `parent_event_id` 改回「本轮 dispatch 的 event_id」。现在续接时新事件挂在上一轮的
dispatch 上，事件树是歪的；线程身份独立之后没有理由再歪。

`payload.task_id` **保留**，语义仍是本轮 dispatch 的 event_id ——
`sseProjector.ts:29/32` 用它给客户端发 progress / artifact 帧，本轮结果切片也要它。

顺带修掉一处隐性依赖：`projectForPrompt` 里的
`e.kind === "tool_result" && !e.is_sidechain`（sessionState.ts:526）—— orchestrator 自己的
直接工具调用和 subagent 的工具返回今天全靠这个布尔值分开，改成线程过滤后该条件自然消失。

## 5. Thread 的分配与解析（Dispatcher）

`TaskRequest` 加可选字段：

```ts
export type TaskRequest = {
  agent: AgentKind;
  task: string;
  /** 续接一条已有轨迹。省略 = 开新线程。 */
  thread?: string;
  model_id?: string;
  tools?: string[];
  timeout_ms?: number;
};
```

`Dispatcher.runExistingTask` 在启动 subagent 之前解析线程，六种情况：

| 情况 | 行为 |
|---|---|
| 不传 `thread` | 分配 `<sessionId>:<agent>:<n+1>`，n = 该 (session, agent) 的历史最大序号 |
| 传了已知 id 且 agent 匹配 | 续接 |
| 传了未知 id，或 agent 对不上 | `task_result` 失败，code `thread_not_found` |
| 传了 id 且 `model_id` 与线程记录不同 | 失败，code `thread_model_mismatch` |
| 同一批 dispatch 里两条指向同一 thread | 两条都失败，code `thread_conflict` |
| 目标 thread 还有未完成的 dispatch | 失败，code `thread_busy` |

后三条是并行 dispatch（`dispatcher.ts:96` 的 `Promise.all`、`dispatchAsync`）带来的真实竞态：
两个 run 往同一条 trace 里交错写 note，投影会变成两个人的独白拼在一起。失败比静默交错好，
而且不烧 LLM 调用 —— orchestrator 下一步就能在 `[CURRENT TURN PROGRESS]` 里看到错误行改正。

失败路径复用现有的 `recordTaskResult` 写法（同 `tool_not_allowed`，`dispatcher.ts:163`），
不抛异常。

**model_id 自动注入**：线程记住最后见到的 `model_id`；续接时若 request 没带，dispatcher
填进去再交给 subagent，开局那次 `get_financial_model` 照常跑。orchestrator 不传也不会丢模型。
带了但不一致 → 上表第四行，因为「续 1 号线但换个模型」几乎必然是笔误，正确动作是开新线程。

## 6. 线程台账

理论上应当像这个仓库的其它状态一样从 log 推导。但 `compactEvents` 会把老轮次的主线程事件
（含 `dispatch`）从内存里 splice 掉，推导会让序号回退、撞上活着的线程。

所以 `SessionState` 持一份内存台账：

```ts
export interface ThreadRecord {
  thread_id: string;
  agent: AgentKind;
  seq: number;
  last_turn: number;
  last_task_id: string;
  status: "running" | "paused" | "exhausted" | "failed" | "done";
  model_id?: string;
  pending_request_id?: string;   // status === "paused" 时指向那条待答问题
}
```

维护方式：`record()` 每追加一条事件就调一次私有的 `applyToLedger(event)`；
`SessionState.restore()` 用同一个函数重放 store 的全量事件（store 从不删）。
**热路径和冷启动走同一段代码**，不会漂移。log 仍是唯一真相，台账只是缓存 ——
这是对「一切从 log 推导」的一处有意破例，原因写进注释。

`status` 由事件推导，没有谁需要显式关闭线程：

- `running` —— 有 dispatch 没 task_result
- `paused` —— 上一轮停在 ask_user
- `exhausted` —— 上一轮烧完步数预算
- `failed` —— 上一轮 failed / timeout
- `done` —— 上一轮干净收工（**仍然可续**，"再把 WACC 调一下"是合法的）

`paused` / `exhausted` / `done` 三者靠 `TaskResult` 新增的一个字段区分，而不是解析 summary 文本：

```ts
export type TaskResult = {
  // ...
  /** 这一轮结束时轨迹的状态，供线程台账使用。 */
  thread_state?: "paused" | "exhausted" | "done";
};
```

由 `SubagentRuntime.run` 写：`pendingUserInput` → `paused`；步数耗尽 → `exhausted`；
其余 → `done`。dispatcher 写的失败/超时结果不带这个字段，台账按 `status` 记 `failed`。

## 7. 两侧投影

### 7.1 subagent 侧：`[PROGRESS SO FAR]` 按线程

四个投影的入参从 `dispatchEventId` 改成 `threadId`，过滤条件改为 `e.thread_id === threadId`。
第 2 轮开局就看得见第 1 轮的 step notes 与工具原始返回 —— 这是 §2 洞 1 的正面修复。

seam note（`subagent.ts:286-291`）的触发条件从 `parentEventId !== taskId` 改成
「这条线程已有前轮事件」，文案按上一轮的 `thread_state` 分三种：

- `paused` → 现文案（用户已回答，答案在 task 里，别重做别再问，步号重新计）
- `exhausted` → 「上一轮用尽步数预算被打断，下面是你自己的工作，接着做，别重来」
- `done` / `failed` → 「上一轮已收工，这是同一条线上的新要求，沿用你已有的结论」

### 7.2 orchestrator 侧：`[THREADS]` 区块

`projectForPrompt` 多返回一段，由 orchestrator 拼在 `[CURRENT TURN PROGRESS]` 之前
（`orchestrator.ts:234`）：

```
[THREADS]
- t-abc:financial_modeling:1 · model fm_9f2 rev 7 (forecast) · 末次活动 turn 4 · paused，等你回答 input_7c1
- t-abc:financial_modeling:2 · model fm_a31 rev 2 (draft)    · 末次活动 turn 6 · exhausted，可续
- t-abc:market_research:1                                    · 末次活动 turn 2 · done
```

从台账渲染而非扫事件，所以压缩之后照样在。按 `last_turn` 倒序，最多 8 条。

区块名用 `[THREADS]` 而非 `[OPEN THREADS]`：没有任何线程会被关闭，`done` 的线也可续，
叫 open 是个名不副实的限定词。

**一处对决策 5 的小扩展**：`formatTaskResultLine` 在结果行尾追加 ` · thread <id>`。
理由是一个真实的歧义 —— 同一轮里同一个 agent 的两条线各返回一条结果时，光看 `[THREADS]`
无法把结果对回线程，而结果行正是 orchestrator 决定下一步的地方。dispatch 行不加（那里
还没有可决策的信息）。这一条如果不要，删掉即可，其余设计不受影响。

### 7.3 prompt 改动

`orchestratorPrompt.ts`：

- `[OUTPUT FORMAT]` 的 dispatch 项加 `"thread"`：
  `{ "agent": "...", "task": "...", "thread": "<可选，续接已有线程时填 [THREADS] 里的 id>" }`
- 三条规则：
  1. `[THREADS]` 里标 `paused` 的线程是在等你现在已经拿到的那个答案 —— **必须续它**，
     不要开新线程，否则 agent 会把同一个问题再问一遍。
  2. 同一个模型 / 同一件事的后续工作，续原线程；`exhausted` 就是活干到一半，续。
  3. 换标的、换模型、换一件不相干的事 → 省略 `thread`，开新线程。

`subagentPrompts.ts`：BUDGET 那段（`subagentPrompts.ts:74`）关于「resumable pause」的措辞
改写为线程语义；补 `finish` 的 `deliver` 用法（见 §8）。

## 8. `finish` 的 `deliver`

`FINISH_TOOL`（`subagent.ts:158`）加一个可选字段，**只发给 financial_modeling** ——
其它三个 agent 是单轮的，没有可挑的东西，不给它们凭空造一个决策。
`buildLoopToolSpecs` 因此需要知道 agent 名。

```
deliver: array of
  active_model_context | revision_summaries | query_results
  | latest_subagent_results | skill_references
```

语义：这一轮交回 orchestrator 的 `generation_context.data` 里，放**整条线程**的哪几段
（段名即 `projectFinancialModelData` 的输出键，`subagent.ts:608`）。省略 = 只交
`active_model_context`。

一个护栏：**`active_model_context` 无论选没选都交** —— model_id / revision /
lifecycle_stage 是 orchestrator 判断线程状态、写下一条 dispatch 的依据，体积恒定。

这条路真实的失败面写在这里备查：agent 漏挑 `query_results`，orchestrator 手上没数，
按 HARD RULE 1（不许编数）它只能说「这块缺数据」。因此 `deliver` 的字段描述把判准写死：
**最终答案里要引用到数字的，必须挑上**。

### 结果与轨迹的范围规则

一条贯穿的规则，实现时按它对照：

> **`task_result` 的一切按本轮切片（`payload.task_id`）；只有模型自己看的
> `[PROGRESS SO FAR]`，以及 `deliver` 点名的那几段，按线程切片。**

具体到 `subagent.ts:461-499`：

| 产物 | 现在 | 改后 |
|---|---|---|
| `artifacts` / `visualizations` | 整条 trace | 本轮（否则第 2 轮会把第 1 轮的附件再挂一遍） |
| `metrics.tool_calls` | 整条 trace | 本轮 |
| `firstToolError`（决定 status） | 整条 trace | 本轮（上一轮的失败不该判这一轮死刑） |
| `generation_context.data`（非 financial） | 整条 trace | 本轮 |
| `generation_context.data`（financial） | 整条 trace | `active_model_context` + `deliver` 点名的段，按线程 |

因此 `SessionState` 需要两个读取器：`threadOutputs(threadId)` 与 `roundOutputs(taskId)`。

## 9. 压缩：全量回放，到顶降级

**内存。** `compactEvents` 只 splice 主线程事件，subagent 线程的轨迹留在内存 ——
否则续接一条老线程会回放出一片空白。代价是长话题的轨迹事件常驻内存；可接受，因为真正给
orchestrator prompt 减负的是投影而不是这次 splice。真成问题时再做「线程摘要化」，
那是另一个改动（§11）。

**prompt。** `projectFinancialModelProgress`（`subagent.ts:637`）加一个字符预算
`THREAD_PROGRESS_BUDGET_CHARS`（env 可调，默认 80_000），超了就**确定性降级**，
从老到新丢，不调 LLM —— 在 subagent 循环里塞一次 LLM 压缩会让每步都变慢，并引入一个新的失败点：

1. `query_results` 只留最近 6 条
2. 老的 `step_notes` 折成一行 `(前 N 步的 note 已省略)`
3. `revision_summaries` 只留最近 10 条
4. `skill_references` 退化成 key 列表

`active_model_context` 永远保留。每步降级都留一行痕迹，让模型知道自己被截断了。

通用的 `subagentProgress`（非 financial）同样加预算：超限时保留最后 N 行 + 一行省略标记。

## 10. 删掉 `resumableInputPause`

`recordUserInputRequest` 的 `paused` 参数从 `{ taskId, modelId }` 换成 `{ threadId }`；
payload 键 `paused_task_id` / `paused_model_id` → `paused_thread`。
`sessionState.ts:407-426` 整个函数删除，`dispatcher.ts:181-182` 一并删。

**这是一处行为变化，写在这里以便回归时认得出**：暂停之后，如果 orchestrator 不显式带
`thread` 就重新 dispatch，agent 会开一条空线程、可能把同一个问题再问一遍。这正是「显式」的
代价。挡它的是 `[THREADS]` 里那行 `paused，等你回答 input_7c1` 加上 §7.3 的规则 1。

`foldUserInputRequest`（`sessionState.ts:92`）不动。

## 11. 兼容性：不做

已有的 dev sqlite 库不迁移。`session_events` 的 SCHEMA 是 `CREATE TABLE IF NOT EXISTS`，
改字段不会自动生效 —— 实现步骤里明确写一条：**删掉本地 sqlite 文件重建**，不写迁移代码，
投影里也不留 `?? payload.task_id` 之类的老事件兜底。

## 12. 测试

新增：

- **分配**：省略 `thread` → `:1`、再省略 → `:2`；带已有 id → 同一条线；
  `thread_not_found` / `thread_model_mismatch` / `thread_conflict` / `thread_busy` 各一条
- **model_id 注入**：续接时不传 model_id，subagent 拿到的 request 里有
- **跨轮回放**：同一线程两次 dispatch，第 2 轮的 `[PROGRESS SO FAR]` 含第 1 轮的 note 与工具返回；
  第 2 轮的 `task_result` 不含第 1 轮的 artifacts / 数据（除非 `deliver` 挑了）
- **`deliver`**：省略 → 只有 `active_model_context`；挑 `query_results` → 出现；
  无论怎么挑 `active_model_context` 都在
- **ask_user**：暂停在台账里记 `paused` + `pending_request_id`；带 thread 续接出现 seam note；
  **不带 thread → 开新线程**（把 §10 的行为变化钉住）
- **`[THREADS]`**：五种 status 各渲染一次；`compactEvents` 之后仍在
- **台账重建**：`SessionState.restore()` 后台账与热路径一致（序号不回退）
- **压缩交互**：`compactEvents` 之后，subagent 线程的事件仍在内存，续接能完整回放
- **预算降级**：超限后 `active_model_context` 存活、notes 折叠、留下省略标记

要改的现有测试与脚本：`framework/__tests__/subagentUserInput.test.ts`、
`agent/financial-modeling/__tests__/subagents.test.ts`、`server/__tests__/sseProjector.test.ts`、
`server/__tests__/chatHistory.test.ts`（都在用 `isSidechain: true`）、
`scripts/xbrl/e2e_test/step8-agent-valuation.ts`（直接构造了 `parentEventId`）。

## 13. 不做

- 客户端不动：SSE `dispatch` 帧不加 thread，UI 不展示线程
- 跨话题线程、线程的重命名与删除
- 线程轨迹的 LLM 摘要化（只做 §9 的确定性降级）
- research 控制层不动：它经 `orchestrator.run` 驱动成员 Topic，不直接构造 `TaskRequest`
- `dispatch` 行不标 thread（只在 `task_result` 行标，理由见 §7.2）
