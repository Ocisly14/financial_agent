---
title: 会话上下文自动压缩(Auto-Compact) — 设计 spec
date: 2026-06-09
status: spec
---

**Status:** Design (pending implementation)
**Date:** 2026-06-09
**Author:** victor530914@gmail.com (with Claude)
**Scope:** `SessionState` / `SessionRegistry` 的事件持久化与 prompt projection 压缩；不改 Dispatcher / Subagent runtime / MCP 工具协议 / orchestrator 的 OrchestratorStep 协议。

---

## 1. 背景与目标

`SessionState`(`src/framework/sessionState.ts`)是一个 append-only 的事件日志,纯内存、无持久化。`projectForPrompt(turn)` 每轮把全部历史事件渲染成 `conversationSoFar`(历史轮次)+ `currentTurnProgress`(当前轮次),拼进主 agent(orchestrator)的 prompt。

随着会话轮数增加,`conversationSoFar` 无限增长,会出现两个问题:

1. 主 agent 的 prompt 体积逼近/超过模型上下文窗口。
2. 进程内存中 `events` 数组无限增长,进程重启后会话历史全部丢失。

目标:当主 agent 上一轮真实 prompt token 用量达到上下文窗口的 60% 时,自动把"较早轮次"压缩成摘要 + 保留关键数据,同时引入 MongoDB 作为事件日志的持久化层,使压缩后的轮次可以安全地从内存裁剪、且不丢失可审计的原始记录。

### 非目标

- 不压缩当前轮次(`currentTurnProgress`)。
- 不改变 orchestrator 的 OrchestratorStep 协议、Dispatcher/Subagent 的协议。
- 不实现完整的"通用持久化查询/回放 UI";Mongo 仅作为事件存储与恢复的后端。

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│ orchestrator.run()                                        │
│  1. await sessions.getOrCreate(sessionId)  ← 可能从 Mongo 恢复 │
│  2. state.beginTurn(userMessage)                          │
│  3. if lastPromptTokensIn / WINDOW >= 0.6:                │
│        await maybeCompact(state, currentTurn, modelRouter)│
│  4. proj = state.projectForPrompt(turn)                   │
│  5. ...原有 step 循环...                                   │
│  6. state.recordPromptTokens(completion.metrics.tokens_in)│
└──────────────────────────────────────────────────────────┘
        │ record() 同步写内存                  │ fire-and-forget
        ▼                                      ▼
┌─────────────────┐                  ┌─────────────────────┐
│ SessionState     │                  │ MongoEventStore      │
│ - events[]       │ ───appendEvent──▶│ session_events       │
│ - lastPromptTokensIn │              │ session_compaction   │
│ - compaction?    │ ◀──loadEvents────│                       │
└─────────────────┘   loadCompaction  └─────────────────────┘
```

---

## 3. MongoDB 持久化层

### 3.1 Schema

简单 schema,使用官方 `mongodb` driver,不引入 ODM。

**`session_events`** — 每个文档 = 一个 `SessionEvent` 原样存储:

```typescript
{
  event_id: string,
  parent_event_id: string | null,
  session_id: string,
  timestamp: string,
  source: Source,
  kind: string,
  is_sidechain: boolean,
  turn: number,
  payload: JsonObject,
}
```

索引:
- `{ session_id: 1, event_id: 1 }` unique
- `{ session_id: 1, turn: 1 }`(范围查询/裁剪用)

**`session_compaction`** — 每个 session 一个文档:

```typescript
{
  session_id: string,
  summarizedThroughTurn: number,
  summaryText: string,
  preservedData: PreservedDataEntry[],
  updatedAt: string,
}
```

### 3.2 写入路径

`SessionState` 构造函数新增可选参数 `store?: EventStore`:

```typescript
interface EventStore {
  appendEvent(event: SessionEvent): Promise<void>;
  loadEvents(sessionId: string): Promise<SessionEvent[]>;
  loadCompaction(sessionId: string): Promise<CompactionCache | undefined>;
  saveCompaction(sessionId: string, cache: CompactionCache): Promise<void>;
}
```

`record()` 保持同步签名不变(push 到 `this.events` + 通知 listeners + 返回 event)。新增最后一步:若 `this.store` 存在,`this.store.appendEvent(event).catch(err => log.error(...))`(fire-and-forget,不 await、不抛出)。

不传 `store` 时(测试/mock),行为与今天完全一致——纯内存,无持久化。

### 3.3 恢复路径

`SessionRegistry.getOrCreate(sessionId)` 改为 `async`:

```typescript
async getOrCreate(sessionId: string): Promise<SessionState> {
  let state = this.sessions.get(sessionId);
  if (state) return state;
  if (this.store) {
    const events = await this.store.loadEvents(sessionId);
    const compaction = await this.store.loadCompaction(sessionId);
    state = SessionState.restore(sessionId, events, compaction, this.store);
  } else {
    state = new SessionState(sessionId, new Date().toISOString(), this.store);
  }
  this.sessions.set(sessionId, state);
  return state;
}
```

`SessionState.restore(...)` 用加载到的 events 预填充 `this.events`,`turn` 计数器取 `max(events.map(e => e.turn))`,`compaction` 取加载到的缓存。这些预加载的事件标记为"已持久化"(不会在 restore 时重复触发 `appendEvent`)。

`orchestrator.run()` 中 `this.sessions.getOrCreate(input.sessionId)` 改为 `await this.sessions.getOrCreate(input.sessionId)`(orchestrator.run 本身已是 async,改动局部)。

### 3.4 配置

环境变量 `MONGODB_URI`,默认 `mongodb://localhost:27017/financial-agent`。本地开发用单节点 Mongo(docker)即可。未配置/连接失败时,降级为纯内存(记一条 warning 日志),不阻断主流程。

