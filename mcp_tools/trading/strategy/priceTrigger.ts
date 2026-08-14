import { z } from "zod";
import { ema, macd, rsi, sma } from "../../technical/indicators.ts";
import { parseTechnicalTimeframe } from "../../technical/stockTechnicalData.ts";

const timeframe = z.string().default("1Day").refine(
  (value) => parseTechnicalTimeframe(value) !== undefined,
  "use 1Day or a 1-390 minute/hour timeframe such as 15Min, 1h, or 4Hour",
);

const rollingChangeTriggerSchema = z.object({
  type: z.literal("rolling_change"),
  direction: z.enum(["up", "down"]),
  pct: z.number().positive(),
  window_minutes: z.number().int().min(1).max(10080),
});

const absoluteThresholdTriggerSchema = z.object({
  type: z.literal("absolute_threshold"),
  direction: z.enum(["up", "down"]),
  price: z.number().positive(),
});

const trailingStopTriggerSchema = z.object({
  type: z.literal("trailing_stop"),
  direction: z.enum(["up", "down"]),
  pct: z.number().positive(),
  reference_price: z.number().positive().optional(),
});

const relativeChangeTriggerSchema = z.object({
  type: z.literal("relative_change"),
  direction: z.enum(["up", "down"]),
  pct: z.number().positive(),
  reference_price: z.number().positive().optional(),
});

const rsiThresholdTriggerSchema = z.object({
  type: z.literal("rsi_threshold"),
  direction: z.enum(["above", "below"]),
  threshold: z.number().min(0).max(100),
  period: z.number().int().min(2).max(100).default(14),
  timeframe,
});

const macdCrossTriggerSchema = z.object({
  type: z.literal("macd_cross"),
  direction: z.enum(["bullish", "bearish"]),
  fast_period: z.number().int().min(2).max(200).default(12),
  slow_period: z.number().int().min(3).max(500).default(26),
  signal_period: z.number().int().min(2).max(100).default(9),
  timeframe,
}).superRefine((trigger, context) => {
  if (trigger.fast_period >= trigger.slow_period) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fast_period must be smaller than slow_period",
      path: ["fast_period"],
    });
  }
});

const movingAverageCrossTriggerSchema = z.object({
  type: z.literal("moving_average_cross"),
  direction: z.enum(["bullish", "bearish"]),
  average_type: z.enum(["sma", "ema"]).default("sma"),
  fast_period: z.number().int().min(2).max(200).default(20),
  slow_period: z.number().int().min(3).max(500).default(50),
  timeframe,
}).superRefine((trigger, context) => {
  if (trigger.fast_period >= trigger.slow_period) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fast_period must be smaller than slow_period",
      path: ["fast_period"],
    });
  }
});

export const priceTriggerSchema = z.union([
  rollingChangeTriggerSchema,
  absoluteThresholdTriggerSchema,
  trailingStopTriggerSchema,
  relativeChangeTriggerSchema,
  rsiThresholdTriggerSchema,
  macdCrossTriggerSchema,
  movingAverageCrossTriggerSchema,
]);

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
  ts: number;
  high: number;
  low: number;
  close: number;
}

export interface TriggerEvaluation {
  conditionMet: boolean;
  nextReferencePrice?: number;
  observed?: Record<string, number | string>;
}

function crossed(
  previousLeft: number,
  previousRight: number,
  currentLeft: number,
  currentRight: number,
  direction: "bullish" | "bearish",
): boolean {
  return direction === "bullish"
    ? previousLeft <= previousRight && currentLeft > currentRight
    : previousLeft >= previousRight && currentLeft < currentRight;
}

