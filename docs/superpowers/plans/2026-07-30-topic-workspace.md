# Topic 工作区实施计划（第一阶段）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「聊天室 + 挂件图表」的前端改成以 Topic 为最小研究单元的三栏工作区，且这个外壳是第二阶段 Research 的同构外壳。

**Architecture:** Topic 复用现有的 `chat_rooms` 表与 session（两者已 1:1）。给它加上身份（`symbol`、`kind`）和一张只记录「用户对图表 tab 集合的意志」的 `topic_charts` 表 —— study 内容仍由 `buildSymbolChartWorkspace` 从消息推导，两者永不分叉。前端拆成 `TopicWorkspace` 三栏外壳（Rail / ChartPane / ConversationPane），可测逻辑全部抽成 `lib/` 纯函数。

**Tech Stack:** Node 23（`--experimental-strip-types`、`--experimental-sqlite`）、`node:test` + `node:assert/strict`、React 19、TanStack Query v5、react-router 7、Tailwind、pnpm。

## Global Constraints

- **规格文档**：`docs/superpowers/specs/2026-07-30-topic-workspace-design.md`。本计划的每个任务都以它为准。
- **测试运行器只有一个**：根目录 `pnpm test`。它跑 `node:test`，glob 见 `package.json`，其中客户端只覆盖 `client/src/lib/__tests__/*.test.ts`。
- **客户端没有 React 测试运行器。** 组件不写测试，也不要引入 vitest/jsdom（超出本次范围）。**所有可测逻辑必须抽成 `client/src/lib/` 下的纯函数**，组件只做编排。组件层的验收是 `pnpm build:client` 通过 + 手动核对。
- **测试风格**：`import test from "node:test"` + `import assert from "node:assert/strict"`，相对导入**必须带 `.ts` 后缀**（`--experimental-strip-types` 的要求，见现有测试）。
- **SQLite 测试**：用 `SqliteEventStore.open(":memory:")`，构造函数是 private，只能走这个静态方法。
- **命名**：代码中一律用 `topic`，不留 `room`。唯一例外是数据库表名 `chat_rooms` 保持不变（避免数据迁移风险），在 `SqliteEventStore` 内注明是历史遗留。
- **设计 token**：组件只引用等级（`--e2`、`--label-2`、`--fill-1`、`--sep` 等，见 `client/src/index.css`），不写死数值、不写 `white/N`、`slate-N`。
- **文案**：所有用户可见字符串走 i18n，`client/src/i18n/locales/en.ts` 与 `zh-CN.ts` 必须同步增删。
- **不要提交。** 每个任务只改代码、跑测试，把改动留在工作区。全部 12 个任务完成、
  用户审核通过之后，由用户决定如何提交。各任务末尾的 `git commit` 步骤保留下来只作为
  **提交信息草稿**，不要执行 —— 需要执行的是它之前的验证步骤。
  任务之间的审查边界靠 `.superpowers/sdd/2026-07-30-topic-workspace/` 下的 diff 快照维持。

---

## 文件结构

**新建（后端）**
- `src/infra/db/migrations.ts` — 幂等的 `ALTER TABLE` 辅助
- `src/infra/db/__tests__/topicStore.test.ts` — Topic 与 topic_charts 的存储层测试

**修改（后端）**
- `src/infra/db/sqliteEventStore.ts` — schema、room→topic 改名、新方法
- `src/server/server.ts` — 路由改名、新增 charts 路由、`handleUpdateTopic`

**新建（前端）**
- `client/src/lib/topicCharts.ts` — tab 集合合并规则（纯函数）
- `client/src/lib/splitLayout.ts` — 分栏比例夹取（纯函数）
- `client/src/lib/__tests__/topicCharts.test.ts`
- `client/src/lib/__tests__/splitLayout.test.ts`
- `client/src/hooks/useTopicStream.ts` — SSE / 流式 / 进度（抽自 `chat.tsx`）
- `client/src/hooks/useSplitLayout.ts` — `splitLayout.ts` 的 React 外壳 + localStorage
- `client/src/hooks/useTopicCharts.ts` — 推导结果 × 用户偏好的 query 编排
- `client/src/components/workspace/TopicWorkspace.tsx`
- `client/src/components/workspace/TopicRail.tsx`
- `client/src/components/workspace/TopicRailItem.tsx`
- `client/src/components/workspace/ChartPane.tsx`
- `client/src/components/workspace/ChartTabBar.tsx`
- `client/src/components/workspace/ConversationPane.tsx`
- `client/src/components/workspace/StatusBar.tsx`
- `client/src/routes/topic.tsx`

**修改（前端）**
- `client/src/lib/api.ts`、`client/src/App.tsx`、`client/src/i18n/locales/{en,zh-CN}.ts`
- `client/src/routes/strategies.tsx`、`client/src/routes/strategy-detail.tsx`

**删除**
- `client/src/components/room-selector.tsx`、`MarketChartWorkspace.tsx`、`chat.tsx`
- `client/src/routes/chat.tsx`、`client/src/routes/strategy-dashboard.css`
- `client/src/components/app-sidebar.tsx`（能力并入 `TopicRail`）

---

## Task 1: 存储层 —— Topic 身份与图表偏好

**Files:**
- Create: `src/infra/db/migrations.ts`
- Create: `src/infra/db/__tests__/migrations.test.ts`
- Create: `src/infra/db/__tests__/topicStore.test.ts`
- Modify: `src/infra/db/sqliteEventStore.ts`（`SCHEMA` 常量；`ChatRoomSummary` 类型；`:173-245` 的 room 方法）

**Interfaces:**
- Produces:
  - `addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void`
  - `type TopicKind = "instrument" | "macro"`
  - `type TopicSummary = { id: string; name: string; symbol: string | null; kind: TopicKind; createdAt: number; lastMessage: { text: string; createdAt: number } | null; messageCount: number }`
  - `type TopicChartPreferenceRow = { symbol: string; range: string | null; pinned: boolean; hidden: boolean; sortOrder: number }`
  - `SqliteEventStore` 上：`createTopic`、`ensureTopic`、`listTopics`、`renameTopic`、`updateTopic`、`deleteTopic`、`listTopicCharts`、`replaceTopicCharts`

- [ ] **Step 1: 写失败的测试**

Create `src/infra/db/__tests__/topicStore.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SqliteEventStore } from "../sqliteEventStore.ts";

test("a new topic defaults to the macro kind with no symbol", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "美联储降息路径");

  const topics = store.listTopics("agent-1");
  assert.equal(topics.length, 1);
  assert.equal(topics[0]?.name, "美联储降息路径");
  assert.equal(topics[0]?.kind, "macro");
  assert.equal(topics[0]?.symbol, null);
  store.close();
});

test("binding a symbol promotes a topic to the instrument kind", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "旧名字");

  assert.equal(store.updateTopic("agent-1", "topic-1", { name: "AAPL 估值", symbol: "AAPL", kind: "instrument" }), true);

  const topic = store.listTopics("agent-1")[0];
  assert.equal(topic?.name, "AAPL 估值");
  assert.equal(topic?.symbol, "AAPL");
  assert.equal(topic?.kind, "instrument");
  store.close();
});

test("updateTopic leaves unspecified fields untouched", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "AAPL");
  store.updateTopic("agent-1", "topic-1", { symbol: "AAPL", kind: "instrument" });

  store.updateTopic("agent-1", "topic-1", { name: "AAPL 财报后" });

  const topic = store.listTopics("agent-1")[0];
  assert.equal(topic?.name, "AAPL 财报后");
  assert.equal(topic?.symbol, "AAPL", "symbol must survive a name-only update");
  store.close();
});

test("updateTopic reports a miss for an unknown topic", () => {
  const store = SqliteEventStore.open(":memory:");
  assert.equal(store.updateTopic("agent-1", "nope", { name: "x" }), false);
  store.close();
});

test("chart preferences round-trip and replace wholesale", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "AAPL");

  store.replaceTopicCharts("topic-1", [
    { symbol: "AAPL", range: "1Y", pinned: true, hidden: false, sortOrder: 0 },
    { symbol: "NVDA", range: null, pinned: false, hidden: true, sortOrder: 1 },
  ]);
  assert.deepEqual(store.listTopicCharts("topic-1"), [
    { symbol: "AAPL", range: "1Y", pinned: true, hidden: false, sortOrder: 0 },
    { symbol: "NVDA", range: null, pinned: false, hidden: true, sortOrder: 1 },
  ]);

  store.replaceTopicCharts("topic-1", [
    { symbol: "MSFT", range: null, pinned: false, hidden: false, sortOrder: 0 },
  ]);
  assert.deepEqual(store.listTopicCharts("topic-1").map((row) => row.symbol), ["MSFT"]);
  store.close();
});

test("chart preferences are scoped per topic", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "A");
  store.createTopic("agent-1", "topic-2", "B");
  store.replaceTopicCharts("topic-1", [{ symbol: "AAPL", range: null, pinned: false, hidden: false, sortOrder: 0 }]);

  assert.deepEqual(store.listTopicCharts("topic-2"), []);
  store.close();
});

test("deleting a topic clears its chart preferences", () => {
  const store = SqliteEventStore.open(":memory:");
  store.createTopic("agent-1", "topic-1", "AAPL");
  store.replaceTopicCharts("topic-1", [{ symbol: "AAPL", range: null, pinned: false, hidden: false, sortOrder: 0 }]);

  assert.equal(store.deleteTopic("agent-1", "topic-1"), true);
  assert.deepEqual(store.listTopicCharts("topic-1"), []);
  store.close();
});

```

