# top-down-research —— Research 层 skill 通道与自上而下研究技能

日期：2026-08-04
状态：设计已确认，待实现

## 1. 目标

给 Research controller 建立 skill 通道，并用一个真实技能 `top-down-research` 打通它：从宏观市场判断出发，收敛到几个板块，由用户选定后并行驱动多个 member Topic 在板块内筛选候选，再由用户选定后做深度分析。

这个技能只负责**编排**——三轮的节奏、每轮在哪里停下来问用户、怎么把 N 个板块的结果拼成一个跨板块判断。分析方法论不在它里面：第三轮的单标的深度分析由 Topic 自己 invoke 已有的 `stock-analysis`。

### 1.1 不在本 spec 范围内

- **Topic 层的板块方法论技能**（相对强度怎么算、板块内怎么筛）。本期先交编排层，方法论另开一轮讨论。
- **Research 层的 `references/` 与 `scripts/`**。本技能只有正文 + 一个 `## for: topic` 小节，不需要 `read_skill_reference` / `run_skill_script`。通道建好后再加代价很低。
- **Research 层的 `tools:` / `agents:` frontmatter**。见 §2.5。
- 对 `stock-analysis` 的任何修改。

## 2. 通道设计（框架改动）

### 2.1 `layer:` frontmatter

`createApp.ts:32` 只有一个 `SkillRegistry`，两层共用。不做区分的话，Topic orchestrator 的 `{{skills}}` 会列出这个编排技能——而它一旦被 invoke 就会试图做自己做不到的事（Topic 没有 `ask_topic`）。

新增 frontmatter 字段：

```yaml
layer: topic | research     # 省略时为 topic
```

`SkillDefinition` 增加 `layer: "topic" | "research"`（解析时补默认值，字段非可选）。`SkillRegistry.list(layer)` 与 `get(name, layer)` 按层过滤：Topic orchestrator 只看得到 `topic` 层，Research controller 只看得到 `research` 层。`layer` 取值非法时在加载期抛错。

现有 `skills/stock-analysis/stock-analysis.md` 不改，走默认值。

### 2.2 `## for: topic` 小节

`skill.ts:122` 目前对 `## for: topic` 直接抛错，因为 `AGENT_KINDS` 只有三个 subagent 名字。

`SkillDefinition` 新增独立字段 `topicSection?: string`，**不并入 `agentSections`**——member Topic 不是 `AgentKind`，塞进那个 `Partial<Record<AgentKind, string>>` 会让类型撒谎。

`splitAgentSections` 改为同时接受 `topic` 作为小节目标，返回 `{ body, agentSections, topicSection }`。加载期交叉校验：

| skill 的 layer | `## for: market_data` 等 | `## for: topic` |
|---|---|---|
| `topic` | 允许 | 加载期抛错 |
| `research` | 加载期抛错 | 允许 |

两个方向都抛错，而不是静默忽略——一个写错层的小节静默失效是最难查的一类问题。

### 2.3 researchPrompt 的 skill 字段

step JSON 从 `{reply, tool_calls}` 变为：

```json
{
  "reply": "...",
  "skill": null | "<skill-name>",
  "tool_calls": null | [ { "name": "...", "input": { } } ]
}
```

沿用 Topic 层已确立的互斥规则：**`skill` 非空时 `tool_calls` 必须为 null**。理由在这一层比在 Topic 层更强——这个技能的全部作用就是改变 controller 接下来怎么写 `ask_topic`，同一步里写出的 `ask_topic` 必然是没读过它写的。

system 模板新增 `[SKILLS YOU CAN INVOKE]` 段与 `{{skills}}` 占位符，渲染方式与 orchestrator 一致（`formatList`）。技能列表为空时该段渲染为一行"（当前没有可用技能）"，不留空标题。

违反互斥时，记一条 `scope: "protocol"` 的 error 事件并进入下一步——与 orchestrator 的处理一致，且该 scope 已被 `sseProjector.ts:47` 过滤掉，不会让用户看到一个会自愈的错误。

### 2.4 researchRuntime 接线

