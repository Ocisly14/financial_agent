---
title: SessionState — Claude Code 风格的事件日志（三 agent 共享黑板）
date: 2026-05-10
status: spec
---

# SessionState 设计

## 0. 范围

引入一个 `SessionState`，让 Communication / Execution / Supervisor 三个 agent 的所有读写都通过它走。

**仅设计 state 数据结构与读写 API**。流程编排（`/ws` handler 推进 phase 的逻辑）后续会重写，**不在本 spec 范围内**；agent 类无状态化的具体方法签名跟随编排重写一起做，本 spec 不展开。

## 1. 设计动机与约束

四个动机：

1. **可读性 / 可维护性**：移除 `app.py` 中散落的会话级局部变量
2. **可观察 / 可调试**：单一 append-only 事件流，任意时刻可 dump 完整快照（仅承担"对话与决策"的领域可观察性，不承担基础设施异常审计——后者归 stderr / Sentry）
3. **可扩展**：未来加第 4、第 5 个 agent 不改 schema
4. **持久化友好**：现阶段内存对象，未来直接映射 Postgres `events` 表

约束：
- 现阶段不实现持久化（后续上 Postgres）
- 项目不写测试，但写入入口的轻量 runtime 校验是必须的（避免脏数据滑入历史）
- WS 帧格式保持不变；snapshot dict 与 WS 帧是两套独立形态
- agent 类**完全无 session 状态**——`self.history` / `self.client` / `self.send` 全删

## 2. 设计参考：Claude Code 的 session 持久化

Claude Code 把每个会话写到 `~/.claude/projects/<project>/<session-id>.jsonl`，每行一个事件。从真实日志归纳出的关键决策：

- **单一 append-only JSONL = 唯一真相**；agent 视角是查询时的派生视图，不是物理分桶
- 每条事件强制带通用信封：`uuid / parentUuid / sessionId / timestamp / type / isSidechain / version / cwd / gitBranch`
- type discriminator + 内嵌结构：`type ∈ {user, assistant, system, attachment, file-history-snapshot, ...}`
- `tool_use` 与 `tool_result` 各自一条事件，靠 `tool_use_id` 链接（不嵌套）；tool_result 在 LLM 视角下表现为"user-side 输入"，**不另立"工具 agent"**
- 子 agent（`Task` / `Agent` 工具产生）同流写入，靠 `isSidechain=true` 区分

本 spec 把这套结构搬过来，按 Execu-AI 三 agent 的语义命名。每个 LLM agent 的输出统一拆成 `context`（文本）+ 一个结构化效果（dispatch / tool_use / verdict），输入按消费者归属（customer 输入归 communication，tool_result 归 execution）。

## 3. 顶层结构

```python
@dataclass
class SessionState:
    session_id:    UUID                                 # 连接建立时分配 (uuid4)
    started_at:    datetime                             # UTC
    version:       str                                  # state schema 版本（"1"），未来字段演进保留位

    events:        list[Event]                          # ◀══ 单一 append-only 事件流（唯一真相）

    pending_confirmation: dict | None                   # 状态机字段（不是事件）：上一轮 agent_dispatch payload 缓存
    phase_status:  dict[str, AgentStatus]               # 实时镜像（LLM agent → status/message/ts；customer 无 phase）

    send:          Callable[[dict], Awaitable[None]]    # WS 推送回调（不进 snapshot）


@dataclass
class AgentStatus:
    status:    Literal["idle", "active", "waiting", "done"]
    message:   str
    timestamp: datetime
```

**模型调用不走 state**。所有模型调用统一通过 `core/share/generator.py::generate_text(GenerationOptions)`——它内部封装 client 创建、env key 解析、retries、provider fallback。Execution AI 的工具循环也建立在 `generate_text()` 之上（解析模型文本输出 → 跑工具 → 把结果拼回 context → 再 generate_text），属编排范畴，state 不感知。state 只持会话数据，不持任何 SDK 客户端。

序列化时只有 `session_id / started_at / version / events / pending_confirmation / phase_status` 进入 dump。`send` 是基础设施，不进 state 持久化形态。

## 4. Event 形状

