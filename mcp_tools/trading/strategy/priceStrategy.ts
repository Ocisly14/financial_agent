import { z } from "zod";
import { priceTriggerSchema, actionSchema, recurrenceSchema } from "./priceTrigger.ts";

const priceAnchorSchema = z.object({
  type: z.literal("phase_fill"),
  phase_id: z.string().min(1),
});

const phaseFillSchema = z.object({
  execution_id: z.string().min(1),
  price: z.number().positive(),
  quantity: z.number().positive(),
  side: z.enum(["BUY", "SELL"]),
  at: z.string().min(1),
});

export const strategyPhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["waiting", "active", "running", "completed", "paused", "cancelled", "failed"]).default("active"),
  depends_on: z.array(z.string().min(1)).default([]),
  activate_on: z.enum(["first_fill", "phase_completed"]).default("phase_completed"),
  price_anchor: priceAnchorSchema.optional(),
  cancel_group: z.string().min(1).optional(),
  price_trigger: priceTriggerSchema,
  action: actionSchema,
  recurrence: recurrenceSchema,
  last_fill: phaseFillSchema.optional(),
  cancel_reason: z.string().optional(),
  failure_reason: z.string().optional(),
});

export const priceStrategySchema = z.object({
  name: z.string().min(1),
  symbol: z.string().regex(/^[A-Z]{1,5}(?:\.[A-Z])?$/, "use a US stock or ETF ticker such as AAPL or BRK.B"),
  mode: z.enum(["paper", "shadow"]).default("paper"),
  phases: z.array(strategyPhaseSchema).min(1),
  guardrails: z
    .object({
      max_notional_usd: z.number().positive().optional(),
      total_budget_usd: z.number().positive().optional(),
    })
    .optional(),
}).superRefine((strategy, context) => {
  const phaseById = new Map<string, (typeof strategy.phases)[number]>();
  for (const [index, phase] of strategy.phases.entries()) {
    if (phaseById.has(phase.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phases", index, "id"],
        message: `duplicate phase id '${phase.id}'`,
      });
    } else {
      phaseById.set(phase.id, phase);
    }
  }

  for (const [index, phase] of strategy.phases.entries()) {
    if (new Set(phase.depends_on).size !== phase.depends_on.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["phases", index, "depends_on"], message: "phase dependencies must be unique" });
    }
    for (const dependencyId of phase.depends_on) {
      if (dependencyId === phase.id) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["phases", index, "depends_on"], message: "a phase cannot depend on itself" });
      } else if (!phaseById.has(dependencyId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["phases", index, "depends_on"], message: `unknown phase dependency '${dependencyId}'` });
      } else {
        const dependency = phaseById.get(dependencyId)!;
        if (phase.activate_on === "phase_completed" && dependency.recurrence.mode === "recurring" && dependency.recurrence.max_triggers === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["phases", index, "activate_on"],
            message: `phase '${dependencyId}' recurs without max_triggers and can never satisfy phase_completed; use first_fill or add max_triggers`,
          });
        }
      }
    }
    if (phase.price_anchor) {
      if (!phase.depends_on.includes(phase.price_anchor.phase_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases", index, "price_anchor", "phase_id"],
          message: "price_anchor.phase_id must also appear in depends_on",
        });
      }
      if (phase.price_trigger.type !== "relative_change" && phase.price_trigger.type !== "trailing_stop") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases", index, "price_anchor"],
          message: "price_anchor is supported only by relative_change and trailing_stop triggers",
        });
      }
      if ("reference_price" in phase.price_trigger && phase.price_trigger.reference_price !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases", index, "price_trigger", "reference_price"],
          message: "do not set reference_price when price_anchor supplies it from a phase fill",
        });
      }
    }
    if (phase.price_trigger.type === "relative_change" && phase.price_trigger.reference_price === undefined && !phase.price_anchor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phases", index, "price_trigger", "reference_price"],
        message: "relative_change requires either reference_price or a phase_fill price_anchor",
      });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (phaseId: string): boolean => {
    if (visiting.has(phaseId)) return true;
    if (visited.has(phaseId)) return false;
    visiting.add(phaseId);
    const phase = phaseById.get(phaseId);
    if (phase?.depends_on.some((dependencyId) => phaseById.has(dependencyId) && visit(dependencyId))) return true;
    visiting.delete(phaseId);
    visited.add(phaseId);
    return false;
  };
  for (const [index, phase] of strategy.phases.entries()) {
    if (visit(phase.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["phases", index, "depends_on"], message: "phase dependencies must not contain a cycle" });
      break;
    }
  }
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
  return raw.trim().toUpperCase();
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
  const price = firstNum(src, ["price", "level", "target_price", "price_level"]);
  const referencePrice = firstNum(src, ["reference_price", "anchor_price"]);
  const threshold = firstNum(src, ["threshold", "rsi_threshold", "level"]);
  if (pct !== undefined) {
    out["pct"] = Math.abs(pct);
    if (!direction && pct < 0) direction = "down";
    if (!direction && pct > 0 && type === "rolling_change") direction = "up";
  }
  if (win !== undefined) out["window_minutes"] = win;
  if (price !== undefined) out["price"] = price;
  if (referencePrice !== undefined) out["reference_price"] = referencePrice;
  if (threshold !== undefined) {
    if (type === "absolute_threshold" && price === undefined) out["price"] = threshold;
    else out["threshold"] = threshold;
  }
  if (["up", "down", "above", "below", "bullish", "bearish"].includes(direction)) out["direction"] = direction;
  const timeframe = str(src["timeframe"] || src["time_frame"] || src["interval"]);
  if (timeframe) out["timeframe"] = timeframe;
  const period = firstNum(src, ["period", "rsi_period"]);
  const fastPeriod = firstNum(src, ["fast_period", "fast"]);
  const slowPeriod = firstNum(src, ["slow_period", "slow"]);
  const signalPeriod = firstNum(src, ["signal_period", "signal"]);
  if (period !== undefined) out["period"] = period;
  if (fastPeriod !== undefined) out["fast_period"] = fastPeriod;
  if (slowPeriod !== undefined) out["slow_period"] = slowPeriod;
  if (signalPeriod !== undefined) out["signal_period"] = signalPeriod;
  const averageType = str(src["average_type"] || src["ma_type"]).toLowerCase();
  if (averageType) out["average_type"] = averageType;
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
  const dependencies = Array.isArray(p["depends_on"])
    ? p["depends_on"].map(str).filter(Boolean)
    : [];
  const activateOn = str(p["activate_on"]).toLowerCase();
  const rawAnchor = asObj(p["price_anchor"]);
  const anchorPhaseId = str(rawAnchor["phase_id"]);
  const priceAnchor = str(rawAnchor["type"]).toLowerCase() === "phase_fill" && anchorPhaseId
    ? { type: "phase_fill", phase_id: anchorPhaseId }
    : undefined;
  const out: Record<string, unknown> = {
    id: str(p["id"]) || slug(name, `phase-${index + 1}`),
    name,
    status: dependencies.length > 0 ? "waiting" : "active",
    depends_on: dependencies,
    activate_on: activateOn === "first_fill" ? "first_fill" : "phase_completed",
    price_trigger: normalizeTrigger(p["price_trigger"]),
    action: normalizeAction(p["action"]),
    recurrence: normalizeRecurrence(p["recurrence"]),
  };
  if (priceAnchor) out["price_anchor"] = priceAnchor;
  const cancelGroup = str(p["cancel_group"]);
  if (cancelGroup) out["cancel_group"] = cancelGroup;
  return out;
}

