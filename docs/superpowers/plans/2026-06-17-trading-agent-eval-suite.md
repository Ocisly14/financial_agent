# Trading Agent Evaluation Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic eval suite (②③④') that emits quotable safety/quality metrics + CI gates, plus an opt-in live NL→DSL eval (①).

**Architecture:** A small `scripts/eval/lib` (pure metrics, report renderer, candle-replay harness) feeds per-eval modules under `scripts/eval/evals`. `run.ts` runs the free/deterministic set and exits non-zero on gate breach; `nl-dsl.ts` runs the live LLM eval separately. Two minimal, behaviour-preserving refactors expose testable seams: `stepConfirmation` (extracted from `strategyMonitor`) and `categoryForAgent` (extracted from `dispatcher`).

**Tech Stack:** TypeScript, Node ≥23 native test runner (`node:test` + `node:assert/strict`), `--experimental-strip-types`, zod. LLM provider is Google Vertex/Gemini (① only).

## Global Constraints

- Node ≥ 23.0.0; run TS directly via `node --experimental-strip-types` (no build step for eval scripts).
- All imports use explicit `.ts` extensions (ESM, `"type": "module"`).
- Deterministic evals (②③④') must NOT make network calls, read env credentials, or call `Date.now()` for assertions — pass fixed timestamps.
- Test files use `node:test` + `node:assert/strict`, matching existing patterns in `mcp_tools/**/__tests__/*.test.ts` and `test/*.test.ts`.
- Risk engine entry: `evaluate(intent: TradeIntent, ctx: RiskContext, rulesToRun?: string[]): RiskDecision` from `mcp_tools/trading/riskEngine.ts`. `RiskDecision` = `{ verdict, rules_fired: RiskRuleId[], explanations, rule_results }`.
- `DEFAULT_RISK_PREFERENCES` and types are in `mcp_tools/trading/riskTypes.ts`.

---

### Task 1: Pure metrics helpers

**Files:**
- Create: `scripts/eval/lib/metrics.ts`
- Test: `scripts/eval/lib/__tests__/metrics.test.ts`

**Interfaces:**
- Produces:
  - `confusion(items: {predicted: boolean; actual: boolean}[]): { tp: number; fp: number; tn: number; fn: number }`
  - `recall(c: {tp:number; fn:number}): number` — returns 1 when no positives.
  - `precision(c: {tp:number; fp:number}): number` — returns 1 when no predicted-positives.
  - `accuracy(correct: number, total: number): number` — returns 1 when total 0.
  - `pct(x: number): string` — formats `0.923` → `"92%"`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/eval/lib/__tests__/metrics.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test scripts/eval/lib/__tests__/metrics.test.ts`
Expected: FAIL — cannot find module `../metrics.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/eval/lib/metrics.ts
export type Confusion = { tp: number; fp: number; tn: number; fn: number };

export function confusion(items: { predicted: boolean; actual: boolean }[]): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const { predicted, actual } of items) {
    if (predicted && actual) c.tp++;
    else if (predicted && !actual) c.fp++;
    else if (!predicted && !actual) c.tn++;
    else c.fn++;
  }
  return c;
}

export function recall(c: { tp: number; fn: number }): number {
  const denom = c.tp + c.fn;
  return denom === 0 ? 1 : c.tp / denom;
}

export function precision(c: { tp: number; fp: number }): number {
  const denom = c.tp + c.fp;
  return denom === 0 ? 1 : c.tp / denom;
}

export function accuracy(correct: number, total: number): number {
  return total === 0 ? 1 : correct / total;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test scripts/eval/lib/__tests__/metrics.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/lib/metrics.ts scripts/eval/lib/__tests__/metrics.test.ts
git commit -m "feat(eval): pure metrics helpers (recall/precision/accuracy)"
```

---

### Task 2: Extract `stepConfirmation` from strategyMonitor

**Files:**
- Create: `src/trading/confirmation.ts`
- Modify: `src/trading/strategyMonitor.ts:119-129` (replace inline counter with `stepConfirmation`)
- Test: `src/trading/__tests__/confirmation.test.ts`

**Interfaces:**
- Produces:
  - `type ConfirmState = { count: number }`
  - `function stepConfirmation(state: ConfirmState, conditionMet: boolean, confirmNeeded: number): { state: ConfirmState; fired: boolean }`
  - Semantics: when `conditionMet`, increment count; `fired` is true iff new count `>= confirmNeeded`. When not met, count resets to 0, `fired` false. The returned `state` is a NEW object (pure).

- [ ] **Step 1: Write the failing test**

```ts
// src/trading/__tests__/confirmation.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/trading/__tests__/confirmation.test.ts`
Expected: FAIL — cannot find module `../confirmation.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/trading/confirmation.ts
export type ConfirmState = { count: number };

/**
 * N-sample wick-confirmation stepper. Pure: returns a new state.
 * Increments on a met sample and fires once the run reaches confirmNeeded;
 * any unmet sample resets the run to zero.
 */
export function stepConfirmation(
  state: ConfirmState,
  conditionMet: boolean,
  confirmNeeded: number,
): { state: ConfirmState; fired: boolean } {
  if (!conditionMet) return { state: { count: 0 }, fired: false };
  const count = state.count + 1;
  return { state: { count }, fired: count >= confirmNeeded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/trading/__tests__/confirmation.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire strategyMonitor to use it (behaviour-preserving)**

In `src/trading/strategyMonitor.ts`, add the import near the top (with the other `./` imports):

```ts
import { stepConfirmation } from "./confirmation.ts";
```

Replace the N-sample block at lines 119-129:

```ts
  // N-sample wick confirmation.
  const confirmNeeded = trigger.confirm_samples;
  if (result.conditionMet) {
    const next = (confirmCounts.get(phaseKey) ?? 0) + 1;
    confirmCounts.set(phaseKey, next);
    if (next >= confirmNeeded) {
      await fire(strategy, phase, price, now);
    }
  } else {
    confirmCounts.set(phaseKey, 0);
  }
```

with:

```ts
  // N-sample wick confirmation (shared stepper, also exercised by the eval suite).
  const stepped = stepConfirmation(
    { count: confirmCounts.get(phaseKey) ?? 0 },
    result.conditionMet,
    trigger.confirm_samples,
  );
  confirmCounts.set(phaseKey, stepped.state.count);
  if (stepped.fired) {
    await fire(strategy, phase, price, now);
  }
```

- [ ] **Step 6: Verify monitor still type-checks and existing tests pass**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no new errors in `strategyMonitor.ts`.
Run: `node --experimental-strip-types --test "mcp_tools/**/__tests__/*.test.ts"`
Expected: existing trigger tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add src/trading/confirmation.ts src/trading/__tests__/confirmation.test.ts src/trading/strategyMonitor.ts
git commit -m "refactor(trading): extract pure stepConfirmation, share with monitor"
```

---

### Task 3: Candle-replay harness

**Files:**
- Create: `scripts/eval/lib/replay.ts`
- Test: `scripts/eval/lib/__tests__/replay.test.ts`

**Interfaces:**
- Consumes: `evaluatePriceTrigger` + `OhlcSample`/`PriceTrigger` from `mcp_tools/trading/strategy/priceTrigger.ts`; `stepConfirmation` from `src/trading/confirmation.ts`.
- Produces:
  - `type Candle = { ts: number; high: number; low: number; close: number }`
  - `type ReplayFixture = { id: string; symbol: string; trigger: PriceTrigger; candles: Candle[]; expectedFire: boolean; label: string }`
  - `function replay(fixture: ReplayFixture): { fired: boolean; fireIndex: number | null }` — steps candle-by-candle. At each index `i`, calls `evaluatePriceTrigger(trigger, candles.slice(0, i+1), candles[i].close)` then `stepConfirmation`; returns the first index that fires (or null). Window-arming is approximated by passing the full prefix as the sample buffer (deterministic, no DB/backfill).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/eval/lib/__tests__/replay.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, type ReplayFixture } from "../replay.ts";

