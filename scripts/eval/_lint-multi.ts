// Offline lint for both NL→DSL datasets — catches the gold-authoring bugs we hit before.
//
// The cases are transcription tasks: the `input` is a plan whose every parameter is already
// decided, and the `gold` is what a faithful transcription produces. That makes one check possible
// that was not before — every number in the gold must literally appear in the plan text. A gold
// that says pct 6 against a plan that says 5 is not a hard case, it is a broken one, and it would
// otherwise show up as a permanent model failure nobody can fix.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));

const SIZE = new Set(["pct_of_position", "pct_of_portfolio", "fixed_quote_usd", "fixed_base_qty"]);
const GUARD = new Set(["total_budget_usd", "max_notional_usd"]);

/** Per trigger type: which directions are legal, and which parameters the gold must pin down. */
const TRIGGERS: Record<string, { directions: string[]; required: string[] }> = {
  rolling_change: { directions: ["up", "down"], required: ["pct", "window_minutes"] },
  absolute_threshold: { directions: ["up", "down"], required: ["price"] },
  relative_change: { directions: ["up", "down"], required: ["pct"] },
  trailing_stop: { directions: ["up", "down"], required: ["pct"] },
  rsi_threshold: { directions: ["above", "below"], required: ["threshold"] },
  macd_cross: { directions: ["bullish", "bearish"], required: [] },
  moving_average_cross: { directions: ["bullish", "bearish"], required: [] },
};

/** Triggers that can take their reference from an earlier phase's fill. */
const ANCHORABLE = new Set(["relative_change", "trailing_stop"]);

type GoldPhase = Record<string, any>;
type Case = { id?: string; input?: string; gold?: Record<string, any> };

/** Whether a number is stated in the plan text, tolerating 182.4 written as 182.40. */
function textStates(text: string, value: number): boolean {
  const plain = String(value);
  if (text.includes(plain)) return true;
  if (Number.isInteger(value) && text.includes(value.toLocaleString("en-US"))) return true;
  return /\./.test(plain) ? text.includes(value.toFixed(2)) : text.includes(`${plain}.00`);
}

