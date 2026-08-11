# Skill 层：把加载器补成完整契约，并用一个股票分析 skill 验证它

日期：2026-08-03
前置：`docs/2026-05-15-agent-framework-redesign-design.md` §5.2（Skill 机制的原始设计）
范围：`SkillRegistry` 的完整契约（渐进披露、agent 小节下传、allowed-tools、scripts）、
      `skills/stock-analysis/` 作为第一个真实 skill
不在范围：skill 的可视化管理界面、skill 热重载、`daily-report` 之类的 scheduler 触发路径

## 1. 结论

Skill 层现在是**加载器齐全、契约残缺**：`SkillRegistry` 会扫描 `skills/*/<name>.md`、
解析 frontmatter、把 name + description 注入 orchestrator prompt，但

- `skill.ts:99` 解析出 `body` 之后**就地丢弃**——`SkillResult` 根本没有承载正文的字段；
- `skills/` 目录是空的，`loadFromDirectory` 的 `.catch(() => [])` 让这件事毫无声响；
- 于是 `validSkills` 永远是空集，`orchestrator.ts:268` 的 skill 分支**从未执行过**。

也就是说，今天即便往 `skills/` 里放一个纯知识型技能文件，它的内容也进不了模型上下文。
只有声明了 `workflow` 的 code-backed 那条路是通的。

本设计把这一层补成完整契约，四件事：**正文注入、references 渐进披露、agent 小节下传、
allowed-tools 白名单**，外加受约束的 `scripts/` 执行。然后写一个单标的深度分析 skill，
用它把四件都真实跑一遍。

## 2. 三级渐进披露

整套契约的核心。三级各自的成本与时机：

| 级别 | 何时进上下文 | 载体 | 现状 |
|---|---|---|---|
| description | 常驻 orchestrator prompt | `orchestrator.ts:220` | 已有 |
| 正文 | `skill` 分支执行后的轮次 | `SkillResult.content` → `skill_result` 事件 | 新增 |
| references | 模型显式调用工具时 | `read_skill_reference` | 新增 |

不 invoke 的 skill 只花 description 那一行的 token。正文只在激活后的轮次出现。
references 里的细则（指标误读、参数适用场景）只有模型真的要解释某个指标时才读进来。

**skill 的生命周期是单个 turn。** `skill_invoke` 事件本就属于某个 turn，下一轮用户提问
重新决定要不要激活。否则一个分析框架会悄悄污染整个会话的后续所有 dispatch。

## 3. 文件布局与 frontmatter

```
skills/stock-analysis/
├── stock-analysis.md     # 文件名即 skill 名；frontmatter + 通用正文 + ## for: <agent> 小节
├── references/           # 按需读取，不进初始上下文
│   ├── indicator-playbook.md
│   └── report-template.md
└── scripts/
    └── score.ts          # stdin JSON → stdout JSON
```

```yaml
name: stock-analysis
description: <触发描述，常驻 orchestrator prompt>
agents: [market_data, market_research]    # 这个 skill 允许 dispatch 的 subagent
tools: [get_stock_price, stock_rsi]       # 可选，在 agents 之上进一步收窄
workflow: <可选，保留现有 code-backed 绑定>
```

### 3.1 用 `yaml` 包解析，不再手写子集

现有的 `parseYamlSubset`（`skill.ts:105`）只认扁平的 `key: value`，逐行 `indexOf(":")`
切一刀。碰到 `agents: [market_data, market_research]` 它会返回字面量字符串
`"[market_data, market_research]"`，而 `includes("market_data")` 对这个字符串**恰好为
true**——静默地"看起来能用"，直到某个 agent 名是另一个的子串才出错。

因此引入 `yaml` 依赖，删除 `parseYamlSubset`。运行时依赖从 4 个变 5 个，换掉一类
无法靠测试稳定捕获的静默错误。

### 3.2 启动期严格失败

