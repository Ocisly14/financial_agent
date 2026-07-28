import { normalizePriceStrategyInput } from "../../../mcp_tools/trading/strategy/priceStrategy.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { registerAllTools, TRADING_TOOLS } from "../../../mcp_tools/registerTools.ts";
import { tradeSubagentPrompt } from "../../../src/agent/prompts/subagentPrompts.ts";
import { PromptRenderer } from "../../../src/framework/prompt.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import { formatAllowedTools } from "../../../src/framework/subagent.ts";

export type GoldDsl = {
  tool: string; trigger_type: string; direction: string;
  pct?: number; price?: number; side: string;
  sizing_kind: string; sizing_value: number; symbol: string; recurrence_mode: string;
};
export type NlCase = { id: string; input: string; gold: GoldDsl };

type GenCall = { tool: string; input: Record<string, unknown> };

/** Normalize the generated tool input and compare each critical field to gold. */
export function scoreCase(generated: GenCall | null, gold: GoldDsl): {
  fields: Record<string, boolean>; intentMatch: boolean; toolMatch: boolean;
} {
  if (!generated) {
    return { fields: {}, intentMatch: false, toolMatch: false };
  }
  const toolMatch = generated.tool === gold.tool;
  // Normalize via the same path the tool uses, then read the first phase.
  let phase: Record<string, unknown> | undefined;
  let symbol = "";
  try {
    const norm = normalizePriceStrategyInput(generated.input) as Record<string, unknown>;
    symbol = String(norm["symbol"] ?? generated.input["symbol"] ?? "");
    const phases = norm["phases"] as Record<string, unknown>[] | undefined;
    phase = phases?.[0];
  } catch {
    phase = (Array.isArray(generated.input["phases"]) ? (generated.input["phases"] as Record<string, unknown>[])[0] : undefined);
    symbol = String(generated.input["symbol"] ?? "");
  }
  const trigger = (phase?.["price_trigger"] ?? {}) as Record<string, unknown>;
  const action = (phase?.["action"] ?? {}) as Record<string, unknown>;
  const size = (action["size"] ?? {}) as Record<string, unknown>;
  const recurrence = (phase?.["recurrence"] ?? {}) as Record<string, unknown>;

  const fields: Record<string, boolean> = {
    tool: toolMatch,
    trigger_type: String(trigger["type"] ?? "") === gold.trigger_type,
    direction: String(trigger["direction"] ?? "") === gold.direction,
    threshold: gold.pct !== undefined ? Number(trigger["pct"]) === gold.pct : Number(trigger["price"]) === gold.price,
    side: String(action["side"] ?? "") === gold.side,
    sizing_kind: String(size["type"] ?? size["kind"] ?? "") === gold.sizing_kind,
    sizing_value: Number(size["value"] ?? 0) === gold.sizing_value,
    symbol: symbol.toUpperCase().startsWith(gold.symbol.replace(/USDT?$/i, "").toUpperCase()),
    recurrence_mode: String(recurrence["mode"] ?? "") === gold.recurrence_mode,
  };
  const critical = ["tool", "trigger_type", "direction", "threshold", "side", "sizing_kind", "sizing_value"];
  const intentMatch = critical.every((k) => fields[k] === true);
  return { fields, intentMatch, toolMatch };
}

// ── Live generator (mirrors scripts/test-llm-strategy.ts single-request path) ──

// ── Multi-phase scoring ───────────────────────────────────────────────────────
// Multi-phase strategies (DCA ladders, tiered take-profit, entry+stop combos,
// budget guardrails, recurrence detail) are scored separately from single-phase.

export type GoldPhase = {
  trigger_type: string; direction: string; pct?: number; price?: number; window_minutes?: number;
  side: string; sizing_kind: string; sizing_value: number;
  order_type?: string; max_slippage_bps?: number; confirm_samples?: number;
  recurrence_mode: string; max_triggers?: number; cooldown_minutes?: number; reanchor?: boolean;
};
export type GoldMultiDsl = {
  tool: string; symbol: string; mode?: string; phases: GoldPhase[];
  guardrails?: { max_notional_usd?: number; total_budget_usd?: number };
};
export type NlMultiCase = { id: string; input: string; gold: GoldMultiDsl };

export type MultiScore = {
  toolMatch: boolean;
  phaseCountMatch: boolean;
  phasesMatched: number;   // count of gold phases with a fully-correct generated phase
  phasesTotal: number;
  guardrailsMatch: boolean;
  modeMatch: boolean;
  intentMatch: boolean;    // tool + every gold phase fully matched + correct count + guardrails + mode
};

/**
 * A generated phase fully matches a gold phase across every parameter the gold
 * specifies: trigger type/direction/threshold, window_minutes (rolling_change),
 * side, sizing, order_type, max_slippage_bps, recurrence mode/max_triggers/cooldown.
 * Optional fields are only checked when the gold pins them down.
 */
