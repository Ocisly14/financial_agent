# Agent Framework Redesign — Design Spec

**Status:** Revised Spec
**Date:** 2026-05-15 → 2026-06-02
**Author:** victor530914@gmail.com (with Claude)
**Replaces:** Eliza-based orchestration in financial-agent 2.0

---

## 1. Overview

第一性原理重写 financial-agent 的编排层，摆脱 Eliza / LangGraph 的复杂度。核心思想（类比 Claude Code）：

- **一个主 agent**：唯一与用户对话的 LLM 循环，持有会话记忆、RAG/profile 能力与少量常用轻量工具
- **多个子 agent**：每个有不同工具池与 system prompt 的独立无状态 LLM worker，由主 agent 通过 dispatch 调用
- **Skill**：过程性知识（markdown），按需注入主 agent context，描述如何编排子 agent 完成复杂工作流
- **MCP 工具层**：现有 plugin 改造为 MCP tools；具体 MCP server 拓扑在 plugin 架构重构时确定

---

## 2. Goals / Non-goals

### Goals

- 消除 Eliza / LangGraph 带来的复杂度（13-step report workflow 等)
- 明确"工具 / 子 agent / skill" 三种扩展机制的边界，业务团队只在这三处加东西
- 主 agent 的上下文不被子 agent 中间产物污染
- 同 session 对话连贯；跨 session 不自动回放，按需查 RAG / profile
- 重启后主对话 + 异步任务都能恢复

### Non-goals

- 不做跨 agent 持久 state（不试图持久化 LLM 实例）
- 不暴露 MCP server 给外部（短期）
- 不重新设计 CEX 审批流（UX 保持现状）
- 不替换技术栈（沿用 TS / pnpm / DocumentDB / ECS Fargate）
- 不做多副本下的 dispatcher 跨进程协调（短期单容器够用）

---

## 3. 高层架构

```
┌──────────────────────────────────────────────────────────┐
│                    User / Client                         │
│                  (HTTP + SSE 单一通道)                   │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│  L3  Application Layer                                   │
│  - Orchestrator system prompt（含 subagent + skill 描述）│
│  - Subagent 定义（execution / trade）                  │
│  - Skill markdown 文件（report-workflow 等）     │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│  L2  Framework Core                                      │
│  - Orchestrator runtime（主 LLM 循环）                  │
│  - Dispatcher（registry + 并发 + 任务池 + 结果校验）   │
│  - Subagent runtime（子 LLM 循环）                      │
│  - SkillRegistry（描述注入 + 按需加载完整内容）         │
│  - MCP client（连接内部 MCP server）                    │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│  L1  Infrastructure Layer                                │
│  - LLM provider（Anthropic / Vertex / OpenAI）           │
│  - DocumentDB（state stores）                            │
│  - S3（artifacts）                                       │
│  - SSE transport                                         │
│  - 可观测性（logger / metric / probe）                  │
└──────────────────────────────────────────────────────────┘

                   ↕ MCP stdio (per-server child process)

  ┌────────────────────────────────────────────────────────┐
  │                 internal MCP server(s)                 │
  │  web_search, news, sentiscore, technic_analysis, cex,  │
  │  prediction, content_analysis, query_memory, artifacts │
  │  ...                                                   │
  └────────────────────────────────────────────────────────┘
```

### 三层职责

- **L3 Application**：业务可写，所有"这个产品是什么"的代码——subagent 描述、skill markdown、主 agent 角色
- **L2 Framework Core**：框架代码，业务无关；Dispatcher / runtime / registry 不应被业务侵蚀
- **L1 Infrastructure**：可替换底层依赖

---

## 4. 核心组件

