# Auto-Trading Strategy — Plan 1: Foundation (DSL + Triggers + Idempotency) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the pure-logic foundation of the auto-trading strategy engine — a validated strategy DSL (ported from staging and extended with our price-trigger types), order-idempotency helpers, and the price-trigger evaluation functions — with zero I/O and full unit-test coverage.

**Architecture:** Port the zero-coupling logic files from `financial-agent/financial-agent-0428@staging` (`packages/plugin-cex/src/`) into `mcp_tools/trading/strategy/`, rewriting imports to financial-agent's ESM `.ts`-extension style. Extend the ported Zod DSL with a new `price_trigger` block covering `rolling_change` (drawdown semantics), `absolute_threshold`, and `trailing_stop`. Implement the trigger-evaluation math as pure functions over an in-memory OHLC sample array. No persistence, no network, no monitor loop — those are Plans 2–4.

**Tech Stack:** TypeScript (ESM, NodeNext, `target` ES2022), `zod` (new dependency) for schema validation, Node's built-in `node:test` + `node:assert/strict` for tests (no external test framework is installed).

**Source reference (port from):** local clone at `/tmp/financial-agent-probe` (branch `staging` of `financial-agent/financial-agent-0428`); if absent, re-clone with `git clone --depth 1 --branch staging https://github.com/financial-agent/financial-agent-0428.git /tmp/financial-agent-probe`.

**Spec:** `docs/superpowers/specs/2026-06-10-auto-trading-strategy-design.md` (§2 reuse list, §4 DSL extension, §5.2 trigger evaluation).

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | add `zod` dependency + a `test` script (node:test runner) |
| `mcp_tools/trading/strategy/strategyDSL.ts` | ported + extended Zod schema for a strategy; parse/summarize helpers |
| `mcp_tools/trading/strategy/priceTrigger.ts` | our extension: `PriceTrigger` types + pure evaluation functions |
| `mcp_tools/trading/idempotency/intentHash.ts` | `canonicalJSON`, `computeIntentHash`, `deriveClientOrderId` (decoupled port) |
| `mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts` | DSL parse/validate tests |
| `mcp_tools/trading/strategy/__tests__/priceTrigger.test.ts` | trigger-evaluation tests |
| `mcp_tools/trading/idempotency/__tests__/intentHash.test.ts` | idempotency tests |

Each file has one responsibility; tests live beside the code under `__tests__/`.

---

## Task 1: Project setup — zod dependency + test runner

**Files:**
- Modify: `package.json` (dependencies + scripts)
- Create: `mcp_tools/trading/strategy/__tests__/sanity.test.ts`

- [ ] **Step 1: Add the `zod` dependency (pin to v3)**

Run: `pnpm add zod@^3`
Expected: `zod` (a 3.x version) appears under `dependencies` in `package.json` and `pnpm-lock.yaml` updates.

IMPORTANT: pin to v3. The ported staging DSL uses zod v3 syntax — `z.record(z.union([...]))` (single value-schema arg) and `z.ZodIssueCode.custom`. zod v4 changed `z.record` to require two args (`z.record(keySchema, valueSchema)`) and reworked issue codes, which would break the verbatim port in Tasks 2–3. Do not install v4.

- [ ] **Step 2: Add a `test` script to package.json**

In `package.json`, inside the `"scripts"` object, add this entry (keep all existing scripts unchanged):

```json
"test": "node --env-file=.env --experimental-strip-types --test \"mcp_tools/**/__tests__/*.test.ts\""
```

Note: a single test file can be run directly with:
`node --experimental-strip-types --test mcp_tools/trading/strategy/__tests__/sanity.test.ts`

- [ ] **Step 3: Write a sanity test to prove the runner works**

