# Skill 契约实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `SkillRegistry` 从"只认三个字段的加载器"补成完整 skill 契约（渐进披露、agent 小节下传、allowed-tools、受约束的脚本执行），并用 `skills/stock-analysis/` 验证。

**Architecture:** 改动集中在 L1 框架四个文件。SKILL.md 的 frontmatter 用 `yaml` 包解析；正文经 `SkillResult.content` → `skill_result` 事件 → `projectForPrompt` 进入下一轮 prompt；`## for: <agent>` 小节由 `Dispatcher` 在 dispatch 时追加到 task 尾部。skill 的生命周期天然是单个 turn——`orchestrator.run()` 每轮新建一个 `Dispatcher`（`orchestrator.ts:202`），状态随之消失。

**Tech Stack:** TypeScript + Node 23（`--experimental-strip-types`）、`node:test`、`node:child_process`、新增 `yaml` 依赖。

## Global Constraints

- **不要 `git commit`。** 每个任务结尾只 `git add` 暂存，等用户过一遍。这条覆盖本计划中所有"提交"字样。
- 所有测试用 `npm test` 跑；单文件用 `node --env-file=.env --experimental-strip-types --experimental-sqlite --test <path>`。
- 严禁 `any`；`tsconfig` 是严格模式，`npx tsc -p tsconfig.json --noEmit` 必须干净。
- 错误一律返回结构化 `{ code, message }`，**唯一例外**是 §3.2 的启动期校验，那里必须抛。
- 路径安全：任何来自模型的路径，`path.resolve` 后必须落在该 skill 目录内，否则 `path_escape`。
- 注释写"为什么"，不写"做了什么"，与仓库现有风格一致。

---

### Task 1: 装 yaml，打开 framework 测试目录

**Files:**
- Modify: `package.json`（`dependencies` 与 `scripts.test`）

**Interfaces:**
- Produces: `yaml` 包的 `parse` 可用；`src/framework/__tests__/*.test.ts` 会被 `npm test` 收集。

`src/framework/__tests__/toolAccess.test.ts` 已存在但**从未被执行过**——`package.json` 的 test glob 没有包含 `src/framework/**`。后续任务的测试全在这个目录，必须先修好，否则写的测试会"全绿"因为根本没跑。

- [ ] **Step 1: 确认现状**

Run: `npm test 2>&1 | grep -c "tool .* not allowed"`
Expected: `0`（toolAccess 的测试一条都没跑）

- [ ] **Step 2: 装依赖**

```bash
pnpm add yaml
```

- [ ] **Step 3: 把 framework 测试加进 glob**

修改 `package.json` 的 `scripts.test`，在 `"src/agent/**/__tests__/*.test.ts"` 之后插入一段：

```
"src/framework/__tests__/*.test.ts"
```

- [ ] **Step 4: 验证**

Run: `npm test 2>&1 | tail -5`
Expected: 测试总数比之前多（toolAccess 的用例开始执行），且全部通过。

- [ ] **Step 5: 暂存**

```bash
git add package.json pnpm-lock.yaml
```

---

### Task 2: frontmatter 用 yaml 解析，启动期严格失败

**Files:**
- Modify: `src/framework/skill.ts`
- Test: `src/framework/__tests__/skill.test.ts`（新建）

**Interfaces:**
- Produces:
  ```ts
  export type SkillDefinition = {
    name: string;
    description: string;
    path: string;      // SKILL.md 的绝对路径
    dir: string;       // skill 目录的绝对路径，路径锁定的基准
    body: string;
    agents?: AgentKind[];
    tools?: string[];
    workflow?: string;
  };
  ```
  `SkillRegistry.loadFromDirectory(root: string): Promise<void>` — 目录不存在静默返回；目录存在而内容非法则抛。

- [ ] **Step 1: 写失败的测试**

新建 `src/framework/__tests__/skill.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillRegistry } from "../skill.ts";

async function skillDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "skills-"));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

test("frontmatter arrays are parsed as arrays, not as their string form", async () => {
  const root = await skillDir({
    "demo/SKILL.md": [
      "---",
      "name: demo",
      "description: a demo skill",
      "agents: [market_data, market_research]",
      "tools:",
      "  - get_stock_price",
      "  - stock_rsi",
      "---",
      "body text",
    ].join("\n"),
  });

  const registry = new SkillRegistry();
  await registry.loadFromDirectory(root);
  const skill = registry.get("demo")!;

  assert.deepEqual(skill.agents, ["market_data", "market_research"]);
  assert.deepEqual(skill.tools, ["get_stock_price", "stock_rsi"]);
  assert.equal(skill.body.trim(), "body text");
  assert.equal(skill.dir, path.join(root, "demo"));
});

test("a missing skills directory is a legal empty state", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory("/nonexistent-skills-dir-xyz");
  assert.deepEqual(registry.list(), []);
});

test("an unknown agent name in frontmatter fails at load time", async () => {
  const root = await skillDir({
    "demo/SKILL.md": [
      "---",
      "name: demo",
      "description: a demo skill",
      "agents: [market_data, not_an_agent]",
      "---",
      "body",
    ].join("\n"),
  });

  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /not_an_agent/);
});

test("a missing description fails at load time rather than loading silently", async () => {
  const root = await skillDir({
    "demo/SKILL.md": ["---", "name: demo", "---", "body"].join("\n"),
  });

  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /description/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skill.test.ts`
Expected: FAIL — `agents` 是字符串 `"[market_data, market_research]"`，非法 skill 不抛。

- [ ] **Step 3: 实现**

在 `src/framework/skill.ts`：

删除 `parseYamlSubset` 整个函数，改用 yaml 包。头部加：

```ts
import { parse as parseYaml } from "yaml";
import type { AgentKind } from "./types.ts";

const AGENT_KINDS: ReadonlySet<string> = new Set<AgentKind>([
  "market_data",
  "market_research",
  "trading_operations",
]);
```

`SkillDefinition` 换成 Interfaces 段里的形状（加 `dir` / `agents` / `tools`）。

`loadFromDirectory` 改为：

```ts
async loadFromDirectory(root: string): Promise<void> {
  // 目录不存在是合法的空状态（还没有任何 skill）；目录存在而内容非法
  // 则必须抛——一个写错的 skill 静默消失是最难查的一类问题。
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const skillPath = path.join(dir, "SKILL.md");
    const raw = await readFile(skillPath, "utf8").catch(() => null);
    if (raw === null) continue;
    const skill = parseSkillMarkdown(skillPath, dir, raw);
    this.skills.set(skill.name, skill);
  }
}
```

`parseSkillMarkdown` 改为：

