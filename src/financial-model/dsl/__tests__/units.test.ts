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

test("a bare number joins a rate under * and / but never under + or -", () => {
  // This asymmetry is what the fade recipes turn on, and formulas.md §0 states it as a table. It is
  // asserted here so the file and the engine cannot drift: the doc used to say "`number` is
  // transparent" without qualification, an agent wrote the decay fade it implied —
  // `0.08 + 0.04 * POW(0.8, YEAR_INDEX())` — and the batch died on `cannot apply '+' to number and
  // ratio`, on the second-to-last step of its budget.
  assert.equal(combine(t(num, 0.08), "+", t(ratio)), null, "the refusal the recipe hit");
  assert.equal(combine(t(ratio), "+", t(num, 0.08)), null, "and it is symmetric");
  assert.equal(combine(t(num, 0.08), "-", t(ratio)), null);

  // Scaling stays free, which is why `g_0 * POW(...)` is legal and decays toward zero.
  assert.deepEqual(combine(t(num, 0.04), "*", t(ratio)), ratio);
  assert.deepEqual(combine(t(ratio), "/", t(num, 2)), ratio);

  // Referencing a rate-typed row for the target is the way to decay toward a non-zero value.
  assert.deepEqual(combine(t(ratio), "+", t(ratio)), ratio);
  assert.deepEqual(combine(t(pct), "+", t(ratio)), ratio);

  // The linear fade is all numbers — YEAR_INDEX() is a number — so it needs no such row.
  assert.deepEqual(combine(t(num, 0.12), "+", t(num, 0.03)), num);
  assert.equal(assignableTo(t(num, 0.12), ratio), true, "and a number result still fits a ratio row");
});
