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

const AGENT_SKILL = `---
name: gamma
description: An agent-layer skill.
layer: agent
tools: [stock_sma]
---
The whole body is the guidance.
`;

test("an agent-layer skill keeps its whole body and may grant tools", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(await skillRoot("gamma", AGENT_SKILL));
  const skill = registry.get("gamma", "agent");

  assert.equal(skill?.layer, "agent");
  assert.equal(skill?.body.trim(), "The whole body is the guidance.");
  assert.deepEqual(skill?.tools, ["stock_sma"]);
  assert.deepEqual(skill?.agentSections, {});
});

test("an agent-layer skill is invisible to the topic and research layers", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(await skillRoot("gamma", AGENT_SKILL));

  assert.equal(registry.get("gamma"), undefined);
  assert.equal(registry.get("gamma", "research"), undefined);
  assert.deepEqual(registry.list().map((s) => s.name), []);
  // getAnyLayer is the deliberate exception: references are guidance text, not
  // capability, so read_skill_reference resolves across layers.
  assert.equal(registry.getAnyLayer("gamma")?.name, "gamma");
});

test("an agent-layer skill may not carry an agent section", async () => {
  const root = await skillRoot("gamma", `${AGENT_SKILL}\n## for: market_data\nExtra.\n`);
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root),
    /agent-layer skill gamma carries a '## for: market_data' section/);
});

test("an agent-layer skill may not carry a topic section", async () => {
  const root = await skillRoot("gamma", `${AGENT_SKILL}\n## for: topic\nExtra.\n`);
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root),
    /agent-layer skill gamma carries a '## for: topic' section/);
});

test("an agent-layer skill may not declare a workflow", async () => {
  const root = await skillRoot("gamma", AGENT_SKILL.replace("layer: agent", "layer: agent\nworkflow: probe"));
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /agent-layer skill gamma may not declare 'workflow'/);
});