Create `mcp_tools/trading/strategy/__tests__/sanity.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

test("test runner is wired up", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 4: Run the sanity test**

Run: `node --experimental-strip-types --test mcp_tools/trading/strategy/__tests__/sanity.test.ts`
Expected: PASS — output shows `# pass 1` and `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml mcp_tools/trading/strategy/__tests__/sanity.test.ts
git commit -m "chore: add zod dep and node:test runner for strategy engine"
```

---

## Task 2: Port the base strategy DSL

Port `packages/plugin-cex/src/strategy/strategyDSL.ts` verbatim except: it is already free of `@elizaos/core` imports, so only the `import { z } from "zod"` line stays. No relative imports to rewrite.

**Files:**
- Create: `mcp_tools/trading/strategy/strategyDSL.ts`
- Test: `mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts`

- [ ] **Step 1: Write failing tests for DSL parse/validate**

Create `mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStrategyDSL,
  tryParseStrategyDSL,
  summarizeStrategy,
  type StrategyDSL,
} from "../strategyDSL.ts";

function validStrategy(): unknown {
  return {
    identity: { id: "s1", version: 1, owner: "u1", status: "draft", mode: "paper" },
    universe: { venue: "binance", symbols: ["BTCUSDT"] },
    signals: [{ id: "rsi1", kind: "price.rsi", params: { period: 14 } }],
    entries: [{ id: "e1", when: { op: "lt", args: ["rsi1", 30] }, then: {
      order_type: "market", side: "BUY",
      sizing: { kind: "pct_equity", value: 10 }, time_in_force: "GTC",
    } }],
    exits: [{ id: "x1", when: { op: "gt", args: ["rsi1", 70] }, then: {
      order_type: "market", side: "SELL",
      sizing: { kind: "pct_equity", value: 100 }, time_in_force: "GTC",
    } }],
    risk: { max_position_notional_usd: 1000, max_daily_loss_usd: 200, max_concurrent_positions: 1, slippage_bps_max: 50 },
    operations: { evaluation_interval_seconds: 10, persistent: true, halt_on_error: true },
    resilience: { auto_kill_on_loss_limit: true, pause_on_stale_orders: 3, pause_on_market_data_lag_s: 30 },
  };
}

test("parseStrategyDSL accepts a valid strategy", () => {
  const s: StrategyDSL = parseStrategyDSL(validStrategy());
  assert.equal(s.identity.id, "s1");
  assert.equal(s.universe.symbols[0], "BTCUSDT");
});

test("tryParseStrategyDSL reports issues for missing required fields", () => {
  const bad = validStrategy() as Record<string, unknown>;
  delete bad.risk;
  const r = tryParseStrategyDSL(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.some((i) => i.startsWith("risk")));
});

test("summarizeStrategy returns a one-line summary", () => {
  const s = parseStrategyDSL(validStrategy());
  const line = summarizeStrategy(s);
  assert.match(line, /BTCUSDT/);
  assert.match(line, /max notional \$1000/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts`
Expected: FAIL — cannot resolve `../strategyDSL.ts` (module not found).

- [ ] **Step 3: Create the ported DSL file**

Create `mcp_tools/trading/strategy/strategyDSL.ts` with the full content below (ported from staging, unchanged logic):

```typescript
import { z } from "zod";

export type StrategyStatus = "draft" | "paper" | "shadow" | "live" | "retired";
export type StrategyMode = "paper" | "shadow" | "live";

const identitySchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  owner: z.string().min(1),
  status: z.enum(["draft", "paper", "shadow", "live", "retired"]),
  mode: z.enum(["paper", "shadow", "live"]).default("paper"),
  name: z.string().optional(),
  description: z.string().optional(),
});

const universeSchema = z.object({
  venue: z.enum(["binance", "coinbase", "paper"]),
  symbols: z.array(z.string().min(1)).min(1),
  expansion: z
    .object({ kind: z.enum(["fixed", "top_n_volume", "watchlist"]), n: z.number().int().min(1).optional() })
    .optional(),
});

const signalSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "price.rsi",
    "price.sma_cross",
    "price.ema_cross",
    "price.atr_band",
    "volume.zscore",
    "sentiment.score",
  ]),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});

