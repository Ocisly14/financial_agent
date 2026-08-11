# member Topic 提问向上透传

日期：2026-08-04
状态：设计已确认，待实现

## 1. 目标

让被 `ask_topic` 驱动的 member Topic 能够反问用户，问题以结构化选项的形式出现在 Research 界面上，用户直接点选即可。

今天 `tools.ts:352` 给被驱动的 Topic 传 `allowUserInput: false`，`orchestrator.ts:285` 会记一条协议错误让它"把缺口写进答复"。结果是指令不清时 member 只能猜或者交白卷，用户要么看不到分歧，要么得自己去那个 Topic 里补话。

这是一项**通道能力**，对所有 Research 生效，与 `top-down-research` 技能相互独立（见 `2026-08-04-top-down-research-design.md` §3.5 的前向说明）。

### 1.1 不在范围内

- Topic 层 `ask_user` 本身的行为、`askUserTool.ts` 的校验规则。
- 合并多个 member 的提问。本设计明确允许**多个 pending 并存**，各自独立。
- Research controller 主动向用户提问（`ask_user`）的既有路径，一行不改。

## 2. 架构：提问不搬家

提问始终留在**提出它的那个 member session** 上。Research 层只负责把它报给前端展示；用户提交时，POST 的 `sessionId` 是那个 **member 的 id**，走的是今天已经跑通、一行不用改的恢复路径（`server.ts:184-196`）。

### 2.1 为什么不是"记到 Research session 上再路由"

`userInputViewForEvent`（`sessionState.ts:352`）判断一个提问是否已回答，靠的是**同一个 session 里下一条 `user_message` 的 `response_to`**。把提问记在 Research session 上、而答案拿去恢复 member，这条推导就断了：Research 侧那条记录永远是 `pending`，直到被下一次无关的用户输入标成 `skipped`。

要让它成立就必须改 `userInputViewForEvent` 认跨 session 的应答——而那是 Topic 层与 Research 层共用的核心推导函数，改它等于改既有 agent 的行为，正是 Research 这条线一直守着的硬约束（`researchRuntime.ts:11`）。风险不对称，故否决。

### 2.2 数据流

```
controller ──ask_topic──▶ member Topic
                            │ 调 ask_user，run() 就地结束
                            │ 请求记在 member 自己的 session 上
                            ▼
          ask_topic 读到 needs_input，回报给 controller
                            │
          Research 发 member_input_request 帧（带 member 归属）
                            ▼
                        前端渲染问题卡
                            │ 用户提交
                            ▼
     POST /chat { sessionId: <member topic id>, inputResponse }
                            │ 既有路径，member 正常续跑
                            ▼
              全部答完后，前端 POST 续跑 Research
                            │
      controller 用 fetch_from_topic 取回各 member 补完的答复，继续
```

后端不跟踪"还差几个"——这个状态天然在前端手上，它知道自己渲染了几张卡、收到了几个成功响应。

## 3. 后端改动

### 3.1 允许被驱动的 Topic 提问

`src/agent/research/tools.ts:352`，去掉 `allowUserInput: false`（默认即 `true`）。

`orchestrator.ts:282-285` 那条"agent-to-agent 运行中不可用"的守卫**保留原样**：它由 `allowUserInput === false` 触发，参数不再传 false 之后自然不生效。不删除，因为它仍是 `allowUserInput: false` 这个入参的正确行为。

### 3.2 `ask_topic` 回报 needs_input

`AskStatus`（`tools.ts:120`）新增 `"needs_input"`。`AskTopicResult` 新增可选字段：

```ts
request?: UserInputRequestView;
```

`askTopic` 在 `run()` 返回后，用 member 的 `SessionState.userInputRequestForTurn(turn)`（`sessionState.ts:347`）检测本轮是否留下了提问。`turn` 取 `run()` 之前 `state.currentTurn + 1`——`stampOrigin` 已经拿到了 member 的 `SessionState`，同一处即可记录。

检测到时返回 `{ status: "needs_input", request, reply }`，`reply` 仍是 `run()` 的返回文本（此时通常是 "Please answer the questions below."）。