/** Pure evaluation against already time-aligned OHLC samples. */
export function evaluatePriceTrigger(
  trigger: PriceTrigger,
  buffer: OhlcSample[],
  currentPrice: number,
): TriggerEvaluation {
  switch (trigger.type) {
    case "absolute_threshold":
      return {
        conditionMet: trigger.direction === "down" ? currentPrice < trigger.price : currentPrice > trigger.price,
        observed: { price: currentPrice, threshold: trigger.price },
      };
    case "rolling_change": {
      if (trigger.direction === "down") {
        const high = Math.max(currentPrice, ...buffer.map((sample) => sample.high));
        const changePct = high > 0 ? ((high - currentPrice) / high) * 100 : 0;
        return { conditionMet: changePct >= trigger.pct, observed: { change_pct: changePct } };
      }
      const low = Math.min(currentPrice, ...buffer.map((sample) => sample.low));
      const changePct = low > 0 ? ((currentPrice - low) / low) * 100 : 0;
      return { conditionMet: changePct >= trigger.pct, observed: { change_pct: changePct } };
    }
    case "relative_change": {
      const referencePrice = trigger.reference_price;
      if (referencePrice === undefined) return { conditionMet: false };
      const changePct = trigger.direction === "down"
        ? ((referencePrice - currentPrice) / referencePrice) * 100
        : ((currentPrice - referencePrice) / referencePrice) * 100;
      return {
        conditionMet: changePct >= trigger.pct,
        observed: { change_pct: changePct, reference_price: referencePrice },
      };
    }
    case "trailing_stop": {
      if (trigger.direction === "down") {
        const anchor = Math.max(trigger.reference_price ?? currentPrice, currentPrice);
        const retracePct = anchor > 0 ? ((anchor - currentPrice) / anchor) * 100 : 0;
        return {
          conditionMet: retracePct >= trigger.pct,
          nextReferencePrice: anchor,
          observed: { retrace_pct: retracePct, reference_price: anchor },
        };
      }
      const anchor = Math.min(trigger.reference_price ?? currentPrice, currentPrice);
      const reboundPct = anchor > 0 ? ((currentPrice - anchor) / anchor) * 100 : 0;
      return {
        conditionMet: reboundPct >= trigger.pct,
        nextReferencePrice: anchor,
        observed: { rebound_pct: reboundPct, reference_price: anchor },
      };
    }
    case "rsi_threshold": {
      const value = rsi(buffer.map((sample) => sample.close), trigger.period).at(-1);
      if (value === undefined) return { conditionMet: false };
      return {
        conditionMet: trigger.direction === "below" ? value < trigger.threshold : value > trigger.threshold,
        observed: { rsi: value, threshold: trigger.threshold },
      };
    }
    case "macd_cross": {
      const values = macd(
        buffer.map((sample) => sample.close),
        trigger.fast_period,
        trigger.slow_period,
        trigger.signal_period,
      );
      if (values.signal.length < 2) return { conditionMet: false };
      const macdOffset = values.macd.length - values.signal.length;
      const lastSignal = values.signal.length - 1;
      const previousSignal = lastSignal - 1;
      const previousMacd = values.macd[macdOffset + previousSignal]!;
      const currentMacd = values.macd[macdOffset + lastSignal]!;
      return {
        conditionMet: crossed(
          previousMacd,
          values.signal[previousSignal]!,
          currentMacd,
          values.signal[lastSignal]!,
          trigger.direction,
        ),
        observed: { macd: currentMacd, signal: values.signal[lastSignal]! },
      };
    }
    case "moving_average_cross": {
      const closes = buffer.map((sample) => sample.close);
      const calculate = trigger.average_type === "ema" ? ema : sma;
      const fast = calculate(closes, trigger.fast_period);
      const slow = calculate(closes, trigger.slow_period);
      if (slow.length < 2) return { conditionMet: false };
      const offset = fast.length - slow.length;
      const current = slow.length - 1;
      const previous = current - 1;
      return {
        conditionMet: crossed(
          fast[offset + previous]!,
          slow[previous]!,
          fast[offset + current]!,
          slow[current]!,
          trigger.direction,
        ),
        observed: { fast_average: fast[offset + current]!, slow_average: slow[current]! },
      };
    }
  }
}

export function isTechnicalTrigger(trigger: PriceTrigger): boolean {
  return trigger.type === "rsi_threshold" || trigger.type === "macd_cross" || trigger.type === "moving_average_cross";
}

export function technicalTriggerHistoryBars(trigger: PriceTrigger): number {
  if (trigger.type === "rsi_threshold") return Math.max(60, trigger.period * 4);
  if (trigger.type === "macd_cross") return Math.max(100, (trigger.slow_period + trigger.signal_period) * 3);
  if (trigger.type === "moving_average_cross") return Math.max(100, trigger.slow_period * 3);
  return 0;
}