```python
SOURCE = Literal["customer", "communication", "execution", "supervisor"]

@dataclass
class Event:
    # ── 通用信封（借自 Claude Code）──
    event_id:        UUID                # 本事件唯一 ID
    parent_event_id: UUID | None         # 指向前驱事件（同 Claude Code 的 parentUuid）
    session_id:      UUID                # 冗余字段，方便未来跨会话查询
    timestamp:       datetime            # UTC 带时区
    source:          SOURCE              # 这条事件属于哪个对话历史（**不是**"由谁产生"）
    kind:            str                 # discriminator
    is_sidechain:    bool = False        # 预留：未来子 agent 标记

    # ── 类型特定字段 ──
    payload:         dict                # kind 决定 payload schema（见 §5）
```

**关于 `source` 的语义**：customer 不是 agent，是人类输入源；3 个 LLM agent 是 communication / execution / supervisor。字段名取 `source` 而非 `agent` 就是为了避免把 customer 混称成 agent。`source` 表示"这条事件归属哪段对话历史"，外部输入按消费者归属——`customer_message` 归 communication 的对话历史里？不——customer 单开一类，仅持 `customer_message`；comm 投射对话时跨 source 拉。tool_result 归 execution（exec 工具循环的 user-side 输入），**不另开 `tool` source**——和 customer 不对称是有意的：customer 跨整个会话存在，tool_result 仅在 exec 某一轮上下文里有意义。

**为什么 payload 用 dict 而不是带类型判别的 dataclass 子类层级**：

- 与 Claude Code 的 JSONL 实际形态一致，未来落库零形变
- 字段演进灵活：加新 kind 不必改 Python 类型层级
- 调试 / 前端推送 / SQL 都可直接 `dict ↔ json` 互转

代价：`payload[key]` 没有静态类型保护。靠"§5 列出每个 kind 的 payload schema"+ 写入入口（§6 的 `record()`）做轻量 runtime 校验兜底。

`parent_event_id` 织出因果链——典型一轮：`customer_message → comm context → comm agent_dispatch → pre_exec_verdict → hard_rule_verdict → exec tool_use → pre_tool_verdict → exec tool_result → exec context → final_verdict → comm context`。任何子树都能按链回放，包括分叉（`pending_confirmation` 复用上一轮的 `agent_dispatch` 时，新一轮 events 的 parent 指回上一轮）。

## 5. (source, kind) 全集

下表列出所有合法事件类型与 `payload` 必含字段。所有 `payload` 内字段都不重复装信封字段（ts / source / event_id 等）。

每个 LLM agent 对应"文本输出 + 一个结构化效果"两类 kind；customer 仅持人类输入。

### 5.1 customer

| kind | payload | 说明 |
|------|---------|------|
| `customer_message` | `{ content: str }` | 客户每次发出一条消息（文本/语音转录）|

### 5.2 communication

| kind | payload | 说明 |
|------|---------|------|
| `context` | `{ content: str }` | 说给客户的话（覆盖原 fast_reply / filler / confirm / clarify / escalate / block_message / wrap_up / tool_commentary / patience_message / escalation_message 等所有"对客说话"语境，靠时序与上下文区分用途）|
| `agent_dispatch` | `{ target, content }` | 路由到下游 agent + 任务描述。极简两字段：comm 不再在 dispatch payload 里塞决策元数据（intent / confidence / hard_rule_flag / order_id 等），那些信息要么由下游 agent 自己从 `content` 里再解析，要么由 supervisor 在自己的 verdict 事件里独立持有 |

`agent_dispatch.payload` 字段：

```python
{
  "target":  "execution",   # 当前固定，预留多 target 扩展
  "content": str,           # 任务描述（下游 agent 看到的 user-side 输入）
}
```

### 5.3 execution

| kind | payload | 说明 |
|------|---------|------|
| `context` | `{ content: str }` | 给 communication 的回话文本（原 final_response）|
| `tool_use` | `{ tool_use_id, name, input }` | 工具调用发起 |
| `tool_result` | `{ tool_use_id, result, api_call, db_changes, started_at, finished_at, success }` | 工具调用结果（runtime 回包，归 exec 名下作为其 user-side 输入）|

`tool_result` 是工具 runtime 写入而非 exec LLM 写入，但归 source=execution——它在 exec 的上下文中扮演 user-role 输入。pre_tool_verdict 拦截时**不写 tool_result**，靠 supervisor 的 `pre_tool_verdict {approved:false, reason}` 表达；ToolCallView 配对时按 tool_use_id 同时读这两个流。

### 5.4 supervisor