`ResearchRuntimeDeps` 新增 `skills: SkillRegistry`，由 `createApp.ts` 传入（已有实例，直接复用）。

一个 step 携带 `skill` 时：

1. `skills.get(name, "research")`；查不到则记 `scope: "protocol"` 的 error（消息里列出可用技能名）并进入下一步。
2. `invoke()`。本技能无 `workflow`，返回 `{ status: "loaded", content: body }`。
3. 把结果记成 `skill_result` 事件，正文进入下一步的历史投影——渐进披露的第二级。`renderHistory` 需要认得这个 kind（现有 `sessionState.ts` 的 `projectForPrompt` 已支持，但 Research 有自己的 `renderHistory`，需各自处理）。
4. 把 `topicSection` 交给 `ResearchToolset`（`setTopicSection`），供后续 `ask_topic` 使用。**顺序很重要**：注入必须在 `invoke()` 返回后、下一步开始前完成。

`skill_result` 事件不产生 SSE 帧（`sseProjector` 的 default 分支已经如此）。

### 2.5 明确不做

- **research 层不支持 `tools:` / `agents:`**。controller 的七个工具在 `RESEARCH_TOOL_SPECS` 里，不走 dispatcher，按层过滤要另写一套；本技能也不需要限制工具。`layer: research` 的 skill 写了这两个字段，加载期抛错，而不是静默忽略。
- **research 层不注册 `read_skill_reference` / `run_skill_script`**。这两个工具是 orchestrator 的直接工具，Research 的工具池不含它们，本期不变。

### 2.6 注入落在时间线上（重要）

`ask_topic` 传给 `orchestrator.run` 的文字会**原样成为该 Topic 时间线上的一条 `user_message` 事件**（`tools.ts:352`；`stampOrigin` 正是靠比对这段文字来打 origin 标记）。Topic 层能把技能正文藏起来，是因为 `recordDispatch` 记干净的、只有 subagent 的输入带 `[SKILL GUIDANCE]`；这里没有这个分离——同一段文字既是给 agent 的输入，也是用户在界面上看到的历史。

**决定：接受它，并把 `## for: topic` 小节写成用户的口吻。**

这符合这一层架构自己的逻辑——controller 是用户的替身，它发出的每一句本来就该是用户可能会打的。用户在时间线上读到"每个结论请带上具体读数和日期"不会觉得是系统噪音。

因此：

- 注入格式**不使用** `[SKILL GUIDANCE]` 这种内部标记，而是空行分隔的自然语句。
- 小节措辞必须是第二人称的请求句，不得出现"skill""技能""注入"等内部词汇，不得出现工具名。
- `topic_dispatch` 帧携带的 `task` 与实际发送的文字一致（不做两份），保持时间线与帧的一致。

被考虑并否决的方案：让 `stampOrigin` 的订阅者把 `content` 改写回未注入版本。否决理由是同一轮的后续 step 会重渲染历史，改写后模型将看不到那段指导，除非确认 orchestrator 当前轮用的是 `input.userMessage` 而非回读事件——这会多出一处对既有 agent 内部行为的依赖，而"既有 agent 保持不变"是 Research 这条线的硬约束（`researchRuntime.ts:11`）。

## 3. `top-down-research` 技能

文件：`skills/top-down-research/top-down-research.md`

### 3.1 frontmatter

```yaml
---
name: top-down-research
description: Use when the user wants to work from market conditions down to
  specific stocks — read the macro picture, narrow to a few sectors, then find
  candidates inside the sectors the user picks.
layer: research
---
```

### 3.2 三轮流程

跨三个**用户轮次**，每轮以用户决策收口。

**第一轮 · 宏观 → 板块候选**
复用或新建一个宏观 Topic，让它判断当前占优的板块，并**连可交易的代理代码一起交回**。controller 收敛成三个左右候选，结束本轮并请用户选择。

**第二轮 · 板块内筛选（并行）**
用户选定后，每个板块对应一个 member Topic，在**同一步内**并行 `ask_topic`。每个 Topic 只做筛选——候选名单加入选理由，不做深度。controller 汇总成跨板块候选表，结束本轮并请用户选择深入哪几只。

