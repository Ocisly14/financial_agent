# member Topic 提问向上透传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让被 `ask_topic` 驱动的 member Topic 能反问用户，问题以选项卡形式出现在 Research 界面上，用户点选后该 member 独立续跑；全部答完再由前端触发一轮 Research 续上。

**Architecture:** 提问不搬家——它始终留在提出它的那个 member session 上。后端只做三件事：允许 member 提问、检测到提问后向 controller 回报 `needs_input`、把提问连同 member 归属发一个新的 Research 帧。用户提交时前端 POST 到**那个 member 的 session**，走今天已经跑通、一行不改的恢复路径。

**Tech Stack:** Node 23（`--experimental-strip-types --experimental-sqlite`）、`node:test`、TypeScript、React + TanStack Query（客户端）

## Global Constraints

以下逐条来自 `docs/superpowers/specs/2026-08-04-member-input-passthrough-design.md`。

- **不得修改** `src/framework/sessionState.ts`（尤其是 `userInputViewForEvent`）、`src/framework/orchestrator.ts`、`src/framework/types.ts` 的 `SSEEvent`、`src/server/server.ts`、`mcp_tools/user/askUserTool.ts`。整套设计的前提就是这些都不动。
- `SSEEvent` 的 `final` 帧保持单数 `input_request` 不变。新东西走 Research 自己的帧通道 `ResearchFrame`。
- `orchestrator.ts` 里那条 "ask_user is unavailable in an agent-to-agent Topic run" 的守卫**保留**。它由 `allowUserInput === false` 触发；本计划只是不再传 false，守卫本身仍是该入参的正确行为。
- **允许多个 pending 并存。** 三个 member 同时提问就是三张独立的卡，各自独立提交。不做合并。
- **答一个恢复一个，答齐再续。** 每次提交立刻恢复对应 member，但 controller 不动；最后一张卡答完才触发一轮 Research。
- member 恢复后可以再次提问，**不设乒乓上限**。
- 客户端**没有** React 测试框架。`client/package.json` 无 vitest / jest / testing-library；`npm test` 只收 `client/src/lib/__tests__/*.test.ts`，全是纯模块。因此**凡是需要测试的客户端逻辑，必须以纯函数形式落在 `client/src/lib/`**，hook 与组件只做接线。不要引入新的测试依赖。
- **不要 `git commit`。** 每个 task 止步于 `git add`，等人过一遍。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/agent/research/tools.ts` | `needs_input` 状态、`AskTopicResult.request`、`member_input_request` 帧、去掉 `allowUserInput: false` |
| `src/agent/research/researchRuntime.ts` | `needs_input` 的 `tool_result` summary |
| `client/src/lib/memberInput.ts` | 纯函数：提交文本拼装、续跑触发判定 |
| `client/src/types/core.ts` | 新帧与卡片归属的类型 |
| `client/src/hooks/useTopicStream.ts` | 接收新帧、`submitMemberInput`、续跑触发 |
| `client/src/components/workspace/ConversationPane.tsx` | 按卡片归属选提交处理函数 |
| `client/src/components/chat/UserInputCard.tsx` | 可选的归属标签 |
| `client/src/i18n/locales/{en,zh-CN}.ts` | 续跑文案、归属标签 |

---

### Task 1: 后端——member 可提问，controller 被告知

**Files:**
- Modify: `src/agent/research/tools.ts`
- Modify: `src/agent/research/researchRuntime.ts:563-572`
- Test: `src/agent/research/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `AskStatus` 新增 `"needs_input"`
  - `AskTopicResult` 新增 `request?: UserInputRequestView`
  - `ResearchFrame` 新增 `{ name: "member_input_request"; data: { topicId: string; topicName: string; request: UserInputRequestView } }`

- [ ] **Step 1: 改既有断言（这一条先做，别等它自己变绿）**

`src/agent/research/__tests__/tools.test.ts:167` 目前断言 `orchestrator.run` 收到 `allowUserInput: false`。本任务移除该入参，所以这条期望必须同步改掉：

```ts
  assert.deepEqual(h.runs, [{ sessionId: "room_a", userMessage: "渠道库存怎么样？" }],
```