```ts
function parseSkillMarkdown(filePath: string, dir: string, raw: string): SkillDefinition {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`skill missing frontmatter: ${filePath}`);

  const frontmatter = parseYaml(match[1] ?? "") as Record<string, unknown> | null;
  if (!frontmatter || typeof frontmatter !== "object") {
    throw new Error(`skill frontmatter must be a mapping: ${filePath}`);
  }

  const name = requireString(frontmatter, "name", filePath);
  const description = requireString(frontmatter, "description", filePath);

  const skill: SkillDefinition = {
    name,
    description,
    path: filePath,
    dir,
    body: match[2] ?? "",
  };

  const agents = optionalStringArray(frontmatter, "agents", filePath);
  if (agents) {
    for (const agent of agents) {
      if (!AGENT_KINDS.has(agent)) {
        throw new Error(`skill ${name} declares unknown agent '${agent}': ${filePath}`);
      }
    }
    skill.agents = agents as AgentKind[];
  }

  const tools = optionalStringArray(frontmatter, "tools", filePath);
  if (tools) skill.tools = tools;

  if (frontmatter["workflow"] !== undefined) {
    skill.workflow = requireString(frontmatter, "workflow", filePath);
  }
  return skill;
}

function requireString(frontmatter: Record<string, unknown>, key: string, filePath: string): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`skill frontmatter '${key}' must be a non-empty string: ${filePath}`);
  }
  return value.trim();
}

function optionalStringArray(
  frontmatter: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] | undefined {
  const value = frontmatter[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`skill frontmatter '${key}' must be a list of strings: ${filePath}`);
  }
  return value as string[];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skill.test.ts`
Expected: 4 个用例全部 PASS。再跑 `npx tsc -p tsconfig.json --noEmit`，无输出。

- [ ] **Step 5: 暂存**

```bash
git add src/framework/skill.ts src/framework/__tests__/skill.test.ts
```

---

### Task 3: `## for: <agent>` 小节切分

**Files:**
- Modify: `src/framework/skill.ts`
- Test: `src/framework/__tests__/skill.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SkillDefinition`、`AGENT_KINDS`
- Produces: `SkillDefinition.agentSections: Partial<Record<AgentKind, string>>`（必有此字段，无小节时是空对象）；导出 `splitAgentSections(body: string, context: string): { body: string; agentSections: Partial<Record<AgentKind, string>> }`

- [ ] **Step 1: 写失败的测试**

追加到 `src/framework/__tests__/skill.test.ts`：

```ts
import { splitAgentSections } from "../skill.ts";

test("the body splits into a shared part and per-agent sections", () => {
  const { body, agentSections } = splitAgentSections(
    [
      "shared guidance",
      "",
      "## for: market_data",
      "take daily bars first",
      "",
      "## for: market_research",
      "30 days of news only",
    ].join("\n"),
    "test",
  );

  assert.equal(body.trim(), "shared guidance");
  assert.equal(agentSections.market_data?.trim(), "take daily bars first");
  assert.equal(agentSections.market_research?.trim(), "30 days of news only");
  assert.equal(agentSections.trading_operations, undefined);
});

test("a body with no sections yields an empty section map", () => {
  const { body, agentSections } = splitAgentSections("just prose", "test");
  assert.equal(body, "just prose");
  assert.deepEqual(agentSections, {});
});

test("a section addressed to an unknown agent is refused", () => {
  assert.throws(() => splitAgentSections("## for: nobody\nhi", "test"), /nobody/);
});

test("ordinary headings are not mistaken for agent sections", () => {
  const { body, agentSections } = splitAgentSections("## Overview\ntext", "test");
  assert.match(body, /## Overview/);
  assert.deepEqual(agentSections, {});
});
```

并修改 Task 2 的第一个用例，追加一行断言：

```ts
  assert.deepEqual(skill.agentSections, {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skill.test.ts`
Expected: FAIL — `splitAgentSections` 不存在。

- [ ] **Step 3: 实现**

`src/framework/skill.ts` 加：

```ts
/** 只匹配行首的 `## for: <agent>`，普通二级标题不受影响。 */
const AGENT_SECTION = /^##[ \t]+for:[ \t]*(\S+)[ \t]*$/gm;

