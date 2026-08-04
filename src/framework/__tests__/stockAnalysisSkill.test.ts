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

test("the market_data section warns that an unparameterised stock_vwap call is cross-day, not intraday", async () => {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(SKILLS_ROOT);
  const section = registry.get("stock-analysis")!.agentSections.market_data!;

  assert.match(section, /stock_vwap/);
  assert.match(section, /history_bars/);
  assert.match(section, /timeframe/);
});
