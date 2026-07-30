// Offline lint for the multi-phase dataset — catches the gold-authoring bugs we hit before.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const TRIG = new Set(["rolling_change", "absolute_threshold", "trailing_stop"]);
const SIZE = new Set(["pct_of_position", "pct_of_portfolio", "fixed_quote_usd", "fixed_base_qty"]);
const GUARD = new Set(["total_budget_usd", "max_notional_usd"]);
const TIME_RE = /(hour|hr|min|minute)/i;

const lines = readFileSync(join(DIR, "datasets", "nl-dsl-multiphase.jsonl"), "utf8").split("\n").filter((l) => l.trim());
const issues: string[] = [];
const ids = new Set<string>();
let phaseTotal = 0;

for (const [i, line] of lines.entries()) {
  let c: any;
  try { c = JSON.parse(line); } catch (e) { issues.push(`line ${i + 1}: invalid JSON`); continue; }
  const id = c.id ?? `line${i + 1}`;
  if (ids.has(id)) issues.push(`${id}: duplicate id`);
  ids.add(id);
  const g = c.gold ?? {};
  if (g.tool !== "create_strategy") issues.push(`${id}: gold.tool != create_strategy`);
  if (!g.symbol) issues.push(`${id}: missing symbol`);
  if (g.mode && !["paper", "shadow", "live"].includes(g.mode)) issues.push(`${id}: bad mode ${g.mode}`);
  if (g.guardrails) for (const k of Object.keys(g.guardrails)) if (!GUARD.has(k)) issues.push(`${id}: bad guardrail key '${k}'`);
  const phases = g.phases ?? [];
  if (phases.length === 0) issues.push(`${id}: no phases`);
  phaseTotal += phases.length;
  const nlHasTime = TIME_RE.test(c.input ?? "");
  for (const [pi, p] of phases.entries()) {
    const tag = `${id} phase[${pi}]`;
    if (!TRIG.has(p.trigger_type)) issues.push(`${tag}: bad trigger_type ${p.trigger_type}`);
    if (!["up", "down"].includes(p.direction)) issues.push(`${tag}: bad direction ${p.direction}`);
    if (!["BUY", "SELL"].includes(p.side)) issues.push(`${tag}: bad side ${p.side}`);
    if (!SIZE.has(p.sizing_kind)) issues.push(`${tag}: bad sizing_kind ${p.sizing_kind}`);
    if (!["one_shot", "recurring"].includes(p.recurrence_mode)) issues.push(`${tag}: bad recurrence_mode`);
    if (typeof p.sizing_value !== "number" || p.sizing_value <= 0) issues.push(`${tag}: bad sizing_value`);
    // Float fragility only matters for percentages (derived values like 33.33); base/quote amounts (e.g. 0.1 AAPL) are exact user-stated values.
    if ((p.sizing_kind === "pct_of_position" || p.sizing_kind === "pct_of_portfolio") && !Number.isInteger(p.sizing_value))
      issues.push(`${tag}: NON-INTEGER percentage ${p.sizing_value} (float fragility — reword to avoid compounding math)`);
    if (p.trigger_type === "rolling_change") {
      if (typeof p.pct !== "number") issues.push(`${tag}: rolling_change missing pct`);
      if (!Number.isInteger(p.window_minutes)) issues.push(`${tag}: rolling_change missing/!int window_minutes`);
      if (!nlHasTime) issues.push(`${tag}: rolling_change but NL has no time word (window under-specified?)`);
    }
    if (p.trigger_type === "absolute_threshold" && typeof p.price !== "number") issues.push(`${tag}: absolute_threshold missing price`);
    if (p.trigger_type === "trailing_stop" && typeof p.pct !== "number") issues.push(`${tag}: trailing_stop missing pct`);
    if (p.confirm_samples !== undefined && !Number.isInteger(p.confirm_samples)) issues.push(`${tag}: bad confirm_samples`);
    if (p.max_triggers !== undefined && !Number.isInteger(p.max_triggers)) issues.push(`${tag}: bad max_triggers`);
    if (p.cooldown_minutes !== undefined && !Number.isInteger(p.cooldown_minutes)) issues.push(`${tag}: bad cooldown_minutes`);
  }
}

console.log(`cases: ${lines.length} · phases: ${phaseTotal}`);
if (issues.length === 0) console.log("✓ no lint issues");
else { console.log(`✘ ${issues.length} issue(s):`); for (const x of issues) console.log("  - " + x); }
