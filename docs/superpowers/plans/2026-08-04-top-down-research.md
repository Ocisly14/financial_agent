# top-down-research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Research controller 建立 skill 通道，并用 `top-down-research` 技能打通它——宏观判断收敛到板块，用户选定后并行驱动 member Topic 筛选候选，再由用户选定后做深度分析。

**Architecture:** skill 按 `layer` 分为 `topic` 与 `research` 两层，共用同一个 `SkillRegistry`，`list()` / `get()` 默认返回 `topic` 层，因此既有的 Topic orchestrator 一个字节都不用改。Research 层的技能通过新的 `## for: topic` 小节把硬约束追加到每条 `ask_topic` 指令上；这段文字会留在 member 的时间线上，因此写成用户口吻。前两轮的用户断点复用已有的 `ask_user` 工具。

**Tech Stack:** Node 23（`--experimental-strip-types --experimental-sqlite`）、`node:test`、TypeScript、`yaml`

## Global Constraints

以下逐条来自 `docs/superpowers/specs/2026-08-04-top-down-research-design.md`，每个 task 的要求都隐含包含本节。

- `src/framework/orchestrator.ts`、`src/framework/dispatcher.ts`、`src/agent/prompts/orchestratorPrompt.ts`、`skills/stock-analysis/**` **一个字节都不改**。
- `SkillRegistry.list()` 与 `get(name)` 的**无参调用必须继续只返回 `topic` 层**——这是上一条得以成立的机制。
- 加载期出错一律 `throw`，不得静默跳过：写错层的小节、非法 `layer`、`research` 层写了 `tools:` / `agents:`，全部在启动时炸。
- `## for: topic` 追加到 `ask_topic` 的文字**会成为 member 时间线上的 `user_message`**，因此：不使用 `[SKILL GUIDANCE]` 之类内部标记，用空行分隔的自然语句；措辞为第二人称请求句；不出现"skill""技能""注入"等内部词汇，不出现工具名。
- 技能文件名必须与目录名、frontmatter `name` 三者一致（`skill.ts:49-57` 的既有契约）。
- 不新增 `references/` 与 `scripts/`；不给 Research 层注册 `read_skill_reference` / `run_skill_script`。
- `ask_user` 硬上限：一次最多 3 题、每题 2-8 个选项（`mcp_tools/user/askUserTool.ts:10-11`）。
- **已知的既有失败**：`src/agent/research/__tests__/tools.test.ts:167` 当前失败（工作区里 `allowUserInput: false` 已加、测试期望未更新）。**本计划不修它**——它属于 `2026-08-04-member-input-passthrough-design.md`，那份设计移除该参数后它会自然变绿。每个 task 报告测试结果时把它单独列出，不要计入自己造成的失败。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/framework/types.ts` | 新增 `SkillLayer` 类型 |
| `src/framework/skill.ts` | `layer` 与 `topicSection` 的解析、加载期校验、按层过滤 |
| `src/agent/research/tools.ts` | `ResearchToolset.setTopicSection` 与 `ask_topic` 的追加 |
| `src/agent/research/researchRuntime.ts` | step 解析出 `skill`、互斥守卫、invoke 分支、`skill_result` 投影 |
| `src/agent/research/researchPrompt.ts` | `skill` 字段、`[SKILLS YOU CAN INVOKE]`、互斥规则 |
| `src/agent/createApp.ts` | 把 `skills` 传给 `ResearchRuntime` |
| `skills/top-down-research/top-down-research.md` | 技能本体 |

---

### Task 1: skill.ts 的分层与 topic 小节

**Files:**
- Modify: `src/framework/types.ts`
- Modify: `src/framework/skill.ts`
- Test: `src/framework/__tests__/skillLayer.test.ts`（新建）

**Interfaces:**
- Consumes: 无（本计划第一个 task）
- Produces:
  - `export type SkillLayer = "topic" | "research";`（在 `src/framework/types.ts`）
  - `SkillDefinition` 新增 `layer: SkillLayer`（**非可选**）与 `topicSection?: string`
  - `SkillRegistry.list(layer?: SkillLayer): SkillDefinition[]`，无参等价于 `"topic"`
  - `SkillRegistry.get(name: string, layer?: SkillLayer): SkillDefinition | undefined`，无参等价于 `"topic"`
  - `splitAgentSections(raw, context)` 返回 `{ body, agentSections, topicSection }`
  - `WorkflowContext.dispatcher` 改为可选（`dispatcher?: Dispatcher`）

- [ ] **Step 1: 写失败的测试**

新建 `src/framework/__tests__/skillLayer.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillRegistry, splitAgentSections } from "../skill.ts";

/** 建一个 skills 根目录，里面放一个名为 `name` 的技能，内容为 `content`。 */
async function skillRoot(name: string, content: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "skill-layer-"));
  const dir = path.join(root, name);
  await mkdir(dir);
  await writeFile(path.join(dir, `${name}.md`), content, "utf8");
  return root;
}

const TOPIC_SKILL = `---
name: alpha
description: A topic-layer skill.
---
Shared body.

## for: market_data
Fetch things.
`;

const RESEARCH_SKILL = `---
name: beta
description: A research-layer skill.
layer: research
---
Shared body.

## for: topic
Please cite readings.
`;