**第三轮 · 深度分析**
落在哪个 Topic 由 controller 现场判断（已有同名 Topic 就用；用户要长期跟踪单只标的就新建）。Topic 自己会 invoke `stock-analysis`，本技能不重复它的方法论。

并发上限恰好是 3（`ASK_TOPIC_CONCURRENCY`），与"三个左右板块"天然对齐；超过 3 个板块时多出的会排队，不会失败。

### 3.3 正文的五条硬约束

按最容易被违反排序：

1. **每一轮必须停在用户决策上。** 模型的默认倾向是一口气跑到底、自己替用户选板块。正文明说：第一轮和第二轮的终点是调用 `ask_user`（该步唯一的工具调用），不得自行决定进入下一轮。
2. **同一轮的板块必须在一步内全部 `ask_topic` 出去。** 分步串行慢三倍，还吃掉 `MAX_STEPS = 6` 的预算。
3. **代理代码只能来自 Topic，且必须经过取数验证。** controller 没有任何数据工具，自己填的 ticker 就是编的。Topic 取不到报价的代码不得进入候选。
4. **先复用后新建，每轮最多一次 `fetch_from_topic` 探查。** 不设上限的话探查会吃光 step 预算。
5. **偏好参考注入值；没有则并进第一轮的 `ask_user`。** 偏好（风险承受、持有期限、已有仓位、回避行业）后续由运行时注入。注入值缺失时，不单开一轮空问卷，而是在第一轮收口的 `ask_user` 里追加风险承受与持有期限两道选择题——与选板块同时提交（§3.4）。

### 3.4 每轮收口的输出形状

前两轮的收口用**已有的 `ask_user` 工具**（`RESEARCH_TOOL_SPECS[0]`，`mcp_tools/user/askUserTool.ts`），不是纯文本提问。它 turn-ending，必须是该步唯一的工具调用，用户的选择通过 `inputResponse` 结构化回到下一轮。

| 轮次 | `reply` | `ask_user` |
|---|---|---|
| 一 | 宏观判断 + 3 个左右板块，每个带代理代码与入选理由 | 题 1：选哪些板块，options = 各板块，`min_selections: 1`、`max_selections: 3`。偏好注入值缺失时追加题 2（风险承受）与题 3（持有期限） |
| 二 | 跨板块候选概览 | 每个板块一道题，options = 该板块的候选标的（label 用代码，description 放一句入选理由） |
| 三 | 完整报告：跨标的结论在前，逐标的依据在后，分歧与未决项收尾 | 无 |

三条来自工具本身的硬约束，必须写进技能正文：

- **每题选项 2-8 个**（`askUserTool.ts:11` `MAX_OPTIONS`）。第二轮跨板块候选常超过 8 个，所以按板块分题——最多 3 个板块正好对上最多 3 道题的上限。
- **一次最多 3 道题**（`MAX_QUESTIONS`）。板块超过 3 个时，第二轮只为用户选中的前 3 个板块出题。
- **`reply` 里不要复述每个选项**，用户在选项卡里已经看得到；`reply` 承载的是判断和依据。

第三轮没有 `ask_user`，收口就是 `tool_calls: null` + 完整报告。`researchPrompt` 已有的"没有 compiling 步骤"规则在这里成立：那一步的 `reply` 就是用户看到的全部。

### 3.5 `## for: topic` 小节

自动追加到每条 `ask_topic` 之后，三轮通用，因此只放跨阶段都成立的约束；阶段差异由 controller 写进指令正文。用户口吻，符合 §2.6：

- 每个结论请带上具体读数和日期，没有读数支撑的判断就不要写。
- 提到任何标的请给出可交易的代码，并确认这个代码取得到行情；取不到就直说取不到。
- 不要给买卖信号，给出维度和依据。
- 只要结论和依据，不要复述过程。

最后一条尤其重要且不可省：被 `ask_topic` 驱动的 Topic 拿到的是 `allowUserInput: false`（`tools.ts:352`），**它无法反问用户**。指令不清或数据取不到时，它唯一的出路就是在答复里说明缺口——正文必须让它知道这条路是被允许的，否则它会去编。