| 组件 | 职责 | 类型 |
|---|---|---|
| **Orchestrator** | 主 LLM 循环；唯一对用户输出 token；持有 memory/RAG/profile；可调 `dispatch` / `ask_user` / `invoke_skill` 和少量常用轻量工具（如 `web_search`） | LLM 驱动 |
| **Dispatcher** | Subagent 注册表 + 并行 fan-out + 同步/异步任务池 + 进度事件 + 结果 envelope 校验/错误归一化 | 确定性代码 |
| **SubagentRegistry** | 启动时加载所有 subagent 定义（description / tools / system prompt / model） | 静态注册 |
| **Subagent Worker** | 一次一用的无状态 LLM 循环；返回 JSON 后销毁；不见用户；不访问 MemoryStore/RAG/profile；MCP client 拿到自己声明的工具子集 | LLM 驱动 |
| **SkillRegistry** | 启动时扫 `skills/*/SKILL.md`，读取 YAML frontmatter（name / description / workflow），把 name + description 注入 Orchestrator system prompt；运行期按 `invoke_skill(name)` 注入完整内容；若声明 workflow，则自动执行对应 code-backed workflow 并返回代码生成的执行摘要 | 静态文件 + 可选代码绑定 |
| **MCP Client** | 启动期连接内部 MCP server（stdio），维持 JSON-RPC 连接 | 框架基础设施 |
| **MCP Server(s)** | MCP tools 的承载进程；具体拆分在 plugin 架构重构时确定 | 独立 Node 进程 |
| **TaskPool** | 异步任务存储（DocumentDB），TTL 7 天，状态机 pending/running/done/failed | 持久化 |
| **WorkflowStore** | code-backed workflow 进度存储（steps / task_ids / summary / artifacts），TTL 7 天 | 持久化 |
| **MemoryStore** | 主 agent 会话 memory + 用户 profile + RAG 向量 | 持久化（沿用） |
| **ApprovalStore** | CEX 审批专用，TTL 15min | 持久化（沿用） |
| **SSE Transport** | token 流 + dispatch/progress/user_input_required 事件复用 | I/O 层 |

---

## 5. 三种扩展机制

业务团队只能接触这三个扩展点；不能改 Dispatcher / Subagent runtime / Orchestrator runtime 内部代码。主 agent prompt 属于 application config / product behavior，不作为扩展机制。

| 扩展机制 | 是什么 | 在哪 | 谁可以执行 |
|---|---|---|---|
| **Tool** | MCP 工具（JSON Schema 输入 + 结构化输出） | 内部 MCP server 中 | 任何 agent 都可注册引用 |
| **Subagent** | LLM 循环 + 工具子集 + system prompt + model | `agent-app/subagents/<name>.ts` | 主 agent 通过 `dispatch` 调用 |
| **Skill** | 过程性知识 markdown | `skills/<name>/SKILL.md` + `references/` | **仅主 agent** 可调用 |

### 5.1 Subagent 清单

不按"阶段"切 subagent。现有 plugin 能力重构为端到端 MCP tools（获取数据、分析、画图、返回 artifact），所以非交易任务统一交给 execution agent；交易任务单独隔离为 trade agent。

| Subagent | 描述（注入主 agent prompt） | 工具来源 |
|---|---|---|
| **execution** | 非交易执行；按 task 自主选择并调用端到端 MCP tools，产出摘要、用于主 agent 生成回答的 prompt/data，以及 artifacts。适用于市场分析、情绪分析、技术分析、新闻/社媒/链上研究、内容分析、报告章节生成等 | 非交易 MCP tools（不含 memory/RAG/profile 工具） |
| **trade** | CEX 订单准备（带审批）；适用于"帮我下单"、"挂限价单"。trade agent 只准备订单和触发审批，审批后的执行由后端代码层 handler 完成 | trading MCP tools |

**边界规则**：
- `execution` 覆盖所有非交易任务，不再区分 collector / processor / general-purpose。
- 业务参数写进自然语言 `task`，不单独维护 `params`。
- `tools[]` 是可选 MCP tool 白名单，仅用于主 agent 或 skill 想收窄工具范围时；默认由 execution agent 根据 task 自主选工具。
- `tools[]` 只能在当前 agent 默认工具池内做收窄，不能给 execution 授权 trading tools，也不能给 trade 授权非交易 tools。
- `execution` 返回当前任务生成回答所需的 prompt、注入 prompt 的数据和已生成 artifacts；不直接输出最终用户可见报告。
- 子 agent 不访问跨 session memory、RAG 或 profile；这些上下文由主 agent 负责读取，并在必要时写入自然语言 `task`。
- `trade` 唯一会触发 CEX 审批弹窗的 subagent；用户确认后的订单执行不再回到 LLM，由后端代码层直接完成。

### 5.2 Skill 清单（MVP 首批）

- `report-workflow` — 现有 13 步报告蒸馏；MVP 做成 skill + code-backed workflow，按固定步骤调用 execution tasks 并组装报告，保持现有 workflow 形态
- 其他后续补（new-token-research / portfolio-review / strategy-explain 等）

Skill 文件结构：

```
skills/report-workflow/
├── SKILL.md                  # 含 YAML frontmatter: name / description / workflow?
└── references/
    ├── report-template.md    # 报告章节模板
    └── chart-section-format.md
```

