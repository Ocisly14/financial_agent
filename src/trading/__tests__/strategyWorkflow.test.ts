import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePriceStrategyInput, parsePriceStrategy } from "../../../mcp_tools/trading/strategy/priceStrategy.ts";
import type { StoredStrategy } from "../persistence/strategyStore.ts";
import { activateEligiblePhases, cancelOcoPeers, nextStrategyStatus, recordPhaseFill } from "../strategyWorkflow.ts";

function workflowStrategy(): StoredStrategy {
  const dsl = parsePriceStrategy(normalizePriceStrategyInput({
    name: "Entry with OCO exits",
    symbol: "AAPL",
    phases: [
      { id: "entry", name: "Entry", price_trigger: { type: "absolute_threshold", direction: "down", price: 180 }, action: { side: "BUY", size: { type: "fixed_quote_usd", value: 500 } }, recurrence: { mode: "one_shot" } },
      { id: "take-profit", name: "Take profit", depends_on: ["entry"], activate_on: "first_fill", price_anchor: { type: "phase_fill", phase_id: "entry" }, cancel_group: "exit", price_trigger: { type: "relative_change", direction: "up", pct: 10 }, action: { side: "SELL", size: { type: "pct_of_position", value: 100 } }, recurrence: { mode: "one_shot" } },
      { id: "stop-loss", name: "Stop loss", depends_on: ["entry"], activate_on: "first_fill", price_anchor: { type: "phase_fill", phase_id: "entry" }, cancel_group: "exit", price_trigger: { type: "trailing_stop", direction: "down", pct: 8 }, action: { side: "SELL", size: { type: "pct_of_position", value: 100 } }, recurrence: { mode: "one_shot" } },
    ],
  }));
  return { id: "strategy-1", owner: "test", symbol: "AAPL", status: "active", created_at: new Date(0).toISOString(), dsl };
}

test("a predecessor fill activates dependent phases and seeds their price anchors", () => {
  const strategy = workflowStrategy();
  const entry = strategy.dsl.phases[0]!;
  entry.status = "completed";
  recordPhaseFill(entry, { execution_id: "fill-entry", price: 100, quantity: 5, side: "BUY", at: new Date(0).toISOString() });

  assert.deepEqual(activateEligiblePhases(strategy), ["take-profit", "stop-loss"]);
  assert.equal(strategy.dsl.phases[1]!.status, "active");
  const takeProfitTrigger = strategy.dsl.phases[1]!.price_trigger;
  const stopLossTrigger = strategy.dsl.phases[2]!.price_trigger;
  assert.equal(takeProfitTrigger.type, "relative_change");
  assert.equal(stopLossTrigger.type, "trailing_stop");
  if (takeProfitTrigger.type === "relative_change") assert.equal(takeProfitTrigger.reference_price, 100);
  if (stopLossTrigger.type === "trailing_stop") assert.equal(stopLossTrigger.reference_price, 100);
});

test("a filled OCO exit cancels its peer", () => {
  const strategy = workflowStrategy();
  const entry = strategy.dsl.phases[0]!;
  entry.status = "completed";
  recordPhaseFill(entry, { execution_id: "fill-entry", price: 100, quantity: 5, side: "BUY", at: new Date(0).toISOString() });
  activateEligiblePhases(strategy);
  const takeProfit = strategy.dsl.phases[1]!;
  takeProfit.status = "completed";

  assert.deepEqual(cancelOcoPeers(strategy, takeProfit), ["stop-loss"]);
  assert.equal(strategy.dsl.phases[2]!.status, "cancelled");
  assert.equal(nextStrategyStatus(strategy), "completed");
});
