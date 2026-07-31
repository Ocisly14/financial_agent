# Research 层实施计划（第二阶段 2a）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 造一个独立的控制器 agent，它以用户身份驱动现有的 Topic agent、创建 Topic、控制布局并汇总答案；配上多成员工作区前端。

**Architecture:** 控制器是**用户的替身**，不是现有 agent 的上层封装 —— 它向 Topic 投递消息走的就是聊天框那条路（`orchestrator.run({ sessionId: topicId, userMessage })`）。因此现有 agent 一行不改，事实自动落在各 Topic 自己的时间线上。成员信息分三层供给：开局名册、外部增量、`fetch_from_topic` 的 map-reduce 回查。

**Tech Stack:** Node 23（`--experimental-strip-types`、`--experimental-sqlite`）、`node:test` + `node:assert/strict`、React 19、TanStack Query v5、react-router 7、Tailwind、pnpm。

## Global Constraints

- **规格文档**：`docs/superpowers/specs/2026-07-30-research-layer-design.md`。每个任务以它为准。
- **不要提交。** 只改代码、跑测试，改动留在工作区。**不要 `git add` / `commit` / `stash` / `checkout` / `reset` / `rm` 以外的写操作**（删文件用 `rm`）。各任务末尾若出现提交步骤，只作为提交信息草稿，不执行。
- **不做逐任务审查。** 全部任务完成后统一测试与审查。
- **现有 agent 一行不改。** `src/framework/orchestrator.ts`、`dispatcher.ts`、`subagent.ts`、`contextCompaction.ts`、`src/agent/prompts/`、`src/agent/subagents/` 全部保持原样。若某个任务看起来必须改它们，停下并报告 BLOCKED —— 那说明设计有问题，不是你该现场决定的。
- **第一阶段的改动未提交也未审查**，全部在工作区里。它是你的基础，不要「顺手修」它的问题；发现了就写进报告。
- 测试运行器只有根 `pnpm test`（`node:test`）。**客户端没有 React 测试运行器** —— 可测逻辑必须抽成 `client/src/lib/` 或 `src/` 下的纯函数。
- 相对导入**必须带 `.ts` 后缀**。
- SQLite 测试用 `SqliteEventStore.open(":memory:")`。**不写迁移**（demo 阶段），新列直接进 `CREATE TABLE`。
- 所有用户可见字符串走 i18n，`en.ts` 与 `zh-CN.ts` 必须同步。
- 设计 token：只用 `text-label-1..4`、`bg-fill-1..3`、`border-sep`、`fin-label`、`fin-figure`、`material`、`shadow-e2-rim`；禁止 `white/N`、`black/N`、`slate-N`、`gray-N` 和裸数值。

---

## 文件结构

**新建（后端）**
- `src/agent/research/researchRuntime.ts` — 控制器运行时（独立于 `OrchestratorRuntime`）
- `src/agent/research/researchPrompt.ts` — 控制器 prompt 模板
- `src/agent/research/tools.ts` — `ask_topic` / `create_topic` / `fetch_from_topic` / `focus` / `edit_tabs` / `edit_members`
- `src/agent/research/memberContext.ts` — 开局名册与外部增量的渲染（纯函数）
- `src/agent/research/retrieval.ts` — `fetch_from_topic` 的分片、汇总、排序、截断（纯函数）
- `src/agent/research/digest.ts` — 缩要生成与惰性刷新判定
- `src/agent/research/__tests__/` — 上述纯函数的测试

**修改（后端）**
- `src/infra/db/sqliteEventStore.ts` — 两张新表与其读写
- `src/server/server.ts` — research 路由、`handleChat` 按 sessionId 分流、`topic_dispatch` 帧
- `src/agent/createApp.ts` — 装配 `ResearchRuntime`

**新建（前端）**
- `client/src/lib/researchLayout.ts` — agent 布局指令的归一化与撤销栈（纯函数）
- `client/src/lib/__tests__/researchLayout.test.ts`
- `client/src/components/workspace/MemberRow.tsx`
- `client/src/components/workspace/MemberPicker.tsx`
- `client/src/hooks/useResearchStream.ts`
- `client/src/routes/research.tsx`