export function splitAgentSections(
  raw: string,
  context: string,
): { body: string; agentSections: Partial<Record<AgentKind, string>> } {
  const agentSections: Partial<Record<AgentKind, string>> = {};
  const matches = [...raw.matchAll(AGENT_SECTION)];
  if (matches.length === 0) return { body: raw, agentSections };

  const body = raw.slice(0, matches[0]!.index);
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i]!;
    const agent = current[1]!;
    if (!AGENT_KINDS.has(agent)) {
      throw new Error(`skill section '## for: ${agent}' names an unknown agent: ${context}`);
    }
    const start = current.index + current[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : raw.length;
    agentSections[agent as AgentKind] = raw.slice(start, end).trim();
  }
  return { body, agentSections };
}
```

在 `SkillDefinition` 上加 `agentSections: Partial<Record<AgentKind, string>>`（非可选），并在 `parseSkillMarkdown` 里把 `body: match[2] ?? ""` 换成：

```ts
  const split = splitAgentSections(match[2] ?? "", filePath);
  const skill: SkillDefinition = {
    name,
    description,
    path: filePath,
    dir,
    body: split.body,
    agentSections: split.agentSections,
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skill.test.ts`
Expected: 8 个用例全部 PASS。

- [ ] **Step 5: 暂存**

```bash
git add src/framework/skill.ts src/framework/__tests__/skill.test.ts
```

---

### Task 4: 正文注入进下一轮 prompt

**Files:**
- Modify: `src/framework/types.ts`（`SkillResult`）
- Modify: `src/framework/skill.ts`（`invoke` 返回 content）
- Modify: `src/framework/sessionState.ts:44`（事件白名单）、`sessionState.ts:362` 附近（投影）
- Modify: `src/framework/orchestrator.ts`（skill 分支记录 `skill_result` 事件）
- Test: `src/framework/__tests__/skill.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `SkillDefinition.body`
- Produces: `SkillResult.content?: string`；新事件 `(orchestrator, "skill_result")`，payload `{ skill: string; content?: string; summary: string }`

- [ ] **Step 1: 写失败的测试**

追加到 `src/framework/__tests__/skill.test.ts`：

```ts
test("invoking a skill without a workflow returns its body as content", async () => {
  const root = await skillDir({
    "demo/SKILL.md": ["---", "name: demo", "description: d", "---", "the framework text"].join("\n"),
  });
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(root);

  const result = await registry.invoke("demo", {
    sessionId: "s",
    userMessage: "m",
    dispatcher: undefined as never,
    state: undefined as never,
  });

  assert.equal(result.status, "loaded");
  assert.equal(result.content?.trim(), "the framework text");
});
```

新建 `src/framework/__tests__/skillProjection.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SessionState } from "../sessionState.ts";

test("an invoked skill's content reaches the next round's prompt", () => {
  const state = new SessionState("s", new Date().toISOString());
  const turn = state.beginTurn("analyse NVDA");

  state.record("orchestrator", "skill_invoke", { skill: "demo" });
  state.record("orchestrator", "skill_result", {
    skill: "demo",
    summary: "Loaded skill demo.",
    content: "RULE: cite every number",
  });

  const projection = state.projectForPrompt(turn);
  assert.match(projection.currentTurnProgress, /RULE: cite every number/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skill.test.ts src/framework/__tests__/skillProjection.test.ts`
Expected: FAIL — `content` 未定义；`skill_result` 事件被 `KINDS` 拒绝。

- [ ] **Step 3: 实现**

`src/framework/types.ts` 的 `SkillResult` 加一行：

```ts
  /** SKILL.md 正文。渐进披露的第二级：只在 invoke 之后的轮次进入上下文。 */
  content?: string;
```

`src/framework/skill.ts` 的 `invoke`，把无 workflow 的分支改为：

```ts
    if (!skill.workflow) {
      return {
        skill: skill.name,
        status: "loaded",
        summary: `Loaded skill ${skill.name}.`,
        content: skill.body,
      };
    }
```

`src/framework/sessionState.ts:44` 的 orchestrator 白名单加 `"skill_result"`：

```ts
  orchestrator: new Set(["reply", "dispatch", "skill_invoke", "skill_result", "error", "tool_use", "tool_result"]),
```

`projectForPrompt` 的当前 turn 循环里，`skill_invoke` 那行之后加：

```ts
      else if (e.kind === "skill_result") {
        const content = e.payload.content as string | undefined;
        progressLines.push(
          content
            ? `[skill ${e.payload.skill as string}]\n${content}`
            : `[skill ${e.payload.skill as string}] ${e.payload.summary as string}`,
        );
      }
```

`src/framework/orchestrator.ts` 的 skill 分支（`orchestrator.ts:271` 之后），在 `skillResult = await this.skills.invoke(...)` 下面加：

```ts
        state.record("orchestrator", "skill_result", {
          skill: skillResult.skill,
          summary: skillResult.summary,
          ...(skillResult.content ? { content: skillResult.content } : {}),
        });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | tail -5`
Expected: 全绿。`npx tsc -p tsconfig.json --noEmit` 无输出。

- [ ] **Step 5: 暂存**

```bash
git add src/framework/types.ts src/framework/skill.ts src/framework/sessionState.ts src/framework/orchestrator.ts src/framework/__tests__/
```

---

### Task 5: agent 小节下传给 subagent

**Files:**
- Modify: `src/framework/dispatcher.ts`
- Modify: `src/framework/orchestrator.ts`（skill 分支调用 setter）
- Test: `src/framework/__tests__/dispatcherSkill.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `agentSections`
- Produces: `Dispatcher.setSkillSections(sections: Partial<Record<AgentKind, string>>): void`

生命周期不需要额外机制：`orchestrator.run()` 每轮新建一个 `Dispatcher`（`orchestrator.ts:202`），所以 setter 写进的状态在下一个 turn 自动消失。Task 9 有一个测试专门盯这件事。

- [ ] **Step 1: 写失败的测试**

新建 `src/framework/__tests__/dispatcherSkill.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { TaskRequest } from "../types.ts";

function harness(): { dispatcher: Dispatcher; seen: TaskRequest[] } {
  const seen: TaskRequest[] = [];
  const subagents = new SubagentRegistry();
  subagents.register({
    name: "market_data",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: [],
    systemPrompt: { system: "", prompt: "" },
  });
  subagents.register({
    name: "market_research",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: [],
    systemPrompt: { system: "", prompt: "" },
  });

  const state = new SessionState("s", new Date().toISOString());
  state.beginTurn("go");
  const runtime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest }) => {
      seen.push(ctx.request);
    },
  };
  const dispatcher = new Dispatcher(
    "s",
    subagents,
    runtime as never,
    new McpToolRegistry(),
    state,
  );
  return { dispatcher, seen };
}

test("the section for the dispatched agent is appended to its task", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillSections({ market_data: "RSI period 14" });

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 1);
  assert.match(seen[0]!.task, /analyse NVDA/);
  assert.match(seen[0]!.task, /RSI period 14/);
});

test("an agent with no section receives its task unchanged", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillSections({ market_data: "RSI period 14" });

  await dispatcher.dispatch([{ agent: "market_research", task: "find news" }]);

  assert.equal(seen[0]!.task, "find news");
});

test("with no skill active every task is untouched", async () => {
  const { dispatcher, seen } = harness();
  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);
  assert.equal(seen[0]!.task, "analyse NVDA");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/dispatcherSkill.test.ts`
Expected: FAIL — `setSkillSections is not a function`。

- [ ] **Step 3: 实现**

`src/framework/dispatcher.ts` 加字段与方法：

```ts
  private skillSections: Partial<Record<AgentKind, string>> = {};

  /**
   * 当前 turn 激活的 skill 的定向指导。orchestrator 每轮新建一个 Dispatcher，
   * 所以这份状态活不过这个 turn——skill 的单 turn 生命周期由此而来，不需要
   * 额外的清理逻辑。
   */
  setSkillSections(sections: Partial<Record<AgentKind, string>>): void {
    this.skillSections = sections;
  }
```

在 `runExistingTask` 里，把传给 runtime 的 request 换成加工过的版本。改 `recordDispatch` 之后那一句：

```ts
  private withSkillSection(request: TaskRequest): TaskRequest {
    const section = this.skillSections[request.agent];
    if (!section) return request;
    return { ...request, task: `${request.task}\n\n[SKILL GUIDANCE]\n${section}` };
  }
```

然后 `runExistingTask` 内 `subagentRuntime.run(definition, { ... request, ... })` 处传 `this.withSkillSection(request)`。注意 `recordDispatch` 记录的仍是**原始 task**——事件日志里该看到用户意图，而不是每次都拖着一段框架文本。

`src/framework/orchestrator.ts` 的 skill 分支，在 `state.record("orchestrator", "skill_result", ...)` 之后加：

```ts
        const invoked = this.skills.get(stepObj.skill);
        if (invoked) dispatcher.setSkillSections(invoked.agentSections);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/dispatcherSkill.test.ts`
Expected: 3 个用例 PASS。

- [ ] **Step 5: 暂存**

```bash
git add src/framework/dispatcher.ts src/framework/orchestrator.ts src/framework/__tests__/dispatcherSkill.test.ts
```

---

### Task 6: allowed-tools 强制

**Files:**
- Modify: `src/framework/dispatcher.ts`
- Modify: `src/framework/orchestrator.ts`
- Test: `src/framework/__tests__/dispatcherSkill.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SkillDefinition.agents` / `.tools`，Task 5 的 setter 模式
- Produces: `Dispatcher.setSkillAllowance(allowance: { agents?: AgentKind[]; tools?: string[] }): void`；被拒绝时 `task_result.error.code === "agent_not_allowed"`

- [ ] **Step 1: 写失败的测试**

追加到 `src/framework/__tests__/dispatcherSkill.test.ts`：

```ts
test("dispatching to an agent the active skill did not declare is refused before the run", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillAllowance({ agents: ["market_data"] });

  await dispatcher.dispatch([{ agent: "market_research", task: "find news" }]);

  assert.equal(seen.length, 0);
});