再建 `src/infra/db/__tests__/migrations.test.ts` —— 迁移要直接测，而不是隔着 store 测：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { addColumnIfMissing } from "../migrations.ts";

/** 迁移前的表长什么样。 */
function legacyRooms(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE chat_rooms (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.prepare("INSERT INTO chat_rooms VALUES (?, ?, ?, ?, ?)").run("r1", "a1", "老会话", 1, 1);
  return db;
}

test("an added column keeps the existing rows", () => {
  const db = legacyRooms();
  addColumnIfMissing(db, "chat_rooms", "symbol", "TEXT");

  const row = db.prepare("SELECT name, symbol FROM chat_rooms WHERE id = 'r1'").get() as
    { name: string; symbol: string | null };
  assert.equal(row.name, "老会话");
  assert.equal(row.symbol, null);
  db.close();
});

test("an added column applies its default to rows that predate it", () => {
  const db = legacyRooms();
  addColumnIfMissing(db, "chat_rooms", "kind", "TEXT NOT NULL DEFAULT 'macro'");

  const row = db.prepare("SELECT kind FROM chat_rooms WHERE id = 'r1'").get() as { kind: string };
  assert.equal(row.kind, "macro", "an existing room becomes a macro topic");
  db.close();
});

test("running the migration twice is a no-op rather than an error", () => {
  const db = legacyRooms();
  addColumnIfMissing(db, "chat_rooms", "symbol", "TEXT");
  // 真实的库已经被旧版本打开过，所以第二次一定会发生。
  assert.doesNotThrow(() => addColumnIfMissing(db, "chat_rooms", "symbol", "TEXT"));
  db.close();
});

test("adding a column does not disturb a column already there", () => {
  const db = legacyRooms();
  addColumnIfMissing(db, "chat_rooms", "symbol", "TEXT");
  db.prepare("UPDATE chat_rooms SET symbol = 'AAPL' WHERE id = 'r1'").run();

  addColumnIfMissing(db, "chat_rooms", "symbol", "TEXT");

  const row = db.prepare("SELECT symbol FROM chat_rooms WHERE id = 'r1'").get() as { symbol: string };
  assert.equal(row.symbol, "AAPL", "a second pass must not blank the column");
  db.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test 2>&1 | head -40`
Expected: FAIL — `store.createTopic is not a function`

- [ ] **Step 3: 写幂等迁移辅助**

Create `src/infra/db/migrations.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

/**
 * `ALTER TABLE … ADD COLUMN` throws when the column is already there, and
 * SQLite has no `IF NOT EXISTS` for it. Existing databases in the wild have
 * already been opened by an older build, so every added column must be
 * guarded by an actual look at the table.
 */
export function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existing) => existing.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
```

- [ ] **Step 4: 扩展 schema**

In `src/infra/db/sqliteEventStore.ts`, 在 `SCHEMA` 常量末尾追加 `topic_charts`：

```sql
CREATE TABLE IF NOT EXISTS topic_charts (
  topic_id   TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  range      TEXT,
  pinned     INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (topic_id, symbol)
);
```

在 `static open()` 中 `db.exec(SCHEMA)` **之后**加入列迁移：

```ts
db.exec(SCHEMA);
addColumnIfMissing(db, "chat_rooms", "symbol", "TEXT");
addColumnIfMissing(db, "chat_rooms", "kind", "TEXT NOT NULL DEFAULT 'macro'");
addColumnIfMissing(db, "chat_rooms", "archived_at", "INTEGER");
return new SqliteEventStore(db);
```

并在 `SCHEMA` 的 `chat_rooms` 定义上方加注释：

```
-- 表名 chat_rooms 是历史遗留。这些行在代码里一律称为 Topic:
-- 一个 topic 的 id 就是它的 session_id（见 server.ts 的 ensureTopic 调用）。
```

- [ ] **Step 5: 改名并实现新方法**

类型改为：

```ts
export type TopicKind = "instrument" | "macro";

export type TopicSummary = {
  id: string;
  name: string;
  symbol: string | null;
  kind: TopicKind;
  createdAt: number;
  lastMessage: { text: string; createdAt: number } | null;
  messageCount: number;
};

export type TopicChartPreferenceRow = {
  symbol: string;
  range: string | null;
  pinned: boolean;
  hidden: boolean;
  sortOrder: number;
};

type TopicRow = { id: string; name: string; symbol: string | null; kind: string; created_at: number };
```

方法改名映射（签名保持，除非注明）：

| 旧 | 新 |
| --- | --- |
| `createRoom(agentId, roomId, name, createdAt?)` | `createTopic(agentId, topicId, name, createdAt?)`，返回 `TopicSummary` |
| `ensureRoom` | `ensureTopic` |
| `listRooms(agentId): ChatRoomSummary[]` | `listTopics(agentId): TopicSummary[]`，SELECT 增加 `symbol, kind` |
| `renameRoom` | **删除** —— `updateTopic({ name })` 完全覆盖它，留着就是死代码 |
| `deleteRoom` | `deleteTopic`，事务内增删 `topic_charts` |
| — | `updateTopic(agentId, topicId, patch): boolean` |
| — | `listTopicCharts(topicId): TopicChartPreferenceRow[]` |
| — | `replaceTopicCharts(topicId, rows): void` |

`createTopic` 的返回值补上 `symbol: null, kind: "macro"`。

`updateTopic` —— 只更新传入的字段：

```ts
updateTopic(
  agentId: string,
  topicId: string,
  patch: { name?: string; symbol?: string | null; kind?: TopicKind },
): boolean {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) { assignments.push("name = ?"); values.push(patch.name); }
  if (patch.symbol !== undefined) { assignments.push("symbol = ?"); values.push(patch.symbol); }
  if (patch.kind !== undefined) { assignments.push("kind = ?"); values.push(patch.kind); }
  if (assignments.length === 0) return false;
  assignments.push("updated_at = ?");
  values.push(Date.now(), topicId, agentId);

  const result = this.db.prepare(
    `UPDATE chat_rooms SET ${assignments.join(", ")} WHERE id = ? AND agent_id = ?`,
  ).run(...values);
  return result.changes > 0;
}
```

图表偏好 —— 整体覆盖写，语义最简单，且天然处理删除：

```ts
listTopicCharts(topicId: string): TopicChartPreferenceRow[] {
  const rows = this.db.prepare(
    `SELECT symbol, range, pinned, hidden, sort_order
     FROM topic_charts WHERE topic_id = ? ORDER BY sort_order ASC, symbol ASC`,
  ).all(topicId) as Array<{ symbol: string; range: string | null; pinned: number; hidden: number; sort_order: number }>;
  return rows.map((row) => ({
    symbol: row.symbol,
    range: row.range,
    pinned: row.pinned === 1,
    hidden: row.hidden === 1,
    sortOrder: row.sort_order,
  }));
}

replaceTopicCharts(topicId: string, rows: TopicChartPreferenceRow[]): void {
  this.db.exec("BEGIN IMMEDIATE");
  try {
    this.db.prepare("DELETE FROM topic_charts WHERE topic_id = ?").run(topicId);
    const insert = this.db.prepare(
      `INSERT INTO topic_charts (topic_id, symbol, range, pinned, hidden, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(topicId, row.symbol, row.range, row.pinned ? 1 : 0, row.hidden ? 1 : 0, row.sortOrder);
    }
    this.db.exec("COMMIT");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

`deleteTopic` 的事务中，在删除 `chat_rooms` 行之前加一句：

```ts
this.db.prepare("DELETE FROM topic_charts WHERE topic_id = ?").run(topicId);
```

- [ ] **Step 6: 更新调用点让类型检查通过**

`src/server/server.ts` 中 `app.eventStore.ensureRoom` / `listRooms` / `createRoom` / `deleteRoom`
改为对应的 topic 方法。`handleRenameRoom` 内的 `renameRoom(agentId, roomId, name)` 改为
`updateTopic(agentId, roomId, { name })` —— 该 handler 本身留到 Task 2 再改造。
本步只做机械改名，路由路径不动。

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm test 2>&1 | tail -20`
Expected: PASS，且既有测试无回归

Run: `pnpm build`
Expected: 无 TypeScript 错误

- [ ] **Step 8: 提交**

```bash
git add src/infra/db/migrations.ts src/infra/db/__tests__/ src/infra/db/sqliteEventStore.ts src/server/server.ts
git commit -m "$(cat <<'EOF'
feat(store): give rooms a real identity as Topics

A room was already 1:1 with a session but had no identity beyond a name.
Topics add a subject (symbol + kind) and a table recording what the user
wants in the chart tab bar. topic_charts deliberately holds no study
content — that keeps coming from the message derivation, so the two
cannot drift apart.

Column migration is guarded by PRAGMA table_info: SQLite has no
IF NOT EXISTS for ADD COLUMN and existing databases are already open.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: HTTP 层 —— topic 路由

**Files:**
- Modify: `src/server/server.ts`（`:180-205` 的 handler；`:294-310` 的路由匹配）

**Interfaces:**
- Consumes: Task 1 的 `listTopics` / `createTopic` / `updateTopic` / `deleteTopic` / `listTopicCharts` / `replaceTopicCharts`
- Produces: HTTP 契约，Task 3 的 `apiClient` 依此实现

**关于测试：** 本仓库没有 HTTP 层的测试夹具（`src/server/__tests__/` 下三个测试都是纯函数级），
而构造完整 app 需要 orchestrator 与模型凭据。为这一个任务引入 HTTP 夹具超出本次范围。
**本任务的验收是类型检查 + 既有测试无回归 + Step 5 的手动核对。**这一点是有意为之，不要伪造测试。

- [ ] **Step 1: 改路由路径**

`server.ts` 中把 `rooms` 匹配块整体替换：

```ts
const topicsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topics$/);
if (topicsMatch) {
  const agentId = decodeURIComponent(topicsMatch[1]!);
  if (method === "GET") return jsonOk(res, { success: true, topics: app.eventStore.listTopics(agentId) });
  if (method === "POST") return await handleCreateTopic(req, res, app, agentId);
}

const topicChartsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topics\/([^/]+)\/charts$/);
if (topicChartsMatch) {
  const topicId = decodeURIComponent(topicChartsMatch[2]!);
  if (method === "GET") {
    return jsonOk(res, { success: true, charts: app.eventStore.listTopicCharts(topicId) });
  }
  if (method === "PUT") return await handleReplaceTopicCharts(req, res, app, topicId);
}

const topicMatch = pathname.match(/^\/api\/agents\/([^/]+)\/topics\/([^/]+)$/);
if (topicMatch) {
  const agentId = decodeURIComponent(topicMatch[1]!);
  const topicId = decodeURIComponent(topicMatch[2]!);
  if (method === "PUT") return await handleUpdateTopic(req, res, app, agentId, topicId);
  if (method === "DELETE") {
    if (!app.eventStore.deleteTopic(agentId, topicId)) return jsonError(res, 404, "topic not found");
    app.sessions.delete(topicId);
    return jsonOk(res, { success: true, message: "deleted" });
  }
}
```

**注意匹配顺序**：`/charts` 的正则必须排在 `topicMatch` 之前，否则 `([^/]+)$` 永远匹配不到带后缀的路径 —— 实际上 `topicMatch` 结尾有 `$` 不会误匹配，但保持先具体后一般的顺序可以避免后续维护出错。

- [ ] **Step 2: 把 `handleRenameRoom` 改成 `handleUpdateTopic`**

```ts
async function handleUpdateTopic(
  req: IncomingMessage,
  res: ServerResponse,
  app: App,
  agentId: string,
  topicId: string,
): Promise<void> {
  let body: { name?: string; symbol?: string | null; kind?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "invalid json");
  }

  const patch: { name?: string; symbol?: string | null; kind?: TopicKind } = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return jsonError(res, 400, "name must not be empty");
    patch.name = name;
  }
  if (body.symbol !== undefined) {
    // 空字符串表示解绑；否则规范化为大写 ticker。
    const symbol = body.symbol === null ? null : body.symbol.trim().toUpperCase();
    if (symbol && !/^[A-Z][A-Z.-]{0,5}$/.test(symbol)) return jsonError(res, 400, "invalid symbol");
    patch.symbol = symbol || null;
  }
  if (body.kind !== undefined) {
    if (body.kind !== "instrument" && body.kind !== "macro") return jsonError(res, 400, "invalid kind");
    patch.kind = body.kind;
  }

  if (!app.eventStore.updateTopic(agentId, topicId, patch)) {
    return jsonError(res, 404, "topic not found");
  }
  jsonOk(res, { success: true, topic: { id: topicId, ...patch } });
}
```

symbol 的正则与 `client/src/lib/chartWorkspace.ts` 的 `ticker()` 保持一致 —— 两端对 ticker 的定义必须相同，否则前端能显示的标的后端会拒绝。

- [ ] **Step 3: 新增 `handleReplaceTopicCharts`**

```ts
async function handleReplaceTopicCharts(
  req: IncomingMessage,
  res: ServerResponse,
  app: App,
  topicId: string,
): Promise<void> {
  let body: { charts?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "invalid json");
  }
  if (!Array.isArray(body.charts)) return jsonError(res, 400, "charts must be an array");

  const rows: TopicChartPreferenceRow[] = [];
  for (const [index, candidate] of body.charts.entries()) {
    const item = candidate as Record<string, unknown>;
    const symbol = typeof item?.symbol === "string" ? item.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z][A-Z.-]{0,5}$/.test(symbol)) return jsonError(res, 400, `invalid symbol at index ${index}`);
    rows.push({
      symbol,
      range: typeof item.range === "string" ? item.range : null,
      pinned: item.pinned === true,
      hidden: item.hidden === true,
      sortOrder: typeof item.sortOrder === "number" ? item.sortOrder : index,
    });
  }

  app.eventStore.replaceTopicCharts(topicId, rows);
  jsonOk(res, { success: true, charts: app.eventStore.listTopicCharts(topicId) });
}
```

- [ ] **Step 4: 类型检查与回归**

Run: `pnpm build && pnpm test 2>&1 | tail -20`
Expected: 无 TS 错误；既有测试全通过

- [ ] **Step 5: 手动核对**

一个终端跑 `pnpm dev`，另一个终端逐条执行并核对输出：

```bash
# 建一个 topic，记下返回的 id
curl -s -X POST localhost:3000/api/agents/<agentId>/topics \
  -H 'content-type: application/json' -d '{"name":"AAPL 估值"}'