SKILL.md frontmatter 示例：

```yaml
---
name: report-workflow
description: Generate a comprehensive multi-section crypto asset analysis report.
workflow: report-workflow
---
```

Skill 采用 Claude Code 风格：只提供"怎么做"的过程性知识，不是函数 API，不定义参数 schema。用户请求或 scheduler 触发时的资产、日期、语言等上下文通过当前会话消息进入主 agent，再由主 agent 按 Skill 指导拆成自然语言 `TaskRequest.task`。对于 `report-workflow` 这类已有固定流程的能力，Skill 可在 YAML frontmatter 中声明 `workflow`；`invoke_skill(name)` 时 runtime 自动调用对应 application-level workflow 代码，按既定步骤调用 `dispatch` / `execution`，避免让主 agent 临时自由规划完整流程。workflow step list / title / order 等运行时 metadata 由 workflow 代码定义，不写在 Skill markdown 里。workflow 完成后返回代码生成的 summary，说明执行了哪些步骤、产出了哪些 `generation_context` 和 artifacts。未声明 `workflow` 的 Skill 只加载 markdown 内容。

### 5.3 Background Agents / Scheduled Workflows

- `daily-report` — scheduler 触发的每日多资产报告；由独立 background agent 运行，和用户 chat session 解耦。

`daily-report` 不通过 `invoke_skill("daily-report")` 进入普通用户会话。Scheduler 读取配置（资产列表 / 语言 / 时间等）后启动 daily report background agent；该 agent 直接调用 MCP tools，可复用 Workflow Store、Artifact Store、报告模板和 shared tool runner，但不通过 main agent `dispatch` / execution subagent，也不复用主 agent 对话 loop，不自动向用户 chat 发送消息。它可以有自己的 prompt/model。产物写入 Artifact Store / report history / audit log；用户之后询问日报时，主 agent 从 Artifact Store / Workflow Store / RAG 按需读取。

MVP 只把 `daily-report` 作为特例处理，不抽象通用 BackgroundAgentRegistry / scheduler framework；后续出现多个后台 agent 后再统一设计。

---

## 6. 数据流与协议

### 6.1 主 agent 可见的工具

```ts
// 同步派发：阻塞到全部完成
dispatch(tasks: TaskRequest[]) → TaskResult[]

// 异步派发：立即返回 task_id 列表，不等待结果
dispatch_async(tasks: TaskRequest[]) → { task_id: string }[]

// 显式等待异步 task 终态结果；timeout 内未完成则返回 timeout
await_task(task_ids: string[], timeout_ms?: number) → TaskResult[]

// 调用 skill：注入 SKILL.md；若声明 workflow，则自动执行并返回代码生成的执行摘要
invoke_skill(name: string) → SkillResult

// 询问用户（人在回路）
ask_user({
  question: string,
  options?: { label: string; description?: string }[],
  multiSelect?: boolean
}) → user_response

// 主 agent 直连的少量上下文/轻量工具
query_memory(filter: object) → MemoryResult[]
read_profile() → UserProfile
web_search(query: string) → WebSearchResult[]
```

主 agent 拥有 MemoryStore/RAG/profile 访问权，并可直接调用少量常用轻量工具（如 `web_search`）。业务分析、图表、预测、内容分析和交易工具默认通过 `execution` / `trade` subagent 调用；subagent 不直接查询 memory/RAG/profile。

执行模型：
- 默认使用 `dispatch`：主 agent 当前 turn 阻塞等待 task 完成，然后基于 `TaskResult[]` 继续生成回复。
- `dispatch_async` 仅用于长任务、后台任务或多资产批量任务；它只创建后台 task 并返回 `task_id`，不会自动唤醒主 agent。
- 异步 task 完成后只通过 SSE 发 `task_done` / `artifact` 事件；主 agent 只有显式调用 `await_task` 时才把结果带回当前推理流程。
- `await_task` 只返回终态结果；运行中状态由 Task Store 和 SSE `progress` 表达，MVP 不把 `running` 加入 `TaskResult.status`。
- MVP 保留 `dispatch_async` / `await_task` 协议作为未来长任务扩展能力；核心交互优先使用同步 `dispatch`、code-backed workflow 或独立 background agent。

### 6.2 TaskRequest / TaskResult

