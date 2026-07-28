# Orchestrator Loop Redesign — Design Spec

**Status:** Design (pending implementation)
**Date:** 2026-06-04
**Author:** victor530914@gmail.com (with Claude)
**Refines:** `docs/2026-05-15-agent-framework-redesign-design.md`（决策 #10：Orchestrator 内核 = LLM Loop）
**Scope:** 只改 orchestrator 内核形态；不动 Dispatcher / Subagent runtime / MCP / Store 协议。

---

## 1. 背景与问题

`2026-05-15` 框架 spec 决策 #10 明确 orchestrator 内核是 **LLM Loop + 类型化 Dispatcher 服务**，§6.4 数据流也是「orchestrator 调 `dispatch` → 拿结果 → LLM 续跑 → 流式回复」。

但当前实现 `src/framework/orchestrator.ts` 把这个 loop 拍扁成了**固定两阶段流水线**：

1. `orchestratorPlanPrompt`（Phase 1）：一次 LLM 调用吐 JSON 计划（`skill` 或 `tasks[]`），计划一次定死。
2. `orchestratorPrompt`（Phase 2）：subagent 跑完后，再一次 LLM 调用把结果合成成回答。

这带来两个具体缺陷：

- **计划一次定死，无法中途再决策**：orchestrator 拿到第一批 task 结果后不能追加任务、不能直接回答、不能反问澄清。
- **dispatch 时没有面向用户的话**：现在 dispatch 只 emit `{type:"dispatch", task, agent}`，`task` 是写给 subagent 的内部指令，没有一句给用户看的状态描述（如「正在获取 BTC 实时价格…」）。前端要么显示内部指令、要么没东西可显示。

## 2. 目标 / 非目标

### 目标
- 把两份 prompt（plan + synthesis）合并成**一份统一 orchestrator system prompt**，由 LLM loop 驱动，拉回 spec 决策 #10 的形态。
- orchestrator 每一轮自主判断：**对用户说什么 / 是否 dispatch / 是否调 skill / 是否调直连工具**。
- dispatch 时**同步产出面向用户的简短状态描述**（`reply` 字段）。
- 保留并行 fan-out（spec 决策 #5）、`generation_context` 协议（spec §6.2）、artifact 嵌入、流式输出（spec 决策 #6）、ask_user 挂起（spec §9.1）。

### 非目标
- 不改 `Dispatcher` / `SubagentRuntime` / MCP / 各 Store 的协议与代码。
- 不改 subagent 的 JSON 选工具协议。
- 不引入原生 function-calling（沿用 JSON 协议，与现有代码风格一致）。
- 不改 CEX 审批流（spec §9.2 保持现状）。

---

## 3. 统一输出协议（每轮一个 JSON）

orchestrator 每一轮读完整历史，输出**恰好一个 JSON 对象**：

```ts
type OrchestratorStep = {
  reply: string;                 // 必填、非空。面向用户的话；dispatch/skill/tool 时=状态描述，终态时=最终回答。可含 Markdown。
  dispatch: null | TaskRequest[]; // 并行 fan-out 的一组 task；保留数组（spec 决策 #5）
  skill: null | string;          // 要调用的 skill 名（独立字段）
  tool_call: null | {            // orchestrator 直连工具（ask_user 等）
    name: string;
    input: object;
  };
};

type TaskRequest = { agent: "execution" | "trade"; task: string };
```

**规则：**
- `reply` 永远存在且非空。
- `dispatch` / `skill` / `tool_call` **三者互斥**——一轮至多一个为非 null。
- 三者全为 null → 本轮即**终态**，`reply` 就是最终回答，loop 结束。
- `dispatch` 是数组，一轮可派多个并行 task。
- `skill` 非 null 时由 runtime 调用对应 code-backed workflow（spec §5.2），其 `task_results` 追加进历史。
- `tool_call` 当前只承载 `ask_user`（人在回路，spec §9.1）；后续主 agent 直连轻量工具（如 `web_search` / `query_memory`）也走这里。