test("layer defaults to topic when the frontmatter omits it", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(await skillRoot("alpha", TOPIC_SKILL));
  assert.equal(registry.get("alpha")?.layer, "topic");
});

test("a research-layer skill parses its topic section and not agentSections", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(await skillRoot("beta", RESEARCH_SKILL));
  const skill = registry.get("beta", "research");
  assert.equal(skill?.layer, "research");
  assert.equal(skill?.topicSection, "Please cite readings.");
  assert.deepEqual(skill?.agentSections, {});
});

test("list and get default to the topic layer", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(await skillRoot("beta", RESEARCH_SKILL));
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get("beta"), undefined);
  assert.equal(registry.list("research").length, 1);
});

test("a topic-layer skill may not carry a topic section", async () => {
  const root = await skillRoot("alpha", TOPIC_SKILL.replace("## for: market_data", "## for: topic"));
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /topic-layer skill.*'## for: topic'/);
});

test("a research-layer skill may not carry an agent section", async () => {
  const root = await skillRoot("beta", RESEARCH_SKILL.replace("## for: topic", "## for: market_data"));
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /research-layer skill.*'## for: market_data'/);
});

test("a research-layer skill may not declare tools or agents", async () => {
  const root = await skillRoot("beta", RESEARCH_SKILL.replace("layer: research", "layer: research\ntools: [ask_topic]"));
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /research-layer skill.*'tools'/);
});

test("a research-layer skill may not declare a workflow", async () => {
  const root = await skillRoot("beta", RESEARCH_SKILL.replace("layer: research", "layer: research\nworkflow: probe"));
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /research-layer skill.*'workflow'/);
});

test("an unknown layer is rejected at load time", async () => {
  const root = await skillRoot("beta", RESEARCH_SKILL.replace("layer: research", "layer: workspace"));
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /unknown layer 'workspace'/);
});

test("splitAgentSections separates the topic section from agent sections", () => {
  const raw = "Body.\n\n## for: topic\nAsk politely.\n\n## for: market_data\nFetch.\n";
  const split = splitAgentSections(raw, "test");
  assert.equal(split.body.trim(), "Body.");
  assert.equal(split.topicSection, "Ask politely.");
  assert.equal(split.agentSections.market_data, "Fetch.");
});
```

五种加载期失败刻意分成五个用例，而不是挤进一个断言——每一种写错法都该有各自明确的失败信息。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skillLayer.test.ts`

Expected: FAIL。第一个用例报 `layer` 不存在于 `SkillDefinition`（类型错或 `undefined`）；`splitAgentSections` 那个用例报 `topicSection` 不存在；`## for: topic` 的用例报现有的 `names an unknown agent`。

- [ ] **Step 3: 在 types.ts 里加 SkillLayer**

在 `src/framework/types.ts` 中 `SkillStatus` 定义之后加入：

```ts
export type SkillLayer = "topic" | "research";
```

- [ ] **Step 4: 改 skill.ts**

`src/framework/skill.ts`：

导入处加上 `SkillLayer`：

```ts
import type { AgentKind, SkillLayer, SkillResult } from "./types.ts";
```

在 `AGENT_KINDS` 之后加：

```ts
const SKILL_LAYERS: ReadonlySet<string> = new Set<SkillLayer>(["topic", "research"]);

/** `## for:` 的第四个合法目标。member Topic 不是 AgentKind——它没有角色，
 *  只有"被问什么"的区别——所以它的小节存在独立字段里，不混进 agentSections。 */
const TOPIC_SECTION_TARGET = "topic";
```

`SkillDefinition` 改为：

```ts
export type SkillDefinition = {
  name: string;
  description: string;
  path: string; // <name>.md 的绝对路径
  dir: string; // skill 目录的绝对路径，后续任务的路径锁定基准
  layer: SkillLayer;
  body: string;
  agentSections: Partial<Record<AgentKind, string>>;
  /** `## for: topic` 的内容。只有 research 层的技能会有。 */
  topicSection?: string;
  agents?: AgentKind[];
  tools?: string[];
  workflow?: string;
};
```

`splitAgentSections` 改为：

```ts
export function splitAgentSections(
  raw: string,
  context: string,
): { body: string; agentSections: Partial<Record<AgentKind, string>>; topicSection?: string } {
  const agentSections: Partial<Record<AgentKind, string>> = {};
  let topicSection: string | undefined;
  const matches = [...raw.matchAll(AGENT_SECTION)];
  if (matches.length === 0) return { body: raw, agentSections };

  const body = raw.slice(0, matches[0]!.index);
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i]!;
    const target = current[1]!;
    if (target !== TOPIC_SECTION_TARGET && !AGENT_KINDS.has(target)) {
      throw new Error(`skill section '## for: ${target}' names an unknown agent: ${context}`);
    }
    const start = current.index! + current[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : raw.length;
    const content = raw.slice(start, end).trim();
    if (target === TOPIC_SECTION_TARGET) topicSection = content;
    else agentSections[target as AgentKind] = content;
  }
  return { body, agentSections, topicSection };
}
```

`parseSkillMarkdown` 中，`const description = ...` 之后插入 layer 解析，并在 `split` 之后插入交叉校验：

```ts
  const layerRaw = frontmatter["layer"];
  if (layerRaw !== undefined && (typeof layerRaw !== "string" || !SKILL_LAYERS.has(layerRaw))) {
    throw new Error(`skill ${name} declares unknown layer '${String(layerRaw)}': ${filePath}`);
  }
  const layer = (layerRaw as SkillLayer | undefined) ?? "topic";

  const split = splitAgentSections(match[2] ?? "", filePath);
  // 写错层的小节静默失效是最难查的一类问题，两个方向都抛。
  if (layer === "topic" && split.topicSection !== undefined) {
    throw new Error(`topic-layer skill ${name} carries a '## for: topic' section: ${filePath}`);
  }
  if (layer === "research" && Object.keys(split.agentSections).length > 0) {
    const first = Object.keys(split.agentSections)[0];
    throw new Error(`research-layer skill ${name} carries a '## for: ${first}' section: ${filePath}`);
  }

  const skill: SkillDefinition = {
    name,
    description,
    path: filePath,
    dir,
    layer,
    body: split.body,
    agentSections: split.agentSections,
  };
  if (split.topicSection !== undefined) skill.topicSection = split.topicSection;