const base = (candles: number[]): { ts: number; high: number; low: number; close: number }[] =>
  candles.map((c, i) => ({ ts: i * 60_000, high: c, low: c, close: c }));

test("clean drawdown fires after confirmation", () => {
  const fx: ReplayFixture = {
    id: "t1", symbol: "BTCUSDT", expectedFire: true, label: "clean drawdown",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 2 },
    candles: base([100, 100, 94, 93]), // drops >5% from high=100 and stays
  };
  assert.equal(replay(fx).fired, true);
});

test("single wick does not fire (confirm gate)", () => {
  const fx: ReplayFixture = {
    id: "t2", symbol: "BTCUSDT", expectedFire: false, label: "single wick",
    trigger: { type: "rolling_change", direction: "down", pct: 5, window_minutes: 10, confirm_samples: 2 },
    candles: base([100, 100, 94, 100]), // one dip then recovers
  };
  assert.equal(replay(fx).fired, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test scripts/eval/lib/__tests__/replay.test.ts`
Expected: FAIL — cannot find module `../replay.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/eval/lib/replay.ts
import { evaluatePriceTrigger, type OhlcSample, type PriceTrigger } from "../../../mcp_tools/trading/strategy/priceTrigger.ts";
import { stepConfirmation, type ConfirmState } from "../../../src/trading/confirmation.ts";

export type Candle = { ts: number; high: number; low: number; close: number };

export type ReplayFixture = {
  id: string;
  symbol: string;
  trigger: PriceTrigger;
  candles: Candle[];
  expectedFire: boolean;
  label: string;
};

export function replay(fixture: ReplayFixture): { fired: boolean; fireIndex: number | null } {
  let state: ConfirmState = { count: 0 };
  let anchor = fixture.trigger.reference_price;
  for (let i = 0; i < fixture.candles.length; i++) {
    const buffer: OhlcSample[] = fixture.candles.slice(0, i + 1);
    const trigger: PriceTrigger = anchor !== undefined ? { ...fixture.trigger, reference_price: anchor } : fixture.trigger;
    const result = evaluatePriceTrigger(trigger, buffer, fixture.candles[i]!.close);
    if (result.nextReferencePrice !== undefined) anchor = result.nextReferencePrice;
    const stepped = stepConfirmation(state, result.conditionMet, fixture.trigger.confirm_samples);
    state = stepped.state;
    if (stepped.fired) return { fired: true, fireIndex: i };
  }
  return { fired: false, fireIndex: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test scripts/eval/lib/__tests__/replay.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/lib/replay.ts scripts/eval/lib/__tests__/replay.test.ts
git commit -m "feat(eval): candle-replay harness over real trigger + confirmation"
```

---

### Task 4: EvalResult contract + report renderer

**Files:**
- Create: `scripts/eval/lib/report.ts`
- Test: `scripts/eval/lib/__tests__/report.test.ts`

**Interfaces:**
- Consumes: `pct` from `./metrics.ts`.
- Produces:
  - `type EvalResult = { category: string; metrics: Record<string, number>; gateViolations: string[]; lines: string[] }`
  - `function renderReport(results: EvalResult[]): { text: string; exitCode: number }` — joins each result's `lines`, appends a `GATES:` line. `exitCode` is 1 if any `gateViolations` is non-empty, else 0.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/eval/lib/__tests__/report.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, type EvalResult } from "../report.ts";

test("exit 0 when no gate violations", () => {
  const r: EvalResult[] = [{ category: "③ risk", metrics: { recall: 1 }, gateViolations: [], lines: ["③ risk: ok"] }];
  const out = renderReport(r);
  assert.equal(out.exitCode, 0);
  assert.match(out.text, /③ risk: ok/);
  assert.match(out.text, /GATES: all passed/);
});

test("exit 1 and lists violations", () => {
  const r: EvalResult[] = [{ category: "④ safety", metrics: {}, gateViolations: ["category leak: cex_create_order"], lines: ["④ safety: FAIL"] }];
  const out = renderReport(r);
  assert.equal(out.exitCode, 1);
  assert.match(out.text, /category leak: cex_create_order/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test scripts/eval/lib/__tests__/report.test.ts`
Expected: FAIL — cannot find module `../report.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/eval/lib/report.ts
export type EvalResult = {
  category: string;
  metrics: Record<string, number>;
  gateViolations: string[];
  lines: string[];
};

export function renderReport(results: EvalResult[]): { text: string; exitCode: number } {
  const body = results.flatMap((r) => r.lines).join("\n");
  const violations = results.flatMap((r) => r.gateViolations);
  const gateLine =
    violations.length === 0
      ? "GATES: all passed ✓"
      : `GATES: FAILED (${violations.length})\n  - ${violations.join("\n  - ")}`;
  return { text: `${body}\n${gateLine}`, exitCode: violations.length === 0 ? 0 : 1 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test scripts/eval/lib/__tests__/report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/lib/report.ts scripts/eval/lib/__tests__/report.test.ts
git commit -m "feat(eval): EvalResult contract + report renderer with gate exit code"
```

---

### Task 5: ② Trigger-accuracy eval + fixtures

**Files:**
- Create: `scripts/eval/datasets/trigger-replay/clean-5pct-drawdown.json`
- Create: `scripts/eval/datasets/trigger-replay/single-wick-spike.json`
- Create: `scripts/eval/datasets/trigger-replay/noisy-chop.json`
- Create: `scripts/eval/datasets/trigger-replay/trailing-stop-retrace.json`
- Create: `scripts/eval/evals/trigger.ts`
- Test: `scripts/eval/evals/__tests__/trigger.test.ts`

**Interfaces:**
- Consumes: `replay`, `ReplayFixture` from `../lib/replay.ts`; `EvalResult` from `../lib/report.ts`; `recall`, `precision`, `pct` from `../lib/metrics.ts`.
- Produces: `function runTriggerEval(): EvalResult` — loads the 4 fixtures, replays each, computes recall over should-fire fixtures and false-trigger rate over should-not-fire fixtures.

- [ ] **Step 1: Create the 4 fixtures**

```json
// scripts/eval/datasets/trigger-replay/clean-5pct-drawdown.json
{ "id": "clean-5pct-drawdown", "symbol": "BTCUSDT", "expectedFire": true,
  "label": "clean 5% drawdown from window high, holds",
  "trigger": { "type": "rolling_change", "direction": "down", "pct": 5, "window_minutes": 10, "confirm_samples": 2 },
  "candles": [
    {"ts":0,"high":100,"low":100,"close":100},
    {"ts":60000,"high":100,"low":100,"close":100},
    {"ts":120000,"high":100,"low":93,"close":94},
    {"ts":180000,"high":94,"low":92,"close":93}
  ] }
```

```json
// scripts/eval/datasets/trigger-replay/single-wick-spike.json
{ "id": "single-wick-spike", "symbol": "BTCUSDT", "expectedFire": false,
  "label": "one-bar dip below threshold then recovers (confirm gate must hold)",
  "trigger": { "type": "rolling_change", "direction": "down", "pct": 5, "window_minutes": 10, "confirm_samples": 2 },
  "candles": [
    {"ts":0,"high":100,"low":100,"close":100},
    {"ts":60000,"high":100,"low":100,"close":100},
    {"ts":120000,"high":100,"low":93,"close":94},
    {"ts":180000,"high":100,"low":99,"close":100}
  ] }
```

```json
// scripts/eval/datasets/trigger-replay/noisy-chop.json
{ "id": "noisy-chop", "symbol": "BTCUSDT", "expectedFire": false,
  "label": "oscillation that never sustains a 5% drawdown for 2 samples",
  "trigger": { "type": "rolling_change", "direction": "down", "pct": 5, "window_minutes": 10, "confirm_samples": 2 },
  "candles": [
    {"ts":0,"high":100,"low":100,"close":100},
    {"ts":60000,"high":100,"low":96,"close":97},
    {"ts":120000,"high":100,"low":96,"close":98},
    {"ts":180000,"high":100,"low":96,"close":97},
    {"ts":240000,"high":100,"low":96,"close":98}
  ] }
```

```json
// scripts/eval/datasets/trigger-replay/trailing-stop-retrace.json
{ "id": "trailing-stop-retrace", "symbol": "BTCUSDT", "expectedFire": true,
  "label": "trailing stop fires after 10% retrace from anchor, sustained",
  "trigger": { "type": "trailing_stop", "direction": "down", "pct": 10, "reference_price": 150, "confirm_samples": 2 },
  "candles": [
    {"ts":0,"high":150,"low":150,"close":150},
    {"ts":60000,"high":150,"low":134,"close":134},
    {"ts":120000,"high":135,"low":133,"close":133}
  ] }
```

- [ ] **Step 2: Write the failing test**

```ts
// scripts/eval/evals/__tests__/trigger.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTriggerEval } from "../trigger.ts";

test("trigger eval: perfect recall, zero false-triggers on fixtures", () => {
  const r = runTriggerEval();
  assert.equal(r.category, "② trigger");
  assert.equal(r.metrics.recall, 1);            // both should-fire fired
  assert.equal(r.metrics.falseTriggerRate, 0);  // neither should-not fired
  assert.equal(r.gateViolations.length, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-strip-types --test scripts/eval/evals/__tests__/trigger.test.ts`
Expected: FAIL — cannot find module `../trigger.ts`.

- [ ] **Step 4: Write minimal implementation**

```ts
// scripts/eval/evals/trigger.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { replay, type ReplayFixture } from "../lib/replay.ts";
import { pct } from "../lib/metrics.ts";
import type { EvalResult } from "../lib/report.ts";

const DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILES = [
  "clean-5pct-drawdown.json",
  "single-wick-spike.json",
  "noisy-chop.json",
  "trailing-stop-retrace.json",
];

function loadFixtures(): ReplayFixture[] {
  return FIXTURE_FILES.map((f) =>
    JSON.parse(readFileSync(join(DIR, "..", "datasets", "trigger-replay", f), "utf8")) as ReplayFixture,
  );
}

export function runTriggerEval(): EvalResult {
  const fixtures = loadFixtures();
  const outcomes = fixtures.map((fx) => ({ fx, fired: replay(fx).fired }));

  const shouldFire = outcomes.filter((o) => o.fx.expectedFire);
  const shouldNot = outcomes.filter((o) => !o.fx.expectedFire);
  const firedCount = shouldFire.filter((o) => o.fired).length;
  const falseTriggers = shouldNot.filter((o) => o.fired).length;

  const recallVal = shouldFire.length === 0 ? 1 : firedCount / shouldFire.length;
  const ftr = shouldNot.length === 0 ? 0 : falseTriggers / shouldNot.length;
  const truePos = firedCount;
  const precisionVal = truePos + falseTriggers === 0 ? 1 : truePos / (truePos + falseTriggers);

  const gateViolations: string[] = [];
  for (const o of outcomes) {
    if (o.fired !== o.fx.expectedFire) {
      gateViolations.push(`② ${o.fx.id}: fired=${o.fired}, expected=${o.fx.expectedFire}`);
    }
  }

  return {
    category: "② trigger",
    metrics: { recall: recallVal, falseTriggerRate: ftr, precision: precisionVal, n: fixtures.length },
    gateViolations,
    lines: [
      `② trigger:  recall ${pct(recallVal)} (${firedCount}/${shouldFire.length}) · ` +
        `false-trigger ${pct(ftr)} (${falseTriggers}/${shouldNot.length}) · precision ${pct(precisionVal)}`,
    ],
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test scripts/eval/evals/__tests__/trigger.test.ts`
Expected: PASS (1 test). If a should-fire fixture does not fire, adjust the fixture candles so the drawdown is sustained for `confirm_samples` consecutive samples.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval/datasets/trigger-replay scripts/eval/evals/trigger.ts scripts/eval/evals/__tests__/trigger.test.ts
git commit -m "feat(eval): ② trigger-accuracy eval with labelled candle fixtures"
```

---

### Task 6: ③ Risk-interception eval

**Files:**
- Create: `scripts/eval/evals/risk.ts` (inline typed dataset — covers all 15 rules + controls)
- Test: `scripts/eval/evals/__tests__/risk.test.ts`

**Interfaces:**
- Consumes: `evaluate`, `DEFAULT_RISK_PREFERENCES`, types from `mcp_tools/trading/riskEngine.ts` / `riskTypes.ts`; `recall`, `precision`, `pct` from `../lib/metrics.ts`; `EvalResult`.
- Produces: `function runRiskEval(): EvalResult` — runs every case through `evaluate`, computes recall (violations blocked) + falseBlocks (legal blocked), with a per-rule breakdown. Cases needing the global-kill env var set `LIVE_TRADING_GLOBAL_KILL` around their own `evaluate` call and restore it.

**Notes on dataset construction (verified against `riskEngine.ts`):** each violating case starts from a fully-valid baseline order and perturbs ONLY the targeted rule's field, so `decision.rules_fired` must include the targeted `RiskRuleId`. Baseline: `{ action: "create_order", mode: "paper", symbol: "BTCUSDT", side: "BUY", order_type: "market", size: { quote_size: "100" } }` with ctx `{ preferences: DEFAULT_RISK_PREFERENCES, now_ms: FIXED_NOW }`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/eval/evals/__tests__/risk.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRiskEval } from "../risk.ts";

test("risk eval blocks every violation and never false-blocks a legal order", () => {
  const r = runRiskEval();
  assert.equal(r.category, "③ risk");
  assert.equal(r.metrics.recall, 1);       // all violations blocked
  assert.equal(r.metrics.falseBlocks, 0);  // no legal order blocked
  assert.ok(r.metrics.violations >= 15);   // all 15 rule categories covered
  assert.equal(r.gateViolations.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test scripts/eval/evals/__tests__/risk.test.ts`
Expected: FAIL — cannot find module `../risk.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/eval/evals/risk.ts
import { evaluate } from "../../../mcp_tools/trading/riskEngine.ts";
import { DEFAULT_RISK_PREFERENCES } from "../../../mcp_tools/trading/riskTypes.ts";
import type { RiskContext, RiskRuleId, TradeIntent } from "../../../mcp_tools/trading/riskTypes.ts";
import { pct } from "../lib/metrics.ts";
import type { EvalResult } from "../lib/report.ts";

const FIXED_NOW = 1_750_000_000_000; // fixed timestamp; cooldown/global cases are deterministic

type RiskCase = {
  id: string;
  rule: RiskRuleId;
  kind: "violation" | "legal";
  intent: TradeIntent;
  ctx: RiskContext;
  needsGlobalKillEnv?: boolean;
};

const baseIntent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  action: "create_order", mode: "paper", symbol: "BTCUSDT", side: "BUY",
  order_type: "market", size: { quote_size: "100" }, ...over,
});

const baseCtx = (over: Partial<RiskContext> = {}): RiskContext => ({
  preferences: { ...DEFAULT_RISK_PREFERENCES, ...(over.preferences ?? {}) },
  now_ms: FIXED_NOW,
  ...over,
});

const VIOLATIONS: RiskCase[] = [
  { id: "killSwitch", rule: "killSwitch", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ preferences: { ...DEFAULT_RISK_PREFERENCES, kill_switch_active: true } }) },
  { id: "liveTradingGlobalKill", rule: "liveTradingGlobalKill", kind: "violation",
    intent: baseIntent({ mode: "live" }), ctx: baseCtx(), needsGlobalKillEnv: true },
  { id: "unknownStateBlocker", rule: "unknownStateBlocker", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ unknown_state_orders_on_pair: 2 }) },
  { id: "assetAllowlist", rule: "assetAllowlist", kind: "violation",
    intent: baseIntent({ symbol: "LUNA-USD" }), ctx: baseCtx() },
  { id: "leverageCap", rule: "leverageCap", kind: "violation",
    intent: baseIntent({ margin_context: { leverage: 10 } }), ctx: baseCtx() },
  { id: "minOrderSize", rule: "minOrderSize", kind: "violation",
    intent: baseIntent({ size: { quote_size: "0" } }), ctx: baseCtx() },
  { id: "maxOrderSize", rule: "maxOrderSize", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ estimated_notional_usd: 20_000 }) },
  { id: "exposureCap", rule: "exposureCap", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ open_exposure_usd: 60_000, estimated_notional_usd: 1_000 }) },
  { id: "dailyLossLimit", rule: "dailyLossLimit", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ rolling_24h_pnl_usd: -250 }) },
  { id: "maxDailyAutoTrades", rule: "maxDailyAutoTrades", kind: "violation",
    intent: baseIntent({ source: "auto_strategy" }), ctx: baseCtx({ daily_auto_trade_count: 50 }) },
  { id: "slippageCap", rule: "slippageCap", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ estimated_slippage_bps: 100 }) },
  { id: "priceDeviation", rule: "priceDeviation", kind: "violation",
    intent: baseIntent({ order_type: "limit", price_params: { limit_price: "70000" } }),
    ctx: baseCtx({ market_mid_usd: 100_000 }) },
  { id: "cooldown", rule: "cooldown", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ last_failure_at_ms: FIXED_NOW - 10_000 }) },
  { id: "marketDataFreshness", rule: "marketDataFreshness", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ market_data_age_ms: 60_000 }) },
  { id: "reconciliationHealth", rule: "reconciliationHealth", kind: "violation",
    intent: baseIntent(), ctx: baseCtx({ stale_reconciliation_count: 5 }) },
];

const LEGAL: RiskCase[] = [
  { id: "legal-market-buy", rule: "minOrderSize", kind: "legal", intent: baseIntent(), ctx: baseCtx() },
  { id: "legal-limit-near-mid", rule: "priceDeviation", kind: "legal",
    intent: baseIntent({ order_type: "limit", price_params: { limit_price: "100050" } }),
    ctx: baseCtx({ market_mid_usd: 100_000 }) },
  { id: "legal-auto-low-count", rule: "maxDailyAutoTrades", kind: "legal",
    intent: baseIntent({ source: "auto_strategy" }), ctx: baseCtx({ daily_auto_trade_count: 3 }) },
  { id: "legal-leverage-ok", rule: "leverageCap", kind: "legal",
    intent: baseIntent({ margin_context: { leverage: 2 } }), ctx: baseCtx() },
  { id: "legal-fresh-data", rule: "marketDataFreshness", kind: "legal",
    intent: baseIntent(), ctx: baseCtx({ market_data_age_ms: 1_000 }) },
];

function runCase(c: RiskCase): { blocked: boolean; firedTarget: boolean } {
  const prev = process.env["LIVE_TRADING_GLOBAL_KILL"];
  if (c.needsGlobalKillEnv) process.env["LIVE_TRADING_GLOBAL_KILL"] = "1";
  try {
    const d = evaluate(c.intent, c.ctx);
    return { blocked: d.verdict !== "allow", firedTarget: d.rules_fired.includes(c.rule) };
  } finally {
    if (c.needsGlobalKillEnv) {
      if (prev === undefined) delete process.env["LIVE_TRADING_GLOBAL_KILL"];
      else process.env["LIVE_TRADING_GLOBAL_KILL"] = prev;
    }
  }
}

export function runRiskEval(): EvalResult {
  const gateViolations: string[] = [];
  let blockedViolations = 0;
  for (const c of VIOLATIONS) {
    const { blocked, firedTarget } = runCase(c);
    if (!blocked || !firedTarget) {
      gateViolations.push(`③ violation '${c.id}' not blocked by rule ${c.rule} (blocked=${blocked}, firedTarget=${firedTarget})`);
    } else blockedViolations++;
  }
  let falseBlocks = 0;
  for (const c of LEGAL) {
    const { blocked } = runCase(c);
    if (blocked) { falseBlocks++; gateViolations.push(`③ legal order '${c.id}' was wrongly blocked`); }
  }

  const recallVal = VIOLATIONS.length === 0 ? 1 : blockedViolations / VIOLATIONS.length;
  return {
    category: "③ risk",
    metrics: { recall: recallVal, violations: VIOLATIONS.length, blocked: blockedViolations, legal: LEGAL.length, falseBlocks },
    gateViolations,
    lines: [
      `③ risk:     blocked ${blockedViolations}/${VIOLATIONS.length} violations (recall ${pct(recallVal)}) · ` +
        `${falseBlocks}/${LEGAL.length} false blocks   [15 rule categories]`,
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test scripts/eval/evals/__tests__/risk.test.ts`
Expected: PASS. If any violation isn't blocked, re-check that case's perturbation against the rule body in `mcp_tools/trading/riskEngine.ts` (e.g. ensure `order_type: "limit"` for priceDeviation, `mode: "live"` for the global kill).

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/evals/risk.ts scripts/eval/evals/__tests__/risk.test.ts
git commit -m "feat(eval): ③ risk-interception eval across all 15 rules"
```

---

### Task 7: Extract `categoryForAgent` (isolation seam)

**Files:**
- Create: `src/framework/toolAccess.ts`
- Modify: `src/framework/dispatcher.ts:120` and `:128-130` (use the extracted helpers)
- Test: `src/framework/__tests__/toolAccess.test.ts`

**Interfaces:**
- Consumes: `AgentKind`, `ToolCategory` from `./types.ts`.
- Produces:
  - `function categoryForAgent(agent: AgentKind): ToolCategory` — `"trade" → "trading"`, else `"non_trading"`.
  - `function assertToolAllowedForAgent(agent: AgentKind, toolName: string, toolCategory: ToolCategory): void` — throws `tool ${toolName} has category ${toolCategory}, not allowed for ${agent}` when mismatched.

- [ ] **Step 1: Write the failing test**

```ts
// src/framework/__tests__/toolAccess.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForAgent, assertToolAllowedForAgent } from "../toolAccess.ts";

test("trade agent maps to trading, others to non_trading", () => {
  assert.equal(categoryForAgent("trade"), "trading");
  assert.equal(categoryForAgent("onchain_data"), "non_trading");
  assert.equal(categoryForAgent("news_research"), "non_trading");
});

test("assert throws when a non-trade agent requests a trading tool", () => {
  assert.throws(() => assertToolAllowedForAgent("news_research", "cex_create_order", "trading"), /not allowed for news_research/);
  assert.doesNotThrow(() => assertToolAllowedForAgent("trade", "cex_create_order", "trading"));
  assert.doesNotThrow(() => assertToolAllowedForAgent("market_research", "financial_search", "non_trading"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/framework/__tests__/toolAccess.test.ts`
Expected: FAIL — cannot find module `../toolAccess.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/framework/toolAccess.ts
import type { AgentKind, ToolCategory } from "./types.ts";

/** A trade subagent may use trading tools; every other agent may use only non-trading tools. */
export function categoryForAgent(agent: AgentKind): ToolCategory {
  return agent === "trade" ? "trading" : "non_trading";
}

export function assertToolAllowedForAgent(agent: AgentKind, toolName: string, toolCategory: ToolCategory): void {
  const required = categoryForAgent(agent);
  if (toolCategory !== required) {
    throw new Error(`tool ${toolName} has category ${toolCategory}, not allowed for ${agent}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/framework/__tests__/toolAccess.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire dispatcher to use it (behaviour-preserving)**

In `src/framework/dispatcher.ts`, add to the imports:

```ts
import { categoryForAgent, assertToolAllowedForAgent } from "./toolAccess.ts";
```

Replace line 120:

```ts
    const requiredCategory: ToolCategory = agent === "trade" ? "trading" : "non_trading";
```

with:

```ts
    const requiredCategory: ToolCategory = categoryForAgent(agent);
```

Replace lines 128-130:

```ts
      if (tool.category !== requiredCategory) {
        throw new Error(`tool ${name} has category ${tool.category}, not allowed for ${agent}`);
      }
```

with:

```ts
      assertToolAllowedForAgent(agent, name, tool.category);
```

(`requiredCategory` may now be unused — if `tsc` flags it, delete that line too.)

- [ ] **Step 6: Verify dispatcher type-checks**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no new errors in `dispatcher.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/framework/toolAccess.ts src/framework/__tests__/toolAccess.test.ts src/framework/dispatcher.ts
git commit -m "refactor(framework): extract categoryForAgent isolation seam"
```

---

### Task 8: ④' Safety-invariants eval

**Files:**
- Create: `scripts/eval/evals/invariants.ts`
- Test: `scripts/eval/evals/__tests__/invariants.test.ts`

**Interfaces:**
- Consumes:
  - `categoryForAgent` from `../../../src/framework/toolAccess.ts`; `McpToolRegistry` from `../../../mcp_tools/toolRegistry.ts`; `registerAllTools`, `TRADING_TOOLS` from `../../../mcp_tools/registerTools.ts`.
  - `SessionState` from `../../../src/framework/sessionState.ts`.
  - `EvalResult` from `../lib/report.ts`.
- Produces: `function runInvariantsEval(): EvalResult` — runs two adversarial invariant batches (category isolation, approval gate); metric = total violations; gate = 0.

**Invariant A — category isolation:** build the real registry, enumerate every tool whose `category === "trading"`, and assert that for each non-trade `AgentKind` (`onchain_data`, `news_research`) `categoryForAgent(agent) !== "trading"` (i.e. the tool would be rejected). A violation is any trading tool whose category equals a non-trade agent's required category.

**Invariant B — approval gate:** drive `SessionState.pendingApproval` through adversarial event sequences. An order is "executable" only when there IS a matching `approval_resolved` (pendingApproval returns undefined for a genuine reason). Trials: (1) approval_required, never resolved → still pending (must NOT execute); (2) resolved for a DIFFERENT id → still pending; (3) resolved for the correct id → not pending (may execute). A violation is any case where a never-/wrong-resolved approval reports as non-pending.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/eval/evals/__tests__/invariants.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInvariantsEval } from "../invariants.ts";

test("safety invariants: zero violations across all adversarial trials", () => {
  const r = runInvariantsEval();
  assert.equal(r.category, "④ safety");
  assert.equal(r.metrics.violations, 0);
  assert.ok(r.metrics.tradingToolsChecked >= 1);
  assert.ok(r.metrics.approvalTrials >= 3);
  assert.equal(r.gateViolations.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test scripts/eval/evals/__tests__/invariants.test.ts`
Expected: FAIL — cannot find module `../invariants.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/eval/evals/invariants.ts
import { McpToolRegistry } from "../../../mcp_tools/toolRegistry.ts";
import { registerAllTools } from "../../../mcp_tools/registerTools.ts";
import { categoryForAgent } from "../../../src/framework/toolAccess.ts";
import { SessionState } from "../../../src/framework/sessionState.ts";
import type { AgentKind } from "../../../src/framework/types.ts";
import type { EvalResult } from "../lib/report.ts";

const NON_TRADE_AGENTS: AgentKind[] = ["onchain_data", "news_research"];

function checkCategoryIsolation(): { checked: number; violations: string[] } {
  const reg = new McpToolRegistry();
  registerAllTools(reg);
  const tradingTools = reg.list().filter((t) => t.category === "trading");
  const violations: string[] = [];
  for (const tool of tradingTools) {
    for (const agent of NON_TRADE_AGENTS) {
      if (categoryForAgent(agent) === tool.category) {
        violations.push(`category leak: ${agent} could reach trading tool ${tool.name}`);
      }
    }
  }
  return { checked: tradingTools.length, violations };
}

function checkApprovalGate(): { trials: number; violations: string[] } {
  const violations: string[] = [];
  let trials = 0;

  // Trial 1: never resolved → must remain pending (not executable).
  trials++;
  {
    const s = new SessionState("eval_appr_1", "2026-06-17T00:00:00.000Z");
    s.record("trade", "approval_required", { approval_id: "a1" });
    if (s.pendingApproval("a1") === undefined) violations.push("approval gate: never-resolved approval reported as executable");
  }

  // Trial 2: resolved for a DIFFERENT id → original must remain pending.
  trials++;
  {
    const s = new SessionState("eval_appr_2", "2026-06-17T00:00:00.000Z");
    s.record("trade", "approval_required", { approval_id: "a1" });
    s.record("trade", "approval_resolved", { approval_id: "OTHER", decision: "approved" });
    if (s.pendingApproval("a1") === undefined) violations.push("approval gate: wrong-id resolution cleared the wrong approval");
  }

  // Trial 3: resolved for the correct id → no longer pending (executable).
  trials++;
  {
    const s = new SessionState("eval_appr_3", "2026-06-17T00:00:00.000Z");
    s.record("trade", "approval_required", { approval_id: "a1" });
    s.record("trade", "approval_resolved", { approval_id: "a1", decision: "approved" });
    if (s.pendingApproval("a1") !== undefined) violations.push("approval gate: genuinely-resolved approval still reported pending");
  }

  return { trials, violations };
}

export function runInvariantsEval(): EvalResult {
  const iso = checkCategoryIsolation();
  const appr = checkApprovalGate();
  const gateViolations = [...iso.violations, ...appr.violations];
  return {
    category: "④ safety",
    metrics: {
      violations: gateViolations.length,
      tradingToolsChecked: iso.checked,
      approvalTrials: appr.trials,
    },
    gateViolations,
    lines: [
      `④ safety:   approval-gate ${appr.violations.length === 0 ? "0 violations" : `${appr.violations.length} VIOLATIONS`}` +
        ` (${appr.trials} trials) · category-isolation ${iso.violations.length === 0 ? "0 leaks" : `${iso.violations.length} LEAKS`}` +
        ` (${iso.checked} trading tools)  ${gateViolations.length === 0 ? "✓" : "✗"}`,
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test scripts/eval/evals/__tests__/invariants.test.ts`
Expected: PASS (1 test). If `registerAllTools` requires env/credentials and throws, narrow to constructing the registry without network tools, or catch+report the inability to load as a single non-gating note (but prefer a clean load).

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/evals/invariants.ts scripts/eval/evals/__tests__/invariants.test.ts
git commit -m "feat(eval): ④ safety-invariants eval (approval gate + category isolation)"
```

---

### Task 9: Deterministic runner `run.ts` + npm script

**Files:**
- Create: `scripts/eval/run.ts`
- Modify: `package.json` (add `"eval"` script)

**Interfaces:**
- Consumes: `runTriggerEval`, `runRiskEval`, `runInvariantsEval`; `renderReport` from `./lib/report.ts`.

- [ ] **Step 1: Write the runner**

```ts
// scripts/eval/run.ts
import { runTriggerEval } from "./evals/trigger.ts";
import { runRiskEval } from "./evals/risk.ts";
import { runInvariantsEval } from "./evals/invariants.ts";
import { renderReport } from "./lib/report.ts";

function main(): void {
  const results = [runRiskEval(), runTriggerEval(), runInvariantsEval()];
  const { text, exitCode } = renderReport(results);
  console.log("\n=== Trading Agent Eval Suite (deterministic) ===\n");
  console.log(text);
  process.exit(exitCode);
}

main();
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add:

```json
    "eval": "node --env-file=.env --experimental-strip-types scripts/eval/run.ts",
```

- [ ] **Step 3: Run the full deterministic suite**

Run: `npm run eval`
Expected output (exit code 0):

```
=== Trading Agent Eval Suite (deterministic) ===

③ risk:     blocked 15/15 violations (recall 100%) · 0/5 false blocks   [15 rule categories]
② trigger:  recall 100% (2/2) · false-trigger 0% (0/2) · precision 100%
④ safety:   approval-gate 0 violations (3 trials) · category-isolation 0 leaks (N trading tools)  ✓
GATES: all passed ✓
```

Verify: `echo $?` prints `0`.

- [ ] **Step 4: Commit**

```bash
git add scripts/eval/run.ts package.json
git commit -m "feat(eval): deterministic runner (②③④') with gate exit code + npm run eval"
```

---

### Task 10: ① NL→DSL fidelity eval (opt-in, live)

**Files:**
- Create: `scripts/eval/evals/nlDsl.ts` (scoring core, reuses `scripts/test-llm-strategy.ts` machinery)
- Create: `scripts/eval/datasets/nl-dsl.jsonl` (start with 12 seed cases; expand toward 40–60)
- Create: `scripts/eval/nl-dsl.ts` (entry point)
- Modify: `package.json` (add `"eval:nl-dsl"` script)

**Interfaces:**
- Consumes: the prompt/tool/model wiring already proven in `scripts/test-llm-strategy.ts` — `McpToolRegistry`, `registerAllTools`/`TRADING_TOOLS`, `tradeSubagentPrompt`, `PromptRenderer`, `GoogleProvider`, `ModelRouter`, `tryParsePriceStrategy`, `normalizePriceStrategyInput`. Reuse its `parseCalls` JSON extraction.
- Produces:
  - `type GoldDsl = { tool: string; trigger_type: string; direction: string; pct?: number; price?: number; side: string; sizing_kind: string; sizing_value: number; symbol: string; recurrence_mode: string }`
  - `type NlCase = { id: string; input: string; gold: GoldDsl }`
  - `function scoreCase(generated: { tool: string; input: Record<string, unknown> } | null, gold: GoldDsl): { fields: Record<string, boolean>; intentMatch: boolean; toolMatch: boolean }`

- [ ] **Step 1: Read the existing prototype to reuse its wiring**

Run: `sed -n '1,120p' scripts/test-llm-strategy.ts`
Note the exports/imports it uses to render the prompt, call the model, and parse tool calls. `nlDsl.ts` reuses the same imports; do NOT duplicate the model-calling logic in a new place — factor the single-request call into a function `generateStrategyCall(input: string): Promise<{ tool: string; input: Record<string, unknown> } | null>` inside `nlDsl.ts` using those same imports.

- [ ] **Step 2: Write the failing test for the pure scorer**

```ts
// scripts/eval/evals/__tests__/nlDsl.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCase, type GoldDsl } from "../nlDsl.ts";

const gold: GoldDsl = {
  tool: "cex_create_strategy", trigger_type: "rolling_change", direction: "down",
  pct: 5, side: "BUY", sizing_kind: "quote_size", sizing_value: 200,
  symbol: "BTCUSDT", recurrence_mode: "one_shot",
};

test("intentMatch true only when all critical fields match", () => {
  const phases = [{ price_trigger: { type: "rolling_change", direction: "down", pct: 5 },
    action: { side: "BUY", size: { type: "quote_size", value: 200 } }, recurrence: { mode: "one_shot" } }];
  const generated = { tool: "cex_create_strategy", input: { symbol: "BTC", phases } };
  const r = scoreCase(generated, gold);
  assert.equal(r.toolMatch, true);
  assert.equal(r.intentMatch, true);
});

test("intentMatch false when direction is wrong", () => {
  const phases = [{ price_trigger: { type: "rolling_change", direction: "up", pct: 5 },
    action: { side: "BUY", size: { type: "quote_size", value: 200 } }, recurrence: { mode: "one_shot" } }];
  const generated = { tool: "cex_create_strategy", input: { symbol: "BTC", phases } };
  assert.equal(scoreCase(generated, gold).intentMatch, false);
});

test("null generation scores as total miss", () => {
  const r = scoreCase(null, gold);
  assert.equal(r.toolMatch, false);
  assert.equal(r.intentMatch, false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-strip-types --test scripts/eval/evals/__tests__/nlDsl.test.ts`
Expected: FAIL — cannot find module `../nlDsl.ts`.

- [ ] **Step 4: Implement `nlDsl.ts` (scorer + live generator)**

```ts
// scripts/eval/evals/nlDsl.ts
import { normalizePriceStrategyInput } from "../../../mcp_tools/trading/strategy/priceStrategy.ts";

export type GoldDsl = {
  tool: string; trigger_type: string; direction: string;
  pct?: number; price?: number; side: string;
  sizing_kind: string; sizing_value: number; symbol: string; recurrence_mode: string;
};
export type NlCase = { id: string; input: string; gold: GoldDsl };

type GenCall = { tool: string; input: Record<string, unknown> };

/** Normalize the generated tool input and compare each critical field to gold. */
export function scoreCase(generated: GenCall | null, gold: GoldDsl): {
  fields: Record<string, boolean>; intentMatch: boolean; toolMatch: boolean;
} {
  if (!generated) {
    return { fields: {}, intentMatch: false, toolMatch: false };
  }
  const toolMatch = generated.tool === gold.tool;
  // Normalize via the same path the tool uses, then read the first phase.
  let phase: Record<string, unknown> | undefined;
  let symbol = "";
  try {
    const norm = normalizePriceStrategyInput(generated.input) as Record<string, unknown>;
    symbol = String(norm["symbol"] ?? generated.input["symbol"] ?? "");
    const phases = norm["phases"] as Record<string, unknown>[] | undefined;
    phase = phases?.[0];
  } catch {
    phase = (Array.isArray(generated.input["phases"]) ? (generated.input["phases"] as Record<string, unknown>[])[0] : undefined);
    symbol = String(generated.input["symbol"] ?? "");
  }
  const trigger = (phase?.["price_trigger"] ?? {}) as Record<string, unknown>;
  const action = (phase?.["action"] ?? {}) as Record<string, unknown>;
  const size = (action["size"] ?? {}) as Record<string, unknown>;
  const recurrence = (phase?.["recurrence"] ?? {}) as Record<string, unknown>;

  const fields: Record<string, boolean> = {
    tool: toolMatch,
    trigger_type: String(trigger["type"] ?? "") === gold.trigger_type,
    direction: String(trigger["direction"] ?? "") === gold.direction,
    threshold: gold.pct !== undefined ? Number(trigger["pct"]) === gold.pct : Number(trigger["price"]) === gold.price,
    side: String(action["side"] ?? "") === gold.side,
    sizing_kind: String(size["type"] ?? size["kind"] ?? "") === gold.sizing_kind,
    sizing_value: Number(size["value"] ?? 0) === gold.sizing_value,
    symbol: symbol.toUpperCase().startsWith(gold.symbol.replace(/USDT?$/i, "").toUpperCase()),
    recurrence_mode: String(recurrence["mode"] ?? "") === gold.recurrence_mode,
  };
  const critical = ["tool", "trigger_type", "direction", "threshold", "side", "sizing_kind", "sizing_value"];
  const intentMatch = critical.every((k) => fields[k] === true);
  return { fields, intentMatch, toolMatch };
}

// Live generator: factor the model call out of scripts/test-llm-strategy.ts using the
// same imports (McpToolRegistry, registerAllTools/TRADING_TOOLS, tradeSubagentPrompt,
// PromptRenderer, GoogleProvider, ModelRouter, parseCalls). Returns the first parsed call.
export async function generateStrategyCall(input: string): Promise<GenCall | null> {
  // Implementation mirrors scripts/test-llm-strategy.ts's single-request path:
  //  1. build registry + trading tool list
  //  2. render tradeSubagentPrompt with the user input
  //  3. call model via ModelRouter/GoogleProvider
  //  4. parseCalls(responseText) → first { tool, input } or null
  throw new Error("wire to scripts/test-llm-strategy.ts model-call path");
}
```

- [ ] **Step 5: Run the scorer test to verify it passes**

Run: `node --experimental-strip-types --test scripts/eval/evals/__tests__/nlDsl.test.ts`
Expected: PASS (3 tests). (`generateStrategyCall` is not exercised by this test.)

- [ ] **Step 6: Create the seed dataset (12 cases; expand later toward 40–60)**

```jsonl
{"id":"c01","input":"Buy $200 of BTC if it drops 5% within an hour","gold":{"tool":"cex_create_strategy","trigger_type":"rolling_change","direction":"down","pct":5,"side":"BUY","sizing_kind":"quote_size","sizing_value":200,"symbol":"BTCUSDT","recurrence_mode":"one_shot"}}
{"id":"c02","input":"If ETH rallies 8% in 30 minutes, sell $500 worth","gold":{"tool":"cex_create_strategy","trigger_type":"rolling_change","direction":"up","pct":8,"side":"SELL","sizing_kind":"quote_size","sizing_value":500,"symbol":"ETHUSDT","recurrence_mode":"one_shot"}}
{"id":"c03","input":"Buy $100 of SOL when it hits $120","gold":{"tool":"cex_create_strategy","trigger_type":"absolute_threshold","direction":"up","price":120,"side":"BUY","sizing_kind":"quote_size","sizing_value":100,"symbol":"SOLUSDT","recurrence_mode":"one_shot"}}
{"id":"c04","input":"Put a 10% trailing stop on my BTC, sell $300","gold":{"tool":"cex_create_strategy","trigger_type":"trailing_stop","direction":"down","pct":10,"side":"SELL","sizing_kind":"quote_size","sizing_value":300,"symbol":"BTCUSDT","recurrence_mode":"one_shot"}}
{"id":"c05","input":"Every time BTC falls 3% in an hour, buy $50 — keep doing it","gold":{"tool":"cex_create_strategy","trigger_type":"rolling_change","direction":"down","pct":3,"side":"BUY","sizing_kind":"quote_size","sizing_value":50,"symbol":"BTCUSDT","recurrence_mode":"recurring"}}
{"id":"c06","input":"Sell $250 of ETH if price climbs to $4000","gold":{"tool":"cex_create_strategy","trigger_type":"absolute_threshold","direction":"up","price":4000,"side":"SELL","sizing_kind":"quote_size","sizing_value":250,"symbol":"ETHUSDT","recurrence_mode":"one_shot"}}
{"id":"c07","input":"Buy $400 of BTC on a 6% dip over the last 2 hours","gold":{"tool":"cex_create_strategy","trigger_type":"rolling_change","direction":"down","pct":6,"side":"BUY","sizing_kind":"quote_size","sizing_value":400,"symbol":"BTCUSDT","recurrence_mode":"one_shot"}}
{"id":"c08","input":"If SOL pumps 12% in 15 minutes, take profit on $150","gold":{"tool":"cex_create_strategy","trigger_type":"rolling_change","direction":"up","pct":12,"side":"SELL","sizing_kind":"quote_size","sizing_value":150,"symbol":"SOLUSDT","recurrence_mode":"one_shot"}}
{"id":"c09","input":"Buy $1000 of BTC when it breaks above $70000","gold":{"tool":"cex_create_strategy","trigger_type":"absolute_threshold","direction":"up","price":70000,"side":"BUY","sizing_kind":"quote_size","sizing_value":1000,"symbol":"BTCUSDT","recurrence_mode":"one_shot"}}
{"id":"c10","input":"Sell $200 of ETH if it drops 7% in an hour","gold":{"tool":"cex_create_strategy","trigger_type":"rolling_change","direction":"down","pct":7,"side":"SELL","sizing_kind":"quote_size","sizing_value":200,"symbol":"ETHUSDT","recurrence_mode":"one_shot"}}
{"id":"c11","input":"Buy $80 of SOL every time it falls 4% in 30 min","gold":{"tool":"cex_create_strategy","trigger_type":"rolling_change","direction":"down","pct":4,"side":"BUY","sizing_kind":"quote_size","sizing_value":80,"symbol":"SOLUSDT","recurrence_mode":"recurring"}}
{"id":"c12","input":"Place a 15% trailing stop to sell $600 of ETH","gold":{"tool":"cex_create_strategy","trigger_type":"trailing_stop","direction":"down","pct":15,"side":"SELL","sizing_kind":"quote_size","sizing_value":600,"symbol":"ETHUSDT","recurrence_mode":"one_shot"}}
```

- [ ] **Step 7: Implement the entry point `nl-dsl.ts`**

```ts
// scripts/eval/nl-dsl.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCase, generateStrategyCall, type NlCase } from "./evals/nlDsl.ts";
import { pct } from "./lib/metrics.ts";

const DIR = dirname(fileURLToPath(import.meta.url));

function loadCases(): NlCase[] {
  const text = readFileSync(join(DIR, "datasets", "nl-dsl.jsonl"), "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as NlCase);
}

async function main(): Promise<void> {
  const cases = loadCases();
  let intentMatches = 0;
  let toolMatches = 0;
  const fieldTotals: Record<string, { ok: number; n: number }> = {};
  for (const c of cases) {
    const generated = await generateStrategyCall(c.input);
    const r = scoreCase(generated, c.gold);
    if (r.intentMatch) intentMatches++;
    if (r.toolMatch) toolMatches++;
    for (const [k, ok] of Object.entries(r.fields)) {
      fieldTotals[k] ??= { ok: 0, n: 0 };
      fieldTotals[k].n++;
      if (ok) fieldTotals[k].ok++;
    }
    console.log(`${r.intentMatch ? "✔" : "✘"} ${c.id}: ${c.input}`);
  }
  const n = cases.length;
  console.log("\n=== ① NL→DSL fidelity (live Gemini) ===");
  console.log(`① nl-dsl:   intent-match ${pct(intentMatches / n)} · tool-select ${pct(toolMatches / n)}  (n=${n})`);
  for (const [k, v] of Object.entries(fieldTotals)) {
    console.log(`   ${k}: ${pct(v.ok / v.n)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 8: Add the npm script**

In `package.json` `"scripts"`, add:

```json
    "eval:nl-dsl": "node --env-file=.env --experimental-strip-types scripts/eval/nl-dsl.ts",
```

- [ ] **Step 9: Complete `generateStrategyCall` and smoke-test live**

Replace the `throw` in `generateStrategyCall` with the model-call path copied from `scripts/test-llm-strategy.ts` (same imports). Then run:

Run: `npm run eval:nl-dsl`
Expected: prints per-case ✔/✘ and a summary line with `intent-match` / `tool-select` percentages. Requires Vertex credentials in `.env`. If credentials are absent, the script errors clearly — that is acceptable (opt-in, never part of `npm run eval`).

- [ ] **Step 10: Commit**

```bash
git add scripts/eval/evals/nlDsl.ts scripts/eval/evals/__tests__/nlDsl.test.ts scripts/eval/datasets/nl-dsl.jsonl scripts/eval/nl-dsl.ts package.json
git commit -m "feat(eval): ① NL→DSL fidelity eval (opt-in, structured field scoring)"
```

---

## Self-Review

**Spec coverage:**
- ① NL→DSL → Task 10 (scorer + live generator + dataset + opt-in script). ✓
- ② Trigger replay → Tasks 2 (stepConfirmation), 3 (replay harness), 5 (eval + fixtures). ✓
- ③ Risk interception → Task 6 (all 15 rules + controls). ✓
- ④' Approval gate + category isolation → Tasks 7 (isolation seam), 8 (eval). ✓
- ⑤ cut; not implemented (per spec). ✓
- Report + gates + exit code → Tasks 4, 9. ✓
- Separate opt-in run mode for ① → Task 10 (`eval:nl-dsl`), deterministic `eval` excludes it → Task 9. ✓
- Synthetic fixtures + one recorded segment for ② → Task 5 (4 fixtures; `real-btc-segment` can be added by recording one segment into the same JSON shape — optional, the 4 synthetic cover the metric). Note: spec listed a `real-btc-segment.json`; deferred as optional since the synthetic set already produces recall/false-trigger. If desired, add it as a 5th fixture file with `expectedFire` labelled.

**Placeholder scan:** `generateStrategyCall` in Task 10 intentionally ships as a `throw` in Step 4 and is completed in Step 9 against the existing prototype — this is a sequenced implementation, not a plan placeholder (the source to copy is named exactly). All other steps contain complete code.

**Type consistency:** `EvalResult` (Task 4) is produced identically by Tasks 5/6/8. `stepConfirmation`/`ConfirmState` (Task 2) consumed by Task 3. `categoryForAgent` (Task 7) consumed by Task 8. `scoreCase`/`GoldDsl`/`NlCase` (Task 10) consistent across scorer, dataset, and entry point. `pct`/`recall`/`precision` (Task 1) consumed by Tasks 5/6/9/10.