**`markSeen` 照常执行**：这一轮 member 确实产生了事件，seen marker 不前移的话，下一轮 external delta 会把 controller 自己造成的变化报成"外部变化"。

### 3.3 新的 Research 帧

`ResearchFrame`（`tools.ts:84`）新增变体：

```ts
| {
    name: "member_input_request";
    data: { topicId: string; topicName: string; request: UserInputRequestView };
  }
```

`SSEEvent` 的 `final` 帧**一个字节都不改**——Research 有自己的帧通道（§4.5），`server.ts` 已经在把 `ResearchFrame` 写成 `{type: frame.name, ...frame.data}`。Topic 层单数的 `input_request` 路径完全不受影响。

`askTopic` 在返回 `needs_input` 的同时 emit 这个帧。多个 member 同时提问就 emit 多个帧，各自独立——这正是"允许多个 pending"的实现。

### 3.4 controller 看到什么

`needs_input` 记成一条正常的 `tool_result`，`summary` 写明：该 member 正在等待用户输入，本轮没有给出答复。controller 因此知道这块是缺口，不会把它当成"没数据"而去编。

**controller 不负责等待**。它照常跑完这一轮（其余并行 member 的答复照常入库——`researchRuntime.ts:285` 已经 `await` 了全部），然后按信息不全的现实收口。

### 3.5 续跑那一轮

前端在全部 member 答完后 POST 一条续跑消息到 Research session。这是一次**普通的 Research 轮次**，没有任何新参数、新分支：

- 消息文本由前端固定给出（§4.3），落在 Research 时间线上，用户读得懂。
- controller 在这一轮用 `fetch_from_topic` 取回各 member 补完的答复。它上一轮的历史里有 `needs_input` 的 `tool_result`，知道该去问谁。

技能正文层面不需要为此写任何东西——`researchPrompt` 已有的规则（"想知道 member 说过什么就 `fetch_from_topic`"）已经覆盖。

### 3.6 member 恢复后再次提问

member 的恢复走的是普通 `orchestrator.run`（`server.ts:240`），`allowUserInput` 默认 `true`，所以它可以再问一次。**接受这个行为，不设上限**：这与用户直接和那个 Topic 对话时的行为完全一致，而人为的乒乓上限会在真正需要两轮澄清时把用户卡死。

## 4. 前端改动

### 4.1 帧接收

`useTopicStream.ts` 处理新的 `member_input_request` 帧。既有的 `inputRequest` 挂在消息 metadata 上（`useTopicStream.ts:81`、`ConversationPane.tsx:128`），消息是列表，因此**多张问题卡在结构上已经成立**——每个帧追加一条带 `inputRequest` metadata 的消息即可，额外携带 `topicId` / `topicName`。

### 4.2 卡片提交路由

带 `topicId` 的卡片必须 POST 到**那个 member 的 session**，未带 `topicId` 的卡片行为逐字不变。

> 修正（2026-08-04，写实现计划时实地核对得出）：本节早前写的是"这是前端唯一的实质改动：提交目标从当前 session 换成卡片自带的 session"。**不止如此。** 既有的 `submitUserInput` 走 `runTurn`，而 `runTurn` 会往当前会话追加一条用户消息、清空任务列表并进入 processing 状态——那些都属于 Research 视图自己的一轮，而 member 的提交并没有开启 Research 的一轮。因此需要一条独立的、安静的提交路径，不能只改 `runTurn` 的目标。
>
> 同样修正 §7：`UserInputCard.tsx` **不需要**透传 `topicId`。提交处理函数由 `ConversationPane` 按消息 metadata 选好再传进去，卡片不必知道 session 的存在；它只多一个纯展示用的可选归属标签。

member 的恢复会在它自己的流上产生事件。Research 视图不订阅那条流，因此这次提交在 Research 界面上只需要把卡片标记为已回答。

但 `POST /chat` **总是返回一条 SSE 流**（`server.ts:213`），无论调用方要不要。这次提交必须把那条流读到 `done` 帧为止再算成功——不读就断开会让 member 的续跑在写完之前失去连接。帧内容全部丢弃，只有终止和错误需要处理。这是实现时最容易漏的一点。

### 4.3 续跑触发