**修改（前端）**
- `client/src/components/workspace/TopicWorkspace.tsx`、`TopicRail.tsx`、`StatusBar.tsx`、`ChartTabBar.tsx`
- `client/src/lib/topicCharts.ts` 与其测试（§6 推翻的规则）
- `client/src/lib/api.ts`、`client/src/types/core.ts`、`client/src/App.tsx`、两个 locale 文件

---

## Task 1: Research 存储层

**Files:**
- Modify: `src/infra/db/sqliteEventStore.ts`
- Create: `src/infra/db/__tests__/researchStore.test.ts`

**Interfaces:**
- Produces: `type ResearchSummary = { id, name, createdAt, updatedAt, memberCount }`；
  `type ResearchMember = { topicId, sortOrder, digest: string | null, digestThroughTurn: number, seenThroughTurn: number }`；
  `SqliteEventStore` 上：`createResearch`、`listResearches`、`getResearch`、`renameResearch`、`deleteResearch`、`listResearchMembers`、`replaceResearchMembers`、`setMemberDigest`、`setMemberSeenTurn`

- [ ] **Step 1: 写失败的测试**

Create `src/infra/db/__tests__/researchStore.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../sqliteEventStore.ts";

function seeded() {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("a1", "t-aapl", "AAPL");
  store.createTopic("a1", "t-nvda", "NVDA");
  store.createTopic("a1", "t-macro", "美联储降息路径");
  return store;
}

test("a research lists with its member count", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "半导体估值");
  store.replaceResearchMembers("r1", ["t-aapl", "t-nvda"]);

  const list = store.listResearches("a1");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, "半导体估值");
  assert.equal(list[0]?.memberCount, 2);
  store.close();
});

test("members keep the order they were given", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "R");
  store.replaceResearchMembers("r1", ["t-nvda", "t-aapl", "t-macro"]);

  assert.deepEqual(
    store.listResearchMembers("r1").map((m) => m.topicId),
    ["t-nvda", "t-aapl", "t-macro"],
  );
  store.close();
});

test("replacing members drops the ones left out", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "R");
  store.replaceResearchMembers("r1", ["t-aapl", "t-nvda"]);
  store.replaceResearchMembers("r1", ["t-aapl"]);

  assert.deepEqual(store.listResearchMembers("r1").map((m) => m.topicId), ["t-aapl"]);
  store.close();
});

test("a surviving member keeps its digest across a membership rewrite", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "R");
  store.replaceResearchMembers("r1", ["t-aapl", "t-nvda"]);
  store.setMemberDigest("r1", "t-aapl", "AAPL 估值偏高但现金流稳", 12);

  store.replaceResearchMembers("r1", ["t-aapl", "t-macro"]);

  const aapl = store.listResearchMembers("r1").find((m) => m.topicId === "t-aapl");
  assert.equal(aapl?.digest, "AAPL 估值偏高但现金流稳", "a rewrite must not throw away work already paid for");
  assert.equal(aapl?.digestThroughTurn, 12);
  store.close();
});

test("a topic can belong to several researches at once", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "半导体估值");
  store.createResearch("a1", "r2", "财报季");
  store.replaceResearchMembers("r1", ["t-aapl"]);
  store.replaceResearchMembers("r2", ["t-aapl"]);

  assert.equal(store.listResearchMembers("r1").length, 1);
  assert.equal(store.listResearchMembers("r2").length, 1);
  store.close();
});

test("digests are per membership, not per topic", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.createResearch("a1", "r2", "B");
  store.replaceResearchMembers("r1", ["t-aapl"]);
  store.replaceResearchMembers("r2", ["t-aapl"]);
  store.setMemberDigest("r1", "t-aapl", "从估值角度看", 5);

  const inR2 = store.listResearchMembers("r2")[0];
  assert.equal(inR2?.digest, null, "each research reads the same topic through its own lens");
  store.close();
});

test("deleting a topic removes it from every research", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.createResearch("a1", "r2", "B");
  store.replaceResearchMembers("r1", ["t-aapl", "t-nvda"]);
  store.replaceResearchMembers("r2", ["t-aapl"]);

  store.deleteTopic("a1", "t-aapl");

  assert.deepEqual(store.listResearchMembers("r1").map((m) => m.topicId), ["t-nvda"]);
  assert.deepEqual(store.listResearchMembers("r2"), []);
  store.close();
});

test("a research whose members all vanish still exists", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.replaceResearchMembers("r1", ["t-aapl"]);
  store.deleteTopic("a1", "t-aapl");

  // 它的对话和论点还在，不该跟着消失。
  assert.equal(store.listResearches("a1").length, 1);
  assert.equal(store.listResearches("a1")[0]?.memberCount, 0);
  store.close();
});

test("deleting a research clears its membership rows but not the topics", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.replaceResearchMembers("r1", ["t-aapl"]);

  assert.equal(store.deleteResearch("a1", "r1"), true);
  assert.deepEqual(store.listResearchMembers("r1"), []);
  assert.equal(store.listTopics("a1").length, 3, "topics outlive the research that grouped them");
  store.close();
});

test("seenThroughTurn round-trips and defaults to zero", () => {
  const store = seeded();
  store.createResearch("a1", "r1", "A");
  store.replaceResearchMembers("r1", ["t-aapl"]);
  assert.equal(store.listResearchMembers("r1")[0]?.seenThroughTurn, 0);

  store.setMemberSeenTurn("r1", "t-aapl", 9);
  assert.equal(store.listResearchMembers("r1")[0]?.seenThroughTurn, 9);
  store.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | head -30`
