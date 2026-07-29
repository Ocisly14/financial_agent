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

test("stock strategy rejects crypto pair symbols", () => {
  assert.equal(tryParsePriceStrategy(candidate("BTCUSDT")).ok, false);
});

test("live requests are rejected because no stock broker adapter exists", () => {
  assert.equal(tryParsePriceStrategy(candidate("MSFT", "live")).ok, false);
});