（把 `, allowUserInput: false` 从对象里删掉。行号可能因并行改动漂移，按 `allowUserInput: false` 搜索定位。）

设计文档 §6 早前写的是"移除参数后该测试会自然变绿"——那已过时，方向反了。以本步为准。

- [ ] **Step 2: 写失败的测试**

在 `src/agent/research/__tests__/tools.test.ts` 末尾追加。该文件已有 `harness()` 工厂（约 123-140 行）构造 `ResearchToolset`，其中 `runs` 数组记录 `orchestrator.run` 的入参、`frames` 数组收集 emit 的帧、`run` 可注入自定义实现。沿用它，**不要重构既有用例**。

```ts
test("a member that leaves a pending question comes back as needs_input", async () => {
  const h = harness({
    // The driven Topic calls ask_user: its run() returns immediately and the
    // request is recorded on that Topic's own session.
    run: async (input) => {
      const state = await h.sessions.getOrCreate(input.sessionId);
      state.recordUserInputRequest({
        request_id: "req_1",
        questions: [{
          id: "q1",
          question: "Which fiscal year?",
          options: [{ id: "fy25", label: "FY25" }, { id: "fy26", label: "FY26" }],
          min_selections: 1,
          max_selections: 1,
        }],
      });
      return { response: "Please answer the questions below." };
    },
  });

  const result = await h.toolset.askTopic("room_a", "渠道库存怎么样？");

  assert.equal(result.status, "needs_input");
  assert.equal(result.request?.request_id, "req_1");
  assert.equal(result.request?.status, "pending");
});

test("needs_input emits a member_input_request frame carrying the member's identity", async () => {
  const h = harness({
    run: async (input) => {
      const state = await h.sessions.getOrCreate(input.sessionId);
      state.recordUserInputRequest({
        request_id: "req_1",
        questions: [{
          id: "q1",
          question: "Which fiscal year?",
          options: [{ id: "fy25", label: "FY25" }, { id: "fy26", label: "FY26" }],
          min_selections: 1,
          max_selections: 1,
        }],
      });
      return { response: "Please answer the questions below." };
    },
  });

  await h.toolset.askTopic("room_a", "渠道库存怎么样？");

  const frame = h.frames.find((f) => f.name === "member_input_request");
  assert.ok(frame, "a member_input_request frame should be emitted");
  assert.equal(frame.data.topicId, "room_a");
  assert.equal(frame.data.request.request_id, "req_1");
});

test("a member that answers normally is unaffected", async () => {
  const h = harness();   // default run() just returns a reply

  const result = await h.toolset.askTopic("room_a", "渠道库存怎么样？");

  assert.equal(result.status, "ok");
  assert.equal(result.request, undefined);
  assert.equal(h.frames.filter((f) => f.name === "member_input_request").length, 0);
});

test("the driven Topic is no longer forbidden from asking the user", async () => {
  const h = harness();
  await h.toolset.askTopic("room_a", "渠道库存怎么样？");
  assert.equal(h.runs[0]!.allowUserInput, undefined);
});
```

若 `harness()` 没有暴露 `sessions` 或 `frames`，就地补上返回字段——这是最小改动，不是重构。

- [ ] **Step 3: 运行测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/research/__tests__/tools.test.ts`

Expected: 四个新用例中三个失败（`status` 是 `"ok"` 而非 `"needs_input"`、找不到 `member_input_request` 帧、`allowUserInput` 仍是 `false`）。

- [ ] **Step 4: 改 tools.ts 的类型**

`AskStatus`（约 120 行）：

```ts
export type AskStatus = "running" | "ok" | "failed" | "timeout" | "skipped" | "needs_input";
```

`AskTopicResult` 加一个字段（`reply` / `reason` 旁边）：

```ts
  /** 只在 status 为 needs_input 时出现:member 本轮留下的、尚未回答的提问。 */
  request?: UserInputRequestView;
```

并确保 `UserInputRequestView` 已从 `../../framework/types.ts` 导入。

`ResearchFrame`（约 84 行）追加一个变体：

```ts
  | {
      name: "member_input_request";
      data: { topicId: string; topicName: string; request: UserInputRequestView };
    }