```ts
type TaskRequest = {
  agent: "execution" | "trade";
  task: string;                  // 自然语言
  tools?: string[];              // 可选 MCP tool 白名单；业务参数写进 task
  timeout_ms?: number;           // 默认 60_000
};

type TaskResult = {
  task_id: string;
  agent: "execution" | "trade";
  status: "ok" | "failed" | "timeout";
  summary: string;               // **必填** — 简述这次 task 产出了什么
  generation_context?: {
    prompt: string;              // 已注入数据的 rendered prompt，用于主 agent 生成本次回答
    data: object;                // 注入 prompt 的结构化数据
  };
  artifacts?: { type: "chart" | "file" | "url"; ref: string; label?: string }[];
  error?: { code: string; message: string };
  metrics?: {                   // 可观测性 metadata；缺失不应导致 task 失败
    ms: number;
    tool_calls: number;
    llm_calls?: number;
    tokens_in?: number;
    tokens_out?: number;
  };
};

type SkillResult = {
  skill: string;
  workflow?: string;
  status: "loaded" | "ok" | "failed";
  summary: string;               // 代码生成，说明加载/执行了哪些步骤和产物
  task_results?: TaskResult[];    // workflow 调用 dispatch/execution 后收集到的结果
  artifacts?: { type: "chart" | "file" | "url"; ref: string; label?: string }[];
  error?: { code: string; message: string };
};
```

Dispatcher 只强校验 `TaskResult` envelope；`generation_context.prompt` / `generation_context.data` 的业务含义由对应 MCP tool 负责。MCP tool 输入/输出仍按自己的 JSON Schema 校验。`execution` 主要返回 `generation_context`；`trade` 通常不返回 `generation_context`，只返回 `summary` / `status`。交易审批详情由 `approval_required.payload` 和 Approval Store 承载。

`SkillResult.summary` 由 workflow 代码生成，不由 LLM 临时总结；它告诉主 agent workflow 做了哪些步骤、哪些 execution task 完成、哪些 artifacts 可用。主 agent 再基于 `SkillResult.task_results[].generation_context` 和 artifacts 生成最终用户可见回复。

`generation_context.prompt` 使用 rendered prompt：MCP tool 负责把本次 task 的数据注入现有报告/分析 prompt 后返回。主 agent 将它作为当前 task 的生成材料，不把它提升为 system prompt。MVP 不引入 prompt template / template engine，也不在 `TaskResult` 协议里加入 `prompt_ref` / `data_ref`；report workflow 这类大流程通过 skill 对应的 code-backed workflow 控制调用顺序和上下文规模。

### 6.3 SSE 事件（用户/前端可见）

```ts
type SSEEvent =
  | { type: "token"; delta: string }                                       // 主 agent token
  | { type: "processing_step"; ... }                                       // 沿用现有
  | { type: "workflow_started"; workflow_id: string; skill: string; workflow: string; title?: string }
  | { type: "workflow_step"; workflow_id: string; step_id: string; title: string; status: "pending" | "running" | "done" | "failed"; pct?: number; note?: string }
  | { type: "workflow_done"; workflow_id: string; status: "ok" | "failed"; summary: string }
  | { type: "dispatch"; task_id: string; agent: TaskRequest["agent"]; task: string } // 主 agent 派任务
  | { type: "progress"; task_id: string; phase: string; pct?: number; note?: string }
  | { type: "task_done"; task_id: string; status: TaskResult["status"]; summary: string }
  | { type: "artifact"; task_id: string; artifact: ... }
  | { type: "user_input_required"; question_id: string; question: string; options?: ... }
  | { type: "approval_required"; approval_id: string; payload: object }    // CEX 审批（沿用）
  | { type: "error"; scope: "main" | "task"; task_id?: string; message: string }
  | { type: "done"; reason: "complete" | "stopped" | "disconnected" };
```

**关键**：子 agent 的 LLM token **不出现在 SSE**。主 agent 的 token + 任务的进度事件复用同一通道。

声明 `workflow` 的 Skill 会额外发 workflow 级 SSE：`workflow_started` / `workflow_step` / `workflow_done`。这些事件用于前端像现有 report workflow 一样单独展示整体流程；workflow step metadata 由 code-backed workflow 定义并发出。workflow 内部每个 execution task 仍然继续发 `dispatch` / `progress` / `task_done` / `artifact`。

### 6.4 典型数据流（用户问 "BTC 怎么样"）