```

（原有的 `const split = ...` 与 `const skill: SkillDefinition = {...}` 两处被上面替换，不要重复保留。）

在 `agents` / `tools` 解析处加上层校验。`agents` 分支改为：

```ts
  const agents = optionalStringArray(frontmatter, "agents", filePath);
  if (agents) {
    if (layer === "research") {
      throw new Error(`research-layer skill ${name} may not declare 'agents': ${filePath}`);
    }
    for (const agent of agents) {
      if (!AGENT_KINDS.has(agent)) {
        throw new Error(`skill ${name} declares unknown agent '${agent}': ${filePath}`);
      }
    }
    skill.agents = agents as AgentKind[];
  }

  const tools = optionalStringArray(frontmatter, "tools", filePath);
  if (tools) {
    if (layer === "research") {
      throw new Error(`research-layer skill ${name} may not declare 'tools': ${filePath}`);
    }
    skill.tools = tools;
  }
```

同一函数末尾的 `workflow` 分支加上同样的层校验：

```ts
  if (frontmatter["workflow"] !== undefined) {
    if (layer === "research") {
      throw new Error(`research-layer skill ${name} may not declare 'workflow': ${filePath}`);
    }
    skill.workflow = requireString(frontmatter, "workflow", filePath);
  }
```

最后，`WorkflowContext.dispatcher` 改为可选：

```ts
export type WorkflowContext = {
  sessionId: string;
  userMessage: string;
  /** 只有 workflow 型技能会用到,而 workflow 仅限 topic 层——research 层的调用方不传。 */
  dispatcher?: Dispatcher;
  state: SessionState;
};
```

`SkillRegistry.invoke` 本身不用改：它只把 `context` 原样交给 workflow handler，而 research 层不可能有 handler。既有的 workflow handler 若因此报类型错，在 handler 内部就地断言 `context.dispatcher!`——它们只在 topic 层被调用，dispatcher 必然存在。

`SkillRegistry` 的 `list` / `get` 改为按层过滤：

```ts
  /**
   * 默认只返回 topic 层。这个默认值是刻意的：它让既有的 Topic orchestrator
   * 与 read_skill_reference / run_skill_script 一个字节都不用改，就自动看不到
   * research 层的技能。
   */
  list(layer: SkillLayer = "topic"): SkillDefinition[] {
    return [...this.skills.values()].filter((skill) => skill.layer === layer);
  }

  get(name: string, layer: SkillLayer = "topic"): SkillDefinition | undefined {
    const skill = this.skills.get(name);
    return skill && skill.layer === layer ? skill : undefined;
  }
```

`invoke(name, context)` 内部的 `this.skills.get(name)` 保持**直接读 Map**（不经过分层过滤）——调用方在调 `invoke` 之前已经用 `get(name, layer)` 验过层，`invoke` 再过滤一次只会让错误信息变模糊。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/framework/__tests__/skillLayer.test.ts`

Expected: PASS，全部 9 个用例。

- [ ] **Step 6: 全量测试与类型检查**

Run: `npx tsc --noEmit && npm test`

Expected: `tsc` 无输出。`npm test` 只有 `src/agent/research/__tests__/tools.test.ts:167` 这一个既有失败（见 Global Constraints）。若出现别的失败，多半是某处手写 `SkillDefinition` 的测试缺了 `layer` 字段——补上 `layer: "topic"`。

- [ ] **Step 7: 暂存**

```bash
git add src/framework/types.ts src/framework/skill.ts src/framework/__tests__/skillLayer.test.ts
```

**不要 git commit。** 本仓库的规矩是改完等人过一遍。

---

### Task 2: ask_topic 追加 topic 小节

