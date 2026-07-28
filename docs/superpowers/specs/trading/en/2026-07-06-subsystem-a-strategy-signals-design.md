# Subsystem A: Strategy-Generation Enhancement + Skeleton (SignalContext / StrategyEngine)

Date: 2026-07-06
Status: Proposal (under review)
Parent spec: `2026-07-03-web3-strategy-loop-design.md` (top-level umbrella)
Scope: The **first** of the three subsystems. Lands the shared skeleton + lets the agent generate "price + TA + on-chain/sentiment" compound-signal strategies. Backtest (B) and the optimization loop (C) are out of scope here.

---

## 1. Goals and Non-Goals

### Goals
1. **Switch the runtime to the full `strategyDSL`** (signals / entries / exits / risk), cleanly replacing the current `priceStrategy`, with no backward-compat wrapper.
2. **Unify the signal taxonomy**: fold the existing 3 price-movement triggers into signals too, alongside TA / on-chain / sentiment; rules reference signals uniformly.
3. **Land the skeleton**: the `SignalContext` interface + the `StrategyEngine.evaluate` pure core, driven by the monitor (live); reserve the same driving surface for B/C.
4. **rules support full nested booleans** (arbitrary and/or/not), expressing web3 compound conditions.
5. **Rewrite the tool + prompt + eval dataset** onto strategyDSL, guarding NL→DSL generation fidelity.

### Non-Goals (left to B / C)
- `HistoricalSignalContext` and historical on-chain/sentiment data sources → **subsystem B**.
- Generate→backtest→optimize loop, parameter sweep, performance memory → **subsystem C**.
- Portfolio/multi-symbol → deferred.
- Migrating old priceStrategy drafts → **not done** (clean break, old drafts discardable).

---

## 2. Skeleton: SignalContext + StrategyEngine

Both new abstractions are shared. **A only implements `LiveSignalContext`** (live pulls); `HistoricalSignalContext` implements the same interface in B.

### 2.1 `SignalContext` (signal data surface, interface)

Provides all signal values needed for one evaluation, by timestamp.

```
interface SignalContext {
  // value of a signal at time t; returns { available: false } when data is missing
  valueOf(signalId, t): { available: true, value: number } | { available: false }
}
```

- Stateful signals (rolling_change needs a window series; trailing_stop needs reference tracking) keep their **state** out of SignalContext; SignalContext only exposes "the raw quantity currently computable", and state is carried by StrategyEngine's `state` (see 2.2).
- "Data unavailable" is a first-class return; upper layers have deterministic behavior for it (default: that signal is false / no trigger). Live and backtest (B) share these semantics, keeping them aligned.

### 2.2 `StrategyEngine.evaluate` (pure core)

```
evaluate(dsl: StrategyDSL, ctx: SignalContext, state: EngineState, t)
  → { decisions: OrderIntent[], nextState: EngineState }
```

One evaluation's path:

```
signals[]  ──(SignalContext.valueOf)──►  evaluate each signal (incl. "unavailable")
    │
    ▼
entries[]/exits[].when  ──(recursive ruleSchema eval: and/or/not/lt/gt/…)──►  bool
    │  matched
    ▼
.then (orderSpec)  ──►  OrderIntent(side/order_type/sizing/tif)
```

- **Pure function**: same `(dsl, ctx, state, t)` → same output. No I/O, no clock dependency (t passed explicitly).
- `EngineState` holds: per-signal/phase confirm counts (reusing `confirmation.ts::stepConfirmation`), trailing_stop reference_price, recurrence trigger counts and cooldown timestamps.
- **Shared by three**: monitor (live), backtest (B), and eval-replay (②) all call this one evaluate.

---

## 3. Unified Signal Taxonomy

signal `kind` enum (extending the existing `signalSchema`):

| Family | kind | Key params | Stateful |
|---|---|---|---|
| Price movement | `price.rolling_change` | pct, window_minutes, direction, confirm_samples | Yes (window) |
| Price movement | `price.threshold` | price, direction, confirm_samples | No |
| Price movement | `price.trailing_stop` | pct, direction, reference_price?, reanchor | Yes (anchor) |
| Technical | `price.rsi` | period, (threshold compared in rule) | No |
| Technical | `price.sma_cross` / `price.ema_cross` | fast, slow | No |
| Technical | `price.atr_band` | period, mult | No |
| Volume | `volume.zscore` | window | No |
| On-chain | `onchain.exchange_netflow` / `onchain.whale_netflow` / `onchain.tx_volume` | window | No |
| Sentiment | `sentiment.fear_greed` | — | No |