Expected: FAIL — `store.createResearch is not a function`

- [ ] **Step 3: 加表**

在 `SCHEMA` 常量末尾追加（`researches.id` 同时是它的 session_id，沿用 topic 的同一技巧）：

```sql
CREATE TABLE IF NOT EXISTS researches (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_researches_agent_updated
  ON researches (agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS research_members (
  research_id         TEXT NOT NULL,
  topic_id            TEXT NOT NULL,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  digest              TEXT,
  digest_through_turn INTEGER NOT NULL DEFAULT 0,
  seen_through_turn   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (research_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_research_members_topic
  ON research_members (topic_id);
```

- [ ] **Step 4: 实现方法**

`replaceResearchMembers(researchId, topicIds)` 是**整体覆盖**，但**必须保留幸存成员的 digest**：
先读出现有行，删除全部，再插入，插入时把幸存 topic 的 `digest` / `digest_through_turn` /
`seen_through_turn` 带回去。测试 `a surviving member keeps its digest` 守的就是这条 ——
digest 是花过模型调用换来的，不能因为加了个新成员就丢掉。

`deleteTopic` 的事务里增加 `DELETE FROM research_members WHERE topic_id = ?`。
**不要**顺带删除成员归零的 research。

`deleteResearch` 的事务里删 `research_members`、`researches`，以及该 research
自己的 `session_events` 与 `session_compaction`（它的 id 就是 session_id）。

`listResearches` 用 `LEFT JOIN` + `COUNT` 得到 `memberCount`，一次查询，不要 N+1。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test 2>&1 | tail -20`
Expected: PASS，既有测试无回归

Run: `pnpm build`
Expected: 无 TypeScript 错误

---

## Task 2: 检索工具的纯逻辑

**Files:**
- Create: `src/agent/research/retrieval.ts`
- Create: `src/agent/research/__tests__/retrieval.test.ts`

这是本阶段最重要的一个任务 —— 它守着「数字必须是原文」那条安全边界。

**Interfaces:**
- Produces:
  - `type IndexedTurn = { turn: number; user: string; reply: string }`
  - `type Chunk = { turns: IndexedTurn[]; tokenEstimate: number }`
  - `type Selection = { turn: number; score: number }`
  - `chunkTurns(turns: IndexedTurn[], maxTokensPerChunk: number): Chunk[]`
  - `mergeSelections(perChunk: Selection[][], budgetTokens: number, turns: IndexedTurn[]): { turns: IndexedTurn[]; coverage: "full" | "truncated" }`
  - `renderChunkForModel(chunk: Chunk): string`
  - `containsDigits(text: string): boolean`

- [ ] **Step 1: 写失败的测试**

Create `src/agent/research/__tests__/retrieval.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkTurns, mergeSelections, renderChunkForModel, containsDigits,
  type IndexedTurn,
} from "../retrieval.ts";