```

- [ ] **Step 5: 改 askTopic**

在 `askTopic` 里，把 `run()` 那一段（约 360-380 行）改成下面这样。三处要点：拿 member 的 `SessionState`、在 `run()` **之前**记下轮次、`markSeen` 照常先执行。

```ts
      // The member's own state, so we can see whether this turn left a question
      // behind. `getOrCreate` is registry-cached — this is not a second load.
      const memberState = await this.ctx.sessions.getOrCreate(topicId);
      const turnBefore = memberState.currentTurn;

      const unstamp = await this.stampOrigin(topicId, task);
      let response: string;
      try {
        const result = await withTimeout(
          this.ctx.orchestrator.run({ sessionId: topicId, userMessage: task }),
          this.ctx.askTimeoutMs ?? ASK_TOPIC_TIMEOUT_MS,
          `ask_topic(${topicId})`,
        );
        response = result.response;
      } finally {
        unstamp();
      }

      // Changes this controller caused are not "external" (§4.2.3), so move the
      // seen marker past them before the next turn's delta is computed. This
      // runs for a needs_input turn too: the member really did produce events.
      await this.markSeen(topicId);

      // The member asked the user something. The request stays on ITS session —
      // the answer will arrive there, through the ordinary resume path. All we
      // do is tell the controller, and hand the UI enough to render the card.
      const pending = memberState.userInputRequestForTurn(turnBefore + 1);
      if (pending && pending.status === "pending") {
        this.ctx.emit({ name: "member_input_request", data: { topicId, topicName, request: pending } });
        this.ctx.emit({ name: "topic_dispatch", data: { topicId, topicName, task, status: "needs_input" } });
        return { topicId, topicName, status: "needs_input", reply: response, request: pending };
      }

      this.ctx.emit({ name: "topic_dispatch", data: { topicId, topicName, task, status: "ok" } });
      return { topicId, topicName, status: "ok", reply: response };
```

注意 `orchestrator.run` 的入参里**删掉了** `allowUserInput: false`。`TopicOrchestrator` 接口（约 72 行）上那个可选参数**保留不动**——它仍是该入参的合法形状，只是这里不再传。

- [ ] **Step 6: 改 researchRuntime 的 summary**

`src/agent/research/researchRuntime.ts` 的 `case "ask_topic"`（约 563-572 行），把 summary 三分支化：

```ts
      case "ask_topic": {
        const topicId = requireString(input, "topic_id");
        const message = requireString(input, "message");
        const result = await toolset.askTopic(topicId, message);
        const summary =
          result.status === "ok"
            ? `[${result.topicName}] answered:\n${result.reply ?? ""}`
            : result.status === "needs_input"
              // Say plainly that this is an open question, not an empty answer —
              // otherwise the controller reads the gap as "no data" and fills it in.
              ? `[${result.topicName}] is waiting on the user's answer to a question of its own and did not report this turn. Do not substitute another member's figures for it; once the user answers, fetch_from_topic will have its reply.`
              : `[${result.topicName}] ${result.status} this turn: ${result.reason ?? "unknown reason"}`;
        return { summary, data: result };
      }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/research/__tests__/tools.test.ts`

Expected: 全部通过，含四个新用例与 Step 1 改过的那条。

- [ ] **Step 8: 全量测试与类型检查**

Run: `npx tsc --noEmit && npm test`

Expected: `tsc` 无输出；`npm test` 全绿。

- [ ] **Step 9: 暂存**

```bash
git add src/agent/research/tools.ts src/agent/research/researchRuntime.ts \
        src/agent/research/__tests__/tools.test.ts
```

**不要 git commit。**

---

### Task 2: 客户端纯函数与类型

**Files:**
- Create: `client/src/lib/memberInput.ts`
- Create: `client/src/lib/__tests__/memberInput.test.ts`
- Modify: `client/src/types/core.ts`

**Interfaces:**
- Consumes: Task 1 的帧形状
- Produces:
  - `export type MemberInputCard = { topicId: string; topicName: string; requestId: string; status: UserInputRequestView["status"] };`
  - `export function answerText(request: UserInputRequestView, answers: UserInputAnswer[]): string;`
  - `export function shouldContinueResearch(cards: MemberInputCard[]): boolean;`

- [ ] **Step 1: 写失败的测试**

新建 `client/src/lib/__tests__/memberInput.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { answerText, shouldContinueResearch } from "../memberInput.ts";
import type { UserInputRequestView } from "../../types/core.ts";

