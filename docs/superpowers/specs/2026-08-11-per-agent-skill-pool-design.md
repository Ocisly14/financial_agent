# 每个 agent 自己的 skill 注册池：subagent 成为一等 skill 消费者

日期：2026-08-11
前置：`docs/superpowers/specs/2026-08-03-skill-contract-design.md`（三级渐进披露、agent 小节下传、allowed-tools 白名单）
      `docs/superpowers/specs/2026-07-30-research-layer-design.md`（research 层，第二个 skill 消费者）
范围：新增 `agent` skill 层；归属声明移到 subagent 注册表；`tools:` 语义从收窄改为授予；
      删除 `agents:` 白名单；新增 `invoke_skill` 工具；拆分 `dcf-valuation`
不在范围：`stock-analysis` / `sector-analysis` 的 `## for:` 小节迁移（推送机制保留）；
      skill 热重载；agent 层 skill 的 `workflow` / `scripts`

---

## 1. 结论

现在只有 orchestrator 和 research 控制器是 skill 的一等消费者。subagent 拿到的是
`dispatcher.ts:199-204` 推送的 `## for: <agent>` 小节——被动、单向、且**只到第二级**：

第三级（references）在生产链路上对 subagent 是断的。`read_skill_reference` 不在
`registerSubagents.ts:18` 的 `defaultTools` 里；即便加进去，`toolAccess.ts:19` 的 category 门
也会拦——它的 category 是 `main`（`skillTools.ts:16`），而 `financial_modeling` 要求
`non_trading`，豁免名单里只有 `ask_user`。

而 `dcf-valuation.md:17` 与 `subagentPrompts.ts:59` 都在指示 financial_modeling 用
`read_skill_reference` 逐阶段取 playbook，`subagent.ts:636` 还专门投影它的输出。三处都假设它可用。
六个 playbook 加 `formulas.md` 在真实链路上从未进过那个 agent 的上下文。

`scripts/xbrl/e2e_test/step8-agent-valuation.ts` 是绿的，但不能作为反证：它在 `:125` 自己注册了
这个工具，在 `:128,145` 把全量 `allowedTools` 直接传给 `runtime.run`，绕开了 dispatcher 的
`resolveAllowedTools` 和 category 门。它证明的是 harness 里能跑。

本设计把 subagent 提升为一等消费者：**它有自己的 skill 池，自己列出、自己判断、自己 invoke**，
并顺带修掉两处让这件事做不成的语义错误（`tools:` 的方向、category 门的粒度）。

四个决定：

| 决定 | 取代 |
| --- | --- |
| skill 归属声明在 subagent 注册表，与 `defaultTools` 并列 | skill frontmatter 的 `agents:` |
| 新增 `layer: agent`，body 即受众 | 靠 `## for:` 在一个文件里区分受众 |
| `tools:` 授予，不收窄 | `dispatcher.ts:309` 的交集 |
| `agents:` 删除 | `dispatcher.ts:208-219` 的白名单拦截 |

贯穿这四条的一个原则：**skill 是指导，不是沙箱**。领域隔离由 `toolAccess.ts` 的 category 门负责，
那道门一动不动；skill 的 frontmatter 不再承担任何"禁止"语义。

## 2. 归属：声明在 agent 侧

```ts
// src/framework/subagent.ts:16
export type SubagentDefinition = {
  name: AgentKind;
  description: string;
  modelClass: ModelClass;
  defaultTools: string[];
  skills?: string[];        // 新增：本 agent 可 invoke 的 agent 层 skill 名
  systemPrompt: PromptTemplate;
  maxToolSteps?: number;
};
```

注册表因此一眼看全一个 agent 能用什么——工具和方法论在同一处声明，不用去 skill 目录里反查谁认领了它。

**registry 不需要"按 agent 查询"。** 归属既然在 agent 侧，清单由 `definition.skills` 逐个
`get(name, "agent")` 取出，不需要 `list("agent")` 再按 agent 过滤一遍——分池由注册表决定，
不由查询决定。registry 唯一要新增的是一个不限层的按名查找，供 §6.2 使用。

## 3. `layer: agent`

```ts
// src/framework/types.ts:21
export type SkillLayer = "topic" | "research" | "agent";
```

解析期约束，全部在 `parseSkillMarkdown` 里抛，与 research 层现有四条同构（`skill.ts:169-211`）：

| 禁止 | 理由 |
| --- | --- |
| 任何 `## for:` 小节 | body 即受众。两种受众挤一个文件正是本设计要拆掉的东西 |
| `agents:` | 归属在注册表。两处声明必然漂移 |
| `workflow:` | workflow handler 拿的是 `Dispatcher`，subagent 没有 |

`tools:` **允许**，见 §4——在授予语义下它有真实含义。