const turn = (n: number, reply = "x".repeat(40)): IndexedTurn =>
  ({ turn: n, user: `q${n}`, reply });

test("chunking loses no turn and keeps them in order", () => {
  const turns = Array.from({ length: 25 }, (_, i) => turn(i + 1));
  const chunks = chunkTurns(turns, 200);

  const flat = chunks.flatMap((c) => c.turns.map((t) => t.turn));
  assert.deepEqual(flat, turns.map((t) => t.turn), "every turn appears exactly once, in order");
});

test("a single turn larger than the budget still gets its own chunk", () => {
  const chunks = chunkTurns([turn(1, "y".repeat(10_000))], 200);
  assert.equal(chunks.length, 1, "an oversized turn must not be dropped or split mid-sentence");
  assert.equal(chunks[0]?.turns[0]?.turn, 1);
});

test("chunking an empty history yields no chunks", () => {
  assert.deepEqual(chunkTurns([], 200), []);
});

test("selections from several chunks merge, dedupe and rank by score", () => {
  const turns = [turn(1), turn(2), turn(3), turn(4)];
  const merged = mergeSelections(
    [[{ turn: 3, score: 0.9 }, { turn: 1, score: 0.2 }], [{ turn: 3, score: 0.4 }, { turn: 4, score: 0.7 }]],
    100_000,
    turns,
  );
  assert.deepEqual(merged.turns.map((t) => t.turn), [3, 4, 1], "highest score first, no duplicates");
  assert.equal(merged.coverage, "full");
});

test("a duplicate keeps its highest score, not its last", () => {
  const turns = [turn(1), turn(2)];
  const merged = mergeSelections(
    [[{ turn: 1, score: 0.9 }], [{ turn: 1, score: 0.1 }, { turn: 2, score: 0.5 }]],
    100_000,
    turns,
  );
  assert.deepEqual(merged.turns.map((t) => t.turn), [1, 2]);
});

test("merging truncates to the budget and says so", () => {
  const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1, "z".repeat(400)));
  const merged = mergeSelections(
    [turns.map((t, i) => ({ turn: t.turn, score: 1 - i * 0.01 }))],
    300,
    turns,
  );
  assert.ok(merged.turns.length < 10);
  assert.equal(merged.coverage, "truncated", "the caller must be told it is not seeing everything");
});

test("a selection naming a turn that does not exist is ignored", () => {
  const merged = mergeSelections([[{ turn: 99, score: 1 }]], 100_000, [turn(1)]);
  assert.deepEqual(merged.turns, [], "a hallucinated id resolves to nothing rather than to the wrong turn");
});

test("the rendered chunk numbers every turn so the model can cite it", () => {
  const rendered = renderChunkForModel({ turns: [turn(7), turn(8)], tokenEstimate: 0 });
  assert.match(rendered, /\[turn 7\]/);
  assert.match(rendered, /\[turn 8\]/);
});

