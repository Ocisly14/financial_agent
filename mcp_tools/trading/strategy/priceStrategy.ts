import { z } from "zod";
import { priceTriggerSchema, actionSchema, recurrenceSchema } from "./priceTrigger.ts";

export const strategyPhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["active", "running", "completed", "paused", "failed"]).default("active"),
  price_trigger: priceTriggerSchema,
  action: actionSchema,
  recurrence: recurrenceSchema,
  failure_reason: z.string().optional(),
});

export const priceStrategySchema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1), // full Binance pair, e.g. "BTCUSDT"
  mode: z.enum(["paper", "shadow", "live"]).default("paper"),
  phases: z.array(strategyPhaseSchema).min(1),
  guardrails: z
    .object({
      max_notional_usd: z.number().positive().optional(),
      total_budget_usd: z.number().positive().optional(),
    })
    .optional(),
});

export type StrategyPhase = z.infer<typeof strategyPhaseSchema>;
export type PriceStrategyDSL = z.infer<typeof priceStrategySchema>;

export function parsePriceStrategy(value: unknown): PriceStrategyDSL {
  return priceStrategySchema.parse(value);
}

export function tryParsePriceStrategy(
  value: unknown,
): { ok: true; value: PriceStrategyDSL } | { ok: false; issues: string[] } {
  const result = priceStrategySchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[%\s,]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function firstNum(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const n = toNum(o[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function normalizeSymbol(raw: string): string {
  let s = raw.replace(/[/\s-]/g, "").toUpperCase();
  if (/USD$/.test(s) && !/USD[TC]$/.test(s) && !/BUSD$/.test(s)) s = s.replace(/USD$/, "USDT");
  return s;
}

function slug(value: string, fallback: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s || fallback;
}

function normalizeTrigger(raw: unknown): Record<string, unknown> {
  const t = asObj(raw);
  const src = { ...asObj(t["params"]), ...t };
  const out: Record<string, unknown> = {};
  const type = str(src["type"]).toLowerCase();
  if (type) out["type"] = type;
  let direction = str(src["direction"]).toLowerCase();
  const pct = firstNum(src, ["pct", "percentage", "percent", "change_percent", "percentage_change", "retrace_pct", "drawdown_pct", "change"]);
  const win = firstNum(src, ["window_minutes", "window", "minutes", "window_min", "time_window_minutes"]);
  const price = firstNum(src, ["price", "level", "threshold", "target_price", "price_level"]);
  if (pct !== undefined) {
    out["pct"] = Math.abs(pct);
    if (!direction && pct < 0) direction = "down";
    if (!direction && pct > 0 && type === "rolling_change") direction = "up";
  }
  if (win !== undefined) out["window_minutes"] = win;
  if (price !== undefined) out["price"] = price;
  if (direction === "up" || direction === "down") out["direction"] = direction;
  const cs = firstNum(src, ["confirm_samples", "confirmations", "confirm"]);
  out["confirm_samples"] = cs ?? 2;
  return out;
}

function normalizeAction(raw: unknown): Record<string, unknown> {
  const src = { ...asObj(asObj(raw)["params"]), ...asObj(raw) };
  const side = str(src["side"] || src["op"] || src["action"]).toUpperCase();
  let orderType = str(src["order_type"] || src["type"]).toLowerCase();
  if (orderType.includes("marketable") || orderType === "limit") orderType = "marketable_limit";
  else if (orderType.includes("market")) orderType = "market";
  else if (!orderType) orderType = "marketable_limit";

  const existing = asObj(src["size"]);
  let sizeType = str(existing["type"]);
  let sizeVal = toNum(existing["value"]);
  if (!sizeType) {
    const pctPos = firstNum(src, ["percentage_of_balance", "percentage_of_position", "base_size_pct", "position_pct", "pct_of_position"]);
    const pctPort = firstNum(src, ["percentage_of_portfolio", "pct_of_portfolio", "portfolio_pct"]);
    const quote = firstNum(src, ["quote_size", "quote_usd", "usd", "fixed_quote_usd", "amount_usd", "notional_usd"]);
    const base = src["base_size"] ?? src["base_qty"] ?? src["quantity"] ?? src["fixed_base_qty"];
    if (pctPos !== undefined) { sizeType = "pct_of_position"; sizeVal = pctPos; }
    else if (pctPort !== undefined) { sizeType = "pct_of_portfolio"; sizeVal = pctPort; }
    else if (quote !== undefined) { sizeType = "fixed_quote_usd"; sizeVal = quote; }
    else if (base !== undefined) {
      const bs = str(base).toLowerCase();
      if (bs === "all" || bs === "everything" || bs === "100%" || bs === "100") { sizeType = "pct_of_position"; sizeVal = 100; }
      else { const bn = toNum(base); if (bn !== undefined) { sizeType = "fixed_base_qty"; sizeVal = bn; } }
    }
  }

  const out: Record<string, unknown> = {};
  if (side) out["side"] = side;
  out["order_type"] = orderType;
  if (sizeType && sizeVal !== undefined) out["size"] = { type: sizeType, value: sizeVal };
  const slip = firstNum(src, ["max_slippage_bps", "slippage_bps", "slippage_bps_max"]);
  out["max_slippage_bps"] = slip ?? 50;
  return out;
}

function normalizeRecurrence(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    const recurring = /recur|repeat|each|every/.test(raw.toLowerCase());
    return { mode: recurring ? "recurring" : "one_shot", reanchor: false, trigger_count: 0 };
  }
  const r = asObj(raw);
  let mode = str(r["mode"]).toLowerCase();
  if (mode === "once" || mode === "one-shot" || mode === "oneshot") mode = "one_shot";
  if (mode === "repeat" || mode === "repeating") mode = "recurring";
  const max = firstNum(r, ["max_triggers", "max_executions", "times", "count", "max_count", "repeat_count"]);
  const cooldown = firstNum(r, ["cooldown_minutes", "cooldown", "cooldown_min"]);
  if (mode !== "one_shot" && mode !== "recurring") mode = max !== undefined && max > 1 ? "recurring" : "one_shot";
  const out: Record<string, unknown> = { mode, reanchor: typeof r["reanchor"] === "boolean" ? r["reanchor"] : false, trigger_count: 0 };
  if (max !== undefined) out["max_triggers"] = max;
  if (cooldown !== undefined) out["cooldown_minutes"] = cooldown;
  return out;
}

function normalizePhase(raw: unknown, index: number): Record<string, unknown> {
  const p = asObj(raw);
  const name = str(p["name"]) || `Phase ${index + 1}`;
  return {
    id: str(p["id"]) || slug(name, `phase-${index + 1}`),
    name,
    status: "active",
    price_trigger: normalizeTrigger(p["price_trigger"]),
    action: normalizeAction(p["action"]),
    recurrence: normalizeRecurrence(p["recurrence"]),
  };
}

export function normalizePriceStrategyInput(input: Record<string, unknown>): Record<string, unknown> {
  const rawPhases = Array.isArray(input["phases"]) ? input["phases"] : [];
  const out: Record<string, unknown> = {
    name: str(input["name"]) || "Auto-trading strategy",
    symbol: normalizeSymbol(str(input["symbol"])),
    phases: rawPhases.map(normalizePhase),
  };
  const mode = str(input["mode"]).toLowerCase();
  out["mode"] = mode === "paper" || mode === "live" || mode === "shadow" ? mode : "paper";
  if (input["guardrails"] !== undefined) out["guardrails"] = input["guardrails"];
  return out;
}

function summarizeTrigger(t: StrategyPhase["price_trigger"]): string {
  return t.type === "rolling_change"
    ? `${t.direction === "down" ? "drops" : "rises"} ${t.pct}% within ${t.window_minutes}m`
    : t.type === "absolute_threshold"
      ? `price ${t.direction === "down" ? "<" : ">"} ${t.price}`
      : `trailing ${t.direction === "down" ? "stop" : "rebound"} ${t.pct}%`;
}

function summarizeSize(phase: StrategyPhase, symbol: string): string {
  const size = phase.action.size;
  return size.type === "pct_of_position"
    ? `${size.value}% of position`
    : size.type === "pct_of_portfolio"
      ? `${size.value}% of portfolio`
      : size.type === "fixed_quote_usd"
        ? `$${size.value}`
        : `${size.value} ${symbol}`;
}

export function summarizeStrategyPhase(phase: StrategyPhase, symbol: string): string {
  return `${phase.name}: when ${symbol} ${summarizeTrigger(phase.price_trigger)}, ${phase.action.side} ${summarizeSize(phase, symbol)} (${phase.action.order_type}, ${phase.recurrence.mode})`;
}

export function summarizePriceStrategy(s: PriceStrategyDSL): string {
  const phaseText = s.phases.map((phase) => summarizeStrategyPhase(phase, s.symbol)).join("; ");
  return `${s.name} [${s.mode}] ${s.symbol}: ${phaseText}`;
}