**Files:**
- Modify: `src/agent/research/tools.ts`
- Test: `src/agent/research/__tests__/tools.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `SkillDefinition.topicSection`
- Produces: `ResearchToolset.setTopicSection(section: string): void`

- [ ] **Step 1: 写失败的测试**

在 `src/agent/research/__tests__/tools.test.ts` 末尾追加。该文件已有的 doubles 里有一个记录 `orchestrator.run` 入参的假对象（`tools.test.ts:167` 附近断言的就是它）；沿用同一个 fixture 构造方式，不要另建一套。

```ts
test("setTopicSection appends its text to the message ask_topic sends", async () => {
  const { toolset, runs } = makeToolset();          // 沿用本文件既有的 fixture 工厂
  toolset.setTopicSection("请给出具体读数和日期。");
  await toolset.askTopic("room_a", "渠道库存怎么样？");

  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.userMessage, "渠道库存怎么样？\n\n请给出具体读数和日期。");
});

test("without a topic section the message is unchanged", async () => {
  const { toolset, runs } = makeToolset();
  await toolset.askTopic("room_a", "渠道库存怎么样？");

  assert.equal(runs[0]!.userMessage, "渠道库存怎么样？");
});

test("an empty message is still rejected before the section is appended", async () => {
  const { toolset, runs } = makeToolset();
  toolset.setTopicSection("请给出具体读数和日期。");
  const result = await toolset.askTopic("room_a", "   ");

  assert.equal(result.status, "failed");
  assert.equal(runs.length, 0);
});
```

若该文件尚无名为 `makeToolset` 的工厂，就照现有用例构造 `ResearchToolset` 的写法就地展开，并把 `orchestrator.run` 的入参推进一个数组里以供断言——**不要为此重构既有用例**。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/research/__tests__/tools.test.ts`

Expected: 三个新用例中前两个失败（`setTopicSection is not a function`）。文件里 `:167` 那个既有失败依然存在，与本 task 无关。

- [ ] **Step 3: 实现**

`src/agent/research/tools.ts`，`ResearchToolset` 类中 `drivenThisTurn` 字段之后加：

```ts
  /** 活动技能的 `## for: topic` 小节。会成为 member 时间线上的可见文字，
   *  所以它写成用户口吻，并且这里不加任何内部标记。 */
  private topicSection = "";
```

`beginTurn()` **不重置** `topicSection`——技能是在轮内 invoke 的，重置会把它在同一轮里抹掉。

新增方法（放在 `beginTurn` 之后）：

```ts
  /** 由 Research 运行时在技能 invoke 之后调用。 */
  setTopicSection(section: string): void {
    this.topicSection = section.trim();
  }
```

`askTopic` 开头的 `const task = message.trim();` 改为：

```ts
    const trimmed = message.trim();
    if (!trimmed) {
      return { topicId, topicName, status: "failed", reason: "message is empty" };
    }
    // 追加在空值检查之后:一段只有指导语、没有指令的消息不该被当成有效驱动。
    const task = this.topicSection ? `${trimmed}\n\n${this.topicSection}` : trimmed;
```

并**删除**紧随其后的原有空值检查块：

```ts
    if (!task) {
      return { topicId, topicName, status: "failed", reason: "message is empty" };
    }
```

`task` 之后的一切保持不变——`stampOrigin(topicId, task)`、`orchestrator.run({ userMessage: task })`、`emit({ ... task ... })` 全部用追加后的文字。这是设计决定（spec §2.6）：那段文字就是用户会看到的。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/research/__tests__/tools.test.ts`

Expected: 三个新用例 PASS。`:167` 那个既有失败仍在。

- [ ] **Step 5: 全量测试与类型检查**

Run: `npx tsc --noEmit && npm test`

Expected: `tsc` 无输出；只有那一个既有失败。

- [ ] **Step 6: 暂存**

```bash
git add src/agent/research/tools.ts src/agent/research/__tests__/tools.test.ts
```

**不要 git commit。**

---

### Task 3: step 解析出 skill 字段与互斥守卫

**Files:**
- Modify: `src/agent/research/researchRuntime.ts`
- Test: `src/agent/research/__tests__/researchSkill.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `ResearchStep` 变为 `{ reply: string; skill: string | null; toolCalls: ToolCall[] }`；`parseResearchStep` 导出不变

- [ ] **Step 1: 写失败的测试**

新建 `src/agent/research/__tests__/researchSkill.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseResearchStep } from "../researchRuntime.ts";

test("a step carrying only a skill parses with no tool calls", () => {
  const step = parseResearchStep('{"reply":"好的","skill":"top-down-research","tool_calls":null}');
  assert.equal(step.skill, "top-down-research");
  assert.deepEqual(step.toolCalls, []);
});

test("skill is null when absent", () => {
  const step = parseResearchStep('{"reply":"好的","tool_calls":null}');
  assert.equal(step.skill, null);
});

test("a non-string skill is treated as absent", () => {
  const step = parseResearchStep('{"reply":"好的","skill":42,"tool_calls":null}');
  assert.equal(step.skill, null);
});

test("an empty skill string is treated as absent", () => {
  const step = parseResearchStep('{"reply":"好的","skill":"   ","tool_calls":null}');
  assert.equal(step.skill, null);
});

test("skill and tool_calls both parse; the runtime, not the parser, rejects the pair", () => {
  const step = parseResearchStep(
    '{"reply":"好的","skill":"top-down-research","tool_calls":[{"name":"focus","input":{"topic_id":"t1"}}]}',
  );
  assert.equal(step.skill, "top-down-research");
  assert.equal(step.toolCalls.length, 1);
});
```

最后一个用例是**刻意的分工**：解析器只负责如实还原模型说了什么，互斥判断在运行时做——那里才有 session 可以记协议错误。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/research/__tests__/researchSkill.test.ts`