层的可见性不变：orchestrator 的 `validSkills`（`orchestrator.ts:238`）来自 `list()`，默认 topic 层，
所以它看不到 agent 层 skill；反过来 agent 的池由 `definition.skills` 限定，只解析 agent 层。

## 4. `tools:` 从收窄改为授予

### 4.1 现状与证据

`dispatcher.ts:309` 取的是交集，skill 列表只能收窄：

```ts
names = skillTools ? defaultTools.filter((name) => skillTools.includes(name)) : defaultTools;
```

把三个现存 skill 的声明与各自 agent 的池对一遍：

| skill | 声明 | 与池的交集 | 收窄效果 |
| --- | --- | --- | --- |
| `stock-analysis` | 15 | market_data 11/11、market_research 4/4 | 无。列表是两个池的精确并集 |
| `dcf-valuation` | 14 | financial_modeling 13/14 | 无。丢掉的一项是不在池里的 `read_skill_reference` |
| `sector-analysis` | 2 | market_data 1/11、market_research 1/4 | 有 |

三个里两个的列表退化成池的副本——作者写它们时表达的是"这个任务要用到这些"，不是"这次只准用这些"。
`dcf-valuation.md:6` 里那行 `read_skill_reference` 是最直接的证据：写它的人就是想授予，
而收窄语义下它至今是死字。

### 4.2 改动

**dispatcher（orchestrator → agent）**，`resolveAllowedTools`（`dispatcher.ts:283-329`）的
无显式请求分支：

```ts
// 交集 → 并集
let names = skillTools ? [...new Set([...pool, ...skillTools])] : pool;
// ask_user 的剥离移到并集之后
if (!this.userInputAllowed) names = names.filter((n) => n !== "ask_user");
```

显式 `request.tools` 分支的上界同步放宽为"池 ∪ skill"，见 §4.3。

**剥离位置是必须改的，不是顺手。** 现在的剥离作用于 `pool`（`dispatcher.ts:287`）；
若维持原位，skill 列表里的 `ask_user` 会从另一条路径进来，绕过 `userInputAllowed`。
后果是 Research 驱动的无人值守流里，agent 一提问就把那一轮问死在空座位上。

**category 门不动。** `dispatcher.ts:325` 对并集里每个名字照跑 `assertToolAllowedForAgent`。
领域隔离从来不靠 `tools:` 撑着——授予语义下 `market_research` 依然碰不到 trading 工具。

**subagent（FM 自己 invoke）**：`subagent.ts:274` 的 `allowed` 从只读快照改为活集合，
`:332` 的 `buildLoopToolSpecs` 每步从活集合取（它本来就在循环里调）。
`invoke_skill` 成功后并入该 skill 的 `tools:`，同样过 category 门。下一步该 agent 就看得到新工具。

### 4.3 两个错误类删除

授予语义下并集不可能小于池，`NoToolsAvailableError`（skill 的 tools 与池无交集）不再可能发生；
`ToolNotAllowedError`（显式 `request.tools` 超出 skill 列表）的前提是 skill 列表为上界，也没了——
显式请求的上界变成"池 ∪ skill"。`dispatcher.ts:23-31` 两个类连同 `:225-234` 的分支一并清掉，
错误码 `tool_not_allowed` / `no_tools_available` 作废。

### 4.4 对现存 skill 的影响

`stock-analysis`、`dcf-valuation` 零行为变化（并集 = 池）。
`sector-analysis` 文件不改（两个工具都已在池里，授予是 no-op），但 market_data 从 1 个工具
恢复成 11 个。这是有意接受的："只用板块工具"这类引导应写进 skill 正文，
不该靠工具表勒出来。

## 5. `agents:` 删除

与 `tools:` 同一原则。orchestrator 本来就能派给所有注册 agent，"授予"对它是空操作——
所以 `agents:` 要么是收窄，要么什么都不是。

删除 `dispatcher.ts:208-219` 整段、`setSkillAllowance` 的 `agents` 参数、
`orchestrator.ts:373-376` 的传参，以及错误码 `agent_not_allowed`。
`skill.ts:185-196` 的 `agents` 解析与校验一并删除。

接受的代价：DCF 进行期间 orchestrator 可以顺手派个 market_data 去查股价。
这属于跑题，不属于越权，由 skill 正文和 orchestrator 自身判断约束。

## 6. 工具面

### 6.1 `invoke_skill`（新增）

放 `src/framework/skillTools.ts`，与 `createReadSkillReferenceTool` 并列。

- 输入：`{ skill: string }`
- 解析：只认 agent 层（`skills.get(name, "agent")`）；不存在则返回 `skill_not_found`
- 输出：`generation_context.data.content` = skill body，与 `read_skill_reference` 同形，
  好让 `subagent.ts:636` 那类投影统一处理
