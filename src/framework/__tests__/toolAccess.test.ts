import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForAgent, assertToolAllowedForAgent } from "../toolAccess.ts";

test("trade agent maps to trading, others to non_trading", () => {
  assert.equal(categoryForAgent("trade"), "trading");
  assert.equal(categoryForAgent("onchain_data"), "non_trading");
  assert.equal(categoryForAgent("news_research"), "non_trading");
});

test("assert throws when a non-trade agent requests a trading tool", () => {
  assert.throws(() => assertToolAllowedForAgent("news_research", "cex_create_order", "trading"), /not allowed for news_research/);
  assert.doesNotThrow(() => assertToolAllowedForAgent("trade", "cex_create_order", "trading"));
  assert.doesNotThrow(() => assertToolAllowedForAgent("news_research", "web_search", "non_trading"));
});