> 与 `2026-05-15` spec §6.1 的差异：spec 把 `invoke_skill` / `ask_user` 都列为主 agent 工具。本设计将 **skill 提升为独立字段**（流程级、产出 workflow SSE，语义比普通工具重），`ask_user` 等保留在 `tool_call`。

### 示例

直接回答（无需后端）：
```json
{"reply":"你好！我是 Financial Agent，可以帮你做加密市场分析。","dispatch":null,"skill":null,"tool_call":null}
```

派发并行 task（注意 `reply` 是给用户的状态描述）：
```json
{"reply":"正在拉取 BTC 实时价格、技术指标和近期新闻，稍等。","dispatch":[
  {"agent":"execution","task":"Fetch current price and 24h metrics for BTC."},
  {"agent":"execution","task":"Compute technical indicators for BTC on 4H and 1D, describe trend, support and resistance."}
],"skill":null,"tool_call":null}
```

调用 skill：
```json
{"reply":"这需要一份完整的多因子分析报告，我来跑一遍。","dispatch":null,"skill":"comprehensive-analysis","tool_call":null}
```

终态（基于历史里的 task 结果写最终回答）：
```json
{"reply":"## BTC 行情\n\nBTC 现价 **$67,420**，24h +3.2%…\n\n{{artifact:1}}\n\n技术面看…","dispatch":null,"skill":null,"tool_call":null}
```

---

## 4. Loop 机制（重写 `OrchestratorRuntime.run()`）

```
run(userMessage):
  把 user message 追加进 transcript
  for turn in 1..MAX_STEPS (安全上限, 建议 6):
    rendered = render(orchestratorPrompt, { history, currentDate, subagents, skills, tools })
    step = parseJson( LLM.generate(rendered) )       // 解析 OrchestratorStep
    emit SSE: reply（见 §5 流式）

    if step.dispatch:
        emit SSE: dispatch × N  （携带 step.reply 作面向用户文案 + task 作内部指令）
        results = dispatcher.dispatch(step.dispatch)        // 并行，沿用现有 Dispatcher
        把每个 [dispatch → agent] task 与 [agent result] summary+generation_context+artifacts 追加进历史
        continue

    else if step.skill:
        emit SSE: workflow_started …
        skillResult = skills.invoke(step.skill, …)          // 沿用现有 SkillRegistry / workflow
        把 skill summary + 其 task_results 追加进历史
        continue

    else if step.tool_call && name == "ask_user":
        emit SSE: user_input_required → 挂起本 turn（转 Transcript 未完成 tool_call，spec §9.1）
        return  // 等用户 POST /user-response 后重装续跑

    else:   // 三者全 null → 终态
        把 reply 作为 assistant 回答写入 transcript
        emit SSE: done
        return { response: reply, … }

  // 触顶保护：到 MAX_STEPS 仍未终态 → 强制以当前历史生成一句兜底 reply 并结束（emit error scope=main 记一笔）
```

**历史（loop context）承载**：沿用 spec §7 的 append-only Transcript Store。每轮的 dispatch、task 结果、skill 结果都作为 `tool_call` / `tool_result` 类条目逐条 append，因此：
- 同一个 user turn 内的多轮 loop 共享同一段递增历史；
- 重启可恢复（spec §7.4）：下一条消息重装 transcript → LLM 续跑；
- 子 agent transcript 仍单独存、主 agent 不读（spec 决策 #15）。

**与现有代码的映射：**
- 删除 `orchestratorPlanPrompt`，删除 `planWithLlm()`、独立 synthesis 调用。
- `buildResponseContext()` 的「把 task 结果格式化」逻辑**保留**，但从「一次性拼 responseContext」改为「每轮把结果追加进 loop 历史」的格式化器。
- `dispatcher.dispatch()` / `SubagentRuntime` / `skills.invoke()` **不动**。

---

## 5. 流式（沿用 spec 决策 #6）