前端记录本轮收到的 `member_input_request` 数量。全部提交成功后，自动 POST 一条续跑消息到 Research session：

```
（已回答上述追问，请继续。）
```

固定文案，中文界面下如此；英文界面用对应译文。它是一条正常的用户消息，落在 Research 时间线上。

用户若不答就直接打字：不做任何特殊处理。member 那条提问按既有语义被后续输入标成 `skipped`（`sessionState.ts:362`），controller 在下一轮 `fetch_from_topic` 时看到该 member 没有新内容，按缺口处理。

## 5. 错误处理

| 情况 | 行为 |
|---|---|
| member 提问后 `ask_topic` 超时 | 不可能同时发生：`ask_user` 让 `run()` 立即返回，早于超时 |
| 提交答案时 member 的请求已非 pending | `server.ts:191` 既有的 409，前端把卡片标为已失效 |
| 部分 member 答完、用户关掉页面 | 已答的 member 已经跑完并写进自己的时间线；Research 缺一次续跑，下次用户在 Research 里说任何话时 controller 都能 `fetch_from_topic` 拿到 |
| 续跑 POST 失败 | 前端提示并允许重试；不做自动重试 |
| member 恢复后再次提问 | §3.6，正常渲染新卡片 |

## 6. 测试

**单元**

- `askTopic`：member 本轮留下 `user_input_required` 时返回 `status: "needs_input"` 且带上 `request`；未留下时逐字维持今天的返回（回归保护）。
- `askTopic`：`needs_input` 时 emit `member_input_request` 帧，`topicId` / `topicName` 正确。
- `askTopic`：`needs_input` 时 `markSeen` 仍被调用。
- `researchRuntime`：`needs_input` 的 `tool_result` summary 里说明该 member 在等待输入；其余并行 member 的结果照常入库；本轮照常收口不挂起。
- `tools.ts:352` 不再传 `allowUserInput: false`。

> 注（2026-08-04 更新）：本节早前写的是"该测试当前失败，移除参数后会自然变绿"。那已经过时——`src/agent/research/__tests__/tools.test.ts:167` 的期望值此后被更新为**包含** `allowUserInput: false`，测试现在是通过的。因此本设计移除该参数时，需要把那条期望值改回不含该字段的形式，而不是等它自己变绿。方向反了，别照旧文执行。

**前端单元**

- 带 `topicId` 的卡片提交到该 topic 的 session；不带的提交到当前 session。
- 收到 N 个 `member_input_request` 帧渲染 N 张卡；全部提交成功后恰好触发一次续跑 POST。

**端到端**（`SESSION_DB_PATH` 指向 scratchpad，独立端口，不碰 `data/sessions.sqlite`）

驱动一个 member，让它调 `ask_user`；断言 Research 流上出现 `member_input_request` 帧、Research 轮次正常结束、该 member session 上存在 pending 请求；再以 member 的 sessionId POST 答案，断言它续跑成功且请求状态变为 `answered`。

## 7. 文件清单

**修改（后端）**
- `src/agent/research/tools.ts` —— 去掉 `allowUserInput: false`；`AskStatus` 加 `"needs_input"`；`AskTopicResult.request`；`askTopic` 检测与 emit；`ResearchFrame` 新变体
- `src/agent/research/researchRuntime.ts` —— `needs_input` 的 `tool_result` summary
- `src/agent/research/__tests__/tools.test.ts` —— 既有断言随参数移除恢复通过，另加新用例

**修改（前端）**
- `client/src/hooks/useTopicStream.ts` —— 接收新帧、按 `topicId` 路由提交、续跑触发
- `client/src/components/chat/UserInputCard.tsx` —— 透传 `topicId`（若提交逻辑在此）
- `client/src/types/core.ts` —— 帧与卡片的类型
- `client/src/i18n/locales/en.ts`、`zh-CN.ts` —— 续跑文案与卡片上的 member 归属标签

**不动**
- `src/framework/sessionState.ts`（尤其是 `userInputViewForEvent`）
- `src/framework/orchestrator.ts`、`src/framework/types.ts` 的 `SSEEvent`
- `src/server/server.ts`
- `mcp_tools/user/askUserTool.ts`
