import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../../src/framework/skill.ts";
import { createReadSkillReferenceTool } from "../../src/framework/skillTools.ts";

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAll(): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(SKILLS_ROOT);
  return registry;
}

test("sector-analysis loads as a topic skill with its own tool grant and agent sections", async () => {
  const registry = await loadAll();
  const skill = registry.get("sector-analysis");

  assert.ok(skill, "sector-analysis skill should load");
  assert.equal(skill.layer, "topic");
  assert.equal(registry.get("sector-analysis", "research"), undefined);
  assert.deepEqual(skill.tools, ["get_sector_analysis", "financial_search"]);
  assert.ok(skill.agentSections.market_data);
  assert.ok(skill.agentSections.market_research);
  assert.equal(skill.agentSections.trading_operations, undefined);
});

test("sector-analysis defines full, subset, and single-sector semantics", async () => {
  const skill = (await loadAll()).get("sector-analysis")!;

  assert.match(skill.body, /complete 11-sector universe/);
  assert.match(skill.body, /rank within the selected subset/);
  assert.match(skill.body, /without a cross-sectional rank or strength score/);
  assert.match(skill.body, /Do not silently substitute/);
  assert.match(skill.body, /Never truncate the result to the top three/);
});

test("sector-analysis requires dual-horizon conditional scenarios", async () => {
  const body = (await loadAll()).get("sector-analysis")!.body;

  assert.match(body, /1–3 months/);
  assert.match(body, /6–12 months/);
  assert.match(body, /base, upside, and downside scenarios/);
  assert.match(body, /invalidation conditions/);
  assert.match(body, /Do not provide unsupported return forecasts, price targets, or probabilities/);
});

test("agent guidance preserves data semantics and news provenance", async () => {
  const skill = (await loadAll()).get("sector-analysis")!;
  const data = skill.agentSections.market_data!;
  const research = skill.agentSections.market_research!;

  assert.match(data, /get_sector_analysis/);
  assert.match(data, /rank and score do not apply/);
  assert.match(data, /Do not interpret the score as a forecast/);
  assert.match(research, /past 30 days/);
  assert.match(research, /next 90 days/);
  assert.match(research, /event date, source, URL, and evidence type/);
});

test("sector-analysis references are available through progressive disclosure", async () => {
  const registry = await loadAll();
  const readReference = createReadSkillReferenceTool(registry);
  const [playbook, template] = await Promise.all([
    readReference.execute(
      { skill: "sector-analysis", path: "forward-analysis-playbook.md" },
      { sessionId: "sector-skill-test" },
    ),
    readReference.execute(
      { skill: "sector-analysis", path: "report-template.md" },
      { sessionId: "sector-skill-test" },
    ),
  ]);

  assert.equal(playbook.error, undefined);
  assert.equal(template.error, undefined);
  assert.match(String(playbook.generation_context?.data["content"]), /Observed market data/);
  assert.match(String(template.generation_context?.data["content"]), /Dual-horizon outlook/);
});

test("the entire sector-analysis skill package is English-only", async () => {
  const registry = await loadAll();
  const skill = registry.get("sector-analysis")!;
  const readReference = createReadSkillReferenceTool(registry);
  const [playbook, template] = await Promise.all([
    readReference.execute(
      { skill: "sector-analysis", path: "forward-analysis-playbook.md" },
      { sessionId: "sector-skill-language-test" },
    ),
    readReference.execute(
      { skill: "sector-analysis", path: "report-template.md" },
      { sessionId: "sector-skill-language-test" },
    ),
  ]);
  const packageText = [
    skill.body,
    ...Object.values(skill.agentSections),
    String(playbook.generation_context?.data["content"]),
    String(template.generation_context?.data["content"]),
  ].join("\n");

  assert.doesNotMatch(packageText, /[\u3400-\u9fff]/u);
});