function lintFile(file: string, issues: string[]): { cases: number; phases: number } {
  const lines = readFileSync(join(DIR, "datasets", file), "utf8").split("\n").filter((l) => l.trim());
  const ids = new Set<string>();
  let phaseTotal = 0;

  for (const [i, line] of lines.entries()) {
    let c: Case;
    try { c = JSON.parse(line) as Case; } catch { issues.push(`${file} line ${i + 1}: invalid JSON`); continue; }
    const id = `${file}:${c.id ?? `line${i + 1}`}`;
    if (c.id && ids.has(c.id)) issues.push(`${id}: duplicate id`);
    if (c.id) ids.add(c.id);

    const text = c.input ?? "";
    if (!text.trim()) issues.push(`${id}: empty input`);
    const g = c.gold ?? {};
    if (g["tool"] !== "create_strategy") issues.push(`${id}: gold.tool != create_strategy`);
    const symbol = String(g["symbol"] ?? "");
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol)) issues.push(`${id}: bad symbol '${symbol}'`);
    else if (!text.includes(symbol)) issues.push(`${id}: plan text never names ${symbol}`);
    if (g["mode"] !== undefined) {
      if (!["paper", "shadow"].includes(g["mode"])) issues.push(`${id}: bad mode ${g["mode"]}`);
      else if (!text.includes(g["mode"])) issues.push(`${id}: plan text never states mode ${g["mode"]}`);
    }
    for (const [k, v] of Object.entries(g["guardrails"] ?? {})) {
      if (!GUARD.has(k)) issues.push(`${id}: bad guardrail key '${k}'`);
      else if (!textStates(text, Number(v))) issues.push(`${id}: plan text never states ${k} ${v}`);
    }

    // Single-phase gold is one phase inline; multi-phase gold carries a phases[].
    const phases: GoldPhase[] = Array.isArray(g["phases"]) ? g["phases"] : [g];
    if (phases.length === 0) issues.push(`${id}: no phases`);
    phaseTotal += phases.length;
    const phaseIds = new Set(phases.map((p) => p["id"]).filter(Boolean));

    for (const [pi, p] of phases.entries()) {
      const tag = `${id} phase[${pi}]`;
      const spec = TRIGGERS[p["trigger_type"]];
      if (!spec) { issues.push(`${tag}: bad trigger_type ${p["trigger_type"]}`); continue; }
      if (!spec.directions.includes(p["direction"])) {
        issues.push(`${tag}: direction '${p["direction"]}' is not one of ${spec.directions.join("|")} for ${p["trigger_type"]}`);
      }
      for (const field of spec.required) {
        const value = p[field];
        if (typeof value !== "number") { issues.push(`${tag}: ${p["trigger_type"]} missing ${field}`); continue; }
        if (field === "window_minutes" && !Number.isInteger(value)) issues.push(`${tag}: window_minutes must be an integer`);
        if (!textStates(text, value)) issues.push(`${tag}: plan text never states ${field} ${value}`);
      }
      if (!["BUY", "SELL"].includes(p["side"])) issues.push(`${tag}: bad side ${p["side"]}`);
      if (!SIZE.has(p["sizing_kind"])) issues.push(`${tag}: bad sizing_kind ${p["sizing_kind"]}`);
      const size = p["sizing_value"];
      if (typeof size !== "number" || size <= 0) issues.push(`${tag}: bad sizing_value`);
      else {
        // Percentages that are not whole numbers make the gold depend on how the model rounds a
        // derived figure; whole shares are what a US equity order can actually be.
        if ((p["sizing_kind"] === "pct_of_position" || p["sizing_kind"] === "pct_of_portfolio") && !Number.isInteger(size)) {
          issues.push(`${tag}: non-integer percentage ${size}`);
        }
        if (p["sizing_kind"] === "fixed_base_qty" && !Number.isInteger(size)) {
          issues.push(`${tag}: ${size} shares — US equity strategies here trade whole shares`);
        }
        if (!textStates(text, size)) issues.push(`${tag}: plan text never states size ${size}`);
      }
      if (!["one_shot", "recurring"].includes(p["recurrence_mode"])) issues.push(`${tag}: bad recurrence_mode`);
      if (p["recurrence_mode"] === "one_shot" && (p["max_triggers"] !== undefined || p["cooldown_minutes"] !== undefined)) {
        issues.push(`${tag}: one_shot phase pins a recurring-only field`);
      }
      for (const field of ["max_triggers", "cooldown_minutes"]) {
        if (p[field] !== undefined && !Number.isInteger(p[field])) issues.push(`${tag}: bad ${field}`);
        else if (p[field] !== undefined && !textStates(text, p[field])) issues.push(`${tag}: plan text never states ${field} ${p[field]}`);
      }
      for (const dependency of p["depends_on"] ?? []) {
        if (!phaseIds.has(dependency)) issues.push(`${tag}: unknown dependency '${dependency}'`);
      }
      if (p["activate_on"] !== undefined) {
        if (!["first_fill", "phase_completed"].includes(p["activate_on"])) issues.push(`${tag}: bad activate_on`);
        if (!(p["depends_on"] ?? []).length) issues.push(`${tag}: activate_on without a dependency`);
      }
      if (p["price_anchor_phase_id"]) {
        if (!(p["depends_on"] ?? []).includes(p["price_anchor_phase_id"])) issues.push(`${tag}: price anchor is not a dependency`);
        if (!ANCHORABLE.has(p["trigger_type"])) issues.push(`${tag}: ${p["trigger_type"]} cannot take a phase-fill anchor`);
      }
      if (p["cancel_group"] && !(p["depends_on"] ?? []).length) {
        issues.push(`${tag}: cancel_group on a phase that depends on nothing — an OCO pair guards an entry`);
      }
    }
  }
  return { cases: lines.length, phases: phaseTotal };
}

const issues: string[] = [];
for (const file of ["nl-dsl.jsonl", "nl-dsl-multiphase.jsonl"]) {
  const { cases, phases } = lintFile(file, issues);
  console.log(`${file}: cases ${cases} · phases ${phases}`);
}
if (issues.length === 0) console.log("✓ no lint issues");
else { console.log(`✘ ${issues.length} issue(s):`); for (const x of issues) console.log("  - " + x); }
process.exit(issues.length === 0 ? 0 : 1);
