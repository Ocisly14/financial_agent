import { test } from "node:test";
import assert from "node:assert/strict";
import { confusion, recall, precision, accuracy, pct } from "../metrics.ts";

test("confusion counts tp/fp/tn/fn", () => {
  const c = confusion([
    { predicted: true, actual: true },   // tp
    { predicted: true, actual: false },  // fp
    { predicted: false, actual: false }, // tn
    { predicted: false, actual: true },  // fn
  ]);
  assert.deepEqual(c, { tp: 1, fp: 1, tn: 1, fn: 1 });
});

test("recall and precision compute correctly, default to 1 on empty", () => {
  assert.equal(recall({ tp: 3, fn: 1 }), 0.75);
  assert.equal(precision({ tp: 3, fp: 1 }), 0.75);
  assert.equal(recall({ tp: 0, fn: 0 }), 1);
  assert.equal(precision({ tp: 0, fp: 0 }), 1);
});

test("accuracy and pct format", () => {
  assert.equal(accuracy(9, 10), 0.9);
  assert.equal(accuracy(0, 0), 1);
  assert.equal(pct(0.923), "92%");
  assert.equal(pct(1), "100%");
});
