import { z } from "zod";

export const priceTriggerSchema = z
  .object({
    type: z.enum(["rolling_change", "absolute_threshold", "trailing_stop"]),
    direction: z.enum(["up", "down"]),
    pct: z.number().positive().optional(),
    window_minutes: z.number().int().min(1).max(10080).optional(),
    price: z.number().positive().optional(),
    reference_price: z.number().positive().optional(),
    confirm_samples: z.number().int().min(1).default(2),
  })
  .superRefine((t, ctx) => {
    if (t.type === "rolling_change") {
      if (t.pct === undefined)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rolling_change requires pct", path: ["pct"] });
      if (t.window_minutes === undefined)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rolling_change requires window_minutes", path: ["window_minutes"] });
    }
    if (t.type === "trailing_stop" && t.pct === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trailing_stop requires pct", path: ["pct"] });
    if (t.type === "absolute_threshold" && t.price === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "absolute_threshold requires price", path: ["price"] });
  });

export const actionSchema = z.object({
  side: z.enum(["BUY", "SELL"]),
  size: z.object({
    type: z.enum(["pct_of_position", "pct_of_portfolio", "fixed_quote_usd", "fixed_base_qty"]),
    value: z.number().positive(),
  }),
  order_type: z.enum(["market", "marketable_limit"]),
  max_slippage_bps: z.number().int().min(0).default(50),
});

export const recurrenceSchema = z.object({
  mode: z.enum(["one_shot", "recurring"]),
  cooldown_minutes: z.number().int().min(0).optional(),
  reanchor: z.boolean().default(false),
  max_triggers: z.number().int().min(1).optional(),
  trigger_count: z.number().int().min(0).default(0),
});

export type PriceTrigger = z.infer<typeof priceTriggerSchema>;
export type StrategyAction = z.infer<typeof actionSchema>;
export type StrategyRecurrence = z.infer<typeof recurrenceSchema>;

export interface OhlcSample {
  ts: number; // epoch ms
  high: number;
  low: number;
  close: number;
}

export interface TriggerEvaluation {
  conditionMet: boolean;
  /** For trailing_stop: the updated anchor to persist (caller writes it back). Undefined otherwise. */
  nextReferencePrice?: number;
}

/**
 * Pure evaluation of a single price trigger against the current price and the
 * recent OHLC buffer. Drawdown semantics for rolling_change (window high/low,
 * NOT endpoint-to-endpoint). Caller is responsible for confirm_samples gating
 * across successive calls and for persisting nextReferencePrice.
 */
export function evaluatePriceTrigger(
  trigger: PriceTrigger,
  buffer: OhlcSample[],
  currentPrice: number,
): TriggerEvaluation {
  switch (trigger.type) {
    case "absolute_threshold": {
      const met =
        trigger.direction === "down"
          ? currentPrice < (trigger.price ?? Infinity)
          : currentPrice > (trigger.price ?? -Infinity);
      return { conditionMet: met };
    }
    case "rolling_change": {
      const pct = trigger.pct ?? 0;
      if (trigger.direction === "down") {
        const high = Math.max(currentPrice, ...buffer.map((s) => s.high));
        const drawdown = high > 0 ? (high - currentPrice) / high : 0;
        return { conditionMet: drawdown >= pct / 100 };
      } else {
        const low = Math.min(currentPrice, ...buffer.map((s) => s.low));
        const rebound = low > 0 ? (currentPrice - low) / low : 0;
        return { conditionMet: rebound >= pct / 100 };
      }
    }
    case "trailing_stop": {
      const pct = trigger.pct ?? 0;
      const ref = trigger.reference_price;
      if (trigger.direction === "down") {
        const anchor = Math.max(ref ?? currentPrice, currentPrice);
        const retrace = anchor > 0 ? (anchor - currentPrice) / anchor : 0;
        return { conditionMet: retrace >= pct / 100, nextReferencePrice: anchor };
      } else {
        const anchor = Math.min(ref ?? currentPrice, currentPrice);
        const rebound = anchor > 0 ? (currentPrice - anchor) / anchor : 0;
        return { conditionMet: rebound >= pct / 100, nextReferencePrice: anchor };
      }
    }
  }
}