test("an allowance listing the agent lets the task through", async () => {
  const { dispatcher, seen } = harness();
  dispatcher.setSkillAllowance({ agents: ["market_data"] });

  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  assert.equal(seen.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/dispatcherSkill.test.ts`
Expected: FAIL — `setSkillAllowance is not a function`。

- [ ] **Step 3: 实现**

`src/framework/dispatcher.ts`：

```ts
  private skillAllowance: { agents?: AgentKind[]; tools?: string[] } = {};

  /** 激活的 skill 的工作范围。叠加在 toolAccess 的分类隔离之上，不取代它。 */
  setSkillAllowance(allowance: { agents?: AgentKind[]; tools?: string[] }): void {
    this.skillAllowance = allowance;
  }
```

在 `runExistingTask` 开头、`try` 之前插入拒绝逻辑：

```ts
    const allowedAgents = this.skillAllowance.agents;
    if (allowedAgents && !allowedAgents.includes(request.agent)) {
      const message = `agent ${request.agent} is outside the active skill's declared agents`;
      this.state.recordTaskResult(request.agent, taskId, {
        task_id: taskId,
        agent: request.agent,
        status: "failed",
        summary: message,
        error: { code: "agent_not_allowed", message },
      });
      return;
    }
```

`resolveAllowedTools` 里，在现有 `defaultSet` 校验之后加一层：

```ts
      const skillTools = this.skillAllowance.tools;
      if (skillTools && !skillTools.includes(name)) {
        throw new Error(`tool ${name} is outside the active skill's declared tools`);
      }
```

`src/framework/orchestrator.ts` 的 skill 分支，紧接 `setSkillSections` 之后：

```ts
        if (invoked) {
          dispatcher.setSkillAllowance({
            ...(invoked.agents ? { agents: invoked.agents } : {}),
            ...(invoked.tools ? { tools: invoked.tools } : {}),
          });
        }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | tail -5`
Expected: 全绿。

- [ ] **Step 5: 暂存**

```bash
git add src/framework/dispatcher.ts src/framework/orchestrator.ts src/framework/__tests__/dispatcherSkill.test.ts
```

---

### Task 7: 路径锁定与 `read_skill_reference`

**Files:**
- Create: `src/framework/skillFiles.ts`
- Create: `mcp_tools/skill/skillFileTools.ts`
- Modify: `src/framework/orchestrator.ts:157`（`ORCHESTRATOR_DIRECT_TOOLS`）
- Modify: `src/agent/createApp.ts`（注册工具）
- Test: `src/framework/__tests__/skillFiles.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `SkillDefinition.dir`
- Produces:
  ```ts
  export function resolveSkillFile(
    skill: SkillDefinition,
    kind: "references" | "scripts",
    relative: string,
  ): string;  // 越界时抛 SkillPathError
  export class SkillPathError extends Error { readonly code = "path_escape"; }
  ```
  工具 `read_skill_reference`，入参 `{ skill: string; path: string }`，category `"main"`。

- [ ] **Step 1: 写失败的测试**

新建 `src/framework/__tests__/skillFiles.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveSkillFile, SkillPathError } from "../skillFiles.ts";
import type { SkillDefinition } from "../skill.ts";

const SKILL: SkillDefinition = {
  name: "demo",
  description: "d",
  path: "/tmp/skills/demo/SKILL.md",
  dir: "/tmp/skills/demo",
  body: "",
  agentSections: {},
};

test("a plain relative path resolves inside the skill directory", () => {
  assert.equal(
    resolveSkillFile(SKILL, "references", "playbook.md"),
    path.join("/tmp/skills/demo", "references", "playbook.md"),
  );
});

test("a traversing path is refused", () => {
  assert.throws(() => resolveSkillFile(SKILL, "references", "../../../etc/passwd"), SkillPathError);
});

test("an absolute path is refused", () => {
  assert.throws(() => resolveSkillFile(SKILL, "references", "/etc/passwd"), SkillPathError);
});

test("a path that only looks like a sibling directory is refused", () => {
  // "references-evil" 以 "references" 为前缀；单纯的 startsWith 会漏掉这一个。
  assert.throws(() => resolveSkillFile(SKILL, "references", "../references-evil/x.md"), SkillPathError);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skillFiles.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

新建 `src/framework/skillFiles.ts`：

```ts
import path from "node:path";
import type { SkillDefinition } from "./skill.ts";

export class SkillPathError extends Error {
  readonly code = "path_escape";
}

/**
 * 把模型给出的相对路径锁进 skill 的 references/ 或 scripts/ 目录。
 *
 * 比较时在基准目录后补一个分隔符：否则 "references-evil" 会通过
 * "references" 的前缀检查。
 */
export function resolveSkillFile(
  skill: SkillDefinition,
  kind: "references" | "scripts",
  relative: string,
): string {
  const base = path.resolve(skill.dir, kind);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new SkillPathError(`path '${relative}' escapes ${skill.name}/${kind}`);
  }
  return target;
}
```

新建 `mcp_tools/skill/skillFileTools.ts`：

```ts
import { readFile } from "node:fs/promises";
import type { RegisteredTool } from "../toolRegistry.ts";
import type { JsonObject } from "../../src/framework/types.ts";
import type { SkillRegistry } from "../../src/framework/skill.ts";
import { resolveSkillFile, SkillPathError } from "../../src/framework/skillFiles.ts";

export const READ_SKILL_REFERENCE = "read_skill_reference";

/** 渐进披露的第三级：references 只在模型明确要读时才进上下文。 */
export function createReadSkillReferenceTool(skills: SkillRegistry): RegisteredTool {
  return {
    name: READ_SKILL_REFERENCE,
    description:
      "Read one reference file belonging to an active skill. Paths are relative to that skill's references/ directory.",
    category: "main",
    inputSchema: {
      type: "object",
      required: ["skill", "path"],
      properties: {
        skill: { type: "string", description: "The skill name." },
        path: { type: "string", description: "Path relative to the skill's references/ directory." },
      },
    },
    execute: async (input: JsonObject) => {
      const name = typeof input["skill"] === "string" ? input["skill"] : "";
      const relative = typeof input["path"] === "string" ? input["path"] : "";
      const skill = skills.get(name);
      if (!skill) {
        return {
          summary: `Skill not found: ${name}`,
          error: { code: "skill_not_found", message: `Skill not found: ${name}` },
        };
      }
      let full: string;
      try {
        full = resolveSkillFile(skill, "references", relative);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          summary: message,
          error: { code: error instanceof SkillPathError ? "path_escape" : "invalid_path", message },
        };
      }
      const content = await readFile(full, "utf8").catch(() => null);
      if (content === null) {
        const message = `Reference not found: ${relative}`;
        return { summary: message, error: { code: "reference_not_found", message } };
      }
      return {
        summary: `Read ${name}/references/${relative} (${content.length} chars).`,
        generation_context: { data: { skill: name, path: relative, content } },
      };
    },
  };
}
```

`src/framework/orchestrator.ts:157` 改为：

```ts
const ORCHESTRATOR_DIRECT_TOOLS = new Set<string>(["read_skill_reference", "run_skill_script"]);
```

`src/agent/createApp.ts` 在 `await skills.loadFromDirectory(...)` 之后注册：

```ts
  const { createReadSkillReferenceTool } = await import("../../mcp_tools/skill/skillFileTools.ts");
  toolRegistry.register(createReadSkillReferenceTool(skills));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | tail -5`
Expected: 全绿。`npx tsc -p tsconfig.json --noEmit` 无输出。

- [ ] **Step 5: 暂存**

```bash
git add src/framework/skillFiles.ts mcp_tools/skill/ src/framework/orchestrator.ts src/agent/createApp.ts src/framework/__tests__/skillFiles.test.ts
```

---

### Task 8: `run_skill_script` 子进程执行

**Files:**
- Create: `src/framework/skillScript.ts`
- Modify: `mcp_tools/skill/skillFileTools.ts`（加第二个工具）
- Modify: `src/agent/createApp.ts`
- Test: `src/framework/__tests__/skillScript.test.ts`（新建）

**Interfaces:**
- Consumes: Task 7 的 `resolveSkillFile`
- Produces:
  ```ts
  export type ScriptOutcome =
    | { ok: true; value: unknown }
    | { ok: false; code: "script_timeout" | "script_failed"; message: string };
  export function runSkillScript(
    scriptPath: string,
    args: unknown,
    timeoutMs?: number,
  ): Promise<ScriptOutcome>;
  export const SCRIPT_TIMEOUT_MS = 10_000;
  ```
  工具 `run_skill_script`，入参 `{ skill: string; script: string; args?: object }`。

- [ ] **Step 1: 写失败的测试**

新建 `src/framework/__tests__/skillScript.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSkillScript } from "../skillScript.ts";

