import test from "node:test";
import assert from "node:assert/strict";
import { scoreIndicators } from "../score.ts";

test("price above both averages with a positive histogram scores a clean uptrend", () => {
  const result = scoreIndicators({
    price: 120,
    sma50: 110,
    sma200: 100,
    rsi: 60,
    macdHistogram: 1.2,
    atrPercent: 2,
  });

  assert.equal(result.trend, 2);
  assert.equal(result.momentum, 1);
  assert.equal(result.volatility, "normal");
  assert.ok(result.evidence.some((line) => line.includes("sma50")));
});

test("price below both averages with a negative histogram scores a clean downtrend", () => {
  const result = scoreIndicators({
    price: 90,
    sma50: 100,
    sma200: 110,
    rsi: 35,
    macdHistogram: -0.8,
  });

  assert.equal(result.trend, -2);
  assert.equal(result.momentum, -1);
});

test("an overbought RSI is reported as a dimension, not turned into a sell signal", () => {
  const result = scoreIndicators({ rsi: 82 });
  assert.equal(result.momentum, 2);
  assert.ok(result.evidence.some((line) => /82/.test(line)));
  assert.ok(!result.evidence.some((line) => /sell|buy/i.test(line)));
});

test("missing inputs score zero and say what was missing", () => {
  const result = scoreIndicators({});
  assert.equal(result.trend, 0);
  assert.equal(result.momentum, 0);
  assert.equal(result.volatility, "unknown");
  assert.ok(result.evidence.some((line) => /no /i.test(line)));
});

test("volatility is banded by ATR as a percentage of price", () => {
  assert.equal(scoreIndicators({ atrPercent: 0.8 }).volatility, "low");
  assert.equal(scoreIndicators({ atrPercent: 2.5 }).volatility, "normal");
  assert.equal(scoreIndicators({ atrPercent: 6 }).volatility, "high");
});

test("a positive macd histogram pulls a negative rsi-derived momentum toward zero", () => {
  const result = scoreIndicators({ rsi: 35, macdHistogram: 0.5 });
  assert.equal(result.momentum, 0);
});

test("a negative macd histogram pulls a positive rsi-derived momentum toward zero", () => {
  const result = scoreIndicators({ rsi: 60, macdHistogram: -0.5 });
  assert.equal(result.momentum, 0);
});