`loadFromDirectory` 现在对 `readdir` 和 `readFile` 都 `.catch()` 成空，一个写错的 skill
等于"什么都没发生"。改为：目录不存在仍然静默（合法的空状态），但**目录存在而内容
非法时抛错**——frontmatter 缺 name/description、agent 名不在注册表里、`## for:` 指向
未知 agent、frontmatter 声明的 references/scripts 文件不存在，全部启动即失败。

技能文件叫 `<目录名>.md` 而不是固定的 `SKILL.md`：同时打开六个 skill 时，编辑器标签页
显示的是六个不同的名字而不是六个 `SKILL.md`。frontmatter 的 `name` 必须与目录名一致，
否则启动即报错——两处都声明了身份，就不能让它们各说各话。

## 4. agent 小节下传

`dispatch` 的契约是 `{ agent, task }`，task 是一句自然语言（`orchestrator.ts:248`）。
skill 正文里的分析框架要到达 `market_data`，需要一个明确的载体。

技能正文用 `## for: <agent>` 声明定向指导：

```markdown
## for: market_data
先取日线建立基线；技术面至少两个周期。

## for: market_research
只取 30 天内新闻，每条带日期和来源域名。
```

解析期切成 `agentSections: Map<AgentKind, string>`，剩余部分是通用正文 `body`。
`Dispatcher.dispatch` 读取当前 turn 激活的 skill，把 `agentSections[task.agent]` 追加到
task 后面再交给 `SubagentRuntime`。没有对应小节的 agent 不受影响。

选择声明式而非"让 orchestrator 自己转述"，是因为转述会走样，而且走样的方式不可测。

## 5. allowed-tools

frontmatter 的 `agents` / `tools` 在运行时强制：激活 skill 的 turn 内，dispatch 到
未声明 agent 的任务被拒绝，`tool_call` 调用未声明工具同样被拒绝。

这**叠加**在现有的 `toolAccess.ts` 之上，不取代它。`toolAccess` 管的是"哪类 agent 能碰
trading 类工具"这条硬隔离；`allowed-tools` 管的是"这个 skill 的工作范围"。两者都不通过
prompt 约束，都在运行时抛错。

## 6. scripts 执行

新增 orchestrator 级工具 `run_skill_script(skill, script, args)`：

- 路径 `path.resolve` 后必须落在 `skills/<name>/scripts/` 内，否则 `path_escape` 错误
- `spawn(process.execPath, [...flags, scriptPath], { shell: false })`——不经 shell
- 入参走 stdin JSON，出参从 stdout 解析 JSON
- 超时 SIGKILL；非零退出、stdout 非 JSON 都返回结构化错误而不是抛出

安全面收敛到两点：**路径锁在 skill 目录内**，**脚本必须能被超时杀掉**。脚本本身是
仓库里的可信代码，模型只能选择调不调，不能构造被执行的内容。

已知取舍：本项目没有沙箱，子进程仍以服务器同等权限运行。子进程相对同进程 import 的
收益是可超时、可隔离崩溃，不是权限隔离。这一点在评审时已明确接受。

`read_skill_reference(skill, path)` 用同一套路径锁定，只是读文件不执行。

## 7. stock-analysis skill 的内容

单标的深度分析：给定一个 ticker，走完行情 → 多周期技术面 → 新闻面 → 结构化结论。
同时用上 `market_data` 和 `market_research`，能把契约的四件都压到。

通用正文写死三条约束：

1. 每个判断挂一个来自工具返回的具体数值或新闻条目。`get_stock_price` 已返回精确的
   min/max、回撤、均线统计，**禁止自行重算**。
2. 冲突信号必须显式写出（例如日线超买但周线仍在上升趋势），不允许挑一边说。
3. 输出是描述性分析，不是买卖指令——与项目现有 paper/shadow 的定位一致。

`## for: market_data`：