async function script(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-script-"));
  const file = path.join(dir, "s.ts");
  await writeFile(file, source, "utf8");
  return file;
}

const ECHO = `
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const args = JSON.parse(raw || "{}");
  process.stdout.write(JSON.stringify({ doubled: args.n * 2 }));
});
`;

test("args go in as JSON on stdin and the result comes back parsed", async () => {
  const outcome = await runSkillScript(await script(ECHO), { n: 21 });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value, { doubled: 42 });
});

test("a script that never finishes is killed and reported as a timeout", async () => {
  const file = await script("while (true) {}");
  const outcome = await runSkillScript(file, {}, 300);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "script_timeout");
});

test("a non-zero exit is reported with its stderr", async () => {
  const file = await script(`process.stderr.write("boom"); process.exit(3);`);
  const outcome = await runSkillScript(file, {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "script_failed");
  assert.match(outcome.message, /boom/);
});

test("stdout that is not JSON is a failure, not a silent empty result", async () => {
  const file = await script(`process.stdout.write("not json");`);
  const outcome = await runSkillScript(file, {});
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "script_failed");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skillScript.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

新建 `src/framework/skillScript.ts`：

```ts
import { spawn } from "node:child_process";

export const SCRIPT_TIMEOUT_MS = 10_000;

export type ScriptOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: "script_timeout" | "script_failed"; message: string };

/**
 * 在子进程里跑一个 skill 脚本。入参走 stdin JSON，出参从 stdout 解析。
 *
 * 选子进程而不是同进程 import，换来的是「可超时、崩溃不带走服务器」。它不是
 * 权限隔离——本项目没有沙箱，脚本仍以服务器同等权限运行。脚本本身是仓库里的
 * 可信代码，模型只能选择调不调，不能构造被执行的内容。
 */
export function runSkillScript(
  scriptPath: string,
  args: unknown,
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
): Promise<ScriptOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: ScriptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: "script_timeout", message: `Script timed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      finish({ ok: false, code: "script_failed", message: error.message });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          ok: false,
          code: "script_failed",
          message: `Script exited with ${code}: ${stderr.trim() || "(no stderr)"}`,
        });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(stdout) });
      } catch {
        finish({
          ok: false,
          code: "script_failed",
          message: `Script stdout was not JSON: ${stdout.slice(0, 200)}`,
        });
      }
    });

    child.stdin.end(JSON.stringify(args ?? {}));
  });
}
```

`mcp_tools/skill/skillFileTools.ts` 追加：

```ts
import { runSkillScript } from "../../src/framework/skillScript.ts";

export const RUN_SKILL_SCRIPT = "run_skill_script";

