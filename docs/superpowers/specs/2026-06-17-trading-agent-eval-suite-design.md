# Trading Agent Evaluation Suite — Design

**Date:** 2026-06-17
**Status:** Approved, ready for implementation
**Scope:** Evaluation suite for the trading agent, producing quotable safety/quality metrics and CI regression gates.

## Goal

Build an evaluation suite that, from first principles, tests only what is **unique, regression-prone, and ours**. Each eval must produce a defensible, quotable number (recall / precision / accuracy / false-trigger rate) or a hard pass/fail safety gate.

## First-principles scope decision

The original request listed five trading evals (①–⑤). After grounding each against the codebase, the final set is **①②③④'** — one was cut and one was modified:

| Eval | Decision | Reason |
|---|---|---|
| ① NL→DSL fidelity | **Keep (highest value)** | The only eval that exercises the actual LLM agent. Silently regresses on prompt/model changes. |
| ② Trigger accuracy (replay) | **Keep, trimmed** | The false-trigger-rate number is an explicit deliverable. Confirmation gate is thin logic, so fixtures are minimized. Requires a small refactor (below). |
| ③ Risk interception | **Keep (strongest)** | Pure-function, 15 named rules, near-zero cost. Produces "100% blocked / 0 false blocks" headline. |
| ④ Safety invariants | **Modify → ④'** | Kill-switch sub-invariant is literally risk rules 10/11 (`killSwitch`, `liveTradingGlobalKill`) — folded into ③. Kept: **approval-gate** + **category-isolation**, which are genuinely distinct hard-isolation properties. |
| ⑤ Idempotency | **Cut** | No local dedup guard exists: `cexCreateOrderTool` derives a `clientOrderId` and sends; `reconciliation.registerOrder` just `orders.set(...)` (overwrite, no placement block). The real guarantee is exchange-side. The deterministic part (same intent → same `clientOrderId`) is already covered by `intentHash.test.ts`. A deterministic eval cannot honestly produce "0 duplicate orders". |

**Final suite:** ①(opt-in, live Gemini) + ②③④'(deterministic, free).

## Architecture

Reuse the existing `scripts/eval/` scaffold.

```
scripts/eval/
  run.ts                     # Entry: runs deterministic suite ②③④', prints report,
                             #   exits non-zero if any gate is violated.
  nl-dsl.ts                  # Separate entry: runs ① against real Gemini/Vertex.
  lib/
    report.ts                # Metric aggregation + report rendering + gate evaluation.
    metrics.ts               # Pure helpers: recall/precision/accuracy/falseTriggerRate.
    replay.ts                # ② candle-replay harness over the real evaluation path.
    __tests__/               # Unit tests for the eval lib itself (node:test).
  evals/
    trigger.ts               # ②
    risk.ts                  # ③
    invariants.ts            # ④'
    nlDsl.ts                 # ①  (imported by nl-dsl.ts only)
  datasets/
    trigger-replay/*.json    # ② labelled candle fixtures (4)
    risk-orders.jsonl        # ③ order scenarios
    invariants.jsonl         # ④' adversarial cases
    nl-dsl.jsonl             # ① 40–60 NL→DSL cases
```

### Shared contract

Every eval module exports:

```ts
type EvalResult = {
  category: string;                 // "③ risk", "② trigger", ...
  metrics: Record<string, number>;  // e.g. { recall: 1.0, falseBlocks: 0, n: 47 }
  gateViolations: string[];         // non-empty ⇒ run.ts exits non-zero
  lines: string[];                  // human-readable report lines
};
```

`report.ts` collects all `EvalResult`s, renders the report block, and returns the exit code (1 if any `gateViolations` non-empty).

`package.json` scripts:
- `"eval": "node --env-file=.env --experimental-strip-types scripts/eval/run.ts"`
- `"eval:nl-dsl": "node --env-file=.env --experimental-strip-types scripts/eval/nl-dsl.ts"`

## Eval ② — Trigger accuracy (K-line replay)

**Under test:** the N-sample confirmation gate — does a real drawdown fire (recall), and do single-bar wicks / noise get filtered (false-trigger rate)?

**Refactor required.** The confirmation state machine currently lives inside `evaluatePhase` in `src/trading/strategyMonitor.ts` (lines ~120–128), entangled with live polling, DB reads, recurrence, and module-level `confirmCounts` state. Extract the pure stepper so both the monitor and the eval exercise the **same** code:

```ts
// src/trading/confirmation.ts (new)
export type ConfirmState = { count: number };
export function stepConfirmation(
  state: ConfirmState,
  conditionMet: boolean,
  confirmNeeded: number,
): { state: ConfirmState; fired: boolean };
```

`strategyMonitor.evaluatePhase` is updated to call `stepConfirmation` instead of inlining the counter; behaviour is unchanged. This is a minimal, behaviour-preserving extraction.

**Replay harness** (`lib/replay.ts`): given a fixture `{ trigger, candles[] }`, step candle-by-candle calling the real `evaluatePriceTrigger(trigger, windowSoFar, candle.close)` + `stepConfirmation`, recording the indices where `fired === true`.

**Fixtures (4)** under `datasets/trigger-replay/`, each `{ id, symbol, trigger, candles[], expectedFires, label }`:
1. `clean-5pct-drawdown.json` — clean drawdown → SHOULD fire.
2. `single-wick-spike.json` — one-bar spike then recovery → SHOULD NOT fire (confirm gate).
3. `noisy-chop.json` — oscillation near threshold → SHOULD NOT fire.
4. `real-btc-segment.json` — one real BTC/ETH segment recorded once into JSON, hand-labelled.

