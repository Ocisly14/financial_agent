import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStrategyDSL,
  tryParseStrategyDSL,
  summarizeStrategy,
  type StrategyDSL,
} from "../strategyDSL.ts";

function validStrategy(): unknown {
  return {
    identity: { id: "s1", version: 1, owner: "u1", status: "draft", mode: "paper" },
    universe: { venue: "binance", symbols: ["BTCUSDT"] },
    signals: [{ id: "rsi1", kind: "price.rsi", params: { period: 14 } }],
    entries: [{ id: "e1", when: { op: "lt", args: ["rsi1", 30] }, then: {
      order_type: "market", side: "BUY",
      sizing: { kind: "pct_equity", value: 10 }, time_in_force: "GTC",
    } }],
    exits: [{ id: "x1", when: { op: "gt", args: ["rsi1", 70] }, then: {
      order_type: "market", side: "SELL",
      sizing: { kind: "pct_equity", value: 100 }, time_in_force: "GTC",
    } }],
    risk: { max_position_notional_usd: 1000, max_daily_loss_usd: 200, max_concurrent_positions: 1, slippage_bps_max: 50 },
    operations: { evaluation_interval_seconds: 10, persistent: true, halt_on_error: true },
    resilience: { auto_kill_on_loss_limit: true, pause_on_stale_orders: 3, pause_on_market_data_lag_s: 30 },
  };
}

test("parseStrategyDSL accepts a valid strategy", () => {
  const s: StrategyDSL = parseStrategyDSL(validStrategy());
  assert.equal(s.identity.id, "s1");
  assert.equal(s.universe.symbols[0], "BTCUSDT");
});

test("tryParseStrategyDSL reports issues for missing required fields", () => {
  const bad = validStrategy() as Record<string, unknown>;
  delete bad.risk;
  const r = tryParseStrategyDSL(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.some((i) => i.startsWith("risk")));
});

test("summarizeStrategy returns a one-line summary", () => {
  const s = parseStrategyDSL(validStrategy());
  const line = summarizeStrategy(s);
  assert.match(line, /BTCUSDT/);
  assert.match(line, /max notional \$1000/);
});

test("parseStrategyDSL accepts a rolling_change price_trigger", () => {
  const base = validStrategy() as Record<string, unknown>;
  base.price_trigger = {
    type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 2,
  };
  base.action = {
    side: "SELL", size: { type: "pct_of_position", value: 10 }, order_type: "marketable_limit", max_slippage_bps: 50,
  };
  base.recurrence = { mode: "one_shot", reanchor: false, trigger_count: 0 };
  const s = parseStrategyDSL(base);
  assert.equal(s.price_trigger?.type, "rolling_change");
  assert.equal(s.action?.order_type, "marketable_limit");
});

test("price_trigger absolute_threshold with price is valid", () => {
  const base = validStrategy() as Record<string, unknown>;
  base.price_trigger = { type: "absolute_threshold", direction: "down", price: 60000 };
  const r = tryParseStrategyDSL(base);
  assert.equal(r.ok, true);
});

test("price_trigger rejects rolling_change missing pct", () => {
  const base = validStrategy() as Record<string, unknown>;
  base.price_trigger = { type: "rolling_change", direction: "down", window_minutes: 10 };
  const r = tryParseStrategyDSL(base);
  assert.equal(r.ok, false);
});