- 附带：`generation_context.data.tools` = 该 skill 的 `tools:`（无则省略）

**扩容与归属检查都不由工具自己做。** `RegisteredTool.execute` 是纯 `(input) => result`，
既拿不到 runtime 句柄，也不知道调用方是谁——所以它无法判断这个 skill 是否属于该 agent，
也无法改动活集合。两件事都归 subagent 循环：在 `subagent.ts:636` 附近读到
`invoke_skill` 的输出后，先比对 `definition.skills`，通过则并入 `tools`。

工具保持纯粹，判定与扩容集中在一处可查。代价是"不属于我的 skill"这个错误由 runtime 而非工具
产出，错误形状与工具自身的 `skill_not_found` 略有不同——这在错误表里写明。

### 6.2 `read_skill_reference` 改为不限层

`skillTools.ts:28` 的 `skills.get(name)` 用默认 topic 层，agent 层 skill 的 references 取不到。
`SkillRegistry` 新增一个不限层的按名查找，`read_skill_reference` 改用它。

理由：skill 名在 `skill.ts:63` 就是全局唯一键（`skills.set(skill.name, ...)`），
层隔离的是**发现与调用**，references 是文字指导而非能力。放宽的实际后果是
orchestrator 若猜中名字可读到 agent 层的 playbook——那是它本来就该能读的东西。

### 6.3 category 门的豁免

```ts
// src/framework/toolAccess.ts:16
const CATEGORY_EXEMPT_TOOLS = new Set(["ask_user", "invoke_skill", "read_skill_reference"]);
```

论证与该文件现有注释完全同构：这些工具不属于任何领域，category 门是领域隔离
（研究 agent 不得触及交易工具），用它去卡框架能力等于任何 subagent 都别想读方法论。
授予不放在 category 里，而放在池里——由 `defaultTools` 显式声明谁拿得到。

`orchestrator.ts:171` 的 `ORCHESTRATOR_DIRECT_TOOLS` 不变。

## 7. `dcf-valuation` 拆分

### 7.1 `skills/dcf-valuation/` 整个删除

拆分后它只剩两段给 orchestrator 的调度说明，而这两段说的事框架已经说过、且说得更准：

- "每轮带上 model_id 才能保住 working notes" —— **是错的**。notes 是线程作用域的
  （`subagent.ts` 的 `[PROGRESS SO FAR]` 走 `state.subagentToolOutputs({ thread: threadId })`），
  model_id 只是让 agent 预取持久化的模型（`subagent.ts:304`）。dispatch JSON 里根本没有
  model_id 字段（`orchestratorPrompt.ts:130` 只有 agent/task/thread）。
- "问题会自己渲染，别复述""再派一次继续" —— `orchestratorPrompt.ts:37-44` 已经通用地讲了线程，
  包括暂停在问题上的线程怎么续。

一个把通用机制用 DCF 措辞复述一遍、且有一处说反了的 skill，价值撑不起它的存在。
被删掉的 description 里那组触发词（intrinsic value / fair value / fundamentals-based
valuation）折进 financial_modeling 的 registry description，那是 orchestrator 选 agent 时
真正读到的地方。

### 7.2 `skills/dcf-modeling/`（新建，`layer: agent`）

- body = 原 `## for: financial_modeling` 的内容
- `references/01-extraction.md` … `06-valuation.md`、`formulas.md` 从 `dcf-valuation/` 迁入
- body 第 17 行的 ``read_skill_reference (skill: `dcf-valuation`)`` 改为 `dcf-modeling`；
  `references/*.md` 里的同样写法一并 grep 改名

### 7.3 注册

```ts
// src/agent/subagents/registerSubagents.ts
defaultTools: [...FINANCIAL_MODELING_TOOLS, STATEMENT_EXTRACTION_TOOL,
  DCF_PRIVATE_SUBAGENT_TOOL, "financial_search", "ask_user",
  "invoke_skill", "read_skill_reference"],
skills: ["dcf-modeling"],
```

### 7.4 prompt

`subagentPrompts.ts:59` 的 "The methodology lives in the skill guidance attached to your task"
不再成立，改为指向 `[YOUR SKILLS]` 清单与 `invoke_skill`。

`subagent.ts:313` 的 render 变量表新增 `skills`，由 `definition.skills` 逐个
`skills.get(name, "agent")` 渲染成 name + description；未声明 skill 的 agent 渲染为 `(none)`。

**连带改动**：`SubagentRuntime` 现在是 `new SubagentRuntime(modelRouter, toolRegistry)`，
手上没有 `SkillRegistry`。加第三个可选参数，缺省时清单渲染为 `(none)`。
`createApp.ts:38` 与 `step8-agent-valuation.ts:129` 两处构造跟着改。