Expected: FAIL，`step.skill` 为 `undefined`。

- [ ] **Step 3: 实现解析**

`src/agent/research/researchRuntime.ts`：

```ts
type ResearchStep = { reply: string; skill: string | null; toolCalls: ToolCall[] };
```

`parseResearchStep` 的两处早退与最终 return 都要带上 `skill`：

```ts
  if (!json) return { reply: text.trim(), skill: null, toolCalls: [] };
```

```ts
  } catch {
    return { reply: text.trim(), skill: null, toolCalls: [] };
  }
```

在 `const reply = ...` 之后加：

```ts
  const skill = typeof raw.skill === "string" && raw.skill.trim() ? raw.skill.trim() : null;
```

最终 return 改为：

```ts
  return {
    reply,
    skill,
    toolCalls: candidates.map(asToolCall).filter((call): call is ToolCall => call !== null),
  };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/research/__tests__/researchSkill.test.ts`

Expected: PASS，5 个用例。

- [ ] **Step 5: 全量测试与类型检查**

Run: `npx tsc --noEmit && npm test`

Expected: `tsc` 无输出；只有那一个既有失败。

- [ ] **Step 6: 暂存**

```bash
git add src/agent/research/researchRuntime.ts src/agent/research/__tests__/researchSkill.test.ts
```

**不要 git commit。**

---

### Task 4: Research 运行时的 skill 分支与 prompt

**Files:**
- Modify: `src/agent/research/researchRuntime.ts`
- Modify: `src/agent/research/researchPrompt.ts`
- Modify: `src/agent/createApp.ts:57-63`
- Test: `src/agent/research/__tests__/researchSkill.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `SkillRegistry.get(name, "research")` 与 `list("research")`、`SkillDefinition.topicSection`；Task 2 的 `ResearchToolset.setTopicSection`；Task 3 的 `ResearchStep.skill`
- Produces: `ResearchRuntimeDeps` 新增 `skills: SkillRegistry`

- [ ] **Step 1: 写失败的测试**

在 `src/agent/research/__tests__/researchSkill.test.ts` 追加。运行时用例需要一个能按脚本逐步返回 completion 的假 provider，以及一个内存 store——`src/agent/research/__tests__/tools.test.ts` 顶部已有这类 doubles，照搬其构造方式。

```ts
test("invoking a research-layer skill records skill_result and installs the topic section", async () => {
  // 模型脚本:第 1 步只 invoke 技能;第 2 步驱动一个 member;第 3 步收口。
  const runtime = makeRuntime({
    completions: [
      '{"reply":"读取方法后开始","skill":"probe","tool_calls":null}',
      '{"reply":"正在查","tool_calls":[{"name":"ask_topic","input":{"topic_id":"room_a","message":"半导体怎么样？"}}]}',
      '{"reply":"结论如下","tool_calls":null}',
    ],
    skills: registryWith({
      name: "probe",
      layer: "research",
      body: "Probe body.",
      topicSection: "请给出具体读数和日期。",
    }),
  });

  await runtime.run(runInput());

  // 技能正文进入了下一步的历史投影
  assert.match(runtime.lastPrompts[1]!, /Probe body\./);
  // 小节确实落到了发给 member 的文字上
  assert.equal(
    runtime.topicRuns[0]!.userMessage,
    "半导体怎么样？\n\n请给出具体读数和日期。",
  );
});

test("skill and tool_calls in one step is a protocol error and runs nothing", async () => {
  const runtime = makeRuntime({
    completions: [
      '{"reply":"两个一起","skill":"probe","tool_calls":[{"name":"ask_topic","input":{"topic_id":"room_a","message":"喂"}}]}',
      '{"reply":"收口","tool_calls":null}',
    ],
    skills: registryWith({ name: "probe", layer: "research", body: "Probe body.", topicSection: "请给出读数。" }),
  });

  await runtime.run(runInput());

  assert.equal(runtime.topicRuns.length, 0);
  assert.equal(runtime.protocolErrors.length, 1);
  assert.match(runtime.protocolErrors[0]!, /exclusive/i);
});

test("an unknown skill name is a protocol error naming the available skills", async () => {
  const runtime = makeRuntime({
    completions: [
      '{"reply":"试试","skill":"nope","tool_calls":null}',
      '{"reply":"收口","tool_calls":null}',
    ],
    skills: registryWith({ name: "probe", layer: "research", body: "Probe body." }),
  });

  await runtime.run(runInput());

  assert.equal(runtime.protocolErrors.length, 1);
  assert.match(runtime.protocolErrors[0]!, /probe/);
});

test("a topic-layer skill is invisible to the research controller", async () => {
  const runtime = makeRuntime({
    completions: [
      '{"reply":"试试","skill":"stock-analysis","tool_calls":null}',
      '{"reply":"收口","tool_calls":null}',
    ],
    skills: registryWith({ name: "stock-analysis", layer: "topic", body: "Topic body." }),
  });

  await runtime.run(runInput());

  assert.equal(runtime.protocolErrors.length, 1);
});
```

`runtime.protocolErrors` 从 session 事件里筛出来即可：`state.allEvents().filter(e => e.kind === "error" && e.payload.scope === "protocol").map(e => String(e.payload.message))`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/research/__tests__/researchSkill.test.ts`