---

## 4. 触发机制

### 4.1 状态

`SessionState` 新增两个运行时字段(不进 event log):

```typescript
private lastPromptTokensIn?: number;
private compaction?: CompactionCache;

interface CompactionCache {
  summarizedThroughTurn: number;       // 1..此数字的轮次已折叠进摘要
  summaryText: string;                 // 滚动摘要(LLM 生成)
  preservedData: PreservedDataEntry[]; // 旧轮次 task_result 的 generation_context.data
}

interface PreservedDataEntry {
  turn: number;
  agent: string;   // task_result 的 source(如 "onchain_data" / "trade")
  data: JsonObject; // generation_context.data 原样保留
}
```

新增方法:`recordPromptTokens(tokensIn: number)`、getter `compactionCache()`、`setCompactionCache(cache: CompactionCache)`。

### 4.2 触发判断

每次 orchestrator 主 LLM 调用(`metadata.mode === "orchestrator"`)结束后:

```typescript
state.recordPromptTokens(completion.metrics.tokens_in);
```

新一轮开始(`run()` 顶部,beginTurn 之后、step 循环之前):

```typescript
const ratio = (state.lastPromptTokensIn ?? 0) / ORCHESTRATOR_CONTEXT_WINDOW_TOKENS;
if (ratio >= COMPACTION_THRESHOLD_RATIO) {
  const targetThrough = turn - 1 - COMPACTION_KEEP_RECENT_TURNS;
  const from = (state.compactionCache()?.summarizedThroughTurn ?? 0) + 1;
  if (from <= targetThrough) {
    await compact(state, from, targetThrough, modelRouter);
  }
}
```

判断依据是"上一轮"的真实 `tokens_in`,因此存在一轮滞后——可接受,增长是渐进的。

---

## 5. 压缩算法 `compact(state, from, targetThrough, modelRouter)`

1. 遍历 `state.allEvents()` 中 `turn ∈ [from, targetThrough]` 且非 sidechain 的事件:
   - `user_message` / `reply(final=true)` → 拼成文本块 `Turn X:\nUser: ...\nYou: ...`,作为摘要 LLM 调用的输入。
   - `task_result` → 取 `generation_context.data`(若有)→ push 进新的 `PreservedDataEntry[]`。**`generation_context.prompt` 与 `artifacts`(图表引用)直接丢弃**,不进摘要输入、不进 preservedData。
2. 调用一次 LLM(`modelClass: "SMALL"`):
   - 输入 = 已有 `summaryText`(若无则空)+ 第 1 步拼出的新文本块。
   - system prompt:"在已有摘要基础上合并新增对话内容,产出更新后的简洁摘要,聚焦用户的意图/偏好/已确认结论;不要复述具体数值数据(已单独保留)。"
3. 更新缓存:
   ```typescript
   state.setCompactionCache({
     summarizedThroughTurn: targetThrough,
     summaryText: <LLM 输出>,
     preservedData: [...(prev?.preservedData ?? []), ...newEntries],
   });
   ```
4. `await store?.saveCompaction(sessionId, cache)`(若配置了 Mongo)。
5. **内存裁剪**:从 `state.events` 中移除所有 `turn <= targetThrough` 的事件(含该范围内的 sidechain 事件)。原始事件已在 §3.2 持续写入 Mongo,裁剪不丢数据。

### 图表文件

