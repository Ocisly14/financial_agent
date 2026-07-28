import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePriceTrigger, type OhlcSample, type PriceTrigger } from "../priceTrigger.ts";

function samples(closes: number[]): OhlcSample[] {
  return closes.map((c, i) => ({ ts: i * 60_000, high: c, low: c, close: c }));
}

test("rolling_change down: fires on drawdown from window high (V-shape included)", () => {
  const buf = samples([100, 92, 98]);
  const trigger: PriceTrigger = { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 1 };
  assert.equal(evaluatePriceTrigger(trigger, buf, 98).conditionMet, false);
  assert.equal(evaluatePriceTrigger(trigger, [...buf, { ts: 180000, high: 94, low: 94, close: 94 }], 94).conditionMet, true);
});

test("rolling_change uses window HIGH not endpoint (drawdown semantics)", () => {
  const buf = samples([100, 110, 104]);
  const trigger: PriceTrigger = { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 1 };
  assert.equal(evaluatePriceTrigger(trigger, buf, 104).conditionMet, true);
});

test("rolling_change up: fires on rebound from window low", () => {
  const buf = samples([100, 90, 95]);
  const trigger: PriceTrigger = { type: "rolling_change", direction: "up", pct: 5, window_minutes: 10, confirm_samples: 1 };
  assert.equal(evaluatePriceTrigger(trigger, buf, 95).conditionMet, true);
});

test("absolute_threshold down: level comparison", () => {
  const trigger: PriceTrigger = { type: "absolute_threshold", direction: "down", price: 60000, confirm_samples: 1 };
  assert.equal(evaluatePriceTrigger(trigger, [], 59999).conditionMet, true);
  assert.equal(evaluatePriceTrigger(trigger, [], 60001).conditionMet, false);
});

test("trailing_stop down: maintains high-water and fires on retrace", () => {
  const trigger: PriceTrigger = { type: "trailing_stop", direction: "down", pct: 10, reference_price: 150, confirm_samples: 1 };
  const r = evaluatePriceTrigger(trigger, [], 135);
  assert.equal(r.conditionMet, true);
  assert.equal(r.nextReferencePrice, 150);
});

test("trailing_stop down: raises anchor on new high, no fire", () => {
  const trigger: PriceTrigger = { type: "trailing_stop", direction: "down", pct: 10, reference_price: 150, confirm_samples: 1 };
  const r = evaluatePriceTrigger(trigger, [], 160);
  assert.equal(r.conditionMet, false);
  assert.equal(r.nextReferencePrice, 160);
});