```
User → Orchestrator: "BTC 怎么样"
Orchestrator:
  - 读 memory + RAG
  - 决定并行 fan-out
  → tool_call: dispatch([
      { agent: "execution", task: "分析近期 BTC 新闻与社交热度，返回关键事件、来源和情绪驱动因素" },
      { agent: "execution", task: "运行 BTC 当前情绪分析，返回分数、解释和图表 artifact（如工具支持）" },
      { agent: "execution", task: "运行 BTC 技术分析，覆盖 4H 和 1D 周期，返回趋势、支撑阻力和图表 artifact（如工具支持）" }
    ])
Dispatcher:
  - 3 个 task 同时启动 Subagent Worker（独立 LLM context）
  - SSE: dispatch × 3
  - Worker 跑各自工具池里的 MCP 工具（每个 MCP 调用走 stdio）
  - 各 Worker emit progress
  - 各 Worker 返回 TaskResult { summary, generation_context, artifacts }
Dispatcher:
  - 结果 envelope 校验；非法输出归一化为 failed + error.code
  - SSE: task_done × 3 + artifact 若干
  - 把 3 个 TaskResult 喂回 Orchestrator
Orchestrator (LLM 续跑):
  - 读 summary + generation_context.prompt + generation_context.data
  - 综合写最终回复，token 流
  → SSE: token × N → done
Transcript Store:
  - 全程逐条 append JSONL
```

---

## 7. State 架构

### 7.1 切片原则

按"生命周期 × 作用域"切成独立的 store；不做"巨型 SessionState 对象"。

| Store | 生命周期 | 作用域 | 物理存储 |
|---|---|---|---|
| **Session Store** | 长（可恢复） | 单 session | DocumentDB `sessions`（元数据） |
| **Transcript Store** | 长（同 session） | 单 session | DocumentDB `transcripts`（**append-only**，每条消息/tool_call/tool_result 一个 doc） |
| **Subagent Transcript Store** | 短（TTL 7d） | 单次 dispatch | DocumentDB `subagent_transcripts`；**主 agent 不读，仅调试/审计** |
| **Task Store** | 短（TTL 7d） | 单次 dispatch（含异步） | DocumentDB `tasks`（状态机 + I/O） |
| **Workflow Store** | 短（TTL 7d） | 单次 code-backed workflow | DocumentDB `workflows`（workflow_id / skill / workflow / status / steps / task_ids / summary / artifacts） |
| **Memory Store** | 永久 | 跨 session（按用户/项目） | DocumentDB（profile + RAG 向量） |
| **Settings Store** | 永久 | 4 层合并 | 文件 / DB（managed / user / workspace / session） |
| **Approval Store** | 短（TTL 15min） | 单次 CEX 审批 | DocumentDB（沿用） |
| **Artifact Store** | 永久 | 跨 session | S3 + DocumentDB 引用（图表/报告） |
| **Skill Store** | 永久（按版本） | 全局只读 | 仓库内 markdown 文件 |
| **Runtime State** | 进程级 | 进程 | 内存（Orchestrator 实例、in-flight task map、SSE 连接表） |

### 7.2 Memory 模型

- **同 session**：transcript 全量在 context（受 compaction 约束）
- **跨 session**：不自动回放对话
  - **profile**：用户偏好（关注币种 / 语言 / 交易风格）→ 启动时自动注入 system prompt
  - **RAG**：历史 transcript / 报告 / 文档向量化，按需查（提供 `query_memory(filter)` 工具）
- MemoryStore 由主 agent 拥有；subagent 完全无状态，不直接查询跨 session memory、RAG 或 profile

### 7.3 Compaction

- transcript token 超阈值（建议 70% × model max context）→ 后台用便宜模型摘要最早 N 条消息为一段 system note
- 摘要时优先压缩 `generation_context.data` 中的大字段，保留 `summary` + `generation_context.prompt` 摘要 + `artifacts` 引用

### 7.4 重启恢复

- **主 agent transcript**：JSONL 留库，下一条用户消息触发重装 → LLM 续跑
- **code-backed workflow**：Workflow Store 留存 `workflow_id` / steps / task_ids / summary / artifacts；重连时按 `workflow_id` 恢复 report workflow 进度卡片并重放 workflow SSE
- **异步任务**：worker 启动时扫 Task Store 中 `status=running` 且 `updated_at` 超时的 task → 重启或标 failed；已完成异步 task 不自动唤醒主 agent，等待后续 `await_task` 或用户追问
- **同步任务**：连接断时主 agent 拿到 error，自行决定重试
- **SSE**：客户端用 `last_event_id` 重连，dispatcher 重放未确认事件
- **ask_user 悬挂态**：transcript 重装自然包含未完成的 tool_call，SSE 重发 `user_input_required`