const ruleSchema: z.ZodType<unknown> = z.object({
  op: z.enum(["lt", "lte", "gt", "gte", "eq", "and", "or", "not", "between"]),
  args: z.array(z.union([z.string(), z.number(), z.boolean(), z.lazy(() => ruleSchema)])),
});

const orderSpecSchema = z.object({
  order_type: z.enum(["market", "limit"]),
  side: z.enum(["BUY", "SELL"]),
  sizing: z.object({ kind: z.enum(["pct_equity", "quote_size", "base_size"]), value: z.number().positive() }),
  limit_offset_bps: z.number().optional(),
  time_in_force: z.enum(["GTC", "IOC", "FOK"]).default("GTC"),
});

const entrySchema = z.object({ id: z.string().min(1), when: ruleSchema, then: orderSpecSchema });
const exitSchema = z.object({ id: z.string().min(1), when: ruleSchema, then: orderSpecSchema });

const riskSchema = z.object({
  max_position_notional_usd: z.number().positive(),
  max_daily_loss_usd: z.number().positive(),
  max_concurrent_positions: z.number().int().min(1),
  per_trade_stop_loss_bps: z.number().int().min(1).optional(),
  per_trade_take_profit_bps: z.number().int().min(1).optional(),
  slippage_bps_max: z.number().int().min(0).default(50),
});

const operationsSchema = z.object({
  evaluation_interval_seconds: z.number().int().min(1),
  persistent: z.boolean().default(true),
  halt_on_error: z.boolean().default(true),
});

const resilienceSchema = z.object({
  auto_kill_on_loss_limit: z.boolean().default(true),
  pause_on_stale_orders: z.number().int().min(0).default(3),
  pause_on_market_data_lag_s: z.number().int().min(0).default(30),
});

export const strategyDSLSchema = z.object({
  identity: identitySchema,
  universe: universeSchema,
  signals: z.array(signalSchema).min(1),
  entries: z.array(entrySchema).min(1),
  exits: z.array(exitSchema).min(1),
  risk: riskSchema,
  operations: operationsSchema,
  resilience: resilienceSchema,
});

export type StrategyDSL = z.infer<typeof strategyDSLSchema>;
export type StrategySignal = z.infer<typeof signalSchema>;
export type StrategyOrderSpec = z.infer<typeof orderSpecSchema>;

export function parseStrategyDSL(value: unknown): StrategyDSL {
  return strategyDSLSchema.parse(value);
}

export function tryParseStrategyDSL(
  value: unknown,
): { ok: true; value: StrategyDSL } | { ok: false; issues: string[] } {
  const result = strategyDSLSchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}

export function summarizeStrategy(strategy: StrategyDSL): string {
  const e = strategy.entries[0];
  const x = strategy.exits[0];
  return `${strategy.identity.name ?? strategy.identity.id} v${strategy.identity.version} on ${strategy.universe.venue}/${strategy.universe.symbols.join(",")} — ${e.id} → ${x.id} — max notional $${strategy.risk.max_position_notional_usd}, max daily loss $${strategy.risk.max_daily_loss_usd}`;
}
```

Note: `ruleSchema` is typed as `z.ZodType<unknown>` (not the staging inferred type) to satisfy `strict` + recursive `z.lazy` under financial-agent's tsconfig. The `StrategyRule`/`StrategyEntry`/`StrategyExit` inferred-type exports from staging are intentionally omitted here — they are not needed until Plan 3 wires the runtime; add them then if required.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts`
Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mcp_tools/trading/strategy/strategyDSL.ts mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts
git commit -m "feat: port strategy DSL (zod schema) from staging plugin-cex"
```

---

## Task 3: Extend DSL with the `price_trigger` block

Add our price-trigger types (spec §4) as an OPTIONAL block on the strategy, so existing signal-based strategies still validate and our price-driven strategies become expressible.

**Files:**
- Create: `mcp_tools/trading/strategy/priceTrigger.ts` (schema + types only in this task)
- Modify: `mcp_tools/trading/strategy/strategyDSL.ts` (reference the new schema)
- Test: `mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts` (add cases)

- [ ] **Step 1: Write failing tests for the price_trigger block**

Append to `mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts`:

```typescript
test("parseStrategyDSL accepts a rolling_change price_trigger", () => {
  const base = validStrategy() as Record<string, unknown>;
  base.price_trigger = {
    type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 2,
  };
  base.action = {
    side: "SELL", size: { type: "pct_of_position", value: 10 }, order_type: "marketable_limit", max_slippage_bps: 50,
  };
  base.recurrence = { mode: "one_shot", reanchor: false, trigger_count: 0 };
  const s = parseStrategyDSL(base);
  assert.equal(s.price_trigger?.type, "rolling_change");
  assert.equal(s.action?.order_type, "marketable_limit");
});

