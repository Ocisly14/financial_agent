import { test } from "node:test";
import assert from "node:assert/strict";
import { stepConfirmation, type ConfirmState } from "../confirmation.ts";

test("fires only after N consecutive met samples", () => {
  let s: ConfirmState = { count: 0 };
  let r = stepConfirmation(s, true, 2);
  assert.equal(r.fired, false);            // 1st met
  r = stepConfirmation(r.state, true, 2);
  assert.equal(r.fired, true);             // 2nd met → fire
});

test("a single wick (one met sample) does not fire with confirm=2", () => {
  let r = stepConfirmation({ count: 0 }, true, 2);
  assert.equal(r.fired, false);
  r = stepConfirmation(r.state, false, 2); // wick recovers
  assert.equal(r.fired, false);
  assert.equal(r.state.count, 0);          // counter reset
});

test("confirm=1 fires immediately", () => {
  assert.equal(stepConfirmation({ count: 0 }, true, 1).fired, true);
});
