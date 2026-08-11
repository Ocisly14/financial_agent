import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillRegistry } from "../skill.ts";
import { createReadSkillReferenceTool } from "../skillTools.ts";

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills");

async function loadAll(): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  await registry.loadFromDirectory(SKILLS_ROOT);
  return registry;
}

test("the shipped stock-analysis skill loads with narrow research access", async () => {
  const registry = await loadAll();
  const skill = registry.get("stock-analysis")!;

  assert.ok(skill, "stock-analysis skill should be discovered");
  assert.equal(skill.layer, "topic");
  assert.ok(skill.tools?.includes("get_stock_price"));
  assert.ok(skill.tools?.includes("get_sector_analysis"));
  assert.ok(skill.tools?.includes("get_sec_company_profile"));
  assert.ok(skill.tools?.includes("get_sec_filings"));
  assert.ok(skill.tools?.includes("get_sec_company_facts"));
  assert.ok(skill.tools?.includes("financial_search"));
  assert.ok(skill.agentSections.market_data);
  assert.ok(skill.agentSections.market_research);
  assert.equal(skill.agentSections.trading_operations, undefined);
});

test("stock-analysis requires macro and company evidence to remain separate until synthesis", async () => {
  const registry = await loadAll();
  const body = registry.get("stock-analysis")!.body;

  assert.match(body, /Treat macro conditions and company data as separate evidence streams until synthesis/);
  assert.match(body, /macro variable -> sector or industry mechanism -> company exposure/);
  assert.match(body, /company-specific evidence more weight than a generic sector relationship/);
  assert.match(body, /Do not collapse opposing signals into a composite score/);
});

test("stock-analysis enforces dual-horizon scenarios and thesis invalidation", async () => {
  const registry = await loadAll();
  const body = registry.get("stock-analysis")!.body;

  assert.match(body, /1-3 months/);
  assert.match(body, /6-12 months/);
  assert.match(body, /base, upside, and downside cases/);
  assert.match(body, /invalidation condition/);
  assert.match(body, /thesis-monitoring indicators and explicit kill criteria/);
});

test("the market_data section uses exact windows and preserves indicator semantics", async () => {
  const registry = await loadAll();
  const section = registry.get("stock-analysis")!.agentSections.market_data!;

  assert.match(section, /window/);
  assert.match(section, /historyDays/);
  assert.match(section, /stock_vwap/);
  assert.match(section, /history_bars/);
  assert.match(section, /timeframe/);
  assert.match(section, /single supported sector ETF proxy/);
});

test("the market_research section requires primary sources, comparable definitions, and provenance", async () => {
  const registry = await loadAll();
  const section = registry.get("stock-analysis")!.agentSections.market_research!;

  assert.match(section, /past 90 days/);
  assert.match(section, /next 90 days/);
  assert.match(section, /event or publication date, source, URL, evidence class/);
  assert.match(section, /GAAP\/non-GAAP differences/);
  assert.match(section, /get_sec_company_facts/);
  assert.match(section, /taxonomy, concept, unit, period, form, filed date, and accession number/);
  assert.match(section, /never manufacture a consensus figure or valuation multiple/);
});

test("stock-analysis references support progressive disclosure", async () => {
  const registry = await loadAll();
  const readReference = createReadSkillReferenceTool(registry);
  const paths = [
    "macro-transmission-playbook.md",
    "company-data-playbook.md",
    "technical-playbook.md",
    "report-template.md",
  ];

  const results = await Promise.all(paths.map((referencePath) => readReference.execute(
    { skill: "stock-analysis", path: referencePath },
    { sessionId: "stock-analysis-reference-test", agentId: "agent-1" },
  )));

  for (const result of results) assert.equal(result.error, undefined);
  assert.match(String(results[0]!.generation_context?.data["content"]), /Macro Transmission Playbook/);
  assert.match(String(results[1]!.generation_context?.data["content"]), /expectations test/);
  assert.match(String(results[2]!.generation_context?.data["content"]), /Technical and Market-Structure Playbook/);
  assert.match(String(results[3]!.generation_context?.data["content"]), /Conditional outlook/);
});