# 绑定标的 —— 期望 success:true
curl -s -X PUT localhost:3000/api/agents/<agentId>/topics/<topicId> \
  -H 'content-type: application/json' -d '{"symbol":"aapl","kind":"instrument"}'

# 列出 —— 期望看到 symbol:"AAPL", kind:"instrument"
curl -s localhost:3000/api/agents/<agentId>/topics

# 非法 ticker —— 期望 400 invalid symbol
curl -s -X PUT localhost:3000/api/agents/<agentId>/topics/<topicId> \
  -H 'content-type: application/json' -d '{"symbol":"not a ticker"}'

# 图表偏好写入与读回
curl -s -X PUT localhost:3000/api/agents/<agentId>/topics/<topicId>/charts \
  -H 'content-type: application/json' \
  -d '{"charts":[{"symbol":"AAPL","pinned":true},{"symbol":"NVDA","hidden":true}]}'
curl -s localhost:3000/api/agents/<agentId>/topics/<topicId>/charts
```

端口以 `pnpm dev` 的启动输出为准。

- [ ] **Step 6: 提交**

```bash
git add src/server/server.ts
git commit -m "$(cat <<'EOF'
feat(api): topic routes replace room routes

Renames the endpoints and widens the update handler beyond `name` so a
topic can be bound to a symbol. Adds the chart-preference endpoint.

The ticker regex matches the client's parser in chartWorkspace.ts on
purpose: if the two disagree, the frontend can display a symbol the
backend refuses to store.

No unit test — this repo has no HTTP fixture and standing one up is out
of scope for this phase. Verified by hand against `pnpm dev`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 客户端 API 与类型

**Files:**
- Modify: `client/src/lib/api.ts:134-190`
- Modify: `client/src/types/core.ts`

**Interfaces:**
- Consumes: Task 2 的 HTTP 契约
- Produces: `apiClient.getTopics/createTopic/updateTopic/deleteTopic/batchDeleteTopics/getTopicCharts/setTopicCharts`；类型 `TopicKind`、`TopicSummary`、`TopicChartPreference`

- [ ] **Step 1: 加类型**

In `client/src/types/core.ts`:

```ts
export type TopicKind = "instrument" | "macro";

export type TopicSummary = {
    id: string;
    name: string;
    symbol: string | null;
    kind: TopicKind;
    createdAt: number;
    lastMessage: { text: string; createdAt: number } | null;
    messageCount: number;
};

/** 用户对图表 tab 集合的意志。不含 study 内容 —— 那些从消息推导。 */
export type TopicChartPreference = {
    symbol: string;
    /** null 表示沿用从消息推导出的 range。 */
    range: string | null;
    pinned: boolean;
    hidden: boolean;
    sortOrder: number;
};
```

- [ ] **Step 2: 改 apiClient**

把 `api.ts` 中 `createRoom` / `getRooms` / `deleteRoom` / `batchDeleteRooms` / `renameRoom` 整块替换：