---

## 8. MCP 工具层

### 8.1 MCP server 拓扑

MCP server 具体数量和分类先不在本 spec 固定；在 plugin/action 重构为 MCP tools 时按代码所有权、依赖、部署和故障隔离需要确定。当前框架只要求：

- MCP tool name 全局唯一。
- MCP tool 声明 JSON Schema 输入/输出。
- 工具权限由 agent tool policy / `tools[]` allowlist 控制，而不是由 server 名控制。
- memory/RAG/profile 类工具默认只给主 agent/runtime 使用，不进入 execution 默认工具池。
- trading 执行类工具不暴露给 LLM 直接选择；审批后由后端 handler 调用。

### 8.2 进程模型

- 主 agent 进程在 ECS Fargate 任务内启动；MCP 客户端按配置 spawn 一个或多个 stdio 子进程
- 每个 MCP server 长期运行，通过 JSON-RPC 处理请求
- 一个 MCP server 崩了 → MCP client 重启它（最多 N 次），主进程不受影响
- 共享底层依赖（DocumentDB / S3 / Vertex AI client）通过环境变量传给子进程

### 8.3 工具改造原则

- 现有 plugin/action 层重构为 MCP tools；重构后不再保留 action 作为独立调用概念
- `tools[]` 中使用 MCP tool name；tool name 全局唯一，MCP server 只是部署/ownership 分组，不进入 task 语义
- 输入：JSON Schema（替换原 Zod schema 或用 `zod-to-json-schema` 转换）
- 输出：给主 agent 生成回答所需的 rendered prompt/data + 可选 artifact refs；execution agent 将其封装进 `TaskResult.generation_context`
- 不暴露 `render_chart` 给 LLM——图表绑定在具体业务工具内部确定性产出

---

## 9. 人在回路 & 审批

### 9.1 通用 `ask_user`（非交易场景）

- 主 agent 调 `ask_user` → emit SSE `user_input_required` → turn 挂起
- 用户在 UI 选择 → POST `/user-response/:question_id`
- 后端把用户回答作为 tool_result 写入 transcript → 唤醒 LLM
- 挂起态由 Transcript Store 中未完成的 tool_call 承载，无需新 store

### 9.2 CEX 审批（保留专用流程）

- UX 不变：trade agent 准备订单 → 弹窗 → 用户确认 → 后端执行。
- trade agent 只调用 `cex_prepare_order(spec)`，生成订单预览并写 Approval Store（15min TTL），返回 `approval_id`，后端通过 SSE 发 `approval_required`。
- trade agent 的 `TaskResult` 只返回 `summary` / `status`；`approval_id` 和 `order_preview` 通过 `approval_required.payload` 与 Approval Store 承载，不放进 `TaskResult`。
- 用户点确认 → POST `/approve/:id` → 后端代码校验 Approval Store（approval_id / TTL / user / order hash）→ 直接调用 `cex_execute_approved_order(approval_id)`。
- 执行结果由后端写入 Approval Store / Task Store / Transcript Store，并通过 SSE `task_done` 或 `error` 通知前端。
- 主 agent 不负责解释审批确认，也不在用户确认后再次 dispatch trade 执行第二段；如果用户追问执行结果，主 agent 从 transcript/task/approval store 读取。

---

## 10. 错误处理（沿用现状）

- 外部 API 错误：所有 axios 调用包 `summarizeAxiosError`（沿用 `packages/core/src/utils/axiosErrorSanitize.ts`）
- subagent 失败：返回 `TaskResult { status: "failed", error: { code, message } }`；主 agent 决定是否重试
- schema / envelope 校验失败：返回 `status: "failed"`，并通过 `error.code`（如 `schema_invalid`）区分原因，附原始输出片段供调试
- fan-out 部分失败：主 agent 拿到的是混合数组——某些 ok，某些 failed；skill 模板里规定如何降级
- MCP server crash：客户端重启（指数退避，最多 3 次），期间 tool 调用排队或返回 transient error
- compaction 失败：日志警告，单次 turn 继续；避免重试循环

---

## 11. 流式协议（沿用 + 扩展）

