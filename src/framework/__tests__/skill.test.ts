import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillRegistry, splitAgentSections } from "../skill.ts";

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
    "demo/demo.md": [
      "---",
      "name: demo",
      "description: a demo skill",
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

  assert.deepEqual(skill.tools, ["get_stock_price", "stock_rsi"]);
  assert.equal(skill.body.trim(), "body text");
  assert.equal(skill.dir, path.join(root, "demo"));
  assert.deepEqual(skill.agentSections, {});
});

test("a skill file whose name disagrees with its directory fails at load time", async () => {
  const root = await skillDir({
    "demo/demo.md": ["---", "name: something-else", "description: d", "---", "body"].join("\n"),
  });

  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /something-else/);
});

test("a directory holding only the old SKILL.md name is skipped, not silently renamed", async () => {
  const root = await skillDir({
    "demo/SKILL.md": ["---", "name: demo", "description: d", "---", "body"].join("\n"),
  });

  const registry = new SkillRegistry();
  await registry.loadFromDirectory(root);
  assert.deepEqual(registry.list(), []);
});

test("a missing skills directory is a legal empty state", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory("/nonexistent-skills-dir-xyz");
  assert.deepEqual(registry.list(), []);
});

test("the removed 'agents:' field fails at load time instead of being ignored", async () => {
  const root = await skillDir({
    "demo/demo.md": [
      "---",
      "name: demo",
      "description: a demo skill",
      "agents: [market_data]",
      "---",
      "body",
    ].join("\n"),
  });

  // Ignoring it would leave the author believing a whitelist is still in force.
  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /declares 'agents', which no longer exists/);
});

test("a missing description fails at load time rather than loading silently", async () => {
  const root = await skillDir({
    "demo/demo.md": ["---", "name: demo", "---", "body"].join("\n"),
  });

  const registry = new SkillRegistry();
  await assert.rejects(() => registry.loadFromDirectory(root), /description/);
});

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

test("invoking a skill without a workflow returns its body as content", async () => {
  const root = await skillDir({
    "demo/demo.md": ["---", "name: demo", "description: d", "---", "the framework text"].join("\n"),
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
