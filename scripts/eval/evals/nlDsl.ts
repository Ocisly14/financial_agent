import { normalizePriceStrategyInput } from "../../../mcp_tools/trading/strategy/priceStrategy.ts";
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { registerAllTools, TRADING_OPERATIONS_TOOLS } from "../../../mcp_tools/registerTools.ts";
import { tradingOperationsSubagentPrompt } from "../../../src/agent/prompts/subagentPrompts.ts";
import { PromptRenderer } from "../../../src/framework/prompt.ts";
import { ModelRouter } from "../../../src/infra/llm/provider.ts";
import { resolveLlmProvider } from "../../../src/agent/createApp.ts";
import { buildLoopToolSpecs } from "../../../src/framework/subagent.ts";
import type { LlmToolSpec } from "../../../src/infra/llm/provider.ts";

export type GoldDsl = {
  tool: string; trigger_type: string; direction: string;
  /** Exactly one of these is the trigger's level: pct for the change triggers, price for
   *  absolute_threshold, threshold for rsi_threshold. A cross trigger has none. */
  pct?: number; price?: number; threshold?: number;
  /** rolling_change only. The schema requires it, so a transcription that drops it is rejected
   *  outright — scoring it as a pass would hide the one failure the tool cannot absorb. */
  window_minutes?: number;
  side: string;
  sizing_kind: string; sizing_value: number; symbol: string; recurrence_mode: string;
};
export type NlCase = { id: string; input: string; gold: GoldDsl };

type GenCall = { tool: string; input: Record<string, unknown> };

/**
 * The one level a trigger fires at, whichever field carries it. A cross trigger pins none, and
 * gold that names none is satisfied by any generated value — there is nothing to be wrong about.
 */
function triggerLevelMatches(trigger: Record<string, unknown>, gold: { pct?: number; price?: number; threshold?: number }): boolean {
  if (gold.pct !== undefined) return Number(trigger["pct"]) === gold.pct;
  if (gold.price !== undefined) return Number(trigger["price"]) === gold.price;
  if (gold.threshold !== undefined) return Number(trigger["threshold"]) === gold.threshold;
  return true;
}

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
    threshold: triggerLevelMatches(trigger, gold),
    window: gold.window_minutes === undefined || Number(trigger["window_minutes"]) === gold.window_minutes,
    side: String(action["side"] ?? "") === gold.side,
    sizing_kind: String(size["type"] ?? size["kind"] ?? "") === gold.sizing_kind,
    sizing_value: Number(size["value"] ?? 0) === gold.sizing_value,
    symbol: symbol.toUpperCase() === gold.symbol.toUpperCase(),
    recurrence_mode: String(recurrence["mode"] ?? "") === gold.recurrence_mode,
  };
  const critical = ["tool", "trigger_type", "direction", "threshold", "window", "side", "sizing_kind", "sizing_value"];
  const intentMatch = critical.every((k) => fields[k] === true);
  return { fields, intentMatch, toolMatch };
}

// ── Live generator (mirrors scripts/test-llm-strategy.ts single-request path) ──

// ── Multi-phase scoring ───────────────────────────────────────────────────────
// Multi-phase strategies (DCA ladders, tiered take-profit, entry+stop combos,
// budget guardrails, recurrence detail) are scored separately from single-phase.