const request: UserInputRequestView = {
  request_id: "req_1",
  status: "pending",
  questions: [
    {
      id: "q1",
      question: "Which fiscal year?",
      options: [{ id: "fy25", label: "FY25" }, { id: "fy26", label: "FY26" }],
      min_selections: 1,
      max_selections: 2,
    },
    {
      id: "q2",
      question: "Include guidance?",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      min_selections: 1,
      max_selections: 1,
    },
  ],
};

test("answerText renders one line per question with the chosen labels", () => {
  const text = answerText(request, [
    { question_id: "q1", selected_option_ids: ["fy26"] },
    { question_id: "q2", selected_option_ids: ["yes"] },
  ]);
  assert.equal(text, "Which fiscal year?: FY26\nInclude guidance?: Yes");
});

test("answerText joins multiple selections in option order, not click order", () => {
  const text = answerText(request, [
    { question_id: "q1", selected_option_ids: ["fy26", "fy25"] },
    { question_id: "q2", selected_option_ids: ["no"] },
  ]);
  assert.equal(text, "Which fiscal year?: FY25, FY26\nInclude guidance?: No");
});

test("a question with no answer renders with an empty selection rather than being dropped", () => {
  const text = answerText(request, [{ question_id: "q1", selected_option_ids: ["fy25"] }]);
  assert.equal(text, "Which fiscal year?: FY25\nInclude guidance?: ");
});

test("shouldContinueResearch is false while any card is still pending", () => {
  assert.equal(shouldContinueResearch([
    { topicId: "a", topicName: "A", requestId: "r1", status: "answered" },
    { topicId: "b", topicName: "B", requestId: "r2", status: "pending" },
  ]), false);
});

test("shouldContinueResearch is true once every card is resolved", () => {
  assert.equal(shouldContinueResearch([
    { topicId: "a", topicName: "A", requestId: "r1", status: "answered" },
    { topicId: "b", topicName: "B", requestId: "r2", status: "skipped" },
  ]), true);
});

