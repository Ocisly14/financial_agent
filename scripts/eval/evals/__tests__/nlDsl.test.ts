import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCase, scoreMultiCase, type GoldDsl, type GoldMultiDsl } from "../nlDsl.ts";

const gold: GoldDsl = {
  tool: "create_strategy", trigger_type: "rolling_change", direction: "down",
  pct: 5, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 200,
  symbol: "AAPL", recurrence_mode: "one_shot",
};

test("intentMatch true only when all critical fields match", () => {
  const phases = [{ price_trigger: { type: "rolling_change", direction: "down", pct: 5 },
    action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }];
  const generated = { tool: "create_strategy", input: { symbol: "AAPL", phases } };
  const r = scoreCase(generated, gold);
  assert.equal(r.toolMatch, true);
  assert.equal(r.intentMatch, true);
});

test("intentMatch false when direction is wrong", () => {
  const phases = [{ price_trigger: { type: "rolling_change", direction: "up", pct: 5 },
    action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }];
  const generated = { tool: "create_strategy", input: { symbol: "AAPL", phases } };
  assert.equal(scoreCase(generated, gold).intentMatch, false);
});

test("null generation scores as total miss", () => {
  const r = scoreCase(null, gold);
  assert.equal(r.toolMatch, false);
  assert.equal(r.intentMatch, false);
});

// ── multi-phase scorer ────────────────────────────────────────────────────────
const multiGold: GoldMultiDsl = {
  tool: "create_strategy", symbol: "AAPL",
  phases: [
    { trigger_type: "rolling_change", direction: "down", pct: 5, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 200, recurrence_mode: "one_shot" },
    { trigger_type: "rolling_change", direction: "down", pct: 10, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 300, recurrence_mode: "one_shot" },
  ],
  guardrails: { total_budget_usd: 500 },
};

test("multi: all phases + guardrails correct → intentMatch, order-independent", () => {
  // generated phases in REVERSED order vs gold + correct guardrails
  const input = {
    symbol: "AAPL",
    guardrails: { total_budget_usd: 500 },
    phases: [
      { price_trigger: { type: "rolling_change", direction: "down", pct: 10 }, action: { side: "BUY", quote_size: 300 }, recurrence: { mode: "one_shot" } },
      { price_trigger: { type: "rolling_change", direction: "down", pct: 5 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } },
    ],
  };
  const r = scoreMultiCase({ tool: "create_strategy", input }, multiGold);
  assert.equal(r.phasesMatched, 2);
  assert.equal(r.phaseCountMatch, true);
  assert.equal(r.guardrailsMatch, true);
  assert.equal(r.intentMatch, true);
});

test("multi: missing a phase → not intentMatch", () => {
  const input = {
    symbol: "AAPL", guardrails: { total_budget_usd: 500 },
    phases: [{ price_trigger: { type: "rolling_change", direction: "down", pct: 5 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }],
  };
  const r = scoreMultiCase({ tool: "create_strategy", input }, multiGold);
  assert.equal(r.phaseCountMatch, false);
  assert.equal(r.phasesMatched, 1);
  assert.equal(r.intentMatch, false);
});

test("multi: checks window_minutes, order_type, max_slippage_bps and mode when gold pins them", () => {
  const goldRich: GoldMultiDsl = {
    tool: "create_strategy", symbol: "MSFT", mode: "shadow",
    phases: [{ trigger_type: "rolling_change", direction: "down", pct: 6, window_minutes: 60, side: "BUY",
      sizing_kind: "fixed_quote_usd", sizing_value: 300, order_type: "marketable_limit", max_slippage_bps: 30, recurrence_mode: "one_shot" }],
  };
  const good = { tool: "create_strategy", input: { symbol: "MSFT", mode: "shadow", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 6, window_minutes: 60 },
      action: { side: "BUY", quote_size: 300, order_type: "limit", max_slippage_bps: 30 }, recurrence: { mode: "one_shot" } }] } };
  assert.equal(scoreMultiCase(good, goldRich).intentMatch, true); // "limit" normalizes to marketable_limit

  const wrongWindow = { tool: "create_strategy", input: { symbol: "MSFT", mode: "shadow", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 6, window_minutes: 30 },
      action: { side: "BUY", quote_size: 300, order_type: "limit", max_slippage_bps: 30 }, recurrence: { mode: "one_shot" } }] } };
  assert.equal(scoreMultiCase(wrongWindow, goldRich).intentMatch, false);

  const wrongMode = { tool: "create_strategy", input: { symbol: "MSFT", mode: "paper", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 6, window_minutes: 60 },
      action: { side: "BUY", quote_size: 300, order_type: "limit", max_slippage_bps: 30 }, recurrence: { mode: "one_shot" } }] } };
  const r = scoreMultiCase(wrongMode, goldRich);
  assert.equal(r.modeMatch, false);
  assert.equal(r.intentMatch, false);
});