**已实现方案（buffer-then-rechunk）**：每轮 orchestrator 的 LLM 调用**不开 `onToken`**（避免把原始 JSON 逐 token 流给用户）。loop 结束拿到终态 `finalReply` 后，runtime 把整段 `reply` 按空白切词，逐片 emit SSE `token` 事件，再 emit `done`；server 随后发 `final` 带完整 response。
- 优点：provider 无关（不依赖各 provider 是否实现 `onToken`）、状态 `reply` 绝不会混进答案气泡（中间轮的状态只走 `dispatch.note`，不进 `token`）。
- 代价：终态答案的 time-to-first-token 变成「整段生成完再开始流」。这是本次的取舍；后续要真·逐 token 流，可换成对首字段 `reply` 做增量 JSON 解析（设计早期方案，复杂度更高），届时再评估。
- 子 agent 的 token **不进 SSE**；只发结构化 `dispatch` / `progress` / `task_done` / `artifact`（spec 决策 #6、§6.3）。
- `{{artifact:N}}` 嵌入逻辑保留：artifact 跨**整个 user turn**（所有轮次累计）统一编号写进 `[CURRENT TURN PROGRESS]` 的结果行，最终回答里用 `{{artifact:N}}` 占位；编号与 server `final` 的 artifact 列表一致（同 task 顺序、同 per-task artifact 顺序）。

---

## 5b. Subagent 也改成 tool-calling loop（同次落地，对齐 spec §4「无状态 LLM 循环」）

原 `SubagentRuntime.run()` 是「一次性选工具 → 平铺跑完」，同样 drift 了 spec §4。本次一并改成真 loop：

```
subagent.run(): for step in 1..MAX_TOOL_STEPS (=5):
  render(子agent prompt, { task, allowedTools(含可选参数提示), progress })
  → LLM → parseSubagentStep → { action: "call_tool", tool, input } | { action: "finish", summary }
  ├ call_tool: 校验 tool 在 allowlist → toolRegistry.call(tool, { task, ...input }) → 结果/错误追加进 [PROGRESS SO FAR] → 继续
  └ finish:    跳出
  收尾：把所有 tool 输出按原逻辑汇编成 generation_context { prompt(join), data{tool_outputs} } + artifacts
```

- 子 agent 现在能**根据某个工具的返回再决定下一步**、能对工具错误重试/换工具、能给工具传结构化参数（`input` 合并进 `{task,...}`，工具仍按 task 自动兜底）。
- 输出契约不变：仍返回 `{ summary, artifacts, generation_context? }`，report/orchestrator 消费方式不动。
- prompt 改为 loop 形态（`{{progress}}` 注入已调工具及结果）；parse 失败/无 action 一律降级为 `finish`，保证终止。
- `MAX_TOOL_STEPS=5` 兜底。

> 已知遗留：`Dispatcher` 给 `TaskResult.metrics` 填的 `tool_calls`/`llm_calls` 仍是旧的近似值（不反映真实循环次数）。属可观测性 metadata，spec §6.2 允许缺失，本次不阻塞；后续可由 subagent 回传真实计数。

## 5c. 工具层：generation_context 只返回「注入 prompt 的精炼 data」，原始序列落本地 cache

loop 改完后暴露出工具层的老问题：`formatResultLine` 会把 `generation_context.data` 整段 JSON 喂给主 agent，而部分工具把**原始数组**塞进 `data`（甚至塞进 `prompt`），导致主 agent / 子 agent 上下文暴涨。原则改为：**`generation_context.prompt` 是已注入精炼值的自洽文本，`data` 只含 prompt 引用的精炼子集，原始序列写入本地 cache，不进 generation_context**。

新增基建：
- `mcp_tools/shared/rawDataCache.ts` — `cacheRawData(ns,key,data)→path` / `readRawData(ns,key)`，落盘 `RAW_DATA_CACHE_DIR`（默认 `./cache/raw`），best-effort 不阻塞工具。
- `mcp_tools/shared/curate.ts` — `curateRecords(records, keys, cap)`：按字段白名单 + 数量上限裁剪原始记录数组。