export function createRunSkillScriptTool(skills: SkillRegistry): RegisteredTool {
  return {
    name: RUN_SKILL_SCRIPT,
    description:
      "Run one script belonging to an active skill. Arguments are passed as JSON; the script returns JSON.",
    category: "main",
    inputSchema: {
      type: "object",
      required: ["skill", "script"],
      properties: {
        skill: { type: "string", description: "The skill name." },
        script: { type: "string", description: "Path relative to the skill's scripts/ directory." },
        args: { type: "object", description: "JSON arguments handed to the script on stdin." },
      },
    },
    execute: async (input: JsonObject) => {
      const name = typeof input["skill"] === "string" ? input["skill"] : "";
      const relative = typeof input["script"] === "string" ? input["script"] : "";
      const skill = skills.get(name);
      if (!skill) {
        return {
          summary: `Skill not found: ${name}`,
          error: { code: "skill_not_found", message: `Skill not found: ${name}` },
        };
      }
      let full: string;
      try {
        full = resolveSkillFile(skill, "scripts", relative);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          summary: message,
          error: { code: error instanceof SkillPathError ? "path_escape" : "invalid_path", message },
        };
      }
      const outcome = await runSkillScript(full, input["args"] ?? {});
      if (!outcome.ok) {
        return { summary: outcome.message, error: { code: outcome.code, message: outcome.message } };
      }
      return {
        summary: `Ran ${name}/scripts/${relative}.`,
        generation_context: { data: { skill: name, script: relative, result: outcome.value as JsonObject } },
      };
    },
  };
}
```

`src/agent/createApp.ts` 的注册处改成同时注册两个：

```ts
  const { createReadSkillReferenceTool, createRunSkillScriptTool } = await import(
    "../../mcp_tools/skill/skillFileTools.ts"
  );
  toolRegistry.register(createReadSkillReferenceTool(skills));
  toolRegistry.register(createRunSkillScriptTool(skills));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | tail -5`
Expected: 全绿。

- [ ] **Step 5: 暂存**

```bash
git add src/framework/skillScript.ts mcp_tools/skill/skillFileTools.ts src/agent/createApp.ts src/framework/__tests__/skillScript.test.ts
```

---

### Task 9: 生命周期与 orchestrator 集成测试

**Files:**
- Test: `src/framework/__tests__/skillLifecycle.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4-6 的全部改动。本任务不写实现代码——如果测试没过，说明前面几个任务的实现有缺陷，回去改那里。

skill 的单 turn 生命周期是这套设计里最容易悄悄回归的一处：泄漏了不会让任何现有测试变红，只会让第二个问题莫名其妙地带着上一个 skill 的框架跑。它必须有专门的测试盯着。

- [ ] **Step 1: 写测试**

新建 `src/framework/__tests__/skillLifecycle.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.ts";
import { SessionState } from "../sessionState.ts";
import { SubagentRegistry } from "../subagent.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import type { TaskRequest } from "../types.ts";

function makeDispatcher(state: SessionState, seen: TaskRequest[]): Dispatcher {
  const subagents = new SubagentRegistry();
  subagents.register({
    name: "market_data",
    description: "d",
    modelClass: "MEDIUM",
    defaultTools: [],
    systemPrompt: { system: "", prompt: "" },
  });
  const runtime = {
    run: async (_definition: unknown, ctx: { request: TaskRequest }) => { seen.push(ctx.request); },
  };
  return new Dispatcher("s", subagents, runtime as never, new McpToolRegistry(), state);
}

test("a skill activated in one turn does not follow the next turn's dispatch", async () => {
  const state = new SessionState("s", new Date().toISOString());
  const seen: TaskRequest[] = [];

  // 第一个 turn：skill 激活
  state.beginTurn("analyse NVDA");
  const first = makeDispatcher(state, seen);
  first.setSkillSections({ market_data: "RSI period 14" });
  await first.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  // 第二个 turn：orchestrator.run 会新建一个 Dispatcher，没有任何 skill 状态
  state.beginTurn("what about the volume");
  const second = makeDispatcher(state, seen);
  await second.dispatch([{ agent: "market_data", task: "what about the volume" }]);

  assert.match(seen[0]!.task, /RSI period 14/);
  assert.doesNotMatch(seen[1]!.task, /RSI period 14/);
});

test("the dispatch event records the user's task, not the task plus the skill text", async () => {
  const state = new SessionState("s", new Date().toISOString());
  const seen: TaskRequest[] = [];
  const turn = state.beginTurn("analyse NVDA");

  const dispatcher = makeDispatcher(state, seen);
  dispatcher.setSkillSections({ market_data: "RSI period 14" });
  await dispatcher.dispatch([{ agent: "market_data", task: "analyse NVDA" }]);

  const projection = state.projectForPrompt(turn);
  assert.match(projection.currentTurnProgress, /analyse NVDA/);
  assert.doesNotMatch(projection.currentTurnProgress, /RSI period 14/);
});
```

- [ ] **Step 2: 跑测试**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skillLifecycle.test.ts`
Expected: 2 个用例 PASS。若第二个失败，回 Task 5 检查 `recordDispatch` 是否误用了加工后的 task。

- [ ] **Step 3: 暂存**

```bash
git add src/framework/__tests__/skillLifecycle.test.ts
```

---

### Task 10: `skills/stock-analysis/` 的 SKILL.md 与 references

**Files:**
- Create: `skills/stock-analysis/SKILL.md`
- Create: `skills/stock-analysis/references/indicator-playbook.md`
- Create: `skills/stock-analysis/references/report-template.md`
- Test: `src/framework/__tests__/stockAnalysisSkill.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2、3 的解析器
- Produces: 名为 `stock-analysis` 的 skill，声明 `agents: [market_data, market_research]`

- [ ] **Step 1: 写失败的测试**

新建 `src/framework/__tests__/stockAnalysisSkill.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../skill.ts";

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills");

test("the shipped stock-analysis skill loads and declares its agents", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(SKILLS_ROOT);
  const skill = registry.get("stock-analysis")!;

  assert.ok(skill, "stock-analysis skill should be discovered");
  assert.deepEqual(skill.agents, ["market_data", "market_research"]);
  assert.ok(skill.agentSections.market_data);
  assert.ok(skill.agentSections.market_research);
  assert.equal(skill.agentSections.trading_operations, undefined);
});

test("the market_data section names the window parameter rather than a wider historyDays", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(SKILLS_ROOT);
  const section = registry.get("stock-analysis")!.agentSections.market_data!;

  assert.match(section, /window/);
  assert.match(section, /historyDays/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/stockAnalysisSkill.test.ts`
Expected: FAIL — skill 尚不存在。

- [ ] **Step 3: 写 SKILL.md**

新建 `skills/stock-analysis/SKILL.md`：