- 沿用现有 token / processing_step 事件，与现客户端兼容
- 新增 `dispatch` / `progress` / `task_done` / `artifact` / `user_input_required` / `workflow_started` / `workflow_step` / `workflow_done`
- `approval_required` 沿用 CEX 现有
- 前端按 `workflow_id` 展示 workflow 级进度卡片，按 `task_id` 把 execution 进度归到对应任务卡片；主 agent token 单独走主气泡
- SSE keep-alive / ALB idle / `last_event_id` 重连配置沿用现状

---

## 12. 测试策略（沿用 Vitest）

- **单测**：Dispatcher（并发 / 异步 / 超时 / envelope 校验 / 错误归一化）；SubagentRegistry；SkillRegistry；MCP client 重启逻辑
- **集成测试**：mock LLM provider；端到端跑 1 个 skill（report-workflow on BTC 缩水版），断言 Workflow Store 状态、workflow SSE + task SSE 顺序
- **smoke tests**：MCP server 启动 + 每个工具至少调用一次
- **e2e**：staging 环境跑 daily-report background agent 和 report workflow workflow，对比新旧输出

---

## 13. 迁移与下线

- **Big-bang**：不与 Eliza 共存；新框架就绪后整体切换
- 切换前在 staging 跑 1 周以上 daily-report background agent + report workflow workflow，比对结果一致性
- 切换时 Memory Store schema 兼容：profile / RAG collection 不动；transcripts collection 新建（旧 messages 保留只读供回看）

### 落地阶段（建议，写在 implementation plan 里）

1. Framework Core 骨架：Orchestrator runtime / Dispatcher / Subagent runtime / MCP client。
2. MCP tool registry + MCP client/server 最小框架：先空壳 echo tool，server 拓扑随 plugin 重构确定。
3. 第 1 个 MCP tool 迁移端到端跑通：返回 `generation_context.prompt/data` + artifacts。
4. execution / trade subagent 注册 + tool policy：execution 访问非交易 tools，trade 只准备订单。
5. 主 agent memory/RAG/profile 接入：主 agent 持有 memory，subagent 禁止访问跨 session memory。
6. Task Store / Workflow Store / Artifact Store / Approval Store 接入。
7. SkillRegistry：YAML frontmatter + optional `workflow` binding + `SkillResult`。
8. report-workflow code-backed workflow：固定 steps、workflow SSE、Workflow Store 恢复。
9. CEX prepare-order dispatch + Approval Store + approval handler 代码层执行。
10. daily-report background agent：scheduler 触发，直接调用 MCP tools，写 Artifact Store / report history。
11. `ask_user` 工具与悬挂态恢复。
12. staging 验证 + Big-bang 切换。

---

## 14. 风险与悬而未决

| 风险 / 未决项 | 影响 | 缓解 / 后续 |
|---|---|---|
| MCP stdio 进程开销 | MCP server 数量未固定，进程数和 RSS 取决于 plugin 重构后的拓扑 | 实现期按工具依赖和部署隔离需求监控并调整 |
| Skill 描述泛滥污染主 prompt | 主 agent system prompt 变长 | 严格 description 字数；定期清理无用 skill |
| execution agent 在大工具池里选错 | 非交易工具数量较多 | system prompt 内分组描述工具；必要时由主 agent / skill 传 `tools[]` 白名单；监控 tool_call 准确率 |
| 大 payload handoff（决策 #23 暂不做） | 多个 execution task 返回 rendered prompt/data 时主 agent context 变长 | MVP 不加 `prompt_ref` / `data_ref`；通过 report-workflow 的 code-backed workflow 控制上下文规模，后续按监控再评估 artifact 引用机制 |
| Multi-replica dispatcher 协调 | 多容器扩展时 in-flight slot 状态不一致 | 短期单容器；未来 Redis or DocumentDB 协调 |
| Settings 合并层数 | 4 层 vs 2 层未定 | 实现期按需要补，不阻塞 MVP |

---

## Appendix A: 决策日志（按时间）

按时间序列记录关键决策。详细背景见 brainstorming 记录（git history）。

