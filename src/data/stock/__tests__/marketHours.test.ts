import { test } from "node:test";
import assert from "node:assert/strict";
import { marketSession, etDateString } from "../marketHours.ts";

// 2026-07-28 is a Tuesday. EDT = UTC-4.
test("regular session", () => {
  assert.equal(marketSession(new Date("2026-07-28T14:00:00Z")), "regular"); // 10:00 ET
  assert.equal(marketSession(new Date("2026-07-28T13:30:00Z")), "regular"); // 09:30 ET, market open
  assert.equal(marketSession(new Date("2026-07-28T19:59:00Z")), "regular"); // 15:59 ET
});

test("pre-market session", () => {
  assert.equal(marketSession(new Date("2026-07-28T08:00:00Z")), "pre-market"); // 04:00 ET
  assert.equal(marketSession(new Date("2026-07-28T13:29:00Z")), "pre-market"); // 09:29 ET
});

test("after-hours session", () => {
  assert.equal(marketSession(new Date("2026-07-28T20:00:00Z")), "after-hours"); // 16:00 ET
  assert.equal(marketSession(new Date("2026-07-28T23:59:00Z")), "after-hours"); // 19:59 ET
});

test("closed outside trading hours and on weekends", () => {
  assert.equal(marketSession(new Date("2026-07-28T05:00:00Z")), "closed");     // 01:00 ET Tuesday
  assert.equal(marketSession(new Date("2026-07-25T14:00:00Z")), "closed");     // Saturday
  assert.equal(marketSession(new Date("2026-07-26T14:00:00Z")), "closed");     // Sunday
});

test("standard time EST = UTC-5", () => {
  // 2026-01-06 is a Tuesday; 14:00 UTC = 09:00 ET, market not yet open
  assert.equal(marketSession(new Date("2026-01-06T14:00:00Z")), "pre-market");
  assert.equal(marketSession(new Date("2026-01-06T15:00:00Z")), "regular"); // 10:00 ET
});

test("etDateString returns the Eastern-time calendar date", () => {
  assert.equal(etDateString(new Date("2026-07-28T14:00:00Z")), "2026-07-28");
  // 02:00 UTC Wednesday = 22:00 ET Tuesday
  assert.equal(etDateString(new Date("2026-07-29T02:00:00Z")), "2026-07-28");
});