```markdown
---
name: stock-analysis
description: Deep single-ticker analysis — quote, multi-timeframe technicals, recent news, and a structured conclusion. Use when the user asks what is going on with one stock, or asks for an analysis, read, or view on a ticker.
agents: [market_data, market_research]
---

分析顺序固定：行情 → 多周期技术面 → 新闻面 → 结构化结论。前一步的结果决定后一步问什么。

三条硬约束：

1. 每个判断必须挂一个来自工具返回的具体数值或新闻条目。`get_stock_price` 已经返回
   精确的最高/最低价及其日期、区间回报、最大回撤和均线，**直接引用，禁止自行重算**。
2. 冲突信号必须显式写出来。日线超买而周线仍在上升趋势，就两个都说，不要挑一边。
3. 输出是描述性分析，不是买卖指令。不给目标价，不说该买该卖。

需要某个指标的解读细则时，用 `read_skill_reference` 读 `indicator-playbook.md`；
输出前读 `report-template.md` 取结构。不要一上来就把两个都读进来。

## for: market_data

先 `get_stock_price` 拿默认的 250 日 condensed history 建立基线。
要看某个具体的历史时段，用 `window` 参数；不要靠放大 `historyDays` 去够——
那样既贵又不准，且工具会把 historyDays 截断。
技术面至少两个周期：1Day 定方向，15Min 或 60Min 定当下结构。
参数默认 RSI 14 / MACD 12-26-9 / 布林带 20-2，除非用户另有指定。
背离必须在两个周期上交叉验证之后才能报告。
每个指标结果回传时带上 bar_count 和 timeframe，让上层知道样本量。

## for: market_research

只取 30 天内的新闻；每条必须带日期和来源域名。
区分「已发生的事实」与「分析师预期」，后者标注给出预期的机构名。
找不到相关新闻就明说找不到，不要用宏观叙事填充。
```

- [ ] **Step 4: 写 references**

新建 `skills/stock-analysis/references/indicator-playbook.md`：

```markdown
# 指标解读细则

本项目可用的 9 个指标工具，各自的适用场景与常见误读。

## RSI（`stock_rsi`）
默认 14 周期。>70 超买、<30 超卖只是**统计描述**，不是反转信号——强趋势中 RSI 可以
在超买区停留数周。有意义的是背离：价格创新高而 RSI 未创新高。背离必须在两个周期上
同时成立才报告，单周期背离的假阳性极高。

## MACD（`stock_macd`）
12-26-9。金叉/死叉在震荡行情里噪声极大；柱状图（histogram）的收缩比穿越本身更早、
更可靠。零轴上方的金叉与零轴下方的金叉含义不同，必须区分。

## 布林带（`stock_bollinger_bands`）
20-2。触及上轨不等于卖出信号——带宽收窄（squeeze）预示波动率将放大，方向未知。
用带宽而不是位置来判断状态。

## ATR（`stock_atr`）
绝对值无法跨标的比较，必须换算成占价格的百分比再比。它衡量波动幅度，不含方向。

## OBV（`stock_obv`）
只看斜率与价格的一致性。OBV 的绝对值取决于起点，本身无意义。

## VWAP（`stock_vwap`）
只在当日盘中有意义，跨日的 VWAP 不要引用。

## SMA / EMA（`stock_sma` / `stock_ema`）
`get_stock_price` 的 stats 已经给了常用均线值，先看那里，不要为了拿一个均线值
额外调一次工具。

## 支撑阻力（`stock_support_resistance`）
返回的是历史价格聚集区，不是预测。引用时必须带上该位置被触及的次数。
```

新建 `skills/stock-analysis/references/report-template.md`：

```markdown
# 输出结构

四段，顺序固定，每段都必须有数字支撑。

## 1. 现在的状态
当前价、较前收盘的涨跌幅、所处交易时段、成交量相对水平。一到两句。

## 2. 技术面
按周期分别说：长周期定方向，短周期定当下结构。每个结论后面跟指标名、参数和数值。
冲突的信号在这里并列写出，不做取舍。

## 3. 消息面
30 天内的相关新闻，每条带日期与来源。事实与预期分开。没有就写「未找到 30 天内的
相关新闻」。

## 4. 综合
把前三段串起来：哪些指向一致，哪些互相矛盾，当前最大的不确定性是什么。
不给目标价，不给买卖建议。
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/stockAnalysisSkill.test.ts`
Expected: 2 个用例 PASS。

- [ ] **Step 6: 暂存**

```bash
git add skills/stock-analysis/ src/framework/__tests__/stockAnalysisSkill.test.ts
```

---

### Task 11: `scripts/score.ts` 指标评分

**Files:**
- Create: `skills/stock-analysis/scripts/score.ts`
- Create: `skills/stock-analysis/scripts/__tests__/score.test.ts`
- Modify: `package.json`（`scripts.test` 加 skills 的 glob）
- Modify: `skills/stock-analysis/SKILL.md`（说明何时调这个脚本）

**Interfaces:**
- Consumes: Task 8 的 `run_skill_script`（stdin JSON → stdout JSON 约定）
- Produces:
  ```ts
  export type ScoreInput = {
    rsi?: number;          // 0-100
    macdHistogram?: number;
    price?: number;
    sma50?: number;
    sma200?: number;
    atrPercent?: number;   // ATR 占价格的百分比
  };
  export type ScoreResult = {
    trend: number;      // -2..2
    momentum: number;   // -2..2
    volatility: "low" | "normal" | "high" | "unknown";
    evidence: string[];
  };
  export function scoreIndicators(input: ScoreInput): ScoreResult;
  ```

评分是描述性的维度打分，不是买卖信号。缺失的输入不参与打分，并在 evidence 里说明缺了什么。

- [ ] **Step 1: 写失败的测试**