逐工具改动（按违规程度）：
| 工具 | 原问题 | 改法 |
|---|---|---|
| `sentiscore_analysis` | prompt 里 `JSON.stringify(result)`（含 1000+ 点 timeSeries）+ data 又存一份 | prompt 改为注入 horizons/perSource/features 精炼值；data 去掉 `timeSeries`；全量 result 入 cache |
| `fear_greed_index_analysis` | prompt 里 `JSON.stringify(analysis)`（含 500 点 history）+ data 全量 | prompt 注入 current/trend/historicalContext/tradingSignal；data 去掉 `history`；全量入 cache |
| `get_orders` / `get_fills` | data 塞交易所原始数组（50+，字段繁多） | data 改 `curateRecords(白名单, cap 25)`；全量原始数组入 cache |
| `whale_alert` | data 含原始 position 对象 + prompt `JSON.stringify(全量 data)` | positions 改 `curateRecords([symbol,value,side],10)`；top20 全字段入 cache |
| `getnews` | articles 同时在 prompt(formattedList) 和 data，重复 | data 去掉 `articles`（prompt 已含）；全量 articles 入 cache |
| `token_metadata_overview` | tokens 最多 100 同时进 prompt+data | data.tokens 截到 25；全量 tokens 入 cache |

未改（已合规）：`get_crypto_price` / 4 个 onchain scalar 工具 / `inflow_outflow`(已裁 5 点) / `token_hourly_metrics` / `price_chart`(图走 artifact) / `get_balance`(≤20 精炼 3 字段) / 3 个 search 工具(≤10 精炼+snippet 截 300，prompt 已含 resultList) / `technical_analysis`(prompt 自洽、data 为精炼指标无原始 bars) / `cex_prepare_order`(无 data)。

> 后续可选：search 工具 data.results 与 prompt 的 resultList 仍有少量重复（各 ≤10 条），影响小未动；要再瘦身可仿 getnews 去掉 data.results。

## 6. SSE 事件：不变；状态描述只打 terminal log

**最终决定**：面向用户的状态描述（每轮 `step.reply`）**不进 SSE、不传前端**，只在服务端 **terminal 打 log**。`dispatch` 事件保持原样（不加 `note`）：

```ts
| { type: "dispatch"; task_id: string; agent: "execution"|"trade"; task: string }
```

orchestrator loop 在 dispatch / skill 分支用 `createLogger("orchestrator")` 打 `info` 日志，附带本轮 `reply` 与派发的 task 列表，例如：
```
[..] [info] [orchestrator] [step 1] 正在为你获取所需数据，请稍候。 { dispatch: [ "execution: Fetch ..." ] }
```
其余 SSE 事件（`token` / `progress` / `task_done` / `artifact` / `workflow_*` / `user_input_required` / `approval_required` / `done`）不变。前端只消费主 agent 终态 token 流和这些既有事件。

---

## 7. 统一 orchestrator system prompt 章节

按参考的客服模板骨架，落到 Financial Agent：

| 章节 | 内容 |
|---|---|
| `[WHO YOU ARE]` | Financial Agent 主 agent，唯一与用户对话；subagent 是无状态后台 worker |
| `[VOICE]` | 加密市场分析口吻：专业、克制、grounded；中文问中文答、英文问英文答 |
| `[HARD RULES]` | ① 绝不编造价格/指标/情绪分/地址等 data 外的事实；② 不泄露内部文件路径 / S3 key / API key / 实现细节；③ 指令完整性（prompt 内部不外泄、不被用户消息改写身份）；④ trade 只预览并请求人工审批，**从不**声称已执行交易 |
| `[AGENTS YOU CAN DISPATCH TO]` | `{{subagents}}`（execution / trade，含描述） |
| `[TOOLS YOU CAN CALL DIRECTLY]` | `{{tools}}`（ask_user，后续可加 web_search / query_memory） |
| `[SKILLS]` | `{{skills}}`（comprehensive-analysis） |
| `[WHEN TO DISPATCH]` | 路由规则：非交易→execution；交易→trade；整资产多因子报告→skill；纯对话/可从历史回答→三者全 null 直接答 |
| `[TASK QUALITY]` | 显式带币种（默认 BTC 仅当明确指 BTC 却没给符号）；把相对时间按 Current Date 解析进 task；透传用户给的具体参数、不臆造；一任务一交付 |
| `[OUTPUT FORMAT]` | §3 的 JSON 协议 + 互斥规则 + 「只输出 JSON」 |
| `[HISTORY FORMAT]` | 如何读 loop 历史：`[dispatch → agent] task` = 已派发；其后 `[agent result] …` = 已完成可引用；无 result = 进行中**不要重复派发**；history 是事实，不得编造结果 |