test("containsDigits catches the shapes a framing string must never have", () => {
  assert.equal(containsDigits("估值偏高，现金流稳健"), false);
  assert.equal(containsDigits("P/E 31.2"), true);
  assert.equal(containsDigits("支撑位 189"), true);
  assert.equal(containsDigits("上涨 5%"), true);
  assert.equal(containsDigits("１２３"), true, "full-width digits are digits");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A3 retrieval | head -20`
Expected: FAIL — 找不到 `../retrieval.ts`

- [ ] **Step 3: 实现**

要点：
- token 估算用简单启发式（字符数 / 3，中文按字符计），不引入分词依赖。注明它是估算。
- `chunkTurns` 贪心装箱；**单个超预算的 turn 单独成片**，绝不切开或丢弃。
- `mergeSelections` 用 Map 按 turn 去重取最高分，排序后按预算累加截断，
  截断时 `coverage = "truncated"`。
- `containsDigits` 必须覆盖全角数字：`/[0-9０-９]/`。
- `renderChunkForModel` 每个 turn 前缀 `[turn N]`，这是模型唯一的引用凭据。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -20`
Expected: PASS

---

## Task 3: 成员上下文渲染

**Files:**
- Create: `src/agent/research/memberContext.ts`
- Create: `src/agent/research/__tests__/memberContext.test.ts`

**Interfaces:**
- Produces:
  - `type MemberFacts = { topicId, name, leadSymbol: string | null, chartSymbols: string[], turnCount: number, lastActivityMs: number, digest: string | null, seenThroughTurn: number }`
  - `renderRoster(members: MemberFacts[], budgetTokens: number): string`
  - `renderExternalDelta(members: MemberFacts[]): string`
  - `staleDigests(members: Array<MemberFacts & { digestThroughTurn: number }>): string[]`

- [ ] **Step 1: 写失败的测试**

Create `src/agent/research/__tests__/memberContext.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { renderRoster, renderExternalDelta, staleDigests, type MemberFacts } from "../memberContext.ts";

const member = (over: Partial<MemberFacts> = {}): MemberFacts => ({
  topicId: "t1", name: "AAPL", leadSymbol: "AAPL", chartSymbols: ["AAPL", "SPY"],
  turnCount: 42, lastActivityMs: Date.parse("2026-07-28T00:00:00Z"),
  digest: "估值偏高但现金流稳健", seenThroughTurn: 42, ...over,
});

test("the roster names every member and carries its digest", () => {
  const text = renderRoster([member(), member({ topicId: "t2", name: "NVDA", leadSymbol: "NVDA", digest: "增长快、估值极高" })], 4000);
  assert.match(text, /t1/); assert.match(text, /AAPL/);
  assert.match(text, /t2/); assert.match(text, /增长快、估值极高/);
});

test("a member without a digest is still listed", () => {
  const text = renderRoster([member({ digest: null })], 4000);
  assert.match(text, /t1/, "a missing digest must not hide the member — the controller still needs to know it exists");
});

test("a macro member with no charts renders without a symbol", () => {
  const text = renderRoster([member({ name: "美联储降息路径", leadSymbol: null, chartSymbols: [] })], 4000);
  assert.match(text, /美联储降息路径/);
});

test("the roster truncates to its budget and says how many were dropped", () => {
  const many = Array.from({ length: 30 }, (_, i) => member({ topicId: `t${i}`, name: `T${i}` }));
  const text = renderRoster(many, 600);
  assert.match(text, /未列出/, "silently dropping members would leave the controller with a wrong world model");
});

test("no external change renders to an empty string", () => {
  assert.equal(renderExternalDelta([member({ turnCount: 42, seenThroughTurn: 42 })]), "");
});

test("an advanced member renders one line naming the gap", () => {
  const text = renderExternalDelta([member({ turnCount: 45, seenThroughTurn: 42 })]);
  assert.match(text, /AAPL/);
  assert.match(text, /3/, "the controller needs the size of what it missed");
});

test("only the advanced members appear in the delta", () => {
  const text = renderExternalDelta([
    member({ topicId: "t1", name: "AAPL", turnCount: 42, seenThroughTurn: 42 }),
    member({ topicId: "t2", name: "NVDA", turnCount: 50, seenThroughTurn: 44 }),
  ]);
  assert.doesNotMatch(text, /AAPL/);
  assert.match(text, /NVDA/);
});

test("a digest is stale exactly when the topic has moved past it", () => {
  assert.deepEqual(staleDigests([{ ...member(), digestThroughTurn: 42, turnCount: 42 }]), []);
  assert.deepEqual(staleDigests([{ ...member(), digestThroughTurn: 40, turnCount: 42 }]), ["t1"]);
});

test("a member that never had a digest counts as stale", () => {
  assert.deepEqual(staleDigests([{ ...member({ digest: null }), digestThroughTurn: 0, turnCount: 3 }]), ["t1"]);
});

test("a brand-new empty topic is not stale — there is nothing to summarise", () => {
  assert.deepEqual(staleDigests([{ ...member({ digest: null }), digestThroughTurn: 0, turnCount: 0 }]), []);
});
```

- [ ] **Step 2: 运行确认失败，Step 3: 实现，Step 4: 确认通过**

Run: `pnpm test 2>&1 | tail -20`

实现要点：名册每成员约 200 token；超预算按 `lastActivityMs` 降序保留，
结尾注明「另有 N 个成员未列出」。外部增量无变化时返回空字符串（不是空行、不是占位符）。

---

## Task 4: 缩要生成

**Files:**
- Create: `src/agent/research/digest.ts`
- Modify: `src/agent/research/__tests__/memberContext.test.ts`（不动）

`generateDigest(turns: IndexedTurn[], modelRouter): Promise<string>` —— 用 `modelClass: "SMALL"`，
输出 ≤300 token，描述「这个 topic 在研究什么、结论到哪」。

`refreshStaleDigests(researchId, store, sessions, modelRouter)` —— 对 `staleDigests()`
返回的成员逐个重新生成并 `setMemberDigest`。**并行上限 3。**

不写自动化测试（需要模型凭据）；`staleDigests` 的判定逻辑已在 Task 3 覆盖。
在报告里写明手动核对方式。

---

## Task 5: 控制器工具

**Files:**
- Create: `src/agent/research/tools.ts`

六个工具，签名见 spec §4.1。要点：

- `ask_topic(topic_id, message)` —— 内部 `orchestrator.run({ sessionId: topic_id, userMessage: message })`，
  **同步等待**，返回该 Topic 的最终回答文本。写入该 Topic `user_message` 事件时带
  `origin: { researchId, researchName }`（spec §5）。
- `fetch_from_topic(topic_id, need)` —— 用 Task 2 的纯函数做分片/汇总，
  中间的 SMALL 模型调用**只准返回选择**，返回值里的 `excerpts` 必须由工具从原始
  turn 文本取回。**用 `containsDigits` 校验 `framing`，含数字则丢弃 framing 而不是丢弃整次调用。**
- `focus(topic_id, symbol?)` —— 瞬时，只发 SSE 帧，不落库。
- `edit_tabs` / `edit_members` —— 落库，复用已有的 `replaceTopicCharts` / `replaceResearchMembers`，
  写入时标 `source: 'agent'`。
- `create_topic(name)` —— 建 Topic 并加为本 Research 成员。

**防护（spec §4.4）**：同一轮内 `ask_topic` 不得重入同一个 topic；并发上限 3；
单次超时 6 分钟，超时记为该成员本轮失败但不中断整轮。

---

## Task 6: ResearchRuntime 与 prompt

**Files:**
- Create: `src/agent/research/researchRuntime.ts`
- Create: `src/agent/research/researchPrompt.ts`
- Modify: `src/agent/createApp.ts`

**这是一个独立的运行时，不是 `OrchestratorRuntime` 的第二个实例。**
理由：`orchestrator.ts:177` 的 `orchestratorTools` 是私有硬编码，复用就得改它，
而「现有 agent 一行不改」是硬约束；且独立性本身就是设计要求。

**代价是与 `orchestrator.ts` 的循环结构有部分重复 —— 这是有意接受的，不要为了消除重复去抽公共基类。**
抽基类等于修改现有 agent。

`researchPrompt` 的模板变量：`currentDate` / `userMessage` / `history` / `roster` /
`externalDelta` / `tools`。**没有 `subagents`** —— 控制器的下属是完整的 Topic，不是 subagent。

`createApp.ts` 里装配并导出 `researchRuntime`。

---

## Task 7: 服务端路由与分流

**Files:**
- Modify: `src/server/server.ts`

- research 的增删改查与成员覆盖写，路径见 spec §8
- `handleChat` 按 sessionId 分流：是 research id 就走 `researchRuntime`，
  且**不要**调 `ensureTopic`（那会把 research 误建成 topic）
- 新增 SSE 帧 `topic_dispatch`（spec §4.5）：被驱动 Topic 的原始帧**不转发**，
  只发压缩的一行

无单元测试（无 HTTP 夹具，同第一阶段）。手动 curl 核对写进报告。

---

## Task 8: 客户端 API 与类型

**Files:**
- Modify: `client/src/lib/api.ts`、`client/src/types/core.ts`

`ResearchSummary`、`ResearchMember` 类型；`getResearches` / `createResearch` /
`updateResearch` / `deleteResearch` / `setResearchMembers`。
`StreamingApiClient` 增加 `topic_dispatch` 帧的处理。

---

## Task 9: 布局指令与撤销（纯逻辑）

**Files:**
- Create: `client/src/lib/researchLayout.ts`
- Create: `client/src/lib/__tests__/researchLayout.test.ts`
- Modify: `client/src/lib/topicCharts.ts`、`client/src/lib/__tests__/topicCharts.test.ts`

**先做这件事**：删除 `topicCharts.test.ts` 里
`"a hidden symbol stays hidden even though the agent charted it again"` 这个用例，
并改 `mergeTopicCharts` 使 agent 可以复活被隐藏的标的。
spec §6 明确推翻了第一阶段的这条规则 —— 这是「agent 全权」的直接推论，不是 bug。
换上新用例：agent 来源的改动可以覆盖 `hidden`，用户来源的不受影响。

`researchLayout.ts` 提供：`applyDirective`（把 agent 的布局指令归一化到状态）、
`invertDirective`（生成撤销所需的反向指令）。测试覆盖：瞬时指令无反向指令、
落库指令有反向指令、连续两次 agent 改动只保留最近一次可撤销。

---

## Task 10: MemberRow 与 MemberPicker

**Files:**
- Create: `client/src/components/workspace/MemberRow.tsx`、`MemberPicker.tsx`
- Modify: `client/src/components/workspace/ChartTabBar.tsx`（加「＋ 比较」）

严格按 spec §7.2、§7.4、§7.5：
圆角胶囊 vs 方角 tab 的形状区分、横向滚动不换行、悬停 `×` 删成员、
被 agent 聚焦时一次性 600ms 高亮描边。

---

## Task 11: ResearchWorkspace 与路由

**Files:**
- Create: `client/src/hooks/useResearchStream.ts`、`client/src/routes/research.tsx`
- Modify: `client/src/components/workspace/TopicWorkspace.tsx`、`StatusBar.tsx`、`App.tsx`

`TopicWorkspace` 已经收 `members` 数组 —— 加成员行、按 spec §7.3 的四种状态表渲染。
路由 `/research/:agentId/:researchId`。**聚焦成员不进 URL**（spec §7.9）。
窄屏下成员行留在图表区顶部（spec §7.7）。

**还要改 `ConversationPane`（spec §5）**：Topic 时间线上带 `origin` 的用户消息，
渲染成一个「来自 Research：半导体估值」的小标签，可折叠。
没有这个标签，用户三个月后会看到一堆自己不记得问过的问题 —— 历史就不可信了。
标签用 `text-label-3` + `fin-label`，点击跳转到那个 Research。

---

## Task 12: 侧栏两个分区与创建流

**Files:**
- Modify: `client/src/components/workspace/TopicRail.tsx`、两个 locale 文件

`Research` 与 `Topics` 两个**平铺**分区，不嵌套（spec §7.8）。
「＋ 比较」选定后创建 Research 并跳转，自动命名。

---

## 统一测试（全部任务完成后）

- [ ] `pnpm test` 全绿
- [ ] `pnpm build` 与 `pnpm build:client` 均无错误
- [ ] `cd client && npx tsc --noEmit` 零错误
- [ ] `grep -rn "orchestrator.ts\|dispatcher.ts" ` 的 git diff 为空 —— 现有 agent 未被改动：
      `git diff --stat -- src/framework/ src/agent/prompts/ src/agent/subagents/` 应无输出
- [ ] `en.ts` 与 `zh-CN.ts` key 集合一致
- [ ] 手动端到端：建两个 topic、合并为 research、向控制器提一个比较类问题，
      确认它调用了 `fetch_from_topic`、代问落在正确的 topic 且带来源标记、
      最终回答里的数字与 topic 原文逐字一致
