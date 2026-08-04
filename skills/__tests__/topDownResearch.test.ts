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
  // This text becomes a user-visible message on the member timeline (spec §2.6).
  for (const banned of ["SKILL", "skill", "injection", "ask_topic", "ask_user", "controller"]) {
    assert.ok(!section.includes(banned), `topic section must not mention "${banned}"`);
  }
});

test("the body names the three rounds and the ask_user stops", async () => {
  const body = (await loadAll()).get("top-down-research", "research")!.body;
  assert.match(body, /ask_user/);
  assert.match(body, /fetch_from_topic/);
});