| kind | payload | 说明 |
|------|---------|------|
| `pre_exec_verdict` | `{ approved, risk, reason }` | pre-execution checkpoint |
| `pre_tool_verdict` | `{ tool_use_id, approved, risk, reason }` | pre-tool checkpoint（每次 tool_use 前；approved=false 时同时充当原 tool_blocked 的角色）|
| `hard_rule_verdict` | `{ allowed, action, risk, triggered_rule, reason, message, preferred, shipping_free, deduct_shipping, all_checks }` | 规则引擎裁决（语义归到 supervisor）|
| `final_verdict` | `{ approved, risk_level, checks, action, notes }` | 终检 4 项合规检查 |

> **不再单设 system source**。基础设施异常（LLM API 全挂、未捕获 KeyError、WS 断开）由编排器最外层 try/except 兜底后让 comm 输出"系统繁忙"性质的 `context`——事件流里仍是一条 communication/context；底层 traceback 进 stderr / Sentry，不进 events。**软/硬超时同理**：comm 自然会发 patience / 转人工 `context`，时间戳间距已经表达了"超时发生在哪里"。
>
> 如果编排器在能 dispatch 兜底 context 之前就死掉（asyncio task 被 cancel 等），事件流会戛然而止——这是设计上接受的代价：events log 定位为对话与决策的领域事件流，不承担基础设施可观察性，那部分由 operational logs 覆盖。

## 6. 写入 API

写操作全部走 `SessionState` 方法，不允许直接 `state.events.append(...)` 或字段赋值。这是为了未来加事件持久化只在方法体里加一行 IO，调用方零改动。

```python
class SessionState:
    # ── 单一通用入口 ────────────────────────────────
    def record(
        self,
        source: SOURCE,
        kind: str,
        payload: dict,
        parent: UUID | None = None,
    ) -> Event:
        """
        构造 Event：自动 stamp event_id（uuid4）、ts（datetime.now(UTC)）、session_id；
        parent 不传时默认指向 events 末尾事件的 event_id（None 表示首事件）。
        append 到 self.events，返回事件本身（调用方常需要 event_id 给后续 parent 用）。

        轻量 runtime 校验：
        - source 必须在 SOURCE 枚举内
        - kind 必须在该 source 对应的 §5 子表里
        - payload 必含字段缺失时抛 ValueError（fail-fast）
        """

    # ── 复合方法（写事件 + 推 WS 帧）─────────────────
    async def deliver_to_customer(
        self,
        content: str,
        parent: UUID | None = None,
    ) -> Event:
        """
        record 一条 communication/context 事件 + await self.send(chat_message 帧) + asyncio.sleep(0.3)。
        当前 comm.say()+history.append+sleep 的三步合成一步。
        仅 communication 对客户说话——所以不暴露 source 参数。
        """

    async def update_status(
        self,
        agent: Literal["communication", "execution", "supervisor"],
        status: Literal["idle", "active", "waiting", "done"],
        message: str = "",
    ) -> None:
        """更新 self.phase_status[agent] + 推 agent_status 帧。不写事件（默认）。customer 无 phase。"""

    # ── 状态机字段 ─────────────────────────────────
    def set_pending_confirmation(self, payload: dict | None) -> None:
        """设置 / 清除挂起态。payload 通常就是上一条 agent_dispatch 的 payload。"""

    # ── 派生 source 视图 ────────────────────────────
    @property
    def customer(self)      -> SourceView: ...
    @property
    def communication(self) -> SourceView: ...
    @property
    def execution(self)     -> SourceView: ...
    @property
    def supervisor(self)    -> SourceView: ...

    # ── 序列化 ─────────────────────────────────────
    def snapshot(self) -> dict:
        """deep-copy；datetime → ISO 8601 + Z；UUID → str；不含 send。"""
```

`record()` 是唯一的写入入口。所有更细粒度的"业务方法"都建在它之上。例：

```python
state.record("customer",     "customer_message",   {"content": text})
state.record("supervisor",   "pre_exec_verdict",   {"approved": True, "risk": "low", "reason": "..."})
ev_use = state.record("execution", "tool_use",     {"tool_use_id": tid, "name": "process_refund", "input": {...}})
state.record("execution",    "tool_result",        {"tool_use_id": tid, ...}, parent=ev_use.event_id)
```

## 7. SourceView 派生视图