test("multi: checks reanchor when gold pins it", () => {
  const goldReanchor: GoldMultiDsl = {
    tool: "create_strategy", symbol: "AAPL",
    phases: [{ trigger_type: "rolling_change", direction: "down", pct: 5, window_minutes: 60, side: "BUY",
      sizing_kind: "fixed_quote_usd", sizing_value: 100, recurrence_mode: "recurring", max_triggers: 3, reanchor: true }],
  };
  const reHit = { tool: "create_strategy", input: { symbol: "AAPL", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 },
      action: { side: "BUY", quote_size: 100 }, recurrence: { mode: "recurring", max_triggers: 3, reanchor: true } }] } };
  assert.equal(scoreMultiCase(reHit, goldReanchor).intentMatch, true);

  const reMiss = { tool: "create_strategy", input: { symbol: "AAPL", phases: [
    { price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 },
      action: { side: "BUY", quote_size: 100 }, recurrence: { mode: "recurring", max_triggers: 3 } }] } };
  assert.equal(scoreMultiCase(reMiss, goldReanchor).intentMatch, false);
});

test("multi: wrong guardrail budget → not intentMatch even if phases match", () => {
  const input = {
    symbol: "AAPL", guardrails: { total_budget_usd: 999 },
    phases: [
      { price_trigger: { type: "rolling_change", direction: "down", pct: 5 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } },
      { price_trigger: { type: "rolling_change", direction: "down", pct: 10 }, action: { side: "BUY", quote_size: 300 }, recurrence: { mode: "one_shot" } },
    ],
  };
  const r = scoreMultiCase({ tool: "create_strategy", input }, multiGold);
  assert.equal(r.phasesMatched, 2);
  assert.equal(r.guardrailsMatch, false);
  assert.equal(r.intentMatch, false);
});

test("multi: checks workflow dependencies, fill anchors and OCO groups", () => {
  const workflowGold: GoldMultiDsl = {
    tool: "create_strategy",
    symbol: "AAPL",
    phases: [
      { id: "entry", depends_on: [], trigger_type: "absolute_threshold", direction: "down", price: 180, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 500, recurrence_mode: "one_shot" },
      { id: "take-profit", depends_on: ["entry"], activate_on: "first_fill", price_anchor_phase_id: "entry", cancel_group: "exit", trigger_type: "relative_change", direction: "up", pct: 10, side: "SELL", sizing_kind: "pct_of_position", sizing_value: 100, recurrence_mode: "one_shot" },
    ],
  };
  const good = { tool: "create_strategy", input: { symbol: "AAPL", phases: [
    { id: "model-entry-id", name: "Entry", depends_on: [], price_trigger: { type: "absolute_threshold", direction: "down", price: 180 }, action: { side: "BUY", size: { type: "fixed_quote_usd", value: 500 } }, recurrence: { mode: "one_shot" } },
    { id: "model-profit-id", name: "Take profit", depends_on: ["model-entry-id"], activate_on: "first_fill", price_anchor: { type: "phase_fill", phase_id: "model-entry-id" }, cancel_group: "model-exit-group", price_trigger: { type: "relative_change", direction: "up", pct: 10 }, action: { side: "SELL", size: { type: "pct_of_position", value: 100 } }, recurrence: { mode: "one_shot" } },
  ] } };
  assert.equal(scoreMultiCase(good, workflowGold).intentMatch, true);

  const missingDependency = structuredClone(good);
  delete (missingDependency.input.phases[1] as Record<string, unknown>)["depends_on"];
  assert.equal(scoreMultiCase(missingDependency, workflowGold).intentMatch, false);
});