## 8. 启动期校验与错误处理

新增 `assertSubagentSkills(subagents, skills)`，在 `createApp.ts:41` 加载完 skills 后调用一次：
每个 agent 声明的每个 skill 名必须存在且 `layer === "agent"`，否则抛，进程起不来。

理由同 `skill.ts:58-62` 那条 name/目录不匹配的抛法——一个静默消失的 skill 是最难查的一类问题，
宁可开不了机。

运行期错误：

| 场景 | 产出方 | 行为 |
| --- | --- | --- |
| `invoke_skill` 名字不存在或不是 agent 层 | 工具 | 返回 `skill_not_found` |
| 该 skill 不在调用方 `definition.skills` 里 | subagent 循环（§6.1） | 记为工具错误 `skill_not_allowed`，消息列出该 agent 可用的 skill 名，body 不进上下文 |
| skill 的 `tools:` 含未注册工具名 | subagent 循环 | 该名字跳过并记 warn；其余工具照常并入 |
| skill 的 `tools:` 含 category 不符的工具 | subagent 循环 | 同上，跳过并记 warn |

后两条不失败整个任务：一个 skill 多声明了一个用不上的工具，不该让 DCF 整轮报废。

## 9. 测试

修改：

- `src/framework/__tests__/skillLayer.test.ts` — agent 层三条解析约束
- dispatcher 用例 — 交集改并集、`ask_user` 剥离位置、两个错误类删除后的路径
- `src/framework/__tests__/stockAnalysisSkill.test.ts` — `agents:` / `tools:` 断言
- `skills/__tests__/englishOnly.test.ts` — 纳入 `skills/dcf-modeling/`

新增：

- `invoke_skill`：正常返回 body、未知名、越权名（不在 `definition.skills` 里）
- 扩容生效：invoke 之后下一步的 `buildLoopToolSpecs` 含新工具；category 不符的被跳过
- category 豁免：`financial_modeling` 能解析 `invoke_skill` / `read_skill_reference`
- 启动期校验：agent 声明不存在的 skill、声明 topic 层 skill，两种都抛

`scripts/xbrl/e2e_test/step8-agent-valuation.ts` 改走生产路径：注册 `invoke_skill`、
`SubagentRuntime` 传入 skills、definition 带 `skills: ["dcf-modeling"]`、
task 里不再手工拼 `[SKILL GUIDANCE]`（`:118,141` 删除）。它从此测的是真链路，
而不是自己搭的那套。

## 10. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/framework/types.ts` | `SkillLayer` 增 `"agent"` |
| `src/framework/skill.ts` | agent 层解析约束；删除 `agents:` 解析 |
| `src/framework/subagent.ts` | `SubagentDefinition.skills`；活工具集合；`skills` render 变量；构造参数 |
| `src/framework/skillTools.ts` | 新增 `invoke_skill`；`read_skill_reference` 不限层 |
| `src/framework/dispatcher.ts` | 交集→并集；`ask_user` 剥离位置；删 `agents` 白名单与两个错误类 |
| `src/framework/toolAccess.ts` | 豁免名单增两项 |
| `src/framework/orchestrator.ts` | `setSkillAllowance` 不再传 `agents` |
| `src/agent/createApp.ts` | `SubagentRuntime` 传 skills；调用 `assertSubagentSkills` |
| `src/agent/subagents/registerSubagents.ts` | FM 的 `defaultTools` 增两项；`skills: ["dcf-modeling"]`；description 收编触发词 |
| `src/agent/prompts/subagentPrompts.ts` | FM 的 HOW TO WORK 段改写；新增 `[YOUR SKILLS]` |
| `skills/dcf-valuation/` | 删除 |
| `skills/dcf-modeling/` | 新建 |
| `skills/stock-analysis/`、`skills/sector-analysis/` | 删 `agents:`（新解析器会抛） |
| `scripts/xbrl/e2e_test/step8-agent-valuation.ts` | 改走生产路径 |

## 11. 不做的事

- **`stock-analysis` / `sector-analysis` 不迁移。** 它们的 4 个 `## for:` 小节继续走
  dispatcher 推送。market_data / market_research 是单次取数，没有 DCF 那种多阶段逐步取
  playbook 的需求，强制它们多一次 invoke 只是开销。两套机制共存，各有正当理由。
- **推送机制不标记为待废弃。** 上一条即理由——它不是过渡态。
- **agent 层不支持 `workflow` / `scripts`。** 没有需求，且 workflow handler 需要 dispatcher。
- **skill 生命周期不变。** orchestrator 侧仍是单 turn（`dispatcher.ts:83-90` 的注释）；
  agent 侧的 invoke 在该次 run 内有效，resume（新 dispatch）需重新 invoke。