test("price_trigger rejects window_minutes on absolute_threshold via refine", () => {
  const base = validStrategy() as Record<string, unknown>;
  base.price_trigger = { type: "absolute_threshold", direction: "down", price: 60000 };
  const r = tryParseStrategyDSL(base);
  assert.equal(r.ok, true); // absolute_threshold with price is valid
});

test("price_trigger rejects rolling_change missing pct", () => {
  const base = validStrategy() as Record<string, unknown>;
  base.price_trigger = { type: "rolling_change", direction: "down", window_minutes: 10 };
  const r = tryParseStrategyDSL(base);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts`
Expected: FAIL — `s.price_trigger` is undefined / schema strips unknown keys, and the missing-pct case still parses ok.

- [ ] **Step 3: Create the priceTrigger schema file**

Create `mcp_tools/trading/strategy/priceTrigger.ts`:

```typescript
import { z } from "zod";

export const priceTriggerSchema = z
  .object({
    type: z.enum(["rolling_change", "absolute_threshold", "trailing_stop"]),
    direction: z.enum(["up", "down"]),
    pct: z.number().positive().optional(),
    window_minutes: z.number().int().min(1).optional(),
    price: z.number().positive().optional(),
    reference_price: z.number().positive().optional(),
    confirm_samples: z.number().int().min(1).default(2),
  })
  .superRefine((t, ctx) => {
    if (t.type === "rolling_change") {
      if (t.pct === undefined)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rolling_change requires pct", path: ["pct"] });
      if (t.window_minutes === undefined)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rolling_change requires window_minutes", path: ["window_minutes"] });
    }
    if (t.type === "trailing_stop" && t.pct === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trailing_stop requires pct", path: ["pct"] });
    if (t.type === "absolute_threshold" && t.price === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "absolute_threshold requires price", path: ["price"] });
  });

export const actionSchema = z
  .object({
    side: z.enum(["BUY", "SELL"]),
    size: z.object({
      type: z.enum(["pct_of_position", "pct_of_portfolio", "fixed_quote_usd", "fixed_base_qty"]),
      value: z.number().positive(),
    }),
    order_type: z.enum(["market", "marketable_limit"]),
    max_slippage_bps: z.number().int().min(0).default(50),
  });

export const recurrenceSchema = z.object({
  mode: z.enum(["one_shot", "recurring"]),
  cooldown_minutes: z.number().int().min(0).optional(),
  reanchor: z.boolean().default(false),
  max_triggers: z.number().int().min(1).optional(),
  trigger_count: z.number().int().min(0).default(0),
});

export type PriceTrigger = z.infer<typeof priceTriggerSchema>;
export type StrategyAction = z.infer<typeof actionSchema>;
export type StrategyRecurrence = z.infer<typeof recurrenceSchema>;
```

- [ ] **Step 4: Reference the new schemas from strategyDSL**

In `mcp_tools/trading/strategy/strategyDSL.ts`, add this import at the top (below the `zod` import):

```typescript
import { priceTriggerSchema, actionSchema, recurrenceSchema } from "./priceTrigger.ts";
```

Then in `strategyDSLSchema`, add three optional fields after `resilience: resilienceSchema,`:

```typescript
  price_trigger: priceTriggerSchema.optional(),
  action: actionSchema.optional(),
  recurrence: recurrenceSchema.optional(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --experimental-strip-types --test mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add mcp_tools/trading/strategy/priceTrigger.ts mcp_tools/trading/strategy/strategyDSL.ts mcp_tools/trading/strategy/__tests__/strategyDSL.test.ts
git commit -m "feat: extend strategy DSL with price_trigger/action/recurrence block"
```

---

## Task 4: Port idempotency helpers (decoupled)

Port `canonicalJSON`, `computeIntentHash`, and `deriveClientOrderId` from `packages/plugin-cex/src/idempotency/intentHash.ts`. The staging `computeIntentHash` depends on `../intent/canonicalIntent`; to keep the foundation self-contained we DECOUPLE it: `computeIntentHash` takes a plain object subset and hashes its `canonicalJSON`. The base32 + `deriveClientOrderId` logic is copied verbatim.

**Files:**
- Create: `mcp_tools/trading/idempotency/intentHash.ts`
- Test: `mcp_tools/trading/idempotency/__tests__/intentHash.test.ts`

- [ ] **Step 1: Write failing tests**

Create `mcp_tools/trading/idempotency/__tests__/intentHash.test.ts`:

```typescript
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
  assert.equal(h1.length, 64); // sha256 hex
});

test("deriveClientOrderId is venue-prefixed and within length limits", () => {
  const hash = computeIntentHash({ symbol: "BTCUSDT", side: "SELL", n: 1 });
  const bn = deriveClientOrderId(hash, "binance");
  const cb = deriveClientOrderId(hash, "coinbase");
  assert.match(bn, /^bn-[a-z2-7]+$/);
  assert.match(cb, /^cb-[a-z2-7]+$/);
  assert.ok(bn.length <= 36 && cb.length <= 36);
  // Deterministic: same hash → same id
  assert.equal(bn, deriveClientOrderId(hash, "binance"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test mcp_tools/trading/idempotency/__tests__/intentHash.test.ts`
Expected: FAIL — cannot resolve `../intentHash.ts`.

- [ ] **Step 3: Create the idempotency file**

Create `mcp_tools/trading/idempotency/intentHash.ts`:

```typescript
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
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test mcp_tools/trading/idempotency/__tests__/intentHash.test.ts`
Expected: PASS — `# pass 3`.

- [ ] **Step 5: Commit**

```bash
git add mcp_tools/trading/idempotency/intentHash.ts mcp_tools/trading/idempotency/__tests__/intentHash.test.ts
git commit -m "feat: port decoupled order idempotency helpers (hash + clientOrderId)"
```

---

## Task 5: Price-trigger evaluation (the core extension)

Implement the spec §5.2 / §4 evaluation math as pure functions over an OHLC sample array. This is NEW logic (staging has no rolling-drawdown trigger). Drawdown semantics, not point-to-point.

**Files:**
- Modify: `mcp_tools/trading/strategy/priceTrigger.ts` (add evaluation functions + sample type)
- Test: `mcp_tools/trading/strategy/__tests__/priceTrigger.test.ts`

- [ ] **Step 1: Write failing tests for trigger evaluation**

Create `mcp_tools/trading/strategy/__tests__/priceTrigger.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePriceTrigger, type OhlcSample, type PriceTrigger } from "../priceTrigger.ts";

// Helper: build samples at 1-minute spacing ending at ts=0 baseline.
function samples(closes: number[]): OhlcSample[] {
  // Each sample: high=low=close for simplicity unless overridden.
  return closes.map((c, i) => ({ ts: i * 60_000, high: c, low: c, close: c }));
}

test("rolling_change down: fires on drawdown from window high (V-shape included)", () => {
  // 100 -> 92 (down 8%) -> 98 (recover to -2% point-to-point). Window high=100.
  const buf = samples([100, 92, 98]);
  const trigger: PriceTrigger = { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 1 };
  // current = last close 98; rolling high = 100; drawdown = 2% -> NOT fired
  assert.equal(evaluatePriceTrigger(trigger, buf, 98).conditionMet, false);
  // but if current dips to 94: drawdown vs high 100 = 6% -> fired
  assert.equal(evaluatePriceTrigger(trigger, [...buf, { ts: 180000, high: 94, low: 94, close: 94 }], 94).conditionMet, true);
});

test("rolling_change uses window HIGH not endpoint (drawdown semantics)", () => {
  // Prices: 100, 110 (new high), 104. Endpoint 100->104 is +4%. Drawdown from 110 = 5.45%.
  const buf = samples([100, 110, 104]);
  const trigger: PriceTrigger = { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 1 };
  assert.equal(evaluatePriceTrigger(trigger, buf, 104).conditionMet, true);
});

test("rolling_change up: fires on rebound from window low", () => {
  const buf = samples([100, 90, 95]); // low=90, current=95 -> +5.55%
  const trigger: PriceTrigger = { type: "rolling_change", direction: "up", pct: 5, window_minutes: 10, confirm_samples: 1 };
  assert.equal(evaluatePriceTrigger(trigger, buf, 95).conditionMet, true);
});

test("absolute_threshold down: level comparison", () => {
  const trigger: PriceTrigger = { type: "absolute_threshold", direction: "down", price: 60000, confirm_samples: 1 };
  assert.equal(evaluatePriceTrigger(trigger, [], 59999).conditionMet, true);
  assert.equal(evaluatePriceTrigger(trigger, [], 60001).conditionMet, false);
});

test("trailing_stop down: maintains high-water and fires on retrace", () => {
  const trigger: PriceTrigger = { type: "trailing_stop", direction: "down", pct: 10, reference_price: 150, confirm_samples: 1 };
  // current 135 vs ref 150 = 10% retrace -> fired; nextReference stays 150
  const r = evaluatePriceTrigger(trigger, [], 135);
  assert.equal(r.conditionMet, true);
  assert.equal(r.nextReferencePrice, 150);
});

test("trailing_stop down: raises anchor on new high, no fire", () => {
  const trigger: PriceTrigger = { type: "trailing_stop", direction: "down", pct: 10, reference_price: 150, confirm_samples: 1 };
  const r = evaluatePriceTrigger(trigger, [], 160); // new high
  assert.equal(r.conditionMet, false);
  assert.equal(r.nextReferencePrice, 160);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test mcp_tools/trading/strategy/__tests__/priceTrigger.test.ts`
Expected: FAIL — `evaluatePriceTrigger` / `OhlcSample` not exported.

- [ ] **Step 3: Add the evaluation logic to priceTrigger.ts**

Append to `mcp_tools/trading/strategy/priceTrigger.ts`:

```typescript
export interface OhlcSample {
  ts: number; // epoch ms
  high: number;
  low: number;
  close: number;
}

export interface TriggerEvaluation {
  conditionMet: boolean;
  /** For trailing_stop: the updated anchor to persist (caller writes it back). Undefined otherwise. */
  nextReferencePrice?: number;
}

/**
 * Pure evaluation of a single price trigger against the current price and the
 * recent OHLC buffer. Drawdown semantics for rolling_change (window high/low,
 * NOT endpoint-to-endpoint). Caller is responsible for confirm_samples gating
 * across successive calls and for persisting nextReferencePrice.
 */
export function evaluatePriceTrigger(
  trigger: PriceTrigger,
  buffer: OhlcSample[],
  currentPrice: number,
): TriggerEvaluation {
  switch (trigger.type) {
    case "absolute_threshold": {
      const met =
        trigger.direction === "down"
          ? currentPrice < (trigger.price ?? Infinity)
          : currentPrice > (trigger.price ?? -Infinity);
      return { conditionMet: met };
    }
    case "rolling_change": {
      const pct = trigger.pct ?? 0;
      if (trigger.direction === "down") {
        const high = Math.max(currentPrice, ...buffer.map((s) => s.high));
        const drawdown = high > 0 ? (high - currentPrice) / high : 0;
        return { conditionMet: drawdown >= pct / 100 };
      } else {
        const low = Math.min(currentPrice, ...buffer.map((s) => s.low));
        const rebound = low > 0 ? (currentPrice - low) / low : 0;
        return { conditionMet: rebound >= pct / 100 };
      }
    }
    case "trailing_stop": {
      const pct = trigger.pct ?? 0;
      const ref = trigger.reference_price;
      if (trigger.direction === "down") {
        const anchor = Math.max(ref ?? currentPrice, currentPrice);
        const retrace = anchor > 0 ? (anchor - currentPrice) / anchor : 0;
        return { conditionMet: retrace >= pct / 100, nextReferencePrice: anchor };
      } else {
        const anchor = Math.min(ref ?? currentPrice, currentPrice);
        const rebound = anchor > 0 ? (currentPrice - anchor) / anchor : 0;
        return { conditionMet: rebound >= pct / 100, nextReferencePrice: anchor };
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test mcp_tools/trading/strategy/__tests__/priceTrigger.test.ts`
Expected: PASS — `# pass 6`.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test`
Expected: PASS — all foundation tests (sanity + DSL + idempotency + priceTrigger) green, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add mcp_tools/trading/strategy/priceTrigger.ts mcp_tools/trading/strategy/__tests__/priceTrigger.test.ts
git commit -m "feat: price-trigger evaluation (drawdown rolling_change, threshold, trailing_stop)"
```

---

## Self-Review Notes (coverage vs spec)

- Spec §2 (reuse list): DSL ✅ (Task 2), idempotency ✅ (Task 4). Quantization, runtime, nlToDSL, backtest, websocket → Plans 3–4 (out of Plan 1 scope; Plan 1 is pure foundation).
- Spec §4 (DSL extension): price_trigger / action / recurrence ✅ (Task 3); drawdown semantics ✅ (Task 5).
- Spec §5.2 evaluation: rolling_change drawdown, absolute_threshold level, trailing_stop anchor ✅ (Task 5). `confirm_samples` N-sample gating is intentionally deferred to the Monitor loop (Plan 3) since it is stateful across successive polls — the schema field exists here (Task 3), the gating logic lands in Plan 3.
- Out of scope for Plan 1 (tracked for later plans): persistence (Plan 2), risk rule `maxDailyAutoTrades` (Plan 2), monitor loop + quantization + execution + websocket (Plan 3), MCP tools + nlToDSL + approval endpoint + backtest (Plan 4).

---

## Plans 2–4 (to be written after Plan 1 lands)

- **Plan 2 — Persistence + risk:** atomic JSON store for strategies, `cost_basis.json`, `daily_pnl_<date>.json`, `risk_config.json`; `maxDailyAutoTrades` risk rule added to `riskEngine.ts`.
- **Plan 3 — Monitor loop + execution:** price-history buffer + kline backfill, `confirm_samples` gating, Strategy Monitor self-scheduling loop, quantization port, marketable-limit + idempotent `cex_create_order` path, websocket user-data stream adaptation, serial-per-symbol execution.
- **Plan 4 — Tools + endpoint:** `nlToDSL` port, `cex_create_strategy`/`cex_list_strategies`/`cex_get_strategy`/`cex_update_strategy`/`cex_backtest_strategy` MCP tools + registration, strategy-approval server endpoint, backtest port.
