import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStreamedPrice } from "../stockChart.ts";

const TS = Date.parse("2026-08-14T14:00:01Z");

function response(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL",
    quote: {
      price: 100, prevClose: 80, changePercent: 25,
      bidPrice: 99.9, askPrice: 100.1,
      dayOpen: 98, dayHigh: 101, dayLow: 97, volume: 1_000,
      quoteTimestamp: "2026-08-14T14:00:00Z",
      ...overrides,
    },
    session: "regular", range: "none", staleness: null,
    dataSource: "Alpaca (IEX feed)", fetchedAtMs: Date.parse("2026-08-14T14:00:00Z"),
  };
}

test("the streamed price replaces the quoted price", () => {
  const next = applyStreamedPrice(response(), 120, TS);
  assert.equal(next?.quote?.price, 120);
});

test("the change percent is recomputed against the previous close", () => {
  const next = applyStreamedPrice(response(), 120, TS);
  assert.equal(next?.quote?.changePercent, 50);
});

test("the quote timestamp advances to the streamed sample", () => {
  const next = applyStreamedPrice(response(), 120, TS);
  assert.equal(next?.quote?.quoteTimestamp, new Date(TS).toISOString());
});

test("daily aggregates are left to the REST payload that owns them", () => {
  const next = applyStreamedPrice(response(), 120, TS);
  assert.equal(next?.quote?.dayOpen, 98);
  assert.equal(next?.quote?.prevClose, 80);
  assert.equal(next?.quote?.volume, 1_000);
  assert.equal(next?.session, "regular");
});

test("the day range widens when the streamed price runs past it", () => {
  const next = applyStreamedPrice(response(), 120, TS);
  assert.equal(next?.quote?.dayHigh, 120, "a new high is visible before the next REST poll");
  const lower = applyStreamedPrice(response(), 90, TS);
  assert.equal(lower?.quote?.dayLow, 90);
});

test("a price inside the day's range leaves the high and low where they were", () => {
  // The day high is a running maximum, not the latest print: a tick below it must not lower it.
  const next = applyStreamedPrice(response(), 99, TS);
  assert.equal(next?.quote?.dayHigh, 101);
  assert.equal(next?.quote?.dayLow, 97);
});

test("change percent stays null when there is no previous close to compare with", () => {
  const next = applyStreamedPrice(response({ prevClose: null }), 120, TS);
  assert.equal(next?.quote?.changePercent, null);
});

test("nothing to patch yet: an absent payload is returned unchanged", () => {
  assert.equal(applyStreamedPrice(undefined, 120, TS), undefined);
});

test("a payload whose quote never loaded is left alone", () => {
  const empty = { ...response(), quote: null };
  assert.equal(applyStreamedPrice(empty, 120, TS), empty);
});

test("the original object is not mutated", () => {
  const original = response();
  applyStreamedPrice(original, 120, TS);
  assert.equal(original.quote?.price, 100);
});
