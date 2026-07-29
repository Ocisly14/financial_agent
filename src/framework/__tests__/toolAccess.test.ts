import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForAgent, assertToolAllowedForAgent } from "../toolAccess.ts";

test("trade agent maps to trading, others to non_trading", () => {
  assert.equal(categoryForAgent("trading_operations"), "trading");
  assert.equal(categoryForAgent("market_data"), "non_trading");
  assert.equal(categoryForAgent("market_research"), "non_trading");
});

test("assert throws when a non-trade agent requests a trading tool", () => {
  assert.throws(() => assertToolAllowedForAgent("market_research", "cex_create_order", "trading"), /not allowed for market_research/);
  assert.doesNotThrow(() => assertToolAllowedForAgent("trading_operations", "cex_create_order", "trading"));
  assert.doesNotThrow(() => assertToolAllowedForAgent("market_research", "web_search", "non_trading"));
});