Expected: FAIL，`ResearchRuntimeDeps` 上没有 `skills`。

- [ ] **Step 3: 改 prompt**

`src/agent/research/researchPrompt.ts`：

在 `[YOUR MEMBERS]` 段之前插入新段落：

```
[SKILLS YOU CAN INVOKE]
{{skills}}
Invoke a skill when its description matches what the user is asking for. A skill supplies the method for a whole class of request — the order to work in, when to stop and ask the user, what shape the answer takes. Its guidance lands in [CURRENT TURN PROGRESS] on the NEXT step, and it also silently shapes what each member Topic is told, so invoke it BEFORE you write any ask_topic for that request.
```

`[OUTPUT FORMAT]` 的 JSON 骨架改为：

```
{
  "reply": "<what the user sees this step; the final step is the complete answer>",
  "skill": null | "<skill-name>",
  "tool_calls": null | [ { "name": "<tool name>", "input": { } } ]
}
```

`Rules:` 列表中，在 `"tool_calls" is an array...` 那条之后插入：

```
- "skill" is EXCLUSIVE — when it is non-null, "tool_calls" MUST be null. A skill exists to change how you write the next ask_topic, so an ask_topic written in the same step was written without it. Setting both is rejected and the whole step is wasted.
- "skill" must match a name from [SKILLS YOU CAN INVOKE].
```

`[WHEN TO DO WHAT]` 列表开头插入一条：

```
- The request matches a skill's description → set "skill" to its name, with tool_calls null.
```

- [ ] **Step 4: 改运行时**

`src/agent/research/researchRuntime.ts`：

导入：

```ts
import type { SkillRegistry } from "../../framework/skill.ts";
```

`ResearchRuntimeDeps` 加 `skills: SkillRegistry;`，类字段与构造函数各加一行 `this.skills = deps.skills;`（字段声明 `private readonly skills: SkillRegistry;`）。

`run()` 里渲染变量加上 `skills`。在 `const tools = formatList(RESEARCH_TOOL_SPECS);` 之后加：

```ts
    const researchSkills = this.skills.list("research");
    const skills = researchSkills.length
      ? formatList(researchSkills.map((skill) => ({ name: skill.name, description: skill.description })))
      : "(No skills are available.)";
```

并把 `skills` 加进 `this.renderer.render(...)` 的第二个参数。

在 `const askUserCalls = ...` 那段守卫**之前**插入 skill 分支：

```ts
      if (parsed.skill) {
        if (parsed.toolCalls.length > 0) {
          state.record("orchestrator", "error", {
            scope: "protocol",
            message:
              "skill is exclusive with tool_calls — invoke the skill alone, then act on its guidance in the next step",
          });
          continue;
        }
        const skill = this.skills.get(parsed.skill, "research");
        if (!skill) {
          const available = researchSkills.map((s) => s.name).join(", ") || "(none)";
          state.record("orchestrator", "error", {
            scope: "protocol",
            message: `unknown skill '${parsed.skill}'; available skills: ${available}`,
          });
          continue;
        }
        if (status) state.recordReply(status, false);
        state.record("orchestrator", "skill_invoke", { skill: skill.name });
        // 小节必须在这里装上:下一步写出的 ask_topic 才带得上它。
        toolset.setTopicSection(skill.topicSection ?? "");
        const result = await this.skills.invoke(skill.name, {
          sessionId: state.session_id,
          userMessage: input.userMessage,
          state,
        });
        state.record("orchestrator", "skill_result", {
          skill: result.skill,
          status: result.status,
          summary: result.summary,
          ...(result.content ? { content: result.content } : {}),
        });
        continue;
      }
```

> 这里不传 `dispatcher`，靠的是 Task 1 里的两项配套改动（见该 task 的 Step 4）：`WorkflowContext.dispatcher` 已改为可选，且 research 层的技能禁止声明 `workflow`。`SkillRegistry.invoke` 只在 `skill.workflow` 存在时才会碰 `context.dispatcher`，所以对 research 层的技能这个字段永远用不到。

`renderEventLine` 的 switch 中加入：

```ts
      case "skill_result": {
        const content = String(payload.content ?? "");
        const head = `[skill ${String(payload.skill ?? "")}] ${String(payload.summary ?? "")}`;
        return content ? `${head}\n${content}` : head;
      }
```

- [ ] **Step 5: 接线 createApp**

`src/agent/createApp.ts`，`ResearchRuntime` 构造处加一行：

```ts
  const researchRuntime = new ResearchRuntime({
    prompt: researchPrompt,
    modelRouter,
    store: eventStore,
    sessions,
    topicOrchestrator: orchestrator,
    tools: toolRegistry,
    skills,
  });
```

（`tools` 已存在，照抄现状；只新增 `skills`。）