`artifacts` 中的 chart 是磁盘文件引用(`./charts/*.html`),compact 不删除磁盘文件,只是这些轮次的 artifact 引用不再出现在 prompt 中。

### 裁剪安全性

`task()` / `turnResults()` / `subagentProgress()` / `subagentToolOutputs()` 等派生视图按 `dispatchEventId` 在 `this.events` 中查找。一旦对应轮次被裁剪,这些查询返回 `undefined`/空。这在正常流程中安全,因为可被 compact 的轮次(`<= currentTurn-1-N`)的 `task_result` 早已落地、不会再被这些方法查询(它们只服务于"当前活跃任务"的进度跟踪)。实现时补充一个测试用例验证此假设。

---

## 6. Prompt 渲染变化

`projectForPrompt(turn)` 内部读取 `this.compaction`(若存在)。由于压缩后的轮次事件已从 `this.events` 物理移除,现有的 `visible.filter(e => e.turn < turn)` 循环自动只剩"最近 N 轮 + 当前轮",原有逐事件渲染逻辑(`formatTaskResultLine` 等)**不需要修改**——这些轮次的 `generation_context.prompt`、图表 artifact 行照常完整保留。

唯一改动:当 `state.compaction` 存在时,在 `priorLines` 前插入两段:

```
[EARLIER CONVERSATION SUMMARY]
<summaryText>

[DATA FROM EARLIER TASKS]
- turn 2 (onchain_data): {"inflow": ..., "outflow": ...}
- turn 4 (technical): {"RSI": 58, "MACD": "bullish"}

[RECENT CONVERSATION]
User: ...
You: ...
[dispatch → ...] ...
[xxx result] ...
```

`state.compaction` 不存在时(短会话或未配置 Mongo 但仍可压缩),`conversationSoFar` 渲染与今天完全一致,向后兼容。

---

## 7. 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ORCHESTRATOR_CONTEXT_WINDOW_TOKENS` | `200000` | 主 agent(`LARGE` modelClass)实际使用模型的上下文窗口大小,用于计算 60% 阈值。`anthropicProvider` 默认 `claude-opus-4-8` 为 200k,与默认值一致;若切到 `googleProvider` 的 `gemini-2.5-pro`(1M 窗口),应将此值调到 `1000000` 左右,否则会过早触发压缩 |
| `COMPACTION_THRESHOLD_RATIO` | `0.6` | 触发压缩的占用比例 |
| `COMPACTION_KEEP_RECENT_TURNS` | `3` | 保留完整内容的最近轮数(N) |
| `MONGODB_URI` | `mongodb://localhost:27017/financial-agent` | 持久化连接串;未配置或连接失败时降级为纯内存 |

---

## 8. 已知限制 / 非目标

- 只压缩"较早轮次"的历史;当前轮次(`currentTurnProgress`)内容不受影响——若单轮本身 dispatch 出大量数据导致超限,压缩不会缓解(已知限制,后续可单独评估)。
- `preservedData` 只增不减,极长会话里它本身也可能变大;本期不处理,后续可考虑让旧的 `preservedData` 也并入摘要文本。
- 触发判断基于"上一轮"真实 `tokens_in`,有一轮滞后,可接受。
- 摘要质量依赖 LLM;若摘要遗漏关键的用户偏好/约束,后续轮次可能"忘记"——这是此类方案的固有取舍。
- Mongo 写入是 fire-and-forget,极端情况下(写入失败 + 进程崩溃)可能丢失最后几条事件;不影响内存中的当前会话,只影响"重启后恢复"的完整性。

---

## 9. 验证计划

- 单测:`compact()` 在给定一段 events 后,正确产出 `summaryText`(mock LLM)、`preservedData`(只含 `data`,不含 `prompt`/`artifacts`),并正确裁剪 `state.events`。
- 单测:`projectForPrompt` 在有/无 `compaction` 缓存两种情况下的输出格式。
- 单测:`SessionRegistry.getOrCreate` 在配置 `EventStore`(用内存 mock 实现)时,跨实例 restore 出相同的 `events` + `compaction` + `turn`。
- 集成:起本地 Mongo,跑一段多轮对话(用 `test/crypto_auto_trading_common_scenarios.json` 的场景延展到超过阈值的轮数),验证:
  - 达到 60% 后下一轮触发压缩,`conversationSoFar` 出现 `[EARLIER CONVERSATION SUMMARY]` 段。
  - 压缩后内存 `events` 数量下降,但 `session_events` collection 中对应轮次的事件仍可查到。
  - 进程重启后,同一 `session_id` 再次 `getOrCreate` 能恢复出压缩前的摘要状态,继续对话不报错。