新建 `skills/stock-analysis/scripts/__tests__/score.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { scoreIndicators } from "../score.ts";

test("price above both averages with a positive histogram scores a clean uptrend", () => {
  const result = scoreIndicators({
    price: 120,
    sma50: 110,
    sma200: 100,
    rsi: 60,
    macdHistogram: 1.2,
    atrPercent: 2,
  });

  assert.equal(result.trend, 2);
  assert.equal(result.momentum, 1);
  assert.equal(result.volatility, "normal");
  assert.ok(result.evidence.some((line) => line.includes("sma50")));
});

test("price below both averages with a negative histogram scores a clean downtrend", () => {
  const result = scoreIndicators({
    price: 90,
    sma50: 100,
    sma200: 110,
    rsi: 35,
    macdHistogram: -0.8,
  });

  assert.equal(result.trend, -2);
  assert.equal(result.momentum, -1);
});

test("an overbought RSI is reported as a dimension, not turned into a sell signal", () => {
  const result = scoreIndicators({ rsi: 82 });
  assert.equal(result.momentum, 2);
  assert.ok(result.evidence.some((line) => /82/.test(line)));
  assert.ok(!result.evidence.some((line) => /sell|buy/i.test(line)));
});

test("missing inputs score zero and say what was missing", () => {
  const result = scoreIndicators({});
  assert.equal(result.trend, 0);
  assert.equal(result.momentum, 0);
  assert.equal(result.volatility, "unknown");
  assert.ok(result.evidence.some((line) => /no /i.test(line)));
});

test("volatility is banded by ATR as a percentage of price", () => {
  assert.equal(scoreIndicators({ atrPercent: 0.8 }).volatility, "low");
  assert.equal(scoreIndicators({ atrPercent: 2.5 }).volatility, "normal");
  assert.equal(scoreIndicators({ atrPercent: 6 }).volatility, "high");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test skills/stock-analysis/scripts/__tests__/score.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

新建 `skills/stock-analysis/scripts/score.ts`：

```ts
/**
 * 把若干指标读数汇总成三个维度的描述性评分。
 *
 * 纯函数、无网络无 IO：模型不用心算，我们也能直接单测。输出的是维度打分和依据，
 * 不是买卖信号——这与 skill 正文的第三条硬约束一致。
 *
 * 作为 skill 脚本运行时：stdin 收 JSON ScoreInput，stdout 出 JSON ScoreResult。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export type ScoreInput = {
  rsi?: number;
  macdHistogram?: number;
  price?: number;
  sma50?: number;
  sma200?: number;
  atrPercent?: number;
};

export type ScoreResult = {
  trend: number;
  momentum: number;
  volatility: "low" | "normal" | "high" | "unknown";
  evidence: string[];
};

function volatilityBand(atrPercent: number | undefined): ScoreResult["volatility"] {
  if (atrPercent === undefined) return "unknown";
  if (atrPercent < 1) return "low";
  if (atrPercent < 4) return "normal";
  return "high";
}

export function scoreIndicators(input: ScoreInput): ScoreResult {
  const evidence: string[] = [];
  let trend = 0;
  let momentum = 0;

  if (input.price !== undefined && input.sma50 !== undefined) {
    const above = input.price > input.sma50;
    trend += above ? 1 : -1;
    evidence.push(`price ${input.price} is ${above ? "above" : "below"} sma50 ${input.sma50}`);
  }
  if (input.price !== undefined && input.sma200 !== undefined) {
    const above = input.price > input.sma200;
    trend += above ? 1 : -1;
    evidence.push(`price ${input.price} is ${above ? "above" : "below"} sma200 ${input.sma200}`);
  }
  if (input.price === undefined || (input.sma50 === undefined && input.sma200 === undefined)) {
    evidence.push("no moving averages supplied; trend not scored");
  }

  if (input.rsi !== undefined) {
    if (input.rsi >= 70) momentum += 2;
    else if (input.rsi >= 55) momentum += 1;
    else if (input.rsi <= 30) momentum -= 2;
    else if (input.rsi <= 45) momentum -= 1;
    evidence.push(`rsi ${input.rsi}`);
  } else {
    evidence.push("no rsi supplied");
  }

  if (input.macdHistogram !== undefined) {
    // 柱状图只用来确认 RSI 给出的方向，不叠加成第二票——两者都源自价格动量。
    if (input.macdHistogram > 0 && momentum < 0) momentum += 1;
    if (input.macdHistogram < 0 && momentum > 0) momentum -= 1;
    evidence.push(`macd histogram ${input.macdHistogram}`);
  }

  const volatility = volatilityBand(input.atrPercent);
  if (volatility === "unknown") evidence.push("no atr supplied; volatility not banded");
  else evidence.push(`atr ${input.atrPercent}% of price`);

  const clamp = (value: number): number => Math.max(-2, Math.min(2, value));
  return { trend: clamp(trend), momentum: clamp(momentum), volatility, evidence };
}

// 作为脚本被 run_skill_script 调用时的入口。被单测 import 时这段不执行，
// 否则测试进程会挂在一个永远等不到 end 的 stdin 上。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const args = JSON.parse(raw || "{}") as ScoreInput;
    process.stdout.write(JSON.stringify(scoreIndicators(args)));
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test skills/stock-analysis/scripts/__tests__/score.test.ts`
Expected: 5 个用例 PASS。

- [ ] **Step 5: 把 skills 测试加进 npm test**

`package.json` 的 `scripts.test` 追加一段：

```
"skills/**/__tests__/*.test.ts"
```

Run: `npm test 2>&1 | tail -5`
Expected: 全绿，总数包含新增的 5 个。

- [ ] **Step 6: SKILL.md 里说明脚本何时用**

在 `skills/stock-analysis/SKILL.md` 的「三条硬约束」之后、`## for:` 小节之前插入：

```markdown
拿到 RSI、MACD 柱状图、均线和 ATR 之后，可以用
`run_skill_script("stock-analysis", "score.ts", { ... })` 把它们汇总成趋势 / 动量 /
波动三个维度的评分与依据。它是描述性的汇总，输出仍要按上面第三条约束表述。
```

- [ ] **Step 7: 暂存**

```bash
git add skills/stock-analysis/ package.json
```

---

### Task 12: 端到端手工验证

**Files:**
- 无改动。这是一次真实运行，用来确认前 11 个任务拼起来确实能工作。

**Interfaces:**
- Consumes: 全部任务

单元测试证明不了"orchestrator 真的会挑中这个 skill"。触发描述写得好不好，只有真跑一次才知道。

- [ ] **Step 1: 全量测试与类型检查**

Run: `npm test 2>&1 | tail -5 && npx tsc -p tsconfig.json --noEmit`
Expected: 测试全绿，tsc 无输出。

- [ ] **Step 2: 启动服务**

Run: `npm start`
Expected: 日志出现 `[sessions] SQLite persistence enabled`，服务在 3000 端口就绪，**且没有 skill 加载错误**（Task 2 的严格校验会在这里第一次面对真实文件）。

- [ ] **Step 3: 发一个会命中 skill 的问题**

在 UI 或用 curl 发送：`分析一下 NVDA 现在的情况`

- [ ] **Step 4: 核对四件事**

在会话事件流里确认：

1. 出现 `skill_invoke`，skill 名为 `stock-analysis`
2. 出现 `skill_result`，payload 带 `content`
3. dispatch 到 `market_data` 的**子 agent 输入**里带了 `[SKILL GUIDANCE]`，而 dispatch 事件本身记录的是原始 task
4. 回答的结构符合 `report-template.md` 的四段

若第 1 条没发生，说明 frontmatter 的 `description` 触发力不够——改描述，不改框架。

- [ ] **Step 5: 交给用户复核**

```bash
git status
```

把改动清单和上面四条的实际观察结果一起交给用户，等复核后再决定提交。
