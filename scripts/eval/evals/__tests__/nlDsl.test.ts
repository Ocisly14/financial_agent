import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCase, scoreMultiCase, type GoldDsl, type GoldMultiDsl } from "../nlDsl.ts";

const gold: GoldDsl = {
  tool: "create_strategy", trigger_type: "rolling_change", direction: "down",
  pct: 5, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 200,
  symbol: "AAPL", recurrence_mode: "one_shot",
};

test("intentMatch true only when all critical fields match", () => {
  const phases = [{ price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 },
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
    { trigger_type: "rolling_change", direction: "down", pct: 5, window_minutes: 60, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 200, recurrence_mode: "one_shot" },
    { trigger_type: "rolling_change", direction: "down", pct: 10, window_minutes: 120, side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 300, recurrence_mode: "one_shot" },
  ],
  guardrails: { total_budget_usd: 500 },
};

test("multi: all phases + guardrails correct → intentMatch, order-independent", () => {
  // generated phases in REVERSED order vs gold + correct guardrails
  const input = {
    symbol: "AAPL",
    guardrails: { total_budget_usd: 500 },
    phases: [
      { price_trigger: { type: "rolling_change", direction: "down", pct: 10, window_minutes: 120 }, action: { side: "BUY", quote_size: 300 }, recurrence: { mode: "one_shot" } },
      { price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } },
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
    phases: [{ price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } }],
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
      { price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 }, action: { side: "BUY", quote_size: 200 }, recurrence: { mode: "one_shot" } },
      { price_trigger: { type: "rolling_change", direction: "down", pct: 10, window_minutes: 120 }, action: { side: "BUY", quote_size: 300 }, recurrence: { mode: "one_shot" } },
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

// ── indicator triggers ────────────────────────────────────────────────────────
// The three stock-native triggers carry their own parameters. Scoring them by
// pct/price alone would pass a plan transcribed onto the wrong period, the wrong
// timeframe, or the wrong average type.

test("multi: RSI threshold, period and timeframe are all checked", () => {
  const goldRsi: GoldMultiDsl = {
    tool: "create_strategy", symbol: "AAPL",
    phases: [{ trigger_type: "rsi_threshold", direction: "below", threshold: 30, period: 14, timeframe: "1Day",
      side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 5000, recurrence_mode: "one_shot" }],
  };
  const phase = (trigger: Record<string, unknown>) => ({ tool: "create_strategy", input: { symbol: "AAPL", phases: [
    { price_trigger: trigger, action: { side: "BUY", size: { type: "fixed_quote_usd", value: 5000 } }, recurrence: { mode: "one_shot" } }] } });

  assert.equal(scoreMultiCase(phase({ type: "rsi_threshold", direction: "below", threshold: 30, period: 14, timeframe: "1Day" }), goldRsi).intentMatch, true);
  assert.equal(scoreMultiCase(phase({ type: "rsi_threshold", direction: "below", threshold: 35, period: 14, timeframe: "1Day" }), goldRsi).intentMatch, false);
  assert.equal(scoreMultiCase(phase({ type: "rsi_threshold", direction: "below", threshold: 30, period: 21, timeframe: "1Day" }), goldRsi).intentMatch, false);
  assert.equal(scoreMultiCase(phase({ type: "rsi_threshold", direction: "below", threshold: 30, period: 14, timeframe: "1h" }), goldRsi).intentMatch, false);
});

test("multi: MACD and moving-average periods and average type are checked", () => {
  const goldMacd: GoldMultiDsl = {
    tool: "create_strategy", symbol: "SPY",
    phases: [{ trigger_type: "macd_cross", direction: "bullish", fast_period: 12, slow_period: 26, signal_period: 9, timeframe: "4Hour",
      side: "BUY", sizing_kind: "pct_of_portfolio", sizing_value: 5, recurrence_mode: "one_shot" }],
  };
  const macd = (trigger: Record<string, unknown>) => ({ tool: "create_strategy", input: { symbol: "SPY", phases: [
    { price_trigger: trigger, action: { side: "BUY", size: { type: "pct_of_portfolio", value: 5 } }, recurrence: { mode: "one_shot" } }] } });
  assert.equal(scoreMultiCase(macd({ type: "macd_cross", direction: "bullish", fast_period: 12, slow_period: 26, signal_period: 9, timeframe: "4Hour" }), goldMacd).intentMatch, true);
  assert.equal(scoreMultiCase(macd({ type: "macd_cross", direction: "bearish", fast_period: 12, slow_period: 26, signal_period: 9, timeframe: "4Hour" }), goldMacd).intentMatch, false);
  assert.equal(scoreMultiCase(macd({ type: "macd_cross", direction: "bullish", fast_period: 8, slow_period: 26, signal_period: 9, timeframe: "4Hour" }), goldMacd).intentMatch, false);

  const goldMa: GoldMultiDsl = {
    tool: "create_strategy", symbol: "QQQ",
    phases: [{ trigger_type: "moving_average_cross", direction: "bullish", average_type: "ema", fast_period: 20, slow_period: 50, timeframe: "1Day",
      side: "BUY", sizing_kind: "fixed_base_qty", sizing_value: 40, recurrence_mode: "one_shot" }],
  };
  const ma = (trigger: Record<string, unknown>) => ({ tool: "create_strategy", input: { symbol: "QQQ", phases: [
    { price_trigger: trigger, action: { side: "BUY", size: { type: "fixed_base_qty", value: 40 } }, recurrence: { mode: "one_shot" } }] } });
  assert.equal(scoreMultiCase(ma({ type: "moving_average_cross", direction: "bullish", average_type: "ema", fast_period: 20, slow_period: 50, timeframe: "1Day" }), goldMa).intentMatch, true);
  assert.equal(scoreMultiCase(ma({ type: "moving_average_cross", direction: "bullish", average_type: "sma", fast_period: 20, slow_period: 50, timeframe: "1Day" }), goldMa).intentMatch, false);
});

test("single: an indicator threshold is scored, not silently skipped", () => {
  const goldRsi: GoldDsl = {
    tool: "create_strategy", trigger_type: "rsi_threshold", direction: "below", threshold: 30,
    side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 5000, symbol: "AAPL", recurrence_mode: "one_shot",
  };
  const call = (threshold: number) => ({ tool: "create_strategy", input: { symbol: "AAPL", phases: [
    { price_trigger: { type: "rsi_threshold", direction: "below", threshold, period: 14 },
      action: { side: "BUY", size: { type: "fixed_quote_usd", value: 5000 } }, recurrence: { mode: "one_shot" } }] } });

  assert.equal(scoreCase(call(30), goldRsi).intentMatch, true);
  assert.equal(scoreCase(call(40), goldRsi).intentMatch, false);
});

test("single: a rolling_change window is scored — the schema requires it, so dropping it is a failed transcription", () => {
  const goldWindowed: GoldDsl = {
    tool: "create_strategy", trigger_type: "rolling_change", direction: "down", pct: 3, window_minutes: 60,
    side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 5000, symbol: "AAPL", recurrence_mode: "one_shot",
  };
  const call = (trigger: Record<string, unknown>) => ({ tool: "create_strategy", input: { symbol: "AAPL", phases: [
    { price_trigger: trigger, action: { side: "BUY", size: { type: "fixed_quote_usd", value: 5000 } }, recurrence: { mode: "one_shot" } }] } });

  assert.equal(scoreCase(call({ type: "rolling_change", direction: "down", pct: 3, window_minutes: 60 }), goldWindowed).intentMatch, true);
  assert.equal(scoreCase(call({ type: "rolling_change", direction: "down", pct: 3, window_minutes: 30 }), goldWindowed).intentMatch, false);
  assert.equal(scoreCase(call({ type: "rolling_change", direction: "down", pct: 3 }), goldWindowed).intentMatch, false);
});

// ── Schema acceptance ─────────────────────────────────────────────────────────
// A transcription is only right if create_strategy would take it. These two cases
// carry every gold field and differ solely in whether the payload survives the tool.

const windowGold: GoldMultiDsl = {
  tool: "create_strategy", symbol: "AAPL",
  phases: [{ trigger_type: "rolling_change", direction: "down", pct: 5, window_minutes: 60,
    side: "BUY", sizing_kind: "fixed_quote_usd", sizing_value: 200, recurrence_mode: "one_shot" }],
};

test("multi: a schema-valid transcription passes", () => {
  const input = { symbol: "AAPL", phases: [{
    price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 },
    action: { side: "BUY", size: { type: "fixed_quote_usd", value: 200 } }, recurrence: { mode: "one_shot" } }] };
  const r = scoreMultiCase({ tool: "create_strategy", input }, windowGold);
  assert.equal(r.schemaValid, true);
  assert.deepEqual(r.schemaIssues, []);
  assert.equal(r.intentMatch, true);
});

test("multi: a payload create_strategy would reject never counts as an intent match", () => {
  // rolling_change with no window_minutes — the one omission the tool cannot absorb.
  const input = { symbol: "AAPL", phases: [{
    price_trigger: { type: "rolling_change", direction: "down", pct: 5 },
    action: { side: "BUY", size: { type: "fixed_quote_usd", value: 200 } }, recurrence: { mode: "one_shot" } }] };
  const r = scoreMultiCase({ tool: "create_strategy", input }, windowGold);
  assert.equal(r.schemaValid, false);
  assert.ok(r.schemaIssues.length > 0, "the rejection reason is reported, not just the verdict");
  assert.equal(r.intentMatch, false);
});

test("multi: an unparseable strategy still reports the fields it got right", () => {
  // A duplicate phase id is rejected by the schema's superRefine, not by any field check.
  const phase = {
    price_trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 60 },
    action: { side: "BUY", size: { type: "fixed_quote_usd", value: 200 } }, recurrence: { mode: "one_shot" } };
  const input = { symbol: "AAPL", phases: [{ ...phase, id: "same" }, { ...phase, id: "same" }] };
  const r = scoreMultiCase({ tool: "create_strategy", input }, {
    ...windowGold, phases: [windowGold.phases[0]!, windowGold.phases[0]!] });
  assert.equal(r.schemaValid, false);
  assert.equal(r.phasesMatched, 2, "the field-level diff still runs, so the report says what else was right");
  assert.equal(r.intentMatch, false);
});

test("multi: no tool call reports the miss as a schema failure too", () => {
  const r = scoreMultiCase(null, windowGold);
  assert.equal(r.schemaValid, false);
  assert.deepEqual(r.schemaIssues, ["no tool call generated"]);
});