**Metrics:** `recall` (should-fire fixtures that fired), `falseTriggerRate` (should-not fixtures that fired), `precision`. **Gate:** none hard (reported), but `falseTriggerRate` surfaced prominently.

## Eval ③ — Risk interception

**Under test:** `evaluate(intent, ctx)` from `mcp_tools/trading/riskEngine.ts` across all 15 rules.

**Dataset** `datasets/risk-orders.jsonl`, each line:
```json
{ "id": "...", "ruleTargeted": "maxOrderSize", "intent": {...}, "ctxOverrides": {...}, "expected": "block" }
```
Coverage: for each of the 15 `RiskRuleId`s, at least one **violating** case (`expected: "block"` or `"downgrade_read_only"`) plus a matched **legal** control (`expected: "allow"`). Kill-switch (rules `killSwitch`, `liveTradingGlobalKill`) lives here, not in ④.

Context built via `buildRiskContext` with `DEFAULT_RISK_PREFERENCES` + per-case overrides. `liveTradingGlobalKill` cases set/clear `LIVE_TRADING_GLOBAL_KILL` around the call.

**Metrics:** `recall` = violating orders blocked / total violating; `falseBlocks` = legal orders blocked; per-rule-category breakdown. **Gates:** `recall === 1.0` AND `falseBlocks === 0`.

Headline: *"blocked N/N policy-violating orders across 15 rule categories, 0 false blocks on M valid orders."*

## Eval ④' — Safety invariants (adversarial pass/fail)

Two distinct hard-isolation invariants. Each runs N adversarial trials; metric = violation count; **gate = 0**.

1. **Approval gate — no auto-fill without `approval_resolved`.** Tested at two seams:
   - Lifecycle: a strategy started via `cex_start_strategy` sits in `pending_approval`; `listStrategies("active")` excludes it, so `strategyMonitor.runOnce` cannot fire it. Only an `approval_resolved` (decision=approved) transition makes it `active`.
   - Session: `sessionState.pendingApproval(id)` returns the request while no matching `approval_resolved` exists and within TTL; returns undefined once resolved. Adversarial trials: resolved-for-other-id, expired-TTL, never-resolved — none may yield an executable/active order.
2. **Category isolation — non-trade agents cannot reach trading tools.** `dispatcher.resolveAllowedTools(agent, ...)` (`src/framework/dispatcher.ts`) must throw when a non-`trade` agent requests any `category: "trading"` tool, and must allow a `trade` agent. Adversarial trials enumerate trading tools requested under every non-trade `AgentKind`.

**Metric:** total violations across all trials. **Gate:** `=== 0`. Headline: *"0 violations across N adversarial trials."*

## Eval ① — NL→DSL fidelity (opt-in, live)

**Under test:** does the LLM, given the real trade-subagent prompt and full trading toolset, emit the correct tool call + structured strategy DSL?

**Machinery:** reuse `scripts/test-llm-strategy.ts` — render `tradeSubagentPrompt` via `PromptRenderer`, expose `TRADING_TOOLS`, call the model through `ModelRouter`/`GoogleProvider`, parse tool calls, run `normalizePriceStrategyInput` + `tryParsePriceStrategy`. Extract this into `evals/nlDsl.ts` so both the prototype and the eval share it.

**Dataset** `datasets/nl-dsl.jsonl`, 40–60 cases:
```json
{ "id": "...", "input": "buy $200 of BTC if it drops 5% in an hour",
  "gold": { "tool": "cex_create_strategy", "trigger_type": "rolling_change",
            "direction": "down", "pct": 5, "side": "BUY", "sizing_kind": "quote_size",
            "sizing_value": 200, "symbol": "BTCUSDT", "recurrence_mode": "one_shot" } }
```
Mix: clear requests (most), a few intentionally ambiguous/underspecified (scored leniently or excluded from strict accuracy and reported separately).

**Scoring:** deterministic per-field exact match against `gold`. An **intent-match** is correct iff all critical fields (tool, trigger_type, direction, threshold, side, sizing) match. Also report per-field accuracy and tool-selection accuracy.

**Run mode:** separate `npm run eval:nl-dsl`; requires Vertex creds; never runs in the deterministic CI path. Emits its own report block.

## Report format

```
③ risk:     blocked 47/47 violations (recall 100%) · 0/30 false blocks   [incl kill-switch]
② trigger:  recall 100% (3/3) · false-trigger 0% (0/3) · precision 100%
④ safety:   approval-gate 0 violations · category-isolation 0 leaks   ✓
GATES: all passed
--- opt-in (npm run eval:nl-dsl) ---
① nl-dsl:   intent-match 88% · tool-select 96%   (n=50, live Gemini)
```

## Testing the eval suite itself

`lib/__tests__/` holds `node:test` unit tests for `metrics.ts` (recall/precision math on known inputs) and `replay.ts` (a tiny synthetic fixture). These run under the existing `npm test` glob if placed to match, or are invoked directly.

## Out of scope / deferred

- ⑤ idempotency as a standalone eval (cut; rationale above). Optional 1-line addition: assert `deriveClientOrderId` is stable across a simulated restart, folded into existing `intentHash.test.ts`.
- Generic (non-trading) agent eval — spec was incomplete; deferred to its own brainstorm.
- Live historical-kline fetching for ② (chose synthetic + one recorded segment for determinism).
- LLM-as-judge scoring for ① (chose deterministic field-match).