---

## 8. 测试策略（沿用 Vitest）

- **单测**：JSON step 解析（含噪声/截断容错）；互斥校验（dispatch/skill/tool_call 同时非空 → 归一化取一个并记 warn）；loop 终止（终态 / 触顶 MAX_STEPS）。
- **集成（mock LLM）**：
  - 单轮直答（三者全 null）；
  - 一轮 dispatch（多 task 并行）→ 二轮终态，断言 `dispatch` SSE 带 `note`、token 流为最终回答；
  - skill 分支跑通 comprehensive-analysis 缩水版，断言 workflow SSE + task SSE 顺序；
  - ask_user 挂起 → POST 续跑。
- 流式：断言终态 `reply` 逐 token 流出，状态 `reply` 也能流出且其后出现 `dispatch`。

---

## 9. 落地步骤（写进 implementation plan）

1. 定义 `OrchestratorStep` 类型 + JSON 解析/容错（复用现有 `extractJsonObject`）。
2. 合并统一 `orchestratorPrompt`（§7 章节），删 `orchestratorPlanPrompt`。
3. 重写 `OrchestratorRuntime.run()` 为 §4 的 loop；保留 `dispatcher.dispatch` / `skills.invoke`。
4. 把 `buildResponseContext` 改造成「把 task/skill 结果追加进 loop 历史」的格式化器。
5. 增量 JSON 解析流式 `reply`（§5）。
6. `dispatch` SSE 加 `note` 字段；前端按 `note` 渲染状态（前端改动单列）。
7. MAX_STEPS 触顶兜底 + `error scope=main` 记录。
8. 测试（§8）。

---

## 10. 风险与未决

| 风险 / 未决 | 影响 | 缓解 |
|---|---|---|
| loop 多轮 → LLM 调用变多、确定性下降 | 成本与延迟上升 | MAX_STEPS 上限；`[WHEN TO DISPATCH]` 引导一轮 fan-out 多 task 而非多轮串行；监控平均轮数 |
| 增量 JSON 解析流式 `reply` 实现脆弱 | 终态回答流式可能抖动 | 解析器只对首字段 `reply` 做增量提取；失败则降级为整段 emit |
| 三动作字段互斥被模型违反 | 一轮同时给 dispatch+skill | runtime 归一化（优先级 dispatch > skill > tool_call）并记 warn，不报错 |
| 历史膨胀（多轮 + generation_context.data） | 主 agent context 变长 | 沿用 spec §7.3 compaction：优先压 `generation_context.data`，保 `summary` + artifact 引用 |

---

## Appendix：决策日志（本次）

| # | 决策点 | 选定 |
|---|---|---|
| L1 | orchestrator 内核形态 | 单一 LLM loop，合并 plan+synthesis 两份 prompt（落实 `2026-05-15` 决策 #10） |
| L2 | 每轮决策机制 | 继续用 JSON 协议（不用原生 function-calling） |
| L3 | 输出字段 | `{reply, dispatch[], skill, tool_call}`，三动作字段互斥 |
| L4 | 面向用户状态描述 | `reply` 字段每轮必填；dispatch/skill 时即状态描述，**只在 terminal 打 log**（不进 SSE、不传前端） |
| L5 | 并行 dispatch | 保留数组，一轮可 fan-out 多 task（沿用 #5） |
| L6 | skill 位置 | 独立字段（非 tool_call），保留 workflow SSE 语义 |
| L7 | 流式 | 已实现 buffer-then-rechunk：终态 `reply` 切词 emit `token`；子 agent token 不进 SSE（沿用 #6）。增量 JSON 流式留作后续优化 |
| L8 | 兜底 | orchestrator MAX_STEPS=6 触顶强制终态 + error scope=main |
| L9 | subagent | 同次改成 tool-calling loop（对齐 spec §4），MAX_TOOL_STEPS=5；输出契约不变 |
