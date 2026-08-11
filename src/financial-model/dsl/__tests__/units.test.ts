import { test } from "node:test";
import assert from "node:assert/strict";
import { assignableTo, combine, commonUnit, sameUnit, type UnitTerm } from "../units.ts";
import type { Unit } from "../../types.ts";

const usd: Unit = { kind: "currency", code: "USD" };
const eur: Unit = { kind: "currency", code: "EUR" };
const pct: Unit = { kind: "percent" };
const ratio: Unit = { kind: "ratio" };
const num: Unit = { kind: "number" };
const shares: Unit = { kind: "shares" };
const t = (unit: Unit, literal?: number): UnitTerm => literal === undefined ? { unit } : { unit, literal };

test("currency addition requires the same currency code", () => {
  assert.deepEqual(combine(t(usd), "+", t(usd)), usd);
  assert.equal(combine(t(usd), "+", t(eur)), null);
});

test("currency scaled by a rate stays currency", () => {
  assert.deepEqual(combine(t(usd), "*", t(pct)), usd);
  assert.deepEqual(combine(t(usd), "*", t(num)), usd);
  assert.deepEqual(combine(t(usd), "/", t(ratio)), usd);
});

test("currency over currency is a ratio; currency over shares is per-share", () => {
  assert.deepEqual(combine(t(usd), "/", t(usd)), ratio);
  assert.equal(combine(t(usd), "/", t(eur)), null);
  assert.deepEqual(combine(t(usd), "/", t(shares)), { kind: "per_share", code: "USD" });
});

test("currency plus percent is rejected", () => {
  assert.equal(combine(t(usd), "+", t(pct)), null);
});

test("dimensionless semantics are preserved", () => {
  assert.deepEqual(combine(t(pct), "+", t(pct)), pct);
  assert.deepEqual(combine(t(pct), "+", t(ratio)), ratio);
  assert.deepEqual(combine(t(pct), "*", t(num)), pct);
  assert.deepEqual(combine(t(pct), "*", t(ratio)), ratio);
});

test("literal zero is polymorphic but arbitrary numbers are not", () => {
  assert.deepEqual(combine(t(num, 0), "+", t(usd)), usd);
  assert.equal(combine(t(num, 10), "+", t(pct)), null);
  assert.equal(assignableTo(t(num, 0), usd), true);
  assert.equal(assignableTo(t(num, 10), usd), false);
});

test("MIN and MAX require a common unit without polymorphic-zero fallback", () => {
  assert.deepEqual(commonUnit(pct, ratio), ratio);
  assert.deepEqual(commonUnit(usd, usd), usd);
  assert.equal(commonUnit(usd, num), null);
});

test("literal one is the dimensionless identity for growth and tax formulas", () => {
  assert.deepEqual(combine(t(num, 1), "+", t(pct)), ratio);
  assert.deepEqual(combine(t(num, 1), "-", t(pct)), ratio);
});

test("sameUnit compares currency codes, not just kinds", () => {
  assert.equal(sameUnit(usd, usd), true);
  assert.equal(sameUnit(usd, eur), false);
  assert.equal(sameUnit(pct, ratio), false);
});