export type GoldPhase = {
  id?: string; depends_on?: string[]; activate_on?: string; price_anchor_phase_id?: string; cancel_group?: string;
  trigger_type: string; direction: string; pct?: number; price?: number; threshold?: number; window_minutes?: number;
  /** Indicator shape. Pinned whenever the plan states it, which is whenever it differs from the
   *  schema default — a plan transcribed onto the wrong period or timeframe is the wrong plan. */
  period?: number; timeframe?: string;
  fast_period?: number; slow_period?: number; signal_period?: number; average_type?: string;
  side: string; sizing_kind: string; sizing_value: number;
  order_type?: string; max_slippage_bps?: number;
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
  workflowMatch: boolean;
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
  if (String(trigger["type"] ?? "") !== gold.trigger_type) return false;
  if (String(trigger["direction"] ?? "") !== gold.direction) return false;
  if (!triggerLevelMatches(trigger, gold)) return false;
  if (gold.window_minutes !== undefined && Number(trigger["window_minutes"]) !== gold.window_minutes) return false;
  for (const field of ["period", "fast_period", "slow_period", "signal_period"] as const) {
    if (gold[field] !== undefined && Number(trigger[field]) !== gold[field]) return false;
  }
  if (gold.timeframe !== undefined && String(trigger["timeframe"] ?? "") !== gold.timeframe) return false;
  if (gold.average_type !== undefined && String(trigger["average_type"] ?? "") !== gold.average_type) return false;
  if (String(action["side"] ?? "") !== gold.side) return false;
  if (String(size["type"] ?? size["kind"] ?? "") !== gold.sizing_kind) return false;
  if (Number(size["value"] ?? 0) !== gold.sizing_value) return false;
  if (gold.order_type !== undefined && String(action["order_type"] ?? "") !== gold.order_type) return false;
  if (gold.max_slippage_bps !== undefined && Number(action["max_slippage_bps"]) !== gold.max_slippage_bps) return false;
  if (String(recurrence["mode"] ?? "") !== gold.recurrence_mode) return false;
  if (gold.max_triggers !== undefined && Number(recurrence["max_triggers"]) !== gold.max_triggers) return false;
  if (gold.cooldown_minutes !== undefined && Number(recurrence["cooldown_minutes"]) !== gold.cooldown_minutes) return false;
  if (gold.reanchor !== undefined && Boolean(recurrence["reanchor"]) !== gold.reanchor) return false;
  if (gold.activate_on !== undefined && String(gen["activate_on"] ?? "") !== gold.activate_on) return false;
  return true;
}