- [ ] **Step 6: 运行测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test src/agent/research/__tests__/researchSkill.test.ts`

Expected: PASS，9 个用例（Task 3 的 5 个 + 本 task 的 4 个）。

- [ ] **Step 7: 全量测试与类型检查**

Run: `npx tsc --noEmit && npm test`

Expected: `tsc` 无输出；只有那一个既有失败。构造 `ResearchRuntimeDeps` 的既有测试会因缺 `skills` 报类型错——补一个空的 `new SkillRegistry()`。

- [ ] **Step 8: 暂存**

```bash
git add src/agent/research/researchRuntime.ts src/agent/research/researchPrompt.ts \
        src/agent/createApp.ts src/agent/research/__tests__/researchSkill.test.ts \
        src/framework/skill.ts src/framework/__tests__/skillLayer.test.ts
```

**不要 git commit。**

---

### Task 5: top-down-research 技能本体

**Files:**
- Create: `skills/top-down-research/top-down-research.md`
- Test: `skills/__tests__/topDownResearch.test.ts`（新建；`npm test` 的 glob 已包含 `skills/**/__tests__/*.test.ts`）

**Interfaces:**
- Consumes: Task 1 的加载与校验规则
- Produces: 一个可加载的 research 层技能

- [ ] **Step 1: 写失败的测试**

新建 `skills/__tests__/topDownResearch.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../../src/framework/skill.ts";

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAll(): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(SKILLS_ROOT);
  return registry;
}

test("top-down-research loads as a research-layer skill", async () => {
  const skill = (await loadAll()).get("top-down-research", "research");
  assert.ok(skill, "skill should load");
  assert.equal(skill.layer, "research");
  assert.ok(skill.topicSection && skill.topicSection.length > 0, "topic section must be present");
});

test("stock-analysis stays on the topic layer", async () => {
  const registry = await loadAll();
  assert.ok(registry.get("stock-analysis"));
  assert.equal(registry.get("stock-analysis", "research"), undefined);
});

test("the topic section carries no internal vocabulary", async () => {
  const section = (await loadAll()).get("top-down-research", "research")!.topicSection!;
  // 这段文字会成为 member 时间线上用户可见的一条消息(spec §2.6)。
  for (const banned of ["SKILL", "skill", "技能", "注入", "ask_topic", "ask_user", "controller"]) {
    assert.ok(!section.includes(banned), `topic section must not mention "${banned}"`);
  }
});

test("the body names the three rounds and the ask_user stops", async () => {
  const body = (await loadAll()).get("top-down-research", "research")!.body;
  assert.match(body, /ask_user/);
  assert.match(body, /fetch_from_topic/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test skills/__tests__/topDownResearch.test.ts`

Expected: FAIL，`skill should load`。

- [ ] **Step 3: 写技能文件**

新建 `skills/top-down-research/top-down-research.md`：

````markdown
---
name: top-down-research
description: Use when the user wants to work from market conditions down to specific stocks — read the macro picture, narrow to a few sectors, then find candidates inside the sectors the user picks.
layer: research
---

自上而下的三轮研究法。每一轮都以用户的一次选择收尾——你负责把选择题问清楚，不负责替用户做选择。

## 三轮

**第一轮 · 宏观 → 板块候选**
先看 roster：已有语义相符的 member 就用 `fetch_from_topic` 看它说过什么，再决定要不要重问；确实没有才 `create_topic` 建一个宏观 Topic。让它判断当前占优的板块，并且**连可交易的代理代码一起交回**。收敛成三个左右候选后，调 `ask_user` 结束这一轮。

**第二轮 · 板块内筛选**
用户选定后，为每个板块准备一个 member Topic，在**同一步内**并行 `ask_topic`。每个 Topic 只做筛选：候选名单加入选理由，不做深度分析。拿到结果后汇总成跨板块的候选概览，调 `ask_user` 结束这一轮。

**第三轮 · 深度分析**
按用户选中的标的驱动相应 Topic 做深度分析。落在哪个 Topic 上由你判断：已有同名 Topic 就用它；用户明确要长期跟踪某只标的，就为它建一个新的。这一轮不调 `ask_user`，直接写出完整报告。

## 硬约束

1. **每一轮必须停在用户的选择上。** 第一轮和第二轮的终点是 `ask_user`，并且它是那一步唯一的工具调用。不要自己替用户挑板块或挑标的，也不要把两轮并成一轮跑完。
2. **同一轮里的多个板块必须在一步内全部 `ask_topic` 出去。** 分步串行会慢三倍，而且会耗尽这一轮的步数预算。
3. **代理代码只能来自 Topic 的答复。** 你没有任何行情工具，自己写出来的代码就是编的。Topic 说取不到行情的代码，不要放进候选。
4. **每一轮最多一次 `fetch_from_topic` 探查。** 探查是为了避免重复提问，不是为了把 member 的历史读一遍。
5. **偏好以给定的用户偏好为准。** 没有给定值时，不要单开一轮空问卷——在第一轮的 `ask_user` 里追加风险承受与持有期限两道选择题，和选板块一起提交。

## 提问的形状

`ask_user` 一次最多 3 题，每题 2-8 个选项。据此：

- 第一轮：题 1 是"深入哪些板块"，选项为各板块，`min_selections` 为 1、`max_selections` 为 3。偏好缺失时再加风险承受、持有期限两题。
- 第二轮：**每个板块一道题**，选项是该板块的候选标的——`label` 用代码，`description` 放一句入选理由。跨板块候选常常超过 8 个，按板块分题正好避开每题的选项上限；板块超过 3 个时，只为用户选中的前 3 个出题。
- `reply` 里不要把每个选项再复述一遍，用户在选项卡上看得到。`reply` 承载的是判断和依据。

## 每一轮的产出

- 第一轮：宏观判断，加三个左右板块，每个带代理代码与入选理由。
- 第二轮：跨板块的候选概览。
- 第三轮：完整报告——跨标的的结论在前，逐标的的依据在后，分歧与未决项收尾。

某个板块的 Topic 超时或失败时，在产出里说明缺了哪一块，不要拿别的板块的数字补。

## for: topic

请给出具体的读数和日期，没有读数支撑的判断就不要写。

提到任何标的，请给出可交易的代码，并确认这个代码取得到行情；取不到就直说取不到。

不要给买卖信号，请给出你判断的维度和依据。

只要结论和依据，不用复述过程。
````

- [ ] **Step 4: 运行测试确认通过**

Run: `node --env-file=.env --experimental-strip-types --experimental-sqlite --test skills/__tests__/topDownResearch.test.ts`

Expected: PASS，4 个用例。

若"the topic section carries no internal vocabulary"失败，说明小节里混进了内部词汇——改小节文字，**不要放宽断言**。

- [ ] **Step 5: 全量测试与类型检查**

Run: `npx tsc --noEmit && npm test`

Expected: `tsc` 无输出；只有那一个既有失败。

- [ ] **Step 6: 暂存**

```bash
git add skills/top-down-research/top-down-research.md skills/__tests__/topDownResearch.test.ts
```

**不要 git commit。**

---

### Task 6: 端到端验证

**Files:**
- Create: `scripts/verify/top-down-research.ts`（一次性验证脚本，验证通过后保留）

**Interfaces:**
- Consumes: 前五个 task 的全部产出
- Produces: 一份人工可读的验证输出

- [ ] **Step 1: 起一个隔离的服务端**

绝不碰 `data/sessions.sqlite`。

```bash
SESSION_DB_PATH=/tmp/tdr-verify.sqlite PORT=3999 \
  node --env-file=.env --experimental-strip-types --experimental-sqlite src/server.ts
```

- [ ] **Step 2: 建一个 Research 并发起第一轮**

用 `curl` 建 Research（照 `src/server/server.ts` 的既有路由；`POST /chat` 带 `sessionId` 为该 Research 的 id）。发一条会触发本技能的消息，例如：

```
现在市场环境下，我想从大方向找几个板块，再往下挑股票。
```

- [ ] **Step 3: 断言第一轮的行为**

从 `/tmp/tdr-verify.sqlite` 读该 session 的事件，逐条确认：

1. 存在一条 `skill_invoke`，`skill` 为 `top-down-research`，且它出现在任何 `ask_topic` 的 `tool_use` **之前**。
2. 存在一条 `skill_result`，其 `content` 非空。
3. 至少一条 `ask_topic` 的 `tool_use`，其 `input.message` **以技能小节的文字结尾**——这验证 spec §2.6 的注入确实生效。
4. 那一轮以 `ask_user` 收尾，且该步只有这一个 tool call。
5. `scope: "protocol"` 的 error 事件数量为 **0**。

- [ ] **Step 4: 断言时间线可读**

打开被驱动的那个 member Topic 的 session，读它的 `user_message` 事件。确认那段追加文字读起来像一句用户会说的话——没有 `[SKILL GUIDANCE]`、没有工具名、没有"技能"字样。这一条是人工判断，不是断言。

- [ ] **Step 5: 记录结果并收尾**

把第 3 步的五项结论与第 4 步的原文摘录写进实现报告。停掉服务端，删除 `/tmp/tdr-verify.sqlite`。

- [ ] **Step 6: 暂存**

```bash
git add scripts/verify/top-down-research.ts
```

**不要 git commit。**

---

## 自查记录

- **spec 覆盖**：§2.1 → Task 1；§2.2 → Task 1；§2.3 → Task 4 Step 3；§2.4 → Task 4 Step 4/5；§2.5 → Task 1（`tools`/`agents`/`workflow` 三条加载期校验）+ Task 4 Step 5（不注册 reference/script 工具）；§2.6 → Task 2 Step 3 + Task 5 Step 3 + Task 6 Step 4；§3.1-3.5 → Task 5；§4 → Task 4 的三个协议错误用例 + 技能正文里的缺口说明；§5 → 各 task 的测试步骤 + Task 6；§6 → 各 task 的文件清单。
- **自查改掉的两处**：草拟时 Task 4 用了 `dispatcher: undefined as never`，Task 1 Step 1 留了一个故意写坏的占位用例。两处都已改干净——`WorkflowContext.dispatcher` 改为可选、research 层禁止 `workflow`，占位用例删除。计划里不该有"别照抄这行"的代码。
- **类型一致性**：`SkillLayer` 定义于 `src/framework/types.ts`，Task 1 产出、Task 4 消费；`setTopicSection` 在 Task 2 产出、Task 4 调用；`ResearchStep.skill` 在 Task 3 产出、Task 4 消费。三处命名一致。
