import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../../src/framework/skill.ts";
import { createReadSkillReferenceTool } from "../../src/framework/skillTools.ts";
import { createCreateStrategyTool } from "../../mcp_tools/trading/strategyTools.ts";
import { readFile } from "node:fs/promises";

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAll(): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(SKILLS_ROOT);
  return registry;
}

test("strategy-design loads as a topic skill with sections for both agents it drives", async () => {
  const registry = await loadAll();
  const skill = registry.get("strategy-design");

  assert.ok(skill, "strategy-design skill should load");
  assert.equal(skill.layer, "topic");
  assert.equal(registry.get("strategy-design", "research"), undefined);
  // No tool grant: dispatching market_data already reaches every technical tool.
  assert.equal(skill.tools, undefined);
  assert.ok(skill.agentSections.market_data);
  assert.ok(skill.agentSections.trading_operations);
});

test("a strategy without exits, sizing, or guardrails is not deliverable", async () => {
  const body = (await loadAll()).get("strategy-design")!.body;

  assert.match(body, /entry leg with no exit is not a strategy/);
  assert.match(body, /same `cancel_group`/);
  assert.match(body, /guardrails\.total_budget_usd/);
  assert.match(body, /max_notional_usd/);
  assert.match(body, /invalidation/);
  assert.match(body, /per-leg\s+accounting is required/);
});

test("the question policy asks for risk, never for the mechanics", async () => {
  const body = (await loadAll()).get("strategy-design")!.body;

  assert.match(body, /Never ask the user for/);
  assert.match(body, /trigger types, percentage thresholds, indicator periods/);
  assert.match(body, /risk tolerance/);
  assert.match(body, /at most three questions/);
});

test("every number is derived from a market baseline, and the stop sets the size", async () => {
  const body = (await loadAll()).get("strategy-design")!.body;

  assert.match(body, /ATR\(14\)/);
  assert.match(body, /support and resistance/);
  assert.match(body, /must trace to a figure in the baseline/);
  assert.match(body, /at least 1x ATR/);
  assert.match(body, /Size from the stop, not from the account/);
});

test("agent guidance splits deciding from transcribing", async () => {
  const skill = (await loadAll()).get("strategy-design")!;
  const data = skill.agentSections.market_data!;
  const trading = skill.agentSections.trading_operations!;

  assert.match(data, /stock_atr/);
  assert.match(data, /stock_support_resistance/);
  assert.match(data, /Return figures, not an essay/);
  // The trading agent owns none of the decisions; it copies a settled plan.
  assert.match(trading, /already decided/);
  assert.match(trading, /Do not round/);
  assert.match(trading, /Do not drop a leg/);
  assert.match(trading, /in the finish summary/);
});

test("strategy-design references are available through progressive disclosure", async () => {
  const registry = await loadAll();
  const readReference = createReadSkillReferenceTool(registry);
  const [sizing, triggers] = await Promise.all([
    readReference.execute({ skill: "strategy-design", path: "sizing.md" }, { sessionId: "strategy-skill-test" }),
    readReference.execute(
      { skill: "strategy-design", path: "trigger-selection.md" },
      { sessionId: "strategy-skill-test" },
    ),
  ]);

  assert.equal(sizing.error, undefined);
  assert.equal(triggers.error, undefined);
  assert.match(String(sizing.generation_context?.data["content"]), /risk per trade/);
  assert.match(String(triggers.generation_context?.data["content"]), /rolling_change/);
});

const TRIGGER_REFERENCE = path.join(SKILLS_ROOT, "strategy-design", "references", "trigger-selection.md");

test("the decision table names exactly the triggers create_strategy accepts", async () => {
  const reference = await readFile(TRIGGER_REFERENCE, "utf8");
  // Second column of a decision-table row, which is a single inline-code trigger name.
  const documented = [...reference.matchAll(/^\|[^|]+\|\s*`([a-z_]+)`\s*\|/gm)].map((match) => match[1]!);

  // Read off the schema the model is actually shown, so a trigger the reference
  // invents and a trigger it never documents both fail here.
  const phases = createCreateStrategyTool().inputSchema["properties"]!["phases"] as Record<string, any>;
  const declared = phases["items"]["properties"]["price_trigger"]["properties"]["type"]["enum"] as string[];

  assert.deepEqual([...documented].sort(), [...declared].sort());
});

test("the reference teaches the wiring rules and both executor limits, without worked plans", async () => {
  const reference = await readFile(TRIGGER_REFERENCE, "utf8");

  assert.equal(/```/.test(reference), false, "the reference stays general: no worked strategy payloads");

  // An exit is wired to the entry's actual fill, not to a level chosen in advance.
  assert.match(reference, /activate_on: "first_fill"/);
  assert.match(reference, /`price_anchor`[\s\S]{0,80}?`phase_fill`/);
  assert.match(reference, /share one `cancel_group`/);

  // The two executor limits the worked plans used to carry in their prose.
  assert.match(reference, /aggregate position/);
  assert.match(reference, /[Pp]er-leg position\s+accounting is required/);
  assert.match(reference, /does not add after its entry/);
});
