import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../../src/framework/skill.ts";
import { createReadSkillReferenceTool } from "../../src/framework/skillTools.ts";
import { normalizePriceStrategyInput, priceStrategySchema } from "../../mcp_tools/trading/strategy/priceStrategy.ts";
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

test("every strategy example in the reference is a strategy the tool would accept", async () => {
  const reference = await readFile(
    path.join(SKILLS_ROOT, "strategy-design", "references", "trigger-selection.md"),
    "utf8",
  );
  const blocks = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]!);

  assert.equal(blocks.length, 3, "the reference should carry three worked plans");
  for (const [index, block] of blocks.entries()) {
    // Through the same path create_strategy uses, so an example that only looks
    // right cannot teach a shape the schema rejects.
    const parsed = priceStrategySchema.safeParse(
      normalizePriceStrategyInput(JSON.parse(block) as Record<string, unknown>),
    );
    assert.ok(parsed.success, `example ${index + 1} rejected: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

test("worked plans close a complete position and do not leave a stopped-out add live", async () => {
  const reference = await readFile(
    path.join(SKILLS_ROOT, "strategy-design", "references", "trigger-selection.md"),
    "utf8",
  );
  const plans = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1]!) as { name: string; phases: Array<{
      id: string; cancel_group?: string; action: { side: string; size: { type: string; value: number } } }> });

  const pullback = plans.find((plan) => plan.name === "AAPL pullback")!;
  for (const id of ["target", "stop"]) {
    const phase = pullback.phases.find((candidate) => candidate.id === id)!;
    assert.equal(phase.action.size.type, "pct_of_position");
    assert.equal(phase.action.size.value, 100, `${id} must close the position completely`);
  }
  assert.equal(pullback.phases.find((phase) => phase.id === "target")!.cancel_group, "exit");
  assert.equal(pullback.phases.find((phase) => phase.id === "stop")!.cancel_group, "exit");

  const momentum = plans.find((plan) => plan.name === "SPY momentum turn")!;
  assert.equal(momentum.phases.some((phase) => phase.id === "add"), false);
  assert.equal(momentum.phases.find((phase) => phase.id === "target")!.cancel_group, "exit");
  assert.equal(momentum.phases.find((phase) => phase.id === "stop")!.cancel_group, "exit");
});
