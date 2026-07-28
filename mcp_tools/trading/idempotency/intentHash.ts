import { createHash } from "node:crypto";

const BINANCE_MAX_LEN = 36;
const COINBASE_MAX_LEN = 36;

/**
 * Stable JSON serializer: object keys sorted recursively; undefined values
 * dropped; arrays kept in order. Determinism is the entire point — do not
 * swap to JSON.stringify, which preserves insertion order.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) out[key] = normalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Hash a plain, already-projected intent subset. Caller decides which fields matter. */
export function computeIntentHash(subset: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJSON(subset)).digest("hex");
}

/**
 * Derive a venue-safe client_order_id from a sha256 hex hash.
 * 26-char base32 prefix (130 bits) fits both venues' 36-char limits.
 */
export function deriveClientOrderId(hash: string, venue: "binance" | "coinbase" | "paper"): string {
  const buf = Buffer.from(hash, "hex");
  const base32 = encodeBase32Lower(buf).slice(0, 26);
  const prefix = venue === "binance" ? "bn" : venue === "coinbase" ? "cb" : "px";
  const id = `${prefix}-${base32}`;
  const max = venue === "binance" ? BINANCE_MAX_LEN : COINBASE_MAX_LEN;
  return id.slice(0, max);
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function encodeBase32Lower(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  return out;
}