```python
@dataclass
class SourceView:
    state:  SessionState
    source: SOURCE

    @property
    def all(self) -> list[Event]:
        """该 source 的全部事件，按 ts 升序。"""

    @property
    def messages(self) -> list[Event]:
        """文本输出类事件（kind 命中文本类集合，详见实现里的 _MESSAGE_KINDS_BY_SOURCE 常量）。"""

    @property
    def results(self) -> list[Event]:
        """结构化裁决/动作类事件（agent_dispatch / tool_use / verdicts）。"""

    @property
    def tool_calls(self) -> list[ToolCallView]:
        """配对 tool_use + tool_result（仅 execution 非空）；blocked 信息从 supervisor 的 pre_tool_verdict 拉取。"""

    def last(self, kind: str) -> Event | None:
        """最近一条指定 kind 的事件，没有返回 None。"""


@dataclass
class ToolCallView:
    """tool_use + 对应 tool_result 配对后的结构化视图；blocked 来源于 supervisor pre_tool_verdict(approved=false)。"""
    tool_use_id:    str
    name:           str
    input:          dict
    started_at:     datetime
    finished_at:    datetime | None
    result:         dict | None
    api_call:       dict | None
    db_changes:     list[dict]
    blocked:        bool                # 是否被 pre_tool_verdict 拒绝
    blocked_reason: str | None          # 来自对应 pre_tool_verdict.reason

    @property
    def duration_ms(self) -> float | None: ...
```

`tool_calls` 视图自动按 `tool_use_id` 配对，使用方拿 `state.execution.tool_calls` 即可一次性获取所有工具调用，不需要自己去 `events` 里找配对。

## 8. 序列化形态

`state.snapshot()` 返回的 dict 形如：

```json
{
  "session_id": "9c3eb5b...",
  "started_at": "2026-05-10T07:23:00.000Z",
  "version": "1",
  "events": [
    {
      "event_id":        "uuid",
      "parent_event_id": "uuid|null",
      "session_id":      "uuid",
      "timestamp":       "2026-05-10T07:23:00.123Z",
      "source":          "customer",
      "kind":            "customer_message",
      "is_sidechain":    false,
      "payload":         { "content": "I'd like a refund for order 112-3456789" }
    },
    {
      "event_id":        "uuid",
      "parent_event_id": "uuid",
      "session_id":      "uuid",
      "timestamp":       "2026-05-10T07:23:01.045Z",
      "source":          "communication",
      "kind":            "agent_dispatch",
      "is_sidechain":    false,
      "payload": {
        "target":  "execution",
        "content": "Customer requests refund for order 112-3456789, reason: damaged on arrival."
      }
    }
  ],
  "pending_confirmation": null,
  "phase_status": {
    "communication": { "status": "idle", "message": "", "timestamp": "..." },
    "execution":     { "status": "idle", "message": "", "timestamp": "..." },
    "supervisor":    { "status": "idle", "message": "", "timestamp": "..." }
  }
}
```

每条 event = JSONL 一行（未来落 Postgres 一对一映射 `events` 表，`(session_id, timestamp)` 联合索引）。

序列化规则：
- `datetime` → ISO 8601 + `Z` 后缀（UTC）
- `UUID` → str
- `send` / `clients` 不出现

## 9. 文件落点

```
core/state.py
  ├── SOURCE (Literal)
  ├── Event (dataclass)
  ├── AgentStatus (dataclass)
  ├── ToolCallView (dataclass)
  ├── SourceView (dataclass)
  ├── SessionState (dataclass + 方法)
  └── _MESSAGE_KINDS_BY_SOURCE / _RESULT_KINDS_BY_SOURCE （SourceView 用的常量集合）
```

单文件足够；类型定义集中。如果未来 `kind → payload schema` 的注册表 / 校验函数膨胀，再拆成 `core/state/__init__.py + events.py` 等。

## 10. 不在范围内（明确排除）

- **流程编排**（`/ws` handler 怎么按 phase 推进）—— 后续重写
- **agent 类无状态化的具体方法签名** —— 跟随编排重写一起做
- **Anthropic API messages 的投影函数** —— 编排重写时再决定具体形态（直接读 events 拼，还是抽纯函数）；本 spec 只保证事件流足够还原任何视角
- **持久化层**（Postgres / Redis / JSONL on disk）—— 本 spec 给未来留口（dataclass 全可序列化、events append-only、`record()` 单一写入入口），但本期实现仅内存
- **测试** —— 项目惯例不写
- **前端 WS 协议变化** —— 本期 WS 帧格式保持不变
- **重连 / session 恢复** —— `phase_status` 镜像设计上支持，但具体握手协议属编排范畴
- **基础设施可观察性**（LLM API 失败、未捕获异常、超时根因）—— 不进 events，归 stderr / Sentry / operational logs