```ts
    createTopic: (agentId: string, name?: string): Promise<{ success: boolean; topic: TopicSummary }> =>
        fetcher({ url: `/api/agents/${agentId}/topics`, method: "POST", body: { name } }),

    getTopics: (agentId: string): Promise<{ success: boolean; topics: TopicSummary[] }> =>
        fetcher({ url: `/api/agents/${agentId}/topics` }),

    updateTopic: (
        agentId: string,
        topicId: string,
        patch: { name?: string; symbol?: string | null; kind?: TopicKind },
    ): Promise<{ success: boolean }> =>
        fetcher({ url: `/api/agents/${agentId}/topics/${topicId}`, method: "PUT", body: patch }),

    deleteTopic: (agentId: string, topicId: string): Promise<{ success: boolean; message: string }> =>
        fetcher({ url: `/api/agents/${agentId}/topics/${topicId}`, method: "DELETE" }),

    batchDeleteTopics: async (agentId: string, topicIds: string[]) => {
        const results = await Promise.all(topicIds.map((topicId) => apiClient.deleteTopic(agentId, topicId)));
        return {
            success: results.every((result) => result.success),
            message: results.every((result) => result.success) ? "deleted" : "some topics could not be deleted",
        };
    },

    getTopicCharts: (agentId: string, topicId: string): Promise<{ success: boolean; charts: TopicChartPreference[] }> =>
        fetcher({ url: `/api/agents/${agentId}/topics/${topicId}/charts` }),

    setTopicCharts: (
        agentId: string,
        topicId: string,
        charts: TopicChartPreference[],
    ): Promise<{ success: boolean; charts: TopicChartPreference[] }> =>
        fetcher({ url: `/api/agents/${agentId}/topics/${topicId}/charts`, method: "PUT", body: { charts } }),
```

保持 `batchDeleteRooms` 原有的「逐个删除 + 汇总」形状（见 `api.ts:147-165`），只是改名与简化。

- [ ] **Step 3: 类型检查**

此时 `room-selector.tsx` 等旧组件会报错 —— **这是预期的**，它们在 Task 9/11 被删除。
本步只验证 `api.ts` 与 `core.ts` 自身：

Run: `cd client && npx tsc --noEmit 2>&1 | grep -E "lib/api.ts|types/core.ts" || echo "api/types clean"`
Expected: `api/types clean`

- [ ] **Step 4: 提交**

```bash
git add client/src/lib/api.ts client/src/types/core.ts
git commit -m "$(cat <<'EOF'
feat(client): topic API surface

Old room components now fail to typecheck; they are deleted in a later
task. Keeping the rename atomic across the client would mean one enormous
commit for a mechanical change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: tab 集合合并规则（本阶段的核心新逻辑）

**Files:**
- Create: `client/src/lib/topicCharts.ts`
- Create: `client/src/lib/__tests__/topicCharts.test.ts`

**Interfaces:**
- Consumes: `SymbolChartWorkspace`（`lib/chartWorkspace.ts`）、`StockRange`（`lib/stockChart.ts`）、`TopicChartPreference`（Task 3）
- Produces: `type TopicChartTab`、`mergeTopicCharts(derived: SymbolChartWorkspace[], preferences: TopicChartPreference[]): TopicChartTab[]`、`preferencesFor(tabs: TopicChartTab[], hidden?: string[]): TopicChartPreference[]`

这是规格 §3.2 那条规则的唯一实现处：**研究内容由 agent 产出，tab 集合由用户拥有。**

- [ ] **Step 1: 写失败的测试**

Create `client/src/lib/__tests__/topicCharts.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mergeTopicCharts } from "../topicCharts.ts";
import type { SymbolChartWorkspace } from "../chartWorkspace.ts";

const derivedChart = (symbol: string, range = "1D"): SymbolChartWorkspace => ({
  symbol,
  range: range as SymbolChartWorkspace["range"],
  createdAt: 1_700_000_000_000,
  studies: [],
});

test("with no preferences the derived tabs pass through in order", () => {
  const tabs = mergeTopicCharts([derivedChart("AAPL"), derivedChart("NVDA")], []);
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["AAPL", "NVDA"]);
  assert.equal(tabs.every((tab) => !tab.pinned && !tab.userAdded), true);
});

test("a hidden symbol stays hidden even though the agent charted it again", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA")],
    [{ symbol: "NVDA", range: null, pinned: false, hidden: true, sortOrder: 0 }],
  );
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["AAPL"]);
});

test("a user-added symbol the agent never charted becomes an empty tab", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL")],
    [{ symbol: "MSFT", range: "1Y", pinned: false, hidden: false, sortOrder: 1 }],
  );
  const msft = tabs.find((tab) => tab.symbol === "MSFT");
  assert.equal(msft?.userAdded, true);
  assert.deepEqual(msft?.studies, []);
  assert.equal(msft?.range, "1Y");
  assert.equal(msft?.createdAt, null);
});

test("once the agent charts a user-added symbol the tab carries its studies", () => {
  const charted = derivedChart("MSFT");
  const tabs = mergeTopicCharts(
    [charted],
    [{ symbol: "MSFT", range: null, pinned: false, hidden: false, sortOrder: 0 }],
  );
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]?.userAdded, false, "the agent's output supersedes the placeholder");
  assert.equal(tabs[0]?.createdAt, charted.createdAt);
});

test("a range preference overrides the derived range", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", "1D")],
    [{ symbol: "AAPL", range: "1Y", pinned: false, hidden: false, sortOrder: 0 }],
  );
  assert.equal(tabs[0]?.range, "1Y");
});

test("a null range preference keeps the derived range", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", "1Y")],
    [{ symbol: "AAPL", range: null, pinned: false, hidden: false, sortOrder: 0 }],
  );
  assert.equal(tabs[0]?.range, "1Y");
});

test("pinned tabs lead, and ties fall back to sort order", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA"), derivedChart("MSFT")],
    [
      { symbol: "MSFT", range: null, pinned: true, hidden: false, sortOrder: 5 },
      { symbol: "NVDA", range: null, pinned: false, hidden: false, sortOrder: 0 },
      { symbol: "AAPL", range: null, pinned: false, hidden: false, sortOrder: 1 },
    ],
  );
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["MSFT", "NVDA", "AAPL"]);
});

test("tabs without a preference sort after tabs that have one", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL"), derivedChart("NVDA")],
    [{ symbol: "NVDA", range: null, pinned: false, hidden: false, sortOrder: 0 }],
  );
  assert.deepEqual(tabs.map((tab) => tab.symbol), ["NVDA", "AAPL"]);
});