```
先 get_stock_price 拿 250 日 condensed history 建立基线；
看某个历史时段用 window 参数，不要靠放大 historyDays 去够。
技术面至少两个周期：1Day 定方向，15Min/60Min 定入场结构。
RSI 14 / MACD 12-26-9 / BB 20-2，除非用户另有指定。
背离必须两个周期交叉验证后才能报告。
每个指标结果回传时带上 bar_count 和 timeframe。
```

`window` 那一句对应 `getStockPriceTool` 描述里的同一条约束，skill 层再强化一次。

`## for: market_research`：

```
只取 30 天内新闻；每条必须带日期和来源域名。
区分「已发生事实」与「分析师预期」，后者标注机构名。
找不到相关新闻就明说，不要用宏观叙事填充。
```

references：`indicator-playbook.md`（9 个指标的解读细则、常见误读、参数适用场景）、
`report-template.md`（输出结构模板）。

`scripts/score.ts`：输入各指标最新值，输出趋势 / 动量 / 波动三个分项评分加证据列表。
纯函数、确定性、无网络无 IO。它输出维度打分和依据，不输出买卖信号。

## 8. 错误处理

一律返回结构化错误，不抛到 orchestrator 循环之外：

| 情况 | code |
|---|---|
| skill 不存在 | `skill_not_found`（已有） |
| workflow 绑定缺失 | `workflow_not_found`（已有） |
| reference / script 路径穿越 | `path_escape` |
| reference 文件不存在 | `reference_not_found` |
| 脚本超时 | `script_timeout` |
| 脚本非零退出 / stdout 非 JSON | `script_failed` |
| dispatch 到未声明 agent | `agent_not_allowed` |
| 调用未声明工具 | `tool_not_allowed` |
| skill 的 `tools:` 与该 agent 的工具池无交集 | `no_tools_available` |

最后一条不能只写日志：没有工具的 subagent 照样会凭 prompt 编出一段回答并返回 `ok`，
在 session log 里与一次有据可依的成功调用无法区分。对一个以"每个判断挂一个工具返回的
数值"为硬约束的系统，静默退化成编造是最不可接受的失败模式。

唯一的例外是 §3.2 的启动期校验：那里必须抛，因为一个配置错误的 skill 静默消失是最难
查的一类问题。

## 9. 测试

| 层 | 测什么 |
|---|---|
| parser | frontmatter 六字段、`## for:` 切分、agent 名非法报错、目录存在但内容非法必须抛 |
| 路径安全 | `../` 穿越、绝对路径、软链接 → 一律 `path_escape` |
| script | 正常 JSON 往返、死循环触发 SIGKILL、非零退出、stdout 非 JSON |
| 下传 | dispatch 到 `market_data` 时 task 尾部带上对应小节；无小节的 agent 不受影响 |
| allowed-tools | 未声明的 agent 与工具被拒绝，且拒绝发生在调用之前 |
| orchestrator 集成 | `MockLlmProvider` 走 skill 分支 → 断言下一轮 prompt 出现了正文 |
| 生命周期 | 下一个 turn 的 dispatch 不再携带上一个 turn 的 skill 小节 |
| score.ts | 纯函数单测：已知指标输入 → 确定的分项评分与证据 |

最后两条最容易回归：生命周期泄漏和评分漂移都不会让任何现有测试变红，必须各自有专门
的测试盯着。

## 10. 影响面

改动集中在 L1 框架的四个文件加一处应用层注册：

- `src/framework/skill.ts` — 解析、渐进披露、路径锁定、脚本执行
- `src/framework/types.ts` — `SkillResult.content`、新错误码
- `src/framework/orchestrator.ts` — 正文进 history、两个新工具、allowed-tools 校验
- `src/framework/dispatcher.ts` — agent 小节追加
- `src/agent/createApp.ts` — 无需改动，`resolveSkillsPath` 已指向 `skills/`

`package.json` 增加 `yaml` 依赖。现有 3 个 subagent、`toolAccess.ts`、compaction 全部不动。
