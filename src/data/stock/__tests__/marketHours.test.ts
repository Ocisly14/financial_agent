import { test } from "node:test";
import assert from "node:assert/strict";
import { marketSession, etDateString } from "../marketHours.ts";

// 2026-07-28 是周二。EDT = UTC-4。
test("盘中时段", () => {
  assert.equal(marketSession(new Date("2026-07-28T14:00:00Z")), "regular"); // 10:00 ET
  assert.equal(marketSession(new Date("2026-07-28T13:30:00Z")), "regular"); // 09:30 ET 开盘
  assert.equal(marketSession(new Date("2026-07-28T19:59:00Z")), "regular"); // 15:59 ET
});

test("盘前时段", () => {
  assert.equal(marketSession(new Date("2026-07-28T08:00:00Z")), "pre-market"); // 04:00 ET
  assert.equal(marketSession(new Date("2026-07-28T13:29:00Z")), "pre-market"); // 09:29 ET
});

test("盘后时段", () => {
  assert.equal(marketSession(new Date("2026-07-28T20:00:00Z")), "after-hours"); // 16:00 ET
  assert.equal(marketSession(new Date("2026-07-28T23:59:00Z")), "after-hours"); // 19:59 ET
});

test("非交易时段与周末", () => {
  assert.equal(marketSession(new Date("2026-07-28T05:00:00Z")), "closed");     // 01:00 ET 周二
  assert.equal(marketSession(new Date("2026-07-25T14:00:00Z")), "closed");     // 周六
  assert.equal(marketSession(new Date("2026-07-26T14:00:00Z")), "closed");     // 周日
});

test("冬令时 EST = UTC-5", () => {
  // 2026-01-06 周二，14:00 UTC = 09:00 ET，尚未开盘
  assert.equal(marketSession(new Date("2026-01-06T14:00:00Z")), "pre-market");
  assert.equal(marketSession(new Date("2026-01-06T15:00:00Z")), "regular"); // 10:00 ET
});

test("etDateString 返回美东日历日", () => {
  assert.equal(etDateString(new Date("2026-07-28T14:00:00Z")), "2026-07-28");
  // 02:00 UTC 周三 = 22:00 ET 周二
  assert.equal(etDateString(new Date("2026-07-29T02:00:00Z")), "2026-07-28");
});