test("an unknown range string in a stored preference is ignored", () => {
  const tabs = mergeTopicCharts(
    [derivedChart("AAPL", "1Y")],
    [{ symbol: "AAPL", range: "not-a-range", pinned: false, hidden: false, sortOrder: 0 }],
  );
  assert.equal(tabs[0]?.range, "1Y", "a corrupt stored value must not break the chart");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A3 topicCharts | head -20`
Expected: FAIL — 找不到 `../topicCharts.ts`

- [ ] **Step 3: 实现**

Create `client/src/lib/topicCharts.ts`:

```ts
import type { SymbolChartWorkspace } from "./chartWorkspace.ts";
import { DEFAULT_STOCK_RANGE, STOCK_RANGES, type StockRange } from "./stockChart.ts";
import type { TopicChartPreference } from "../types/core.ts";

export type TopicChartTab = SymbolChartWorkspace & {
    pinned: boolean;
    /** True while the tab exists only because the user asked for it — the agent
     *  has not charted this symbol in this topic yet. */
    userAdded: boolean;
};

/** A preference row is durable storage, so it may hold a value this build no
 *  longer knows. A corrupt range must degrade to the derived one, never throw. */
function storedRange(value: string | null): StockRange | undefined {
    return value !== null && (STOCK_RANGES as readonly string[]).includes(value)
        ? value as StockRange
        : undefined;
}

/**
 * Fold what the agent charted together with what the user wants to see.
 *
 * The rule this file exists to enforce: research content comes from the agent
 * (the derived list), the tab set belongs to the user (the preference list).
 * Preferences never carry study data, so the two can never drift apart.
 */
export function mergeTopicCharts(
    derived: SymbolChartWorkspace[],
    preferences: TopicChartPreference[],
): TopicChartTab[] {
    const byPreference = new Map(preferences.map((preference) => [preference.symbol, preference]));
    const tabs: TopicChartTab[] = [];
    const seen = new Set<string>();

    for (const chart of derived) {
        const preference = byPreference.get(chart.symbol);
        if (preference?.hidden) continue;
        seen.add(chart.symbol);
        tabs.push({
            ...chart,
            range: storedRange(preference?.range ?? null) ?? chart.range,
            pinned: preference?.pinned ?? false,
            userAdded: false,
        });
    }

    // Symbols the user added that the agent has not charted yet: an empty tab
    // is the honest rendering — it says "this is on my list, nothing here yet".
    for (const preference of preferences) {
        if (preference.hidden || seen.has(preference.symbol)) continue;
        tabs.push({
            symbol: preference.symbol,
            range: storedRange(preference.range) ?? DEFAULT_STOCK_RANGE,
            createdAt: null,
            studies: [],
            pinned: preference.pinned,
            userAdded: true,
        });
    }

    const orderOf = (symbol: string): number => byPreference.get(symbol)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return tabs
        .map((tab, index) => ({ tab, index }))
        .sort((left, right) => {
            if (left.tab.pinned !== right.tab.pinned) return left.tab.pinned ? -1 : 1;
            const byOrder = orderOf(left.tab.symbol) - orderOf(right.tab.symbol);
            if (byOrder !== 0) return byOrder;
            return left.index - right.index;   // stable: derived order wins ties
        })
        .map(({ tab }) => tab);
}

/** Project the current tab set back into storable preferences. */
export function preferencesFor(tabs: TopicChartTab[], hidden: string[] = []): TopicChartPreference[] {
    const visible = tabs.map((tab, index) => ({
        symbol: tab.symbol,
        range: null,
        pinned: tab.pinned,
        hidden: false,
        sortOrder: index,
    }));
    return [
        ...visible,
        ...hidden.map((symbol, index) => ({
            symbol,
            range: null,
            pinned: false,
            hidden: true,
            sortOrder: visible.length + index,
        })),
    ];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -20`
Expected: PASS，全部 9 个新测试通过

- [ ] **Step 5: 提交**

```bash
git add client/src/lib/topicCharts.ts client/src/lib/__tests__/topicCharts.test.ts
git commit -m "$(cat <<'EOF'
feat(client): merge rule for the chart tab set

One rule, one file: research content comes from the agent, the tab set
belongs to the user. A hidden symbol stays hidden however many times the
agent charts it again — that is the whole point of giving the user
ownership.

Stored ranges are validated on read. A preference row outlives the build
that wrote it, so an unknown value must fall back rather than throw.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 分栏比例

**Files:**
- Create: `client/src/lib/splitLayout.ts`
- Create: `client/src/lib/__tests__/splitLayout.test.ts`
- Create: `client/src/hooks/useSplitLayout.ts`

**Interfaces:**
- Produces: `type SplitConstraints`、`MIN_CHART_WIDTH`、`MIN_CONVERSATION_WIDTH`、`chartFits(constraints): boolean`、`clampChartRatio(ratio, constraints): number`、`useSplitLayout(): { ratio, setRatio, fits, containerRef }`

- [ ] **Step 1: 写失败的测试**

Create `client/src/lib/__tests__/splitLayout.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { chartFits, clampChartRatio, MIN_CHART_WIDTH, MIN_CONVERSATION_WIDTH } from "../splitLayout.ts";

const wide = { totalWidth: 1600, railWidth: 240 };

test("a comfortable ratio passes through untouched", () => {
  assert.equal(clampChartRatio(0.46, wide), 0.46);
});

test("a ratio starving the chart is raised to its minimum", () => {
  const clamped = clampChartRatio(0.05, wide);
  assert.ok(Math.abs(clamped - MIN_CHART_WIDTH / (1600 - 240)) < 1e-9);
});

test("a ratio starving the conversation is lowered to its maximum", () => {
  const clamped = clampChartRatio(0.95, wide);
  assert.ok(Math.abs(clamped - (1 - MIN_CONVERSATION_WIDTH / (1600 - 240))) < 1e-9);
});

test("both panes fit when the available width covers both minimums", () => {
  assert.equal(chartFits({ totalWidth: MIN_CHART_WIDTH + MIN_CONVERSATION_WIDTH + 240, railWidth: 240 }), true);
});

test("the chart pane does not fit one pixel below the combined minimums", () => {
  assert.equal(chartFits({ totalWidth: MIN_CHART_WIDTH + MIN_CONVERSATION_WIDTH + 239, railWidth: 240 }), false);
});

test("a ratio is clamped to zero when the chart cannot fit at all", () => {
  assert.equal(clampChartRatio(0.46, { totalWidth: 600, railWidth: 240 }), 0);
});

test("a non-finite ratio falls back to the default rather than poisoning the layout", () => {
  assert.equal(clampChartRatio(Number.NaN, wide), 0.46);
});

test("a zero-width container yields zero rather than dividing by zero", () => {
  assert.equal(clampChartRatio(0.46, { totalWidth: 0, railWidth: 240 }), 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test 2>&1 | grep -A3 splitLayout | head -20`
Expected: FAIL — 找不到 `../splitLayout.ts`

- [ ] **Step 3: 实现纯函数**

Create `client/src/lib/splitLayout.ts`:

```ts
/** Below this the chart stops being readable and becomes decoration. */
export const MIN_CHART_WIDTH = 360;
/** Prose below ~480px wraps every sentence and a research note reads as a chat log. */
export const MIN_CONVERSATION_WIDTH = 480;
export const DEFAULT_CHART_RATIO = 0.46;

export type SplitConstraints = { totalWidth: number; railWidth: number };

function available({ totalWidth, railWidth }: SplitConstraints): number {
    return Math.max(0, totalWidth - railWidth);
}

/** Whether both panes can meet their minimums side by side. */
export function chartFits(constraints: SplitConstraints): boolean {
    return available(constraints) >= MIN_CHART_WIDTH + MIN_CONVERSATION_WIDTH;
}

/**
 * Clamp a stored ratio against the live container. Returns 0 when the chart
 * cannot fit at all — the caller renders a single column, which is a stable
 * state and not a degraded one.
 */
export function clampChartRatio(ratio: number, constraints: SplitConstraints): number {
    if (!chartFits(constraints)) return 0;
    const width = available(constraints);
    const safe = Number.isFinite(ratio) ? ratio : DEFAULT_CHART_RATIO;
    return Math.min(Math.max(safe, MIN_CHART_WIDTH / width), 1 - MIN_CONVERSATION_WIDTH / width);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: 实现 React 外壳**

Create `client/src/hooks/useSplitLayout.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { clampChartRatio, DEFAULT_CHART_RATIO, chartFits } from "@/lib/splitLayout";

/** The user's space preference is a habit, not a property of one topic. */
const STORAGE_KEY = "workspace.chartRatio";

function storedRatio(): number {
    if (typeof window === "undefined") return DEFAULT_CHART_RATIO;
    const raw = Number.parseFloat(window.localStorage.getItem(STORAGE_KEY) ?? "");
    return Number.isFinite(raw) ? raw : DEFAULT_CHART_RATIO;
}

export function useSplitLayout(railWidth: number) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [totalWidth, setTotalWidth] = useState(0);
    const [ratio, setRatioState] = useState(storedRatio);

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setTotalWidth(entry.contentRect.width);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const setRatio = useCallback((next: number) => {
        setRatioState(next);
        window.localStorage.setItem(STORAGE_KEY, String(next));
    }, []);

    const constraints = { totalWidth, railWidth };
    return {
        containerRef,
        /** 0 means the chart column must not render. */
        ratio: clampChartRatio(ratio, constraints),
        fits: chartFits(constraints),
        setRatio,
    };
}
```

- [ ] **Step 6: 提交**

```bash
git add client/src/lib/splitLayout.ts client/src/lib/__tests__/splitLayout.test.ts client/src/hooks/useSplitLayout.ts
git commit -m "$(cat <<'EOF'
feat(client): resizable split with tested clamping

Column widths were breakpoint constants, so the user had no say in how
space was divided. In a finance terminal that is a basic need, not an
advanced feature.

The arithmetic lives in a pure module because the client has no React
test runner — the hook is a thin shell over functions that are tested.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 抽出流式逻辑

**Files:**
- Create: `client/src/hooks/useTopicStream.ts`
- Reference: `client/src/components/chat.tsx:60-250`（抽取来源，本任务不删）

**Interfaces:**
- Consumes: `StreamingApiClient`、`apiClient.getMessages`（`lib/api.ts`）、`ProgressTask`（`components/ChatProgressPill.tsx`）、`ContentWithUser`（`components/chat/types.ts`）
- Produces:
  ```ts
  useTopicStream(agentId: UUID, topicId: UUID): {
      messages: ContentWithUser[];
      isHistoryLoading: boolean;
      isProcessing: boolean;
      streamingText: string;
      liveTasks: ProgressTask[];
      pendingApproval: StrategyApprovalDialogData | null;
      isConnected: boolean;
      sendMessage: (text: string) => Promise<void>;
      stop: () => void;
      resolveApproval: (decision: "approve" | "reject") => Promise<void>;
  }
  ```

- [ ] **Step 1: 建 hook 文件，原样搬运逻辑**

把 `chat.tsx` 中以下部分整体移入 `useTopicStream.ts`，**逻辑一字不改**（这是重构，不是重写）：

- `queryKey` / `useQuery` 取历史消息（`chat.tsx:77-86`）
- `appendMessages`（`:104-110`）
- `sendMessage` 的全部 SSE 回调（`:112-231`）—— 包括 `strategy_created` 的 toast、
  `dispatch`/`tool_call`/`task_done` 的任务聚合、`strategy_approval_required` 的中断捕获
- `handleStop`（`:242-246`）
- `handleStrategyApprove` / `handleStrategyReject`（`:248-296`）合并为 `resolveApproval(decision)`，
  两者除了传给 `activateStrategy` 的字符串与失败文案外完全相同

`pendingInterrupt` 内部状态保留原样，对外只暴露 `pendingApproval`（即 `pendingInterrupt?.payload ?? null`）。

- [ ] **Step 2: 新增连接状态**

`isConnected` 是状态栏需要的真实信号。在 hook 内维护：

```ts
const [isConnected, setIsConnected] = useState(true);
```

在 `sendMessage` 的 `onError` 回调里 `setIsConnected(false)`，在 `onStep` 收到任意帧时
`setIsConnected(true)`。**不要**引入心跳或轮询 —— 没有真实信号就不要显示，
这是规格 §8 的约束。

- [ ] **Step 3: 让旧 chat.tsx 改用 hook**

`chat.tsx` 改为调用 `useTopicStream`，删除被搬走的本地状态。渲染部分暂不动。
这一步是为了**证明抽取是等价的** —— 界面行为不变，测试与构建通过。

- [ ] **Step 4: 验证**

Run: `pnpm build:client`
Expected: 构建成功

手动核对：`pnpm dev` + `pnpm start:client`，在现有聊天界面发一条消息，确认
流式输出、任务进度条、策略草稿 toast 三者行为与改动前一致。

- [ ] **Step 5: 提交**

```bash
git add client/src/hooks/useTopicStream.ts client/src/components/chat.tsx
git commit -m "$(cat <<'EOF'
refactor(client): lift the streaming logic out of the chat component

Moved verbatim — a refactor, not a rewrite — so the old component still
renders it and any behaviour change would show up now rather than buried
in the layout work.

The two approval handlers differed only in one string; they collapse into
resolveApproval(decision).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: ConversationPane

**Files:**
- Create: `client/src/components/workspace/ConversationPane.tsx`
- Reference: `client/src/components/chat.tsx:298-380`（消息渲染）

**Interfaces:**
- Consumes: Task 6 的 `useTopicStream` 返回值（由父组件传入，**本组件不自己调 hook** —— 它不假设自己在跟谁说话，第二阶段 Research 会传入另一个 session 的流）
- Produces:
  ```tsx
  <ConversationPane
      agentId={agentId}
      title={string}            // topic 名或 research 名
      subtitle={string}         // "AAPL · 42 轮" 之类
      stream={ReturnType<typeof useTopicStream>}
      input={string}
      onInputChange={(value: string) => void}
  />
  ```

- [ ] **Step 1: 搬运渲染逻辑**

把 `chat.tsx` 的 `renderAssistantContent` / `renderAssistantBubble` / `renderUserBubble`
与 `ChatMessageList` + `ChatComposer` 的组合整体移入。**视觉一字不改** ——
`53d25fd` 已经把这部分调好了，这里只是换个容器。

顶部加一条 header（`title` + `subtitle`），用 `fin-label` 与 `text-label-2`：

```tsx
<header className="flex shrink-0 items-baseline gap-2 border-b border-sep px-4 py-2.5">
    <h2 className="truncate text-[13px] font-semibold tracking-[-0.011em]">{title}</h2>
    {subtitle ? <span className="fin-label truncate text-label-3">{subtitle}</span> : null}
</header>
```

- [ ] **Step 2: 参数化对话主体**

组件内部**不得**出现 `topicId`、`roomId` 或任何关于「对面是谁」的假设。
它只消费 `stream` 这个 props。这条是规格 §11 的要求，第二阶段的 Research 视图靠它复用。

- [ ] **Step 3: 验证**

Run: `pnpm build:client`
Expected: 成功

- [ ] **Step 4: 提交**

```bash
git add client/src/components/workspace/ConversationPane.tsx
git commit -m "$(cat <<'EOF'
feat(workspace): conversation pane

Takes its stream as a prop and holds no notion of who is on the other
end. Phase 2's Research view reuses this component with a different
session, which only works if the assumption is absent from day one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: ChartPane 与 ChartTabBar

**Files:**
- Create: `client/src/components/workspace/ChartPane.tsx`
- Create: `client/src/components/workspace/ChartTabBar.tsx`
- Create: `client/src/hooks/useTopicCharts.ts`
- Reference: `client/src/components/MarketChartWorkspace.tsx`（演化来源，Task 11 删除）

**Interfaces:**
- Consumes: `mergeTopicCharts` / `preferencesFor`（Task 4）、`apiClient.getTopicCharts` / `setTopicCharts`（Task 3）、`buildSymbolChartWorkspace`（不变）、`FinancialChartRenderer`
- Produces:
  ```ts
  useTopicCharts(agentId, topicId, messages, streamingText): {
      tabs: TopicChartTab[];
      activeSymbol: string | undefined;
      setActiveSymbol: (symbol: string) => void;
      addSymbol: (symbol: string) => void;
      hideSymbol: (symbol: string) => void;
      togglePinned: (symbol: string) => void;
      selectedSymbols: string[];              // 第二阶段的叠加对比预留，本阶段只读
      toggleSelected: (symbol: string) => void;
  }
  ```

- [ ] **Step 1: 写 useTopicCharts**

它把三样东西合起来：`buildSymbolChartWorkspace(messages, streamingText)` 的推导结果、
`getTopicCharts` 的用户偏好、以及 `mergeTopicCharts` 的规则。

隐藏集合需要单独保存 —— `preferencesFor` 的第二个参数就是为它准备的：

```ts
const hiddenRef = useRef<string[]>([]);   // 从 preferences 里 hidden 为 true 的行初始化
```

任何一次 `addSymbol` / `hideSymbol` / `togglePinned` 之后，调用
`apiClient.setTopicCharts(agentId, topicId, preferencesFor(tabs, hiddenRef.current))`
并 `invalidateQueries({ queryKey: ["topicCharts", agentId, topicId] })`。

`addSymbol` 必须用与后端相同的 ticker 正则校验（`/^[A-Z][A-Z.-]{0,5}$/`），
校验失败时不发请求，用 toast 提示。

- [ ] **Step 2: 写 ChartTabBar**

tab 样式沿用 `MarketChartWorkspace.tsx:104-117` 已调好的那套（`fin-figure`、方角 chip、
选中态 `bg-foreground text-background`）。新增三件事：

1. 每个 tab 悬停时显示一个「×」→ `hideSymbol`
2. 每个 tab 右键 / 长按菜单：钉住（`togglePinned`）。钉住的 tab 前加一个小圆点
3. tab 条末尾一个 `＋` 按钮，点开一个受控 `Input`，回车 → `addSymbol`

`userAdded` 且 `studies` 为空的 tab，在文字后加一个 `text-label-4` 的小圆点，
表示「已加入，agent 尚未画过」。

**为第二阶段预留但本阶段不实现**：tab 的多选叠加对比。
`selectedSymbols` / `toggleSelected` 保留在 hook 的返回值里但 `ChartTabBar` 暂不渲染选择态 UI，
这样第二阶段加叠加视图时不需要改数据结构（规格 §11）。

- [ ] **Step 3: 写 ChartPane**

由 `MarketChartWorkspace` 演化：保留 header + `FinancialChartRenderer` + `MessageTimeContext`
的结构，把 symbol tab 的来源从 `charts` prop 换成 `useTopicCharts` 的 `tabs`。

删除 `MarketChartWorkspace` 的 `collapsed` / `onCollapsedChange` 分支 ——
折叠现在由 `TopicWorkspace` 的分栏比例统一处理（Task 11），不再是图表组件的内部状态。

`viewportChartAreaHeight()` 里写死的 `WORKSPACE_HEADER_HEIGHT = 92` 换成 `ResizeObserver`
测量实际容器高度 —— 现在头部高度不再固定（tab 条可换行）。

`tabs` 为空时，`ChartPane` 返回 `null`，由父组件决定不渲染该列。

- [ ] **Step 4: 验证**

Run: `pnpm build:client`
Expected: 成功（旧组件的报错可暂存，Task 11 清理）

Run: `pnpm test 2>&1 | tail -10`
Expected: `chartWorkspace.test.ts` 与 `topicCharts.test.ts` 全通过 —— 推导逻辑未被破坏

- [ ] **Step 5: 提交**

```bash
git add client/src/components/workspace/ChartPane.tsx client/src/components/workspace/ChartTabBar.tsx client/src/hooks/useTopicCharts.ts
git commit -m "$(cat <<'EOF'
feat(workspace): chart pane with a tab set the user owns

The tab bar gains add, hide and pin. Until now the only way to change
what was on screen was to ask the agent to draw it again.

Collapse leaves the chart component: the split ratio owns it now, so
there is one mechanism for allocating width instead of two.

The 92px header constant is replaced by measurement — the tab row wraps
now, so its height is no longer knowable in advance.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: TopicRail

**Files:**
- Create: `client/src/components/workspace/TopicRail.tsx`
- Create: `client/src/components/workspace/TopicRailItem.tsx`
- Reference: `client/src/components/room-selector.tsx`、`client/src/components/app-sidebar.tsx`（Task 11 删除）

**Interfaces:**
- Consumes: `apiClient.getTopics` / `createTopic` / `updateTopic` / `deleteTopic` / `batchDeleteTopics`（Task 3）
- Produces: `<TopicRail agentId={UUID} activeTopicId={UUID | undefined} collapsed={boolean} onCollapsedChange={(next: boolean) => void} />`

- [ ] **Step 1: 写 TopicRailItem**

一行的内容：标的徽标（`kind === "instrument"` 时显示 `symbol`，用 `fin-figure` 方角 chip；
`macro` 时显示一个 `text-label-3` 的小图标）、topic 名、最后消息摘要（`text-label-3`，单行截断）。

行内菜单（`ui/dropdown-menu.tsx`）：改名、绑定标的、删除。
「绑定标的」打开一个 `Input`，提交时调 `updateTopic({ symbol, kind: "instrument" })`；
清空则 `updateTopic({ symbol: null, kind: "macro" })`。

- [ ] **Step 2: 写 TopicRail**

从 `room-selector.tsx` 保留这些已经能用的能力，其余全部丢弃：
- 列表查询与 `staleTime` 设置
- 新建 topic（`generateChatRoomName` 改名为 `generateTopicName`，移入 `lib/utils.ts`）
- 多选批量删除

丢弃：`app-sidebar.tsx` 的 agent 分组（实际只有一个 agent，`showAgentHeader` 的判断证明了这点）、
`FloatingSidebarToggle`（折叠现在是 Rail 自己的 props）、埋在 `:427` 的策略入口
（改为 Rail 底部一个明确的一级入口，链接 `/strategies/:agentId`）。

顶部：产品标识 + 折叠按钮。折叠态宽 56px，只显示标的徽标。

- [ ] **Step 3: i18n**

新增 key 到 `en.ts` 与 `zh-CN.ts`（两个文件必须同步）：

```
topics.title / topics.new / topics.empty / topics.rename / topics.delete
topics.bindSymbol / topics.bindSymbolPlaceholder / topics.unbindSymbol
topics.invalidSymbol / topics.macroKind / topics.collapse / topics.expand
```

删除已废弃的 `chat.room*` 系列 key。

- [ ] **Step 4: 验证**

Run: `pnpm build:client`
Expected: 成功

- [ ] **Step 5: 提交**

```bash
git add client/src/components/workspace/TopicRail.tsx client/src/components/workspace/TopicRailItem.tsx client/src/lib/utils.ts client/src/i18n/locales/en.ts client/src/i18n/locales/zh-CN.ts
git commit -m "$(cat <<'EOF'
feat(workspace): topic rail

Replaces a 731-line room selector. The agent grouping goes: there is one
agent, and the old code's own showAgentHeader check said so.

The strategies link was on line 427 of that file. It is a top-level
entry now — navigation that has to be found by reading source is not
navigation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: StatusBar

**Files:**
- Create: `client/src/components/workspace/StatusBar.tsx`
- Modify: `client/src/App.tsx`（移除浮动 `ThemeToggle`）

**Interfaces:**
- Consumes: `useTopicStream` 的 `isConnected`（Task 6）、`apiClient.listStrategies`、`ThemeContext`、`LanguageContext`
- Produces: `<StatusBar topic={TopicSummary | undefined} isConnected={boolean} />`

- [ ] **Step 1: 实现**

高 36px，`border-b border-sep`，内容自左至右：

1. 当前 topic 的标的与 kind（`instrument` 显示 ticker，`macro` 显示 topic 名）
2. 连接状态：`isConnected` 为真时一个 `emerald` 小点 + "Live"，否则 `rose` 小点 + "Disconnected"
3. 右侧：模式 chip、`ThemeToggle`、语言切换

模式 chip **必须来自真实数据**：查询 `apiClient.listStrategies()`，
若存在任一 `dsl.mode === "live"` 的活跃策略则显示 `LIVE`，否则 `PAPER`。
现有 `strategies.tsx` 里的 `<ModeTag mode="paper" />` 是硬编码的，一并改为同一来源。

**不要添加**市场时钟、P&L、账户净值 —— 没有真实数据源（规格 §8、§12）。

- [ ] **Step 2: 从 App.tsx 移除浮动 ThemeToggle**

删除 `App.tsx` 中 `<ThemeToggle />` 那一行及其 import。它现在住在状态栏里。

- [ ] **Step 3: 验证**

Run: `pnpm build:client`
Expected: 成功

手动核对：停掉后端（`pnpm dev` 按 Ctrl-C）后发一条消息，状态栏应转为 Disconnected。

- [ ] **Step 4: 提交**

```bash
git add client/src/components/workspace/StatusBar.tsx client/src/App.tsx client/src/routes/strategies.tsx
git commit -m "$(cat <<'EOF'
feat(workspace): status bar carrying only real signals

paper/live was a hardcoded string in the strategies page. It now comes
from the strategy data, which makes it information rather than
decoration.

No market clock, no P&L: there is no data source behind either, and a
fake one becomes a promise that has to be torn out in phase 2.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: TopicWorkspace 外壳、路由、删除旧文件

**Files:**
- Create: `client/src/components/workspace/TopicWorkspace.tsx`
- Create: `client/src/routes/topic.tsx`
- Modify: `client/src/App.tsx`
- Delete: `client/src/components/room-selector.tsx`、`MarketChartWorkspace.tsx`、`chat.tsx`、`app-sidebar.tsx`、`client/src/routes/chat.tsx`

**Interfaces:**
- Consumes: Task 5–10 的全部产出

- [ ] **Step 1: 写 TopicWorkspace**

三栏 grid + 可拖拽分隔条。它接受一个**成员数组**而非单个 topic —— 这是规格 §11
的同构外壳要求，第二阶段的 Research 传 N 个成员，本阶段永远传 1 个：

```tsx
export function TopicWorkspace({ agentId, members, activeTopic }: {
    agentId: UUID;
    /** Phase 1 always passes one. Research passes N. */
    members: TopicSummary[];
    activeTopic: TopicSummary;
}) {
    const [railCollapsed, setRailCollapsed] = useState(false);
    const railWidth = railCollapsed ? 56 : 240;
    const { containerRef, ratio, setRatio } = useSplitLayout(railWidth);
    const stream = useTopicStream(agentId, activeTopic.id);
    const charts = useTopicCharts(agentId, activeTopic.id, stream.messages, stream.streamingText);
    const [input, setInput] = useState("");

    const showChart = ratio > 0 && charts.tabs.length > 0;

    return (
        <div className="flex h-dvh max-h-dvh flex-col overflow-hidden">
            <StatusBar topic={activeTopic} isConnected={stream.isConnected} />
            <div ref={containerRef} className="flex min-h-0 flex-1">
                <TopicRail
                    agentId={agentId}
                    activeTopicId={activeTopic.id}
                    collapsed={railCollapsed}
                    onCollapsedChange={setRailCollapsed}
                />
                {showChart && (
                    <>
                        <div style={{ width: `${ratio * 100}%` }} className="min-w-0">
                            <ChartPane charts={charts} />
                        </div>
                        <SplitHandle onRatioChange={setRatio} containerRef={containerRef} railWidth={railWidth} />
                    </>
                )}
                <div className="min-w-0 flex-1">
                    <ConversationPane
                        agentId={agentId}
                        title={activeTopic.name}
                        subtitle={activeTopic.symbol ?? undefined}
                        stream={stream}
                        input={input}
                        onInputChange={setInput}
                    />
                </div>
            </div>
            {stream.pendingApproval && (
                <StrategyApprovalDialog
                    isOpen
                    data={stream.pendingApproval}
                    onApprove={() => stream.resolveApproval("approve")}
                    onReject={() => stream.resolveApproval("reject")}
                />
            )}
        </div>
    );
}
```

`SplitHandle` 是同文件内的小组件：一条 `w-1 cursor-col-resize` 的竖条，
`onPointerDown` 后监听 `pointermove`，用 `(event.clientX - containerLeft - railWidth) / availableWidth`
算出新比例交给 `setRatio`（`useSplitLayout` 内部已负责夹取）。
`onPointerUp` 解绑。拖拽期间给 `document.body` 加 `select-none`。

**图表列为空时无过渡动画** —— 布局跳变反映的是内容的有无，不是状态切换（规格 §7）。
不要给 grid 或宽度加 `transition`。

- [ ] **Step 1b: 窄屏的上下堆叠（规格 §7）**

`< 1024px` 时三栏不成立。用 `use-mobile.tsx` 已有的 `useIsMobile` 模式加一个 1024 的媒体查询钩子
（`client/src/hooks/use-mobile.tsx` 现有实现的断点是 768，**不要改它** —— 它服务于别处；
在 `useSplitLayout` 同目录新增 `useIsNarrow()`，阈值 1024）：

```ts
export function useIsNarrow(): boolean {
    const [narrow, setNarrow] = useState(
        () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
    );
    useEffect(() => {
        const media = window.matchMedia("(max-width: 1023px)");
        const update = () => setNarrow(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    return narrow;
}
```

`TopicWorkspace` 在 `narrow` 为真时：

1. 主容器由 `flex` 改为 `flex flex-col`，图表在上、对话在下；图表区固定 `h-[42dvh] shrink-0`，
   对话区 `flex-1`。分隔条不渲染（拖拽在窄屏没有意义，两栏都已到最小宽度）。
2. `TopicRail` 不占据文档流，改为 off-canvas —— 用现有的 `ui/sheet.tsx` 包裹，
   由 `StatusBar` 左侧新增的一个 `PanelLeft` 按钮触发。该按钮仅在 `narrow` 时渲染。

`useSplitLayout` 在窄屏下的返回值不使用，但**不要跳过调用** —— hook 必须无条件调用。

- [ ] **Step 2: 写 routes/topic.tsx**

职责：解析 `:agentId` / `:topicId`，查 `getTopics`，处理三种情况：
1. `topicId` 不存在于列表 → 重定向到列表首项
2. 列表为空 → 空状态 + 「新建 Topic」按钮（沿用 `routes/chat.tsx:70-92` 的空态结构与文案 key）
3. 正常 → `<TopicWorkspace agentId={agentId} members={[topic]} activeTopic={topic} />`

- [ ] **Step 3: 改 App.tsx 路由**

```tsx
<Route path="/" element={<RootRedirect />} />
<Route path="topic/:agentId/:topicId" element={<Topic />} />
<Route path="topic/:agentId" element={<Topic />} />
<Route path="strategies/:agentId" element={<Strategies />} />
<Route path="strategies/:agentId/:strategyId" element={<StrategyDetail />} />
```

`RootRedirect` 改为跳 `/topic/${firstAgent.id}`。

删除 `SidebarProvider` / `SidebarInset` / `AppSidebar` / `FloatingSidebarToggle` 的包裹
—— `TopicWorkspace` 自己管理三栏，不再需要 shadcn 的 sidebar 外壳。
`App.tsx:63` 那个 `pl-[20px]` 一并消失。

`chat.tsx:145` 里 `navigate` 到策略详情的路径不变（`/strategies/...`），
但该逻辑此时已在 `useTopicStream` 中，无需改动。

- [ ] **Step 4: 删除旧文件**

```bash
git rm client/src/components/room-selector.tsx \
       client/src/components/MarketChartWorkspace.tsx \
       client/src/components/chat.tsx \
       client/src/components/app-sidebar.tsx \
       client/src/routes/chat.tsx
```

删除后检查 `ui/sidebar.tsx` 是否还有引用：

Run: `cd client/src && grep -rn "ui/sidebar" . || echo "sidebar unused"`

若输出 `sidebar unused`，一并 `git rm client/src/components/ui/sidebar.tsx`。

- [ ] **Step 5: 验证**

Run: `cd client && npx tsc --noEmit`
Expected: 零错误 —— 这是整个重构的收口检查

Run: `pnpm build:client`
Expected: 构建成功

Run: `pnpm test 2>&1 | tail -10`
Expected: 全部通过

手动核对清单（`pnpm dev` + `pnpm start:client`）：
- [ ] `/` 重定向到某个 topic
- [ ] Rail 能新建、改名、绑定标的、删除 topic
- [ ] 绑定标的后徽标出现在 Rail 行内与状态栏
- [ ] 发消息 → 流式输出、进度条正常
- [ ] agent 画图后 tab 出现；`＋` 手动加一个标的；`×` 隐藏一个
- [ ] 隐藏后再让 agent 画同一个标的 —— **应保持隐藏**（Task 4 测试覆盖的规则，此处验证端到端）
- [ ] 拖拽分隔条，刷新页面后宽度保持
- [ ] 窗口缩到 1024px 以下，转为上下布局
- [ ] 宏观 topic（无标的、无图表）→ 对话占满，无空的图表列
- [ ] Rail 折叠 / 展开

- [ ] **Step 6: 提交**

```bash
git add -A client/src
git commit -m "$(cat <<'EOF'
feat(workspace): the three-column shell, and the chat app it replaces

TopicWorkspace takes a member array rather than a single topic. Phase 1
always passes one; Research will pass N. That is the whole reason this
shell exists in this shape.

Deletes room-selector (731 lines), chat.tsx (444), MarketChartWorkspace
and app-sidebar. Their responsibilities are now in components small
enough to reason about one at a time.

No transition on the chart column appearing: it reflects whether content
exists, not a state toggle, and animating it would claim otherwise.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: 收编策略页的视觉

**Files:**
- Modify: `client/src/routes/strategies.tsx`
- Modify: `client/src/routes/strategy-detail.tsx`
- Delete: `client/src/routes/strategy-dashboard.css`

**只换样式，不动结构与 IA。**路由不变、功能不变、列不变。

- [ ] **Step 1: 逐类替换**

| `sq-*` 类 | 替换为 |
| --- | --- |
| `.sq-root` / `.sq-shell` | `min-h-dvh bg-background` + `mx-auto max-w-6xl px-6 py-8` |
| `.sq-masthead` / `.sq-title` / `.sq-kicker` | `flex items-baseline justify-between` + `text-2xl font-semibold tracking-[-0.02em]` + `fin-label text-label-3` |
| `.sq-tabs` / `.sq-tab` | 现有 `ui/button.tsx` 的 ghost variant |
| `.sq-chip` | 与 `ChartTabBar` 相同的 chip 样式（`fin-figure`、方角、选中态 `bg-foreground text-background`）—— 全 app 一种 chip |
| `.sq-board` / `.sq-table` | `material rounded-lg border border-sep shadow-e2-rim` + `w-full text-sm`，表头 `fin-label text-label-3 border-b border-sep` |
| `.sq-status` / `.led` | 状态点用语义色 token；tone 映射保留现有 `STATUS_TONE` 的逻辑 |
| `.sq-mode` / `.dot` | 与 StatusBar 的模式 chip 同一个组件 —— 抽到 `components/workspace/ModeChip.tsx` 并两处共用 |
| `.sq-cell-mono` | `fin-figure` |
| `.sq-cell-faint` | `text-label-3` |
| `.sq-note` | `text-label-2 text-sm` |
| `.sq-rise` 及其 `animationDelay` | **删除**。逐行入场动画在一个每 15 秒轮询刷新的表格上会不断重放 |

- [ ] **Step 2: 删 CSS 并确认无残留**

```bash
git rm client/src/routes/strategy-dashboard.css
```

Run: `cd client/src && grep -rn "sq-" . || echo "no sq- classes remain"`
Expected: `no sq- classes remain`

- [ ] **Step 3: 验证**

Run: `cd client && npx tsc --noEmit && pnpm build`
Expected: 成功

手动核对：策略列表与详情页在浅色和深色下都正常，与工作区视觉连贯。

- [ ] **Step 4: 提交**

```bash
git add -A client/src
git commit -m "$(cat <<'EOF'
refactor(strategies): fold the page into the shared design language

Deletes the parallel sq-* stylesheet. Same route, same columns, same
behaviour — a visual enclave is how "unify the design language" gets
postponed forever.

Drops the per-row entrance animation: the table refetches every 15
seconds, so it replayed on every poll.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## 收口检查

全部任务完成后：

- [ ] `pnpm test` 全通过
- [ ] `pnpm build` 与 `pnpm build:client` 均无错误
- [ ] `cd client/src && grep -rn "roomId\|RoomSelector\|getRooms\|sq-" .` 无输出
- [ ] `grep -rn "border-white/\|slate-[0-9]\|gray-[0-9]" client/src` 无新增（对照 `53d25fd`）
- [ ] `en.ts` 与 `zh-CN.ts` 的 key 集合一致。两个文件都是 `export default {…}` 的字面量，
      可以直接用 Node 加载后比对（`--experimental-strip-types` 能吃 TS）：

      ```bash
      node --experimental-strip-types -e '
        const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) =>
          v && typeof v === "object" ? flat(v, p + k + ".") : [p + k]);
        Promise.all([
          import("./client/src/i18n/locales/en.ts"),
          import("./client/src/i18n/locales/zh-CN.ts"),
        ]).then(([en, zh]) => {
          const a = new Set(flat(en.default)), b = new Set(flat(zh.default));
          const only = (x, y) => [...x].filter((k) => !y.has(k));
          const missing = [...only(a, b).map((k) => "zh 缺: " + k), ...only(b, a).map((k) => "en 缺: " + k)];
          console.log(missing.length ? missing.join("\n") : "i18n keys match");
        });
      '
      ```

      Expected: `i18n keys match`
- [ ] Task 11 的手动核对清单全部勾选
