import { test } from "node:test";
import assert from "node:assert/strict";
import { quantityFromSize } from "../strategyExecutor.ts";

const ctx = { positionQty: 2, portfolioUsd: 10_000 };

test("fixed_base_qty returns the value directly", () => {
  assert.equal(quantityFromSize({ type: "fixed_base_qty", value: 0.5 }, 60_000, ctx).qty, 0.5);
});

test("fixed_quote_usd divides by current price", () => {
  assert.equal(quantityFromSize({ type: "fixed_quote_usd", value: 600 }, 60_000, ctx).qty, 0.01);
});

test("pct_of_position is a fraction of held quantity", () => {
  assert.equal(quantityFromSize({ type: "pct_of_position", value: 50 }, 60_000, ctx).qty, 1);
});

test("pct_of_portfolio: notional = portfolio*pct, qty = notional/price", () => {
  // 25% of $10,000 = $2,500 notional; at $50,000 → 0.05 base
  assert.equal(quantityFromSize({ type: "pct_of_portfolio", value: 25 }, 50_000, ctx).qty, 0.05);
});

test("pct_of_portfolio with no portfolio value is skipped with a reason", () => {
  const r = quantityFromSize({ type: "pct_of_portfolio", value: 25 }, 50_000, { positionQty: 0, portfolioUsd: 0 });
  assert.equal(r.qty, 0);
  assert.match(r.reason ?? "", /portfolio value unavailable/);
});
