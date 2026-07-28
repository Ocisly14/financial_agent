import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCase, scoreMultiCase, type GoldDsl, type GoldMultiDsl } from "../nlDsl.ts";

const gold: GoldDsl = {
  tool: "cex_create_strategy", trigger_type: "rolling_change", direction: "down",
  pct: 5, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 200,
  symbol: "BTCUSDT", recurrence_mode: "one_shot",
};

test("intentMatch true only when all critical fields match", () => {
  const phases = [{ price_trigger: { type: "rolling_change", direction: "down", pct: 5 },
    action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }];
  const generated = { tool: "cex_create_strategy", input: { symbol: "BTC", phases } };
  const r = scoreCase(generated, gold);
  assert.equal(r.toolMatch, true);
  assert.equal(r.intentMatch, true);
});

test("intentMatch false when direction is wrong", () => {
  const phases = [{ price_trigger: { type: "rolling_change", direction: "up", pct: 5 },
    action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }];
  const generated = { tool: "cex_create_strategy", input: { symbol: "BTC", phases } };
  assert.equal(scoreCase(generated, gold).intentMatch, false);
});

test("null generation scores as total miss", () => {
  const r = scoreCase(null, gold);
  assert.equal(r.toolMatch, false);
  assert.equal(r.intentMatch, false);
});

// ── multi-phase scorer ────────────────────────────────────────────────────────
const multiGold: GoldMultiDsl = {
  tool: "cex_create_strategy", symbol: "BTCUSDT",
  phases: [
    { trigger_type: "rolling_change", direction: "down", pct: 5, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 200, recurrence_mode: "one_shot" },
    { trigger_type: "rolling_change", direction: "down", pct: 10, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 300, recurrence_mode: "one_shot" },
  ],
  guardrails: { total_budget_usd: 500 },
};

test("multi: all phases + guardrails correct → intentMatch, order-independent", () => {
  // generated phases in REVERSED order vs gold + correct guardrails
  const input = {
    symbol: "BTC",
    guardrails: { total_budget_usd: 500 },
    phases: [
      { price_trigger: { type: "rolling_change", direction: "down", pct: 10 }, action: { side: "BUY", quote_size: 300 }, recurrence: { mode: "one_shot" } },
      { price_trigger: { type: "rolling_change", direction: "down", pct: 5 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } },
    ],
  };
  const r = scoreMultiCase({ tool: "cex_create_strategy", input }, multiGold);
  assert.equal(r.phasesMatched, 2);
  assert.equal(r.phaseCountMatch, true);
  assert.equal(r.guardrailsMatch, true);
  assert.equal(r.intentMatch, true);
});

test("multi: missing a phase → not intentMatch", () => {
  const input = {
    symbol: "BTC", guardrails: { total_budget_usd: 500 },
    phases: [{ price_trigger: { type: "rolling_change", direction: "down", pct: 5 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }],
  };
  const r = scoreMultiCase({ tool: "cex_create_strategy", input }, multiGold);
  assert.equal(r.phaseCountMatch, false);
  assert.equal(r.phasesMatched, 1);
  assert.equal(r.intentMatch, false);
});

test("multi: checks window_minutes, order_type, max_slippage_bps and mode when gold pins them", () => {
  const goldRich: GoldMultiDsl = {
    tool: "cex_create_strategy", symbol: "ETHUSDT", mode: "live",
    phases: [{ trigger_type: "rolling_change", direction: "down", pct: 6, window_minutes: 60, side: "BUY",
      sizing_kind: "fixed_quote_usd", sizing_value: 300, order_type: "marketable_limit", max_slippage_bps: 30, recurrence_mode: "one_shot" }],
  };
  const good = { tool: "cex_create_strategy", input: { symbol: "ETH", mode: "live", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 6, window_minutes: 60 },
      action: { side: "BUY", quote_size: 300, order_type: "limit", max_slippage_bps: 30 }, recurrence: { mode: "one_shot" } }] } };
  assert.equal(scoreMultiCase(good, goldRich).intentMatch, true); // "limit" normalizes to marketable_limit

  const wrongWindow = { tool: "cex_create_strategy", input: { symbol: "ETH", mode: "live", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 6, window_minutes: 30 },
      action: { side: "BUY", quote_size: 300, order_type: "limit", max_slippage_bps: 30 }, recurrence: { mode: "one_shot" } }] } };
  assert.equal(scoreMultiCase(wrongWindow, goldRich).intentMatch, false);

  const wrongMode = { tool: "cex_create_strategy", input: { symbol: "ETH", mode: "paper", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 6, window_minutes: 60 },
      action: { side: "BUY", quote_size: 300, order_type: "limit", max_slippage_bps: 30 }, recurrence: { mode: "one_shot" } }] } };
  const r = scoreMultiCase(wrongMode, goldRich);
  assert.equal(r.modeMatch, false);
  assert.equal(r.intentMatch, false);
});

test("multi: checks confirm_samples and reanchor when gold pins them", () => {
  const goldCs: GoldMultiDsl = {
    tool: "cex_create_strategy", symbol: "BTCUSDT",
    phases: [{ trigger_type: "rolling_change", direction: "down", pct: 5, window_minutes: 60, side: "BUY",
      sizing_kind: "fixed_quote_usd", sizing_value: 200, confirm_samples: 3, recurrence_mode: "one_shot" }],
  };
  const hit = { tool: "cex_create_strategy", input: { symbol: "BTC", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60, confirm_samples: 3 },
      action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }] } };
  assert.equal(scoreMultiCase(hit, goldCs).intentMatch, true);
  // model leaves confirm_samples at the default 2 → miss
  const miss = { tool: "cex_create_strategy", input: { symbol: "BTC", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 },
      action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }] } };
  assert.equal(scoreMultiCase(miss, goldCs).intentMatch, false);

  const goldReanchor: GoldMultiDsl = {
    tool: "cex_create_strategy", symbol: "BTCUSDT",
    phases: [{ trigger_type: "rolling_change", direction: "down", pct: 5, window_minutes: 60, side: "BUY",
      sizing_kind: "fixed_quote_usd", sizing_value: 100, recurrence_mode: "recurring", max_triggers: 3, reanchor: true }],
  };
  const reHit = { tool: "cex_create_strategy", input: { symbol: "BTC", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 },
      action: { side: "BUY", quote_size: 100 }, recurrence: { mode: "recurring", max_triggers: 3, reanchor: true } }] } };
  assert.equal(scoreMultiCase(reHit, goldReanchor).intentMatch, true);
});

test("multi: wrong guardrail budget → not intentMatch even if phases match", () => {
  const input = {
    symbol: "BTC", guardrails: { total_budget_usd: 999 },
    phases: [
      { price_trigger: { type: "rolling_change", direction: "down", pct: 5 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } },
      { price_trigger: { type: "rolling_change", direction: "down", pct: 10 }, action: { side: "BUY", quote_size: 300 }, recurrence: { mode: "one_shot" } },
    ],
  };
  const r = scoreMultiCase({ tool: "cex_create_strategy", input }, multiGold);
  assert.equal(r.phasesMatched, 2);
  assert.equal(r.guardrailsMatch, false);
  assert.equal(r.intentMatch, false);
});