> 这条基于当前行为。member Topic 的提问向上透传是另一份 spec 的内容，与本技能相互独立：透传上线后，"说明缺口"从唯一出路变成两条出路之一，本技能的这段措辞不需要改。

## 4. 错误处理

| 情况 | 行为 |
|---|---|
| `skill` 名不存在于 research 层 | `scope: "protocol"` error，消息列出可用技能名，继续下一步 |
| `skill` 与 `tool_calls` 同时非空 | `scope: "protocol"` error，说明互斥原因，继续下一步 |
| 某个板块 Topic 超时 / 失败 | 该 member 本轮失败，其余不受影响（`concurrency.ts` 现有语义）；controller 必须在收口输出里说明缺了哪个板块，不得用别的板块的数字补 |
| `ask_user` 与其他工具同步调用 | `researchRuntime.ts:268` 已有的守卫拦下，无需新增 |
| `ask_user` 某题选项超过 8 个或超过 3 题 | `askUserTool.ts` 返回 `invalid_user_input_request`，记为失败的 `tool_result`，模型下一步自行修正；技能正文预先约束以避免（§3.4） |
| 宏观 Topic 未能给出可验证的代理代码 | 该板块不进入候选；若候选不足 3 个，如实给出实际数量 |
| 加载期：layer 非法、小节写错层、research 层写了 `tools:`/`agents:` | 启动时抛错 |

## 5. 测试

**单元**

- `skill.ts`：`layer` 默认值与非法值；`## for: topic` 在两层下的允许 / 抛错；`topicSection` 与 `agentSections` 互不污染；research 层写 `tools:` / `agents:` 抛错。
- `SkillRegistry.list/get`：按层过滤，`stock-analysis` 不出现在 research 层，`top-down-research` 不出现在 topic 层。
- `researchRuntime`：step 解析出 `skill` 字段；skill 与 tool_calls 并存时记 protocol error 且不执行任何工具；invoke 后 `skill_result` 进入下一步历史投影。
- `ResearchToolset`：设置 `topicSection` 后 `ask_topic` 发出的文字包含该段；未设置时与今天逐字相同（回归保护）。
- `top-down-research.md` 本身：能被 `loadFromDirectory` 加载，`layer === "research"`，`topicSection` 非空。

**端到端**（沿用既有做法：`SESSION_DB_PATH` 指向 scratchpad，独立端口，绝不污染 `data/sessions.sqlite`）

一轮完整的第一轮：invoke 技能 → 宏观 Topic 被驱动 → 收口 step 的 `tool_calls` 为 null 且 `reply` 含板块候选与一个问题。断言：0 条 protocol error；宏观 Topic 的时间线上那条 `user_message` 含 `## for: topic` 的措辞（验证 §2.6 的决定确实生效且可读）。

## 6. 文件清单

**新建**
- `skills/top-down-research/top-down-research.md`
- `src/framework/__tests__/skillLayer.test.ts`
- `src/agent/research/__tests__/researchSkill.test.ts`

**修改**
- `src/framework/skill.ts` —— `layer`、`topicSection`、分层过滤、加载期校验
- `src/framework/types.ts` —— 若 `SkillLayer` 类型置于此
- `src/agent/research/researchPrompt.ts` —— `skill` 字段、`[SKILLS YOU CAN INVOKE]`、互斥规则
- `src/agent/research/researchRuntime.ts` —— `skills` 依赖、step 解析、invoke 分支、`renderHistory` 认 `skill_result`
- `src/agent/research/tools.ts` —— `setTopicSection` 与 `ask_topic` 的追加
- `src/agent/createApp.ts` —— 把 `skills` 传给 `ResearchRuntime`
- 既有测试中构造 `ResearchRuntimeDeps` / `SkillDefinition` 的地方

**不动**
- `src/framework/orchestrator.ts`、`src/framework/dispatcher.ts`、`src/agent/prompts/orchestratorPrompt.ts`、`skills/stock-analysis/**`