test("shouldContinueResearch is false with no cards at all", () => {
  // Nothing was asked, so there is nothing to continue from — this guards the
  // trigger against firing on an ordinary turn.
  assert.equal(shouldContinueResearch([]), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test client/src/lib/__tests__/memberInput.test.ts`

Expected: FAIL，找不到模块 `../memberInput.ts`。

- [ ] **Step 3: 写 memberInput.ts**

新建 `client/src/lib/memberInput.ts`：

```ts
import type { UserInputAnswer, UserInputRequestView } from "@/types/core";

/**
 * One outstanding question card belonging to a member Topic of this Research.
 *
 * The card is only a pointer: the request itself lives on that member's own
 * session, which is also where the answer is delivered. Nothing here is the
 * source of truth for the request's state — it mirrors what the UI has seen.
 */
export type MemberInputCard = {
  topicId: string;
  topicName: string;
  requestId: string;
  status: UserInputRequestView["status"];
};

/**
 * The human-readable message that accompanies a structured answer. It becomes
 * the `user_message` on that member's timeline, so it reads as prose rather
 * than as a payload dump.
 */
export function answerText(request: UserInputRequestView, answers: UserInputAnswer[]): string {
  const byQuestion = new Map(answers.map((answer) => [answer.question_id, answer.selected_option_ids]));
  return request.questions
    .map((question) => {
      const selected = new Set(byQuestion.get(question.id) ?? []);
      // Iterate the options, not the answer ids: the line then reads in the
      // order the user saw, regardless of the order they clicked.
      const labels = question.options.filter((option) => selected.has(option.id)).map((option) => option.label);
      return `${question.question}: ${labels.join(", ")}`;
    })
    .join("\n");
}

/**
 * Whether the Research turn should now be resumed. True only once every card
 * this turn produced has been resolved — answering one member at a time would
 * otherwise wake the controller with partial information, and it would draw a
 * conclusion from it.
 */
export function shouldContinueResearch(cards: MemberInputCard[]): boolean {
  return cards.length > 0 && cards.every((card) => card.status !== "pending");
}
```

- [ ] **Step 4: 在 core.ts 加类型**

`client/src/types/core.ts`，在 `UserInputRequestView` 定义之后加：

```ts
/** A member Topic's own question, surfaced on the Research stream (see the
 *  member-input-passthrough design). `topicId` is the session the answer must
 *  be POSTed to — NOT the Research session the card is displayed in. */
export type MemberInputRequestFrame = {
    topicId: string;
    topicName: string;
    request: UserInputRequestView;
};
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-strip-types --test client/src/lib/__tests__/memberInput.test.ts`

Expected: PASS，6 个用例。

- [ ] **Step 6: 全量测试与类型检查**

Run: `npx tsc --noEmit && npm test && pnpm --prefix client exec tsc --noEmit -p tsconfig.json`

Expected: 全绿。（客户端有独立的 tsconfig；根 `tsc` 不覆盖它。）

- [ ] **Step 7: 暂存**

```bash
git add client/src/lib/memberInput.ts client/src/lib/__tests__/memberInput.test.ts client/src/types/core.ts
```

**不要 git commit。**

---

### Task 3: 接收新帧并渲染卡片

**Files:**
- Modify: `client/src/hooks/useTopicStream.ts`
- Modify: `client/src/components/workspace/ConversationPane.tsx:128-137`
- Modify: `client/src/components/chat/UserInputCard.tsx`
- Modify: `client/src/i18n/locales/en.ts`、`client/src/i18n/locales/zh-CN.ts`

**Interfaces:**
- Consumes: Task 2 的 `MemberInputRequestFrame`、`MemberInputCard`
- Produces: 带 `memberTopicId` / `memberTopicName` metadata 的消息；`stream.memberCards: MemberInputCard[]`

- [ ] **Step 1: 在 runTurn 的帧处理里接住新帧**

`useTopicStream.ts` 的 `onStep` 回调里已有一条分支处理 Research 布局帧：

```ts
if (step.name === "topic_focus" || step.name === "layout_changed") {
    onDirectiveRef.current?.(step);
    return;
}
```

在它之后插入：

```ts
if (step.name === "member_input_request") {
    const data = step.data as MemberInputRequestFrame | undefined;
    if (data?.request) {
        // Its own message, so N simultaneous questions render as N cards.
        appendMessages([{
            id: `member-input-${data.request.request_id}`,
            user: "assistant",
            text: "",
            createdAt: Date.now(),
            content: {
                metadata: {
                    inputRequest: data.request,
                    memberTopicId: data.topicId,
                    memberTopicName: data.topicName,
                },
            },
        } as unknown as ContentWithUser]);
    }
    return;
}
```

导入 `MemberInputRequestFrame`。若 `appendMessages` 的形参类型与上面不符，按该文件既有的追加写法调整字段名，**不要**改 `appendMessages` 本身。

- [ ] **Step 2: 暴露 memberCards**

`useTopicStream` 从消息列表里派生卡片清单并返回，供 Task 4 的触发使用：

```ts
const memberCards = useMemo<MemberInputCard[]>(() => {
    const rows = queryClient.getQueryData<ContentWithUser[]>(queryKey) ?? [];
    return rows.flatMap((row) => {
        const metadata = (row as { content?: { metadata?: Record<string, unknown> } }).content?.metadata;
        const request = metadata?.inputRequest as UserInputRequestView | undefined;
        const topicId = metadata?.memberTopicId as string | undefined;
        if (!request || !topicId) return [];
        return [{
            topicId,
            topicName: (metadata?.memberTopicName as string | undefined) ?? topicId,
            requestId: request.request_id,
            status: request.status,
        }];
    });
}, [queryClient, queryKey, messages]);
```

把 `memberCards` 加进 hook 的返回对象。`messages` 用该 hook 已有的消息列表变量名（依赖它是为了让卡片状态变化时重算）。

- [ ] **Step 3: 让卡片显示归属**

`UserInputCard.tsx` 加一个可选 prop：

```ts
export function UserInputCard({
    request,
    onSubmit,
    attribution,
}: {
    request: UserInputRequestView;
    onSubmit: (request: UserInputRequestView, answers: UserInputAnswer[]) => Promise<void> | void;
    /** Which member asked. Absent when the controller itself is asking. */
    attribution?: string;
}) {
```

在卡片标题区渲染它（沿用该文件既有的标题元素与样式类，不新增样式方案）：

```tsx
{attribution ? (
    <span className="text-xs text-muted-foreground">{t("research.memberAsked", { topic: attribution })}</span>
) : null}
```

`ConversationPane.tsx` 的 `renderAssistantContent` 里取出归属并传下去：

```tsx
const memberTopicName = metadata?.memberTopicName as string | undefined;
...
<UserInputCard
    key={inputRequest.request_id}
    request={inputRequest}
    onSubmit={stream.submitUserInput}
    {...(memberTopicName ? { attribution: memberTopicName } : {})}
/>
```

（提交路由在 Task 4 接上；本 task 先保持 `submitUserInput` 不变。）

- [ ] **Step 4: 加文案**

`client/src/i18n/locales/en.ts` 的 `research` 段：

```ts
memberAsked: "{{topic}} is asking",
```

`client/src/i18n/locales/zh-CN.ts` 的同一段：

```ts
memberAsked: "{{topic}} 想确认",
```

若 `research` 段不存在，就放进该文件既有的、与 Research 工作区相关的那个段落，两个语言文件的键路径必须完全一致。

- [ ] **Step 5: 类型检查与全量测试**

Run: `npx tsc --noEmit && npm test && pnpm --prefix client exec tsc --noEmit -p tsconfig.json`

Expected: 全绿。

- [ ] **Step 6: 人工验证渲染**

Run: `pnpm --prefix client dev`

暂时在 `useTopicStream` 里手工构造一个 `member_input_request` 帧（或用浏览器控制台触发 `appendMessages`），确认：两张卡同时出现、各自带归属标签、彼此独立不互相覆盖。确认后**把手工构造的代码删掉**。

- [ ] **Step 7: 暂存**

```bash
git add client/src/hooks/useTopicStream.ts client/src/components/workspace/ConversationPane.tsx \
        client/src/components/chat/UserInputCard.tsx \
        client/src/i18n/locales/en.ts client/src/i18n/locales/zh-CN.ts
```

**不要 git commit。**

---

### Task 4: 提交路由与续跑触发

**Files:**
- Modify: `client/src/hooks/useTopicStream.ts`
- Modify: `client/src/components/workspace/ConversationPane.tsx`
- Modify: `client/src/i18n/locales/en.ts`、`client/src/i18n/locales/zh-CN.ts`

**Interfaces:**
- Consumes: Task 2 的 `answerText` / `shouldContinueResearch`、Task 3 的 `memberCards` 与 metadata
- Produces: `stream.submitMemberInput(topicId, request, answers)`

- [ ] **Step 1: 写 submitMemberInput**

**不要复用 `runTurn`。** `runTurn` 会往当前会话追加一条用户消息、清空 `tasksRef`、重置 `liveTasks` 并进入 processing 状态——那些都属于 Research 视图自己的一轮。member 的提交发生在另一个 session 上，Research 视图这一轮并没有开始。

在 `useTopicStream` 里新增：

```ts
const submitMemberInput = useCallback(
    async (topicId: string, request: UserInputRequestView, answers: UserInputAnswer[]) => {
        if (request.status !== "pending") return;
        updateInputRequests((candidate) =>
            candidate.request_id === request.request_id
                ? { ...candidate, status: "answered", answers }
                : candidate,
        );

        const inputResponse: UserInputSubmission = {
            requestId: request.request_id,
            answers: answers.map((answer) => ({
                questionId: answer.question_id,
                selectedOptionIds: answer.selected_option_ids,
            })),
        };

        try {
            // POST goes to the MEMBER's session, not this view's. That is the
            // whole point: the request lives there and the ordinary resume path
            // picks it up untouched.
            //
            // `POST /chat` always answers with an SSE stream whether or not the
            // caller wants one. `sendMessageStream` consumes it to completion,
            // so awaiting this call is what keeps the member's resume alive —
            // dropping the connection early would cut it off mid-write.
            await apiClient.sendMessageStream(
                agentId,
                answerText(request, answers),
                topicId,
                () => {}, () => {}, () => {}, () => {},
                undefined,
                (error) => { sonnerToast.error(String(typeof error === "string" ? error : error?.message ?? error)); },
                undefined, undefined, undefined, undefined, undefined, 0,
                inputResponse,
            );
        } catch {
            // Put the card back so the user can retry; the member never got the answer.
            updateInputRequests((candidate) =>
                candidate.request_id === request.request_id
                    ? { ...candidate, status: "pending" }
                    : candidate,
            );
        }
    },
    [agentId, updateInputRequests],
);
```

`sendMessageStream` 的位置参数很多且没有默认值缺口——照 `client/src/lib/api.ts:426-448` 的签名逐个核对，不要靠记忆填。回调传空函数是刻意的：这条流的内容属于 member 的视图，Research 界面不展示。

把 `submitMemberInput` 加进 hook 的返回对象。

- [ ] **Step 2: 用 answerText 收敛既有逻辑**

`submitUserInput` 里现有一段内联的"按题拼答案文本"代码（`const byQuestion = new Map(...)` 到 `.join("\n")`）。用 Task 2 的纯函数替换：

```ts
const text = answerText(request, answers);
```

删掉被替换的那几行。两条提交路径由此共用同一份措辞，且这段逻辑现在有测试覆盖。

- [ ] **Step 3: 接上续跑触发**

在 `useTopicStream` 里加一个 effect：

```ts
const continuationFiredRef = useRef<string | null>(null);

useEffect(() => {
    if (!shouldContinueResearch(memberCards)) {
        // Cards gone (new turn) — arm the trigger again.
        if (memberCards.length === 0) continuationFiredRef.current = null;
        return;
    }
    // One fire per distinct set of cards: without this key the effect re-runs
    // on every unrelated message append and posts the continuation repeatedly.
    const key = memberCards.map((card) => card.requestId).sort().join("|");
    if (continuationFiredRef.current === key) return;
    continuationFiredRef.current = key;
    void runTurn(t("research.continueAfterMemberInput"));
}, [memberCards, runTurn, t]);
```

`t` 来自该 hook 已有的 `useTranslation`；若 hook 里还没有，就地引入。

- [ ] **Step 4: 加续跑文案**

`en.ts`：

```ts
continueAfterMemberInput: "(Answered the follow-up questions above — please continue.)",
```

`zh-CN.ts`：

```ts
continueAfterMemberInput: "（已回答上述追问，请继续。）",
```

- [ ] **Step 5: 按归属选提交处理函数**

`ConversationPane.tsx` 的 `renderAssistantContent`：

```tsx
const memberTopicId = metadata?.memberTopicId as string | undefined;
...
<UserInputCard
    key={inputRequest.request_id}
    request={inputRequest}
    onSubmit={
        memberTopicId
            ? (request, answers) => stream.submitMemberInput(memberTopicId, request, answers)
            : stream.submitUserInput
    }
    {...(memberTopicName ? { attribution: memberTopicName } : {})}
/>
```

没有 `memberTopicId` 的卡片（controller 自己提的问）行为**逐字不变**。

- [ ] **Step 6: 类型检查与全量测试**

Run: `npx tsc --noEmit && npm test && pnpm --prefix client exec tsc --noEmit -p tsconfig.json`

Expected: 全绿，含 Task 2 的 6 个纯函数用例。

- [ ] **Step 7: 暂存**

```bash
git add client/src/hooks/useTopicStream.ts client/src/components/workspace/ConversationPane.tsx \
        client/src/i18n/locales/en.ts client/src/i18n/locales/zh-CN.ts
```

**不要 git commit。**

---

### Task 5: 端到端验证

**Files:**
- Create: `scripts/verify/member-input-passthrough.ts`

**Interfaces:**
- Consumes: Task 1-4 的全部产出
- Produces: 一份人工可读的验证输出

- [ ] **Step 1: 起一个隔离的服务端**

绝不碰真实库。若任何一步会写 `data/sessions.sqlite`，停下并报 BLOCKED。

```bash
SESSION_DB_PATH=/tmp/member-input-verify.sqlite PORT=3999 \
  node --env-file=.env --experimental-strip-types --experimental-sqlite src/server.ts
```

- [ ] **Step 2: 造一个必然触发反问的场景**

建一个 Research 和一个 member Topic（路由照 `src/server/server.ts` 现状读，不要猜），然后向 Research 发一条指令，使 controller 必须驱动那个 member，而该 member 面对的信息不足以自行决定——例如让它比较"上一季度"但不给出是自然季度还是财季。

若模型没有触发反问，**这本身是结果，不是要绕过的障碍**：如实记录第一步的原始输出，并直接在 member 的 session 上手工触发一次 `ask_user` 走完剩下的断言。两种情况都要在报告里写清用的是哪条路径。

- [ ] **Step 3: 断言透传**

从 `/tmp/member-input-verify.sqlite` 读事件，逐条确认并记录证据：

1. Research 的 SSE 流上出现了 `member_input_request` 帧，`topicId` 是那个 member。
2. 该 member 的 session 上存在一条 `user_input_required` 事件，状态为 `pending`。
3. Research session 上**没有**新增 `user_input_required` 事件——提问不搬家。
4. Research 那一轮正常结束，没有挂起。
5. Research 的 `tool_result` 里该 member 的 summary 说明它在等待用户回答。

- [ ] **Step 4: 断言恢复**

以 **member 的 sessionId** POST 一次 `inputResponse`，把返回的 SSE 流读到 `done`。然后确认：

6. 该请求的状态从 `pending` 变为 `answered`。
7. member 的 session 上出现了新一轮，且它的 `user_message` 带有 `response_to`。
8. 全程 `data/sessions.sqlite` 的 mtime 未变。

- [ ] **Step 5: 记录并收尾**

把八项结论写进实现报告。停掉服务端，删除 `/tmp/member-input-verify.sqlite*`。

- [ ] **Step 6: 暂存**

```bash
git add scripts/verify/member-input-passthrough.ts
```

**不要 git commit。**

---

## 自查记录

- **spec 覆盖**：§3.1 → Task 1 Step 5（去掉入参）；§3.2 → Task 1 Step 4-5；§3.3 → Task 1 Step 4-5（帧）；§3.4 → Task 1 Step 6；§3.5 → Task 4 Step 3-4；§3.6 → 无需代码，恢复走普通 `run`，Task 5 Step 4 覆盖；§4.1 → Task 3；§4.2 → Task 4 Step 1；§4.3 → Task 4 Step 3-4；§5 错误表 → Task 4 Step 1 的 catch 回滚 + Task 5；§6 → 各 task 的测试步骤；§7 文件清单 → 各 task 的 Files。
- **对 spec 的两处修正**（实现前实地核对代码得出，spec 待同步）：
  1. §4.2 说前端"唯一实质改动"是把提交目标从当前 session 换成卡片自带的 session。**不止如此**：`submitUserInput` 走的 `runTurn` 会往当前会话追加用户消息、重置任务列表并进入 processing 状态，那些都属于 Research 自己的一轮。member 的提交必须走一条独立的、安静的路径（Task 4 Step 1），不能改 `runTurn` 的目标了事。
  2. §7 说要改 `UserInputCard.tsx` 以"透传 topicId"。**不需要**——提交处理函数由 `ConversationPane` 按 metadata 选好再传进去，卡片不必知道 session 的存在。它只加一个纯展示用的可选 `attribution`。
- **测试设施的现实**：客户端没有 React 测试框架，所以可测逻辑集中在 `client/src/lib/memberInput.ts` 的两个纯函数上；hook 与组件的接线由 Task 3 Step 6 的人工验证和 Task 5 的端到端覆盖。这是当前设施下的诚实划法，不是省略。
- **类型一致性**：`MemberInputRequestFrame`（Task 2，core.ts）= Task 1 帧 `data` 的形状，逐字段对应；`MemberInputCard`（Task 2）由 Task 3 派生、Task 4 消费；`answerText` / `shouldContinueResearch` 在 Task 2 产出、Task 4 消费。