- A signal only **produces a number** (or unavailable); **threshold comparison goes in the rule** (e.g. `rsi < 30`). This lets one signal be reused by different rules.
- A implements evaluation for all these families in `LiveSignalContext`: price/TA/volume computed from klines (port `indicators.ts`); on-chain/sentiment call existing on-chain / sentiment tools.

---

## 4. rules: Full Nested Booleans

- Reuse the existing `ruleSchema` (`op ∈ {lt,lte,gt,gte,eq,and,or,not,between}`, args may recursively contain sub-rules / signalIds / constants).
- entries/exits are each `{ id, when: rule, then: orderSpec }`.
- StrategyEngine recursively evaluates `when`; a leaf `lt/gt/…` has one side as a signalId (resolved via SignalContext), the other a constant or another signal.
- **Boolean semantics of unavailable signals**: a signal that's unavailable in a comparison → that comparison is false (default no trigger); under `not` it still propagates as false (does not flip to true). Written into the StrategyEngine contract and pinned by eval.

---

## 5. Runtime Rewrite (clean break)

- `strategyMonitor.ts`: switch to calling `StrategyEngine.evaluate` for each active strategy; confirm gate, trailing-anchor persistence, recurrence convergence migrate from "per-phase" to "per-entry/exit + EngineState".
- `strategyExecutor.ts`: consumes the `OrderIntent[]` from evaluate, using the existing order/risk/paper-venue path (unchanged).
- `strategyStore` / `StoredStrategy`: `dsl` field type changes from `PriceStrategyDSL` to `StrategyDSL`; `priceStrategy.ts` and its normalize retire.
- `priceHistory.ts`: kept as the price/kline source for `LiveSignalContext`.

**Boundary payoff**: monitor/executor no longer understand specific trigger types, only "evaluate → order"; adding a signal touches only SignalContext + the signal enum, not the execution layer.

---

## 6. Tool and Prompt Rewrite

- `cex_create_strategy`'s inputSchema changes from `phases[]` to `signals[] / entries[] / exits[] / risk`, field names/enums aligned to strategyDSL. The tool description and the "stop and name a missing field, don't fabricate" guardrail are preserved.
- trade-subagent prompt: add the unified signal taxonomy and the "signal outputs a number, threshold compared in rule" expression pattern, with compound-condition examples (e.g. `RSI<30 AND onchain.exchange_netflow<0 → BUY`).
- The normalization layer (mirroring the current `normalizePriceStrategyInput`) is rewritten to the strategyDSL version, tolerating the model's field aliases.

---

## 7. Eval (rewrite + migration)

- **① NL→DSL**: rewrite the 50-case dataset to strategyDSL gold; add cases covering TA / on-chain / sentiment / AND-OR-NOT compound conditions. Per-field exact-match scoring unchanged.
- **② Trigger replay**: migrate `replay.ts` onto the unified `StrategyEngine.evaluate` (not the old direct priceTrigger call), fixture semantics unchanged, incidentally validating signal evaluation.
- **③④'**: risk and safety invariants are unaffected; a regression pass suffices.

---

## 8. Error Handling and Determinism

- SignalContext throwing/timing out → normalized to "unavailable" (fail-safe no trigger), so live doesn't mis-fire on a single flaky data source.
- StrategyEngine is a pure function throughout, no clock; `t` and all external quantities passed explicitly via ctx/state — this is the prerequisite for ⑤ (backtest determinism) and ② (replay).
- trailing_stop anchor, recurrence counts, etc. persist through the store on every change (continuing the current "restart doesn't give back gains" guarantee).

---

## 9. Delivery Boundary (A done means)

The agent can generate a valid strategyDSL with TA/on-chain/sentiment compound conditions → save draft → pass approval → the monitor evaluates and executes it live via StrategyEngine; ① NL→DSL and ②③④' all green. **The backtest button does not yet exist (B); the optimization loop does not yet exist (C).**