function workflowMatches(
  genPhases: Record<string, unknown>[],
  goldPhases: GoldPhase[],
  matchedIndexes: number[],
): boolean {
  if (matchedIndexes.length !== goldPhases.length || matchedIndexes.some((index) => index < 0)) return false;
  const goldIdToIndex = new Map(goldPhases.map((phase, index) => [phase.id, index] as const).filter(([id]) => id !== undefined));
  const generatedIdForGold = (goldId: string): string | undefined => {
    const goldIndex = goldIdToIndex.get(goldId);
    if (goldIndex === undefined) return undefined;
    return String(genPhases[matchedIndexes[goldIndex]!]!["id"] ?? "") || undefined;
  };

  const generatedOcoByGoldGroup = new Map<string, string>();
  for (const [goldIndex, gold] of goldPhases.entries()) {
    const generated = genPhases[matchedIndexes[goldIndex]!]!;
    if (gold.depends_on !== undefined) {
      const actual = Array.isArray(generated["depends_on"]) ? (generated["depends_on"] as unknown[]).map(String).sort() : [];
      const expected = gold.depends_on.map(generatedIdForGold);
      if (expected.some((id) => id === undefined) || actual.join("|") !== (expected as string[]).sort().join("|")) return false;
    }
    if (gold.price_anchor_phase_id !== undefined) {
      const expectedAnchor = generatedIdForGold(gold.price_anchor_phase_id);
      const anchor = (generated["price_anchor"] ?? {}) as Record<string, unknown>;
      if (!expectedAnchor || String(anchor["phase_id"] ?? "") !== expectedAnchor) return false;
    }
    if (gold.cancel_group !== undefined) {
      const actualGroup = String(generated["cancel_group"] ?? "");
      if (!actualGroup) return false;
      const prior = generatedOcoByGoldGroup.get(gold.cancel_group);
      if (prior !== undefined && prior !== actualGroup) return false;
      generatedOcoByGoldGroup.set(gold.cancel_group, actualGroup);
    }
  }
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
    return { toolMatch: false, phaseCountMatch: false, phasesMatched: 0, phasesTotal, guardrailsMatch: false, modeMatch: false, workflowMatch: false, intentMatch: false };
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
  const matchedIndexes: number[] = [];
  for (const gp of gold.phases) {
    const idx = genPhases.findIndex((gen, i) => !used.has(i) && phaseFullyMatches(gen, gp));
    matchedIndexes.push(idx);
    if (idx >= 0) { used.add(idx); matched++; }
  }
  const phaseCountMatch = genPhases.length === phasesTotal;
  const grMatch = guardrailsMatch(gens, gold.guardrails);
  const modeMatch = gold.mode === undefined ? true : mode === gold.mode;
  const workflowMatch = workflowMatches(genPhases, gold.phases, matchedIndexes);
  const intentMatch = toolMatch && phaseCountMatch && matched === phasesTotal && grMatch && modeMatch && workflowMatch;
  return { toolMatch, phaseCountMatch, phasesMatched: matched, phasesTotal, guardrailsMatch: grMatch, modeMatch, workflowMatch, intentMatch };
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

let cachedToolSpecs: LlmToolSpec[] | null = null;
let cachedRenderer: PromptRenderer | null = null;
let cachedRouter: ModelRouter | null = null;

function ensureWiring(): { toolSpecs: LlmToolSpec[]; renderer: PromptRenderer; router: ModelRouter } {
  if (!cachedToolSpecs || !cachedRenderer || !cachedRouter) {
    const registry = new McpToolRegistry();
    registerAllTools(registry);
    const tradingDefs = registry.list().filter((t) => (TRADING_OPERATIONS_TOOLS as readonly string[]).includes(t.name));
    // The same native specs the dispatched agent receives (`buildLoopToolSpecs`, subagent.ts), which
    // is the only channel carrying create_strategy's argument schema. Rendering the tools as prompt
    // text instead measured a protocol the agent stopped using when it moved to native tool calls —
    // and since the prompt has no {{allowedTools}} slot, that text reached the model nowhere at all,
    // which is why every case scored zero.
    cachedToolSpecs = buildLoopToolSpecs(tradingDefs);
    cachedRenderer = new PromptRenderer();
    // Reuse the app's provider resolution so ① runs on the SAME provider the agent
    // actually uses (Vertex service-account when configured, else API key / Anthropic).
    cachedRouter = new ModelRouter(resolveLlmProvider());
  }
  return { toolSpecs: cachedToolSpecs, renderer: cachedRenderer, router: cachedRouter };
}

/**
 * One transcription round: the task text carries a plan whose every parameter is already decided,
 * exactly as the strategy-design skill hands it over, and the agent's job is to render it as
 * create_strategy arguments. This is the step trading_operations actually owns in production — it
 * has no market tools and makes no choices — so it is the step worth scoring.
 */
export async function generateStrategyCall(input: string): Promise<GenCall | null> {
  const { toolSpecs, renderer, router } = ensureWiring();
  const { system, prompt } = renderer.render(tradingOperationsSubagentPrompt, {
    task: input,
    progress: "(nothing yet)",
    stepBudget: "",
  });
  const res = await router.generate(
    [{ role: "system", content: system }, { role: "user", content: prompt }],
    { modelClass: "MEDIUM", temperature: 0, metadata: { mode: "subagent", agent: "trading_operations" },
      tools: toolSpecs },
  );
  // `finish` is how the agent reports a task it will not act on; it is not a strategy call.
  const call = (res.toolCalls ?? []).find((candidate) => candidate.name !== "finish");
  if (call) return { tool: call.name, input: call.input as Record<string, unknown> };
  // Providers without native tool calling still answer in text; read it the old way rather than
  // scoring a real answer as no answer.
  return parseCalls(res.text)[0] ?? null;
}