| # | 日期 | 决策点 | 选定 |
|---|---|---|---|
| 1 | 05-15 | 项目定位 | 替换当前 financial-agent 框架（big-bang） |
| 2 | 05-15 | 子 agent 定义 | 两类：execution + trade |
| 3 | 05-15 | 主 agent 工具能力 | 持有 memory/RAG/profile，并可直接调用少量常用轻量工具（如 `web_search`） |
| 4 | 05-15 | 子 agent 返回格式 | `TaskResult` envelope；execution 返回 `generation_context.prompt/data` + artifacts；trade 只返回 summary/status，审批详情走 `approval_required.payload` + Approval Store |
| 5 | 05-15 | 并行执行 | 支持，主 agent 一轮可 fan-out 多个 task |
| 6 | 05-15 | 流式输出 | 只流主 agent 的 token；子 agent 发结构化 progress；code-backed workflow 发独立 workflow SSE |
| 7 | 05-15 | 执行模型 | 默认同步阻塞；保留异步协议作未来长任务扩展；异步完成不自动唤醒主 agent，需显式 `await_task` |
| 8 | 05-15 | 记忆模型 | 主 agent 拥有 memory/RAG/profile；子 agent 完全无状态且不直接访问 memory |
| 9 | 05-15 | 迁移路径 | Big-bang 重写 |
| 10 | 05-15 | Orchestrator 内核 | 方案 B：LLM Loop + 类型化 Dispatcher 服务 |
| 11 | 05-15 | 子 agent 实现 | 独立 LLM 实例 + 工具子集 + system prompt + description |
| 12 | 05-15 | TaskPool 存储 | DocumentDB 持久化 |
| 13 | 05-15 | execution 工具子集 | `tools[]` 可选；需要收窄工具范围时由主 agent 在 dispatch 调用里显式列出 |
| 14 | 05-18 | Transcript 存储 | Append-only JSONL（DocumentDB collection） |
| 15 | 05-18 | 子 agent transcript | 持久化但主 agent 不读；调试/审计用 |
| 16 | 05-18 | Memory 模型 | 同 session 完整 + 跨 session profile + RAG |
| 17 | 05-18 | Transcript compaction | 接近阈值自动摘要旧消息 |
| 18 | 05-18 | 重启恢复语义 | 主 agent 对话可恢复 + 异步 task 可恢复 |
| 19 | 05-18 | 子 agent 颗粒度轴 | 不按阶段切；非交易统一 execution，交易单独 trade |
| 20 | 05-18 | execution vs trade 边界 | 按风险与权限分：交易单独隔离，其他端到端 MCP tools 归 execution |
| 21 | 05-19 | 图表生成方式 | 绑定在具体业务工具内部，不暴露独立 render_chart |
| 22 | 05-19 | 现有 plugin 形态 | 多为"端到端"，工具自带数据获取、分析、画图和报告 prompt 组装 |
| 23 | 05-19 | execution task 数据交接 | `generation_context.prompt/data` 内联返回；MVP 不加 `prompt_ref` / `data_ref` |
| 24 | 05-19 | 复杂工作流封装 | Skill = 第三种扩展机制；声明 YAML `workflow` 时 `invoke_skill` 自动执行 code-backed workflow，并返回代码生成的 summary；Workflow Store 持久化进度；daily-report 改为独立 background agent，直接调用 MCP tools；MVP 不抽象通用 background agent framework |
| 25 | 05-19 | Skill 存储 | 仓库内 markdown 文件，YAML frontmatter 声明 name / description / optional workflow |
| 26 | 05-19 | Skill 调用权限 | 仅主 agent 可调用 |
| 27 | 05-19 | 工具实现协议 | MCP；现有 plugin/action 重构为 MCP tools，不再保留 action 调用层 |
| 28 | 05-19 | MCP server 颗粒度 | 不在框架 spec 固定；plugin 重构时按 ownership / dependencies / deployment 决定 |
| 29 | 05-19 | MCP 外部暴露 | 仅内部使用（短期） |
| 30 | 05-20 | MCP server 具体划分 | 暂不固定；当前只要求 MCP tool 注册、schema 和权限策略 |
| 31 | 05-20 | CEX 审批流 | UX 不变；trade agent 只准备订单，用户确认后由后端代码层直接执行 approved order |
| 32 | 05-20 | 通用 Human-in-the-loop | 新增 `ask_user` 工具 |
| 33 | 05-20 | ask_user 挂起态承载 | Transcript Store 未完成 tool_call |
| 34 | 05-20 | 错误处理策略 | 沿用现有 |
| 35 | 05-20 | 流式协议 | 沿用 + 新增 dispatch / task_done / user_input_required / progress / workflow_* |
| 36 | 05-20 | 测试策略 | 沿用 Vitest |
| 37 | 05-20 | 技术栈 | 全部沿用现状 |
| 38 | 05-20 | 迁移路径 | Big-bang |
