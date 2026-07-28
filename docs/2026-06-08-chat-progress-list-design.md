---
title: 聊天实时进度展示 — 设计 spec
date: 2026-06-08
status: spec
---

# 聊天实时进度展示（progress pill）

## 1. 背景与目标

MVP 聊天现在只显示主 agent 的「最终答案 + 图表」,中间过程(派了哪些子 agent、调了哪些工具、各任务结果)完全不显示。后端(orchestrator + SSE projector)在一轮里**已经发出** `dispatch` / `progress`(subagent_started、`calling <tool>`)/ `task_done` 帧,`StreamingApiClient.sendMessageStream` 也已把每帧翻译成 `onStep(step: ProcessingStep)`(`client/src/lib/api.ts:1264-1318`),但当前 `chat.tsx` 把 `onStep` 设成了空函数。

目标:让用户在每条回复上看到「主 agent 这次干了什么」的实时 + 可回看的进度。

## 2. 设计(经可视化 brainstorm 确认)

**形态:单行状态药丸 + 点开展开列表**,挂在每条助手回复的**顶部**(头像右侧、答案上方)。

三个状态:

| 状态 | 折叠那行显示 |
|---|---|
| 进行中(实时) | `⟳ Running technical analysis · 2/3 ▾`(spinner + **当前任务描述** + `已完成/总数`) |
| 完成(折叠) | `✓ Done · 3 steps ▾` |
| 展开(点 ▾) | 逐任务列表(见下) |

**药丸文字 = 任务描述**(人类可读,如「Running technical analysis」),不是原始工具名,也不是通用阶段词。进行中显示「当前仍在跑的任务」;全部完成显示 `Done`。

**持久化 = 每条回复都保留**:每条历史助手回复都各自挂一个折叠药丸,随时能展开看那条当时干了啥。步骤数据**存在该条消息上**(不是单一全局实时态)。默认折叠。

**展开列表**:每个子任务一行 =
- 状态图标:`✓` 完成 / `⟳` 进行中 / `○` 等待 / `✗` 失败
- 任务描述(主文字)
- 一行灰色小字:`<工具名> · <结果摘要>`,例如 `technical_analysis · RSI 58, MACD bullish`

示例展开:
```
✓ Done · 3 steps ▴
  ✓ Fetching market price       get_crypto_price · BTC $67,420 | 24h +3.2%
  ✓ Running technical analysis  technical_analysis · RSI 58, MACD bullish
  ✓ Generating 30-day chart     price_chart · chart ready
```

## 3. 数据来源与聚合

`onStep` 收到的 `ProcessingStep`(`client/src/types.ts:29-39`)按 `id = task_id` 聚合成「每任务一条记录」。后端一个子任务的事件序列(同一 task_id):

| 事件(name) | 取什么 |
|---|---|
| `dispatch`(data:`{task_id, agent, task}`) | 任务描述 = `data.task` |
| `progress` name=`subagent_started` | 标记任务开始(in_progress) |
| `progress` name=`tool_call`,message=`calling <tool>` | 工具名 = `<tool>` |
| `task_done`,status `ok→completed`,message=summary | 状态 + 结果摘要 |

聚合结果(每任务):`{ taskId, description, tool?, status, summary? }`。
- 药丸 count = 任务数;`已完成` = status 为 completed/error 的任务数。
- 进行中药丸文字 = 最近一个 in_progress 任务的 `description`(没有则 `Done`)。

> 注:`workflow_*` 帧不经过 `onStep`(streaming client 未映射),但 comprehensive-analysis 工作流的各子任务仍走 `dispatch`/`task_done`,照样出现在列表里。工作流级分组不在本设计范围。

## 4. 组件与改动面

只动前端,单文件为主:`client/src/components/chat.tsx` + 一个小组件。

- **每条助手消息存步骤**:`onFinalResponse` 把本轮聚合好的任务记录附到这条 assistant 消息上(消息对象加一个 `steps` 字段,或用与 message id 关联的 Map)。进行中用临时态(in-flight turn 的聚合)。
- **新组件 `ChatProgressPill`**(小,自洽):props `{ tasks, isComplete }`,默认折叠成单行药丸,点击展开/收起列表。状态图标用 `lucide-react`(`Loader2`(spin)/`CheckCircle`/`Circle`/`XCircle`),`cn` + Tailwind 配色,跟随主题。
  - 现有 `StreamingThinkingBubble.tsx` 是「默认展开的大卡片 + 单一实时态」,与本设计(默认折叠的小药丸 + 每条消息一个)不符,因此新写一个轻量组件,不复用它。
- **渲染位置**:在 `renderAssistantBubble` 里,`ChatBubbleMessage` 上方插入 `<ChatProgressPill .../>`(该消息有 steps 时)。进行中那条回复用实时聚合态渲染。

## 5. 验证
- `pnpm --prefix client build`(tsc + vite)通过。
- 起后端 + 前端,发「draw a 30-day BTC chart and analyze the technicals」:
  - 进行中顶部出现 `⟳ <任务> · n/N ▾`,随各子任务推进更新;
  - 答案落地后变 `✓ Done · N steps ▾`,点开看到逐任务列表(图标 + 任务 + 工具·摘要);
  - 发第二条消息,新回复有自己的药丸,旧回复的药丸仍在、可展开。
- 纯寒暄(无 dispatch)的回复**不显示**药丸。

## 6. 不在范围
- 把 orchestrator 每轮的状态 `reply` 文本传到前端(当前只打 terminal log,设计决定不传)。
- 工作流级(workflow_*)的步骤分组卡片。
- 附件/语音等输入栏功能。
