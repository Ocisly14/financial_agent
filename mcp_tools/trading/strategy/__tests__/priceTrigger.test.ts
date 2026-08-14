import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePriceTrigger,
  priceTriggerSchema,
  type OhlcSample,
  type PriceTrigger,
} from "../priceTrigger.ts";

function samples(closes: number[]): OhlcSample[] {
  return closes.map((c, i) => ({ ts: i * 60_000, high: c, low: c, close: c }));
}

test("rolling_change down: fires on drawdown from window high (V-shape included)", () => {
  const buf = samples([100, 92, 98]);
  const trigger: PriceTrigger = { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10 };
  assert.equal(evaluatePriceTrigger(trigger, buf, 98).conditionMet, false);
  assert.equal(evaluatePriceTrigger(trigger, [...buf, { ts: 180000, high: 94, low: 94, close: 94 }], 94).conditionMet, true);
});

test("rolling_change uses window HIGH not endpoint (drawdown semantics)", () => {
  const buf = samples([100, 110, 104]);
  const trigger: PriceTrigger = { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10 };
  assert.equal(evaluatePriceTrigger(trigger, buf, 104).conditionMet, true);
});

test("rolling_change up: fires on rebound from window low", () => {
  const buf = samples([100, 90, 95]);
  const trigger: PriceTrigger = { type: "rolling_change", direction: "up", pct: 5, window_minutes: 10 };
  assert.equal(evaluatePriceTrigger(trigger, buf, 95).conditionMet, true);
});

test("absolute_threshold down: level comparison", () => {
  const trigger: PriceTrigger = { type: "absolute_threshold", direction: "down", price: 60000 };
  assert.equal(evaluatePriceTrigger(trigger, [], 59999).conditionMet, true);
  assert.equal(evaluatePriceTrigger(trigger, [], 60001).conditionMet, false);
});

test("relative_change measures movement from a fixed fill anchor", () => {
  const trigger: PriceTrigger = { type: "relative_change", direction: "up", pct: 10, reference_price: 100 };
  assert.equal(evaluatePriceTrigger(trigger, [], 109).conditionMet, false);
  const result = evaluatePriceTrigger(trigger, [], 111);
  assert.equal(result.conditionMet, true);
  assert.equal(result.observed?.["reference_price"], 100);
});

test("trailing_stop down: maintains high-water and fires on retrace", () => {
  const trigger: PriceTrigger = { type: "trailing_stop", direction: "down", pct: 10, reference_price: 150 };
  const r = evaluatePriceTrigger(trigger, [], 135);
  assert.equal(r.conditionMet, true);
  assert.equal(r.nextReferencePrice, 150);
});

test("trailing_stop down: raises anchor on new high, no fire", () => {
  const trigger: PriceTrigger = { type: "trailing_stop", direction: "down", pct: 10, reference_price: 150 };
  const r = evaluatePriceTrigger(trigger, [], 160);
  assert.equal(r.conditionMet, false);
  assert.equal(r.nextReferencePrice, 160);
});

test("RSI threshold fires when the configured timeframe series is oversold", () => {
  const trigger: PriceTrigger = {
    type: "rsi_threshold",
    direction: "below",
    threshold: 30,
    period: 3,
    timeframe: "15Min",
  };
  const result = evaluatePriceTrigger(trigger, samples([10, 9, 8, 7, 6]), 6);
  assert.equal(result.conditionMet, true);
  assert.equal(result.observed?.["rsi"], 0);
});

test("moving-average trigger requires a fresh bullish cross", () => {
  const trigger: PriceTrigger = {
    type: "moving_average_cross",
    direction: "bullish",
    average_type: "sma",
    fast_period: 2,
    slow_period: 3,
    timeframe: "1Day",
  };
  assert.equal(evaluatePriceTrigger(trigger, samples([10, 10, 10, 10, 8, 14]), 14).conditionMet, true);
  assert.equal(evaluatePriceTrigger(trigger, samples([10, 10, 10, 12, 13, 14]), 14).conditionMet, false);
});

test("MACD trigger detects bullish and bearish line crosses", () => {
  const bullish: PriceTrigger = {
    type: "macd_cross",
    direction: "bullish",
    fast_period: 2,
    slow_period: 4,
    signal_period: 2,
    timeframe: "1Day",
  };
  const bearish: PriceTrigger = { ...bullish, direction: "bearish" };
  assert.equal(evaluatePriceTrigger(bullish, samples([10, 9, 8, 7, 6, 5, 4, 12]), 12).conditionMet, true);
  assert.equal(evaluatePriceTrigger(bearish, samples([4, 5, 6, 7, 8, 9, 10, 2]), 2).conditionMet, true);
});

test("technical trigger schema applies defaults and validates timeframe/period ordering", () => {
  const parsed = priceTriggerSchema.parse({
    type: "macd_cross",
    direction: "bullish",
  });
  assert.equal(parsed.type, "macd_cross");
  if (parsed.type === "macd_cross") {
    assert.equal(parsed.fast_period, 12);
    assert.equal(parsed.slow_period, 26);
    assert.equal(parsed.signal_period, 9);
    assert.equal(parsed.timeframe, "1Day");
  }
  assert.equal(priceTriggerSchema.safeParse({
    type: "moving_average_cross",
    direction: "bullish",
    fast_period: 50,
    slow_period: 20,
  }).success, false);
  assert.equal(priceTriggerSchema.safeParse({
    type: "rsi_threshold",
    direction: "below",
    threshold: 30,
    timeframe: "2Day",
  }).success, false);
});