function phaseFullyMatches(gen: Record<string, unknown>, gold: GoldPhase): boolean {
  const trigger = (gen["price_trigger"] ?? {}) as Record<string, unknown>;
  const action = (gen["action"] ?? {}) as Record<string, unknown>;
  const size = (action["size"] ?? {}) as Record<string, unknown>;
  const recurrence = (gen["recurrence"] ?? {}) as Record<string, unknown>;
  const thresholdOk = gold.pct !== undefined ? Number(trigger["pct"]) === gold.pct : Number(trigger["price"]) === gold.price;
  if (String(trigger["type"] ?? "") !== gold.trigger_type) return false;
  if (String(trigger["direction"] ?? "") !== gold.direction) return false;
  if (!thresholdOk) return false;
  if (gold.window_minutes !== undefined && Number(trigger["window_minutes"]) !== gold.window_minutes) return false;
  if (String(action["side"] ?? "") !== gold.side) return false;
  if (String(size["type"] ?? size["kind"] ?? "") !== gold.sizing_kind) return false;
  if (Number(size["value"] ?? 0) !== gold.sizing_value) return false;
  if (gold.order_type !== undefined && String(action["order_type"] ?? "") !== gold.order_type) return false;
  if (gold.max_slippage_bps !== undefined && Number(action["max_slippage_bps"]) !== gold.max_slippage_bps) return false;
  if (gold.confirm_samples !== undefined && Number(trigger["confirm_samples"]) !== gold.confirm_samples) return false;
  if (String(recurrence["mode"] ?? "") !== gold.recurrence_mode) return false;
  if (gold.max_triggers !== undefined && Number(recurrence["max_triggers"]) !== gold.max_triggers) return false;
  if (gold.cooldown_minutes !== undefined && Number(recurrence["cooldown_minutes"]) !== gold.cooldown_minutes) return false;
  if (gold.reanchor !== undefined && Boolean(recurrence["reanchor"]) !== gold.reanchor) return false;
  return true;
}

function guardrailsMatch(gen: Record<string, unknown>, gold: GoldMultiDsl["guardrails"]): boolean {
  if (!gold) return true;
  if (gold.max_notional_usd !== undefined && Number(gen["max_notional_usd"]) !== gold.max_notional_usd) return false;
  if (gold.total_budget_usd !== undefined && Number(gen["total_budget_usd"]) !== gold.total_budget_usd) return false;
  return true;
}

export function scoreMultiCase(generated: GenCall | null, gold: GoldMultiDsl): MultiScore {
  const phasesTotal = gold.phases.length;
  if (!generated) {
    return { toolMatch: false, phaseCountMatch: false, phasesMatched: 0, phasesTotal, guardrailsMatch: false, modeMatch: false, intentMatch: false };
  }
  const toolMatch = generated.tool === gold.tool;
  let genPhases: Record<string, unknown>[] = [];
  let gens: Record<string, unknown> = {};
  let mode = "";
  try {
    const norm = normalizePriceStrategyInput(generated.input) as Record<string, unknown>;
    genPhases = (norm["phases"] as Record<string, unknown>[]) ?? [];
    gens = (norm["guardrails"] as Record<string, unknown>) ?? {};
    mode = String(norm["mode"] ?? "");
  } catch {
    genPhases = Array.isArray(generated.input["phases"]) ? (generated.input["phases"] as Record<string, unknown>[]) : [];
    gens = (generated.input["guardrails"] as Record<string, unknown>) ?? {};
    mode = String(generated.input["mode"] ?? "");
  }

  // Greedy, order-independent: each gold phase claims one unused fully-correct generated phase.
  const used = new Set<number>();
  let matched = 0;
  for (const gp of gold.phases) {
    const idx = genPhases.findIndex((gen, i) => !used.has(i) && phaseFullyMatches(gen, gp));
    if (idx >= 0) { used.add(idx); matched++; }
  }
  const phaseCountMatch = genPhases.length === phasesTotal;
  const grMatch = guardrailsMatch(gens, gold.guardrails);
  const modeMatch = gold.mode === undefined ? true : mode === gold.mode;
  const intentMatch = toolMatch && phaseCountMatch && matched === phasesTotal && grMatch && modeMatch;
  return { toolMatch, phaseCountMatch, phasesMatched: matched, phasesTotal, guardrailsMatch: grMatch, modeMatch, intentMatch };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function parseCalls(text: string): GenCall[] {
  const json = extractJsonObject(text);
  if (!json) return [];
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(json) as Record<string, unknown>; } catch { return []; }
  const calls = Array.isArray(raw["calls"]) ? (raw["calls"] as unknown[]) : raw["tool"] ? [raw] : [];
  return calls
    .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : null))
    .filter((c): c is Record<string, unknown> => c !== null && typeof c["tool"] === "string")
    .map((c) => ({ tool: String(c["tool"]), input: (c["input"] && typeof c["input"] === "object" ? c["input"] : {}) as Record<string, unknown> }));
}

let cachedAllowedTools: string | null = null;
let cachedRenderer: PromptRenderer | null = null;
let cachedRouter: ModelRouter | null = null;

function ensureWiring(): { allowedTools: string; renderer: PromptRenderer; router: ModelRouter } {
  if (!cachedAllowedTools || !cachedRenderer || !cachedRouter) {
    const registry = new McpToolRegistry();
    registerAllTools(registry);
    const tradingDefs = registry.list().filter((t) => (TRADING_TOOLS as readonly string[]).includes(t.name));
    cachedAllowedTools = formatAllowedTools(tradingDefs);
    cachedRenderer = new PromptRenderer();
    // Reuse the app's provider resolution so ① runs on the SAME provider the agent
    // actually uses (Vertex service-account when configured, else API key / Anthropic).
    cachedRouter = new ModelRouter(resolveLlmProvider());
  }
  return { allowedTools: cachedAllowedTools, renderer: cachedRenderer, router: cachedRouter };
}

export async function generateStrategyCall(input: string): Promise<GenCall | null> {
  const { allowedTools, renderer, router } = ensureWiring();
  const { system, prompt } = renderer.render(tradeSubagentPrompt, {
    allowedTools,
    task: input,
    progress: "(nothing yet)",
  });
  const res = await router.generate(
    [{ role: "system", content: system }, { role: "user", content: prompt }],
    { modelClass: "MEDIUM", temperature: 0, metadata: { mode: "subagent", agent: "trade" } },
  );
  const calls = parseCalls(res.text);
  return calls[0] ?? null;
}
