import { test } from "node:test";
import assert from "node:assert/strict";
import { withLiveCandle } from "../stockChart.ts";

const MINUTE = Date.parse("2026-08-14T14:00:00Z");
const bar = (t: number, o: number, h: number, l: number, c: number, v = 10) => ({
  t: new Date(t).toISOString(), o, h, l, c, v,
});

test("the streamed price becomes the forming candle's close", () => {
  const candles = [bar(MINUTE - 60_000, 99, 100, 98, 99.5), bar(MINUTE, 99.5, 100.5, 99, 100)];
  const next = withLiveCandle(candles, 101, MINUTE + 30_000, "1Min");

  assert.equal(next.length, 2);
  assert.equal(next.at(-1)?.c, 101);
});

test("a price above the forming candle extends its high", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  const next = withLiveCandle(candles, 102, MINUTE + 30_000, "1Min");

  assert.equal(next.at(-1)?.h, 102);
  assert.equal(next.at(-1)?.l, 99, "the low is untouched");
});

test("a price below the forming candle extends its low", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  const next = withLiveCandle(candles, 98, MINUTE + 30_000, "1Min");

  assert.equal(next.at(-1)?.l, 98);
  assert.equal(next.at(-1)?.h, 100.5);
});

test("a price inside the forming candle's range moves only the close", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  const next = withLiveCandle(candles, 99.8, MINUTE + 30_000, "1Min");

  assert.equal(next.at(-1)?.h, 100.5);
  assert.equal(next.at(-1)?.l, 99);
  assert.equal(next.at(-1)?.c, 99.8);
});

test("the candle's open is never rewritten", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  const next = withLiveCandle(candles, 102, MINUTE + 30_000, "1Min");

  assert.equal(next.at(-1)?.o, 99.5);
});

test("a price in the next minute opens a new candle", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  const next = withLiveCandle(candles, 101, MINUTE + 61_000, "1Min");

  assert.equal(next.length, 2);
  assert.deepEqual(
    { o: next.at(-1)?.o, h: next.at(-1)?.h, l: next.at(-1)?.l, c: next.at(-1)?.c, v: next.at(-1)?.v },
    { o: 101, h: 101, l: 101, c: 101, v: 0 },
    "a synthesized candle has no volume of its own",
  );
  assert.equal(next.at(-1)?.t, new Date(MINUTE + 60_000).toISOString(), "aligned to the bucket, not the tick");
});

test("a five-minute chart keeps a price two minutes later in the same candle", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  const next = withLiveCandle(candles, 101, MINUTE + 120_000, "5Min");

  assert.equal(next.length, 1);
  assert.equal(next.at(-1)?.c, 101);
});

test("a five-minute chart opens a new candle once the bucket rolls", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  const next = withLiveCandle(candles, 101, MINUTE + 320_000, "5Min");

  assert.equal(next.length, 2);
  assert.equal(next.at(-1)?.t, new Date(MINUTE + 300_000).toISOString());
});

test("a daily chart updates today's candle but never invents tomorrow's", () => {
  const daily = [{ t: "2026-08-14", o: 99.5, h: 100.5, l: 99, c: 100, v: 1_000 }];
  const next = withLiveCandle(daily, 102, Date.parse("2026-08-15T14:00:00Z"), "1Day");

  assert.equal(next.length, 1, "a new session's bar is the server's to declare");
  assert.equal(next.at(-1)?.c, 102);
  assert.equal(next.at(-1)?.h, 102);
});

test("without a price the candles are returned untouched", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  assert.equal(withLiveCandle(candles, null, MINUTE, "1Min"), candles);
});

test("an empty series stays empty", () => {
  const candles: ReturnType<typeof bar>[] = [];
  assert.equal(withLiveCandle(candles, 101, MINUTE, "1Min"), candles);
});

test("a tick older than the forming candle is ignored", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  assert.equal(withLiveCandle(candles, 102, MINUTE - 5_000, "1Min"), candles);
});

test("an unknown timeframe leaves the series alone rather than guessing a bucket", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  assert.equal(withLiveCandle(candles, 102, MINUTE + 30_000, undefined), candles);
});

test("the input array and its candles are not mutated", () => {
  const candles = [bar(MINUTE, 99.5, 100.5, 99, 100)];
  withLiveCandle(candles, 102, MINUTE + 30_000, "1Min");

  assert.equal(candles.length, 1);
  assert.equal(candles[0]!.c, 100);
  assert.equal(candles[0]!.h, 100.5);
});
