import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJSON, computeIntentHash, deriveClientOrderId } from "../intentHash.ts";

test("canonicalJSON sorts keys recursively and is order-independent", () => {
  const a = canonicalJSON({ b: 1, a: { y: 2, x: 1 } });
  const b = canonicalJSON({ a: { x: 1, y: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"x":1,"y":2},"b":1}');
});

test("computeIntentHash is deterministic for equal subsets", () => {
  const h1 = computeIntentHash({ symbol: "BTCUSDT", side: "SELL", size: "0.1" });
  const h2 = computeIntentHash({ size: "0.1", symbol: "BTCUSDT", side: "SELL" });
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test("deriveClientOrderId is venue-prefixed and within length limits", () => {
  const hash = computeIntentHash({ symbol: "BTCUSDT", side: "SELL", n: 1 });
  const bn = deriveClientOrderId(hash, "binance");
  const cb = deriveClientOrderId(hash, "coinbase");
  assert.match(bn, /^bn-[a-z2-7]+$/);
  assert.match(cb, /^cb-[a-z2-7]+$/);
  assert.ok(bn.length <= 36 && cb.length <= 36);
  assert.equal(bn, deriveClientOrderId(hash, "binance"));
});
