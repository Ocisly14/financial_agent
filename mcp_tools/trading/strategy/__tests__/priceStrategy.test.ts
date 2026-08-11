import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePriceStrategyInput, tryParsePriceStrategy } from "../priceStrategy.ts";

function candidate(symbol: string, mode?: string): Record<string, unknown> {
  return normalizePriceStrategyInput({
    name: "Dip entry",
    symbol,
    mode,
    phases: [{
      name: "Entry",
      price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 },
      action: { side: "BUY", size: { type: "fixed_quote_usd", value: 500 } },
      recurrence: { mode: "one_shot" },
    }],
  });
}

test("stock strategy accepts a US ticker and defaults to paper mode", () => {
  const parsed = tryParsePriceStrategy(candidate("aapl"));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.symbol, "AAPL");
    assert.equal(parsed.value.mode, "paper");
  }
});

test("stock strategy rejects non-equity pair symbols", () => {
  assert.equal(tryParsePriceStrategy(candidate("EURUSD")).ok, false);
});

test("live requests are rejected because no stock broker adapter exists", () => {
  assert.equal(tryParsePriceStrategy(candidate("MSFT", "live")).ok, false);
});

test("normalizes an RSI strategy phase with indicator parameters", () => {
  const input = candidate("NVDA");
  const phase = (input["phases"] as Record<string, unknown>[])[0]!;
  phase["price_trigger"] = {
    type: "rsi_threshold",
    direction: "below",
    threshold: 28,
    period: 10,
    timeframe: "30Min",
  };
  const parsed = tryParsePriceStrategy(input);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const trigger = parsed.value.phases[0]!.price_trigger;
    assert.equal(trigger.type, "rsi_threshold");
    if (trigger.type === "rsi_threshold") {
      assert.equal(trigger.threshold, 28);
      assert.equal(trigger.timeframe, "30Min");
    }
  }
});

test("normalizes dependent phases as waiting and validates a fill-relative trigger", () => {
  const input = normalizePriceStrategyInput({
    name: "Entry with exits",
    symbol: "AAPL",
    phases: [
      {
        id: "entry",
        name: "Entry",
        price_trigger: { type: "absolute_threshold", direction: "down", price: 180 },
        action: { side: "BUY", size: { type: "fixed_quote_usd", value: 500 } },
        recurrence: { mode: "one_shot" },
      },
      {
        id: "take-profit",
        name: "Take profit",
        depends_on: ["entry"],
        activate_on: "first_fill",
        price_anchor: { type: "phase_fill", phase_id: "entry" },
        cancel_group: "exit",
        price_trigger: { type: "relative_change", direction: "up", pct: 10 },
        action: { side: "SELL", size: { type: "pct_of_position", value: 100 } },
        recurrence: { mode: "one_shot" },
      },
    ],
  });
  const parsed = tryParsePriceStrategy(input);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.phases[0]!.status, "active");
    assert.equal(parsed.value.phases[1]!.status, "waiting");
    assert.deepEqual(parsed.value.phases[1]!.depends_on, ["entry"]);
  }
});

test("rejects unknown and cyclic phase dependencies", () => {
  const unknown = normalizePriceStrategyInput({
    name: "Unknown dependency",
    symbol: "MSFT",
    phases: [{
      id: "exit",
      name: "Exit",
      depends_on: ["missing"],
      price_trigger: { type: "absolute_threshold", direction: "up", price: 500 },
      action: { side: "SELL", size: { type: "pct_of_position", value: 100 } },
      recurrence: { mode: "one_shot" },
    }],
  });
  assert.equal(tryParsePriceStrategy(unknown).ok, false);

  const cycle = normalizePriceStrategyInput({
    name: "Cycle",
    symbol: "MSFT",
    phases: [
      { id: "a", name: "A", depends_on: ["b"], price_trigger: { type: "absolute_threshold", direction: "up", price: 500 }, action: { side: "BUY", size: { type: "fixed_base_qty", value: 1 } }, recurrence: { mode: "one_shot" } },
      { id: "b", name: "B", depends_on: ["a"], price_trigger: { type: "absolute_threshold", direction: "down", price: 400 }, action: { side: "SELL", size: { type: "fixed_base_qty", value: 1 } }, recurrence: { mode: "one_shot" } },
    ],
  });
  assert.equal(tryParsePriceStrategy(cycle).ok, false);
});