export function normalizePriceStrategyInput(input: Record<string, unknown>): Record<string, unknown> {
  const rawPhases = Array.isArray(input["phases"]) ? input["phases"] : [];
  const out: Record<string, unknown> = {
    name: str(input["name"]) || "Price strategy",
    symbol: normalizeSymbol(str(input["symbol"])),
    phases: rawPhases.map(normalizePhase),
  };
  const mode = str(input["mode"]).toLowerCase();
  // Preserve an explicit unsupported mode so schema validation rejects it
  // instead of silently changing a requested live strategy into paper mode.
  out["mode"] = mode === "shadow" || mode === "live" ? mode : "paper";
  if (input["guardrails"] !== undefined) out["guardrails"] = input["guardrails"];
  return out;
}

function summarizeTrigger(t: StrategyPhase["price_trigger"]): string {
  switch (t.type) {
    case "rolling_change":
      return `${t.direction === "down" ? "drops" : "rises"} ${t.pct}% within ${t.window_minutes}m`;
    case "absolute_threshold":
      return `price ${t.direction === "down" ? "<" : ">"} ${t.price}`;
    case "trailing_stop":
      return `trailing ${t.direction === "down" ? "stop" : "rebound"} ${t.pct}%`;
    case "relative_change":
      return `${t.direction === "down" ? "falls" : "rises"} ${t.pct}% from its anchor`;
    case "rsi_threshold":
      return `${t.timeframe} RSI(${t.period}) ${t.direction === "below" ? "<" : ">"} ${t.threshold}`;
    case "macd_cross":
      return `${t.timeframe} MACD(${t.fast_period},${t.slow_period},${t.signal_period}) ${t.direction} cross`;
    case "moving_average_cross":
      return `${t.timeframe} ${t.average_type.toUpperCase()}(${t.fast_period},${t.slow_period}) ${t.direction} cross`;
  }
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
  const dependency = phase.depends_on.length > 0
    ? ` after ${phase.depends_on.join("+")} ${phase.activate_on === "first_fill" ? "fills" : "completes"}`
    : "";
  const oco = phase.cancel_group ? `, OCO ${phase.cancel_group}` : "";
  return `${phase.name}${dependency}: when ${symbol} ${summarizeTrigger(phase.price_trigger)}, ${phase.action.side} ${summarizeSize(phase, symbol)} (${phase.action.order_type}, ${phase.recurrence.mode}${oco})`;
}

export function summarizePriceStrategy(s: PriceStrategyDSL): string {
  const phaseText = s.phases.map((phase) => summarizeStrategyPhase(phase, s.symbol)).join("; ");
  return `${s.name} [${s.mode}] ${s.symbol}: ${phaseText}`;
}
